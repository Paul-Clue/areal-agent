import { Queue } from 'bullmq';
import { getSharedQueueConnection } from './redisConnection';

export const VIDEO_QUEUE_NAME = 'video-generation';

export type VideoJobData = {
  agentId: string;
  valuationNumber: string;
  nlaObjectId: number | null;
  customBoundary: object | null;
};

let _queue: Queue<VideoJobData, unknown, string> | null = null;

/** Lazy BullMQ queue so importing this module (e.g. at build) does not connect to Redis. */
export function getVideoQueue() {
  if (!_queue) {
    _queue = new Queue(VIDEO_QUEUE_NAME, {
      connection: getSharedQueueConnection(),
    });
  }
  return _queue;
}
