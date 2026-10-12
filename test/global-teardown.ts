import 'dotenv/config';
import Redis from 'ioredis';

/** Deletes every Redis key created by this e2e run (see global-setup.ts). */
export default async function globalTeardown(): Promise<void> {
  const runId = process.env.E2E_RUN_ID;
  if (!runId) {
    return; // never guess: without the run id we would not know what is ours
  }
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  try {
    await redis.connect();
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(
        cursor,
        'MATCH',
        `e2e-${runId}-*`,
        'COUNT',
        500,
      );
      cursor = next;
      if (keys.length) {
        await redis.del(...keys);
      }
    } while (cursor !== '0');
  } catch {
    // Cleanup is best effort; a Redis hiccup must not fail the test run.
  } finally {
    redis.disconnect();
  }
}
