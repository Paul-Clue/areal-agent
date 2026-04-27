import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Runs `ffmpeg` with the given args (after `-y`). Fails with stderr if the exit code is non-zero. */
export async function runFfmpeg(args: string[]): Promise<void> {
  await execFileAsync('ffmpeg', ['-y', ...args], { maxBuffer: 32 * 1024 * 1024 });
}
