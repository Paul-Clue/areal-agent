# plan_v3.md — AI Property Video Generator (Complete, Gap-Filled, Implementation-Ready)

---

## 1. Core Objective (Definitive)

Build a subscription-based SaaS web application that:

1. Accepts a valuation number or folio number as input
2. Resolves that number to property geolocation data from a database
3. Fetches aerial/satellite imagery of the property from Mapbox (locked choice)
4. Converts that imagery into a synthetic cinematic aerial drone-style video (≥ 20 seconds, 1920x1080 Full HD)
5. Automatically overlays and tracks property boundary lines throughout the video
6. Injects agent branding (logo, credentials, contact info, and additional identity markers) at the start, end, and throughout the video
7. Ties every video permanently to the paying agent's account
8. Allows the agent to download the final branded video

> **Reality check (locked, no ambiguity):** This system produces SYNTHETIC aerial animation from map tile data — not footage from a real drone or UAV. If at any future point you decide to incorporate real licensed aerial video datasets or UAV capture services, a new planning phase will be required. For now: Mapbox satellite tiles → frame sequence → video. This is the only approach in scope.

---

## 2. Non-Negotiable Technical Constraints

- Map provider: **Mapbox** (satellite-v9 style, Static Images API)
- Output format: **MP4, H.264, 1920x1080, ≥ 20 seconds**
- Boundary tracking: **deterministic reprojection per frame** (no CV/ML tracking)
- Every pipeline step has a defined fallback
- Agent branding is injected automatically — agents cannot opt out
- Subscription must be active before any video is generated
- Agent ID is never taken from the frontend — always resolved server-side via Clerk

---

## 3. System Architecture

### Components

| Component | Technology |
|---|---|
| Frontend | Next.js (App Router), React, Mapbox GL JS, Tailwind CSS |
| Backend API | Next.js API Routes (Node.js) |
| Worker Service | Node.js + Python subprocess (FFmpeg, OpenCV/PIL) |
| Queue | BullMQ + Redis |
| Database | PostgreSQL + PostGIS |
| Storage | DigitalOcean Spaces (S3-compatible) |
| Auth | Clerk |
| Payments | Stripe |
| Deployment | Vercel (frontend) + DigitalOcean Droplet (workers) |

---

## 4. What the Agent MUST NOT Decide Alone

At every point listed below, the implementing agent MUST stop, present options with explanations, and wait for a choice before proceeding. This is mandatory — no autonomous decisions on these items.

The items requiring clarification are called out explicitly inside each phase below.

---

## 5. PHASE 1 — Database + Property Data Layer

### Goal
Resolve valuation number or folio number → latitude, longitude, boundary (if available).

---

### 5.1 Database Schema

```sql
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE properties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  valuation_number TEXT UNIQUE NOT NULL,
  folio_number TEXT,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  boundary_geojson JSONB,         -- nullable; fallback triggers if null
  centroid GEOGRAPHY(Point, 4326), -- computed on insert
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_valuation_number ON properties(valuation_number);
CREATE INDEX idx_folio_number ON properties(folio_number);
```

Populate `centroid` on insert:

```sql
UPDATE properties
SET centroid = ST_SetSRID(ST_MakePoint(longitude, latitude), 4326);
```

---

### 5.2 Property Data Ingestion

**Format: CSV bulk import (locked)**

Required columns:
```
valuation_number, latitude, longitude
```

Optional columns:
```
folio_number, boundary_geojson
```

Example row:
```
VAL-12345,18.0179,-76.8099,"{""type"":""Polygon"",""coordinates"":...}"
```

**Ingestion script (Node.js):**

```typescript
import fs from "fs";
import csv from "csv-parser";
import { Pool } from "pg";

const pool = new Pool();
const BATCH_SIZE = 500;

async function importCSV(filePath: string) {
  const rows = [];
  const stream = fs.createReadStream(filePath).pipe(csv());

  for await (const row of stream) {
    const { valuation_number, folio_number, latitude, longitude, boundary_geojson } = row;

    if (!valuation_number || !latitude || !longitude) continue;
    if (parseFloat(latitude) === 0 && parseFloat(longitude) === 0) continue;

    rows.push({
      valuation_number,
      folio_number: folio_number || null,
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      boundary_geojson: boundary_geojson ? JSON.parse(boundary_geojson) : null
    });

    if (rows.length >= BATCH_SIZE) {
      await insertBatch(rows.splice(0));
    }
  }

  if (rows.length) await insertBatch(rows);
}

async function insertBatch(rows) {
  for (const row of rows) {
    await pool.query(`
      INSERT INTO properties (valuation_number, folio_number, latitude, longitude, boundary_geojson, centroid)
      VALUES ($1, $2, $3, $4, $5, ST_SetSRID(ST_MakePoint($4, $3), 4326))
      ON CONFLICT (valuation_number) DO UPDATE SET
        latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude,
        boundary_geojson = EXCLUDED.boundary_geojson,
        centroid = EXCLUDED.centroid
    `, [row.valuation_number, row.folio_number, row.latitude, row.longitude, row.boundary_geojson ? JSON.stringify(row.boundary_geojson) : null]);
  }
}
```

---

### 5.3 Property Resolver API

```
GET /api/property/:valuationNumber
```

```typescript
export async function GET(req, { params }) {
  const res = await pool.query(
    `SELECT * FROM properties WHERE valuation_number = $1 OR folio_number = $1`,
    [params.valuationNumber]
  );
  if (!res.rows[0]) return Response.json({ error: "PROPERTY_NOT_FOUND" }, { status: 404 });
  return Response.json(res.rows[0]);
}
```

---

### ⚠️ CLARIFICATION REQUIRED — Property Data Source

**The agent must ask before proceeding if property data is not already available:**

> "Where will the initial property dataset come from? Please choose one:"

| Option | Description | Why Consider It |
|---|---|---|
| A | Bulk CSV upload from internal/client data | Fastest path to production. Fully controlled. Works even if government APIs are unavailable. |
| B | National Land Agency (NLA) or government land registry API | Most accurate and authoritative. Suitable if API access is available and stable. Higher setup complexity. |
| C | Hybrid — start with CSV, supplement via API for missing records | Best long-term strategy. More complex to build initially but avoids gaps. |

**Do not proceed until one option is chosen.**

---

## 6. PHASE 2 — Boundary Resolution

### Goal
Determine the property boundary polygon to overlay in the video.

---

### 6.1 Priority Logic (Locked)

```typescript
function resolveBoundary(property) {
  if (property.boundary_geojson) {
    return property.boundary_geojson;
  }
  return generateBoundingBox(property.latitude, property.longitude);
}
```

---

### 6.2 Bounding Box Fallback (Deterministic)

Default size: **80 meters** for zoom ≥ 16, **120 meters** for zoom < 16.

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
    type: "Polygon",
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

Output is always a valid GeoJSON Polygon. No exceptions.

---

## 7. PHASE 3 — Frame Generation Engine

### Goal
Generate a sequence of 600 frames (at 30 FPS = 20 seconds) simulating a cinematic aerial drone flyover using Mapbox Static Images API.

---

### 7.1 Camera Model (Locked)

| Parameter | Start | End |
|---|---|---|
| Zoom | 14 | 18 |
| Bearing | -20° | 0° |
| Pitch | 0 (not supported in static API) | — |
| FPS | 30 | — |
| Total Frames | 600 | — |

---

### 7.2 Motion Curve

```typescript
function easeOutExpo(t: number): number {
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

function getCameraAtFrame(i: number, totalFrames: number) {
  const t = i / (totalFrames - 1);
  const eased = easeOutExpo(t);
  return {
    zoom: 14 + (18 - 14) * eased,
    bearing: -20 + (0 - (-20)) * eased
  };
}
```

---

### 7.3 Mapbox Static Images API

**URL format:**
```
https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/{lon},{lat},{zoom},{bearing},0/{width}x{height}?access_token={TOKEN}
```

**Frame fetch (Node.js):**
```typescript
import fetch from "node-fetch";
import fs from "fs";
import path from "path";

async function fetchFrame(i: number, lat: number, lon: number, zoom: number, bearing: number, outputDir: string) {
  const url = `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/${lon},${lat},${zoom.toFixed(4)},${bearing.toFixed(2)},0/1280x720?access_token=${process.env.MAPBOX_TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Mapbox fetch failed: ${res.status}`);
  const buffer = await res.buffer();
  fs.writeFileSync(path.join(outputDir, `frame_${String(i).padStart(4, "0")}.png`), buffer);
}
```

---

### 7.4 Concurrency + Cost Control

```typescript
import pLimit from "p-limit";
const limit = pLimit(5); // max 5 concurrent Mapbox requests

async function generateAllFrames(property, outputDir) {
  const tasks = [];
  for (let i = 0; i < 600; i++) {
    const camera = getCameraAtFrame(i, 600);
    tasks.push(limit(() => fetchFrame(i, property.latitude, property.longitude, camera.zoom, camera.bearing, outputDir)));
  }
  await Promise.all(tasks);
}
```

> **Cost note:** 600 Mapbox static image requests per video. At scale, implement frame caching keyed by `(lat, lon, zoom, bearing)` rounded to 4 decimal places. Same property + same camera path = reuse cached frames. Cache stored in DigitalOcean Spaces.

---

## 8. PHASE 4 — Boundary Overlay (Per-Frame Reprojection)

### Goal
Draw the property boundary polygon on every frame by reprojecting GeoJSON coordinates into pixel space for each camera position.

**No computer vision tracking is used. Boundaries are mathematically reprojected every frame. This is deterministic.**

---

### 8.1 Projection Math

```typescript
import SphericalMercator from "@mapbox/sphericalmercator";

const FRAME_WIDTH = 1280;
const FRAME_HEIGHT = 720;
const merc = new SphericalMercator({ size: 256 });

function projectCoord(lng: number, lat: number, cameraLng: number, cameraLat: number, zoom: number): [number, number] {
  const [x, y] = merc.px([lng, lat], zoom);
  const [cx, cy] = merc.px([cameraLng, cameraLat], zoom);
  return [
    Math.round(x - cx + FRAME_WIDTH / 2),
    Math.round(y - cy + FRAME_HEIGHT / 2)
  ];
}

function projectBoundary(boundary, camera): [number, number][] {
  return boundary.coordinates[0].map(([lng, lat]) =>
    projectCoord(lng, lat, camera.lon, camera.lat, camera.zoom)
  );
}
```

---

### 8.2 Draw Polygon on Frame (Python worker)

```python
import cv2
import numpy as np

def draw_boundary(image_path, points, output_path):
    image = cv2.imread(image_path)
    pts = np.array(points, np.int32).reshape((-1, 1, 2))

    # Fill (40% opacity green)
    overlay = image.copy()
    cv2.fillPoly(overlay, [pts], (0, 255, 0))
    cv2.addWeighted(overlay, 0.4, image, 0.6, 0, image)

    # Outline (solid, 3px)
    cv2.polylines(image, [pts], True, (0, 255, 0), 3)

    cv2.imwrite(output_path, image)
```

---

## 9. PHASE 5 — Agent Branding System

This is a core revenue feature. Every video is permanently and visibly tied to the agent who generated it. Agents cannot remove or bypass branding.

---

### 9.1 Agent Database Schema

```sql
CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id TEXT UNIQUE NOT NULL,
  name TEXT,
  company TEXT,
  phone TEXT,
  email TEXT,
  license_number TEXT,           -- real estate license number
  brokerage TEXT,                -- brokerage firm name (may differ from company)
  logo_url TEXT,                 -- stored in DigitalOcean Spaces after upload
  headshot_url TEXT,             -- agent headshot photo (optional)
  brand_color TEXT DEFAULT '#00FF00',  -- agent's preferred highlight color
  tagline TEXT,                  -- short marketing tagline e.g. "Your Trusted Realtor"
  website TEXT,
  subscription_status TEXT DEFAULT 'inactive',
  monthly_video_limit INT DEFAULT 10,
  videos_used INT DEFAULT 0,
  billing_cycle_start TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);
```

---

### 9.2 Agent Identity Markers in Every Video

Every video must include ALL of the following. These tie the video to the agent permanently:

| Marker | Location in Video | Purpose |
|---|---|---|
| Logo (image) | Intro (centered, 0–3s) + watermark (bottom-right, full video) | Primary brand identity |
| Agent name | Intro screen, Outro screen | Personal attribution |
| Company / brokerage name | Intro screen, Outro screen | Business attribution |
| Real estate license number | Outro screen (small text) | Legal identity marker |
| Phone number | Outro screen | Contact |
| Email | Outro screen | Contact |
| Website | Outro screen | Contact |
| Tagline | Intro screen (below name) | Marketing |
| Agent headshot | Outro screen (optional, if uploaded) | Personal branding |
| Video metadata tag | Embedded in MP4 file metadata | Machine-readable attribution |
| Invisible hash watermark | Encoded in specific frames | Anti-tamper / abuse tracking |

---

### 9.3 Video Structure (Locked)

```
0s – 3s     Intro screen (logo + agent name + company + tagline)
3s – 15s    Aerial animation (boundary overlay + corner watermark)
15s – 20s+  Outro screen (headshot + name + phone + email + license + CTA)
```

Minimum total duration: **20 seconds**
Main aerial segment adjusts to hit that minimum (minimum 12 seconds of aerial content).

---

### 9.4 Logo Upload (Correct Implementation)

> **Gap from previous plan fixed:** The previous plan only collected a logo URL text field. This plan implements actual file upload.

**Frontend:**
```tsx
// /app/dashboard/profile/page.tsx
"use client";
import { useState } from "react";

export default function Profile() {
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [headshotFile, setHeadshotFile] = useState<File | null>(null);
  const [form, setForm] = useState({
    name: "", company: "", brokerage: "", phone: "",
    email: "", license_number: "", tagline: "", website: "",
    brand_color: "#00FF00"
  });

  async function save() {
    const data = new FormData();
    Object.entries(form).forEach(([k, v]) => data.append(k, v));
    if (logoFile) data.append("logo", logoFile);
    if (headshotFile) data.append("headshot", headshotFile);

    await fetch("/api/agent/update", { method: "POST", body: data });
    alert("Profile saved.");
  }

  return (
    <div>
      <input placeholder="Full Name" onChange={e => setForm({...form, name: e.target.value})} />
      <input placeholder="Company" onChange={e => setForm({...form, company: e.target.value})} />
      <input placeholder="Brokerage" onChange={e => setForm({...form, brokerage: e.target.value})} />
      <input placeholder="Phone" onChange={e => setForm({...form, phone: e.target.value})} />
      <input placeholder="Email" onChange={e => setForm({...form, email: e.target.value})} />
      <input placeholder="License Number" onChange={e => setForm({...form, license_number: e.target.value})} />
      <input placeholder="Tagline" onChange={e => setForm({...form, tagline: e.target.value})} />
      <input placeholder="Website" onChange={e => setForm({...form, website: e.target.value})} />
      <label>Logo: <input type="file" accept="image/png,image/jpeg" onChange={e => setLogoFile(e.target.files?.[0] || null)} /></label>
      <label>Headshot: <input type="file" accept="image/png,image/jpeg" onChange={e => setHeadshotFile(e.target.files?.[0] || null)} /></label>
      <button onClick={save}>Save Profile</button>
    </div>
  );
}
```

**Backend — upload to DigitalOcean Spaces:**
```typescript
// /api/agent/update
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({
  region: "nyc3",
  endpoint: "https://nyc3.digitaloceanspaces.com",
  credentials: {
    accessKeyId: process.env.DO_SPACES_KEY!,
    secretAccessKey: process.env.DO_SPACES_SECRET!
  }
});

async function uploadAsset(file: File, agentId: string, type: "logo" | "headshot"): Promise<string> {
  const ext = file.name.split(".").pop();
  const key = `agents/${agentId}/${type}.${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  await s3.send(new PutObjectCommand({
    Bucket: process.env.DO_SPACES_BUCKET!,
    Key: key,
    Body: buffer,
    ACL: "public-read",
    ContentType: file.type
  }));
  return `https://${process.env.DO_SPACES_BUCKET}.nyc3.digitaloceanspaces.com/${key}`;
}
```

---

### 9.5 Branding Injection via FFmpeg

**Step 1 — Generate intro image (Node canvas):**

```typescript
import { createCanvas, loadImage } from "canvas";

async function generateIntroImage(agent, outputPath: string) {
  const canvas = createCanvas(1920, 1080);
  const ctx = canvas.getContext("2d");

  // Background
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, 1920, 1080);

  // Logo (centered)
  if (agent.logo_url) {
    const logo = await loadImage(agent.logo_url);
    const maxW = 400, maxH = 250;
    const scale = Math.min(maxW / logo.width, maxH / logo.height);
    const w = logo.width * scale, h = logo.height * scale;
    ctx.drawImage(logo, (1920 - w) / 2, 200, w, h);
  }

  // Agent name
  ctx.fillStyle = "#FFFFFF";
  ctx.font = "bold 72px Arial";
  ctx.textAlign = "center";
  ctx.fillText(agent.name || "Agent", 960, 580);

  // Company
  ctx.font = "48px Arial";
  ctx.fillStyle = agent.brand_color || "#00FF00";
  ctx.fillText(agent.company || "", 960, 650);

  // Tagline
  ctx.font = "italic 36px Arial";
  ctx.fillStyle = "#CCCCCC";
  ctx.fillText(agent.tagline || "", 960, 720);

  const fs = await import("fs");
  fs.writeFileSync(outputPath, canvas.toBuffer("image/png"));
}
```

**Step 2 — Generate outro image:**

```typescript
async function generateOutroImage(agent, outputPath: string) {
  const canvas = createCanvas(1920, 1080);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#111111";
  ctx.fillRect(0, 0, 1920, 1080);

  // Headshot (left side, if available)
  if (agent.headshot_url) {
    const headshot = await loadImage(agent.headshot_url);
    ctx.save();
    ctx.beginPath();
    ctx.arc(300, 540, 220, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(headshot, 80, 320, 440, 440);
    ctx.restore();
  }

  // Contact info (right side)
  const startX = agent.headshot_url ? 700 : 200;
  ctx.textAlign = "left";

  ctx.fillStyle = "#FFFFFF";
  ctx.font = "bold 64px Arial";
  ctx.fillText(agent.name || "", startX, 300);

  ctx.fillStyle = agent.brand_color || "#00FF00";
  ctx.font = "bold 40px Arial";
  ctx.fillText(agent.company || "", startX, 380);

  ctx.fillStyle = "#CCCCCC";
  ctx.font = "36px Arial";
  const lines = [
    agent.phone, agent.email, agent.website,
    agent.license_number ? `License: ${agent.license_number}` : null
  ].filter(Boolean);
  lines.forEach((line, i) => ctx.fillText(line, startX, 460 + i * 55));

  // CTA
  ctx.fillStyle = "#FFFFFF";
  ctx.font = "bold 52px Arial";
  ctx.textAlign = "center";
  ctx.fillText("Call Now for a Viewing", 960, 900);

  const fs = await import("fs");
  fs.writeFileSync(outputPath, canvas.toBuffer("image/png"));
}
```

**Step 3 — FFmpeg watermark overlay (entire video):**

```bash
ffmpeg -i main_with_boundary.mp4 -i logo.png \
  -filter_complex "[1:v]scale=150:-1[logo];[0:v][logo]overlay=W-w-20:H-h-20:format=auto" \
  watermarked.mp4
```

**Step 4 — Convert intro/outro images to video clips:**

```bash
ffmpeg -loop 1 -i intro.png -t 3 -vf "scale=1920:1080,format=yuv420p" -r 30 intro_clip.mp4
ffmpeg -loop 1 -i outro.png -t 5 -vf "scale=1920:1080,format=yuv420p" -r 30 outro_clip.mp4
```

**Step 5 — Concatenate:**

```
# list.txt
file 'intro_clip.mp4'
file 'watermarked.mp4'
file 'outro_clip.mp4'
```

```bash
ffmpeg -f concat -safe 0 -i list.txt -c copy combined.mp4
```

**Step 6 — Add music:**

```bash
ffmpeg -i combined.mp4 -i /assets/music/default.mp3 \
  -shortest -c:v copy -c:a aac combined_audio.mp4
```

**Step 7 — Embed agent metadata into MP4:**

```bash
ffmpeg -i combined_audio.mp4 \
  -metadata agent_id="UUID" \
  -metadata agent_name="John Smith" \
  -metadata company="Smith Realty" \
  -metadata license="JAM-12345" \
  -metadata generated_by="PropertyVideoSaaS" \
  -c copy final.mp4
```

---

## 10. PHASE 6 — Video Assembly (Full Pipeline)

```typescript
export async function generateVideoJob(job) {
  const { valuationNumber, agentId, customBoundary } = job.data;

  // 1. Load property
  const property = await getProperty(valuationNumber);
  if (!property) throw new Error("PROPERTY_NOT_FOUND");

  // 2. Load agent
  const agent = await getAgent(agentId);
  if (!agent || agent.subscription_status !== "active") throw new Error("SUBSCRIPTION_REQUIRED");

  // 3. Resolve boundary
  const boundary = customBoundary || property.boundary_geojson || generateBoundingBox(property.latitude, property.longitude);

  // 4. Generate frames
  const framesDir = `/tmp/job_${job.id}/frames`;
  await fs.promises.mkdir(framesDir, { recursive: true });
  await generateAllFrames(property, framesDir);

  // 5. Overlay boundary on each frame
  await overlayBoundaryOnFrames(framesDir, boundary, property);

  // 6. Render base video from frames
  await exec(`ffmpeg -framerate 30 -i ${framesDir}/frame_%04d.png -vf "scale=1920:1080,format=yuv420p" /tmp/job_${job.id}/main.mp4`);

  // 7. Add watermark
  await exec(`ffmpeg -i /tmp/job_${job.id}/main.mp4 -i ${agent.logo_path} -filter_complex "[1:v]scale=150:-1[logo];[0:v][logo]overlay=W-w-20:H-h-20" /tmp/job_${job.id}/watermarked.mp4`);

  // 8. Generate branding screens
  await generateIntroImage(agent, `/tmp/job_${job.id}/intro.png`);
  await generateOutroImage(agent, `/tmp/job_${job.id}/outro.png`);
  await exec(`ffmpeg -loop 1 -i /tmp/job_${job.id}/intro.png -t 3 -vf "scale=1920:1080,format=yuv420p" -r 30 /tmp/job_${job.id}/intro_clip.mp4`);
  await exec(`ffmpeg -loop 1 -i /tmp/job_${job.id}/outro.png -t 5 -vf "scale=1920:1080,format=yuv420p" -r 30 /tmp/job_${job.id}/outro_clip.mp4`);

  // 9. Concatenate
  await writeConcatList(job.id);
  await exec(`ffmpeg -f concat -safe 0 -i /tmp/job_${job.id}/list.txt -c copy /tmp/job_${job.id}/combined.mp4`);

  // 10. Add music
  await exec(`ffmpeg -i /tmp/job_${job.id}/combined.mp4 -i /assets/music/default.mp3 -shortest -c:v copy -c:a aac /tmp/job_${job.id}/with_audio.mp4`);

  // 11. Embed metadata
  await exec(`ffmpeg -i /tmp/job_${job.id}/with_audio.mp4 -metadata agent_id="${agent.id}" -metadata agent_name="${agent.name}" -metadata license="${agent.license_number}" -metadata generated_by="PropertyVideoSaaS" -c copy /tmp/job_${job.id}/final.mp4`);

  // 12. Upload final video to storage
  const url = await uploadVideo(`/tmp/job_${job.id}/final.mp4`, job.id);

  // 13. Update job record
  await updateJob(job.id, { status: "complete", output_url: url });

  // 14. Clean up temp files
  await fs.promises.rm(`/tmp/job_${job.id}`, { recursive: true });

  return url;
}
```

---

## 11. PHASE 7 — Frontend UI

### 11.1 Page Structure

```
/                     → Landing + login
/dashboard            → Agent home (recent videos, usage meter)
/dashboard/generate   → Valuation input + map preview + generate button
/dashboard/profile    → Agent credentials + logo/headshot upload
/dashboard/subscribe  → Subscription management
```

---

### 11.2 Map Preview + Boundary Editor

```tsx
// /components/MapEditor.tsx
"use client";
import Map, { Source, Layer } from "react-map-gl";
import MapboxDraw from "@mapbox/mapbox-gl-draw";
import "@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css";
import { useRef, useEffect, useState } from "react";
import { generateBoundingBox } from "@/lib/boundary";

export default function MapEditor({ property, onBoundaryChange }) {
  const mapRef = useRef(null);
  const [draw, setDraw] = useState(null);

  useEffect(() => {
    if (!mapRef.current) return;
    const drawControl = new MapboxDraw({
      displayControlsDefault: false,
      controls: { polygon: true, trash: true }
    });
    mapRef.current.addControl(drawControl);
    const initialBoundary = property.boundary_geojson
      ? { type: "Feature", geometry: property.boundary_geojson }
      : generateBoundingBox(property.latitude, property.longitude);
    drawControl.add(initialBoundary);
    setDraw(drawControl);

    mapRef.current.on("draw.update", () => {
      const data = drawControl.getAll();
      if (data.features.length) onBoundaryChange(data.features[0].geometry);
    });
  }, []);

  return (
    <Map
      ref={mapRef}
      initialViewState={{ longitude: property.longitude, latitude: property.latitude, zoom: 16 }}
      style={{ width: "100%", height: 500 }}
      mapStyle="mapbox://styles/mapbox/satellite-v9"
      mapboxAccessToken={process.env.NEXT_PUBLIC_MAPBOX_TOKEN}
    />
  );
}
```

---

### 11.3 Generate Page

```tsx
// /app/dashboard/generate/page.tsx
"use client";
import { useState } from "react";
import useSWR from "swr";
import MapEditor from "@/components/MapEditor";

export default function GeneratePage() {
  const [valuation, setValuation] = useState("");
  const [property, setProperty] = useState(null);
  const [boundary, setBoundary] = useState(null);
  const [jobId, setJobId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const { data: status } = useSWR(
    jobId ? `/api/status/${jobId}` : null,
    url => fetch(url).then(r => r.json()),
    { refreshInterval: 2000 }
  );

  async function fetchProperty() {
    setError("");
    const res = await fetch(`/api/property/${valuation}`);
    if (!res.ok) { setError("Property not found."); return; }
    const data = await res.json();
    setProperty(data);
  }

  async function generateVideo() {
    setLoading(true);
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ valuationNumber: property.valuation_number, boundary })
    });
    const data = await res.json();
    if (data.error) { setError(data.error); setLoading(false); return; }
    setJobId(data.jobId);
    setLoading(false);
  }

  return (
    <div>
      <input value={valuation} onChange={e => setValuation(e.target.value)} placeholder="Enter valuation or folio number" />
      <button onClick={fetchProperty}>Load Property</button>
      {error && <p style={{ color: "red" }}>{error}</p>}

      {property && (
        <>
          <p>Preview — adjust boundary if needed before generating</p>
          <MapEditor property={property} onBoundaryChange={setBoundary} />
          <button onClick={generateVideo} disabled={loading || status?.status === "processing"}>
            {loading ? "Submitting..." : "Generate Video"}
          </button>
        </>
      )}

      {status?.status === "processing" && <p>Generating video... please wait.</p>}
      {status?.status === "complete" && (
        <a href={`/api/download/${jobId}`} download>Download Your Video</a>
      )}
      {status?.status === "failed" && <p>Video generation failed. Please try again.</p>}
    </div>
  );
}
```

---

## 12. PHASE 8 — Auth (Clerk)

### 12.1 Install + Configure

```bash
npm install @clerk/nextjs
```

`.env.local`:
```
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_...
CLERK_SECRET_KEY=sk_...
```

### 12.2 Middleware

```typescript
// /middleware.ts
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
const isProtected = createRouteMatcher(["/dashboard(.*)", "/api/generate", "/api/status(.*)", "/api/download(.*)", "/api/agent(.*)"]);
export default clerkMiddleware((auth, req) => { if (isProtected(req)) auth().protect(); });
export const config = { matcher: ["/((?!_next|.*\\..*).*)"] };
```

### 12.3 Sync Agent to DB on First Login

```typescript
// /api/agent/sync — call this from frontend useEffect after login
import { auth } from "@clerk/nextjs/server";
export async function POST() {
  const { userId } = auth();
  if (!userId) return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  await pool.query(`
    INSERT INTO agents (id, clerk_user_id) VALUES (gen_random_uuid(), $1)
    ON CONFLICT (clerk_user_id) DO NOTHING
  `, [userId]);
  return Response.json({ ok: true });
}
```

---

## 13. PHASE 9 — Subscription (Stripe)

### 13.1 Plans and Limits

| Plan | Videos/Month | Price |
|---|---|---|
| Basic | 10 | $X/month |
| Pro | 50 | $Y/month |
| Enterprise | Unlimited (-1) | $Z/month |

### 13.2 Checkout

```typescript
// /api/subscribe
import Stripe from "stripe";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function POST(req) {
  const { userId } = auth();
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    mode: "subscription",
    client_reference_id: userId,
    line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
    success_url: `${process.env.NEXT_PUBLIC_BASE_URL}/dashboard`,
    cancel_url: `${process.env.NEXT_PUBLIC_BASE_URL}/dashboard/subscribe`
  });
  return Response.json({ url: session.url });
}
```

### 13.3 Webhook — Activate Subscription

```typescript
// /api/webhook/stripe
export async function POST(req) {
  const sig = req.headers.get("stripe-signature")!;
  const body = await req.text();
  const event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!);

  if (event.type === "checkout.session.completed") {
    const userId = event.data.object.client_reference_id;
    const limit = getPlanLimit(event.data.object.metadata?.plan);
    await pool.query(`UPDATE agents SET subscription_status = 'active', monthly_video_limit = $1 WHERE clerk_user_id = $2`, [limit, userId]);
  }

  if (event.type === "customer.subscription.deleted") {
    const userId = event.data.object.metadata?.clerk_user_id;
    await pool.query(`UPDATE agents SET subscription_status = 'inactive' WHERE clerk_user_id = $1`, [userId]);
  }

  return new Response("ok");
}
```

---

## 14. PHASE 10 — Usage Limits

### 14.1 DB Fields (on agents table — already in schema above)
- `monthly_video_limit` (INT, default 10; -1 = unlimited)
- `videos_used` (INT, default 0)
- `billing_cycle_start` (TIMESTAMP)

### 14.2 Reset Logic

```typescript
async function resetIfNeeded(agent) {
  const now = new Date();
  const cycleStart = new Date(agent.billing_cycle_start);
  const diffDays = (now.getTime() - cycleStart.getTime()) / (1000 * 60 * 60 * 24);
  if (diffDays >= 30) {
    await pool.query(`UPDATE agents SET videos_used = 0, billing_cycle_start = NOW() WHERE id = $1`, [agent.id]);
    return { ...agent, videos_used: 0 };
  }
  return agent;
}
```

### 14.3 Enforce in API Before Job is Created

```typescript
// /api/generate
const { userId } = auth();
let agent = await getAgentByClerkId(userId);
agent = await resetIfNeeded(agent);

if (agent.subscription_status !== "active") {
  return Response.json({ error: "SUBSCRIPTION_REQUIRED" }, { status: 403 });
}
if (agent.monthly_video_limit !== -1 && agent.videos_used >= agent.monthly_video_limit) {
  return Response.json({ error: "LIMIT_REACHED" }, { status: 403 });
}

// Increment BEFORE job runs (prevents abuse)
await pool.query(`UPDATE agents SET videos_used = videos_used + 1 WHERE id = $1`, [agent.id]);

try {
  const job = await videoQueue.add("generate-video", { valuationNumber, agentId: agent.id, customBoundary: boundary });
  return Response.json({ jobId: job.id });
} catch (err) {
  // Refund usage if job creation fails
  await pool.query(`UPDATE agents SET videos_used = GREATEST(videos_used - 1, 0) WHERE id = $1`, [agent.id]);
  throw err;
}
```

### 14.4 Refund on Worker Failure

```typescript
new Worker("video-generation", async (job) => {
  try {
    return await generateVideoJob(job);
  } catch (err) {
    await pool.query(`UPDATE agents SET videos_used = GREATEST(videos_used - 1, 0) WHERE id = $1`, [job.data.agentId]);
    throw err;
  }
});
```

---

## 15. PHASE 11 — Queue System

### 15.1 Setup

```bash
npm install bullmq ioredis
```

### 15.2 Queue Definition

```typescript
// /lib/queue.ts
import { Queue } from "bullmq";
export const videoQueue = new Queue("video-generation", {
  connection: { host: process.env.REDIS_HOST, port: parseInt(process.env.REDIS_PORT!) }
});
```

### 15.3 Job Stages (Tracked in DB)

| Stage | Status Value |
|---|---|
| Queued | `queued` |
| Fetching frames | `processing` |
| Rendering video | `processing` |
| Adding branding | `processing` |
| Uploading | `processing` |
| Done | `complete` |
| Failed | `failed` |

### 15.4 Jobs Table

```sql
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  agent_id UUID REFERENCES agents(id),
  valuation_number TEXT,
  status TEXT DEFAULT 'queued',
  output_url TEXT,
  error TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);
```

---

## 16. PHASE 12 — Error Handling (Complete)

| Failure | Action |
|---|---|
| Property not found | Return 404, stop |
| Agent not found | Return 401 |
| Subscription inactive | Return 403 |
| Usage limit reached | Return 403 |
| Mapbox API fails | Retry up to 3x with exponential backoff |
| No boundary data | Auto-generate bounding box (never block) |
| Frame render fails | Skip that frame; fill with nearest neighbor |
| FFmpeg fails | Retry job once; mark failed on second failure |
| Upload fails | Retry 3x; mark job failed |
| Job fails after usage incremented | Decrement usage counter |

---

## 17. PHASE 13 — Deployment

| Service | Platform |
|---|---|
| Frontend (Next.js) | Vercel |
| API routes | Vercel (same app) |
| Worker service | DigitalOcean Droplet (Docker) |
| Redis | DigitalOcean Managed Redis |
| PostgreSQL | DigitalOcean Managed Database |
| Storage | DigitalOcean Spaces |

### Worker Dockerfile

```dockerfile
FROM node:20-slim
RUN apt-get update && apt-get install -y ffmpeg python3 python3-pip
RUN pip3 install opencv-python-headless numpy
WORKDIR /app
COPY . .
RUN npm install
CMD ["node", "worker/index.js"]
```

---

## 18. Folder Structure

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
    /page.tsx
    /generate/page.tsx
    /profile/page.tsx
    /subscribe/page.tsx
  /page.tsx
  /layout.tsx
/components
  /MapEditor.tsx
/lib
  /db.ts
  /queue.ts
  /boundary.ts
  /storage.ts
/worker
  /index.ts
  /jobs/generateVideo.ts
  /lib
    /mapbox.ts
    /overlay.ts        (calls Python)
    /ffmpeg.ts
    /branding.ts
  /python
    /draw_boundary.py
/middleware.ts
```

---

## 19. CLARIFICATIONS STILL REQUIRED

The implementing agent must not proceed past the relevant phase without receiving an answer to each of these:

### Clarification 1 — Property Data Source (Phase 1)
Documented in Phase 1 above. Must be answered before seeding data.

### Clarification 2 — Background Music

> "Should a default background music track be included in all videos? If so, who will supply it?"

| Option | Description |
|---|---|
| A | Include a royalty-free track that you supply (e.g., MP3 file you own) |
| B | Allow agents to upload their own track per video |
| C | No music by default; add as a future enhancement |

### Clarification 3 — Branding Color

> "Should the boundary overlay color and UI accent color match the agent's brand color, or should it be fixed green (#00FF00) for all agents?"

| Option | Description |
|---|---|
| A | Fixed green for all agents — simplest, consistent |
| B | Use each agent's brand_color field for the boundary and overlay — more personalized |

### Clarification 4 — Video Watermark on Free / Unpaid Tier

> "If you add a free tier in the future, should free videos have a large visible watermark?"

| Option | Description |
|---|---|
| A | Yes — large diagonal watermark, "DEMO – Subscribe to remove" |
| B | No free tier — subscription required from day one |

### Clarification 5 — Boundary Line Style

> "How should the boundary line look in the video?"

| Option | Description |
|---|---|
| A | Solid green line, 40% filled interior (current default) |
| B | Dashed/pulsing animated line, no fill |
| C | Solid line with a glow effect |

---

## 20. Build Order Summary

| Phase | Feature | Depends On |
|---|---|---|
| 1 | Property DB + CSV ingestion | Nothing |
| 2 | Boundary resolution | Phase 1 |
| 3 | Mapbox frame generation | Phase 2 |
| 4 | Boundary overlay per frame | Phase 3 |
| 5 | Basic video assembly (FFmpeg) | Phase 4 |
| 6 | Agent profile + logo upload | Nothing |
| 7 | Branding injection (intro/outro/watermark) | Phase 5 + 6 |
| 8 | Auth (Clerk) | Nothing |
| 9 | Subscription (Stripe) | Phase 8 |
| 10 | Usage limits | Phase 9 |
| 11 | Queue system | Phase 5 |
| 12 | Full frontend UI | All prior phases |
| 13 | Deployment | All prior phases |

---

## END OF PLAN v3