# Testing

Two layers, both with Jest.

| Layer | Command | Needs | Time |
|---|---|---|---|
| Unit | `npm test` | nothing (no database, no Redis, no network) | ~5 s |
| End-to-end / API | `npm run test:e2e` | `npm run docker:up` (Postgres + Redis) | ~10 s |

`npm run test:cov` prints unit-test coverage (report in `coverage/`, which is git-ignored).

## Unit tests (`src/**/*.spec.ts`)

Next to the code they test. Repositories, the queue, the clock and the audit
recorder are mocked; `src/common/testing/fake-data-source.ts` stands in for a
`DataSource` so code that writes inside a transaction can be tested.

They are written to catch regressions in **business rules**, not to hit a coverage
number. As a check, the suite was mutation-tested: about 140 deliberate bugs
(remove an ownership check, flip a boundary, drop a compare-and-set, disable a
redaction, revert the 3-second-JWT bug) were applied one at a time and every one
of them is caught by at least one test.

## End-to-end tests (`test/*.e2e-spec.ts`)

They boot the real Nest application against real Postgres and Redis and drive it
over HTTP with Supertest. Only the third-party risk provider is replaced (a
scripted double), so tests can force failures and hold jobs mid-flight.

```bash
npm run docker:up        # Postgres on :5433, Redis on :6379
npm run test:e2e         # the whole suite
npm run test:e2e -- authorization          # one file
npm run test:e2e -- --randomize            # random test order (a determinism check)
npm run test:e2e -- --runInBand            # serial
```

The database user needs `CREATEDB` (the docker-compose `postgres` user has it). If
your server has no `postgres` maintenance database, set `E2E_ADMIN_DB`.

### Isolation: nothing to clean up, nothing shared

* **Per-file databases.** Once per run, `test/global-setup.ts` creates a *template*
  database and runs **every migration** into it, so migrations are exercised from
  scratch on each run. Each test file then clones the template
  (`CREATE DATABASE ... TEMPLATE ...`, fast and safe from parallel Jest workers),
  and drops its clone when it finishes. Files can run in parallel and can never see
  each other's data. Nothing is truncated between *files*; `harness.truncateApplicationData()`
  is there for a test that wants a blank slate inside one file.
* **The dev database is out of reach.** Every database this suite creates, uses or
  drops must be named `merchant_platform_e2e_*`; `assertSafeTestDatabaseName`
  refuses anything else, the harness checks `current_database()` before any test
  runs, and `test/infrastructure.e2e-spec.ts` pins all of this (including "cannot
  drop the dev database").
* **Redis is namespaced.** Each file uses its own queue prefix, so test jobs can
  never reach a developer's running worker; keys are removed afterwards.
* **A crashing test file cannot hang or leak.** If a file fails after its app is
  up, its open connections would normally keep Jest alive forever and skip the
  teardown. `forceExit` in `test/jest-e2e.json` makes the run end anyway so
  `global-teardown.ts` always drops the run's databases and Redis keys, and
  `createHarness` drops its own database if its setup fails. (Verified with a
  deliberately crashing file, alone and with `--bail`: the run exits in seconds and
  leaves nothing behind.)
* **Crash recovery.** A *killed* run (Ctrl-C twice, `kill -9`) cannot clean up after
  itself, so the next run drops e2e databases that are more than an hour old.

### The background worker is off unless a file asks for it

A live risk-review worker would race tests that set application state by hand.
`test/setup-env.ts` turns it off for every file; a file that tests the worker
starts with `import './helpers/enable-risk-worker';` (it must be the first import:
`ConfigModule` snapshots the environment when the app module is first imported).

### What lives where

| File | Covers |
|---|---|
| `authentication.e2e-spec.ts` | login, token lifetime, forged / expired / tampered / unsigned tokens, public routes |
| `authorization.e2e-spec.ts` | the access-control matrix (every route x every kind of caller), bypass attempts, the "every route has a row" guard |
| `applications.e2e-spec.ts` | CRUD, ownership isolation, lists and pagination |
| `application-workflow.e2e-spec.ts` | submit, assign, decide, the information-request loop |
| `risk-review.e2e-spec.ts` | the real BullMQ worker: retries, final failure, idempotency, stale runs, retry endpoint |
| `audit-trail.e2e-spec.ts` | one row per action, same-transaction rollback in both directions, append-only, no secrets |
| `sensitive-data.e2e-spec.ts` | masking, encryption at rest, tamper detection |
| `infrastructure.e2e-spec.ts` | the guarantees above |

### Adding an endpoint

`authorization.e2e-spec.ts` fails if the API exposes a route that has no row in its
matrix. Add one: the application state it needs and the status each kind of caller
must get (401 unauthenticated, 403 wrong role, 404 object hidden from this caller,
2xx allowed). That forces the "who may call this?" decision to be written down.

### Writing tests that stay deterministic

* Make assertions about **what** is visible (these ids, these owners), not about
  totals that depend on what other tests created. If a test needs exact counts, give
  it its own user with `harness.createExtraUser(role)`.
* A test that ends while background work is still running leaks it into the next
  test. Wait for the queue to go idle (see `afterEach` in `risk-review.e2e-spec.ts`)
  before arming one-shot failures such as `jest.spyOn(auditService, 'record')`.
* Run the suite with `--randomize` a few times before trusting new tests.
