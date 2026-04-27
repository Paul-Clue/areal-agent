import { Worker } from 'bullmq';
import { newRedisConnection } from '../lib/redisConnection';
import { VIDEO_QUEUE_NAME, type VideoJobData } from '../lib/queue';
import { pool } from '../lib/db';
import { generateVideoJob } from './jobs/generateVideo';

/**
 * Subscribes to `VIDEO_QUEUE_NAME` and runs `generateVideoJob` for each BullMQ item.
 * Run after `./env` has loaded `.env.local` (see `index.ts`).
 */
export function startWorker() {
  const connection = newRedisConnection();
  const worker = new Worker<VideoJobData>(
    VIDEO_QUEUE_NAME,
    async (job) => {
      await generateVideoJob(job);
    },
    { connection }
  );

  worker.on('failed', async (job, err) => {
    if (!job?.id) return;
    const d = job.data;
    if (!d?.agentId) return;
    await pool
      .query('UPDATE agents SET videos_used = GREATEST(videos_used - 1, 0) WHERE id = $1', [d.agentId])
      .catch(() => undefined);
    console.error('[worker] job failed', job.id, err);
  });

  worker.on('completed', (job) => {
    console.log('[worker] job completed', job.id);
  });

  const shutdown = async () => {
    await worker.close();
    await connection.quit();
    await pool.end();
  };

  process.on('SIGINT', () => {
    void shutdown().then(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void shutdown().then(() => process.exit(0));
  });

  console.log(`[worker] listening on queue "${VIDEO_QUEUE_NAME}" (Redis + FFmpeg + Mapbox).`);
  return worker;
}
