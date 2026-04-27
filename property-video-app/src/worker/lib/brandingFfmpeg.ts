import fs from 'node:fs/promises';
import path from 'node:path';
import { runFfmpeg } from './ffmpegUtil';

export type AgentRow = {
  name: string | null;
  company: string | null;
  tagline: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  license_number: string | null;
  brand_color: string | null;
};

/**
 * Builds 3s intro and 5s outro with plain FFmpeg drawtext (no node-canvas).
 */
export async function renderIntroOutroClips(
  workDir: string,
  agent: AgentRow
): Promise<{ intro: string; outro: string }> {
  const line1 = path.join(workDir, 'intro1.txt');
  const line2 = path.join(workDir, 'intro2.txt');
  const line3 = path.join(workDir, 'intro3.txt');
  await fs.writeFile(line1, agent.name || 'Agent', 'utf8');
  await fs.writeFile(line2, agent.company || ' ', 'utf8');
  await fs.writeFile(line3, agent.tagline || ' ', 'utf8');

  const intro = path.join(workDir, 'intro_brand.mp4');
  const color = (agent.brand_color || '#00ff00').replace('#', '0x');
  await runFfmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=1920x1080:d=3:r=30',
    '-vf',
    `drawtext=font=Sans:fontcolor=white:fontsize=64:x=(w-text_w)/2:y=h*0.38:textfile=${line1},drawtext=font=Sans:fontcolor=${color}:fontsize=40:x=(w-text_w)/2:y=h*0.48:textfile=${line2},drawtext=font=Sans:fontcolor=gray:fontsize=28:x=(w-text_w)/2:y=h*0.58:textfile=${line3},format=yuv420p`,
    '-c:v',
    'libx264',
    '-crf',
    '20',
    '-preset',
    'medium',
    intro,
  ]);

  const o1 = path.join(workDir, 'out1.txt');
  const o2 = path.join(workDir, 'out2.txt');
  const o3 = path.join(workDir, 'out3.txt');
  const o4 = path.join(workDir, 'out4.txt');
  const o5 = path.join(workDir, 'out5.txt');
  await fs.writeFile(o1, agent.name || ' ', 'utf8');
  await fs.writeFile(o2, agent.company || ' ', 'utf8');
  await fs.writeFile(o3, [agent.phone, agent.email, agent.website].filter(Boolean).join(' · ') || ' ', 'utf8');
  await fs.writeFile(
    o4,
    agent.license_number ? `License: ${agent.license_number}` : ' ',
    'utf8'
  );
  await fs.writeFile(o5, 'Call for a viewing', 'utf8');

  const outro = path.join(workDir, 'outro_brand.mp4');
  await runFfmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=c=0x101010:s=1920x1080:d=5:r=30',
    '-vf',
    `drawtext=font=Sans:fontcolor=white:fontsize=56:x=(w-text_w)/2:y=h*0.25:textfile=${o1},drawtext=font=Sans:fontcolor=${color}:fontsize=40:x=(w-text_w)/2:y=h*0.35:textfile=${o2},drawtext=font=Sans:fontcolor=0xcccccc:fontsize=32:x=(w-text_w)/2:y=h*0.45:textfile=${o3},drawtext=font=Sans:fontcolor=0xaaaaaa:fontsize=30:x=(w-text_w)/2:y=h*0.55:textfile=${o4},drawtext=font=Sans:fontcolor=white:fontsize=44:x=(w-text_w)/2:y=h*0.75:textfile=${o5},format=yuv420p`,
    '-c:v',
    'libx264',
    '-crf',
    '20',
    '-preset',
    'medium',
    outro,
  ]);

  return { intro, outro };
}
