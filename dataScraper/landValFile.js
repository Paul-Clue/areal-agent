/**
 * landValFile.js
 *
 * land_val_numbers output is NDJSON (one compact JSON object per line) to avoid
 * V8 max string length on JSON.stringify of the full array (~400k+ parcels).
 * Legacy format: a single JSON array in land_val_numbers.json (pretty-printed).
 * Migration streams the legacy file and rewrites to NDJSON without loading all at once.
 */

const fs = require('fs');
const readline = require('readline');
const JSONStream = require('JSONStream');
const path = require('path');

const DEFAULT_LAND_VAL_FILE = 'land_val_numbers.json';

/**
 * Heuristic: first non-whitespace char is [ → legacy array export.
 * Reads only the first 8 KiB of the file.
 */
function isLegacyArrayFile(filePath) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) return false;
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, 8192, 0);
    return buf.subarray(0, n).toString('utf8').trimStart().startsWith('[');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * One streaming pass: array JSON → NDJSON in place, keeping a .legacy_backup copy.
 * Does not keep all records in memory.
 */
function migrateArrayToNdjson(filePath) {
  const tmpPath = filePath + '.ndjson_migrating';
  const out = fs.createWriteStream(tmpPath);
  const inStream = fs.createReadStream(filePath);
  const parser = inStream.pipe(JSONStream.parse('*'));

  return new Promise((resolve, reject) => {
    const onData = (obj) => {
      const line = JSON.stringify(obj) + '\n';
      if (!out.write(line)) {
        parser.pause();
        out.once('drain', () => parser.resume());
      }
    };
    const finishOut = (err) => {
      if (err) {
        out.destroy();
        try {
          if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch {
          /* ignore */
        }
        reject(err);
        return;
      }
      out.end();
    };
    parser.on('data', onData);
    parser.on('end', () => finishOut());
    parser.on('error', finishOut);
    out.on('error', finishOut);
    out.on('finish', () => {
      const backup = filePath + '.legacy_backup';
      try {
        if (fs.existsSync(backup)) fs.unlinkSync(backup);
        fs.renameSync(filePath, backup);
        fs.renameSync(tmpPath, filePath);
        resolve({ backupPath: backup });
      } catch (e) {
        reject(e);
      }
    });
  });
}

/**
 * Resolves a path under dataScraper (cwd when scripts run) or the given filePath.
 */
function resolveFile(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
}

/**
 * If the file is a legacy array, migrates to NDJSON. No-op for NDJSON.
 * @param {string} [filePath=DEFAULT_LAND_VAL_FILE] — relative to cwd
 */
async function ensureNdjson(filePath = DEFAULT_LAND_VAL_FILE) {
  const p = resolveFile(filePath);
  if (!fs.existsSync(p)) return { migrated: false, path: p };
  if (isLegacyArrayFile(p)) {
    const { backupPath } = await migrateArrayToNdjson(p);
    return { migrated: true, path: p, backupPath };
  }
  return { migrated: false, path: p };
}

/**
 * Counts non-empty lines (one record per line in NDJSON; compact lines have no embedded newlines).
 */
function countNdjsonRecords(filePath) {
  const p = resolveFile(filePath);
  return new Promise((resolve, reject) => {
    let n = 0;
    const rl = readline.createInterface({
      input: fs.createReadStream(p),
      crlfDelay: Infinity,
    });
    rl.on('line', (line) => {
      if (line.trim()) n++;
    });
    rl.on('close', () => resolve(n));
    rl.on('error', reject);
  });
}

/**
 * Yields one parcel record at a time. Supports NDJSON or legacy array (streamed, no full-buffer parse).
 * @param {string} [filePath=DEFAULT_LAND_VAL_FILE]
 */
async function* iterateLandValRecords(filePath = DEFAULT_LAND_VAL_FILE) {
  const p = resolveFile(filePath);
  if (!fs.existsSync(p)) throw new Error(`File not found: ${p}`);
  if (isLegacyArrayFile(p)) {
    // JSONStream is not async-iterable; bridge with a queue
    const inStream = fs.createReadStream(p);
    const parser = inStream.pipe(JSONStream.parse('*'));
    const queue = [];
    let ended = false;
    let errH;
    let waitNext = null;
    const notify = () => {
      if (waitNext) {
        const r = waitNext;
        waitNext = null;
        r();
      }
    };
    parser.on('data', (item) => {
      queue.push(item);
      notify();
    });
    parser.on('end', () => {
      ended = true;
      notify();
    });
    parser.on('error', (e) => {
      errH = e;
      notify();
    });
    try {
      while (!errH) {
        if (queue.length) {
          yield queue.shift();
        } else if (ended) {
          break;
        } else {
          await new Promise((res) => {
            waitNext = res;
          });
        }
      }
    } finally {
      inStream.destroy();
    }
    if (errH) throw errH;
  } else {
    const rl = readline.createInterface({
      input: fs.createReadStream(p),
      crlfDelay: Infinity,
    });
    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        yield JSON.parse(line);
      }
    } finally {
      rl.close();
    }
  }
}

module.exports = {
  DEFAULT_LAND_VAL_FILE,
  isLegacyArrayFile,
  migrateArrayToNdjson,
  ensureNdjson,
  countNdjsonRecords,
  iterateLandValRecords,
  resolveFile,
};
