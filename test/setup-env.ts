/**
 * Runs before every e2e test file (jest `setupFiles`), before any app module
 * is imported. Safe defaults so no suite can touch another environment's queue
 * or run a background worker it did not ask for.
 */
const unique = `e2e-${process.env.E2E_RUN_ID ?? process.pid}-${Math.random().toString(36).slice(2, 8)}`;

// Own Redis key prefix: test jobs can never reach a dev server's worker.
process.env.QUEUE_PREFIX = unique;
// Off unless a suite opts in: a live worker would race tests that set
// application state by hand.
process.env.RISK_REVIEW_WORKER_ENABLED ??= 'false';
process.env.RISK_REVIEW_BACKOFF_MS = '50';
process.env.RISK_REVIEW_ATTEMPTS = '3';
process.env.RISK_REVIEW_CONCURRENCY = '5';
process.env.RISK_SIM_LATENCY_MS = '0';
process.env.RISK_SIM_FAILURE_RATE = '0';
