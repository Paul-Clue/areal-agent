# Project summary (living document)

**Last updated:** 2026-04-27

This file is the **primary onboarding document** for agents working in parallel or new sessions. Read it before large changes. It describes the **areal-agent** repo: product intent, what is implemented on disk, what still lives only in plans, and operational gotchas.

---

## One-paragraph snapshot

**areal-agent** supports a planned **Jamaica NLA–based property video SaaS** (see `planv5.md` / **`planv6.md`** for the current app build). The **Next.js app** now lives in-repo as **`property-video-app/`** (partial **`planv6.md`** implementation: DB client, property/parcel APIs, Clerk, generate UI with map + multi-parcel modal, **map framing via `ST_PointOnSurface`**, and **drag-to-move / vertex reshape** on the parcel polygon — **not** the full worker, FFmpeg, BullMQ, Stripe, or Spaces pipeline). **Workers, production deployment, billing, and hosted Redis/Spaces** are still plan-only or environment-specific. What *is* here: (1) long-form specs under `docs/`; (2) a **Node/Puppeteer data pipeline** under `dataScraper/` (NLA GIS fetch, optional tax-site scrape, validation, Postgres ingest **and parcel ingest**); (3) **SQL and role templates** under `database/` from `databasePlanv2.md` Phase 0 **plus** `databaseUpdate.md` (one-to-many parcels, `property_parcels`); (4) **`property-video-app/`** — Next.js 16 app per `planv6.md` Step 0+ (see **Application — `planv6` progress** below). A **production Postgres database is not created or guaranteed by the repo alone**—operators create a cluster, apply SQL, set secrets, and run scripts.

---

## North star (from `planv5.md`)

- Input: **valuation number** or **folio**.
- Backend: **PostgreSQL + PostGIS** with parcel geometry (when present).
- Video: **Mapbox** (default) and optionally **Cesium + Google 3D Tiles** when coverage exists.
- Output: **branded synthetic** aerial-style video (not real drone footage), with boundaries and post-processing per plan.
- **Auth / billing / deployment** are specified in `planv5.md` / `planv6.md`. **Clerk** is wired in **`property-video-app`**; **Stripe, production deploy, worker droplet, Redis, Spaces** remain to be implemented per plan.

---

## What exists in-repo vs out-of-repo

| In this repo | Not in this repo (see plans) |
|----------------|-------------------------------|
| `docs/*.md` plans and `prompts.txt` | Hosted **production** DB (unless you provision it) |
| `database/*.sql` schema + hardening templates | Full **video worker** pipeline (FFmpeg, frame gen, upload) as a separate long-running service — **specified in `planv6.md`, not fully built** |
| `dataScraper` fetch / validate / ingest scripts | Vercel deployment, managed Redis, DO Spaces (unless configured) |
| **`property-video-app/`** — Next.js app (`npm install` / `npm run dev` **in that folder**) | Committed `.env` / `.env.local` with real secrets |
| `.gitignore`, `dataScraper/.env.example`, `property-video-app/.env.local.example` | — |

---

## Repository layout

| Path | Role |
|------|------|
| `docs/` | Product plans (`planv5.md`, **`planv6.md`**), Phase 0 DB plan (`databasePlanv2.md`), **DB update v1** (`databaseUpdate.md`), older plans, `prompts.txt`, **this file** |
| `database/` | Executable SQL: `schema.sql`, **parcel update** (`update_property_parcels_v1.sql`, `update_property_parcels_step6.sql`, `grants_property_parcels_app_user.sql`, `verify_property_parcels_v1.sql`), RLS, **`app_user.template.sql`**, `app_user.local.sql` (gitignored — password; run before parcel grants), pool limit, optional tuning |
| `reference/databaseUpdate-step8/` | Original **Next.js** snippets for Step 8 — logic is **merged into** `property-video-app/src/lib/property.ts` and related routes/components (keep in sync when changing lookup behavior) |
| `property-video-app/` | Next.js **16** app: `planv6.md` **Step 0** (create-next-app) plus Phases **1–3**-style pieces (see **Application — `planv6` progress**). Has its own `package.json` — **not** at repo root. |
| `dataScraper/` | Node project: NLA fetch, JSON validation, Postgres ingest, legacy/auxiliary scripts |
| `.gitignore` | Ignores `.env`, logs, `fetch_progress.json`, `node_modules/`, **`database/app_user.local.sql`**, `.env.local` |

There is **no** root `package.json`. Use **`cd dataScraper`** for the pipeline and **`cd property-video-app`** for the web app.

---

## Application — `planv6` progress (`property-video-app/`)

Implemented from **`docs/planv6.md`** (not the full plan):

| Area | Status |
|------|--------|
| **Step 0** — Next.js app (TypeScript, App Router, Tailwind, `src/`, `@/*`) | Done |
| **Phase 1** — `src/lib/db.ts` (`pg` Pool, `DATABASE_URL`, SSL in production) | Done |
| **Phase 2** — `src/lib/boundary.ts` (`resolveBoundary`, `generateBoundingBox`) | Done |
| **Phase 3** — `src/lib/property.ts` (`lookupProperty`, `getParcelById`), `GET /api/property/[id]`, `GET /api/parcel/[nlaObjectId]` | Done |
| **Clerk** — `ClerkProvider`, `src/middleware.ts` (`auth.protect` on `/dashboard` + protected APIs including `/api/property`, `/api/parcel`, `/api/agent`, `/api/generate`, `/api/status`) | Done |
| **Phase 8 (partial)** — `POST /api/agent/sync`, client layout that calls sync on dashboard load | Done |
| **Phase 11 (partial)** — `/`, `/dashboard`, `/dashboard/generate` with `ParcelSelectModal`, `MapEditor` (Mapbox + MapboxDraw), dynamic map load | Done |
| **Generate map — framing** — `src/lib/property.ts` adds **`frame_latitude` / `frame_longitude`** (`ST_PointOnSurface(boundary::geometry)` when `boundary` is set); **`GET /api/property/[id]`** and **`GET /api/parcel/[nlaObjectId]`** return them; **`MapEditor`** uses them for **`initialViewState`** so the camera centers **inside** the NLA polygon instead of relying only on ingest’s vertex-mean **`latitude` / `longitude`**. | Done |
| **Generate map — boundary UX** — Custom Mapbox Draw **`simple_select`** (`src/lib/mapboxDrawSimpleSelectDrag.ts`): **drag the shaded interior** to translate the whole polygon; **draw styles** derived from `MapboxDraw.lib.theme` drop the default filter that hid **vertex handles** in `simple_select`, so **corner dots** stay usable without forcing `direct_select` on every body click. Instructions appear above the map on Generate. | Done |
| **Env** — `property-video-app/.env.local.example` (aligns with plan §6.4) | Done |

**Explicitly not implemented yet** (still per `planv6.md` only): `src/worker/*` (Mapbox/Cesium frame pipelines, FFmpeg, post-processing, branding scripts), **BullMQ + Redis** (`src/lib/queue.ts`, worker process), **Stripe** and webhooks, **DigitalOcean Spaces** uploads, `POST /api/generate` as a real queue job (currently **501** stub), **`GET /api/status/[jobId]`** as a real job tracker (currently a stub that returns **failed** / not configured — the generate UI’s SWR polling cannot reach a “complete” state from this alone), Cesium **coverage probe** / renderer selection as in Phase 4, profile UI beyond sync, download route, and the plan’s **⚠️ clarification** decisions (LUT vs curves, boundary style, music, etc.).

**Run locally:** `cd property-video-app && npm install && cp .env.local.example .env.local` — set at minimum **`DATABASE_URL`** (as **`app_user`**), **Clerk** keys, **`NEXT_PUBLIC_MAPBOX_TOKEN`** (and `MAPBOX_TOKEN` when workers exist). **Clerk v6+** uses `<Show when="signed-in" />` (not `SignedIn` / `SignedOut`).

**Next.js 16** may warn that **`middleware.ts`** is legacy in favor of **“proxy”**; follow **Next.js** migration when upgrading — Clerk can remain configured similarly.

---

## Phase 0 database (`database/`)

Implements **Step 2** (and templates for **7A, 7B, 7D, 7F**) of `databasePlanv2.md`. Apply with `psql` as a superuser/admin, in order, on a **new empty database** with PostGIS available.

| File | Purpose |
|------|---------|
| `schema.sql` | Extensions (`postgis`, `pgcrypto`, `pg_trgm`), `properties`, `agents`, `jobs`, indexes, `updated_at` triggers, `v_data_quality_summary`, `v_parish_summary`, `refresh_log` |
| `rls.sql` | Row-level security on `agents` (after schema and data policy is understood) |
| `app_user.template.sql` | Create `app_user` and **Phase 0** table grants (password placeholder) — **never commit** a file with a real password |
| `app_user.local.sql` | **Not in git** (see `.gitignore`). Copy from the template, set password, `psql -f database/app_user.local.sql`. **Run after** `schema.sql` (and v1 if you use parcels); **run before** `grants_property_parcels_app_user.sql` (that script errors if `app_user` does not exist). |
| `app_user_pool.sql` | `CONNECTION LIMIT` for `app_user` |
| `performance_self_managed.sql` | Optional; **only** for self-managed Postgres, not typical managed hosts |

**Connections (per plan):** bulk **ingestion** uses an **admin** URL (e.g. direct port); the **application** should use **`app_user`** via **PgBouncer** when the host provides it. `dataScraper/.env.example` documents `DATABASE_URL` for scripts.

**Operator responsibility:** creating the database, running `schema.sql`, running fetch/validate/ingest, then RLS/`app_user` per plan, is **environment-specific** and not automated in CI here.

---

## Database update v1 — `property_parcels` (`docs/databaseUpdate.md`)

Adds **`property_parcels`** (one row per NLA `nla_object_id`), **`properties.has_multiple_parcels`**, **`properties.canonical_selection_method`**, indexes, and views (`v_parcels_quality_summary`, `v_multi_parcel_lv_numbers`, `v_incomplete_parcels`). Spec and step-by-step instructions: **`databaseUpdate.md`**.

| File | Purpose |
|------|---------|
| `update_property_parcels_v1.sql` | Steps 1–4: alter `properties`, create `property_parcels`, indexes, views, `updated_at` trigger |
| `update_property_parcels_step6.sql` | Sets `has_multiple_parcels` / `canonical_selection_method` from parcel counts (run **after** `ingestParcels.js`) |
| `grants_property_parcels_app_user.sql` | Grants for `app_user` on `property_parcels` and new views — requires **`app_user` to exist** (run `app_user.local.sql` or template first) |
| `verify_property_parcels_v1.sql` | Step 7–style checks from `databaseUpdate.md` — run with **`psql -f`**, not Node |

**FK rule:** `property_parcels.valuation_number` references **`properties(valuation_number)`**. Run **`npm run ingest`** before **`npm run ingest-parcels`**, or every parcel insert will fail. `ingestParcels.js` includes a preflight `COUNT(*)` on `properties`.

**Canonical selection** for sibling ordering is configured in `ingestParcels.js` (`CANONICAL_METHOD`; default `most_complete_address`). Keep **`update_property_parcels_step6.sql`** in sync if you change it.

**Reference full load (local `property_video_db`, 2026):** after fetch + `npm run ingest` + `npm run ingest-parcels` + step 6, ballpark numbers were: **`properties`** **880,422** rows; **`property_parcels`** **976,812** rows (one per NLA feature). The gap **96,390** = **extra parcel rows** (multiple `nla_object_id` per valuation number), **not** “missing” property rows. Step 6 updated **48,169** LVs as multi-parcel and **832,253** as single-parcel among those with parcel data. **`976,812` is not** the `properties` row count—do not subtract it from a property `COUNT(*)` to look for “unupdated” rows. Quality summary: **`v_parcels_quality_summary`** (e.g. **~7%** `is_incomplete` in that load); `verify_property_parcels_v1.sql` should show **0** rows for *7E* (exactly one `sibling_index = 1` per LV) and **0** *inconsistent_rows* for *7F*.

---

## `dataScraper/` — package and npm scripts

- **Package name:** `puppet-land-val-nums` (`package.json`).
- **Install:** `cd dataScraper && npm install`.
- **Scripts:**
  - `npm run fetch` → `fetchAndSaveData.js` (NLA GIS full/paginated fetch to `land_val_numbers.json`)
  - `npm run validate-data` → `validateLandValNumbers.js` (coverage + stop conditions from `databasePlanv2.md` Step 4)
  - `npm run ingest` → `ingestToDatabase.js` (upsert into **`properties`**, requires `DATABASE_URL` in `.env`)
  - `npm run ingest-parcels` → `ingestParcels.js` (upsert into **`property_parcels`**; requires **`properties`** populated and `update_property_parcels_v1.sql` applied)

**Config:** copy `.env.example` to `.env` and set `DATABASE_URL` for ingest (see example comments).

**Dependencies (high-signal):** `puppeteer`, `pg`, `dotenv`, plus `JSONStream`, `event-stream`, `csv-writer`, `node-fetch`, etc. Not every script uses every package.

---

## Pipeline order (recommended)

### First-time database + full Jamaica parcel load

1. **Provision Postgres** and apply **`database/schema.sql`** (PostGIS, etc.).
2. Apply **`database/update_property_parcels_v1.sql`** (adds parcel table and `properties` flags **before** or **after** main ingest; must be applied **before** `ingest-parcels`).
3. **`npm run fetch`** — writes `land_val_numbers.json` (**NDJSON**), `fetch_log.txt`; **resume** via file **line count** as `resultOffset`.
4. **`npm run validate-data`** — optional; exit **1** on Step 4 stops (`databasePlanv2.md`). Validator normalizes parish whitespace for Stop 4 (NLA `"ST.  ANDREW"` vs canonical names).
5. **`npm run ingest`** — upserts **`properties`** from `land_val_numbers.json` (skips rows with empty `lvNumber`).
6. **`npm run ingest-parcels`** — upserts **`property_parcels`** (one row per `nlaObjectId`; requires rows in **`properties`**).
7. **`psql … -f database/update_property_parcels_step6.sql`** — refresh `has_multiple_parcels` / `canonical_selection_method`.
8. **Create `app_user`:** `psql … -f database/app_user.local.sql` (or a secure copy of `app_user.template.sql` with a real password). **Must run before** parcel grants; otherwise `grants_property_parcels_app_user.sql` fails with *role "app_user" does not exist*.
9. **`psql … -f database/grants_property_parcels_app_user.sql`** — parcel table + v1 view grants for **`app_user`**.
10. **Verify:** `psql … -f database/verify_property_parcels_v1.sql` (SQL for **`psql` only** — not `node`).
11. **Hardening (optional):** `database/app_user_pool.sql`, `rls.sql`, and remaining Step 6–7 items in `databasePlanv2.md`.

Also: **`v_data_quality_summary`** / **`v_parish_summary`** (Phase 0) as needed.

---

## Scripts reference (all under `dataScraper/`)

| File | Purpose |
|------|---------|
| `fetchAndSaveData.js` | **Primary NLA fetch** (per `databasePlanv2.md`): **headless** Puppeteer → MapServer `/query`, pagination, Jamaica coordinate validation, `nlaObjectId` / `lvNumber` / addresses / `boundaryGeojson`, 3s delay, **resume** support. |
| `validateLandValNumbers.js` | Step 4-style report; enforces stop rules (coordinates %, duplicates, missing LV, parish coverage). |
| `ingestToDatabase.js` | Batch upsert into `properties` using `pg` + `dotenv`. |
| `ingestParcels.js` | Batch upsert into `property_parcels` (NDJSON); grouping + `sibling_index`; see `databaseUpdate.md`. |
| `getData.js` | Esri `QueryTask`-style sample (browser-oriented); not the main fetch path. |
| `landNums.js` | Experimental interactive map clicking / table scrape. |
| `tx-taxData.js` | PTS site: reads `land_valuation_numbers.json`, appends `property_info.json`, `used-evals.txt`. |
| `write-evals.js` | Writes `evals.json` from `land_valuation_numbers.json`. |
| `1-copy_json_subset.js` | Stream-split large JSON into chunks; filename in script may use hyphens — check before run. |
| `process_names.js` | `property_info.json` → `owner_names.csv` (expects parseable JSON array). |
| `puppeteer-iframe-reveal.js`, `pointer.js`, `tx-frame.js` | Debugging / helpers. |

---

## Data files and LLM context

**Do not read these into chat context** (see `prompts.txt`): they are huge.

| File | Role |
|------|------|
| `land_valuation_numbers.json` | Large NLA-style parcel export (`objectId`, `lvNumber`, addresses, etc.). |
| `land_val_numbers.json` | **Fetch output** (NDJSON) for validation/ingest; old pretty-printed **JSON array** is migrated once on the next run. Includes geometry when the API returns it. `*.legacy_backup` may exist after migration. |
| `evals.json` | List of valuation strings from `write-evals.js`. |
| `property_info.json` | PTS scrape output (`propertyInfo` objects); may be **appended** by `tx-taxData.js` — not always one JSON array. |
| `used-evals.txt` | Resume list for PTS scraper. |

**Gitignore / logs:** `fetch_log.txt`, `ingest_log.txt`, `ingest_parcels_log.txt`, `fetch_progress.json` may appear during runs.

---

## External URLs (from code)

| System | URL |
|--------|-----|
| NLA GIS MapServer | `https://gisportal.nla.gov.jm/nlagis/rest/services/ElandjamaicaAug162024/MapServer/16` |
| eLand interactive map | `https://elandjamaica.nla.gov.jm/elandjamaica/interactivemap.aspx` |
| PTS (tax query) | `https://ptsqueryonline.fsl.org.jm/PTSOnlineWeb/ptsquery.jsp` |

Respect **rate limits** and **terms of use**.

---

## Documentation index

| File | Use |
|------|-----|
| `planv6.md` | Newer / extended application plan (use alongside or instead of v5 for current product decisions). |
| `planv5.md` | **Application** build: Next.js, workers, Mapbox/Cesium, product rules. |
| `databasePlanv2.md` | **Phase 0** DB: schema, fetch, validate, ingest, hardening, refresh. |
| `databaseUpdate.md` | **Phase 0 update v1:** `property_parcels`, multi-parcel flags, views, ingest order, app lookup (Step 8). |
| `plan.md` / `planUpdate.md` | Older / alternate product plans. |
| `prompts.txt` | File exclusions, sample record shapes, asks agents to keep **this** summary current. |

---

## Gotchas

1. **Two filename conventions:** `land_valuation_numbers.json` vs `land_val_numbers.json` vs `land-valuation-numbers.json` in `1-copy_json_subset.js` — confirm paths before running.
2. **`property_info.json`:** `tx-taxData.js` may append line-by-line; `process_names.js` expects a **single valid JSON array** — align formats if you change the scraper.
3. **Ingestion** requires **`DATABASE_URL`** and a database where **`schema.sql`** was applied successfully.
4. **`app_user`:** Create only after reading Step 7B in `databasePlanv2.md` (password handling). Use **`database/app_user.local.sql`** (gitignored) or a one-off file **outside git** with the real password — **never** commit credentials. Create **`app_user` before** `grants_property_parcels_app_user.sql`.
5. **Local Postgres.app (macOS):** A “reindexing required” banner is a **heuristic** (often macOS / collation related). Run `reindexdb --all` or `database/reindex_all_local.sh`, then **More Info → Hide this Warning** in the app. Full steps: `databasePlanv2.md` appendix *Postgres.app: “Reindexing required”*.
6. **`ingest-parcels` before `ingest`:** Fails with FK violations; **`properties`** must exist first. `ingestParcels.js` exits early if `properties` is empty.
7. **`psql`:** Use a real database name or `"$DATABASE_URL"` — do not paste the literal ellipsis character `…` as the dbname (Postgres will try to open a database named `…`).
8. **Step 6 row counts:** `UPDATE` totals from `update_property_parcels_step6.sql` only touch `properties` rows whose LV has **at least one** `property_parcels` row. Rows with **zero** parcel rows keep default flags (`has_multiple_parcels` false, `canonical_selection_method` null) until reconciled. On a **full** ingest + parcel load, `COUNT(*)` for `properties` can match **48,169 + 832,253 = 880,422** when every LV has parcel data.
9. **Row-count confusion:** **`COUNT(*) FROM property_parcels`** (e.g. **976,812**) counts **parcel features**, not `properties` rows. **`COUNT(*) FROM properties`** (e.g. **880,422**) is distinct LVs. The difference is **sibling** rows, not necessarily “rows Step 6 skipped.”
10. **`verify_property_parcels_v1.sql`:** Run with **`psql -f`**. Running with **`node`** tries to parse SQL as JavaScript and fails on comments.

---

## Next steps after DB work (app)

1. **Pipeline:** run fetch / ingest / parcel ingest / step 6 / `app_user` / grants as in **Pipeline order** above.
2. **App:** `cd property-video-app`, configure **`.env.local`**, `npm run dev`, sign in with Clerk, open **`/dashboard/generate`**, smoke-test a multi-parcel LV (e.g. **`031B6W02067`**) and a single-parcel LV. **`reference/databaseUpdate-step8/`** is superseded in code by `property-video-app/`, but keep parity if you change DB lookup rules (`databaseUpdate.md` Step 8).
3. **From `planv6.md`:** queue + worker (Phases 10, 14–15), subscription + generate route (12–14), or Mapbox-only renderer path before Cesium.

---

## Handoff checklist for a new agent / parallel chat

1. Read **this file** and the relevant plan (`planv6.md` / `planv5.md` for app work, `databasePlanv2.md` for DB work, **`property-video-app/`** for the current Next app).
2. Do **not** open multi-megabyte JSON in the editor or paste into prompts.
3. For DB changes: work from `database/*.sql`, `dataScraper/ingestToDatabase.js`, and `dataScraper/ingestParcels.js`; confirm target environment and secrets outside git.
4. After structural or workflow changes, update **Last updated** and the **Changelog** below.

### Changelog

- **2026-04-25:** **`property-video-app` + `planv6`:** Documented the in-repo Next.js app (`property-video-app/`), what is implemented vs still plan-only (worker, queue, Stripe, Spaces, clarifications), Clerk/Mapbox/DB handoff, updated snapshot and tables (no longer “app not in repo”), Next steps, and handoff pointer to `planv6.md`.
- **2026-04-25:** **Context-loading-strategy (subagent cross-check):** `dataScraper` pipeline and `database` + `reference/databaseUpdate-step8` match this doc; `planv6.md` added to documentation index. Minor operational notes from scan: `ingestToDatabase.js` can leave a partial DB write if a batch fails mid-run (per-batch rollback, process may not exit non-zero); `package.json` `test` script is a placeholder.
- **2026-04-25:** **ProjectSummary** — reference load **880,422** `properties` / **976,812** `property_parcels` / **96,390** sibling rows; **app_user** order (**`app_user.local.sql` →** grants); **verify** with **`psql`** only; gotchas for row-count mix-ups and full-load Step 6 math; **Next steps** pointer to `reference/databaseUpdate-step8/` and `app_user` `DATABASE_URL`.
- **2026-04-25:** Documented **`databaseUpdate.md`** / **`property_parcels`** workflow: SQL files (`update_property_parcels_v1.sql`, step 6, grants, verify), **`npm run ingest-parcels`**, FK order (**`ingest` before `ingest-parcels`**), `reference/databaseUpdate-step8/`, validator parish normalization (Stop 4), and related gotchas (`psql` ellipsis, Step 6 coverage).
- **2026-04-25:** `land_val_numbers.json` is NDJSON (not a single huge array); resume uses file line count as `resultOffset`; legacy array files migrate with a `*.legacy_backup` copy.
- **2026-04-25:** Added `database/reindex_all_local.sh` and `databasePlanv2.md` appendix for Postgres.app “reindexing required” (commands + dismissing the UI).
- **2026-04-25:** Expanded for Phase 0 `database/` SQL, fetch/validate/ingest pipeline, npm scripts, env files, in-vs-out-of-repo scope, and handoff for concurrent sessions.
- **2026-04-25:** Initial summary (repo scan; large JSONs excluded per `prompts.txt`).
