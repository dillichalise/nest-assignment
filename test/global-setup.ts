/**
 * Runs once in the Jest parent process, before any worker starts. The id is
 * inherited by the workers (setup-env.ts puts it in every queue prefix) and
 * lets global-teardown.ts remove exactly this run's Redis keys, and nobody
 * else's: not a concurrent run, not the dev server's `bull:*` queue.
 */
export default function globalSetup(): void {
  process.env.E2E_RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
