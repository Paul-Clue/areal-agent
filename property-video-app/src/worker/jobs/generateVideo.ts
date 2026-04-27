import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Job } from 'bullmq';
import { pool } from '../../lib/db';
import { resolveBoundary } from '../../lib/boundary';
import { getParcelById, lookupProperty } from '../../lib/property';
import { isSpacesConfigured, uploadVideoToSpaces } from '../../lib/storage';
import type { VideoJobData } from '../../lib/queue';
import { selectRenderer } from '../lib/rendererSelector';
import { generateMapboxFrames } from '../lib/mapboxRenderer';
import { overlayFramesWithBoundary } from '../lib/overlayFrame';
import { toPolygonInput } from '../lib/geojsonPolygon';
import { runPostProcessChain } from '../lib/postProcess';
import { renderIntroOutroClips, type AgentRow } from '../lib/brandingFfmpeg';
import { runFfmpeg } from '../lib/ffmpegUtil';

function totalFramesCount(): number {
  const n = parseInt(process.env.VIDEO_TOTAL_FRAMES || '600', 10);
  return Math.max(60, Math.min(1200, n));
}

function outputBase(): string {
  return process.env.VIDEO_OUTPUT_DIR || path.join(process.cwd(), '.data', 'videos');
}

/** Loads a logo image into a local path for FFmpeg input. */
async function materializeLogo(logoRef: string, workDir: string): Promise<string | null> {
  const dest = path.join(workDir, 'logo_overlay.png');
  if (logoRef.startsWith('http://') || logoRef.startsWith('https://')) {
    const r = await fetch(logoRef);
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    await fs.writeFile(dest, buf);
    return dest;
  }
  if (logoRef.startsWith('file:')) {
    const src = fileURLToPath(logoRef);
    if (existsSync(src)) {
      await fs.copyFile(src, dest);
      return dest;
    }
  }
  if (path.isAbsolute(logoRef) && existsSync(logoRef)) {
    await fs.copyFile(logoRef, dest);
    return dest;
  }
  return null;
}

async function renameRawToPng(framesDir: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const r = path.join(framesDir, `frame_${String(i).padStart(4, '0')}.raw.png`);
    const p = path.join(framesDir, `frame_${String(i).padStart(4, '0')}.png`);
    if (existsSync(r)) {
      await fs.copyFile(r, p);
      await fs.unlink(r).catch(() => undefined);
    }
  }
}

/**
 * Full property video: Mapbox fly-through, boundary overlay, post-process, intro/outro, optional Spaces upload.
 */
export async function generateVideoJob(job: Job<VideoJobData>): Promise<string> {
  const { agentId, valuationNumber, nlaObjectId, customBoundary } = job.data;
  const jobId = String(job.id);
  const totalFrames = totalFramesCount();
  const outDir = outputBase();
  const workDir = path.join(outDir, 'work', jobId);
  const framesDir = path.join(workDir, 'frames');
  await fs.mkdir(framesDir, { recursive: true });

  try {
  const agentRes = await pool.query('SELECT * FROM agents WHERE id = $1', [agentId]);
  const agent = agentRes.rows[0] as Record<string, unknown> | undefined;
  if (!agent) throw new Error('AGENT_NOT_FOUND');

  let property;
  if (nlaObjectId) {
    property = await getParcelById(nlaObjectId);
  } else {
    const r = await lookupProperty(valuationNumber);
    if (r.type === 'not_found') throw new Error('PROPERTY_NOT_FOUND');
    if (r.type === 'multiple') throw new Error('PARCEL_SELECTION_REQUIRED');
    property = r.property;
  }
  if (!property) throw new Error('PROPERTY_NOT_FOUND');

  const boundary = (customBoundary as object) ?? resolveBoundary(property);
  await selectRenderer(property);

  await pool.query(
    `UPDATE jobs SET status = 'processing', renderer = 'mapbox' WHERE id = $1`,
    [jobId]
  );

  await generateMapboxFrames(property, framesDir, totalFrames);

  const centerLat = property.frame_latitude ?? property.latitude;
  const centerLon = property.frame_longitude ?? property.longitude;
  const poly = toPolygonInput(boundary as object);
  if (poly) {
    try {
      await overlayFramesWithBoundary(totalFrames, framesDir, { lat: centerLat, lon: centerLon }, poly);
    } catch (e) {
      await renameRawToPng(framesDir, totalFrames);
      console.warn('Boundary overlay failed, using raw frames:', e);
    }
  } else {
    await renameRawToPng(framesDir, totalFrames);
  }

  const baseMp4 = path.join(workDir, 'base.mp4');
  await runFfmpeg([
    '-framerate',
    '30',
    '-i',
    path.join(framesDir, 'frame_%04d.png'),
    '-vf',
    'format=yuv420p',
    '-c:v',
    'libx264',
    '-crf',
    '20',
    '-preset',
    'fast',
    baseMp4,
  ]);

  const postMp4 = path.join(workDir, 'post.mp4');
  await runPostProcessChain(baseMp4, postMp4);

  let aerial = postMp4;
  const logoRef = (agent.logo_url as string) || '';
  if (logoRef) {
    const logoPath = await materializeLogo(logoRef, workDir);
    if (logoPath) {
      const wm = path.join(workDir, 'watermark.mp4');
      await runFfmpeg([
        '-i',
        postMp4,
        '-i',
        logoPath,
        '-filter_complex',
        '[1:v]scale=150:-1[lg];[0:v][lg]overlay=W-w-20:H-h-20:format=auto',
        '-c:v',
        'libx264',
        '-crf',
        '18',
        '-preset',
        'medium',
        wm,
      ]);
      aerial = wm;
    }
  }

  const { intro, outro } = await renderIntroOutroClips(workDir, agent as AgentRow);

  const concatList = path.join(workDir, 'list.txt');
  const esc = (p: string) => p.replace(/'/g, "'\\''");
  await fs.writeFile(
    concatList,
    `file '${esc(intro)}'\nfile '${esc(aerial)}'\nfile '${esc(outro)}'\n`,
    'utf8'
  );

  const withMeta = path.join(workDir, 'with_metadata.mp4');
  await runFfmpeg([
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    concatList,
    '-c',
    'copy',
    path.join(workDir, 'combined.mp4'),
  ]);

  const combined = path.join(workDir, 'combined.mp4');
  const name = (agent.name as string) || '';
  const license = (agent.license_number as string) || '';
  await runFfmpeg([
    '-i',
    combined,
    '-metadata',
    'title=Property video',
    '-metadata',
    `agent_id=${String(agentId)}`,
    '-metadata',
    `agent_name=${name}`,
    '-metadata',
    `license=${license}`,
    '-metadata',
    'generated_by=PropertyVideoSaaS',
    '-c',
    'copy',
    withMeta,
  ]);

  const published = path.join(outDir, `${jobId}.mp4`);
  await fs.copyFile(withMeta, published);

  let outputUrl: string;
  if (isSpacesConfigured()) {
    const url = await uploadVideoToSpaces(published, jobId);
    outputUrl = url;
    try {
      await fs.unlink(published);
    } catch {
      // keep local if delete fails
    }
  } else {
    outputUrl = `local:${published}`;
  }

  await pool.query(
    `UPDATE jobs SET status = 'complete', output_url = $1, completed_at = NOW(), error_message = NULL WHERE id = $2`,
    [outputUrl, jobId]
  );
  await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);

  return outputUrl;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await pool
      .query(
        `UPDATE jobs SET status = 'failed', error_message = $1, completed_at = NOW() WHERE id = $2`,
        [msg.slice(0, 2000), jobId]
      )
      .catch(() => undefined);
    await fs.rm(path.join(outDir, 'work', jobId), { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
}
