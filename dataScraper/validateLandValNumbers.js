/**
 * validateLandValNumbers.js — databasePlanv2.md Step 4
 *
 * Coverage analysis and stop-condition checks on land_val_numbers.json
 * (NDJSON: one object per line, or legacy single JSON array — streamed).
 *
 * Usage: node validateLandValNumbers.js [path/to/land_val_numbers.json]
 * Exit 0: no stop conditions triggered
 * Exit 1: one or more stop conditions (see databasePlanv2.md Step 4)
 */

const { ensureNdjson, iterateLandValRecords, DEFAULT_LAND_VAL_FILE } = require('./landValFile');

const inputFile = process.argv[2] || DEFAULT_LAND_VAL_FILE;

const JAMAICA_PARISHES = [
  'CLARENDON',
  'HANOVER',
  'KINGSTON',
  'MANCHESTER',
  'PORTLAND',
  'ST. ANDREW',
  'ST. ANN',
  'ST. CATHERINE',
  'ST. ELIZABETH',
  'ST. JAMES',
  'ST. MARY',
  'ST. THOMAS',
  'TRELAWNY',
  'WESTMORELAND',
];

async function main() {
  const fs = require('fs');
  if (!fs.existsSync(inputFile)) {
    console.error(`File not found: ${inputFile}`);
    process.exit(1);
  }

  const fsMeta = await ensureNdjson(inputFile);
  if (fsMeta.migrated) {
    console.log(`Migrated legacy file to NDJSON. Backup: ${fsMeta.backupPath || 'n/a'}`);
  }

  const data = await collectStats(inputFile);

  const n = data.n;
  const withPolygon = data.withPolygon;
  const withCoords = data.withCoords;
  const noCoords = data.noCoords;
  const missingLvNum = data.missingLvNum;
  const duplicateLvNums = data.duplicateLvNums;
  const allZero = data.allZero;
  const parishes = data.parishes;

  const pctCoords = n ? (withCoords / n) * 100 : 0;
  const dupRate = n ? (duplicateLvNums / n) * 100 : 0;
  const missingLvRate = n ? (missingLvNum / n) * 100 : 0;

  console.log('=== Coverage Report ===');
  console.log('Total records:         ', n);
  console.log(
    'With polygon boundary: ',
    withPolygon,
    '(' + ((n ? withPolygon / n : 0) * 100).toFixed(1) + '%)'
  );
  console.log('With coordinates:      ', withCoords, '(' + pctCoords.toFixed(1) + '%)');
  console.log('No coordinates:        ', noCoords, '(' + ((n ? noCoords / n : 0) * 100).toFixed(1) + '%)');
  console.log('All-zero coordinates:  ', allZero);
  console.log('Missing LV number:     ', missingLvNum);
  console.log('Duplicate LV numbers:  ', duplicateLvNums);
  console.log('');
  console.log('=== By Parish ===');
  Object.entries(parishes)
    .sort((a, b) => b[1] - a[1])
    .forEach(([p, c]) => console.log(p.padEnd(30), c));

  const stopReasons = [];

  const allCoordsAreZeroZero = withCoords > 0 && allZero === withCoords;
  if (n && (pctCoords < 50 || allCoordsAreZeroZero)) {
    stopReasons.push(
      'Stop 1: Less than 50% with coordinates OR all stored coordinates are 0,0 (see plan Step 4 — Stop 1).'
    );
  }
  if (dupRate > 1) {
    stopReasons.push(
      `Stop 2: Duplicate LV rate ${dupRate.toFixed(2)}% exceeds 1% (plan Step 4 — Stop 2).`
    );
  }
  if (missingLvRate > 5) {
    stopReasons.push(
      `Stop 3: Missing LV rate ${missingLvRate.toFixed(2)}% exceeds 5% (plan Step 4 — Stop 3).`
    );
  }

  const missingParishes = JAMAICA_PARISHES.filter((p) => !data.presentParishSet.has(p));
  if (missingParishes.length > 0 && n > 0) {
    stopReasons.push(
      `Stop 4: Fewer than 14 parishes present in data. Missing: ${missingParishes.join(', ')} (plan Step 4 — Stop 4).`
    );
  }

  if (stopReasons.length) {
    console.log('');
    console.log('=== STOP — resolve per databasePlanv2.md before ingestion ===');
    stopReasons.forEach((r) => console.log('-', r));
    process.exit(1);
  }

  console.log('');
  console.log('No Step 4 stop conditions triggered. Proceed to ingestToDatabase.js');
  process.exit(0);
}

/** Single streaming pass: aggregate stats (no full-file JSON.parse). */
async function collectStats(filePath) {
  let n = 0;
  let withPolygon = 0;
  let withCoords = 0;
  let noCoords = 0;
  let missingLvNum = 0;
  let allZero = 0;
  const parishes = {};
  const uniqueLv = new Set();
  const presentParishSet = new Set();

  for await (const r of iterateLandValRecords(filePath)) {
    n++;
    if (r.boundaryGeojson != null) withPolygon++;
    if (r.latitude != null) withCoords++;
    if (r.latitude == null) noCoords++;
    if (!r.lvNumber || r.lvNumber.trim() === '') missingLvNum++;
    if (r.latitude === 0 && r.longitude === 0) allZero++;
    const p = r.parish || 'UNKNOWN';
    parishes[p] = (parishes[p] || 0) + 1;
    uniqueLv.add(r.lvNumber);
    // NLA often uses "ST.  ANDREW" (double space); collapse for Stop 4 vs JAMAICA_PARISHES.
    const pu = (r.parish || '').trim().toUpperCase().replace(/\s+/g, ' ');
    if (pu) presentParishSet.add(pu);
  }

  const duplicateLvNums = n - uniqueLv.size;
  return {
    n,
    withPolygon,
    withCoords,
    noCoords,
    missingLvNum,
    allZero,
    duplicateLvNums,
    parishes,
    presentParishSet,
  };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
