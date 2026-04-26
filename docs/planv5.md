# plan_v5.md — AI Property Video Generator (Application Build Plan)
## Reflects Phase 0 Database Already Complete

---

## CHANGELOG FROM v4

| Area | Change |
|---|---|
| Phase 1 — Database layer | **Removed entirely.** Database, schema, all tables, indexes, triggers, views, and data are already built and populated by Phase 0 v2. |
| Phase 1 — Data ingestion | **Removed entirely.** CSV ingestion replaced by NLA GIS API scraper already run in Phase 0. |
| Phase 1 — Property data clarification | **Removed.** Answered by Phase 0 — data comes from NLA GIS API. |
| Database connection | **Updated.** Application connects to the existing database using `app_user` credentials on PgBouncer port 25061. No schema creation needed. |
| Property resolver | **Updated.** Query updated to match the actual Phase 0 schema column names (`street_address`, `scheme_address`, `nla_object_id`, etc.). |
| Boundary resolution | **Updated.** `boundary_geojson` is already populated from NLA polygon data for most properties. Bounding box fallback is now a minority case, not the default. |
| Build order | **Updated.** Phase 1 removed. Phase 2 is now the first thing to build. |
| Clarification 1 (property data source) | **Removed.** No longer applicable — data is already in the database. |

Everything else from v4 is unchanged and still applies.

---

## 1. Core Objective

Build a subscription-based SaaS web application that:

1. Accepts a valuation number or folio number as input
2. Looks up the property in the **already-populated PostgreSQL database** (built in Phase 0)
3. Selects the best available renderer automatically:
   - **Cesium + Google Photorealistic 3D Tiles** if coverage exists at those coordinates
   - **Mapbox satellite-v9** if Cesium coverage is absent (currently the case for Jamaica)
4. Generates a cinematic aerial video (≥ 20 seconds, 1920x1080 Full HD)
5. Applies a mandatory post-processing pipeline to improve visual quality
6. Automatically overlays and tracks real NLA property boundary lines throughout the video
7. Injects agent branding at the start, end, and throughout the video
8. Ties every video permanently to the paying agent's account
9. Allows the agent to download the final branded video

> **Reality check (locked):** This system produces SYNTHETIC aerial animation. The Mapbox path is a top-down satellite zoom with cinematic post-processing. The Cesium path, when coverage exists, produces a tilted 3D photorealistic flyover resembling real drone footage. As Google expands their 3D Tiles dataset, more properties automatically receive the higher-quality Cesium render with no code changes required.

---

## 2. What Is Already Done (Phase 0 Deliverables)

The following items are complete and must not be re-implemented.
The application connects to these — it does not create them.

| Deliverable | Status | Notes |
|---|---|---|
| PostgreSQL database | ✅ Complete | Hosted on DigitalOcean (or Droplet per hosting choice made in Phase 0) |
| PostGIS + pgcrypto + pg_trgm extensions | ✅ Installed | |
| `properties` table | ✅ Created and populated | Contains all Jamaica NLA parcels with coordinates and boundary polygons |
| `agents` table | ✅ Created | Empty — populated as agents sign up |
| `jobs` table | ✅ Created | Empty — populated as videos are generated |
| `refresh_log` table | ✅ Created | |
| All indexes | ✅ Created | Including spatial GIST indexes |
| `v_data_quality_summary` view | ✅ Created | |
| `v_parish_summary` view | ✅ Created | |
| Auto-update triggers | ✅ Created | `updated_at` maintained automatically |
| Row-level security on `agents` | ✅ Enabled | |
| `app_user` database account | ✅ Created | Restricted permissions — use this for the application |
| NLA property data | ✅ Ingested | All Jamaica parcels with real polygon boundaries from NLA GIS API |
| `app_user` connection string | ✅ Available | Port 25061 (PgBouncer) for application use |

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
- Application connects to database as `app_user` via PgBouncer port 25061 — never as `doadmin`

---

## 4. System Architecture

| Component | Technology |
|---|---|
| Frontend | Next.js (App Router), React, Mapbox GL JS, Tailwind CSS |
| Backend API | Next.js API Routes (Node.js) |
| Worker Service | Node.js + Python subprocess (FFmpeg, OpenCV, Puppeteer) |
| Queue | BullMQ + Redis |
| Database | **Existing** PostgreSQL + PostGIS (Phase 0) |
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

## 6. Database Connection (First Thing to Configure)

This is the very first task. Before any code is written, confirm the
application can connect to the existing Phase 0 database.

### 6.1 Environment Variables

Create `/app/.env.local` with the following. The values come from the
credentials saved during Phase 0 Step 7B.

```bash
# Application database — app_user via PgBouncer (use this for ALL application queries)
DATABASE_URL=postgresql://app_user:PASSWORD@HOST:25061/DATABASE?sslmode=require

# Never use the admin connection string in application code
# Admin URL is only for ingestion scripts and schema changes
```

### 6.2 Database Client Module

```typescript
// /lib/db.ts
import { Pool } from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is not set');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:  { rejectUnauthorized: false },
  max:  10,
  idleTimeoutMillis:       30000,
  connectionTimeoutMillis: 10000
});

// Test connection on startup
pool.query('SELECT NOW()').then(() => {
  console.log('Database connection established');
}).catch(err => {
  console.error('Database connection failed:', err.message);
  process.exit(1);
});
```

### 6.3 Verify Connection Before Proceeding

Run this before writing any other application code:

```bash
node -e "
require('dotenv').config({ path: '.env.local' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
pool.query('SELECT COUNT(*) FROM properties').then(r => {
  console.log('Connected. Properties in database:', r.rows[0].count);
  pool.end();
}).catch(err => {
  console.error('Connection failed:', err.message);
  process.exit(1);
});
"
```

Expected output: `Connected. Properties in database: [large number]`

If this fails, stop and resolve the connection before proceeding.
The application cannot function without a working database connection.

---

## 7. PHASE 2 — Boundary Resolution

> **Note:** Phase 1 (database creation and data ingestion) is already complete.
> The application starts at Phase 2.

### Goal
Resolve a property's boundary for use in video overlay. Because Phase 0
ingested real NLA polygon boundaries for most properties, the bounding box
fallback will rarely be needed. The logic handles both cases.

### 7.1 Priority Logic (Locked)

```typescript
// /lib/boundary.ts

function resolveBoundary(property) {
  if (property.boundary_geojson) {
    // Real NLA boundary polygon — use it directly
    return property.boundary_geojson;
  }
  // Fallback: generate a bounding box from coordinates
  // This applies to properties where NLA had no polygon geometry
  return generateBoundingBox(property.latitude, property.longitude);
}
```

### 7.2 Bounding Box Fallback

```typescript
function metersToLat(meters: number): number {
  return meters / 111320;
}

function metersToLng(meters: number, lat: number): number {
  return meters / (111320 * Math.cos(lat * Math.PI / 180));
}

function generateBoundingBox(lat: number, lng: number, zoom: number = 17) {
  const size = zoom < 16 ? 60 : 40; // half-size in meters
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

export { resolveBoundary, generateBoundingBox };
```

Output is always a valid GeoJSON Polygon. No exceptions.

---

## 8. PHASE 3 — Property Resolver API

### Goal
Expose an API endpoint that the frontend calls to look up a property
by valuation number or folio number.

### 8.1 Property Resolver

```typescript
// /lib/property.ts
import { pool } from './db';

export async function getProperty(valuationNumber: string) {
  const res = await pool.query(
    `SELECT
       id,
       nla_object_id,
       valuation_number,
       folio_number,
       street_address,
       scheme_address,
       parish,
       location,
       latitude,
       longitude,
       boundary_geojson,
       has_coordinates,
       has_boundary,
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

> **Important:** The column names here match the Phase 0 schema exactly.
> Do not change them. The Phase 0 schema uses `street_address` and
> `scheme_address` (not `streetAdd` or `schemeAdd`).

### 8.2 API Route

```typescript
// /app/api/property/[id]/route.ts
import { getProperty } from '@/lib/property';
import { auth } from '@clerk/nextjs/server';

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const { userId } = auth();
  if (!userId) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });

  const property = await getProperty(params.id);
  if (!property) return Response.json({ error: 'PROPERTY_NOT_FOUND' }, { status: 404 });

  // Do not expose raw database IDs to the frontend
  return Response.json({
    valuation_number: property.valuation_number,
    folio_number:     property.folio_number,
    street_address:   property.street_address,
    scheme_address:   property.scheme_address,
    parish:           property.parish,
    location:         property.location,
    latitude:         property.latitude,
    longitude:        property.longitude,
    boundary_geojson: property.boundary_geojson,
    has_coordinates:  property.has_coordinates,
    has_boundary:     property.has_boundary
    // cesium_coverage is internal — not exposed to frontend
  });
}
```

---

## 9. PHASE 4 — Renderer Selection

### Goal
Decide which renderer to use for this property before any frames are
generated. Result is cached in the `cesium_coverage` column so the
probe never runs twice for the same property.

### 9.1 Selection Logic

```typescript
// /worker/lib/rendererSelector.ts
import { pool } from '../../lib/db';

export async function selectRenderer(property): Promise<'cesium' | 'mapbox'> {
  // Use cached result if available
  if (property.cesium_coverage === true)  return 'cesium';
  if (property.cesium_coverage === false) return 'mapbox';

  // Unknown — probe now
  const hasCoverage = await probeCesiumCoverage(property.latitude, property.longitude);

  // Cache result — never probe this property again
  await pool.query(
    'UPDATE properties SET cesium_coverage = $1 WHERE valuation_number = $2',
    [hasCoverage, property.valuation_number]
  );

  return hasCoverage ? 'cesium' : 'mapbox';
}
```

### 9.2 Cesium Coverage Probe

```typescript
import puppeteer from 'puppeteer';

async function probeCesiumCoverage(lat: number, lon: number): Promise<boolean> {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page    = await browser.newPage();

  try {
    const hasCoverage = await page.evaluate(async () => {
      try {
        const res = await fetch(
          `https://tile.googleapis.com/v1/3dtiles/root.json?key=${process.env.GOOGLE_MAPS_API_KEY}`
        );
        return res.ok;
      } catch {
        return false;
      }
    });
    return hasCoverage;
  } finally {
    await browser.close();
  }
}
```

### ⚠️ CLARIFICATION REQUIRED — Coverage Probe Reliability

If the coverage probe returns inconsistent results during testing
(e.g. returns true for all properties or false for all properties),
the agent must stop and ask:

> "The Cesium coverage probe is not behaving reliably. How should we handle renderer selection?"

| Option | Description | Why Consider It |
|---|---|---|
| A | Default all properties to Mapbox renderer until Cesium is manually enabled per region | Safest and most predictable. Jamaica currently has no Google 3D Tiles coverage so this is the correct short-term behavior. Zero risk of Cesium failing in production. |
| B | Add a manual `cesium_coverage` override column in an admin panel so you can enable Cesium for specific properties or regions | Gives full control without relying on automated probing. When Google adds Jamaica coverage, you enable it with a database update rather than waiting for probes to detect it. |
| C | Build a one-time batch scan that probes all properties and caches results, then disables per-job probing entirely | Run once, cache everything, never probe again per job. Fastest per-job performance. Best option if the probe logic itself is solid but the per-job overhead is too high. |

---

## 10. PHASE 5A — Mapbox Frame Generation (Primary Renderer)

### Goal
Generate 600 frames (30 FPS × 20 seconds) simulating a cinematic aerial
flyover using Mapbox Static Images API.

### 10.1 Camera Model (Locked)

| Parameter | Start | End |
|---|---|---|
| Zoom | 14 | 18 |
| Bearing | -20° | 0° |
| Pitch | 0° (not available in Static API) | — |
| FPS | 30 | — |
| Total Frames | 600 | — |

### 10.2 Motion Curve

```typescript
// /worker/lib/mapboxRenderer.ts
function easeOutExpo(t: number): number {
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

function getCameraAtFrame(i: number, totalFrames: number) {
  const t     = i / (totalFrames - 1);
  const eased = easeOutExpo(t);
  return {
    zoom:    14 + (18 - 14) * eased,
    bearing: -20 + (0 - (-20)) * eased
  };
}
```

### 10.3 Frame Fetch

```typescript
import fetch from 'node-fetch';
import fs    from 'fs';
import path  from 'path';

async function fetchMapboxFrame(
  i:          number,
  lat:        number,
  lon:        number,
  zoom:       number,
  bearing:    number,
  outputDir:  string
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
```

### 10.4 Concurrency + Cost Control

```typescript
import pLimit from 'p-limit';
const limit = pLimit(5); // max 5 concurrent Mapbox requests

export async function generateMapboxFrames(property, outputDir: string) {
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

> **Cost control:** Cache frames keyed by `(lat_4dp, lon_4dp, zoom_4dp, bearing_2dp)`.
> Same property + same camera path = reuse cached frames from DigitalOcean Spaces.
> This avoids paying for the same 600 API calls on repeat generations.

---

## 11. PHASE 5B — Cesium Frame Generation (Upgrade Renderer)

### Goal
When Google Photorealistic 3D Tiles coverage is confirmed, use a headless
Cesium browser instance to render a true 3D aerial flyover.

### 11.1 Self-Hosted Cesium Render Page

```html
<!-- /worker/static/cesium-render.html -->
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

### 11.2 Cesium Flight Script

```javascript
// /worker/static/cesium-flight.js
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
    lon:     lerp(k0[1], k1[1], t),
    lat:     lerp(k0[2], k1[2], t),
    alt:     lerp(k0[3], k1[3], t),
    pitch:   lerp(k0[4], k1[4], t),
    heading: lerp(k0[5], k1[5], t),
  };
}

window.CESIUM_READY = true;

window.renderFrameAt = function(progress) {
  const cam = getCameraAt(progress);
  viewer.scene.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(cam.lon, cam.lat, cam.alt),
    orientation: {
      heading: Cesium.Math.toRadians(cam.heading),
      pitch:   Cesium.Math.toRadians(cam.pitch),
      roll:    0
    }
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

### 11.3 Puppeteer Frame Capture Worker

```typescript
// /worker/lib/cesiumRenderer.ts
import puppeteer from 'puppeteer';
import path      from 'path';
import fs        from 'fs';

const TOTAL_FRAMES = 600;
const FRAME_WIDTH  = 1280;
const FRAME_HEIGHT = 720;

export async function generateCesiumFrames(
  lat:       number,
  lon:       number,
  boundary:  object,
  outputDir: string
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

  await page.evaluateOnNewDocument((lat, lon, totalFrames) => {
    (window as any).RENDER_CONFIG = { lat, lon, totalFrames };
  }, lat, lon, TOTAL_FRAMES);

  await page.goto(
    `file://${path.resolve(__dirname, '../static/cesium-render.html')}`,
    { waitUntil: 'networkidle0', timeout: 60000 }
  );

  await page.waitForFunction(() => (window as any).CESIUM_READY === true, { timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000)); // allow tiles to load

  for (let i = 0; i < TOTAL_FRAMES; i++) {
    const progress = i / (TOTAL_FRAMES - 1);
    await page.evaluate((p) => (window as any).renderFrameAt(p), progress);

    // Get pixel coordinates of boundary for this frame
    const pixelPoints = await page.evaluate(
      (b) => (window as any).projectBoundary(b),
      boundary
    );

    await new Promise(r => setTimeout(r, 50));

    const framePath = path.join(outputDir, `frame_${String(i).padStart(4, '0')}.png`);
    await page.screenshot({ path: framePath, type: 'png' });

    // Store pixel points for boundary overlay step
    fs.writeFileSync(
      path.join(outputDir, `boundary_${String(i).padStart(4, '0')}.json`),
      JSON.stringify(pixelPoints)
    );
  }

  await browser.close();
}
```

> **Performance note:** Headless Cesium rendering takes 5–15 minutes per video
> on a standard Droplet. A GPU-enabled Droplet reduces this to 1–3 minutes.
> If render time becomes a complaint, the agent must stop and present options.

---

## 12. PHASE 5C — Post-Processing Pipeline (MANDATORY)

Applies to every video regardless of renderer used.

### 12.1 Step 1 — AI Upscaling (Mapbox frames only)

```bash
pip install realesrgan --break-system-packages

python3 -c "
from realesrgan import RealESRGANer
from basicsr.archs.rrdbnet_arch import RRDBNet
import cv2, glob

model     = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32, scale=2)
upsampler = RealESRGANer(scale=2, model_path='RealESRGAN_x2plus.pth', model=model,
                         tile=0, tile_pad=10, pre_pad=0, half=False)

for f in sorted(glob.glob('/tmp/job/frames/*.png')):
    img, _ = upsampler.enhance(cv2.imread(f, cv2.IMREAD_UNCHANGED), outscale=2)
    cv2.imwrite(f, img)
print('Upscaling complete')
"
```

> Cesium frames are already rendered at 1920x1080 — skip upscaling for those.

### ⚠️ CLARIFICATION REQUIRED — Color Grading Method

Before implementing Step 2, the agent must ask:

> "Which color grading approach should be used in the post-processing pipeline?"

| Option | Description | Why Consider It |
|---|---|---|
| A | Supply a .cube LUT file from a royalty-free source | Best quality. Produces the most cinematic result. Requires you to download a .cube file from a source like freeluts.com or rocketstock.com and place it at `/assets/luts/cinematic_warm.cube` before this step can run. |
| B | Use FFmpeg color curves (no external file needed) | Simpler to implement immediately. No file to supply. Slightly less fine-grained control than a LUT but produces a good warm cinematic grade without any external dependency. Recommended if you want to move fast. |

**Do not implement Step 2 until this choice is made.**

### 12.2 Step 2 — Color Grading

**If Option A (LUT):**
```bash
ffmpeg -i base.mp4 \
  -vf "lut3d=/assets/luts/cinematic_warm.cube" \
  graded.mp4
```

**If Option B (FFmpeg curves):**
```bash
ffmpeg -i base.mp4 \
  -vf "curves=r='0/0 0.5/0.6 1/1':g='0/0 0.5/0.52 1/0.95':b='0/0.05 0.5/0.45 1/0.85'" \
  graded.mp4
```

### 12.3 Step 3 — Vignette

```bash
ffmpeg -i graded.mp4 -vf "vignette=PI/4" vignetted.mp4
```

### 12.4 Step 4 — Motion Blur

```bash
ffmpeg -i vignetted.mp4 -vf "tmix=frames=3:weights='1 2 1'" motion_blur.mp4
```

### 12.5 Step 5 — Film Grain

```bash
ffmpeg -i motion_blur.mp4 -vf "noise=alls=8:allf=t+u" grain.mp4
```

### 12.6 Step 6 — Frame Interpolation (Mapbox only)

Only run if frames were generated at 15 FPS to save API cost:

```bash
ffmpeg -i grain.mp4 \
  -vf "minterpolate=fps=30:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1" \
  smooth_30fps.mp4
```

### 12.7 Step 7 — Final Encode at 1920x1080

```bash
ffmpeg -i smooth_30fps.mp4 \
  -vf "scale=1920:1080:flags=lanczos,format=yuv420p" \
  -c:v libx264 -crf 18 -preset slow \
  -movflags +faststart \
  post_processed.mp4
```

---

## 13. PHASE 6 — Boundary Overlay Per Frame

### 13.1 Mapbox Path — Flat Reprojection

```typescript
// /worker/lib/overlay.ts
import SphericalMercator from '@mapbox/sphericalmercator';

const FRAME_WIDTH  = 1280;
const FRAME_HEIGHT = 720;
const merc = new SphericalMercator({ size: 256 });

function projectCoord(
  lng: number, lat: number,
  cameraLng: number, cameraLat: number,
  zoom: number
): [number, number] {
  const [x,  y]  = merc.px([lng, lat], zoom);
  const [cx, cy] = merc.px([cameraLng, cameraLat], zoom);
  return [
    Math.round(x - cx + FRAME_WIDTH  / 2),
    Math.round(y - cy + FRAME_HEIGHT / 2)
  ];
}

export function projectBoundaryFlat(boundary, camera): [number, number][] {
  return boundary.coordinates[0].map(([lng, lat]) =>
    projectCoord(lng, lat, camera.lon, camera.lat, camera.zoom)
  );
}
```

### 13.2 Cesium Path — Canvas Coordinates

Already handled inside `cesium-flight.js` via `window.projectBoundary`.
Pixel coordinates are written per-frame to `boundary_XXXX.json` files
by the Puppeteer capture worker (Phase 11.3 above).

### 13.3 Draw Boundary on Frame (Python — both paths)

```python
# /worker/python/draw_boundary.py
import cv2
import numpy as np
import json
import sys

image_path  = sys.argv[1]
points_json = sys.argv[2]
output_path = sys.argv[3]

image  = cv2.imread(image_path)
points = json.loads(points_json)
pts    = np.array(points, np.int32).reshape((-1, 1, 2))

# 40% opacity fill
overlay = image.copy()
cv2.fillPoly(overlay, [pts], (0, 255, 0))
cv2.addWeighted(overlay, 0.4, image, 0.6, 0, image)

# Solid 3px outline
cv2.polylines(image, [pts], True, (0, 255, 0), 3)

cv2.imwrite(output_path, image)
```

### ⚠️ CLARIFICATION REQUIRED — Boundary Line Style

> "How should the property boundary look in the video?"

| Option | Description | Why Consider It |
|---|---|---|
| A | Solid green line with 40% filled interior (current default) | Clean and clearly visible from altitude. No additional rendering complexity. Works on both Mapbox and Cesium frames. Easiest to implement. |
| B | Solid green outline only, no fill | Less visually dominant. Better for large properties where a fill would obscure most of the land. Still clearly marks the boundary. |
| C | Solid line with a glow/bloom effect applied in post-processing | Most visually polished. Makes the boundary look more like a professional overlay. Adds one additional FFmpeg filter pass. Slightly longer render time. |

**Do not proceed until one option is chosen.**

---

## 14. PHASE 7 — Video Assembly

```bash
# 1. Compile frames to base video
ffmpeg -framerate 30 -i frame_%04d.png \
  -vf "format=yuv420p" base.mp4

# 2. Run post-processing (Phase 12 — chained)
ffmpeg -i base.mp4 \
  -vf "[color grading filter],vignette=PI/4,tmix=frames=3:weights='1 2 1',noise=alls=8:allf=t+u,scale=1920:1080:flags=lanczos,format=yuv420p" \
  -c:v libx264 -crf 18 -preset slow -movflags +faststart \
  post_processed.mp4

# 3. Add watermark
ffmpeg -i post_processed.mp4 -i logo.png \
  -filter_complex "[1:v]scale=150:-1[logo];[0:v][logo]overlay=W-w-20:H-h-20:format=auto" \
  watermarked.mp4

# 4. Convert branding screens to clips
ffmpeg -loop 1 -i intro.png -t 3  -vf "scale=1920:1080,format=yuv420p" -r 30 intro_clip.mp4
ffmpeg -loop 1 -i outro.png -t 5  -vf "scale=1920:1080,format=yuv420p" -r 30 outro_clip.mp4

# 5. Concatenate
ffmpeg -f concat -safe 0 -i list.txt -c copy combined.mp4

# 6. Add music
ffmpeg -i combined.mp4 -i /assets/music/default.mp3 \
  -shortest -c:v copy -c:a aac combined_audio.mp4

# 7. Embed agent metadata in MP4 file
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
| A | Include a royalty-free track you supply as an MP3 file placed at `/assets/music/default.mp3` | Adds production quality to every video with no agent effort required. You must own the rights to the track or use a properly licensed royalty-free source. |
| B | Allow agents to upload their own track per video via the generate page | Gives agents full control over music. More work to build — requires a file upload field on the generate page and temporary storage of the audio file. |
| C | No music — video is silent by default | Simplest to implement. Agents can add music themselves after downloading if they choose. Some markets prefer silent property videos. |

**Do not proceed past Step 6 of video assembly until one option is chosen.**

---

## 15. PHASE 8 — Agent Profile System

### 15.1 Agent Table Already Exists

The `agents` table was created in Phase 0. Do not re-create it.
The application only inserts and updates rows — it never alters the schema.

### 15.2 Sync Agent to Database on First Login

```typescript
// /app/api/agent/sync/route.ts
import { auth } from '@clerk/nextjs/server';
import { pool } from '@/lib/db';

export async function POST() {
  const { userId } = auth();
  if (!userId) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });

  await pool.query(
    `INSERT INTO agents (id, clerk_user_id)
     VALUES (gen_random_uuid(), $1)
     ON CONFLICT (clerk_user_id) DO NOTHING`,
    [userId]
  );
  return Response.json({ ok: true });
}
```

Call this from the frontend immediately after login:

```typescript
// /app/dashboard/layout.tsx
'use client';
import { useEffect } from 'react';

export default function DashboardLayout({ children }) {
  useEffect(() => {
    fetch('/api/agent/sync', { method: 'POST' });
  }, []);
  return <>{children}</>;
}
```

### 15.3 Logo + Headshot Upload (Frontend)

```tsx
// /app/dashboard/profile/page.tsx
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
      <label>Logo:    <input type="file" accept="image/png,image/jpeg" onChange={e => setLogoFile(e.target.files?.[0]     || null)} /></label>
      <label>Headshot:<input type="file" accept="image/png,image/jpeg" onChange={e => setHeadshotFile(e.target.files?.[0] || null)} /></label>
      <button onClick={save}>Save Profile</button>
    </div>
  );
}
```

### 15.4 Upload to DigitalOcean Spaces (Backend)

```typescript
// /app/api/agent/update/route.ts
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { auth } from '@clerk/nextjs/server';
import { pool } from '@/lib/db';

const s3 = new S3Client({
  region:   'nyc3',
  endpoint: 'https://nyc3.digitaloceanspaces.com',
  credentials: {
    accessKeyId:     process.env.DO_SPACES_KEY!,
    secretAccessKey: process.env.DO_SPACES_SECRET!
  }
});

async function uploadAsset(file: File, agentId: string, type: 'logo' | 'headshot'): Promise<string> {
  const ext    = file.name.split('.').pop();
  const key    = `agents/${agentId}/${type}.${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  await s3.send(new PutObjectCommand({
    Bucket:      process.env.DO_SPACES_BUCKET!,
    Key:         key,
    Body:        buffer,
    ACL:         'public-read',
    ContentType: file.type
  }));
  return `https://${process.env.DO_SPACES_BUCKET}.nyc3.digitaloceanspaces.com/${key}`;
}
```

---

## 16. PHASE 9 — Branding Injection

### 16.1 Video Structure (Locked)

```
0s – 3s      Intro screen  (logo + agent name + company + tagline)
3s – 17s+    Aerial video  (boundary overlay + corner watermark logo)
Last 5s      Outro screen  (headshot + name + phone + email + license + CTA)
```

Minimum total: **20 seconds**. Aerial segment minimum: **12 seconds**.

### 16.2 All Agent Identity Markers Required

| Marker | Location | Purpose |
|---|---|---|
| Logo | Intro (centered) + watermark (full video, bottom-right) | Primary brand identity |
| Agent name | Intro + Outro | Personal attribution |
| Company / brokerage | Intro + Outro | Business attribution |
| License number | Outro (small text) | Legal identity |
| Phone | Outro | Contact |
| Email | Outro | Contact |
| Website | Outro | Contact |
| Tagline | Intro (below name) | Marketing |
| Headshot | Outro (if uploaded) | Personal branding |
| MP4 metadata tags | File metadata | Machine-readable attribution |

### 16.3 Intro + Outro Image Generation

```typescript
// /worker/lib/branding.ts
import { createCanvas, loadImage } from 'canvas';
import fs from 'fs';

export async function generateIntroImage(agent, outputPath: string) {
  const canvas = createCanvas(1920, 1080);
  const ctx    = canvas.getContext('2d');

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, 1920, 1080);

  if (agent.logo_url) {
    const logo  = await loadImage(agent.logo_url);
    const scale = Math.min(400 / logo.width, 250 / logo.height);
    ctx.drawImage(logo, (1920 - logo.width * scale) / 2, 200, logo.width * scale, logo.height * scale);
  }

  ctx.fillStyle = '#FFFFFF';
  ctx.font      = 'bold 72px Arial';
  ctx.textAlign = 'center';
  ctx.fillText(agent.name    || '', 960, 580);

  ctx.fillStyle = agent.brand_color || '#00FF00';
  ctx.font      = '48px Arial';
  ctx.fillText(agent.company || '', 960, 650);

  ctx.fillStyle = '#CCCCCC';
  ctx.font      = 'italic 36px Arial';
  ctx.fillText(agent.tagline || '', 960, 720);

  fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
}

export async function generateOutroImage(agent, outputPath: string) {
  const canvas = createCanvas(1920, 1080);
  const ctx    = canvas.getContext('2d');

  ctx.fillStyle = '#111111';
  ctx.fillRect(0, 0, 1920, 1080);

  if (agent.headshot_url) {
    const headshot = await loadImage(agent.headshot_url);
    ctx.save();
    ctx.beginPath();
    ctx.arc(300, 540, 220, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(headshot, 80, 320, 440, 440);
    ctx.restore();
  }

  const startX = agent.headshot_url ? 700 : 200;
  ctx.textAlign = 'left';

  ctx.fillStyle = '#FFFFFF';
  ctx.font      = 'bold 64px Arial';
  ctx.fillText(agent.name    || '', startX, 300);

  ctx.fillStyle = agent.brand_color || '#00FF00';
  ctx.font      = 'bold 40px Arial';
  ctx.fillText(agent.company || '', startX, 380);

  ctx.fillStyle = '#CCCCCC';
  ctx.font      = '36px Arial';
  [agent.phone, agent.email, agent.website,
   agent.license_number ? `License: ${agent.license_number}` : null]
    .filter(Boolean)
    .forEach((line, i) => ctx.fillText(line as string, startX, 460 + i * 55));

  ctx.fillStyle = '#FFFFFF';
  ctx.font      = 'bold 52px Arial';
  ctx.textAlign = 'center';
  ctx.fillText('Call Now for a Viewing', 960, 900);

  fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
}
```

---

## 17. PHASE 10 — Full Worker Pipeline

```typescript
// /worker/jobs/generateVideo.ts
import fs   from 'fs';
import path from 'path';
import { exec as execCb } from 'child_process';
import { promisify }      from 'util';

const exec = promisify(execCb);

export async function generateVideoJob(job) {
  const { valuationNumber, agentId, customBoundary } = job.data;
  const jobDir    = `/tmp/job_${job.id}`;
  const framesDir = `${jobDir}/frames`;
  await fs.promises.mkdir(framesDir, { recursive: true });

  // 1. Load property
  const property = await getProperty(valuationNumber);
  if (!property) throw new Error('PROPERTY_NOT_FOUND');

  // 2. Load agent
  const agent = await getAgent(agentId);
  if (!agent || agent.subscription_status !== 'active') throw new Error('SUBSCRIPTION_REQUIRED');

  // 3. Resolve boundary
  const boundary = customBoundary
    || property.boundary_geojson            // Real NLA polygon (most properties)
    || generateBoundingBox(property.latitude, property.longitude); // Fallback

  // 4. Select renderer
  const renderer = await selectRenderer(property);
  await updateJobStatus(job.id, `processing:frames:${renderer}`);

  // 5. Generate frames
  if (renderer === 'cesium') {
    await generateCesiumFrames(property.latitude, property.longitude, boundary, framesDir);
  } else {
    await generateMapboxFrames(property, framesDir);
    // Overlay boundary (Mapbox — flat reprojection per frame)
    await overlayBoundaryMapbox(framesDir, boundary, property);
  }

  // 6. Compile frames to base video
  await updateJobStatus(job.id, 'processing:video');
  await exec(`ffmpeg -framerate 30 -i ${framesDir}/frame_%04d.png -vf "format=yuv420p" ${jobDir}/base.mp4`);

  // 7. Post-processing (mandatory)
  await updateJobStatus(job.id, 'processing:postprocess');
  await runPostProcessing(jobDir, renderer);

  // 8. Add watermark
  await exec(
    `ffmpeg -i ${jobDir}/post_processed.mp4 -i ${agent.logo_path} ` +
    `-filter_complex "[1:v]scale=150:-1[logo];[0:v][logo]overlay=W-w-20:H-h-20" ` +
    `${jobDir}/watermarked.mp4`
  );

  // 9. Generate branding screens
  await updateJobStatus(job.id, 'processing:branding');
  await generateIntroImage(agent, `${jobDir}/intro.png`);
  await generateOutroImage(agent, `${jobDir}/outro.png`);
  await exec(`ffmpeg -loop 1 -i ${jobDir}/intro.png -t 3 -vf "scale=1920:1080,format=yuv420p" -r 30 ${jobDir}/intro_clip.mp4`);
  await exec(`ffmpeg -loop 1 -i ${jobDir}/outro.png -t 5 -vf "scale=1920:1080,format=yuv420p" -r 30 ${jobDir}/outro_clip.mp4`);

  // 10. Concatenate
  fs.writeFileSync(`${jobDir}/list.txt`,
    `file '${jobDir}/intro_clip.mp4'\nfile '${jobDir}/watermarked.mp4'\nfile '${jobDir}/outro_clip.mp4'`
  );
  await exec(`ffmpeg -f concat -safe 0 -i ${jobDir}/list.txt -c copy ${jobDir}/combined.mp4`);

  // 11. Add music
  await exec(
    `ffmpeg -i ${jobDir}/combined.mp4 -i /assets/music/default.mp3 ` +
    `-shortest -c:v copy -c:a aac ${jobDir}/with_audio.mp4`
  );

  // 12. Embed metadata
  await exec(
    `ffmpeg -i ${jobDir}/with_audio.mp4 ` +
    `-metadata agent_id="${agent.id}" ` +
    `-metadata agent_name="${agent.name}" ` +
    `-metadata license="${agent.license_number}" ` +
    `-metadata generated_by="PropertyVideoSaaS" ` +
    `-c copy ${jobDir}/final.mp4`
  );

  // 13. Upload to DigitalOcean Spaces
  await updateJobStatus(job.id, 'processing:upload');
  const url = await uploadVideo(`${jobDir}/final.mp4`, job.id);

  // 14. Mark complete and clean up
  await updateJob(job.id, { status: 'complete', output_url: url });
  await fs.promises.rm(jobDir, { recursive: true });

  return url;
}
```

---

## 18. PHASE 11 — Frontend UI

### 18.1 Page Structure

```
/                       Landing page + login
/dashboard              Agent home (recent videos, usage meter, renderer badge)
/dashboard/generate     Valuation input + map preview + generate button
/dashboard/profile      Agent credentials + logo/headshot upload
/dashboard/subscribe    Subscription management
```

### 18.2 Map Preview + Boundary Editor

```tsx
// /components/MapEditor.tsx
'use client';
import Map, { Source, Layer } from 'react-map-gl';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import { useRef, useEffect } from 'react';
import { generateBoundingBox } from '@/lib/boundary';

export default function MapEditor({ property, onBoundaryChange }) {
  const mapRef = useRef(null);

  useEffect(() => {
    if (!mapRef.current) return;
    const draw = new MapboxDraw({
      displayControlsDefault: false,
      controls: { polygon: true, trash: true }
    });
    mapRef.current.addControl(draw);

    // Use real NLA boundary if available, bounding box otherwise
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
    <Map
      ref={mapRef}
      initialViewState={{ longitude: property.longitude, latitude: property.latitude, zoom: 16 }}
      style={{ width: '100%', height: 500 }}
      mapStyle="mapbox://styles/mapbox/satellite-v9"
      mapboxAccessToken={process.env.NEXT_PUBLIC_MAPBOX_TOKEN}
    />
  );
}
```

### 18.3 Generate Page

```tsx
// /app/dashboard/generate/page.tsx
'use client';
import { useState }  from 'react';
import useSWR        from 'swr';
import MapEditor     from '@/components/MapEditor';

const fetcher = (url: string) => fetch(url).then(r => r.json());

export default function GeneratePage() {
  const [valuation, setValuation] = useState('');
  const [property,  setProperty]  = useState(null);
  const [boundary,  setBoundary]  = useState(null);
  const [jobId,     setJobId]     = useState(null);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState('');

  const { data: status } = useSWR(
    jobId ? `/api/status/${jobId}` : null,
    fetcher,
    { refreshInterval: 2000 }
  );

  async function fetchProperty() {
    setError('');
    const res  = await fetch(`/api/property/${valuation.trim()}`);
    const data = await res.json();
    if (!res.ok) { setError(data.error || 'Property not found.'); return; }
    setProperty(data);
    setBoundary(data.boundary_geojson); // Pre-populate with real NLA boundary
  }

  async function generateVideo() {
    setLoading(true);
    const res  = await fetch('/api/generate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        valuationNumber: property.valuation_number,
        boundary        // Agent-adjusted or NLA original
      })
    });
    const data = await res.json();
    if (data.error) { setError(data.error); setLoading(false); return; }
    setJobId(data.jobId);
    setLoading(false);
  }

  return (
    <div>
      <input
        value={valuation}
        onChange={e => setValuation(e.target.value)}
        placeholder="Enter valuation number or folio number"
      />
      <button onClick={fetchProperty}>Load Property</button>

      {error && <p style={{ color: 'red' }}>{error}</p>}

      {property && (
        <>
          <p>{property.street_address || property.scheme_address}, {property.parish}</p>
          <p style={{ color: '#888' }}>
            Preview — adjust boundary if needed before generating.
            {property.has_boundary
              ? ' Showing real NLA property boundary.'
              : ' No boundary data — showing approximate bounding box.'}
          </p>
          <MapEditor property={property} onBoundaryChange={setBoundary} />
          <button
            onClick={generateVideo}
            disabled={loading || status?.status === 'processing'}
          >
            {loading ? 'Submitting...' : 'Generate Video'}
          </button>
        </>
      )}

      {status?.status === 'processing' && <p>Generating video — this takes 2–15 minutes...</p>}
      {status?.status === 'complete'   && <a href={`/api/download/${jobId}`} download>Download Your Video</a>}
      {status?.status === 'failed'     && <p>Generation failed. Please try again.</p>}
    </div>
  );
}
```

### 18.4 Renderer Badge

Show agents which renderer produced their video:

```tsx
{job.renderer === 'cesium'
  ? <span style={{ color: 'green' }}>3D Photorealistic</span>
  : <span style={{ color: 'blue'  }}>Satellite Aerial</span>
}
```

---

## 19. PHASE 12 — Auth (Clerk)

```bash
npm install @clerk/nextjs
```

```bash
# /app/.env.local
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_...
CLERK_SECRET_KEY=sk_...
```

```typescript
// /middleware.ts
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isProtected = createRouteMatcher([
  '/dashboard(.*)',
  '/api/generate',
  '/api/status(.*)',
  '/api/download(.*)',
  '/api/agent(.*)'
]);

export default clerkMiddleware((auth, req) => {
  if (isProtected(req)) auth().protect();
});

export const config = { matcher: ['/((?!_next|.*\\..*).*)'] };
```

```tsx
// /app/layout.tsx
import { ClerkProvider } from '@clerk/nextjs';

export default function RootLayout({ children }) {
  return (
    <ClerkProvider>
      <html><body>{children}</body></html>
    </ClerkProvider>
  );
}
```

---

## 20. PHASE 13 — Subscription (Stripe)

### 20.1 Plans

| Plan | Videos/Month | Renderer |
|---|---|---|
| Basic | 10 | Mapbox only |
| Pro | 50 | Cesium when available, else Mapbox |
| Enterprise | Unlimited (-1) | Cesium priority + dedicated worker |

### 20.2 Checkout

```typescript
// /app/api/subscribe/route.ts
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

### 20.3 Webhook

```typescript
// /app/api/webhook/stripe/route.ts
export async function POST(req: Request) {
  const event = stripe.webhooks.constructEvent(
    await req.text(),
    req.headers.get('stripe-signature')!,
    process.env.STRIPE_WEBHOOK_SECRET!
  );

  if (event.type === 'checkout.session.completed') {
    const userId = event.data.object.client_reference_id;
    const limit  = getPlanLimit(event.data.object.metadata?.plan);
    await pool.query(
      `UPDATE agents SET subscription_status = 'active', monthly_video_limit = $1 WHERE clerk_user_id = $2`,
      [limit, userId]
    );
  }

  if (event.type === 'customer.subscription.deleted') {
    const userId = event.data.object.metadata?.clerk_user_id;
    await pool.query(
      `UPDATE agents SET subscription_status = 'inactive' WHERE clerk_user_id = $1`,
      [userId]
    );
  }

  return new Response('ok');
}
```

---

## 21. PHASE 14 — Usage Limits

### 21.1 Reset Logic

```typescript
async function resetIfNeeded(agent) {
  const now        = new Date();
  const cycleStart = new Date(agent.billing_cycle_start);
  const diffDays   = (now.getTime() - cycleStart.getTime()) / (1000 * 60 * 60 * 24);
  if (diffDays >= 30) {
    await pool.query(
      `UPDATE agents SET videos_used = 0, billing_cycle_start = NOW() WHERE id = $1`,
      [agent.id]
    );
    return { ...agent, videos_used: 0 };
  }
  return agent;
}
```

### 21.2 Enforce Before Job Runs

```typescript
// /app/api/generate/route.ts
import { auth } from '@clerk/nextjs/server';
import { pool } from '@/lib/db';

export async function POST(req: Request) {
  const { userId }   = auth();
  if (!userId) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });

  const { valuationNumber, boundary } = await req.json();

  let agent = await getAgentByClerkId(userId);
  if (!agent) return Response.json({ error: 'AGENT_NOT_FOUND' }, { status: 404 });

  agent = await resetIfNeeded(agent);

  if (agent.subscription_status !== 'active')
    return Response.json({ error: 'SUBSCRIPTION_REQUIRED' }, { status: 403 });

  if (agent.monthly_video_limit !== -1 && agent.videos_used >= agent.monthly_video_limit)
    return Response.json({ error: 'LIMIT_REACHED' }, { status: 403 });

  // Increment BEFORE job runs — prevents abuse
  await pool.query(`UPDATE agents SET videos_used = videos_used + 1 WHERE id = $1`, [agent.id]);

  try {
    const job = await videoQueue.add('generate-video', {
      valuationNumber,
      agentId:        agent.id,
      customBoundary: boundary
    });
    return Response.json({ jobId: job.id });
  } catch (err) {
    // Refund usage on job creation failure
    await pool.query(
      `UPDATE agents SET videos_used = GREATEST(videos_used - 1, 0) WHERE id = $1`,
      [agent.id]
    );
    throw err;
  }
}
```

### 21.3 Refund on Worker Failure

```typescript
new Worker('video-generation', async (job) => {
  try {
    return await generateVideoJob(job);
  } catch (err) {
    await pool.query(
      `UPDATE agents SET videos_used = GREATEST(videos_used - 1, 0) WHERE id = $1`,
      [job.data.agentId]
    );
    throw err;
  }
});
```

---

## 22. PHASE 15 — Queue System

```bash
npm install bullmq ioredis
```

```typescript
// /lib/queue.ts
import { Queue } from 'bullmq';

export const videoQueue = new Queue('video-generation', {
  connection: {
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT!)
  }
});
```

Job status values written to the `jobs` table:

| Status | When Set |
|---|---|
| `queued` | On job creation |
| `processing` | When worker picks up the job |
| `complete` | When video is uploaded |
| `failed` | On unrecoverable error |

---

## 23. PHASE 16 — Error Handling

| Failure | Action |
|---|---|
| Property not found | Return 404, stop |
| Agent not found | Return 401 |
| Subscription inactive | Return 403 |
| Usage limit reached | Return 403 |
| Database connection failure | Log error, return 500, alert on-call |
| Cesium coverage probe fails | Log, set `cesium_coverage = false`, fall back to Mapbox |
| Cesium render crashes mid-job | Close browser, fall back to Mapbox, retry once |
| Mapbox API fails | Retry up to 3x with exponential backoff |
| No boundary in DB | Generate bounding box automatically — never block |
| Frame render fails | Skip frame, fill with nearest neighbour |
| Post-processing fails | Retry once; skip individual filter if retry fails |
| FFmpeg fails | Retry job once; mark failed on second failure |
| Upload fails | Retry 3x; mark job failed |
| Job fails after usage incremented | Decrement usage counter |

---

## 24. PHASE 17 — Deployment

| Service | Platform |
|---|---|
| Frontend (Next.js) | Vercel |
| API routes | Vercel (same app) |
| Worker service | DigitalOcean Droplet (Docker) |
| Redis | DigitalOcean Managed Redis |
| PostgreSQL | **Existing Phase 0 database** — no new database needed |
| Storage | DigitalOcean Spaces |

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

CMD ["node", "worker/index.js"]
```

### Required Environment Variables

```bash
# /app/.env.local (Next.js application)

# Database (Phase 0 — app_user via PgBouncer)
DATABASE_URL=postgresql://app_user:PASSWORD@HOST:25061/DATABASE?sslmode=require

# Mapbox
NEXT_PUBLIC_MAPBOX_TOKEN=pk_...
MAPBOX_TOKEN=pk_...

# Clerk
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_...
CLERK_SECRET_KEY=sk_...

# Stripe
STRIPE_SECRET_KEY=sk_...
STRIPE_PRICE_ID=price_...
STRIPE_WEBHOOK_SECRET=whsec_...

# DigitalOcean Spaces
DO_SPACES_KEY=...
DO_SPACES_SECRET=...
DO_SPACES_BUCKET=property-videos

# Redis
REDIS_HOST=...
REDIS_PORT=6379

# Google Maps (for Cesium coverage probe)
GOOGLE_MAPS_API_KEY=...

# App
NEXT_PUBLIC_BASE_URL=https://yourdomain.com
```

---

## 25. Folder Structure

```
/app
  /api
    /property/[id]/route.ts
    /generate/route.ts
    /status/[jobId]/route.ts
    /download/[jobId]/route.ts
    /agent
      /sync/route.ts
      /update/route.ts
      /usage/route.ts
    /subscribe/route.ts
    /webhook/stripe/route.ts
  /dashboard
    /layout.tsx          ← triggers agent sync on login
    /page.tsx
    /generate/page.tsx
    /profile/page.tsx
    /subscribe/page.tsx
  /page.tsx
  /layout.tsx
/components
  /MapEditor.tsx
/lib
  /db.ts                 ← connects to Phase 0 database
  /queue.ts
  /boundary.ts
  /property.ts
  /storage.ts
/worker
  /index.ts
  /jobs
    /generateVideo.ts
  /lib
    /rendererSelector.ts
    /mapboxRenderer.ts
    /cesiumRenderer.ts
    /postProcess.ts
    /overlay.ts
    /ffmpeg.ts
    /branding.ts
  /static
    /cesium-render.html
    /cesium-flight.js
  /python
    /draw_boundary.py
/assets
  /music
    /default.mp3         ← supply before deployment (if music option chosen)
  /luts
    /cinematic_warm.cube ← supply before deployment (if LUT option chosen)
/middleware.ts
```

---

## 26. Remaining Clarifications

The implementing agent must not proceed past the relevant phase
without receiving an answer to each of these.

### Clarification 1 — Boundary Line Style (Phase 13)
Must be answered before the boundary overlay is implemented.

### Clarification 2 — Background Music (Phase 14)
Must be answered before video assembly Step 6 is implemented.

### Clarification 3 — Color Grading Method (Phase 12)
Must be answered before post-processing Step 2 is implemented.

### Clarification 4 — Cesium Coverage Probe (Phase 9)
Only required if probe behaves unreliably during testing.

### Clarification 5 — Branding Color

> "Should the boundary overlay color and intro/outro accent color match each agent's personal brand color, or be fixed green for all agents?"

| Option | Description | Why Consider It |
|---|---|---|
| A | Fixed green (#00FF00) for all agents | Simplest to implement. Consistent across all videos. No additional per-job rendering logic. |
| B | Use each agent's `brand_color` field stored in the database | More personalized. Every agent's video matches their own brand identity. Adds one variable to the boundary drawing and canvas rendering code. |

### Clarification 6 — Free Tier

> "Should there be a free tier with watermarked videos, or is a paid subscription required from day one?"

| Option | Description | Why Consider It |
|---|---|---|
| A | Paid subscription required from day one | Simplest to build and enforce. No free tier logic or conditional watermarking needed. |
| B | Free tier with 2 videos per month, large watermark reading "DEMO – Subscribe to remove" | Allows agents to try the product before committing. Creates viral spread as demo videos circulate. Requires conditional watermark logic in the video pipeline. |

### Clarification 7 — Cesium Renderer by Subscription Plan

> "Should the Cesium 3D photorealistic renderer (when Google coverage exists) be available to all paying subscribers, or reserved for higher-tier plans?"

| Option | Description | Why Consider It |
|---|---|---|
| A | Available to all paying subscribers | Simpler. Best user experience across all plans. No plan-gating logic needed in the renderer selector. |
| B | Reserved for Pro and Enterprise plans | Creates a clear upgrade incentive. As Google expands Jamaica coverage, the value of higher plans increases automatically. Requires one additional check in the renderer selection logic. |

---

## 27. Build Order

| Phase | Feature | Depends On |
|---|---|---|
| — | Phase 0 database | **Already complete** |
| 6 | Database connection + verify | Phase 0 |
| 2 | Boundary resolution library | Phase 0 |
| 3 | Property resolver API | Phase 0, Phase 6 |
| 12 | Auth (Clerk) | Nothing |
| 4 | Renderer selection logic | Phase 0, Phase 6 |
| 5A | Mapbox frame generation | Phase 2, Phase 4 |
| 5B | Cesium headless renderer | Phase 4 |
| 5C | Post-processing pipeline | Phase 5A or 5B |
| 6 | Boundary overlay per frame | Phase 5A/5B |
| 7 | Video assembly (FFmpeg) | Phase 5C, Phase 6 |
| 8 | Agent profile + file upload | Phase 12 |
| 9 | Branding injection | Phase 7, Phase 8 |
| 10 | Full worker pipeline | All above |
| 13 | Subscription (Stripe) | Phase 12 |
| 14 | Usage limits | Phase 13 |
| 15 | Queue system | Phase 10 |
| 16 | Full frontend UI | All above |
| 17 | Deployment | All above |

---

## END OF PLAN v5