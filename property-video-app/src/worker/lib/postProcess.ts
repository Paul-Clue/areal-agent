import path from 'node:path';
import { runFfmpeg } from './ffmpegUtil';

/**
 * Chained enhancement pass (FFmpeg only — no external LUT; matches planv6 “curves” style).
 * Input and output are absolute paths to MP4 (or any container FFmpeg accepts).
 */
export async function runPostProcessChain(inputMp4: string, outputMp4: string): Promise<void> {
  const dir = path.dirname(outputMp4);
  const v1 = path.join(dir, 'post_vignette.mp4');
  const v2 = path.join(dir, 'post_tmix.mp4');
  const v3 = path.join(dir, 'post_grain.mp4');
  const graded = path.join(dir, 'post_graded.mp4');

  await runFfmpeg([
    '-i',
    inputMp4,
    '-vf',
    "curves=r='0/0 0.5/0.6 1/1':g='0/0 0.5/0.52 1/0.95':b='0/0.05 0.5/0.45 1/0.85',format=yuv420p",
    '-c:v',
    'libx264',
    '-crf',
    '20',
    '-preset',
    'medium',
    graded,
  ]);

  await runFfmpeg([
    '-i',
    graded,
    '-vf',
    'vignette=PI/4,format=yuv420p',
    '-c:v',
    'libx264',
    '-crf',
    '20',
    '-preset',
    'medium',
    v1,
  ]);

  await runFfmpeg([
    '-i',
    v1,
    '-vf',
    "tmix=frames=3:weights='1 2 1',format=yuv420p",
    '-c:v',
    'libx264',
    '-crf',
    '20',
    '-preset',
    'medium',
    v2,
  ]);

  await runFfmpeg([
    '-i',
    v2,
    '-vf',
    'noise=alls=6:allf=t+u,scale=1920:1080:flags=lanczos,format=yuv420p',
    '-c:v',
    'libx264',
    '-crf',
    '18',
    '-preset',
    'slow',
    '-movflags',
    '+faststart',
    v3,
  ]);

  await runFfmpeg(['-i', v3, '-c', 'copy', outputMp4]);
}
