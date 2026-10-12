import 'dotenv/config';
import Redis from 'ioredis';
import { DB_PREFIX, dropDatabasesStartingWith } from './helpers/test-database';

/**
 * Removes everything this e2e run created outside the test processes: its
 * Postgres databases (per-file clones and the template) and its Redis keys.
 * Both are scoped by the run id (see global-setup.ts), so a concurrent run and
 * the dev server's `bull:*` queue are never touched.
 */
export default async function globalTeardown(): Promise<void> {
  const runId = process.env.E2E_RUN_ID;
  if (!runId) {
    return; // never guess: without the run id we would not know what is ours
  }

  try {
    // clones from files that did not get to close, then the template
    await dropDatabasesStartingWith(`${DB_PREFIX}${runId}_`);
    await dropDatabasesStartingWith(`${DB_PREFIX}tpl_${runId}`);
  } catch {
    // Best effort: a leftover is swept by the next run once it is an hour old.
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
