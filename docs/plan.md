# plan.md — AI Real Estate Video Generator with Boundary Tracking

## 1. Objective

Build a full-stack application that:

1. Accepts uploaded drone footage (video files)  
2. Accepts property boundary input (GeoJSON, shapefile, or manually drawn polygon)  
3. Tracks and overlays the boundary onto the video  
4. Automatically generates a cinematic real estate video by:
   - Cutting clips intelligently
   - Adding transitions
   - Syncing to user-uploaded music  
5. Outputs a final rendered video (MP4) suitable for marketing

The system MUST be deterministic and modular. No step should rely on ambiguous inference without defined fallback logic.

---

## 2. High-Level Architecture

### 2.1 System Components

- Frontend (Web App)
  - React (Next.js)
  - Map interface (Mapbox GL JS)
  - Video upload UI
  - Boundary drawing/editing UI

- Backend API
  - Node.js (Express or Next.js API routes)
  - Handles uploads, job orchestration, and storage

- Processing Pipeline (Worker Service)
  - Python (preferred for CV/ML tasks)
  - Runs:
    - Video processing
    - Object tracking
    - Overlay rendering
    - Video editing

- Storage
  - Object storage (S3-compatible, e.g., DigitalOcean Spaces)
  - Database (PostgreSQL)

- Queue System
  - Redis + BullMQ (or equivalent)

---

## 3. Functional Requirements

### 3.1 User Inputs

#### Required Inputs:
- video_file (MP4, MOV)
- boundary_polygon (GeoJSON format)

#### Optional Inputs:
- music_file (MP3/WAV)
- branding_assets (logo PNG, watermark)
- video_style (enum: cinematic, fast-paced, luxury)

---

## 4. Detailed Pipeline

## 4.1 Step 1 — Video Upload & Preprocessing

### Input:
- Raw drone video

### Processing:
1. Extract metadata using FFmpeg:
   - Resolution
   - FPS
   - Duration

2. Normalize video:
   - Convert to MP4 (H.264)
   - Standardize resolution to 1920x1080

### Tools:
- FFmpeg

---

## 4.2 Step 2 — Frame Extraction

### Process:
- Extract frames at fixed interval:
  - Default: 10 FPS

### Output:
- Frame sequence: /frames/frame_0001.jpg

### Command:
ffmpeg -i input.mp4 -vf fps=10 frames/frame_%04d.jpg

---

## 4.3 Step 3 — Camera Motion Estimation

### Goal:
Estimate camera movement to allow boundary tracking.

### Method:
- Use OpenCV optical flow (Lucas-Kanade)

### Steps:
1. Detect feature points:
      cv2.goodFeaturesToTrack()   

2. Track points across frames:
      cv2.calcOpticalFlowPyrLK()   

3. Estimate transformation matrix:
   - Affine transform per frame

### Output:
- Transformation matrices per frame

---

## 4.4 Step 4 — Boundary Projection

### Input:
- GeoJSON polygon
- Initial frame

### Assumption:
User aligns polygon manually on first frame via UI.

### Process:
1. Convert GeoJSON → pixel coordinates
2. Store initial polygon mask

---

## 4.5 Step 5 — Boundary Tracking

### Method:
Apply transformation matrices to polygon across frames.

### Algorithm:
For each frame:
new_polygon = apply_affine_transform(prev_polygon, matrix)

### Output:
- Polygon coordinates per frame

---

## 4.6 Step 6 — Overlay Rendering

### Process:
For each frame:

1. Draw polygon:
   - Color: #00FF00
   - Opacity: 40%
   - Border thickness: 3px

2. Optional:
   - Animate pulse effect

### Tool:
- OpenCV or PIL

---

## 4.7 Step 7 — Scene Detection

### Goal:
Split video into meaningful clips

### Method:
- Use histogram difference between frames

### Threshold:
- Scene cut if difference > 0.6

### Output:
- List of scenes with timestamps

---

## 4.8 Step 8 — Clip Selection

### Logic:
- Select top scenes based on:
  - Stability (low camera shake)
  - Motion smoothness

### Metric:
score = inverse(camera_motion_variance)

---

## 4.9 Step 9 — Music Sync

### Input:
- User-provided music

### Process:
1. Extract beat timestamps:
   - Use librosa

2. Align cuts to beats:
   - Snap scene transitions to nearest beat

---

## 4.10 Step 10 — Transitions

### Supported transitions:
- Fade (default)
- Cross dissolve
- Zoom-in

### Implementation:
- FFmpeg filters:
xfade=transition=fade:duration=1:offset=...

---

## 4.11 Step 11 — Final Video Assembly

### Process:
1. Recombine processed frames:
ffmpeg -framerate 30 -i frame_%04d.jpg output.mp4

2. Add audio:
ffmpeg -i video.mp4 -i audio.mp3 -shortest final.mp4

---

## 5. Frontend Requirements

### 5.1 Upload UI
- Drag-and-drop video upload
- Upload progress bar

### 5.2 Map Interface
- Display satellite map
- Draw/edit polygon
- Export GeoJSON

### 5.3 Video Preview
- Show processed preview
- Allow re-edit

---

## 6. Backend API

### Endpoints:

#### POST /upload
- Upload video

#### POST /boundary
- Save GeoJSON

#### POST /process
- Trigger processing job

#### GET /status/:jobId
- Return job status

#### GET /download/:jobId
- Download final video

---

## 7. Database Schema

### Table: jobs
- id
- status
- video_url
- output_url
- created_at

### Table: boundaries
- job_id
- geojson

---

## 8. Queue System

- Use BullMQ
- Job stages:
  1. preprocess
  2. tracking
  3. overlay
  4. editing
  5. rendering

---

## 9. Error Handling

- If tracking fails:
  - Fallback to static overlay

- If music missing:
  - Use default track

---

## 10. Performance Considerations

- Use GPU acceleration where possible
- Parallelize frame processing
- Cache intermediate outputs

---

## 11. Deployment

- Frontend: Vercel
- Backend: DigitalOcean Droplet
- Workers: Docker containers
- Storage: S3-compatible

---

## 12. Future Enhancements

- Automatic parcel detection via GIS APIs
- 3D boundary extrusion
- AI voice-over generation
- MLS integration

---

## 13. Deliverables

- Fully functional web app
- API service
- Worker pipeline
- Documentation
- Sample dataset for testing

---

## END OF PLAN
There will be a database with geo location data for all properties
1) User inputs valuation number or folio number
2) The geo location data matching the unputs are pulled from the database and sent to a service like google maps or mapbox (which ever on is best for creating videos from there footage.)
3) The service provides areal footage of the property that can be turned into aerial drone footage to in order to create a real estate video.
4) The application gets the footage from the provider, and turns it into an aerial drone footage video if it's not already in that state.
5) The application then uses boundary line data from the service provider or the database (Keep in mind that the database might not have this data) to map-out and automatically draw/highlight and track the drawn/highlighted boundary lines in the video.
6) The application would then add the company logo and realtor/real estate agents credentials at the begining and end of the video.
7) The information/credentials for the agent will be gathered from an initial account creation screen and saved for adding to the video.
8) The application will be subscription based, so the agents credentials/information must be added to every video so that all videos created for that account are for the agent who is paying for the service. If you can think of any other markers to place in the video to tie to the agent, those ideas are welcomed.
9) The user/real estate agent can then download a full HD drone footage video showing property lines highlighted/drawn and tracked through-out the video.
10) The video should be at least 20 seconds long.

Also break the plan down in steps of implementation, not a one-shot deal. Please make that plan so that the agent can does not have to guess or have to make its own decisions about any part of the implementation. If at any point in implementing any feature that, for some reason, the agent needs clarity, make it so that the agent asks me for clarification and provides a list of options for to choose from in order to give it clarity. Each option should have an explaination as to why it can/should be considered.





















You’re right — the original plan assumed user-supplied drone footage, but your real goal is much closer to a data → map provider → synthetic drone video pipeline. That’s a fundamentally different system.

Below is a rewritten, implementation-first plan that removes ambiguity, forces deterministic choices, and builds toward your exact product step-by-step.

⸻

plan_v2.md — AI Property Video Generator (From Valuation Number)

⸻

1. Core Objective (Re-defined)

Build a system that:

1. Accepts a valuation number / folio number
2. Resolves it → property geolocation + boundary
3. Pulls aerial imagery from a map provider
4. Converts imagery → cinematic drone-style video
5. Overlays and tracks property boundaries
6. Adds agent branding automatically (subscription-tied)
7. Outputs a ≥ 20 second Full HD (1920x1080) video

⸻

2. Non-Negotiable Technical Constraints

* NO reliance on “real-time Google Maps video capture” (not provided as an API)
* ALL imagery must come from:
    * Static tiles OR
    * 3D map rendering APIs
* Boundary tracking must be deterministic (no “AI guessing” unless fallback triggered)
* Every step must have a fallback

⸻

3. System Architecture (Updated)

Components

1. Frontend (Next.js)

* Input: valuation number
* Dashboard: generated videos
* Account/profile (agent branding)

2. Backend API (Node.js)

* Resolves property data
* Orchestrates jobs

3. Worker (Python + FFmpeg)

* Map rendering
* Video generation
* Boundary overlay
* Branding

4. Database (PostgreSQL + PostGIS)

* Property data
* Agent data
* Job tracking

5. Storage

* DigitalOcean Spaces (videos/assets)

6. Queue

* BullMQ (Redis)

⸻

4. CRITICAL DESIGN DECISION (DO NOT SKIP)

Map Provider Strategy

The agent MUST choose ONE of the following before implementation:

Option A — Mapbox (RECOMMENDED)

* Use Mapbox Static Images + Mapbox GL rendering
* Pros:
    * API-friendly
    * Easier automation
    * Style control (important for “cinematic” look)
* Cons:
    * No true 3D photorealistic view

Option B — Google Maps Platform

* Use Static Maps API
* Pros:
    * Better satellite imagery
* Cons:
    * Strict usage limits
    * No video/3D export
    * Legal constraints

Option C — CesiumJS

* Use 3D globe rendering
* Pros:
    * TRUE drone-like camera movement
* Cons:
    * More complex setup

⸻

REQUIRED ACTION

Before proceeding, if unclear, the agent MUST ask:

“Which provider should I use: Mapbox, Google, or Cesium?”

⸻

5. Implementation Plan (Step-by-Step, No Guessing)

⸻

STEP 1 — Property Data Layer

Goal

Resolve valuation number → geodata

Implementation

Database Schema

properties:
- id
- valuation_number (unique)
- folio_number
- latitude
- longitude
- boundary_geojson (nullable)

API

GET /property/:valuationNumber

Logic

if property exists:
    return data
else:
    return error: PROPERTY_NOT_FOUND

⸻

If Data Is Missing

Agent MUST ask:

“Where should property data come from?”

Options:

1. Government API (e.g. land registry)
    * Accurate, authoritative
2. Bulk dataset import
    * Faster initial build
3. Manual upload (CSV/GeoJSON)
    * Flexible fallback

⸻

STEP 2 — Boundary Resolution

Logic Priority Order

1. Use DB boundary if exists
2. Else fetch from provider (if supported)
3. Else fallback to bounding box

⸻

If No Boundary Exists

Agent MUST ask:

Options:

1. Use square bounding box around coordinates
    → Simple, always works
2. Attempt external GIS lookup
    → More accurate, but unreliable
3. Ask user to draw boundary
    → Best accuracy, worst UX

⸻

STEP 3 — Map Frame Generation

Goal

Generate a sequence of frames simulating drone motion

⸻

Camera Path (FIXED — NO GUESSING)

Duration: 20 seconds
FPS: 30
Total frames: 600
Camera motion:
1. Start: zoomed out (altitude high)
2. Slowly zoom in
3. Slight pan (left → right)
4. End: centered on property

⸻

Frame Generation Strategy

If using Mapbox:

Call Static API repeatedly:

for frame in frames:
    compute zoom + bearing
    fetch image

⸻

Output

/frames/frame_0001.png → frame_0600.png

⸻

STEP 4 — Drone Effect Simulation

Goal

Make frames look like drone footage

Effects (MANDATORY)

* Smooth zoom interpolation
* Ease-in/ease-out motion
* Slight rotation (bearing change)
* Optional:
    * Depth blur
    * Color grading (cinematic LUT)

⸻

STEP 5 — Boundary Overlay

Input

* GeoJSON polygon

Process

1. Convert geo → pixel coordinates per frame
2. Draw polygon:

color: #00FF00
opacity: 40%
stroke: 3px

⸻

Tracking

NO CV tracking needed.

Instead:

Reproject polygon per frame using map projection

⸻

STEP 6 — Branding System (CRITICAL FEATURE)

Agent Profile Schema

agents:
- id
- name
- company
- logo_url
- phone
- email
- subscription_status

⸻

Video Injection Points

Beginning (0–3 sec)

* Logo fade in
* Agent name
* Company

End (last 5 sec)

* Contact details
* Call-to-action

⸻

Additional Anti-Abuse Markers

Include ALL:

1. Watermark (bottom corner)
2. Metadata tag in video file
3. Invisible frame watermark (optional hash)

⸻

STEP 7 — Video Assembly

Command

ffmpeg -framerate 30 -i frame_%04d.png \
  -vf "format=yuv420p" \
  output.mp4

⸻

Add Branding + Audio

ffmpeg -i video.mp4 -i audio.mp3 \
  -filter_complex "[overlay logic]" \
  final.mp4

⸻

STEP 8 — API Flow

Endpoints

POST /generate
GET /status/:jobId
GET /download/:jobId

⸻

Job Pipeline

1. resolve_property
2. resolve_boundary
3. generate_frames
4. overlay_boundary
5. render_video
6. add_branding

⸻

STEP 9 — Subscription Enforcement

Rules

if agent.subscription_status != active:
    block video generation

⸻

Optional Enhancements

* Limit videos/month
* Watermark for free tier

⸻

STEP 10 — Output Requirements

* Format: MP4
* Resolution: 1920x1080
* Duration: ≥ 20 seconds
* Includes:
    * Boundary overlay
    * Branding
    * Smooth motion

⸻

6. FAILURE HANDLING (STRICT)

Failure	Action
Property not found	Stop + return error
No imagery	Retry provider → fallback
No boundary	Use bounding box
Rendering fails	Retry 3x

⸻

7. What the Agent MUST NOT Decide Alone

At ANY of these points, the agent must ask you:

1. Map provider choice
2. Property data source
3. Boundary fallback strategy
4. Branding style (minimal vs heavy)
5. Color scheme for overlays

Each time, it must present options + reasoning.

⸻

8. Suggested Build Order (Execution Plan)

Phase 1 (MVP Core)

1. Property lookup
2. Static map frame generation
3. Basic video rendering

Phase 2

4. Boundary overlay
5. Camera motion polish

Phase 3

6. Agent accounts
7. Branding overlays

Phase 4

8. Subscription system
9. Optimization + scaling

⸻

9. Reality Check (Important)

What you are building is:

* NOT true drone footage
* It is synthetic aerial animation from map data

To get real drone footage, you’d need:

* UAV capture OR
* Licensed aerial video datasets

⸻

10. Next Required Decision

Before moving forward, answer this:

Which map provider do you want to base the system on?

1. Mapbox (recommended for control)
2. Google Maps (better imagery, more restrictions)
3. Cesium (best for true 3D drone feel)

If you want, I can:

* ￼ Lock one choice
* Then ￼ generate actual code scaffolding (Next.js + worker + FFmpeg pipeline) for Phase 1 immediately