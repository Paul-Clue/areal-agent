/**
 * ingestParcels.js — docs/databaseUpdate.md Step 5
 *
 * Reads land_val_numbers.json (NDJSON or legacy array) and upserts every
 * NLA feature into property_parcels. Does not modify the properties table.
 *
 * Run:    node ingestParcels.js
 * Requires: DATABASE_URL, schema from database/update_property_parcels_v1.sql
 */

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const {
  ensureNdjson,
  iterateLandValRecords,
  DEFAULT_LAND_VAL_FILE,
} = require('./landValFile');

// Match Step 5 clarification: most_complete_address (see databaseUpdate.md)
const CANONICAL_METHOD = 'most_complete_address';

const INPUT_FILE = DEFAULT_LAND_VAL_FILE;
const BATCH_SIZE = 500;
const LOG_FILE = 'ingest_parcels_log.txt';

const dbUrl = process.env.DATABASE_URL || '';
const useSsl = dbUrl && !/localhost|127\.0\.0\.1/.test(dbUrl);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function checkCompleteness(record) {
  const reasons = [];

  if (record.lvNumber && record.lvNumber.trim().endsWith('---')) {
    reasons.push('LV number ends in ---');
  }

  const hasNoFolio = !record.volFol || record.volFol.trim() === '';
  const hasNoParish = !record.parish || record.parish.trim() === '';
  if (hasNoFolio && hasNoParish) {
    reasons.push('null folio and null parish');
  }

  const hasNoStreet =
    !record.streetAdd ||
    record.streetAdd.trim() === '' ||
    record.streetAdd.trim() === ' ';
  const hasNoScheme =
    !record.schemeAdd ||
    record.schemeAdd.trim() === '' ||
    record.schemeAdd.trim() === ' ';
  const hasNoLocation =
    !record.location ||
    record.location.trim() === '' ||
    record.location.trim() === ' ';
  if (hasNoStreet && hasNoScheme && hasNoLocation) {
    reasons.push('all address fields are null or blank');
  }

  return {
    isIncomplete: reasons.length > 0,
    incompleteReason: reasons.length > 0 ? reasons.join('; ') : null,
  };
}

function ringVertexCount(record) {
  try {
    return record.boundaryGeojson?.coordinates?.[0]?.length ?? 0;
  } catch {
    return 0;
  }
}

function computeCanonicalScore(record) {
  if (CANONICAL_METHOD === 'most_complete_address') {
    let score = 0;
    if (record.streetAdd && record.streetAdd.trim() !== '' && record.streetAdd.trim() !== ' ')
      score += 4;
    if (record.schemeAdd && record.schemeAdd.trim() !== '' && record.schemeAdd.trim() !== ' ')
      score += 3;
    if (record.location && record.location.trim() !== '' && record.location.trim() !== ' ')
      score += 2;
    if (record.volFol && record.volFol.trim() !== '') score += 2;
    if (record.parish && record.parish.trim() !== '') score += 1;
    if (record.boundaryGeojson) {
      try {
        const ring = record.boundaryGeojson.coordinates[0];
        score += Math.min(ring.length / 100, 1);
      } catch {
        /* ignore */
      }
    }
    return score;
  }

  if (CANONICAL_METHOD === 'largest_boundary') {
    return ringVertexCount(record);
  }

  if (CANONICAL_METHOD === 'first_fetched') {
    return record.nlaObjectId ? 1 / record.nlaObjectId : 0;
  }

  return 0;
}

/** Deterministic ordering: score desc, larger polygon, lower nla_object_id. */
function compareCanonical(a, b) {
  if (b._score !== a._score) return b._score - a._score;
  const lenB = ringVertexCount(b);
  const lenA = ringVertexCount(a);
  if (lenB !== lenA) return lenB - lenA;
  return (a.nlaObjectId || 0) - (b.nlaObjectId || 0);
}

function geojsonToWKT(geojson) {
  if (!geojson || geojson.type !== 'Polygon') return null;
  try {
    const ring = geojson.coordinates[0].map(([lng, lat]) => `${lng} ${lat}`).join(', ');
    return `POLYGON((${ring}))`;
  } catch {
    return null;
  }
}

function groupAndRank(records) {
  const groups = Object.create(null);
  for (const record of records) {
    const lv = (record.lvNumber || '').trim();
    if (!lv) continue;
    if (!groups[lv]) groups[lv] = [];
    groups[lv].push(record);
  }

  const ranked = [];
  for (const parcels of Object.values(groups)) {
    const sorted = parcels
      .map((p) => ({ ...p, _score: computeCanonicalScore(p) }))
      .sort(compareCanonical);

    sorted.forEach((parcel, i) => {
      ranked.push({
        ...parcel,
        _siblingIndex: i + 1,
        _totalSiblings: sorted.length,
      });
    });
  }
  return ranked;
}

async function insertParcelBatch(client, batch) {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const record of batch) {
    const lv = (record.lvNumber || '').trim();
    if (!lv) {
      skipped++;
      continue;
    }
    if (!record.nlaObjectId) {
      skipped++;
      continue;
    }

    const { isIncomplete, incompleteReason } = checkCompleteness(record);
    const boundaryWKT = geojsonToWKT(record.boundaryGeojson);
    const centroidWKT =
      record.latitude && record.longitude
        ? `POINT(${record.longitude} ${record.latitude})`
        : null;

    try {
      const result = await client.query(
        `
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
          CASE WHEN $10::text IS NOT NULL AND btrim($10::text) <> ''
            THEN ST_GeographyFromText('SRID=4326;' || $10::text)
            ELSE NULL END,
          CASE WHEN $11::text IS NOT NULL AND btrim($11::text) <> ''
            THEN ST_GeographyFromText('SRID=4326;' || $11::text)
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
      `,
        [
          record.nlaObjectId,
          lv,
          record.volFol || null,
          record.streetAdd || null,
          record.schemeAdd || null,
          record.parish || null,
          record.location || null,
          record.latitude || null,
          record.longitude || null,
          centroidWKT,
          boundaryWKT,
          record.boundaryGeojson ? JSON.stringify(record.boundaryGeojson) : null,
          isIncomplete,
          incompleteReason,
          record._siblingIndex || null,
        ]
      );

      if (result.rows[0]?.was_inserted) inserted++;
      else updated++;
    } catch (err) {
      log(`SKIP nla_object_id=${record.nlaObjectId} lv=${lv}: ${err.message}`);
      skipped++;
    }
  }

  return { inserted, updated, skipped };
}

(async () => {
  fs.writeFileSync(LOG_FILE, '');
  log('=== Parcel Ingestion Started ===');
  log(`Canonical method: ${CANONICAL_METHOD}`);

  const migrated = await ensureNdjson(INPUT_FILE);
  if (migrated.migrated) {
    log(`Migrated legacy JSON to NDJSON. Backup: ${migrated.backupPath || 'n/a'}`);
  }

  log(`Loading and grouping ${INPUT_FILE} (memory-intensive for large files)...`);
  const raw = [];
  let lineN = 0;
  for await (const r of iterateLandValRecords(INPUT_FILE)) {
    raw.push(r);
    lineN++;
    if (lineN % 100000 === 0) log(`  ... read ${lineN} records`);
  }
  log(`Loaded ${raw.length} records`);

  log('Grouping by valuation number and assigning sibling_index...');
  const ranked = groupAndRank(raw);
  raw.length = 0;

  const multiParcelCount = ranked.filter((r) => r._totalSiblings > 1).length;
  const singleCount = ranked.filter((r) => r._totalSiblings === 1).length;
  log(`Rows to upsert: ${ranked.length}`);
  log(`Single-parcel LV rows: ${singleCount}`);
  log(`Rows belonging to multi-parcel LVs: ${multiParcelCount}`);

  let client;
  try {
    client = await pool.connect();
    log('Database connection successful');
  } catch (err) {
    log(`FATAL: Cannot connect to database: ${err.message}`);
    process.exit(1);
  }

  const pre = await client.query('SELECT COUNT(*)::bigint AS n FROM properties');
  const propertiesCount = Number(pre.rows[0].n);
  if (propertiesCount === 0) {
    log(
      'FATAL: properties table is empty. property_parcels.valuation_number '
        + 'references properties(valuation_number). Run Phase 0 ingest first: '
        + 'npm run ingest (ingestToDatabase.js), then npm run ingest-parcels.'
    );
    client.release();
    await pool.end();
    process.exit(1);
  }
  log(`Preflight OK: ${propertiesCount} row(s) in properties (FK target for parcels)`);

  let totalInserted = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let batchNum = 0;

  try {
    // No per-batch transaction: row-level SKIP must not poison the rest of the batch
    // (PostgreSQL aborts the whole txn after the first failed statement).
    for (let i = 0; i < ranked.length; i += BATCH_SIZE) {
      const batch = ranked.slice(i, i + BATCH_SIZE);
      batchNum++;

      const { inserted, updated, skipped } = await insertParcelBatch(client, batch);

      totalInserted += inserted;
      totalUpdated += updated;
      totalSkipped += skipped;

      const pct = Math.round(((i + batch.length) / ranked.length) * 100);
      log(
        `Batch ${batchNum} (${pct}%) — ` +
          `Inserted: ${inserted} | Updated: ${updated} | Skipped: ${skipped} | ` +
          `Running totals — Inserted: ${totalInserted} | Updated: ${totalUpdated}`
      );
    }

    log('=== Parcel Ingestion Complete ===');
    log(`Total inserted: ${totalInserted}`);
    log(`Total updated:  ${totalUpdated}`);
    log(`Total skipped:  ${totalSkipped}`);
  } finally {
    client.release();
    await pool.end();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
