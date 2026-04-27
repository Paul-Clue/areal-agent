import IORedis from 'ioredis';

const lazyOpts = { maxRetriesPerRequest: null, lazyConnect: true } as const;

function createConnection(): IORedis {
  const url = process.env.REDIS_URL;
  if (url) {
    return new IORedis(url, { ...lazyOpts });
  }
  return new IORedis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    ...lazyOpts,
  });
}

/** New IORedis instance; BullMQ recommends separate connections for queue vs worker. */
export function newRedisConnection(): IORedis {
  return createConnection();
}

let shared: IORedis | undefined;

/** Shared IORedis for the API-side BullMQ `Queue` (singleton). */
export function getSharedQueueConnection(): IORedis {
  if (!shared) shared = createConnection();
  return shared;
}
