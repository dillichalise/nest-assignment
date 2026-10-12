/**
 * Runs before every e2e test file (jest `setupFiles`), before any app module
 * is imported. Safe defaults so no suite can touch another environment's queue
 * or run a background worker it did not ask for.
 */
import { assertSafeTestDatabaseName, DB_PREFIX } from './helpers/test-database';

const runId = process.env.E2E_RUN_ID;
if (!runId || !process.env.E2E_TEMPLATE_DB) {
  throw new Error(
    'E2E_RUN_ID / E2E_TEMPLATE_DB are not set. Run the suite with `npm run test:e2e` ' +
      '(jest --config test/jest-e2e.json), whose global setup provisions the test databases.',
  );
}
const unique = `e2e-${runId}-${Math.random().toString(36).slice(2, 8)}`;

// Own database for this test file, cloned from the migrated template by the
// harness. Set unconditionally and checked: a DB_NAME from the shell or .env
// (i.e. the dev database) must never win here.
const databaseName = `${DB_PREFIX}${runId}_${Math.random().toString(36).slice(2, 8)}`;
process.env.E2E_DB_NAME = databaseName;
process.env.DB_NAME = assertSafeTestDatabaseName(databaseName);

// Own Redis key prefix: test jobs can never reach a dev server's worker.
process.env.QUEUE_PREFIX = unique;
// Off unless a suite opts in: a live worker would race tests that set
// application state by hand. Set UNCONDITIONALLY: the dev .env (which says
// `true`) is loaded into the parent process by global setup and inherited here.
// A suite that wants the worker imports ./helpers/enable-risk-worker, which runs
// after this file and before the app module.
process.env.RISK_REVIEW_WORKER_ENABLED = 'false';
process.env.RISK_REVIEW_BACKOFF_MS = '50';
process.env.RISK_REVIEW_ATTEMPTS = '3';
process.env.RISK_REVIEW_CONCURRENCY = '5';
process.env.RISK_SIM_LATENCY_MS = '0';
process.env.RISK_SIM_FAILURE_RATE = '0';
