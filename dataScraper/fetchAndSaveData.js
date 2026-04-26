/**
 * fetchAndSaveData.js
 *
 * Scrapes ALL property parcels from the NLA GIS REST API (eLand Jamaica).
 * Output: land_val_numbers.json as NDJSON (one compact JSON object per line).
 * This avoids V8 "Invalid string length" when the dataset exceeds ~hundreds of
 * thousands of parcel polygons in a single JSON.stringify.
 *
 * Run:    node fetchAndSaveData.js
 * Resume: re-run; resultOffset = current line count (ignores stale fetch_progress.json).
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const {
  ensureNdjson,
  countNdjsonRecords,
  DEFAULT_LAND_VAL_FILE,
} = require('./landValFile');

const NLA_URL = 'https://gisportal.nla.gov.jm/nlagis/rest/services/ElandjamaicaAug162024/MapServer/16/query';
const PAGE_SIZE = 1000;
const REQUEST_DELAY_MS = 3000;
const OUTPUT_FILE = DEFAULT_LAND_VAL_FILE;
const PROGRESS_FILE = 'fetch_progress.json';
const LOG_FILE = 'fetch_log.txt';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

/**
 * Appends one JSON object per line to the output file (no giant single-stringify).
 * Each record is produced by mapFeature without internal newlines in compact form.
 */
function appendRecords(records) {
  if (!records.length) return;
  const chunk = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.appendFileSync(OUTPUT_FILE, chunk, 'utf8');
}

/**
 * Best-effort snapshot; resume uses line count, not this file.
 */
function writeProgressSnapshot(totalRecords) {
  fs.writeFileSync(
    PROGRESS_FILE,
    JSON.stringify({ totalRecords, updatedAt: new Date().toISOString() }, null, 2)
  );
}

function saveProgress(totalRecords) {
  writeProgressSnapshot(totalRecords);
}

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    }
  } catch {
    /* ignore */
  }
  return null;
}

function extractGeometry(feature) {
  let latitude = null;
  let longitude = null;
  let boundaryGeojson = null;
  const geo = feature.geometry;
  if (!geo) return { latitude, longitude, boundaryGeojson };

  if (geo.rings && geo.rings.length > 0) {
    boundaryGeojson = { type: 'Polygon', coordinates: geo.rings };
    const ring = geo.rings[0];
    longitude = ring.reduce((s, p) => s + p[0], 0) / ring.length;
    latitude = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  } else if (geo.x !== undefined && geo.y !== undefined) {
    longitude = geo.x;
    latitude = geo.y;
  }
  return { latitude, longitude, boundaryGeojson };
}

function isValidCoordinate(lat, lng) {
  if (lat === null || lng === null) return false;
  if (lat === 0 && lng === 0) return false;
  if (lat < 17.5 || lat > 19.0) return false;
  if (lng < -79.0 || lng > -76.0) return false;
  return true;
}

function mapFeature(feature) {
  const attr = feature.attributes;
  const { latitude, longitude, boundaryGeojson } = extractGeometry(feature);
  const coordsValid = isValidCoordinate(latitude, longitude);

  return {
    nlaObjectId: attr.OBJECTID || null,
    lvNumber: (attr.LV_NUMBER || '').trim(),
    volFol: (attr.VOL_FOL || '').trim() || null,
    streetAdd: (attr.STREET_ADD || '').trim() || null,
    schemeAdd: (attr.SCHEME_ADD || '').trim() || null,
    parish: (attr.PARISH || '').trim() || null,
    location: (attr.LOCATION || '').trim() || null,
    latitude: coordsValid ? latitude : null,
    longitude: coordsValid ? longitude : null,
    boundaryGeojson: coordsValid ? boundaryGeojson : null,
    _hasCoords: coordsValid,
    _hasBoundary: coordsValid && boundaryGeojson !== null,
    _coordsInvalid: !coordsValid && (latitude !== null || longitude !== null),
  };
}

(async () => {
  fs.writeFileSync(LOG_FILE, '');
  log('=== NLA GIS Fetch Started ===');

  const migratedMeta = await ensureNdjson(OUTPUT_FILE);
  if (migratedMeta.migrated) {
    log(
      `Migrated legacy JSON array to NDJSON. Backup: ${migratedMeta.backupPath || 'n/a'}`
    );
  }

  // Resume offset = number of full records on disk (source of truth for API resultOffset)
  let totalRecords = 0;
  if (fs.existsSync(OUTPUT_FILE) && fs.statSync(OUTPUT_FILE).size > 0) {
    totalRecords = await countNdjsonRecords(OUTPUT_FILE);
  }

  const oldProgress = loadProgress();
  if (oldProgress) {
    const prev =
      oldProgress.totalRecords != null
        ? oldProgress.totalRecords
        : oldProgress.pageIndex != null
          ? oldProgress.pageIndex * PAGE_SIZE
          : null;
    if (prev != null && prev !== totalRecords) {
      log(
        `Note: fetch_progress was out of sync (${prev} vs ${totalRecords} lines in file). Using file line count for resultOffset.`
      );
    }
  }

  if (totalRecords > 0) {
    log(`Resuming: ${totalRecords} records in ${OUTPUT_FILE} — next resultOffset = ${totalRecords}`);
  } else {
    log(`Output ${OUTPUT_FILE} (NDJSON) — starting at offset 0`);
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') log(`Browser error: ${msg.text()}`);
  });

  let totalWithPolygon = 0;
  let totalPointOnly = 0;
  let totalNoGeometry = 0;
  let totalBadCoords = 0;
  const MAX_RETRIES = 3;

  async function fetchPage() {
    const params = new URLSearchParams({
      where: '1=1',
      outFields: 'OBJECTID,LV_NUMBER,VOL_FOL,STREET_ADD,SCHEME_ADD,PARISH,LOCATION',
      returnGeometry: 'true',
      geometryType: 'esriGeometryPolygon',
      outSR: '4326',
      f: 'json',
      resultOffset: totalRecords,
      resultRecordCount: PAGE_SIZE,
    });

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await page.goto(`${NLA_URL}?${params}`, { waitUntil: 'networkidle0', timeout: 30000 });
        const content = await page.content();
        const match = content.match(/{.*}/s);
        if (!match) throw new Error('No JSON found in response');

        const result = JSON.parse(match[0]);
        if (result.error) throw new Error(`API error: ${result.error.message}`);
        if (!result.features || result.features.length === 0) {
          log('No more features — fetch complete');
          return false;
        }

        const mapped = result.features.map(mapFeature);
        const pagePolygon = mapped.filter((r) => r._hasBoundary).length;
        const pagePoint = mapped.filter((r) => r._hasCoords && !r._hasBoundary).length;
        const pageNone = mapped.filter((r) => !r._hasCoords && !r._coordsInvalid).length;
        const pageBad = mapped.filter((r) => r._coordsInvalid).length;

        totalWithPolygon += pagePolygon;
        totalPointOnly += pagePoint;
        totalNoGeometry += pageNone;
        totalBadCoords += pageBad;

        const clean = mapped.map(
          ({ _hasCoords, _hasBoundary, _coordsInvalid, ...rest }) => rest
        );

        const offsetThisBatch = totalRecords;
        // Persist before progress so a crash still matches line count = next resultOffset
        appendRecords(clean);
        totalRecords += clean.length;

        const pageLabel = Math.floor(offsetThisBatch / PAGE_SIZE) + 1;
        log(
          `Page ${pageLabel} (offset ${offsetThisBatch}) — ${mapped.length} parcels | ` +
            `Polygons: ${pagePolygon} | Points: ${pagePoint} | ` +
            `No geometry: ${pageNone} | Bad coords: ${pageBad} | ` +
            `Total so far: ${totalRecords}`
        );

        saveProgress(totalRecords);

        if (result.features.length === PAGE_SIZE) {
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
    throw new Error('NLA page fetch: retry loop exited without result');
  }

  try {
    let continueLoop = true;
    while (continueLoop) {
      continueLoop = await fetchPage();
    }

    log('=== Fetch Complete ===');
    log(`Total parcels fetched:  ${totalRecords}`);
    if (totalRecords > 0) {
      log(
        `With polygon boundary:  ${totalWithPolygon} (${((totalWithPolygon / totalRecords) * 100).toFixed(1)}%)`
      );
      log(
        `With point only:        ${totalPointOnly}   (${((totalPointOnly / totalRecords) * 100).toFixed(1)}%)`
      );
      log(
        `No geometry:            ${totalNoGeometry}  (${((totalNoGeometry / totalRecords) * 100).toFixed(1)}%)`
      );
      log(
        `Bad / out-of-bounds:    ${totalBadCoords}   (${((totalBadCoords / totalRecords) * 100).toFixed(1)}%)`
      );
    }

    if (fs.existsSync(PROGRESS_FILE)) fs.unlinkSync(PROGRESS_FILE);
  } catch (err) {
    log(`FATAL ERROR: ${err.message}`);
    const onDisk = fs.existsSync(OUTPUT_FILE) ? await countNdjsonRecords(OUTPUT_FILE) : 0;
    log(`Records on disk: ${onDisk} (${OUTPUT_FILE}, NDJSON). In-memory count was ${totalRecords}.`);
    log('Re-run the script to resume from the last written lines (resultOffset = line count).');
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
