/**
 * Side-effect import. Put it FIRST in a test file that needs the real BullMQ
 * risk-review worker:
 *
 *   import './helpers/enable-risk-worker';
 *
 * Why an import and not a harness option: ConfigModule snapshots the
 * environment when AppModule is first imported, so the flag has to be set
 * before that import happens. Without it the worker stays off (setup-env.ts),
 * which keeps tests that edit application state by hand free of races.
 */
process.env.RISK_REVIEW_WORKER_ENABLED = 'true';
