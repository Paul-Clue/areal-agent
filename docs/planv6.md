# plan_v6.md — AI Property Video Generator (Application Build Plan)
## Standalone — Database Fully Complete and Verified

---

## CHANGELOG FROM v5

| Area | Change |
|---|---|
| What is already done | Updated to reflect database update plan v1 fully implemented and verified |
| `property_parcels` table | Added to completed deliverables — 976,812 rows ingested |
| Multi-parcel handling | Added to completed deliverables — `has_multiple_parcels` set, `property_parcels` populated |
| Incomplete records | Added to completed deliverables — 68,512 rows flagged |
| `app_user` connection limit | Added to completed deliverables — capped at 20 connections |
| Phase 3 — Property Resolver | Fully rewritten to use `lookupProperty` which handles single, multiple, and not-found cases |
| Phase 3 — API route | Updated to return `type: 'single'` or `type: 'multiple'` response shape |
| Phase 3 — Parcel API route | New route added: `GET /api/parcel/[nlaObjectId]` |
| Phase 11 — Frontend UI | Generate page updated to handle disambiguation modal |
| Phase 11 — New component | `ParcelSelectModal` component added |
| Phase 0 Step 1 — App creation | New first step: create the Next.js app from scratch using `create-next-app` |
| Reference files note | Added note that `reference/databaseUpdate-step8/` files must be merged into the app |
| Build order | Updated to reflect parcel lookup as part of Phase 3 |

Everything else from v5 is unchanged and still applies.

---

## 1. Core Objective

Build a subscription-based SaaS web application that:

1. Accepts a valuation number or folio number as input
2. Looks up the property in the already-populated PostgreSQL database
3. If the valuation number maps to multiple physical parcels, presents
   a disambiguation modal so the agent selects the correct property
4. Selects the best available renderer automatically:
   - Cesium + Google Photorealistic 3D Tiles if coverage exists
   - Mapbox satellite-v9 if Cesium coverage is absent (current case for Jamaica)
5. Generates a cinematic aerial video (≥ 20 seconds, 1920x1080 Full HD)
6. Applies a mandatory post-processing pipeline to improve visual quality
7. Overlays and tracks real NLA property boundary lines throughout the video
8. Injects agent branding at the start, end, and throughout the video
9. Ties every video permanently to the paying agent's account
10. Allows the agent to download the final branded video

---

## 2. What Is Already Done — Complete Database State

The following items are complete. The application connects to these.
Nothing in this list is created or modified by the application.

| Deliverable | Status | Detail |
|---|---|---|
| PostgreSQL database | ✅ Complete | Local PostgreSQL, database name: `property_video_db` |
| PostGIS + pgcrypto + pg_trgm | ✅ Installed | |
| `properties` table | ✅ Populated | 880,422 canonical NLA parcel records |
| `property_parcels` table | ✅ Populated | 976,812 rows — one per NLA feature |
| Multi-parcel flags | ✅ Set | `has_multiple_parcels` populated on all `properties` rows |
| Additional siblings | ✅ Identified | 96,390 parcels with `sibling_index > 1` |
| Incomplete records | ✅ Flagged | 68,512 rows with `is_incomplete = true` |
| `agents` table | ✅ Created | Empty — populated as agents sign up |
| `jobs` table | ✅ Created | Empty — populated as videos are generated |
| `refresh_log` table | ✅ Created | |
| All indexes | ✅ Created | Including spatial GIST indexes on both tables |
| All views | ✅ Created | `v_data_quality_summary`, `v_parish_summary`, `v_parcels_quality_summary`, `v_multi_parcel_lv_numbers`, `v_incomplete_parcels` |
| Auto-update triggers | ✅ Created | On `properties`, `agents`, `property_parcels` |
| `app_user` account | ✅ Created | Restricted permissions, connection limit 20 |
| `app_user` grants | ✅ Applied | Includes `property_parcels` and all views |
| Reference app files | ✅ Available | In `areal-agent/reference/databaseUpdate-step8/` — ready to copy into the Next.js app |

---

## 3. Non-Negotiable Technical Constraints

- Primary renderer: **Mapbox** (satellite-v9, Static Images API) — always works
- Upgrade renderer: **Cesium** (Google Photorealistic 3D Tiles, headless Puppeteer) — used when coverage confirmed
- Post-processing: **Mandatory on all videos** regardless of renderer
- Output format: **MP4, H.264, 1920x1080, ≥ 20 seconds**
- Boundary tracking: **Deterministic reprojection per frame** (no CV/ML)
- Every pipeline step has a defined fallback
- Agent branding injected automatically — agents cannot opt out
- Subscription must be active before any video is generated
- Agent ID always resolved server-side via Clerk — never trusted from frontend
- Application connects as `app_user` — never as the admin user
- Multi-parcel LV numbers always trigger the disambiguation modal — never silently pick one

---

## 4. System Architecture

| Component | Technology |
|---|---|
| Frontend | Next.js (App Router), React, Mapbox GL JS, Tailwind CSS |
| Backend API | Next.js API Routes (Node.js) |
| Worker Service | Node.js + Python subprocess (FFmpeg, OpenCV, Puppeteer) |
| Queue | BullMQ + Redis |
| Database | Existing `property_video_db` PostgreSQL (local, owned by `paulc1`) |
| Storage | DigitalOcean Spaces (S3-compatible) |
| Auth | Clerk |
| Payments | Stripe |
| Deployment | Vercel (frontend) + DigitalOcean Droplet (workers) |

---

## 5. What the Agent MUST NOT Decide Alone

At every point marked with ⚠️, the implementing agent MUST stop,
present the options listed, and wait for a choice before proceeding.
All clarification points are explicitly called out inside each phase.

---

## 6. STEP 0 — Create the Next.js Application

This is the very first action. The application repo does not exist yet.

### 6.1 Create the App

```zsh
npx create-next-app@latest property-video-app \
  --typescript \
  --tailwind \
  --eslint \
  --app \
  --src-dir \
  --import-alias "@/*"
```

When prompted, accept all defaults. This creates a Next.js 14+ project
with the App Router, TypeScript, and Tailwind CSS configured.

### 6.2 Enter the Project Directory

```zsh
cd property-video-app
```

All subsequent commands in this plan are run from inside this directory
unless stated otherwise.

### 6.3 Install Core Dependencies

```zsh
npm install pg dotenv
npm install @types/pg --save-dev
```

### 6.4 Create the Environment File

```zsh
touch .env.local
```

Add the following to `.env.local`. The `DATABASE_URL` uses `app_user`
connecting to the local `property_video_db` database created in Phase 0.

```bash
# Database — app_user (restricted access, matches Phase 0 setup)
DATABASE_URL=postgresql://app_user:PASSWORD@localhost:5432/property_video_db

# Mapbox (get from mapbox.com — needed for map preview and frame generation)
NEXT_PUBLIC_MAPBOX_TOKEN=pk_...
MAPBOX_TOKEN=pk_...

# Clerk (get from clerk.com — needed for authentication)
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_...
CLERK_SECRET_KEY=sk_...

# Stripe (get from stripe.com — needed for subscriptions)
STRIPE_SECRET_KEY=sk_...
STRIPE_PRICE_ID=price_...
STRIPE_WEBHOOK_SECRET=whsec_...

# DigitalOcean Spaces (needed for video storage)
DO_SPACES_KEY=...
DO_SPACES_SECRET=...
DO_SPACES_BUCKET=property-videos

# Redis (needed for job queue)
REDIS_HOST=localhost
REDIS_PORT=6379

# Google Maps (needed for Cesium coverage probe)
GOOGLE_MAPS_API_KEY=...

# App base URL
NEXT_PUBLIC_BASE_URL=http://localhost:3000
```

### ⚠️ CLARIFICATION REQUIRED — API Keys Not Yet Obtained

If any of the API keys above have not yet been obtained, the agent
must stop and ask:

> "Which of the following service accounts still need to be created
> before we proceed?"

| Service | What It Is For | Where to Sign Up |
|---|---|---|
| Mapbox | Satellite map tiles for preview and frame generation | mapbox.com |
| Clerk | Agent authentication (login/signup) | clerk.com |
| Stripe | Subscription billing | stripe.com |
| DigitalOcean Spaces | Storing generated video files | digitalocean.com |
| Google Maps | Cesium 3D tiles coverage probe | console.cloud.google.com |

The agent must not proceed past Step 0 until `MAPBOX_TOKEN` and
`NEXT_PUBLIC_MAPBOX_TOKEN` are filled in at minimum. The map preview
will not work without Mapbox. All other keys can be filled in later
as each phase is built, with the following exceptions:
- Clerk is required before Phase 12 (Auth)
- Stripe is required before Phase 13 (Subscription)
- DigitalOcean Spaces is required before Phase 17 (Deployment)

### 6.5 Add .env.local to .gitignore

Confirm `.gitignore` already contains `.env.local` (create-next-app
adds it by default). If it does not:

```zsh
echo ".env.local" >> .gitignore
```

Never commit `.env.local` to version control.

### 6.6 Copy Reference Files from the Database Repo

The database update plan v1 produced ready-to-use application files
in `areal-agent/reference/databaseUpdate-step8/`. Copy them now.

```zsh
# Run from inside property-video-app
# Adjust the source path to wherever areal-agent lives on your machine

cp ../areal-agent/reference/databaseUpdate-step8/lib/property.ts     src/lib/property.ts
cp ../areal-agent/reference/databaseUpdate-step8/ParcelSelectModal.tsx src/components/ParcelSelectModal.tsx
```

Then read `../areal-agent/reference/databaseUpdate-step8/README.txt`
for any additional instructions about the API routes and dashboard
fragment before proceeding.

---

## 7. PHASE 1 — Database Connection

### Goal
Confirm the application can connect to the existing `property_video_db`
database before any other code is written.

### 7.1 Database Client Module

Create `src/lib/db.ts`:

```typescript
import { Pool } from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is not set');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:  process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max:  10,
  idleTimeoutMillis:       30000,
  connectionTimeoutMillis: 10000
});

pool.query('SELECT NOW()').then(() => {
  console.log('Database connection established');
}).catch(err => {
  console.error('Database connection failed:', err.message);
  process.exit(1);
});
```

> **SSL note:** SSL is disabled for local development (where the database
> runs on the same machine) and enabled for production. This matches the
> local setup from Phase 0 where the database is `localhost:5432`.

### 7.2 Verify Connection Before Proceeding

```zsh
node -e "
require('dotenv').config({ path: '.env.local' });
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false
});
pool.query('SELECT COUNT(*) FROM properties').then(r => {
  console.log('Connected. Properties in database:', r.rows[0].count);
  pool.query('SELECT COUNT(*) FROM property_parcels').then(r2 => {
    console.log('Parcels in database:', r2.rows[0].count);
    pool.end();
  });
}).catch(err => {
  console.error('Connection failed:', err.message);
  process.exit(1);
});
"
```

Expected output:
```
Connected. Properties in database: 880422
Parcels in database: 976812
```

If the connection fails, stop. Do not proceed until this works.
The most likely cause is that `app_user` password in `.env.local`
is wrong. Re-check the password set during Phase 0 Step 7B.

---

## 8. PHASE 2 — Boundary Resolution

Create `src/lib/boundary.ts`:

```typescript
export function resolveBoundary(property: {
  boundary_geojson: object | null;
  latitude: number;
  longitude: number;
}) {
  if (property.boundary_geojson) {
    // Real NLA boundary polygon — use directly
    // Available for ~99.9% of properties (976,773 of 976,812 have boundaries)
    return property.boundary_geojson;
  }
  // Fallback: bounding box (affects only ~39 properties with no geometry)
  return generateBoundingBox(property.latitude, property.longitude);
}

function metersToLat(meters: number): number {
  return meters / 111320;
}

function metersToLng(meters: number, lat: number): number {
  return meters / (111320 * Math.cos(lat * Math.PI / 180));
}

export function generateBoundingBox(lat: number, lng: number, zoom: number = 17) {
  const size = zoom < 16 ? 60 : 40;
  const dLat = metersToLat(size);
  const dLng = metersToLng(size, lat);

  return {
    type: 'Polygon',
    coordinates: [[
      [lng - dLng, lat - dLat],
      [lng + dLng, lat - dLat],
      [lng + dLng, lat + dLat],
      [lng - dLng, lat + dLat],
      [lng - dLng, lat - dLat]
    ]]
  };
}
```

---

## 9. PHASE 3 — Property Resolver

### Goal
Look up a property by valuation number or folio number. Handle three
outcomes: single match, multiple parcels (disambiguation needed),
not found. The reference file from `databaseUpdate-step8` already
contains this logic — verify it matches what is below and adjust if needed.

### 9.1 Property Resolver (src/lib/property.ts)

This file was copied from the reference folder in Step 6.6.
Confirm it contains the `lookupProperty` and `getParcelById` functions.
The complete implementation is:

```typescript
import { pool } from './db';

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

export async function lookupProperty(input: string): Promise<LookupResult> {
  const query = input.trim();

  // Step 1: Check primary properties table
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

    // Multi-parcel — fetch all siblings for modal
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

    // Single match
    return {
      type:     'single',
      property: {
        source:          'properties',
        nla_object_id:   null,
        is_incomplete:   false,
        cesium_coverage: row.cesium_coverage,
        ...row
      }
    };
  }

  // Step 2: Check property_parcels (edge case)
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

  if (parcelResult.rows.length === 0) return { type: 'not_found' };

  if (parcelResult.rows.length === 1) {
    return {
      type:     'single',
      property: { source: 'property_parcels', cesium_coverage: null, ...parcelResult.rows[0] }
    };
  }

  return {
    type:             'multiple',
    parcels:          parcelResult.rows,
    valuation_number: parcelResult.rows[0].valuation_number
  };
}

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
  return { source: 'property_parcels', cesium_coverage: null, ...res.rows[0] };
}
```

### 9.2 Property Lookup API Route

Create `src/app/api/property/[id]/route.ts`:

```typescript
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
        latitude:       p.latitude,
        longitude:      p.longitude
      }))
    });
  }

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

### 9.3 Parcel Selection API Route

Create `src/app/api/parcel/[nlaObjectId]/route.ts`:

```typescript
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

---

## 10. PHASE 4 — Renderer Selection

Create `src/worker/lib/rendererSelector.ts`:

```typescript
import { pool } from '../../lib/db';

export async function selectRenderer(property: {
  cesium_coverage:  boolean | null;
  valuation_number: string;
  latitude:         number;
  longitude:        number;
}): Promise<'cesium' | 'mapbox'> {
  if (property.cesium_coverage === true)  return 'cesium';
  if (property.cesium_coverage === false) return 'mapbox';

  const hasCoverage = await probeCesiumCoverage(property.latitude, property.longitude);

  await pool.query(
    'UPDATE properties SET cesium_coverage = $1 WHERE valuation_number = $2',
    [hasCoverage, property.valuation_number]
  );

  return hasCoverage ? 'cesium' : 'mapbox';
}

async function probeCesiumCoverage(lat: number, lon: number): Promise<boolean> {
  const puppeteer = await import('puppeteer');
  const browser   = await puppeteer.default.launch({ headless: true, args: ['--no-sandbox'] });
  const page      = await browser.newPage();
  try {
    const hasCoverage = await page.evaluate(async (key: string) => {
      try {
        const res = await fetch(`https://tile.googleapis.com/v1/3dtiles/root.json?key=${key}`);
        return res.ok;
      } catch { return false; }
    }, process.env.GOOGLE_MAPS_API_KEY || '');
    return hasCoverage;
  } finally {
    await browser.close();
  }
}
```

### ⚠️ CLARIFICATION REQUIRED — Coverage Probe Reliability

If the coverage probe returns inconsistent results during testing,
the agent must stop and ask:

> "The Cesium coverage probe is not behaving reliably. How should
> we handle renderer selection?"

| Option | Description | Why Consider It |
|---|---|---|
| A | Default all properties to Mapbox until Cesium is manually enabled | Safest. Jamaica currently has no Google 3D Tiles coverage so Mapbox is always correct for now. Zero risk of Cesium failing in production. |
| B | Add a manual override in an admin panel to enable Cesium per region | Full control without automated probing. When Google adds Jamaica coverage you enable it with a database update. |
| C | One-time batch scan of all properties, cache results, disable per-job probing | Run once, cache everything. Best long-term performance once coverage is reliable. |

---

## 11. PHASE 5A — Mapbox Frame Generation

Create `src/worker/lib/mapboxRenderer.ts`:

```typescript
import fetch from 'node-fetch';
import fs    from 'fs';
import path  from 'path';
import pLimit from 'p-limit';

const limit = pLimit(5);

function easeOutExpo(t: number): number {
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

function getCameraAtFrame(i: number, totalFrames: number) {
  const t     = i / (totalFrames - 1);
  const eased = easeOutExpo(t);
  return {
    zoom:    14 + (18 - 14) * eased,
    bearing: -20 + (20) * eased
  };
}

async function fetchMapboxFrame(
  i: number, lat: number, lon: number,
  zoom: number, bearing: number, outputDir: string
) {
  const url = `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/`
    + `${lon},${lat},${zoom.toFixed(4)},${bearing.toFixed(2)},0/`
    + `1280x720?access_token=${process.env.MAPBOX_TOKEN}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Mapbox fetch failed: ${res.status}`);

  const buffer = await res.buffer();
  fs.writeFileSync(
    path.join(outputDir, `frame_${String(i).padStart(4, '0')}.png`),
    buffer
  );
}

export async function generateMapboxFrames(
  property: { latitude: number; longitude: number },
  outputDir: string
) {
  const tasks = Array.from({ length: 600 }, (_, i) => {
    const camera = getCameraAtFrame(i, 600);
    return limit(() => fetchMapboxFrame(
      i, property.latitude, property.longitude,
      camera.zoom, camera.bearing, outputDir
    ));
  });
  await Promise.all(tasks);
}
```

---

## 12. PHASE 5B — Cesium Frame Generation

### 12.1 Self-Hosted Cesium Render Page

Create `src/worker/static/cesium-render.html`:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <script src="https://cesium.com/downloads/cesiumjs/releases/1.114/Build/Cesium/Cesium.js"></script>
  <link href="https://cesium.com/downloads/cesiumjs/releases/1.114/Build/Cesium/Widgets/widgets.css" rel="stylesheet">
  <style>
    html, body, #cesiumContainer { width:100%; height:100%; margin:0; padding:0; overflow:hidden; }
  </style>
</head>
<body>
  <div id="cesiumContainer"></div>
  <script src="cesium-flight.js"></script>
</body>
</html>
```

### 12.2 Cesium Flight Script

Create `src/worker/static/cesium-flight.js`:

```javascript
const { lat, lon, totalFrames } = window.RENDER_CONFIG;

const viewer = new Cesium.Viewer('cesiumContainer', {
  animation: false, timeline: false, geocoder: false,
  homeButton: false, sceneModePicker: false, baseLayerPicker: false,
  navigationHelpButton: false,
  additionalOptions: { onlyUsingWithGoogleGeocoder: true }
});

const googleTiles = await Cesium.createGooglePhotorealistic3DTileset();
viewer.scene.primitives.add(googleTiles);
viewer.scene.skyAtmosphere.show = true;
viewer.scene.globe.enableLighting = true;
viewer.scene.postProcessStages.fxaa.enabled = true;

const keyframes = [
  [ 0.00, lon - 0.003, lat + 0.003, 420, -25,   0 ],
  [ 0.25, lon - 0.001, lat + 0.002, 320, -35,  45 ],
  [ 0.50, lon + 0.002, lat + 0.001, 250, -42,  90 ],
  [ 0.75, lon + 0.002, lat - 0.002, 190, -45, 150 ],
  [ 1.00, lon - 0.001, lat - 0.001, 160, -40, 200 ],
];

function lerp(a, b, t) { return a + (b - a) * t; }

function getCameraAt(progress) {
  let k0 = keyframes[0], k1 = keyframes[keyframes.length - 1];
  for (let i = 0; i < keyframes.length - 1; i++) {
    if (progress >= keyframes[i][0] && progress <= keyframes[i+1][0]) {
      k0 = keyframes[i]; k1 = keyframes[i+1]; break;
    }
  }
  const seg = k1[0] - k0[0];
  const t   = seg === 0 ? 0 : (progress - k0[0]) / seg;
  return {
    lon: lerp(k0[1], k1[1], t), lat: lerp(k0[2], k1[2], t),
    alt: lerp(k0[3], k1[3], t), pitch: lerp(k0[4], k1[4], t),
    heading: lerp(k0[5], k1[5], t)
  };
}

window.CESIUM_READY = true;

window.renderFrameAt = function(progress) {
  const cam = getCameraAt(progress);
  viewer.scene.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(cam.lon, cam.lat, cam.alt),
    orientation: { heading: Cesium.Math.toRadians(cam.heading), pitch: Cesium.Math.toRadians(cam.pitch), roll: 0 }
  });
};

window.projectBoundary = function(boundaryGeoJSON) {
  return boundaryGeoJSON.coordinates[0].map(([lng, lat]) => {
    const cartesian = Cesium.Cartesian3.fromDegrees(lng, lat);
    const canvasPos = viewer.scene.cartesianToCanvasCoordinates(cartesian);
    if (!canvasPos) return null;
    return [Math.round(canvasPos.x), Math.round(canvasPos.y)];
  }).filter(Boolean);
};
```

### 12.3 Puppeteer Frame Capture

Create `src/worker/lib/cesiumRenderer.ts`:

```typescript
import puppeteer from 'puppeteer';
import path      from 'path';
import fs        from 'fs';

const TOTAL_FRAMES = 600;
const FRAME_WIDTH  = 1280;
const FRAME_HEIGHT = 720;

export async function generateCesiumFrames(
  lat: number, lon: number, boundary: object, outputDir: string
): Promise<void> {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      `--window-size=${FRAME_WIDTH},${FRAME_HEIGHT}`,
      '--enable-webgl', '--use-gl=swiftshader'
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: FRAME_WIDTH, height: FRAME_HEIGHT });
  await page.evaluateOnNewDocument(
    (lat, lon, totalFrames) => { (window as any).RENDER_CONFIG = { lat, lon, totalFrames }; },
    lat, lon, TOTAL_FRAMES
  );

  await page.goto(
    `file://${path.resolve(__dirname, '../static/cesium-render.html')}`,
    { waitUntil: 'networkidle0', timeout: 60000 }
  );
  await page.waitForFunction(() => (window as any).CESIUM_READY === true, { timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));

  for (let i = 0; i < TOTAL_FRAMES; i++) {
    const progress = i / (TOTAL_FRAMES - 1);
    await page.evaluate((p) => (window as any).renderFrameAt(p), progress);
    const pixelPoints = await page.evaluate((b) => (window as any).projectBoundary(b), boundary);
    await new Promise(r => setTimeout(r, 50));
    await page.screenshot({ path: path.join(outputDir, `frame_${String(i).padStart(4, '0')}.png`), type: 'png' });
    fs.writeFileSync(path.join(outputDir, `boundary_${String(i).padStart(4, '0')}.json`), JSON.stringify(pixelPoints));
  }

  await browser.close();
}
```

---

## 13. PHASE 5C — Post-Processing Pipeline (MANDATORY)

Applies to every video regardless of renderer.

### ⚠️ CLARIFICATION REQUIRED — Color Grading Method

> "Which color grading approach should be used?"

| Option | Description | Why Consider It |
|---|---|---|
| A | Supply a .cube LUT file from a royalty-free source (e.g. freeluts.com) placed at `/assets/luts/cinematic_warm.cube` | Best quality. Most cinematic result. Requires you to supply the file. |
| B | Use FFmpeg color curves — no external file needed | Simpler. No file to supply. Good result. Recommended if you want to move fast. |

**Do not implement color grading until this choice is made.**

### 13.1 Step 1 — AI Upscaling (Mapbox frames only)

```bash
pip install realesrgan --break-system-packages
```

```python
# Applied in worker — upscales 1280x720 Mapbox frames to 1920x1080
from realesrgan import RealESRGANer
from basicsr.archs.rrdbnet_arch import RRDBNet
import cv2, glob

model     = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32, scale=2)
upsampler = RealESRGANer(scale=2, model_path='RealESRGAN_x2plus.pth', model=model,
                         tile=0, tile_pad=10, pre_pad=0, half=False)

for f in sorted(glob.glob('/tmp/job/frames/*.png')):
    img, _ = upsampler.enhance(cv2.imread(f, cv2.IMREAD_UNCHANGED), outscale=2)
    cv2.imwrite(f, img)
```

### 13.2 Steps 2–7 — FFmpeg Chain

```bash
# Color grading (Option A — LUT)
ffmpeg -i base.mp4 -vf "lut3d=/assets/luts/cinematic_warm.cube" graded.mp4

# Color grading (Option B — curves)
ffmpeg -i base.mp4 -vf "curves=r='0/0 0.5/0.6 1/1':g='0/0 0.5/0.52 1/0.95':b='0/0.05 0.5/0.45 1/0.85'" graded.mp4

# Vignette
ffmpeg -i graded.mp4 -vf "vignette=PI/4" vignetted.mp4

# Motion blur
ffmpeg -i vignetted.mp4 -vf "tmix=frames=3:weights='1 2 1'" motion_blur.mp4

# Film grain
ffmpeg -i motion_blur.mp4 -vf "noise=alls=8:allf=t+u" grain.mp4

# Frame interpolation to 30 FPS (Mapbox only, if generated at 15 FPS)
ffmpeg -i grain.mp4 -vf "minterpolate=fps=30:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1" smooth.mp4

# Final encode at 1920x1080
ffmpeg -i smooth.mp4 \
  -vf "scale=1920:1080:flags=lanczos,format=yuv420p" \
  -c:v libx264 -crf 18 -preset slow -movflags +faststart \
  post_processed.mp4
```

---

## 14. PHASE 6 — Boundary Overlay Per Frame

Create `src/worker/python/draw_boundary.py`:

```python
import cv2, numpy as np, json, sys

image_path  = sys.argv[1]
points_json = sys.argv[2]
output_path = sys.argv[3]

image  = cv2.imread(image_path)
points = json.loads(points_json)
pts    = np.array(points, np.int32).reshape((-1, 1, 2))

overlay = image.copy()
cv2.fillPoly(overlay, [pts], (0, 255, 0))
cv2.addWeighted(overlay, 0.4, image, 0.6, 0, image)
cv2.polylines(image, [pts], True, (0, 255, 0), 3)
cv2.imwrite(output_path, image)
```

Create `src/worker/lib/overlay.ts` (Mapbox flat reprojection):

```typescript
import SphericalMercator from '@mapbox/sphericalmercator';

const FRAME_WIDTH  = 1280;
const FRAME_HEIGHT = 720;
const merc = new SphericalMercator({ size: 256 });

export function projectBoundaryFlat(
  boundary: { coordinates: number[][][] },
  camera:   { lon: number; lat: number; zoom: number }
): [number, number][] {
  return boundary.coordinates[0].map(([lng, lat]) => {
    const [x,  y]  = merc.px([lng, lat], camera.zoom);
    const [cx, cy] = merc.px([camera.lon, camera.lat], camera.zoom);
    return [Math.round(x - cx + FRAME_WIDTH / 2), Math.round(y - cy + FRAME_HEIGHT / 2)];
  });
}
```

### ⚠️ CLARIFICATION REQUIRED — Boundary Line Style

> "How should the property boundary look in the video?"

| Option | Description | Why Consider It |
|---|---|---|
| A | Solid green line with 40% filled interior | Clean and visible from altitude. No extra rendering complexity. Works on both renderers. Easiest to implement. |
| B | Solid green outline only, no fill | Less dominant. Better for large properties where fill would obscure the land. |
| C | Solid line with glow/bloom effect | Most polished. Adds one FFmpeg filter pass. Slightly longer render time. |

**Do not finalize the draw_boundary.py implementation until this is chosen.**

---

## 15. PHASE 7 — Video Assembly

```bash
# 1. Compile frames
ffmpeg -framerate 30 -i frame_%04d.png -vf "format=yuv420p" base.mp4

# 2. Post-processing (Phase 13)
# [run chained FFmpeg command] → post_processed.mp4

# 3. Watermark
ffmpeg -i post_processed.mp4 -i logo.png \
  -filter_complex "[1:v]scale=150:-1[logo];[0:v][logo]overlay=W-w-20:H-h-20:format=auto" \
  watermarked.mp4

# 4. Branding screens
ffmpeg -loop 1 -i intro.png -t 3 -vf "scale=1920:1080,format=yuv420p" -r 30 intro_clip.mp4
ffmpeg -loop 1 -i outro.png -t 5 -vf "scale=1920:1080,format=yuv420p" -r 30 outro_clip.mp4

# 5. Concatenate
ffmpeg -f concat -safe 0 -i list.txt -c copy combined.mp4

# 6. Add music
ffmpeg -i combined.mp4 -i /assets/music/default.mp3 \
  -shortest -c:v copy -c:a aac combined_audio.mp4

# 7. Embed metadata
ffmpeg -i combined_audio.mp4 \
  -metadata agent_id="UUID" \
  -metadata agent_name="Name" \
  -metadata company="Company" \
  -metadata license="LIC-12345" \
  -metadata generated_by="PropertyVideoSaaS" \
  -c copy final.mp4
```

### ⚠️ CLARIFICATION REQUIRED — Background Music

> "Should a default background music track be included in all videos?"

| Option | Description | Why Consider It |
|---|---|---|
| A | Include a royalty-free MP3 you supply at `/assets/music/default.mp3` | Adds production quality automatically. You must own the rights. |
| B | Allow agents to upload their own track per video | Gives agents full control. More complex to build — needs file upload field. |
| C | No music by default | Simplest. Agents add music after downloading if they choose. |

**Do not proceed past Step 6 of assembly until one option is chosen.**

---

## 16. PHASE 8 — Agent Profile System

### 16.1 Agent Sync on First Login

Create `src/app/api/agent/sync/route.ts`:

```typescript
import { auth } from '@clerk/nextjs/server';
import { pool } from '@/lib/db';

export async function POST() {
  const { userId } = auth();
  if (!userId) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  await pool.query(
    `INSERT INTO agents (id, clerk_user_id) VALUES (gen_random_uuid(), $1) ON CONFLICT (clerk_user_id) DO NOTHING`,
    [userId]
  );
  return Response.json({ ok: true });
}
```

### 16.2 Dashboard Layout (triggers sync)

Create `src/app/dashboard/layout.tsx`:

```typescript
'use client';
import { useEffect } from 'react';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  useEffect(() => { fetch('/api/agent/sync', { method: 'POST' }); }, []);
  return <>{children}</>;
}
```

### 16.3 Profile Page

Create `src/app/dashboard/profile/page.tsx`:

```tsx
'use client';
import { useState } from 'react';

export default function Profile() {
  const [logoFile,     setLogoFile]     = useState<File | null>(null);
  const [headshotFile, setHeadshotFile] = useState<File | null>(null);
  const [form, setForm] = useState({
    name: '', company: '', brokerage: '', phone: '',
    email: '', license_number: '', tagline: '', website: '',
    brand_color: '#00FF00'
  });

  async function save() {
    const data = new FormData();
    Object.entries(form).forEach(([k, v]) => data.append(k, v));
    if (logoFile)     data.append('logo',     logoFile);
    if (headshotFile) data.append('headshot', headshotFile);
    await fetch('/api/agent/update', { method: 'POST', body: data });
    alert('Profile saved.');
  }

  return (
    <div>
      <input placeholder="Full Name"      onChange={e => setForm({...form, name:           e.target.value})} />
      <input placeholder="Company"        onChange={e => setForm({...form, company:         e.target.value})} />
      <input placeholder="Brokerage"      onChange={e => setForm({...form, brokerage:       e.target.value})} />
      <input placeholder="Phone"          onChange={e => setForm({...form, phone:           e.target.value})} />
      <input placeholder="Email"          onChange={e => setForm({...form, email:           e.target.value})} />
      <input placeholder="License Number" onChange={e => setForm({...form, license_number: e.target.value})} />
      <input placeholder="Tagline"        onChange={e => setForm({...form, tagline:         e.target.value})} />
      <input placeholder="Website"        onChange={e => setForm({...form, website:         e.target.value})} />
      <label>Logo:    <input type="file" accept="image/png,image/jpeg" onChange={e => setLogoFile(e.target.files?.[0] || null)} /></label>
      <label>Headshot:<input type="file" accept="image/png,image/jpeg" onChange={e => setHeadshotFile(e.target.files?.[0] || null)} /></label>
      <button onClick={save}>Save Profile</button>
    </div>
  );
}
```

### 16.4 Asset Upload to DigitalOcean Spaces

Create `src/app/api/agent/update/route.ts`:

```typescript
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { auth } from '@clerk/nextjs/server';
import { pool } from '@/lib/db';

const s3 = new S3Client({
  region:   'nyc3',
  endpoint: 'https://nyc3.digitaloceanspaces.com',
  credentials: { accessKeyId: process.env.DO_SPACES_KEY!, secretAccessKey: process.env.DO_SPACES_SECRET! }
});

async function uploadAsset(file: File, agentId: string, type: 'logo' | 'headshot'): Promise<string> {
  const ext    = file.name.split('.').pop();
  const key    = `agents/${agentId}/${type}.${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  await s3.send(new PutObjectCommand({
    Bucket: process.env.DO_SPACES_BUCKET!, Key: key,
    Body: buffer, ACL: 'public-read', ContentType: file.type
  }));
  return `https://${process.env.DO_SPACES_BUCKET}.nyc3.digitaloceanspaces.com/${key}`;
}
```

---

## 17. PHASE 9 — Branding Injection

### 17.1 Video Structure (Locked)

```
0s – 3s      Intro screen  (logo + agent name + company + tagline)
3s – 17s+    Aerial video  (boundary overlay + corner watermark)
Last 5s      Outro screen  (headshot + name + phone + email + license + CTA)
```

### 17.2 Required Identity Markers

| Marker | Location | Purpose |
|---|---|---|
| Logo | Intro + watermark (full video) | Primary brand identity |
| Agent name | Intro + Outro | Personal attribution |
| Company / brokerage | Intro + Outro | Business attribution |
| License number | Outro | Legal identity |
| Phone | Outro | Contact |
| Email | Outro | Contact |
| Website | Outro | Contact |
| Tagline | Intro | Marketing |
| Headshot | Outro (if uploaded) | Personal branding |
| MP4 metadata tags | File | Machine-readable attribution |

### 17.3 Branding Image Generation

Create `src/worker/lib/branding.ts`:

```typescript
import { createCanvas, loadImage } from 'canvas';
import fs from 'fs';

export async function generateIntroImage(agent: any, outputPath: string) {
  const canvas = createCanvas(1920, 1080);
  const ctx    = canvas.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, 1920, 1080);

  if (agent.logo_url) {
    const logo  = await loadImage(agent.logo_url);
    const scale = Math.min(400 / logo.width, 250 / logo.height);
    ctx.drawImage(logo, (1920 - logo.width * scale) / 2, 200, logo.width * scale, logo.height * scale);
  }

  ctx.fillStyle = '#FFFFFF'; ctx.font = 'bold 72px Arial'; ctx.textAlign = 'center';
  ctx.fillText(agent.name    || '', 960, 580);
  ctx.fillStyle = agent.brand_color || '#00FF00'; ctx.font = '48px Arial';
  ctx.fillText(agent.company || '', 960, 650);
  ctx.fillStyle = '#CCCCCC'; ctx.font = 'italic 36px Arial';
  ctx.fillText(agent.tagline || '', 960, 720);

  fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
}

export async function generateOutroImage(agent: any, outputPath: string) {
  const canvas = createCanvas(1920, 1080);
  const ctx    = canvas.getContext('2d');
  ctx.fillStyle = '#111111';
  ctx.fillRect(0, 0, 1920, 1080);

  if (agent.headshot_url) {
    const hs = await loadImage(agent.headshot_url);
    ctx.save(); ctx.beginPath(); ctx.arc(300, 540, 220, 0, Math.PI * 2); ctx.clip();
    ctx.drawImage(hs, 80, 320, 440, 440); ctx.restore();
  }

  const x = agent.headshot_url ? 700 : 200;
  ctx.textAlign = 'left';
  ctx.fillStyle = '#FFFFFF'; ctx.font = 'bold 64px Arial'; ctx.fillText(agent.name || '', x, 300);
  ctx.fillStyle = agent.brand_color || '#00FF00'; ctx.font = 'bold 40px Arial'; ctx.fillText(agent.company || '', x, 380);
  ctx.fillStyle = '#CCCCCC'; ctx.font = '36px Arial';
  [agent.phone, agent.email, agent.website, agent.license_number ? `License: ${agent.license_number}` : null]
    .filter(Boolean).forEach((line, i) => ctx.fillText(line as string, x, 460 + i * 55));

  ctx.fillStyle = '#FFFFFF'; ctx.font = 'bold 52px Arial'; ctx.textAlign = 'center';
  ctx.fillText('Call Now for a Viewing', 960, 900);
  fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
}
```

---

## 18. PHASE 10 — Full Worker Pipeline

Create `src/worker/jobs/generateVideo.ts`:

```typescript
import fs   from 'fs';
import { exec as execCb } from 'child_process';
import { promisify }      from 'util';
import { lookupProperty, getParcelById } from '../../lib/property';
import { resolveBoundary, generateBoundingBox } from '../../lib/boundary';
import { selectRenderer }      from '../lib/rendererSelector';
import { generateMapboxFrames } from '../lib/mapboxRenderer';
import { generateCesiumFrames } from '../lib/cesiumRenderer';
import { generateIntroImage, generateOutroImage } from '../lib/branding';
import { pool } from '../../lib/db';

const exec = promisify(execCb);

export async function generateVideoJob(job: any) {
  const { valuationNumber, agentId, customBoundary, nlaObjectId } = job.data;
  const jobDir    = `/tmp/job_${job.id}`;
  const framesDir = `${jobDir}/frames`;
  await fs.promises.mkdir(framesDir, { recursive: true });

  // 1. Load property — use specific parcel if agent selected from modal
  let property;
  if (nlaObjectId) {
    property = await getParcelById(nlaObjectId);
  } else {
    const result = await lookupProperty(valuationNumber);
    if (result.type === 'not_found') throw new Error('PROPERTY_NOT_FOUND');
    if (result.type === 'multiple')  throw new Error('PARCEL_SELECTION_REQUIRED');
    property = result.property;
  }
  if (!property) throw new Error('PROPERTY_NOT_FOUND');

  // 2. Load agent
  const agentRes = await pool.query('SELECT * FROM agents WHERE id = $1', [agentId]);
  const agent    = agentRes.rows[0];
  if (!agent || agent.subscription_status !== 'active') throw new Error('SUBSCRIPTION_REQUIRED');

  // 3. Resolve boundary
  const boundary = customBoundary || resolveBoundary(property);

  // 4. Select renderer
  const renderer = await selectRenderer(property);
  await pool.query(`UPDATE jobs SET status = 'processing' WHERE id = $1`, [job.id]);

  // 5. Generate frames
  if (renderer === 'cesium') {
    await generateCesiumFrames(property.latitude, property.longitude, boundary, framesDir);
  } else {
    await generateMapboxFrames(property, framesDir);
  }

  // 6. Compile frames
  await exec(`ffmpeg -framerate 30 -i ${framesDir}/frame_%04d.png -vf "format=yuv420p" ${jobDir}/base.mp4`);

  // 7. Post-processing
  await exec(`ffmpeg -i ${jobDir}/base.mp4 -vf "vignette=PI/4,tmix=frames=3:weights='1 2 1',noise=alls=8:allf=t+u,scale=1920:1080:flags=lanczos,format=yuv420p" -c:v libx264 -crf 18 -preset slow -movflags +faststart ${jobDir}/post_processed.mp4`);

  // 8. Watermark
  await exec(`ffmpeg -i ${jobDir}/post_processed.mp4 -i ${agent.logo_url || '/assets/placeholder_logo.png'} -filter_complex "[1:v]scale=150:-1[logo];[0:v][logo]overlay=W-w-20:H-h-20" ${jobDir}/watermarked.mp4`);

  // 9. Branding screens
  await generateIntroImage(agent, `${jobDir}/intro.png`);
  await generateOutroImage(agent, `${jobDir}/outro.png`);
  await exec(`ffmpeg -loop 1 -i ${jobDir}/intro.png -t 3 -vf "scale=1920:1080,format=yuv420p" -r 30 ${jobDir}/intro_clip.mp4`);
  await exec(`ffmpeg -loop 1 -i ${jobDir}/outro.png -t 5 -vf "scale=1920:1080,format=yuv420p" -r 30 ${jobDir}/outro_clip.mp4`);

  // 10. Concatenate
  fs.writeFileSync(`${jobDir}/list.txt`, `file '${jobDir}/intro_clip.mp4'\nfile '${jobDir}/watermarked.mp4'\nfile '${jobDir}/outro_clip.mp4'`);
  await exec(`ffmpeg -f concat -safe 0 -i ${jobDir}/list.txt -c copy ${jobDir}/combined.mp4`);

  // 11. Music (conditional on choice made in Phase 15)
  await exec(`ffmpeg -i ${jobDir}/combined.mp4 -i /assets/music/default.mp3 -shortest -c:v copy -c:a aac ${jobDir}/with_audio.mp4`);

  // 12. Metadata
  await exec(`ffmpeg -i ${jobDir}/with_audio.mp4 -metadata agent_id="${agent.id}" -metadata agent_name="${agent.name}" -metadata license="${agent.license_number || ''}" -metadata generated_by="PropertyVideoSaaS" -c copy ${jobDir}/final.mp4`);

  // 13. Upload + complete
  const url = await uploadVideo(`${jobDir}/final.mp4`, job.id);
  await pool.query(`UPDATE jobs SET status = 'complete', output_url = $1, completed_at = NOW() WHERE id = $2`, [url, job.id]);
  await fs.promises.rm(jobDir, { recursive: true });

  return url;
}
```

---

## 19. PHASE 11 — Frontend UI

### 19.1 Page Structure

```
/                       Landing page + login
/dashboard              Agent home (recent videos, usage meter)
/dashboard/generate     Valuation input + map preview + generate
/dashboard/profile      Agent credentials + uploads
/dashboard/subscribe    Subscription management
```

### 19.2 Disambiguation Modal

This file was copied from the reference folder in Step 6.6.
Confirm `src/components/ParcelSelectModal.tsx` exists and contains
the modal component. If not, create it:

```tsx
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

function formatAddress(p: Parcel): string {
  return p.street_address || p.scheme_address || p.location || 'No address available';
}

export default function ParcelSelectModal({
  valuationNumber, parcels, onSelect, onClose
}: {
  valuationNumber: string;
  parcels:         Parcel[];
  onSelect:        (nlaObjectId: number) => void;
  onClose:         () => void;
}) {
  return (
    <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: 'white', borderRadius: 8, padding: 32, maxWidth: 600, width: '90%', maxHeight: '80vh', overflowY: 'auto' }}>
        <h2 style={{ marginTop: 0 }}>Multiple properties found</h2>
        <p>Valuation number <strong>{valuationNumber}</strong> is linked to multiple properties. Select the one you want to create a video for.</p>
        {parcels.map(p => (
          <button key={p.nla_object_id} onClick={() => onSelect(p.nla_object_id)}
            style={{ display: 'block', width: '100%', textAlign: 'left', padding: '12px 16px', marginBottom: 8, border: '1px solid #ddd', borderRadius: 6, background: '#f9f9f9', cursor: 'pointer', fontSize: 14 }}>
            <strong>{formatAddress(p)}</strong>
            {p.parish && <span style={{ color: '#666' }}> — {p.parish}</span>}
            <br />
            <span style={{ fontSize: 12, color: '#888' }}>
              {p.has_boundary ? '✓ Boundary data available' : '⚠ No boundary — approximate box used'}
              {p.is_incomplete && ' · ⚠ Incomplete NLA record'}
            </span>
          </button>
        ))}
        <button onClick={onClose} style={{ marginTop: 8, color: '#666', background: 'none', border: 'none', cursor: 'pointer' }}>Cancel</button>
      </div>
    </div>
  );
}
```

### 19.3 Map Editor Component

Create `src/components/MapEditor.tsx`:

```tsx
'use client';
import Map from 'react-map-gl';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import { useRef, useEffect } from 'react';
import { generateBoundingBox } from '@/lib/boundary';

export default function MapEditor({ property, onBoundaryChange }: {
  property:           any;
  onBoundaryChange:   (boundary: object) => void;
}) {
  const mapRef = useRef<any>(null);

  useEffect(() => {
    if (!mapRef.current) return;
    const draw = new MapboxDraw({ displayControlsDefault: false, controls: { polygon: true, trash: true } });
    mapRef.current.addControl(draw);
    const initial = property.boundary_geojson
      ? { type: 'Feature', geometry: property.boundary_geojson }
      : { type: 'Feature', geometry: generateBoundingBox(property.latitude, property.longitude) };
    draw.add(initial);
    mapRef.current.on('draw.update', () => {
      const data = draw.getAll();
      if (data.features.length) onBoundaryChange(data.features[0].geometry);
    });
  }, []);

  return (
    <Map ref={mapRef}
      initialViewState={{ longitude: property.longitude, latitude: property.latitude, zoom: 16 }}
      style={{ width: '100%', height: 500 }}
      mapStyle="mapbox://styles/mapbox/satellite-v9"
      mapboxAccessToken={process.env.NEXT_PUBLIC_MAPBOX_TOKEN}
    />
  );
}
```

### 19.4 Generate Page (with modal)

Create `src/app/dashboard/generate/page.tsx`:

```tsx
'use client';
import { useState }        from 'react';
import useSWR              from 'swr';
import MapEditor           from '@/components/MapEditor';
import ParcelSelectModal   from '@/components/ParcelSelectModal';

const fetcher = (url: string) => fetch(url).then(r => r.json());

export default function GeneratePage() {
  const [valuation,         setValuation]         = useState('');
  const [property,          setProperty]          = useState<any>(null);
  const [boundary,          setBoundary]          = useState<any>(null);
  const [jobId,             setJobId]             = useState<string | null>(null);
  const [loading,           setLoading]           = useState(false);
  const [error,             setError]             = useState('');
  const [multiParcels,      setMultiParcels]      = useState<any[] | null>(null);
  const [showModal,         setShowModal]         = useState(false);
  const [valuationForModal, setValuationForModal] = useState('');
  const [selectedNlaId,     setSelectedNlaId]     = useState<number | null>(null);

  const { data: status } = useSWR(
    jobId ? `/api/status/${jobId}` : null,
    fetcher, { refreshInterval: 2000 }
  );

  async function fetchProperty() {
    setError(''); setMultiParcels(null); setShowModal(false); setProperty(null);
    const res  = await fetch(`/api/property/${valuation.trim()}`);
    const data = await res.json();
    if (!res.ok) { setError(data.error || 'Property not found.'); return; }
    if (data.type === 'multiple') {
      setMultiParcels(data.parcels);
      setValuationForModal(data.valuation_number);
      setShowModal(true);
      return;
    }
    setProperty(data);
    setBoundary(data.boundary_geojson);
  }

  async function handleParcelSelect(nlaObjectId: number) {
    setShowModal(false); setSelectedNlaId(nlaObjectId);
    const res  = await fetch(`/api/parcel/${nlaObjectId}`);
    const data = await res.json();
    if (!res.ok) { setError('Could not load parcel data.'); return; }
    setProperty(data); setBoundary(data.boundary_geojson);
  }

  async function generateVideo() {
    setLoading(true);
    const res  = await fetch('/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        valuationNumber: property.valuation_number,
        nlaObjectId:     selectedNlaId,
        boundary
      })
    });
    const data = await res.json();
    if (data.error) { setError(data.error); setLoading(false); return; }
    setJobId(data.jobId); setLoading(false);
  }

  return (
    <div>
      <input value={valuation} onChange={e => setValuation(e.target.value)}
        placeholder="Enter valuation number or folio number" />
      <button onClick={fetchProperty}>Load Property</button>

      {error && <p style={{ color: 'red' }}>{error}</p>}

      {property && (
        <>
          <p><strong>{property.street_address || property.scheme_address || 'No address'}</strong>{property.parish ? `, ${property.parish}` : ''}</p>
          <p style={{ color: '#888', fontSize: 13 }}>
            Preview — adjust boundary if needed.
            {property.has_boundary ? ' Showing real NLA boundary.' : ' Showing approximate bounding box.'}
            {property.is_incomplete && ' ⚠ Incomplete NLA record.'}
          </p>
          <MapEditor property={property} onBoundaryChange={setBoundary} />
          <button onClick={generateVideo} disabled={loading || status?.status === 'processing'}>
            {loading ? 'Submitting...' : 'Generate Video'}
          </button>
        </>
      )}

      {status?.status === 'processing' && <p>Generating video — this takes 2–15 minutes...</p>}
      {status?.status === 'complete'   && <a href={`/api/download/${jobId}`} download>Download Your Video</a>}
      {status?.status === 'failed'     && <p>Generation failed. Please try again.</p>}

      {showModal && multiParcels && (
        <ParcelSelectModal
          valuationNumber={valuationForModal}
          parcels={multiParcels}
          onSelect={handleParcelSelect}
          onClose={() => setShowModal(false)}
        />
      )}
    </div>
  );
}
```

---

## 20. PHASE 12 — Auth (Clerk)

```zsh
npm install @clerk/nextjs
```

Update `src/app/layout.tsx`:

```typescript
import { ClerkProvider } from '@clerk/nextjs';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en"><body>{children}</body></html>
    </ClerkProvider>
  );
}
```

Create `src/middleware.ts`:

```typescript
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isProtected = createRouteMatcher([
  '/dashboard(.*)', '/api/generate', '/api/status(.*)',
  '/api/download(.*)', '/api/agent(.*)', '/api/parcel(.*)'
]);

export default clerkMiddleware((auth, req) => {
  if (isProtected(req)) auth().protect();
});

export const config = { matcher: ['/((?!_next|.*\\..*).*)'] };
```

---

## 21. PHASE 13 — Subscription (Stripe)

```zsh
npm install stripe
```

### 21.1 Plans

| Plan | Videos/Month | monthly_video_limit value |
|---|---|---|
| Basic | 10 | 10 |
| Pro | 50 | 50 |
| Enterprise | Unlimited | -1 |

### 21.2 Checkout Route

Create `src/app/api/subscribe/route.ts`:

```typescript
import Stripe from 'stripe';
import { auth } from '@clerk/nextjs/server';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function POST() {
  const { userId } = auth();
  const session    = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    mode:                 'subscription',
    client_reference_id:  userId!,
    line_items:           [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
    success_url:          `${process.env.NEXT_PUBLIC_BASE_URL}/dashboard`,
    cancel_url:           `${process.env.NEXT_PUBLIC_BASE_URL}/dashboard/subscribe`
  });
  return Response.json({ url: session.url });
}
```

### 21.3 Stripe Webhook

Create `src/app/api/webhook/stripe/route.ts`:

```typescript
import Stripe from 'stripe';
import { pool } from '@/lib/db';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

function getPlanLimit(plan?: string): number {
  if (plan === 'pro')        return 50;
  if (plan === 'enterprise') return -1;
  return 10; // Basic default
}

export async function POST(req: Request) {
  const event = stripe.webhooks.constructEvent(
    await req.text(),
    req.headers.get('stripe-signature')!,
    process.env.STRIPE_WEBHOOK_SECRET!
  );

  if (event.type === 'checkout.session.completed') {
    const userId = (event.data.object as any).client_reference_id;
    const limit  = getPlanLimit((event.data.object as any).metadata?.plan);
    await pool.query(
      `UPDATE agents SET subscription_status = 'active', monthly_video_limit = $1 WHERE clerk_user_id = $2`,
      [limit, userId]
    );
  }

  if (event.type === 'customer.subscription.deleted') {
    const userId = (event.data.object as any).metadata?.clerk_user_id;
    await pool.query(
      `UPDATE agents SET subscription_status = 'inactive' WHERE clerk_user_id = $1`,
      [userId]
    );
  }

  return new Response('ok');
}
```

---

## 22. PHASE 14 — Usage Limits

Create `src/app/api/generate/route.ts`:

```typescript
import { auth } from '@clerk/nextjs/server';
import { pool } from '@/lib/db';
import { videoQueue } from '@/lib/queue';

async function resetIfNeeded(agent: any) {
  const diffDays = (Date.now() - new Date(agent.billing_cycle_start).getTime()) / (1000 * 60 * 60 * 24);
  if (diffDays >= 30) {
    await pool.query(`UPDATE agents SET videos_used = 0, billing_cycle_start = NOW() WHERE id = $1`, [agent.id]);
    return { ...agent, videos_used: 0 };
  }
  return agent;
}

export async function POST(req: Request) {
  const { userId } = auth();
  if (!userId) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });

  const { valuationNumber, nlaObjectId, boundary } = await req.json();

  const agentRes = await pool.query(`SELECT * FROM agents WHERE clerk_user_id = $1`, [userId]);
  let agent = agentRes.rows[0];
  if (!agent) return Response.json({ error: 'AGENT_NOT_FOUND' }, { status: 404 });

  agent = await resetIfNeeded(agent);

  if (agent.subscription_status !== 'active')
    return Response.json({ error: 'SUBSCRIPTION_REQUIRED' }, { status: 403 });

  if (agent.monthly_video_limit !== -1 && agent.videos_used >= agent.monthly_video_limit)
    return Response.json({ error: 'LIMIT_REACHED' }, { status: 403 });

  await pool.query(`UPDATE agents SET videos_used = videos_used + 1 WHERE id = $1`, [agent.id]);

  try {
    const job = await videoQueue.add('generate-video', {
      valuationNumber, nlaObjectId, agentId: agent.id, customBoundary: boundary
    });
    await pool.query(
      `INSERT INTO jobs (id, agent_id, valuation_number, status) VALUES ($1, $2, $3, 'queued')`,
      [job.id, agent.id, valuationNumber]
    );
    return Response.json({ jobId: job.id });
  } catch (err) {
    await pool.query(`UPDATE agents SET videos_used = GREATEST(videos_used - 1, 0) WHERE id = $1`, [agent.id]);
    throw err;
  }
}
```

---

## 23. PHASE 15 — Queue System

```zsh
npm install bullmq ioredis
```

Create `src/lib/queue.ts`:

```typescript
import { Queue, Worker } from 'bullmq';

export const videoQueue = new Queue('video-generation', {
  connection: { host: process.env.REDIS_HOST, port: parseInt(process.env.REDIS_PORT || '6379') }
});

export function startWorker() {
  return new Worker('video-generation', async (job) => {
    const { generateVideoJob } = await import('./worker/jobs/generateVideo');
    try {
      return await generateVideoJob(job);
    } catch (err) {
      const { pool } = await import('./db');
      await pool.query(
        `UPDATE agents SET videos_used = GREATEST(videos_used - 1, 0) WHERE id = $1`,
        [job.data.agentId]
      );
      throw err;
    }
  }, {
    connection: { host: process.env.REDIS_HOST, port: parseInt(process.env.REDIS_PORT || '6379') }
  });
}
```

---

## 24. PHASE 16 — Error Handling

| Failure | Action |
|---|---|
| Property not found | Return 404, stop |
| Parcel selection required | Return error — frontend should not reach generate without selecting |
| Agent not found | Return 401 |
| Subscription inactive | Return 403 |
| Usage limit reached | Return 403 |
| Database connection failure | Log, return 500 |
| Cesium probe fails | Set `cesium_coverage = false`, fall back to Mapbox |
| Cesium render crashes | Close browser, fall back to Mapbox, retry once |
| Mapbox API fails | Retry 3x with exponential backoff |
| No boundary in DB | Generate bounding box — never block |
| Frame render fails | Skip frame, fill with nearest neighbour |
| Post-processing fails | Retry once; skip filter on second failure |
| FFmpeg fails | Retry once; mark failed on second failure |
| Upload fails | Retry 3x; mark job failed |
| Job fails after usage increment | Decrement usage counter |

---

## 25. PHASE 17 — Deployment

| Service | Platform |
|---|---|
| Frontend + API | Vercel |
| Worker service | DigitalOcean Droplet (Docker) |
| Redis | DigitalOcean Managed Redis |
| PostgreSQL | Migrate `property_video_db` to DigitalOcean Managed PostgreSQL |
| Storage | DigitalOcean Spaces |

### ⚠️ CLARIFICATION REQUIRED — Database Migration for Production

The current database runs locally on your development machine. For production
deployment the application on Vercel cannot reach `localhost:5432`.

> "How should the production database be hosted?"

| Option | Description | Why Consider It |
|---|---|---|
| A | Migrate `property_video_db` to DigitalOcean Managed PostgreSQL | Recommended. Automated backups, monitoring, and PgBouncer built in. `pg_dump` the local database and restore it to the managed cluster. All data is preserved. |
| B | Self-managed PostgreSQL on a DigitalOcean Droplet with a public IP | More control, lower cost, but you manage backups and uptime. Requires opening port 5432 to the application's IP range. |
| C | Keep local for development, create a separate fresh production database | Only do this if you plan to re-ingest all NLA data from scratch on the production server. Not recommended — the existing data took significant time to ingest. |

**Do not proceed to deployment until this is chosen. The DATABASE_URL
in production must point to a publicly reachable host.**

### Worker Dockerfile

```dockerfile
FROM node:20-slim

RUN apt-get update && apt-get install -y \
  ffmpeg python3 python3-pip \
  chromium chromium-driver \
  fonts-liberation libatk-bridge2.0-0 libgtk-3-0 \
  libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 \
  libasound2 libpangocairo-1.0-0 \
  && rm -rf /var/lib/apt/lists/*

RUN pip3 install opencv-python-headless numpy realesrgan basicsr --break-system-packages

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app
COPY . .
RUN npm install

CMD ["node", "src/worker/index.js"]
```

---

## 26. Folder Structure

```
property-video-app/
  src/
    app/
      api/
        property/[id]/route.ts     ← lookupProperty — single or multiple
        parcel/[nlaObjectId]/route.ts ← getParcelById — after modal selection
        generate/route.ts          ← enforces subscription + usage limits
        status/[jobId]/route.ts
        download/[jobId]/route.ts
        agent/
          sync/route.ts
          update/route.ts
          usage/route.ts
        subscribe/route.ts
        webhook/stripe/route.ts
      dashboard/
        layout.tsx                 ← triggers agent sync
        page.tsx
        generate/page.tsx          ← includes ParcelSelectModal
        profile/page.tsx
        subscribe/page.tsx
      page.tsx
      layout.tsx                   ← ClerkProvider
    components/
      MapEditor.tsx
      ParcelSelectModal.tsx        ← copied from reference/databaseUpdate-step8
    lib/
      db.ts                        ← pool connecting to property_video_db
      queue.ts
      boundary.ts
      property.ts                  ← copied from reference/databaseUpdate-step8
      storage.ts
    worker/
      index.ts
      jobs/
        generateVideo.ts
      lib/
        rendererSelector.ts
        mapboxRenderer.ts
        cesiumRenderer.ts
        postProcess.ts
        overlay.ts
        ffmpeg.ts
        branding.ts
      static/
        cesium-render.html
        cesium-flight.js
      python/
        draw_boundary.py
  assets/
    music/
      default.mp3                  ← supply if music Option A chosen
    luts/
      cinematic_warm.cube          ← supply if color grading Option A chosen
  middleware.ts
  .env.local                       ← never committed to git
```

---

## 27. Smoke Tests (Run After Each Phase)

After completing each phase, run the test for that phase before moving on.

| After Phase | Test |
|---|---|
| Phase 1 (DB connection) | Run the node connection test — must print 880422 properties |
| Phase 3 (Property resolver) | `curl http://localhost:3000/api/property/13004014089` — must return single result with boundary |
| Phase 3 (Multi-parcel) | `curl http://localhost:3000/api/property/031B6W02067` — must return type: multiple with 276 parcels |
| Phase 4 (Renderer) | Generate test job — check logs confirm Mapbox selected |
| Phase 11 (Modal) | Enter `031B6W02067` in the generate page — modal must appear |
| Phase 12 (Auth) | Sign up as test agent — confirm row created in `agents` table |
| Phase 13 (Stripe) | Complete test checkout — confirm `subscription_status = active` in DB |
| Phase 17 (Deploy) | Generate a video end-to-end on production — confirm download works |

---

## 28. Remaining Clarifications

| # | Clarification | Required Before |
|---|---|---|
| 1 | API keys not yet obtained | Step 0 (Mapbox minimum) |
| 2 | Color grading method (LUT vs curves) | Phase 5C Step 2 |
| 3 | Boundary line style | Phase 6 |
| 4 | Background music | Phase 7 Step 6 |
| 5 | Branding color (fixed vs per-agent) | Phase 9 |
| 6 | Free tier vs paid-only from day one | Phase 13 |
| 7 | Cesium renderer by subscription plan | Phase 13 |
| 8 | Cesium probe reliability | Phase 10 (only if probe is unreliable) |
| 9 | Production database hosting | Phase 17 |

---

## 29. Build Order

| Step | Task | Depends On |
|---|---|---|
| 0 | Create Next.js app, install deps, copy reference files | Nothing |
| 1 | Database connection + verify | Step 0 |
| 2 | Boundary resolution library | Step 1 |
| 3 | Property resolver + API routes (single + multiple + parcel) | Step 1, 2 |
| 12 | Auth — Clerk setup | Step 0 |
| 4 | Renderer selection | Step 1 |
| 5A | Mapbox frame generation | Step 2, 4 |
| 5B | Cesium headless renderer | Step 4 |
| 5C | Post-processing pipeline | Step 5A or 5B |
| 6 | Boundary overlay per frame | Step 5A/5B |
| 7 | Video assembly FFmpeg | Step 5C, 6 |
| 8 | Agent profile + file upload | Step 12 |
| 9 | Branding injection | Step 7, 8 |
| 10 | Full worker pipeline | Steps 4–9 |
| 13 | Subscription — Stripe | Step 12 |
| 14 | Usage limits + generate API | Step 13 |
| 15 | Queue system | Step 10 |
| 16 | Full frontend UI | All above |
| 17 | Deployment | All above |

---

## END OF PLAN v6