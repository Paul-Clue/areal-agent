# Phase 0 — Database Update Plan (v1)
## Handling Duplicate Valuation Numbers and Incomplete NLA Records

**Purpose:** Update the existing production PostgreSQL database to correctly
handle the one-to-many relationship between land valuation numbers and physical
parcels, and to flag incomplete NLA records where LV numbers end in `---` or
fields such as folio and parish are null.

**Prerequisite:** Phase 0 database plan v2 has already been implemented.
The `properties`, `agents`, `jobs`, and `refresh_log` tables already exist
and are populated. This plan makes additive changes only — nothing is dropped,
truncated, or rebuilt.

---

## Overview

```
STEP 1  Add columns to the existing properties table
STEP 2  Create the property_parcels table
STEP 3  Create indexes on property_parcels
STEP 4  Create supporting views
STEP 5  Run the parcel ingestion script
STEP 6  Populate has_multiple_parcels on the properties table
STEP 7  Verify the update
STEP 8  Update the application lookup logic
STEP 9  Final checklist
```

Every step must be completed and verified before moving to the next.
The implementing agent must not skip or combine steps.

---

## STEP 1 — Add Columns to the Existing Properties Table

These two columns are added to the existing `properties` table.
No existing data is changed. Both columns default to safe values.

Connect to your database and run:

```sql
-- 1A. Flag indicating this LV number has more than one physical parcel
--     in the property_parcels table.
--     Default FALSE — updated in bulk by Step 6 after parcels are ingested.
ALTER TABLE properties
ADD COLUMN IF NOT EXISTS has_multiple_parcels BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN properties.has_multiple_parcels IS
  'TRUE if this valuation number has more than one physical parcel '
  'in the property_parcels table. Set by the ingestion pipeline. '
  'When TRUE, the application presents a disambiguation modal to the agent.';

-- 1B. Flag indicating the canonical row chosen from among multiple parcels.
--     Describes the selection strategy used so it can be audited later.
ALTER TABLE properties
ADD COLUMN IF NOT EXISTS canonical_selection_method TEXT;

COMMENT ON COLUMN properties.canonical_selection_method IS
  'How the canonical parcel was chosen when multiple parcels share this '
  'valuation number. Values: most_complete_address, largest_boundary, '
  'first_fetched, only_parcel. NULL for records ingested before this '
  'column existed.';
```

### Verify Step 1

```sql
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'properties'
  AND column_name IN ('has_multiple_parcels', 'canonical_selection_method')
ORDER BY column_name;
```

Expected: two rows returned. If either is missing, re-run the relevant
`ALTER TABLE` statement before continuing.

---

## STEP 2 — Create the property_parcels Table

This table stores every individual NLA GIS feature, one row per
`nla_object_id`. For LV numbers with only one parcel, there will be
exactly one row here. For LV numbers with multiple parcels, there
will be one row per parcel.

```sql
CREATE TABLE IF NOT EXISTS property_parcels (
  -- Primary key — NLA's own unique feature ID
  nla_object_id       INTEGER       PRIMARY KEY,

  -- Link to the canonical properties row
  -- ON DELETE SET NULL: if the canonical row is ever removed,
  -- the parcel record is kept but unlinked rather than deleted.
  valuation_number    TEXT          NOT NULL
                      REFERENCES properties(valuation_number)
                      ON DELETE SET NULL
                      ON UPDATE CASCADE,

  -- NLA identifiers
  folio_number        TEXT,

  -- Location fields from NLA
  street_address      TEXT,
  scheme_address      TEXT,
  parish              TEXT,
  location            TEXT,

  -- Coordinates for this specific parcel
  latitude            DOUBLE PRECISION,
  longitude           DOUBLE PRECISION,

  -- PostGIS geographic types for this specific parcel
  centroid            GEOGRAPHY(Point, 4326),
  boundary            GEOGRAPHY(Polygon, 4326),

  -- Raw GeoJSON boundary for this specific parcel
  boundary_geojson    JSONB,

  -- Computed quality flags
  has_coordinates     BOOLEAN       GENERATED ALWAYS AS
                      (latitude IS NOT NULL AND longitude IS NOT NULL) STORED,
  has_boundary        BOOLEAN       GENERATED ALWAYS AS
                      (boundary_geojson IS NOT NULL) STORED,

  -- Data quality flags
  -- TRUE when the LV number ends in '---' or address fields are null/blank.
  -- These records have valid geometry but incomplete metadata.
  is_incomplete       BOOLEAN       NOT NULL DEFAULT FALSE,

  -- Human-readable explanation of why is_incomplete is TRUE.
  -- NULL when is_incomplete is FALSE.
  incomplete_reason   TEXT,

  -- Which parcel this is among siblings sharing the same valuation number.
  -- 1 = the parcel whose data was promoted to the canonical properties row.
  -- 2, 3, ... = additional parcels displayed in the disambiguation modal.
  sibling_index       INTEGER,

  -- Metadata
  data_source         TEXT          DEFAULT 'NLA_GIS_API',
  last_fetched_at     TIMESTAMP     WITH TIME ZONE DEFAULT NOW(),
  created_at          TIMESTAMP     WITH TIME ZONE DEFAULT NOW(),
  updated_at          TIMESTAMP     WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE property_parcels IS
  'Every individual NLA GIS feature, one row per nla_object_id. '
  'Stores the one-to-many relationship between valuation numbers '
  'and physical parcels. For single-parcel LV numbers, there is '
  'exactly one row here. For multi-parcel LV numbers, there is one '
  'row per parcel. The application uses this table to present a '
  'disambiguation modal when a valuation number matches multiple parcels.';

COMMENT ON COLUMN property_parcels.nla_object_id IS
  'NLA GIS OBJECTID. Globally unique across the entire NLA dataset. '
  'Used as the primary key for this table.';

COMMENT ON COLUMN property_parcels.valuation_number IS
  'Foreign key to properties.valuation_number. Multiple rows in this '
  'table can share the same valuation_number.';

COMMENT ON COLUMN property_parcels.is_incomplete IS
  'TRUE when the record has valid geometry but incomplete metadata. '
  'Triggers include: LV number ending in ---, null folio and parish, '
  'blank or whitespace-only address fields.';

COMMENT ON COLUMN property_parcels.sibling_index IS
  '1 = canonical parcel (data promoted to properties table). '
  '2+ = additional parcels shown in the disambiguation modal. '
  'NULL = not yet assigned.';
```

### Add Auto-Update Trigger for property_parcels

```sql
CREATE TRIGGER trg_property_parcels_updated_at
  BEFORE UPDATE ON property_parcels
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

> The `update_updated_at_column()` function already exists from Phase 0.
> If it does not exist (check with `\df update_updated_at_column` in psql),
> re-run this block first:

```sql
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

### Verify Step 2

```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'property_parcels'
ORDER BY ordinal_position;
```

Expected: all columns listed above appear. If the table was not created,
re-run the `CREATE TABLE` statement before continuing.

---

## STEP 3 — Create Indexes on property_parcels

```sql
-- Primary lookup: find all parcels for a given valuation number
-- This is the key query for the disambiguation modal
CREATE INDEX IF NOT EXISTS idx_parcels_valuation_number
  ON property_parcels(valuation_number);

-- NLA object ID lookups
CREATE INDEX IF NOT EXISTS idx_parcels_nla_object_id
  ON property_parcels(nla_object_id);

-- Parish filtering
CREATE INDEX IF NOT EXISTS idx_parcels_parish
  ON property_parcels(parish)
  WHERE parish IS NOT NULL;

-- Data quality monitoring
CREATE INDEX IF NOT EXISTS idx_parcels_is_incomplete
  ON property_parcels(is_incomplete);

CREATE INDEX IF NOT EXISTS idx_parcels_has_coordinates
  ON property_parcels(has_coordinates);

CREATE INDEX IF NOT EXISTS idx_parcels_has_boundary
  ON property_parcels(has_boundary);

-- Spatial indexes for geographic queries
CREATE INDEX IF NOT EXISTS idx_parcels_centroid_geo
  ON property_parcels USING GIST(centroid)
  WHERE centroid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_parcels_boundary_geo
  ON property_parcels USING GIST(boundary)
  WHERE boundary IS NOT NULL;

-- Sibling index for ordering parcels in the modal
CREATE INDEX IF NOT EXISTS idx_parcels_sibling_index
  ON property_parcels(valuation_number, sibling_index)
  WHERE sibling_index IS NOT NULL;
```

### Verify Step 3

```sql
SELECT indexname, tablename
FROM pg_indexes
WHERE tablename = 'property_parcels'
ORDER BY indexname;
```

Expected: all indexes listed above appear. Re-run any missing ones
before continuing.

---

## STEP 4 — Create Supporting Views

### 4A — Parcels Data Quality View

```sql
CREATE OR REPLACE VIEW v_parcels_quality_summary AS
SELECT
  COUNT(*)                                              AS total_parcels,
  COUNT(DISTINCT valuation_number)                      AS unique_lv_numbers,
  COUNT(*) FILTER (WHERE has_coordinates)               AS with_coordinates,
  COUNT(*) FILTER (WHERE has_boundary)                  AS with_boundary,
  COUNT(*) FILTER (WHERE is_incomplete)                 AS incomplete_records,
  COUNT(*) FILTER (WHERE sibling_index = 1)             AS canonical_parcels,
  COUNT(*) FILTER (WHERE sibling_index > 1)             AS additional_parcels,
  ROUND(
    COUNT(*) FILTER (WHERE is_incomplete)::NUMERIC
    / NULLIF(COUNT(*), 0) * 100, 2
  )                                                     AS pct_incomplete
FROM property_parcels;

COMMENT ON VIEW v_parcels_quality_summary IS
  'Run: SELECT * FROM v_parcels_quality_summary; for parcel dataset health.';
```

### 4B — Multi-Parcel LV Numbers View

```sql
CREATE OR REPLACE VIEW v_multi_parcel_lv_numbers AS
SELECT
  valuation_number,
  COUNT(*)                                              AS parcel_count,
  COUNT(*) FILTER (WHERE is_incomplete)                 AS incomplete_count,
  COUNT(*) FILTER (WHERE has_boundary)                  AS with_boundary,
  MIN(parish) FILTER (WHERE parish IS NOT NULL)         AS parish,
  ARRAY_AGG(
    COALESCE(street_address, scheme_address, location, 'No address')
    ORDER BY sibling_index NULLS LAST
  )                                                     AS addresses
FROM property_parcels
GROUP BY valuation_number
HAVING COUNT(*) > 1
ORDER BY parcel_count DESC;

COMMENT ON VIEW v_multi_parcel_lv_numbers IS
  'All valuation numbers that have more than one parcel. '
  'Run: SELECT * FROM v_multi_parcel_lv_numbers LIMIT 20; to inspect.';
```

### 4C — Incomplete Records View

```sql
CREATE OR REPLACE VIEW v_incomplete_parcels AS
SELECT
  nla_object_id,
  valuation_number,
  folio_number,
  parish,
  street_address,
  scheme_address,
  incomplete_reason,
  has_coordinates,
  has_boundary
FROM property_parcels
WHERE is_incomplete = TRUE
ORDER BY valuation_number;

COMMENT ON VIEW v_incomplete_parcels IS
  'All parcels flagged as incomplete. '
  'Run: SELECT COUNT(*) FROM v_incomplete_parcels; to see total.';
```

### Verify Step 4

```sql
SELECT viewname
FROM pg_views
WHERE schemaname = 'public'
  AND viewname IN (
    'v_parcels_quality_summary',
    'v_multi_parcel_lv_numbers',
    'v_incomplete_parcels'
  )
ORDER BY viewname;
```

Expected: all three view names returned.

---

## STEP 5 — Run the Parcel Ingestion Script

This script reads the existing `land_val_numbers.json` file produced
by the Phase 0 fetch script and inserts every NLA feature into
`property_parcels`. It does not re-scrape the NLA API.
It does not modify the `properties` table.

### ⚠️ CLARIFICATION REQUIRED — Canonical Parcel Selection

Before running the ingestion script, one decision must be made.
For valuation numbers with multiple parcels, the application needs
one of them to be the "canonical" record — the row that stays in
the `properties` table as the default. The canonical parcel is
the one used if an agent's input matches a multi-parcel LV number
but the agent does not interact with the modal (future-proofing).

> "When a valuation number has multiple parcels, which one should
> be promoted as the canonical record in the properties table?"

| Option | Description | Why Consider It |
|---|---|---|
| A | The parcel with the most complete address data (non-null street_address preferred, then scheme_address, then location) | Produces the most useful canonical record for display. Address is the most human-readable identifier. If two parcels tie, the one with the larger boundary wins the tiebreak. Recommended. |
| B | The parcel with the largest boundary polygon (most land area) | Useful if the product is more about land coverage than address identity. Simple to compute from the GeoJSON coordinates. |
| C | The parcel with the lowest nla_object_id (first registered in the NLA system) | Simplest rule. Deterministic and reproducible. No quality judgment is made — just use NLA's own ordering. |

**Do not run the ingestion script until one option is chosen.**
The chosen option determines how `sibling_index` is assigned and
which parcel's data is used to update the `properties` table.

---

### 5A — Install Dependencies

In the `puppet-land-val-nums` project directory:

```bash
npm install pg dotenv
```

---

### 5B — The Parcel Ingestion Script

Save this as `ingestParcels.js`. Set the `CANONICAL_METHOD` constant
to `'most_complete_address'`, `'largest_boundary'`, or `'first_fetched'`
based on the clarification answer above.

```javascript
/**
 * ingestParcels.js
 *
 * Reads land_val_numbers.json and inserts every NLA feature into the
 * property_parcels table. Handles one-to-many relationships between
 * valuation numbers and physical parcels.
 *
 * Also flags incomplete records (LV numbers ending in ---, null fields).
 *
 * Does NOT modify the properties table directly — Step 6 does that.
 *
 * Run: node ingestParcels.js
 * Safe to re-run: uses ON CONFLICT DO UPDATE on nla_object_id.
 */

require('dotenv').config();
const { Pool } = require('pg');
const fs       = require('fs');

// ---------------------------------------------------------------------------
// SET THIS based on the clarification answer before running
// Options: 'most_complete_address' | 'largest_boundary' | 'first_fetched'
// ---------------------------------------------------------------------------
const CANONICAL_METHOD = 'most_complete_address';

const INPUT_FILE = 'land_val_numbers.json';
const BATCH_SIZE = 500;
const LOG_FILE   = 'ingest_parcels_log.txt';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:  { rejectUnauthorized: false },
  max:  5,
  idleTimeoutMillis:       30000,
  connectionTimeoutMillis: 10000
});

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ---------------------------------------------------------------------------
// Determine if a record is incomplete
// ---------------------------------------------------------------------------
function checkCompleteness(record) {
  const reasons = [];

  // LV number ending in --- is a known NLA data quality pattern
  if (record.lvNumber && record.lvNumber.trim().endsWith('---')) {
    reasons.push('LV number ends in ---');
  }

  // Null or whitespace-only folio AND null parish together = incomplete
  const hasNoFolio  = !record.volFol  || record.volFol.trim()  === '';
  const hasNoParish = !record.parish  || record.parish.trim()  === '';
  if (hasNoFolio && hasNoParish) {
    reasons.push('null folio and null parish');
  }

  // Null or whitespace-only address fields of all types
  const hasNoStreet  = !record.streetAdd  || record.streetAdd.trim()  === '' || record.streetAdd.trim() === ' ';
  const hasNoScheme  = !record.schemeAdd  || record.schemeAdd.trim()  === '' || record.schemeAdd.trim() === ' ';
  const hasNoLocation = !record.location  || record.location.trim()   === '' || record.location.trim()  === ' ';
  if (hasNoStreet && hasNoScheme && hasNoLocation) {
    reasons.push('all address fields are null or blank');
  }

  return {
    isIncomplete:    reasons.length > 0,
    incompleteReason: reasons.length > 0 ? reasons.join('; ') : null
  };
}

// ---------------------------------------------------------------------------
// Score a record for canonical selection
// Higher score = better candidate for canonical row
// ---------------------------------------------------------------------------
function computeCanonicalScore(record) {
  if (CANONICAL_METHOD === 'most_complete_address') {
    let score = 0;
    if (record.streetAdd  && record.streetAdd.trim()  !== '' && record.streetAdd.trim()  !== ' ') score += 4;
    if (record.schemeAdd  && record.schemeAdd.trim()  !== '' && record.schemeAdd.trim()  !== ' ') score += 3;
    if (record.location   && record.location.trim()   !== '' && record.location.trim()   !== ' ') score += 2;
    if (record.volFol     && record.volFol.trim()     !== '')                                     score += 2;
    if (record.parish     && record.parish.trim()     !== '')                                     score += 1;
    if (record.boundaryGeojson) {
      // Tiebreak: larger boundary polygon scores higher
      try {
        const ring = record.boundaryGeojson.coordinates[0];
        score += Math.min(ring.length / 100, 1); // fractional bonus
      } catch { /* ignore */ }
    }
    return score;
  }

  if (CANONICAL_METHOD === 'largest_boundary') {
    if (!record.boundaryGeojson) return 0;
    try {
      const ring = record.boundaryGeojson.coordinates[0];
      // Approximate area from coordinate count (not true area — good enough for ranking)
      return ring.length;
    } catch { return 0; }
  }

  if (CANONICAL_METHOD === 'first_fetched') {
    // Lower nlaObjectId = first registered = higher priority
    return record.nlaObjectId ? (1 / record.nlaObjectId) : 0;
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Convert GeoJSON polygon to WKT for PostGIS
// ---------------------------------------------------------------------------
function geojsonToWKT(geojson) {
  if (!geojson || geojson.type !== 'Polygon') return null;
  try {
    const ring = geojson.coordinates[0].map(([lng, lat]) => `${lng} ${lat}`).join(', ');
    return `POLYGON((${ring}))`;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Group raw records by valuation number and assign sibling_index
// ---------------------------------------------------------------------------
function groupAndRank(data) {
  // Group by LV number
  const groups = {};
  for (const record of data) {
    const lv = (record.lvNumber || '').trim();
    if (!lv) continue;
    if (!groups[lv]) groups[lv] = [];
    groups[lv].push(record);
  }

  // Sort each group and assign sibling_index
  const ranked = [];
  for (const [lv, parcels] of Object.entries(groups)) {
    const sorted = parcels
      .map(p => ({ ...p, _score: computeCanonicalScore(p) }))
      .sort((a, b) => b._score - a._score); // highest score first = index 1

    sorted.forEach((parcel, i) => {
      ranked.push({
        ...parcel,
        _siblingIndex:    i + 1,
        _isCanonical:     i === 0,
        _totalSiblings:   sorted.length
      });
    });
  }

  return ranked;
}

// ---------------------------------------------------------------------------
// Insert one batch into property_parcels
// ---------------------------------------------------------------------------
async function insertParcelBatch(client, batch) {
  let inserted = 0, updated = 0, skipped = 0;

  for (const record of batch) {
    const lv = (record.lvNumber || '').trim();
    if (!lv) { skipped++; continue; }
    if (!record.nlaObjectId) { skipped++; continue; }

    const { isIncomplete, incompleteReason } = checkCompleteness(record);
    const boundaryWKT = geojsonToWKT(record.boundaryGeojson);
    const centroidWKT = record.latitude && record.longitude
      ? `POINT(${record.longitude} ${record.latitude})` : null;

    try {
      const result = await client.query(`
        INSERT INTO property_parcels (
          nla_object_id,
          valuation_number,
          folio_number,
          street_address,
          scheme_address,
          parish,
          location,
          latitude,
          longitude,
          centroid,
          boundary,
          boundary_geojson,
          is_incomplete,
          incomplete_reason,
          sibling_index,
          last_fetched_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          CASE WHEN $10 IS NOT NULL
            THEN ST_GeographyFromText('SRID=4326;' || $10)
            ELSE NULL END,
          CASE WHEN $11 IS NOT NULL
            THEN ST_GeographyFromText('SRID=4326;' || $11)
            ELSE NULL END,
          $12, $13, $14, $15, NOW()
        )
        ON CONFLICT (nla_object_id) DO UPDATE SET
          valuation_number  = EXCLUDED.valuation_number,
          folio_number      = EXCLUDED.folio_number,
          street_address    = EXCLUDED.street_address,
          scheme_address    = EXCLUDED.scheme_address,
          parish            = EXCLUDED.parish,
          location          = EXCLUDED.location,
          latitude          = EXCLUDED.latitude,
          longitude         = EXCLUDED.longitude,
          centroid          = EXCLUDED.centroid,
          boundary          = EXCLUDED.boundary,
          boundary_geojson  = EXCLUDED.boundary_geojson,
          is_incomplete     = EXCLUDED.is_incomplete,
          incomplete_reason = EXCLUDED.incomplete_reason,
          sibling_index     = EXCLUDED.sibling_index,
          last_fetched_at   = NOW()
        RETURNING (xmax = 0) AS was_inserted
      `, [
        record.nlaObjectId,
        lv,
        record.volFol      || null,
        record.streetAdd   || null,
        record.schemeAdd   || null,
        record.parish      || null,
        record.location    || null,
        record.latitude    || null,
        record.longitude   || null,
        centroidWKT,
        boundaryWKT,
        record.boundaryGeojson ? JSON.stringify(record.boundaryGeojson) : null,
        isIncomplete,
        incompleteReason,
        record._siblingIndex || null
      ]);

      result.rows[0]?.was_inserted ? inserted++ : updated++;

    } catch (err) {
      // Most likely: valuation_number FK not found in properties table
      // This means the properties table does not have this LV number yet
      // Log it but do not stop the batch
      log(`SKIP nla_object_id=${record.nlaObjectId} lv=${lv}: ${err.message}`);
      skipped++;
    }
  }

  return { inserted, updated, skipped };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  fs.writeFileSync(LOG_FILE, '');
  log('=== Parcel Ingestion Started ===');
  log(`Canonical method: ${CANONICAL_METHOD}`);

  // Load data
  let data;
  try {
    data = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
    log(`Loaded ${data.length} records from ${INPUT_FILE}`);
  } catch (err) {
    log(`FATAL: Cannot read ${INPUT_FILE}: ${err.message}`);
    process.exit(1);
  }

  // Group and rank
  log('Grouping records by valuation number and assigning sibling indexes...');
  const ranked = groupAndRank(data);
  log(`Grouped into ranked parcel list: ${ranked.length} rows`);

  const multiParcelCount = ranked.filter(r => r._totalSiblings > 1).length;
  const singleCount      = ranked.filter(r => r._totalSiblings === 1).length;
  log(`Single-parcel LV numbers: ${singleCount}`);
  log(`Multi-parcel LV numbers (total parcels): ${multiParcelCount}`);

  // Connect to database
  let client;
  try {
    client = await pool.connect();
    log('Database connection successful');
  } catch (err) {
    log(`FATAL: Cannot connect to database: ${err.message}`);
    process.exit(1);
  }

  let totalInserted = 0, totalUpdated = 0, totalSkipped = 0, batchNum = 0;

  try {
    for (let i = 0; i < ranked.length; i += BATCH_SIZE) {
      const batch = ranked.slice(i, i + BATCH_SIZE);
      batchNum++;

      await client.query('BEGIN');
      try {
        const { inserted, updated, skipped } = await insertParcelBatch(client, batch);
        await client.query('COMMIT');

        totalInserted += inserted;
        totalUpdated  += updated;
        totalSkipped  += skipped;

        const pct = Math.round((i + batch.length) / ranked.length * 100);
        log(
          `Batch ${batchNum} (${pct}%) — ` +
          `Inserted: ${inserted} | Updated: ${updated} | Skipped: ${skipped} | ` +
          `Running totals — Inserted: ${totalInserted} | Updated: ${totalUpdated}`
        );
      } catch (err) {
        await client.query('ROLLBACK');
        log(`Batch ${batchNum} rolled back: ${err.message}`);
      }
    }

    log('=== Parcel Ingestion Complete ===');
    log(`Total inserted: ${totalInserted}`);
    log(`Total updated:  ${totalUpdated}`);
    log(`Total skipped:  ${totalSkipped}`);

  } finally {
    client.release();
    await pool.end();
  }
})();
```

---

### 5C — Run the Script

```bash
# Confirm DATABASE_URL is set
cat .env

node ingestParcels.js
```

**Expected run time:** Same dataset as Phase 0 ingestion — 5–15 minutes.

**If the script reports many SKIPs** with FK errors, it means the
`properties` table is missing those valuation numbers. This should
not happen since Phase 0 already ingested that table. If it does,
stop and report — do not proceed until the cause is investigated.

---

## STEP 6 — Populate has_multiple_parcels on the Properties Table

After `property_parcels` is populated, update the `properties` table
to flag which LV numbers have more than one parcel.

Run this SQL directly in psql:

```sql
-- Mark all LV numbers that have more than one parcel in property_parcels
UPDATE properties p
SET
  has_multiple_parcels        = TRUE,
  canonical_selection_method  = 'CANONICAL_METHOD_PLACEHOLDER'
WHERE (
  SELECT COUNT(*)
  FROM property_parcels pp
  WHERE pp.valuation_number = p.valuation_number
) > 1;
```

> Replace `CANONICAL_METHOD_PLACEHOLDER` with the method chosen in
> the Step 5 clarification — e.g. `most_complete_address`.

```sql
-- Mark single-parcel LV numbers explicitly
UPDATE properties p
SET
  has_multiple_parcels       = FALSE,
  canonical_selection_method = 'only_parcel'
WHERE (
  SELECT COUNT(*)
  FROM property_parcels pp
  WHERE pp.valuation_number = p.valuation_number
) = 1;

-- Check how many of each we have
SELECT
  has_multiple_parcels,
  COUNT(*) AS lv_count
FROM properties
GROUP BY has_multiple_parcels
ORDER BY has_multiple_parcels;
```

---

## STEP 7 — Verify the Update

Run every query. All must pass before the update is considered complete.

### 7A — Parcel Table Row Count

```sql
SELECT COUNT(*) AS total_parcels FROM property_parcels;
-- Must be equal to or greater than the row count in the properties table.
-- Greater is expected — multi-parcel LV numbers contribute more than one row.
```

### 7B — Parcel Quality Summary

```sql
SELECT * FROM v_parcels_quality_summary;
```

Expected minimum thresholds:

| Metric | Minimum Acceptable |
|---|---|
| `total_parcels` | Greater than `SELECT COUNT(*) FROM properties` |
| `unique_lv_numbers` | Equal to `SELECT COUNT(*) FROM properties` |
| `with_coordinates` percentage | 70% |
| `with_boundary` percentage | 50% |

### 7C — Multi-Parcel Inspection

```sql
-- Inspect the top 10 LV numbers with the most parcels
SELECT valuation_number, parcel_count, parish, addresses
FROM v_multi_parcel_lv_numbers
LIMIT 10;
```

Review these manually. The addresses array should contain distinct
locations, confirming these are genuinely separate physical parcels
and not data errors.

### 7D — Incomplete Records Count

```sql
SELECT incomplete_reason, COUNT(*) AS count
FROM property_parcels
WHERE is_incomplete = TRUE
GROUP BY incomplete_reason
ORDER BY count DESC;
```

This tells you the breakdown of why records are flagged incomplete.
There is no pass/fail threshold here — it is for your information.

### 7E — Sibling Index Sanity Check

```sql
-- Every multi-parcel group must have exactly one sibling_index = 1
SELECT valuation_number, COUNT(*) FILTER (WHERE sibling_index = 1) AS canonical_count
FROM property_parcels
GROUP BY valuation_number
HAVING COUNT(*) FILTER (WHERE sibling_index = 1) <> 1
LIMIT 20;
```

Expected: zero rows returned. If any rows are returned, the canonical
assignment in the ingestion script has a bug — stop and report.

### 7F — has_multiple_parcels Consistency Check

```sql
-- Confirm has_multiple_parcels on properties matches the actual parcel counts
SELECT COUNT(*) AS inconsistent_rows
FROM properties p
WHERE p.has_multiple_parcels = TRUE
  AND (
    SELECT COUNT(*) FROM property_parcels pp
    WHERE pp.valuation_number = p.valuation_number
  ) <= 1;
```

Expected: 0. If greater than 0, re-run Step 6.

### 7G — Known Valuation Number Test

```sql
-- Test a known multi-parcel LV number from the agent's analysis
-- Replace with an actual duplicate LV number from your dataset
SELECT
  nla_object_id,
  valuation_number,
  sibling_index,
  street_address,
  scheme_address,
  parish,
  latitude,
  longitude,
  is_incomplete,
  incomplete_reason
FROM property_parcels
WHERE valuation_number = '031B6W02067'
ORDER BY sibling_index;
```

Expected: multiple rows returned, each with a distinct `nla_object_id`
and `sibling_index` starting at 1.

### 7H — Incomplete Records Spot-Check

```sql
SELECT
  nla_object_id,
  valuation_number,
  folio_number,
  parish,
  street_address,
  incomplete_reason
FROM property_parcels
WHERE is_incomplete = TRUE
LIMIT 10;
```

Review these manually. Confirm the `incomplete_reason` text accurately
describes the problem with each record.

---

## STEP 8 — Application Lookup Logic Update

This step describes the changes needed in the application code
(plan v5) to use the new `property_parcels` table. No database
changes are made here — this is code only.

The implementing agent must update the property lookup in two places:
the resolver function and the API route response.

### 8A — Updated Property Resolver

```typescript
// /lib/property.ts

import { pool } from './db';

// Result type for a single resolved property (used for video generation)
export type ResolvedProperty = {
  source:           'properties' | 'property_parcels';
  nla_object_id:    number | null;
  valuation_number: string;
  folio_number:     string | null;
  street_address:   string | null;
  scheme_address:   string | null;
  parish:           string | null;
  location:         string | null;
  latitude:         number;
  longitude:        number;
  boundary_geojson: object | null;
  has_coordinates:  boolean;
  has_boundary:     boolean;
  cesium_coverage:  boolean | null;
  is_incomplete:    boolean;
};

// Returned when multiple parcels share a valuation number
export type ParcelSummary = {
  nla_object_id:  number;
  street_address: string | null;
  scheme_address: string | null;
  parish:         string | null;
  location:       string | null;
  latitude:       number | null;
  longitude:      number | null;
  has_boundary:   boolean;
  is_incomplete:  boolean;
  sibling_index:  number;
};

export type LookupResult =
  | { type: 'single';   property: ResolvedProperty }
  | { type: 'multiple'; parcels:  ParcelSummary[]; valuation_number: string }
  | { type: 'not_found' };

// ---------------------------------------------------------------------------
// Main lookup function
// ---------------------------------------------------------------------------
export async function lookupProperty(input: string): Promise<LookupResult> {
  const query = input.trim();

  // -------------------------------------------------------------------------
  // Step 1: Check the primary properties table
  // -------------------------------------------------------------------------
  const primaryResult = await pool.query(
    `SELECT
       valuation_number, folio_number,
       street_address, scheme_address, parish, location,
       latitude, longitude, boundary_geojson,
       has_coordinates, has_boundary,
       cesium_coverage, has_multiple_parcels
     FROM properties
     WHERE valuation_number = $1 OR folio_number = $1
     LIMIT 1`,
    [query]
  );

  if (primaryResult.rows.length > 0) {
    const row = primaryResult.rows[0];

    // If this LV number has multiple parcels, fetch them all for the modal
    if (row.has_multiple_parcels) {
      const parcelsResult = await pool.query(
        `SELECT
           nla_object_id, street_address, scheme_address,
           parish, location, latitude, longitude,
           has_boundary, is_incomplete, sibling_index
         FROM property_parcels
         WHERE valuation_number = $1
         ORDER BY sibling_index ASC NULLS LAST`,
        [row.valuation_number]
      );

      return {
        type:             'multiple',
        parcels:          parcelsResult.rows,
        valuation_number: row.valuation_number
      };
    }

    // Single match — return it directly
    return {
      type:     'single',
      property: {
        source:           'properties',
        nla_object_id:    null,
        is_incomplete:    false,
        cesium_coverage:  row.cesium_coverage,
        ...row
      }
    };
  }

  // -------------------------------------------------------------------------
  // Step 2: Not found in properties — check property_parcels
  // This handles edge cases where a parcel exists but was not the canonical
  // row chosen for the primary table (should be rare after full ingestion)
  // -------------------------------------------------------------------------
  const parcelResult = await pool.query(
    `SELECT
       nla_object_id, valuation_number, folio_number,
       street_address, scheme_address, parish, location,
       latitude, longitude, boundary_geojson,
       has_coordinates, has_boundary,
       is_incomplete, sibling_index
     FROM property_parcels
     WHERE valuation_number = $1 OR folio_number = $1
     ORDER BY sibling_index ASC NULLS LAST`,
    [query]
  );

  if (parcelResult.rows.length === 0) {
    return { type: 'not_found' };
  }

  if (parcelResult.rows.length === 1) {
    const row = parcelResult.rows[0];
    return {
      type:     'single',
      property: {
        source:          'property_parcels',
        cesium_coverage: null,
        ...row
      }
    };
  }

  // Multiple matches in property_parcels
  return {
    type:             'multiple',
    parcels:          parcelResult.rows,
    valuation_number: parcelResult.rows[0].valuation_number
  };
}

// ---------------------------------------------------------------------------
// Fetch a single specific parcel by nla_object_id
// Called after agent selects from the disambiguation modal
// ---------------------------------------------------------------------------
export async function getParcelById(nlaObjectId: number): Promise<ResolvedProperty | null> {
  const res = await pool.query(
    `SELECT
       nla_object_id, valuation_number, folio_number,
       street_address, scheme_address, parish, location,
       latitude, longitude, boundary_geojson,
       has_coordinates, has_boundary, is_incomplete
     FROM property_parcels
     WHERE nla_object_id = $1`,
    [nlaObjectId]
  );
  if (!res.rows[0]) return null;
  return {
    source:          'property_parcels',
    cesium_coverage: null,
    ...res.rows[0]
  };
}
```

### 8B — Updated API Route

```typescript
// /app/api/property/[id]/route.ts
import { lookupProperty } from '@/lib/property';
import { auth }           from '@clerk/nextjs/server';

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const { userId } = auth();
  if (!userId) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });

  const result = await lookupProperty(params.id);

  if (result.type === 'not_found') {
    return Response.json({ error: 'PROPERTY_NOT_FOUND' }, { status: 404 });
  }

  if (result.type === 'multiple') {
    // Return all parcels — frontend will show disambiguation modal
    return Response.json({
      type:             'multiple',
      valuation_number: result.valuation_number,
      parcels:          result.parcels.map(p => ({
        nla_object_id:  p.nla_object_id,
        street_address: p.street_address,
        scheme_address: p.scheme_address,
        parish:         p.parish,
        location:       p.location,
        has_boundary:   p.has_boundary,
        is_incomplete:  p.is_incomplete,
        sibling_index:  p.sibling_index,
        // Include coordinates so the map can preview each parcel
        latitude:       p.latitude,
        longitude:      p.longitude
      }))
    });
  }

  // Single result
  const p = result.property;
  return Response.json({
    type:             'single',
    valuation_number: p.valuation_number,
    folio_number:     p.folio_number,
    street_address:   p.street_address,
    scheme_address:   p.scheme_address,
    parish:           p.parish,
    location:         p.location,
    latitude:         p.latitude,
    longitude:        p.longitude,
    boundary_geojson: p.boundary_geojson,
    has_coordinates:  p.has_coordinates,
    has_boundary:     p.has_boundary,
    is_incomplete:    p.is_incomplete
  });
}
```

### 8C — New API Route for Parcel Selection

This endpoint is called when an agent clicks a specific parcel
in the disambiguation modal.

```typescript
// /app/api/parcel/[nlaObjectId]/route.ts
import { getParcelById } from '@/lib/property';
import { auth }          from '@clerk/nextjs/server';

export async function GET(req: Request, { params }: { params: { nlaObjectId: string } }) {
  const { userId } = auth();
  if (!userId) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });

  const parcel = await getParcelById(parseInt(params.nlaObjectId));
  if (!parcel) return Response.json({ error: 'PARCEL_NOT_FOUND' }, { status: 404 });

  return Response.json({
    nla_object_id:    parcel.nla_object_id,
    valuation_number: parcel.valuation_number,
    street_address:   parcel.street_address,
    scheme_address:   parcel.scheme_address,
    parish:           parcel.parish,
    location:         parcel.location,
    latitude:         parcel.latitude,
    longitude:        parcel.longitude,
    boundary_geojson: parcel.boundary_geojson,
    has_coordinates:  parcel.has_coordinates,
    has_boundary:     parcel.has_boundary,
    is_incomplete:    parcel.is_incomplete
  });
}
```

### 8D — Disambiguation Modal Component

```tsx
// /components/ParcelSelectModal.tsx
'use client';

type Parcel = {
  nla_object_id:  number;
  street_address: string | null;
  scheme_address: string | null;
  parish:         string | null;
  location:       string | null;
  has_boundary:   boolean;
  is_incomplete:  boolean;
  sibling_index:  number;
};

type Props = {
  valuationNumber: string;
  parcels:         Parcel[];
  onSelect:        (nlaObjectId: number) => void;
  onClose:         () => void;
};

function formatAddress(parcel: Parcel): string {
  if (parcel.street_address) return parcel.street_address;
  if (parcel.scheme_address) return parcel.scheme_address;
  if (parcel.location)       return parcel.location;
  return 'No address available';
}

export default function ParcelSelectModal({ valuationNumber, parcels, onSelect, onClose }: Props) {
  return (
    <div style={{
      position:        'fixed', inset: 0,
      backgroundColor: 'rgba(0,0,0,0.6)',
      display:         'flex',
      alignItems:      'center',
      justifyContent:  'center',
      zIndex:          1000
    }}>
      <div style={{
        background:   'white',
        borderRadius: 8,
        padding:      32,
        maxWidth:     600,
        width:        '90%',
        maxHeight:    '80vh',
        overflowY:    'auto'
      }}>
        <h2 style={{ marginTop: 0 }}>Multiple properties found</h2>
        <p>
          Valuation number <strong>{valuationNumber}</strong> is linked to
          multiple physical properties. Select the one you want to create
          a video for.
        </p>

        {parcels.map((parcel) => (
          <button
            key={parcel.nla_object_id}
            onClick={() => onSelect(parcel.nla_object_id)}
            style={{
              display:       'block',
              width:         '100%',
              textAlign:     'left',
              padding:       '12px 16px',
              marginBottom:  8,
              border:        '1px solid #ddd',
              borderRadius:  6,
              background:    '#f9f9f9',
              cursor:        'pointer',
              fontSize:      14
            }}
          >
            <strong>{formatAddress(parcel)}</strong>
            {parcel.parish && <span style={{ color: '#666' }}> — {parcel.parish}</span>}
            <br />
            <span style={{ fontSize: 12, color: '#888' }}>
              {parcel.has_boundary ? '✓ Boundary data available' : '⚠ No boundary — approximate box will be used'}
              {parcel.is_incomplete && ' · ⚠ Incomplete NLA record'}
            </span>
          </button>
        ))}

        <button onClick={onClose} style={{ marginTop: 8, color: '#666', background: 'none', border: 'none', cursor: 'pointer' }}>
          Cancel
        </button>
      </div>
    </div>
  );
}
```

### 8E — Updated Generate Page (modal integration)

Update the generate page in plan v5 to handle the `multiple` response
type. Only the `fetchProperty` function and modal rendering change —
everything else stays the same.

```tsx
// Add to /app/dashboard/generate/page.tsx

import ParcelSelectModal from '@/components/ParcelSelectModal';

// Add to state
const [multiParcels,     setMultiParcels]     = useState(null);
const [showModal,        setShowModal]         = useState(false);
const [valuationForModal, setValuationForModal] = useState('');

// Replace fetchProperty with this version
async function fetchProperty() {
  setError('');
  setMultiParcels(null);
  setShowModal(false);

  const res  = await fetch(`/api/property/${valuation.trim()}`);
  const data = await res.json();

  if (!res.ok) {
    setError(data.error || 'Property not found.');
    return;
  }

  if (data.type === 'multiple') {
    // Show disambiguation modal
    setMultiParcels(data.parcels);
    setValuationForModal(data.valuation_number);
    setShowModal(true);
    return;
  }

  // Single result — proceed as normal
  setProperty(data);
  setBoundary(data.boundary_geojson);
}

// Handle agent selecting a parcel from the modal
async function handleParcelSelect(nlaObjectId: number) {
  setShowModal(false);
  const res  = await fetch(`/api/parcel/${nlaObjectId}`);
  const data = await res.json();
  if (!res.ok) { setError('Could not load parcel data.'); return; }
  setProperty(data);
  setBoundary(data.boundary_geojson);
}

// Add inside the returned JSX, below the generate button
{showModal && multiParcels && (
  <ParcelSelectModal
    valuationNumber={valuationForModal}
    parcels={multiParcels}
    onSelect={handleParcelSelect}
    onClose={() => setShowModal(false)}
  />
)}
```

---

## STEP 9 — Final Checklist

Every item must be checked before the database update is complete.

### Database
- [ ] `has_multiple_parcels` column added to `properties`
- [ ] `canonical_selection_method` column added to `properties`
- [ ] `property_parcels` table created with all columns
- [ ] Auto-update trigger created on `property_parcels`
- [ ] All 9 indexes created on `property_parcels`
- [ ] `v_parcels_quality_summary` view created
- [ ] `v_multi_parcel_lv_numbers` view created
- [ ] `v_incomplete_parcels` view created

### Canonical Selection
- [ ] Clarification question answered (Step 5)
- [ ] `CANONICAL_METHOD` constant set in `ingestParcels.js`

### Ingestion
- [ ] `ingestParcels.js` ran without fatal errors
- [ ] `property_parcels` row count is greater than `properties` row count
- [ ] Sibling index sanity check returned zero rows (Step 7E)
- [ ] `has_multiple_parcels` consistency check returned zero rows (Step 7F)
- [ ] Step 6 SQL ran and `has_multiple_parcels` is set on all rows

### Data Quality
- [ ] Incomplete records reviewed in `v_incomplete_parcels`
- [ ] Multi-parcel LV numbers reviewed in `v_multi_parcel_lv_numbers`
- [ ] Known duplicate LV number test returned multiple rows (Step 7G)

### Application Code
- [ ] `lookupProperty` function updated in `/lib/property.ts`
- [ ] `/api/property/[id]` route returns `type: multiple` when appropriate
- [ ] `/api/parcel/[nlaObjectId]` route created
- [ ] `ParcelSelectModal` component created
- [ ] Generate page updated to handle modal flow
- [ ] `app_user` granted SELECT/INSERT/UPDATE/DELETE on `property_parcels`

### Permissions (run as admin user)
```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON property_parcels TO app_user;
GRANT SELECT ON v_parcels_quality_summary  TO app_user;
GRANT SELECT ON v_multi_parcel_lv_numbers  TO app_user;
GRANT SELECT ON v_incomplete_parcels       TO app_user;
```

---

## END OF DATABASE UPDATE PLAN v1