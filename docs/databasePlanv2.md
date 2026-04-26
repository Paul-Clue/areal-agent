# Phase 0 — Production Database Build Plan (v2)
## Property Video SaaS — eLand Jamaica Data Pipeline

**Purpose:** Build, populate, verify, and harden the PostgreSQL property database
before any application code is written. When this phase is complete, the database
is production-grade, fully populated with all Jamaica parcel data, and ready to
accept an application connection.

**Changes from v1:** Two clarification gaps have been filled:
- Gap 1 (Step 4): Stop condition now includes a full clarification block with
  resolution options for each failure type instead of just telling the agent to stop.
- Gap 2 (Step 7B): Password generation, storage, and communication are now
  fully specified with a clarification block before the SQL runs.

---

## Overview

```
STEP 1  Install and configure PostgreSQL
STEP 2  Create the production schema
STEP 3  Run the fetch script to scrape all NLA data
STEP 4  Validate the raw JSON output
STEP 5  Run the ingestion script to load data into the database
STEP 6  Verify data integrity
STEP 7  Apply production hardening
STEP 8  Create the database refresh workflow
STEP 9  Final pre-handoff checklist
```

Every step must be completed and verified before moving to the next.
The implementing agent must not skip or combine steps.

---

## Prerequisites

Before starting, confirm the following are installed on the machine
that will host the database:

| Requirement    | Minimum Version | Check Command                          |
|----------------|-----------------|----------------------------------------|
| PostgreSQL     | 15+             | `psql --version`                       |
| PostGIS        | 3.3+            | (checked inside psql after install)    |
| Node.js        | 18+             | `node --version`                       |
| npm            | 9+              | `npm --version`                        |
| Puppeteer deps | Chromium        | `node -e "require('puppeteer')"`       |

---

### ⚠️ CLARIFICATION REQUIRED — Hosting Environment

> "Where will the PostgreSQL database be hosted?"

| Option | Description | Why Consider It |
|--------|-------------|-----------------|
| A | DigitalOcean Managed PostgreSQL | Recommended. No maintenance burden. Automated backups, failover, and monitoring are built in. Connects directly to the application on Vercel and DigitalOcean with minimal configuration. Scales up with a few clicks. |
| B | Self-managed PostgreSQL on a DigitalOcean Droplet | More control over configuration and lower monthly cost, but you are fully responsible for backups, security patches, uptime, and scaling. Only recommended if you have database administration experience. |
| C | Local machine (development only) | Only appropriate for testing the scripts before production setup. Never use this for production — data will not be accessible to the hosted application. |

**Do not proceed until one option is chosen.**

---

## STEP 1 — Install and Configure PostgreSQL

### 1A — If Using DigitalOcean Managed PostgreSQL (Option A)

1. Log into DigitalOcean
2. Click **Create** → **Databases**
3. Select:
   - Engine: **PostgreSQL 15**
   - Region: **closest to Jamaica** (NYC3 or TOR1)
   - Plan: **Basic** (can scale up later)
4. Name the cluster: `property-video-db`
5. Wait for provisioning (5–10 minutes)
6. Under **Connection Details**, copy and save:
   - Host
   - Port (default 25060)
   - Database name (default `defaultdb`)
   - Username (default `doadmin`)
   - Password
   - SSL mode: **require**
7. Under **Settings** → **Trusted Sources**, add the IP address
   of the machine that will run the ingestion scripts

Save these credentials. You will need them in every subsequent step.

---

### 1B — If Using Self-Managed Droplet (Option B)

```bash
# On Ubuntu 22.04 / 24.04

# Install PostgreSQL 15
sudo apt update
sudo apt install -y postgresql-15 postgresql-contrib-15

# Start and enable service
sudo systemctl start postgresql
sudo systemctl enable postgresql

# Install PostGIS
sudo apt install -y postgresql-15-postgis-3

# Create the database
sudo -u postgres psql -c "CREATE DATABASE property_video_db;"

# Allow remote connections
sudo nano /etc/postgresql/15/main/pg_hba.conf
# Add this line at the end:
# host  all  all  0.0.0.0/0  scram-sha-256

sudo nano /etc/postgresql/15/main/postgresql.conf
# Change: listen_addresses = '*'

sudo systemctl restart postgresql
```

---

### 1C — Connection String Format

Regardless of hosting option, your connection string will be:

```
postgresql://USERNAME:PASSWORD@HOST:PORT/DATABASE?sslmode=require
```

Example for DigitalOcean Managed PostgreSQL:
```
postgresql://doadmin:PASS@db-property-video.db.ondigitalocean.com:25060/defaultdb?sslmode=require
```

Store this in a `.env` file. Never hardcode it in any script.

```bash
# .env (in the puppet-land-val-nums project root)
DATABASE_URL=postgresql://USERNAME:PASSWORD@HOST:PORT/DATABASE?sslmode=require
```

---

## STEP 2 — Create the Production Schema

Connect to your database and run the following SQL in order.
Every statement must succeed before moving to the next.

### 2A — Enable Extensions

```sql
-- Connect first:  psql $DATABASE_URL

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Verify all three installed correctly
SELECT name, default_version, installed_version
FROM pg_available_extensions
WHERE name IN ('postgis', 'pgcrypto', 'pg_trgm')
ORDER BY name;
```

Expected: all three rows show a value in `installed_version`.
If any show NULL, stop and resolve before continuing.

---

### 2B — Create the Properties Table

```sql
CREATE TABLE properties (
  -- Primary key
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

  -- NLA identifiers (from eLand Jamaica)
  nla_object_id     INTEGER      UNIQUE,
  valuation_number  TEXT         UNIQUE NOT NULL,
  folio_number      TEXT,

  -- Location fields
  street_address    TEXT,
  scheme_address    TEXT,
  parish            TEXT,
  location          TEXT,

  -- Coordinates (derived from geometry)
  latitude          DOUBLE PRECISION,
  longitude         DOUBLE PRECISION,

  -- PostGIS geographic types
  centroid          GEOGRAPHY(Point, 4326),
  boundary          GEOGRAPHY(Polygon, 4326),

  -- Raw GeoJSON for application use
  boundary_geojson  JSONB,

  -- Renderer cache
  cesium_coverage   BOOLEAN,

  -- Computed quality flags (auto-maintained by PostgreSQL)
  has_coordinates   BOOLEAN      GENERATED ALWAYS AS
                    (latitude IS NOT NULL AND longitude IS NOT NULL) STORED,
  has_boundary      BOOLEAN      GENERATED ALWAYS AS
                    (boundary_geojson IS NOT NULL) STORED,

  -- Metadata
  data_source       TEXT         DEFAULT 'NLA_GIS_API',
  last_fetched_at   TIMESTAMP    WITH TIME ZONE DEFAULT NOW(),
  created_at        TIMESTAMP    WITH TIME ZONE DEFAULT NOW(),
  updated_at        TIMESTAMP    WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE  properties                    IS 'All Jamaica land parcels from NLA GIS API (eLand Jamaica).';
COMMENT ON COLUMN properties.valuation_number   IS 'LV_NUMBER from NLA. Primary agent lookup key.';
COMMENT ON COLUMN properties.folio_number       IS 'VOL_FOL from NLA. Alternative lookup (e.g. 1559/614).';
COMMENT ON COLUMN properties.cesium_coverage    IS 'NULL=unchecked, true=covered, false=not covered. Set by video worker.';
```

---

### 2C — Create the Agents Table

```sql
CREATE TABLE agents (
  id                  UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id       TEXT  UNIQUE NOT NULL,
  name                TEXT,
  company             TEXT,
  brokerage           TEXT,
  phone               TEXT,
  email               TEXT,
  license_number      TEXT,
  logo_url            TEXT,
  headshot_url        TEXT,
  brand_color         TEXT  DEFAULT '#00FF00',
  tagline             TEXT,
  website             TEXT,
  subscription_status TEXT  DEFAULT 'inactive'
                      CHECK (subscription_status IN ('inactive','active','cancelled','past_due')),
  monthly_video_limit INT   DEFAULT 10
                      CHECK (monthly_video_limit = -1 OR monthly_video_limit >= 0),
  videos_used         INT   DEFAULT 0 CHECK (videos_used >= 0),
  billing_cycle_start TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE agents IS 'Registered real estate agents. Subscription status controls video generation access.';
```

---

### 2D — Create the Jobs Table

```sql
CREATE TABLE jobs (
  id               TEXT  PRIMARY KEY,
  agent_id         UUID  NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  property_id      UUID  REFERENCES properties(id) ON DELETE SET NULL,
  valuation_number TEXT  NOT NULL,
  renderer         TEXT  CHECK (renderer IN ('mapbox','cesium')),
  status           TEXT  NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','processing','complete','failed')),
  output_url       TEXT,
  error_message    TEXT,
  created_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at     TIMESTAMP WITH TIME ZONE
);

COMMENT ON TABLE jobs IS 'Video generation jobs. output_url populated when status = complete.';
```

---

### 2E — Create Indexes

Run all of these. Do not skip any.

```sql
-- Primary lookups (every video generation request uses these)
CREATE INDEX idx_properties_valuation_number
  ON properties(valuation_number);

CREATE INDEX idx_properties_folio_number
  ON properties(folio_number)
  WHERE folio_number IS NOT NULL;

CREATE INDEX idx_properties_nla_object_id
  ON properties(nla_object_id)
  WHERE nla_object_id IS NOT NULL;

-- Parish filtering
CREATE INDEX idx_properties_parish
  ON properties(parish)
  WHERE parish IS NOT NULL;

-- Data quality monitoring
CREATE INDEX idx_properties_has_coordinates
  ON properties(has_coordinates);

CREATE INDEX idx_properties_has_boundary
  ON properties(has_boundary);

-- Spatial indexes (PostGIS — for geographic queries)
CREATE INDEX idx_properties_centroid_geo
  ON properties USING GIST(centroid)
  WHERE centroid IS NOT NULL;

CREATE INDEX idx_properties_boundary_geo
  ON properties USING GIST(boundary)
  WHERE boundary IS NOT NULL;

-- Fuzzy address search
CREATE INDEX idx_properties_street_address_trgm
  ON properties USING GIN(street_address gin_trgm_ops)
  WHERE street_address IS NOT NULL;

-- Agent indexes
CREATE INDEX idx_agents_clerk_user_id      ON agents(clerk_user_id);
CREATE INDEX idx_agents_subscription_status ON agents(subscription_status);

-- Job indexes
CREATE INDEX idx_jobs_agent_id         ON jobs(agent_id);
CREATE INDEX idx_jobs_status           ON jobs(status);
CREATE INDEX idx_jobs_valuation_number ON jobs(valuation_number);
```

---

### 2F — Create Auto-Update Trigger

Keeps `updated_at` current automatically on every row change.

```sql
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_properties_updated_at
  BEFORE UPDATE ON properties
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_agents_updated_at
  BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

---

### 2G — Create Data Quality View

```sql
CREATE OR REPLACE VIEW v_data_quality_summary AS
SELECT
  COUNT(*)                                        AS total_parcels,
  COUNT(*) FILTER (WHERE has_coordinates)         AS with_coordinates,
  COUNT(*) FILTER (WHERE has_boundary)            AS with_boundary_polygon,
  COUNT(*) FILTER (WHERE NOT has_coordinates)     AS missing_coordinates,
  COUNT(*) FILTER (WHERE has_coordinates
                   AND NOT has_boundary)          AS coords_only_no_boundary,
  COUNT(*) FILTER (WHERE parish IS NOT NULL)      AS with_parish,
  ROUND(
    COUNT(*) FILTER (WHERE has_coordinates)::NUMERIC
    / NULLIF(COUNT(*),0) * 100, 2
  )                                               AS pct_with_coordinates,
  ROUND(
    COUNT(*) FILTER (WHERE has_boundary)::NUMERIC
    / NULLIF(COUNT(*),0) * 100, 2
  )                                               AS pct_with_boundary
FROM properties;

COMMENT ON VIEW v_data_quality_summary IS
  'Run: SELECT * FROM v_data_quality_summary; to see dataset health.';
```

---

### 2H — Create Parish Summary View

```sql
CREATE OR REPLACE VIEW v_parish_summary AS
SELECT
  COALESCE(parish,'UNKNOWN')                      AS parish,
  COUNT(*)                                        AS total_parcels,
  COUNT(*) FILTER (WHERE has_boundary)            AS with_boundary,
  COUNT(*) FILTER (WHERE has_coordinates)         AS with_coordinates,
  ROUND(
    COUNT(*) FILTER (WHERE has_boundary)::NUMERIC
    / NULLIF(COUNT(*),0) * 100, 1
  )                                               AS pct_with_boundary
FROM properties
GROUP BY parish
ORDER BY total_parcels DESC;

COMMENT ON VIEW v_parish_summary IS
  'Run: SELECT * FROM v_parish_summary; to see coverage by parish.';
```

---

### 2I — Create Refresh Log Table

```sql
CREATE TABLE refresh_log (
  id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at       TIMESTAMP WITH TIME ZONE NOT NULL,
  completed_at     TIMESTAMP WITH TIME ZONE,
  records_fetched  INTEGER,
  records_inserted INTEGER,
  records_updated  INTEGER,
  records_skipped  INTEGER,
  notes            TEXT
);

COMMENT ON TABLE refresh_log IS
  'Log of every full data refresh from the NLA GIS API.';
```

---

### 2J — Verify Schema Created Correctly

```sql
SELECT
  tablename  AS object_name,
  'table'    AS type
FROM pg_tables
WHERE schemaname = 'public'

UNION ALL

SELECT
  viewname,
  'view'
FROM pg_views
WHERE schemaname = 'public'

ORDER BY type, object_name;
```

Expected output — every one of these must appear:

```
agents                  | table
jobs                    | table
properties              | table
refresh_log             | table
v_data_quality_summary  | view
v_parish_summary        | view
```

If any are missing, re-run the relevant CREATE statement before continuing.

---

## STEP 3 — Run the Fetch Script

### 3A — Prepare the Scraping Environment

In your `puppet-land-val-nums` project directory:

```bash
# Install dependencies
npm install

# Confirm Puppeteer can launch a browser
node -e "const p = require('puppeteer'); p.launch().then(b => { console.log('Puppeteer OK'); b.close(); })"
```

If Puppeteer fails to launch, install missing system libraries:

```bash
sudo apt install -y \
  libgbm-dev libxkbcommon-x11-0 libgtk-3-0 \
  libasound2 libnss3 libatk-bridge2.0-0
```

---

### 3B — The Complete Fetch Script

Save this as `fetchAndSaveData.js`, replacing the existing version entirely.

```javascript
/**
 * fetchAndSaveData.js
 *
 * Scrapes ALL property parcels from the NLA GIS REST API (eLand Jamaica).
 * Fetches valuation numbers, folio numbers, addresses, coordinates,
 * and boundary polygons for every parcel in the system.
 *
 * Output: land_val_numbers.json
 *
 * Run:    node fetchAndSaveData.js
 * Resume: re-run the same command if interrupted — resumes automatically.
 */

const puppeteer = require('puppeteer');
const fs        = require('fs');

const NLA_URL          = 'https://gisportal.nla.gov.jm/nlagis/rest/services/ElandjamaicaAug162024/MapServer/16/query';
const PAGE_SIZE        = 1000;
const REQUEST_DELAY_MS = 3000;
const OUTPUT_FILE      = 'land_val_numbers.json';
const PROGRESS_FILE    = 'fetch_progress.json';
const LOG_FILE         = 'fetch_log.txt';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function saveToJsonFile(data, filename) {
  try {
    fs.writeFileSync(filename, JSON.stringify(data, null, 2));
    log(`Saved ${data.length} records to ${filename}`);
  } catch (err) {
    log(`ERROR writing ${filename}: ${err.message}`);
    throw err;
  }
}

function saveProgress(pageIndex, totalFetched) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ pageIndex, totalFetched }));
}

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
      log(`Resuming from page ${saved.pageIndex} (${saved.totalFetched} records already fetched)`);
      return saved;
    }
  } catch { /* start fresh */ }
  return { pageIndex: 0, totalFetched: 0 };
}

function extractGeometry(feature) {
  let latitude = null, longitude = null, boundaryGeojson = null;
  const geo = feature.geometry;
  if (!geo) return { latitude, longitude, boundaryGeojson };

  if (geo.rings && geo.rings.length > 0) {
    boundaryGeojson = { type: 'Polygon', coordinates: geo.rings };
    const ring  = geo.rings[0];
    longitude   = ring.reduce((s, p) => s + p[0], 0) / ring.length;
    latitude    = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  } else if (geo.x !== undefined && geo.y !== undefined) {
    longitude = geo.x;
    latitude  = geo.y;
  }
  return { latitude, longitude, boundaryGeojson };
}

function isValidCoordinate(lat, lng) {
  if (lat === null || lng === null)  return false;
  if (lat === 0   && lng === 0)      return false;
  if (lat < 17.5  || lat > 19.0)    return false;
  if (lng < -79.0 || lng > -76.0)   return false;
  return true;
}

function mapFeature(feature) {
  const attr = feature.attributes;
  const { latitude, longitude, boundaryGeojson } = extractGeometry(feature);
  const coordsValid = isValidCoordinate(latitude, longitude);

  return {
    nlaObjectId:     attr.OBJECTID                  || null,
    lvNumber:        (attr.LV_NUMBER  || '').trim(),
    volFol:          (attr.VOL_FOL    || '').trim()  || null,
    streetAdd:       (attr.STREET_ADD || '').trim()  || null,
    schemeAdd:       (attr.SCHEME_ADD || '').trim()  || null,
    parish:          (attr.PARISH     || '').trim()  || null,
    location:        (attr.LOCATION   || '').trim()  || null,
    latitude:        coordsValid ? latitude        : null,
    longitude:       coordsValid ? longitude       : null,
    boundaryGeojson: coordsValid ? boundaryGeojson : null,
    _hasCoords:      coordsValid,
    _hasBoundary:    coordsValid && boundaryGeojson !== null,
    _coordsInvalid:  !coordsValid && (latitude !== null || longitude !== null)
  };
}

(async () => {
  fs.writeFileSync(LOG_FILE, '');
  log('=== NLA GIS Fetch Started ===');

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  page.on('console', msg => {
    if (msg.type() === 'error') log(`Browser error: ${msg.text()}`);
  });

  let allData  = [];
  const progress = loadProgress();
  let pageIndex  = progress.pageIndex;

  if (pageIndex > 0 && fs.existsSync(OUTPUT_FILE)) {
    try {
      allData = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
      log(`Loaded ${allData.length} existing records from ${OUTPUT_FILE}`);
    } catch {
      log('Could not load partial output — starting fresh');
      allData = []; pageIndex = 0;
    }
  }

  let totalWithPolygon = 0, totalPointOnly = 0;
  let totalNoGeometry  = 0, totalBadCoords = 0;
  const MAX_RETRIES = 3;

  async function fetchPage() {
    const params = new URLSearchParams({
      where:             '1=1',
      outFields:         'OBJECTID,LV_NUMBER,VOL_FOL,STREET_ADD,SCHEME_ADD,PARISH,LOCATION',
      returnGeometry:    'true',
      geometryType:      'esriGeometryPolygon',
      outSR:             '4326',
      f:                 'json',
      resultOffset:      pageIndex * PAGE_SIZE,
      resultRecordCount: PAGE_SIZE
    });

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await page.goto(`${NLA_URL}?${params}`, { waitUntil: 'networkidle0', timeout: 30000 });
        const content = await page.content();
        const match   = content.match(/{.*}/s);
        if (!match) throw new Error('No JSON found in response');

        const result = JSON.parse(match[0]);
        if (result.error) throw new Error(`API error: ${result.error.message}`);
        if (!result.features || result.features.length === 0) {
          log('No more features — fetch complete');
          return false;
        }

        const mapped      = result.features.map(mapFeature);
        const pagePolygon = mapped.filter(r => r._hasBoundary).length;
        const pagePoint   = mapped.filter(r => r._hasCoords && !r._hasBoundary).length;
        const pageNone    = mapped.filter(r => !r._hasCoords && !r._coordsInvalid).length;
        const pageBad     = mapped.filter(r => r._coordsInvalid).length;

        totalWithPolygon += pagePolygon;
        totalPointOnly   += pagePoint;
        totalNoGeometry  += pageNone;
        totalBadCoords   += pageBad;

        const clean = mapped.map(({ _hasCoords, _hasBoundary, _coordsInvalid, ...rest }) => rest);
        allData = allData.concat(clean);

        log(
          `Page ${pageIndex + 1} — ${mapped.length} parcels | ` +
          `Polygons: ${pagePolygon} | Points: ${pagePoint} | ` +
          `No geometry: ${pageNone} | Bad coords: ${pageBad} | ` +
          `Total so far: ${allData.length}`
        );

        saveProgress(pageIndex + 1, allData.length);
        saveToJsonFile(allData, OUTPUT_FILE);

        if (result.features.length === PAGE_SIZE) {
          pageIndex++;
          log(`Waiting ${REQUEST_DELAY_MS / 1000}s before next request...`);
          await delay(REQUEST_DELAY_MS);
          return true;
        }
        return false;

      } catch (err) {
        log(`Attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
        if (attempt < MAX_RETRIES) {
          const backoff = REQUEST_DELAY_MS * attempt * 2;
          log(`Backing off ${backoff / 1000}s...`);
          await delay(backoff);
        } else {
          throw err;
        }
      }
    }
  }

  try {
    let continueLoop = true;
    while (continueLoop) {
      continueLoop = await fetchPage();
    }

    log('=== Fetch Complete ===');
    log(`Total parcels fetched:  ${allData.length}`);
    log(`With polygon boundary:  ${totalWithPolygon} (${(totalWithPolygon/allData.length*100).toFixed(1)}%)`);
    log(`With point only:        ${totalPointOnly}   (${(totalPointOnly/allData.length*100).toFixed(1)}%)`);
    log(`No geometry:            ${totalNoGeometry}  (${(totalNoGeometry/allData.length*100).toFixed(1)}%)`);
    log(`Bad / out-of-bounds:    ${totalBadCoords}   (${(totalBadCoords/allData.length*100).toFixed(1)}%)`);

    if (fs.existsSync(PROGRESS_FILE)) fs.unlinkSync(PROGRESS_FILE);

  } catch (err) {
    log(`FATAL ERROR: ${err.message}`);
    log(`Partial data saved to ${OUTPUT_FILE} (${allData.length} records)`);
    log('Re-run the script to resume from the last saved page.');
  } finally {
    await browser.close();
  }
})();
```

---

### 3C — Run the Script

```bash
node fetchAndSaveData.js
```

**What you will see:**

```
[timestamp] === NLA GIS Fetch Started ===
[timestamp] Page 1 — 1000 parcels | Polygons: 847 | Points: 120 | No geometry: 33 | Bad coords: 0 | Total so far: 1000
[timestamp] Waiting 3s before next request...
[timestamp] Page 2 — 1000 parcels | ...
...
[timestamp] === Fetch Complete ===
[timestamp] Total parcels fetched:  485000
[timestamp] With polygon boundary:  412000 (85.0%)
```

**If interrupted:** Re-run `node fetchAndSaveData.js`. The script detects
`fetch_progress.json` and resumes from the last saved page automatically.

**Expected run time:** 400,000–600,000 parcels at 1,000 per page with a
3-second delay = 400–600 pages = 20–30 minutes total.

---

## STEP 4 — Validate the Raw JSON Output

Before inserting anything into the database, run these checks
against the output file. All checks must pass.

### 4A — Record Count Check

```bash
node -e "
const data = JSON.parse(require('fs').readFileSync('land_val_numbers.json', 'utf8'));
console.log('Total records:', data.length);
console.log('First record:', JSON.stringify(data[0], null, 2));
console.log('Last record:', JSON.stringify(data[data.length - 1], null, 2));
"
```

---

### 4B — Coverage Analysis

```bash
node -e "
const data = JSON.parse(require('fs').readFileSync('land_val_numbers.json', 'utf8'));

const withPolygon     = data.filter(r => r.boundaryGeojson !== null).length;
const withCoords      = data.filter(r => r.latitude !== null).length;
const noCoords        = data.filter(r => r.latitude === null).length;
const missingLvNum    = data.filter(r => !r.lvNumber || r.lvNumber.trim() === '').length;
const duplicateLvNums = data.length - new Set(data.map(r => r.lvNumber)).size;
const allZero         = data.filter(r => r.latitude === 0 && r.longitude === 0).length;

const parishes = {};
data.forEach(r => { const p = r.parish || 'UNKNOWN'; parishes[p] = (parishes[p]||0) + 1; });

console.log('=== Coverage Report ===');
console.log('Total records:         ', data.length);
console.log('With polygon boundary: ', withPolygon,  '(' + (withPolygon/data.length*100).toFixed(1) + '%)');
console.log('With coordinates:      ', withCoords,   '(' + (withCoords/data.length*100).toFixed(1)  + '%)');
console.log('No coordinates:        ', noCoords,     '(' + (noCoords/data.length*100).toFixed(1)    + '%)');
console.log('All-zero coordinates:  ', allZero);
console.log('Missing LV number:     ', missingLvNum);
console.log('Duplicate LV numbers:  ', duplicateLvNums);
console.log('');
console.log('=== By Parish ===');
Object.entries(parishes).sort((a,b) => b[1]-a[1])
  .forEach(([p,c]) => console.log(p.padEnd(30), c));
"
```

---

### 4C — Spot-Check Known Properties

```bash
node -e "
const data = JSON.parse(require('fs').readFileSync('land_val_numbers.json', 'utf8'));
const testNumbers = ['13004014089']; // Replace with real valuation numbers you know
testNumbers.forEach(n => {
  const match = data.find(r => r.lvNumber === n);
  console.log(match ? 'FOUND: ' + JSON.stringify(match, null, 2) : 'NOT FOUND: ' + n);
});
"
```

---

### ⚠️ STOP CONDITIONS — CLARIFICATION REQUIRED

If the coverage analysis reveals any of the problems in the table
below, the agent must STOP and present the matching clarification
question before proceeding. Do not proceed to ingestion if any
stop condition is triggered.

---

#### Stop Condition 1 — Less than 50% with coordinates OR all coordinates are 0,0

This means the API is either not returning geometry, or the coordinate
system conversion failed.

> "The fetch returned fewer coordinates than expected. How should we proceed?"

| Option | Description | Why Consider It |
|--------|-------------|-----------------|
| A | Re-run the fetch script with `headless: false` so you can watch the browser and inspect the raw API response in the network tab | Lets you see exactly what the API is returning and whether geometry is present in the raw JSON before any processing. Best for diagnosing whether the problem is in the API or in the script. |
| B | Test the NLA API URL directly in a browser with `?returnGeometry=true&outSR=4326` appended and inspect the raw JSON | Fastest way to confirm whether the NLA API supports geometry output for this dataset. If the raw JSON has no geometry field, the API does not support it and we need a different approach. |
| C | Proceed with coordinates-only records and accept that boundary overlays will use the bounding box fallback for all properties | Only choose this if the API has confirmed it does not return geometry. The video will still work but boundary lines will be approximate rectangles, not real property shapes. |

**Do not proceed until one option is chosen and its outcome is reported.**

---

#### Stop Condition 2 — More than 1% duplicate LV numbers

This means the same valuation number appears more than once in the
output, which will cause ingestion conflicts.

> "Duplicate valuation numbers were found in the output. How should we handle them?"

| Option | Description | Why Consider It |
|--------|-------------|-----------------|
| A | Keep the record with the most complete data (has boundary polygon preferred over point-only, point-only preferred over no geometry) | Produces the highest-quality dataset. Requires a deduplication script to run before ingestion. |
| B | Keep the last occurrence of each duplicate (the most recently fetched version) | Simplest to implement. Works well if duplicates are caused by NLA data updates where the newer record supersedes the older one. |
| C | Keep all duplicates and let the ingestion script's upsert logic handle it (last write wins) | Requires no extra processing. Acceptable if the duplicate rate is below 5% and the records are near-identical. Not recommended above 5%. |

**Do not proceed until one option is chosen.**

---

#### Stop Condition 3 — More than 5% missing LV numbers

This means a significant portion of records have no valuation number
and cannot be looked up by agents.

> "More than 5% of records are missing their LV number. How should we proceed?"

| Option | Description | Why Consider It |
|--------|-------------|-----------------|
| A | Skip all records without an LV number during ingestion and log them to a separate file for manual review | Keeps the database clean. The logged file lets you investigate whether the missing numbers are a data quality issue in NLA or a parsing bug in the script. |
| B | Inspect the raw API response for a sample of missing records to determine if the field name changed or the data is genuinely absent | The NLA API field name for the valuation number could differ from `LV_NUMBER` for some record types. This option investigates before discarding data. |
| C | Halt the entire fetch and contact NLA to understand why records lack valuation numbers before proceeding | Choose this if the percentage is very high (above 20%) and you suspect a systemic API issue rather than isolated data quality gaps. |

**Do not proceed until one option is chosen.**

---

#### Stop Condition 4 — Fewer than 14 parishes in the output

Jamaica has exactly 14 parishes. If any are missing, coverage is incomplete.

> "Some Jamaica parishes are missing from the dataset. How should we proceed?"

| Option | Description | Why Consider It |
|--------|-------------|-----------------|
| A | Proceed with the data available and note which parishes are missing — coverage can be supplemented in a future refresh | Acceptable if the missing parishes have low property density (e.g. very rural) and the product can launch without them. |
| B | Re-run the fetch with a parish-specific filter for each missing parish to determine if they exist in the API at all | The NLA API supports `where=PARISH='ST. THOMAS'` style filters. This confirms whether the data exists but was missed, or genuinely does not exist. |
| C | Halt and investigate — all 14 parishes must be present before the database is considered production-ready | Choose this if you require full Jamaica coverage for the product to be viable. |

**Do not proceed until one option is chosen.**

---

If all coverage analysis checks pass (no stop conditions triggered),
proceed directly to Step 5. No clarification is needed.

---

## STEP 5 — Run the Ingestion Script

### 5A — Install Script Dependencies

```bash
npm install pg dotenv
```

---

### 5B — The Complete Ingestion Script

Save this as `ingestToDatabase.js`:

```javascript
/**
 * ingestToDatabase.js
 *
 * Reads land_val_numbers.json and inserts all records into
 * the PostgreSQL properties table.
 *
 * Run:    node ingestToDatabase.js
 * Safe:   uses ON CONFLICT DO UPDATE — re-runnable without duplicating data.
 */

require('dotenv').config();
const { Pool } = require('pg');
const fs       = require('fs');

const INPUT_FILE = 'land_val_numbers.json';
const BATCH_SIZE = 500;
const LOG_FILE   = 'ingest_log.txt';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:  { rejectUnauthorized: false },
  max:  5,
  idleTimeoutMillis:      30000,
  connectionTimeoutMillis: 10000
});

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function geojsonToWKT(geojson) {
  if (!geojson || geojson.type !== 'Polygon') return null;
  try {
    const ring = geojson.coordinates[0].map(([lng, lat]) => `${lng} ${lat}`).join(', ');
    return `POLYGON((${ring}))`;
  } catch { return null; }
}

async function insertBatch(client, batch) {
  let inserted = 0, updated = 0, skipped = 0;

  for (const record of batch) {
    if (!record.lvNumber || record.lvNumber.trim() === '') { skipped++; continue; }

    const boundaryWKT = geojsonToWKT(record.boundaryGeojson);
    const centroidWKT = record.latitude && record.longitude
      ? `POINT(${record.longitude} ${record.latitude})` : null;

    try {
      const result = await client.query(`
        INSERT INTO properties (
          nla_object_id, valuation_number, folio_number,
          street_address, scheme_address, parish, location,
          latitude, longitude, centroid, boundary, boundary_geojson,
          last_fetched_at
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,
          CASE WHEN $10 IS NOT NULL THEN ST_GeographyFromText('SRID=4326;'||$10) ELSE NULL END,
          CASE WHEN $11 IS NOT NULL THEN ST_GeographyFromText('SRID=4326;'||$11) ELSE NULL END,
          $12, NOW()
        )
        ON CONFLICT (valuation_number) DO UPDATE SET
          nla_object_id    = EXCLUDED.nla_object_id,
          folio_number     = EXCLUDED.folio_number,
          street_address   = EXCLUDED.street_address,
          scheme_address   = EXCLUDED.scheme_address,
          parish           = EXCLUDED.parish,
          location         = EXCLUDED.location,
          latitude         = EXCLUDED.latitude,
          longitude        = EXCLUDED.longitude,
          centroid         = EXCLUDED.centroid,
          boundary         = EXCLUDED.boundary,
          boundary_geojson = EXCLUDED.boundary_geojson,
          last_fetched_at  = NOW()
        RETURNING (xmax = 0) AS was_inserted
      `, [
        record.nlaObjectId || null,
        record.lvNumber.trim(),
        record.volFol    || null,
        record.streetAdd || null,
        record.schemeAdd || null,
        record.parish    || null,
        record.location  || null,
        record.latitude  || null,
        record.longitude || null,
        centroidWKT,
        boundaryWKT,
        record.boundaryGeojson ? JSON.stringify(record.boundaryGeojson) : null
      ]);

      result.rows[0]?.was_inserted ? inserted++ : updated++;

    } catch (err) {
      log(`ERROR on ${record.lvNumber}: ${err.message}`);
      skipped++;
    }
  }
  return { inserted, updated, skipped };
}

(async () => {
  fs.writeFileSync(LOG_FILE, '');
  log('=== Ingestion Started ===');

  let data;
  try {
    data = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
    log(`Loaded ${data.length} records from ${INPUT_FILE}`);
  } catch (err) {
    log(`FATAL: Cannot read ${INPUT_FILE}: ${err.message}`);
    process.exit(1);
  }

  let client;
  try {
    client = await pool.connect();
    log('Database connection successful');
  } catch (err) {
    log(`FATAL: Cannot connect to database: ${err.message}`);
    log('Check that DATABASE_URL is set correctly in .env');
    process.exit(1);
  }

  let totalInserted = 0, totalUpdated = 0, totalSkipped = 0, batchNumber = 0;

  try {
    for (let i = 0; i < data.length; i += BATCH_SIZE) {
      const batch = data.slice(i, i + BATCH_SIZE);
      batchNumber++;

      await client.query('BEGIN');
      try {
        const { inserted, updated, skipped } = await insertBatch(client, batch);
        await client.query('COMMIT');

        totalInserted += inserted;
        totalUpdated  += updated;
        totalSkipped  += skipped;

        const pct = Math.round((i + batch.length) / data.length * 100);
        log(
          `Batch ${batchNumber} (${pct}%) — ` +
          `Inserted: ${inserted} | Updated: ${updated} | Skipped: ${skipped} | ` +
          `Totals — Inserted: ${totalInserted} | Updated: ${totalUpdated}`
        );
      } catch (err) {
        await client.query('ROLLBACK');
        log(`Batch ${batchNumber} rolled back: ${err.message}`);
      }
    }

    log('=== Ingestion Complete ===');
    log(`Total inserted:  ${totalInserted}`);
    log(`Total updated:   ${totalUpdated}`);
    log(`Total skipped:   ${totalSkipped}`);
    log(`Total processed: ${totalInserted + totalUpdated + totalSkipped}`);

  } finally {
    client.release();
    await pool.end();
  }
})();
```

---

### 5C — Run the Ingestion Script

```bash
# Confirm .env has the correct DATABASE_URL
cat .env

# Run
node ingestToDatabase.js
```

**Expected run time:** 5–15 minutes for 400,000–600,000 records.

---

## STEP 6 — Verify Data Integrity

Run every query. All must pass before proceeding to Step 7.

### 6A — Row Count

```sql
SELECT COUNT(*) AS total_rows FROM properties;
-- Must be within 1% of the record count from land_val_numbers.json
```

### 6B — Data Quality Summary

```sql
SELECT * FROM v_data_quality_summary;
```

Minimum acceptable thresholds:

| Metric                  | Minimum |
|-------------------------|---------|
| `pct_with_coordinates`  | 70%     |
| `pct_with_boundary`     | 50%     |
| `total_parcels`         | 100,000 |

### 6C — Parish Breakdown

```sql
SELECT * FROM v_parish_summary;
```

All 14 parishes must appear: Clarendon, Hanover, Kingston, Manchester,
Portland, St. Andrew, St. Ann, St. Catherine, St. Elizabeth,
St. James, St. Mary, St. Thomas, Trelawny, Westmoreland.

### 6D — Lookup Test

```sql
SELECT
  id, valuation_number, folio_number, parish,
  street_address, latitude, longitude,
  has_coordinates, has_boundary,
  ST_AsGeoJSON(centroid) AS centroid_geojson,
  boundary_geojson
FROM properties
WHERE valuation_number = '13004014089'
   OR folio_number     = '13004014089';
```

Must return exactly one row with correct coordinates and boundary data.

### 6E — Index Performance Test

```sql
EXPLAIN ANALYZE
SELECT id, latitude, longitude, boundary_geojson
FROM properties
WHERE valuation_number = '13004014089';
```

Must show `Index Scan` in the output. If you see `Seq Scan`,
re-run Step 2E — the index was not created correctly.

### 6F — Geometry Validity Check

```sql
SELECT COUNT(*) AS invalid_boundaries
FROM properties
WHERE boundary IS NOT NULL
  AND NOT ST_IsValid(boundary::geometry);
```

Expected: 0. If greater than 0, stop and report the count before proceeding.

### 6G — Coordinate Range Check

```sql
SELECT COUNT(*) AS out_of_bounds
FROM properties
WHERE latitude IS NOT NULL
  AND (
    latitude  < 17.5 OR latitude  > 19.0 OR
    longitude < -79.0 OR longitude > -76.0
  );
```

Expected: 0. If greater than 0, the coordinate validation in the fetch
script needs adjustment — stop and report.

---

## STEP 7 — Production Hardening

Apply these settings after Step 6 passes. Run them in order.

### 7A — Row-Level Security

```sql
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;

CREATE POLICY agents_isolation_policy ON agents
  USING (clerk_user_id = current_setting('app.current_user_id', true));
```

This prevents any bug in the application from ever returning one
agent's data to a different agent. It is enforced at the database
level and cannot be bypassed by application code.

---

### 7B — Create Application User

#### ⚠️ CLARIFICATION REQUIRED — Password Generation and Storage

Before running the SQL in this step, a password must be created for
the `app_user` database account. The agent must not invent a password
on its own. Choose how the password will be generated and where it
will be stored before proceeding.

> "How should the app_user database password be generated and stored?"

| Option | Description | Why Consider It |
|--------|-------------|-----------------|
| A | Generate a cryptographically random password using the command line (`openssl rand -base64 32`), store it in a password manager (e.g. 1Password, Bitwarden), and paste it into the SQL and the application `.env` file manually | Most secure method. The password is never typed by hand, never appears in a file on disk in plain text beyond the `.env` file, and is stored in a dedicated secrets manager. Recommended for production. |
| B | Use DigitalOcean's built-in database user management panel to create the `app_user` and let DigitalOcean generate and display the password, then copy it into the application `.env` | Convenient if using DigitalOcean Managed PostgreSQL. DigitalOcean generates a strong password automatically. The risk is that the password is only shown once — it must be copied immediately. |
| C | Store the password in a `.env` file locally and also add it to the application hosting environment (Vercel environment variables) manually | This is the storage step, not the generation step. Use this in combination with Option A or B. The `.env` file must never be committed to version control — confirm `.gitignore` includes `.env` before proceeding. |

**Do not proceed until one option is chosen. Once chosen, generate
the password using the chosen method, store it securely, then return
here and substitute it into the SQL below in place of
`PASTE_GENERATED_PASSWORD_HERE`.**

---

```sql
-- Substitute the generated password before running this block
CREATE USER app_user WITH PASSWORD 'PASTE_GENERATED_PASSWORD_HERE';

-- Read/write on application tables only
GRANT SELECT, INSERT, UPDATE, DELETE ON properties TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON agents     TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON jobs       TO app_user;

-- Read on monitoring views
GRANT SELECT ON v_data_quality_summary TO app_user;
GRANT SELECT ON v_parish_summary       TO app_user;
GRANT SELECT ON refresh_log            TO app_user;

-- UUID generation
GRANT EXECUTE ON FUNCTION gen_random_uuid() TO app_user;

-- app_user cannot DROP tables, ALTER schema, or access system tables
-- Ingestion scripts continue to use the admin/doadmin credentials
```

After running the SQL, update the application `.env` file with the
new `app_user` connection string:

```bash
# Replace the existing DATABASE_URL with the app_user version
# Use port 25061 (PgBouncer) for the application
# Use port 25060 (direct) for admin tasks and ingestion only
DATABASE_URL=postgresql://app_user:PASTE_GENERATED_PASSWORD_HERE@HOST:25061/DATABASE?sslmode=require
```

Confirm the password is also added to Vercel environment variables
before the application is deployed.

---

### 7C — Verify app_user Permissions

Run this block logged in as `app_user` to confirm it can read and
write but cannot perform admin operations:

```sql
-- Connect as app_user:
-- psql "postgresql://app_user:PASSWORD@HOST:PORT/DATABASE?sslmode=require"

-- These must succeed:
SELECT COUNT(*) FROM properties;       -- read
SELECT COUNT(*) FROM agents;           -- read
SELECT COUNT(*) FROM jobs;             -- read
SELECT * FROM v_data_quality_summary;  -- view read

-- This must fail with a permission error:
DROP TABLE properties;
-- Expected: ERROR: must be owner of table properties
```

If the DROP succeeds, the permissions were not applied correctly.
Stop and re-run Step 7B.

---

### 7D — Connection Pooling

```sql
ALTER ROLE app_user CONNECTION LIMIT 20;
```

If using DigitalOcean Managed PostgreSQL, also enable PgBouncer
from the DigitalOcean control panel:
- Click your database cluster → **Connection Pools** → **Create Pool**
- Pool name: `app-pool`
- Database: `defaultdb`
- User: `app_user`
- Mode: **Transaction**
- Pool size: **10**

The application connects to the PgBouncer port (25061), not the
direct database port (25060). Direct port is for admin use only.

---

### 7E — Backup Verification

**DigitalOcean Managed PostgreSQL:**
- Go to your cluster → **Backups**
- Confirm daily backups are enabled
- Confirm retention is at least 7 days
- Click **Create Backup** to take a manual baseline backup right now

**Self-managed Droplet:**

```bash
# Create backup directory
mkdir -p /backups

# Add to crontab (crontab -e):
# Daily at 2am, keeps 7 days
0 2 * * * pg_dump $DATABASE_URL | gzip > /backups/property_db_$(date +\%Y\%m\%d).sql.gz
find /backups -name "*.sql.gz" -mtime +7 -delete
```

---

### 7F — Performance Settings

**DigitalOcean Managed PostgreSQL:** Skip this step. Settings are
pre-tuned for your plan size automatically.

**Self-managed Droplet only:**

```sql
ALTER SYSTEM SET shared_buffers              = '512MB';
ALTER SYSTEM SET effective_cache_size        = '1536MB';
ALTER SYSTEM SET maintenance_work_mem        = '128MB';
ALTER SYSTEM SET checkpoint_completion_target = '0.9';
ALTER SYSTEM SET wal_buffers                 = '16MB';
ALTER SYSTEM SET default_statistics_target   = '100';
ALTER SYSTEM SET random_page_cost            = '1.1';
ALTER SYSTEM SET effective_io_concurrency    = '200';
SELECT pg_reload_conf();
```

---

## STEP 8 — Database Refresh Workflow

The NLA data changes as new parcels are registered and boundaries
are updated. This procedure keeps the database current.

### 8A — Refresh Frequency

| Trigger | Action |
|---------|--------|
| Initial build | Run now (you are doing this) |
| Monthly maintenance | Re-run fetch + ingest |
| NLA announces a data update | Run immediately |

### 8B — Refresh Procedure

Both scripts are safe to re-run. The fetch overwrites the JSON file
and the ingestion script upserts — it will not create duplicates.

```bash
# 1. Force a full fresh fetch (delete the progress file)
rm -f fetch_progress.json

# 2. Fetch all data again
node fetchAndSaveData.js

# 3. Validate output (Step 4 checks)
node -e "/* coverage analysis from Step 4B */"

# 4. Ingest into database (upserts — no duplicates)
node ingestToDatabase.js

# 5. Confirm data quality
psql $DATABASE_URL -c "SELECT * FROM v_data_quality_summary;"
```

### 8C — Log Each Refresh

After every refresh, insert a record into `refresh_log`:

```sql
INSERT INTO refresh_log
  (started_at, completed_at, records_fetched, records_inserted, records_updated, notes)
VALUES
  (NOW() - INTERVAL '25 minutes', NOW(), 487000, 3200, 483800,
   'Monthly refresh — April 2026');
```

---

## STEP 9 — Final Pre-Handoff Checklist

Every item must be checked before the database is considered
production-ready and before application development begins.

### Schema
- [ ] `properties` table created with all columns
- [ ] `agents` table created with all columns
- [ ] `jobs` table created with all columns
- [ ] `refresh_log` table created
- [ ] All 13 indexes created (run `\di` in psql to list)
- [ ] Auto-update triggers created on `properties` and `agents`
- [ ] `v_data_quality_summary` view exists and returns data
- [ ] `v_parish_summary` view exists and returns data

### Data
- [ ] Fetch script completed without fatal errors
- [ ] `land_val_numbers.json` contains more than 100,000 records
- [ ] `fetch_progress.json` deleted (confirms full fetch, not partial)
- [ ] All Step 4 stop conditions passed or resolved with a chosen option
- [ ] Ingestion script completed without fatal errors
- [ ] `SELECT COUNT(*) FROM properties` matches JSON count within 1%
- [ ] `pct_with_coordinates` is at least 70%
- [ ] `pct_with_boundary` is at least 50%
- [ ] All 14 Jamaica parishes appear in `v_parish_summary`
- [ ] Lookup test returns one correct row for a known valuation number
- [ ] Index performance test shows `Index Scan` not `Seq Scan`
- [ ] Zero invalid geometries
- [ ] Zero out-of-bounds coordinates

### Security
- [ ] Password generation method chosen and executed (Step 7B clarification)
- [ ] Password stored in password manager or DigitalOcean panel
- [ ] `app_user` database account created with restricted permissions
- [ ] `app_user` permission verification test passed (DROP failed as expected)
- [ ] Row-level security enabled on `agents` table
- [ ] `.env` file contains `app_user` connection string
- [ ] `.env` is listed in `.gitignore` — confirmed not committed to version control
- [ ] Backups confirmed enabled and a manual baseline backup taken

### Connection
- [ ] `DATABASE_URL` (app_user, PgBouncer port 25061) documented and stored securely
- [ ] Admin connection string (doadmin, direct port 25060) stored separately for ingestion use
- [ ] Database is reachable from the planned application hosting environment

---

## Application Connection Reference

When the application is ready to connect, use these values.

```bash
# /app/.env.local  (Next.js application)

# Application database connection (app_user, via PgBouncer)
DATABASE_URL=postgresql://app_user:PASSWORD@HOST:25061/DATABASE?sslmode=require

# Admin connection (for ingestion scripts only — never used by the application)
DATABASE_ADMIN_URL=postgresql://doadmin:PASSWORD@HOST:25060/DATABASE?sslmode=require
```

Database connection in the application:

```typescript
// /lib/db.ts
import { Pool } from 'pg';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis:       30000,
  connectionTimeoutMillis: 10000
});
```

Property lookup query (the exact query the application uses):

```typescript
async function getProperty(valuationNumber: string) {
  const res = await pool.query(
    `SELECT
       id, valuation_number, folio_number,
       parish, street_address, scheme_address, location,
       latitude, longitude,
       boundary_geojson, has_coordinates, has_boundary,
       cesium_coverage
     FROM properties
     WHERE valuation_number = $1
        OR folio_number     = $1
     LIMIT 1`,
    [valuationNumber.trim()]
  );
  return res.rows[0] || null;
 }
 ```

---

## Appendix — Local macOS (Postgres.app): “Reindexing required”

**Not specific to this schema.** [Postgres.app](https://postgresapp.com) can show this after a **macOS upgrade** or when the data directory was **in use before and after macOS 11** (or history is unknown), because **Apple libc collation** order for default locales can change. Indexes built under the old ordering may then be wrong. The banner is a **heuristic** (sometimes a false positive). Authoritative app docs: [Reindexing your database](https://postgresapp.com/documentation/reindex-warning.html), [Troubleshooting](https://postgresapp.com/documentation/troubleshooting.html).

**Fix the data (required):** Rebuild indexes on **every** database. Easiest from the command line (Postgres.app provides `reindexdb` on `PATH` when you use their terminal instructions, or add their `bin` to `PATH`):

```bash
# Default local port; override if needed (e.g. export PGPORT=5432)
reindexdb --all --echo
```

**Alternative:** In `psql`, connect **to each database** and run `REINDEX DATABASE` for *that* database (you cannot reindex a different DB from one session). For mixed-case names use identifiers exactly as created, e.g. `REINDEX DATABASE "prismaTest";` — unquoted names are lowercased.

**Clear the app UI (after reindexing):** The banner does **not** go away automatically. In Postgres.app use **More Info → Hide this Warning** so the app records a new baseline. That does not replace reindexing.

**If `REINDEX` errors on a unique index:** You may have duplicate values; clean data first (unrelated to the normal “post–macOS reindex” path).

**Version:** Production in this plan uses **PostgreSQL 15+**; **PostgreSQL 14** on Postgres.app for local work is common — apply `schema.sql` and note any 15-only features you rely on.

---

## END OF PHASE 0

When every item on the Step 9 checklist is checked, the database is
production-ready. Proceed to Phase 1 — Application Development.