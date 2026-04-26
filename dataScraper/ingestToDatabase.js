/**
 * ingestToDatabase.js
 *
 * Streams land_val_numbers.json (NDJSON: one object per line; legacy array is
 * auto-migrated) and inserts into the PostgreSQL properties table.
 *
 * Run:    node ingestToDatabase.js
 * Safe:   uses ON CONFLICT DO UPDATE — re-runnable without duplicating data.
 *
 * Uses DATABASE_URL from .env (admin/doadmin for bulk load per databasePlanv2.md).
 */

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const {
  ensureNdjson,
  countNdjsonRecords,
  iterateLandValRecords,
  DEFAULT_LAND_VAL_FILE,
} = require('./landValFile');

const INPUT_FILE = DEFAULT_LAND_VAL_FILE;
const BATCH_SIZE = 500;
const LOG_FILE = 'ingest_log.txt';

// Postgres.app / local dev: no SSL. Hosted (DO, etc.): require TLS.
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

function geojsonToWKT(geojson) {
  if (!geojson || geojson.type !== 'Polygon') return null;
  try {
    const ring = geojson.coordinates[0].map(([lng, lat]) => `${lng} ${lat}`).join(', ');
    return `POLYGON((${ring}))`;
  } catch {
    return null;
  }
}

async function insertBatch(client, batch) {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const record of batch) {
    if (!record.lvNumber || record.lvNumber.trim() === '') {
      skipped++;
      continue;
    }

    const boundaryWKT = geojsonToWKT(record.boundaryGeojson);
    const centroidWKT =
      record.latitude && record.longitude ? `POINT(${record.longitude} ${record.latitude})` : null;

    try {
      const result = await client.query(
        `
        INSERT INTO properties (
          nla_object_id, valuation_number, folio_number,
          street_address, scheme_address, parish, location,
          latitude, longitude, centroid, boundary, boundary_geojson,
          last_fetched_at
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,
          CASE WHEN $10::text IS NOT NULL AND btrim($10::text) <> ''
            THEN ST_GeographyFromText('SRID=4326;'||$10::text) ELSE NULL END,
          CASE WHEN $11::text IS NOT NULL AND btrim($11::text) <> ''
            THEN ST_GeographyFromText('SRID=4326;'||$11::text) ELSE NULL END,
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
      `,
        [
          record.nlaObjectId || null,
          record.lvNumber.trim(),
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
        ]
      );

      if (result.rows[0]?.was_inserted) inserted++;
      else updated++;
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

  if (!process.env.DATABASE_URL) {
    log('FATAL: DATABASE_URL is not set. Add it to dataScraper/.env');
    process.exit(1);
  }

  if (!fs.existsSync(INPUT_FILE)) {
    log(`FATAL: ${INPUT_FILE} not found. Run the fetch script first.`);
    process.exit(1);
  }

  const m = await ensureNdjson(INPUT_FILE);
  if (m.migrated) {
    log(`Migrated legacy file to NDJSON. Backup: ${m.backupPath || 'n/a'}`);
  }

  let totalRows;
  try {
    totalRows = await countNdjsonRecords(INPUT_FILE);
  } catch (err) {
    log(`FATAL: Cannot read ${INPUT_FILE}: ${err.message}`);
    process.exit(1);
  }
  log(`Streaming ${totalRows} record(s) from ${INPUT_FILE} (NDJSON)`);

  let client;
  try {
    client = await pool.connect();
    log('Database connection successful');
  } catch (err) {
    log(`FATAL: Cannot connect to database: ${err.message}`);
    log('Check that DATABASE_URL is set correctly in .env');
    process.exit(1);
  }

  let totalInserted = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let batchNumber = 0;
  let batch = [];
  let processed = 0;

  try {
    for await (const record of iterateLandValRecords(INPUT_FILE)) {
      batch.push(record);
      if (batch.length < BATCH_SIZE) continue;

      batchNumber++;
      const currentBatch = batch;
      batch = [];

      await client.query('BEGIN');
      try {
        const { inserted, updated, skipped } = await insertBatch(client, currentBatch);
        await client.query('COMMIT');

        totalInserted += inserted;
        totalUpdated += updated;
        totalSkipped += skipped;
        processed += currentBatch.length;

        const pct = totalRows ? Math.round((processed / totalRows) * 100) : 0;
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

    if (batch.length) {
      batchNumber++;
      await client.query('BEGIN');
      try {
        const { inserted, updated, skipped } = await insertBatch(client, batch);
        await client.query('COMMIT');
        totalInserted += inserted;
        totalUpdated += updated;
        totalSkipped += skipped;
        processed += batch.length;
        const pct = totalRows ? Math.round((processed / totalRows) * 100) : 0;
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
