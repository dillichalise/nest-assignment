# Merchant Platform API

A NestJS service for merchant onboarding. Sales users create and submit merchant
applications, an admin assigns a reviewer, a background job runs a (simulated)
third-party risk check, and the assigned reviewer records the decision. Every
significant action is written to an append-only audit trail.

**Stack:** TypeScript, NestJS 11, PostgreSQL + TypeORM (reviewed migrations),
Redis + BullMQ, JWT auth with role- and object-level authorization,
OpenAPI/Swagger, Jest + Supertest, Docker Compose for local infrastructure.

## Contents

[Prerequisites](#prerequisites) · [Quick start](#quick-start) · [Try it](#try-it) ·
[How it works](#how-it-works) · [Testing](#testing) · [Project structure](#project-structure) ·
[Scripts](#scripts) · [Configuration](#configuration) · [Troubleshooting](#troubleshooting) ·
[More documentation](#more-documentation)

## Prerequisites

* **Node.js 20 or newer** (developed on 22) and npm
* **Docker** with Compose, for PostgreSQL and Redis
* `curl` for the command-line walkthrough (optional; Swagger works in the browser)

## Quick start

```bash
git clone <repository-url> merchant-platform && cd merchant-platform
npm install
cp .env.example .env          # local development settings
npm run docker:up             # PostgreSQL on :5433 and Redis on :6379
npm run migration:run         # create the database schema
npm run seed                  # create the demo users
npm run start:dev             # API on http://localhost:5001
```

Check it is alive:

```bash
curl http://localhost:5001/health
# {"status":"ok","uptime":3.1,"timestamp":"..."}
```

Interactive API documentation: **http://localhost:5001/docs** (Swagger UI; the raw
OpenAPI document is at `/docs-json`).

### Running the API in Docker (optional)

The default setup runs the API on your host. To run it in a container as well (it applies
pending migrations on start), use the `app` compose profile:

```bash
npm run docker:app:up      # build and start Postgres, Redis and the API
npm run docker:app:seed    # demo users
npm run docker:app:logs    # follow API logs
npm run docker:app:down    # stop everything
```

Set `API_PORT` if 5001 is taken on your host. The container uses `NODE_ENV=development`
by default so the published local-dev `FIELD_ENCRYPTION_KEY` is accepted; set
`API_NODE_ENV=production` together with your own secrets for anything real.

### Demo users

`npm run seed` creates these users, all with the password in `SEED_PASSWORD`
(see `.env`):

| Email | Role | Can |
|---|---|---|
| `sales@example.com`, `sales2@example.com` | SALES | create, edit and submit **their own** applications |
| `admin@example.com` | ADMIN | assign reviewers, retry failed risk reviews, read the audit trail |
| `reviewer@example.com` | REVIEWER | read applications **assigned to them** and decide on them |

The seed only creates users that do **not** exist yet, so changing `SEED_PASSWORD`
later does not change existing users' passwords. To reset them, delete the users
and run `npm run seed` again. Demo users and the example `.env` values are for
local development only.

## Try it

### In Swagger (no tools needed)

1. Open http://localhost:5001/docs and expand `POST /auth/login`. Click *Try it
   out*, pick the *A sales user* example, replace the password with your
   `SEED_PASSWORD`, and execute.
2. Copy `accessToken` from the response, click **Authorize** (top right), paste it
   (without the word *Bearer*) and confirm. The token is remembered across reloads.
3. Run `POST /applications` (the example body is ready to send) and copy the `id`
   from the response.
4. Run `POST /applications/{id}/submit` with that id. The response shows
   `riskStatus: PENDING`; a background job completes it within about a second.
5. Log in as `admin@example.com`, **Authorize** with the new token, and find the
   reviewer's id: log in as `reviewer@example.com`, authorize, call `GET /auth/me`
   and copy `id`. Then, as the admin, run `POST /applications/{id}/assign` with
   `{"reviewerId": "<that id>"}`.
6. As the reviewer, run `GET /applications/{id}` until `riskStatus` is `COMPLETED`,
   then `POST /applications/{id}/decision` with the *Approve* example.
7. As the admin, run `GET /applications/{id}/audit` to see the whole history.

## How it works

```
        DRAFT ──submit──► SUBMITTED ──assign──► IN_REVIEW ──decide──► APPROVED
          ▲                  │  (risk review                │──────► REJECTED
          │                  │   runs in the                │
          └──resubmit── INFO_REQUESTED ◄────────────────────┘
                             background)
```

* **Authentication.** A JWT proves who you were at login; every request then re-checks
  that the user is still active and takes their *current* role from the database, so
  deactivating or demoting someone applies immediately.
* **Roles.** SALES own what they create; ADMIN operates the queue; REVIEWER decides
  only what is assigned to them. ADMIN cannot approve.
* **Object-level security.** Being allowed to call an endpoint is not enough: a
  SALES user can touch only their own applications, a reviewer only assigned ones.
  Anything you may not see answers `404`, identical to "does not exist".
* **Risk review.** Submitting queues a BullMQ job. The worker (in the API process
  unless `RISK_REVIEW_WORKER_ENABLED=false`) asks a simulated provider, stores the
  score, retries transient failures with exponential backoff, and is safe to run
  twice. A decision is only possible once the review has `COMPLETED`.
* **Audit trail.** Each action's audit row is written in the same database
  transaction as the change itself, and the table rejects `UPDATE`/`DELETE`.
* **Sensitive data.** The owner's tax id is encrypted at rest; email, phone and tax
  id are masked in responses (an ADMIN sees them in full on one application).
* **Why it is built this way:** see [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Testing

```bash
npm test                  # unit tests: no infrastructure needed, ~5 s
npm run test:cov          # unit tests with a coverage report
npm run test:cov:view     # same, then open the HTML report in your browser
npm run test:cov:serve    # serve the last report at http://localhost:8080
npm run docker:up         # the end-to-end tests need Postgres and Redis
npm run test:e2e          # API tests against real Postgres + Redis, ~10 s
```

The end-to-end suite is self-contained: every test file runs in its own throwaway
database (a clone of a freshly migrated template), so it needs no setup, leaves
nothing behind and **cannot touch your development database**. It includes an
authorization matrix (every route against every kind of caller) and checks that
the API documentation matches the API. Details, determinism checks and how to add
an endpoint to the matrix are in [`docs/TESTING.md`](docs/TESTING.md).

## Project structure

```
src/
  main.ts, app.module.ts      bootstrap, global wiring
  swagger.setup.ts            the OpenAPI document and Swagger UI
  auth/                       login, JWT guard, roles guard, @CurrentUser
  users/                      the user entity and lookups
  policies/                   object-level rules (who may see / edit / decide what)
  applications/               entity, DTOs, controller, state machine, workflow service
  risk-review/                the BullMQ worker, the provider interface and its simulator
  queue/                      queue configuration (retries, backoff)
  audit/                      audit service, append-only table, metadata sanitizer
  database/                   TypeORM config, migrations, seed script
  health/                     liveness endpoint
  common/                     errors, exception filter, pipes, request ids, masking, encryption
test/                         end-to-end tests, helpers and the per-file database setup
docs/                         SECURITY.md, TESTING.md, DECISIONS.md
```

Unit tests (`*.spec.ts`) sit next to the code they test.

## Scripts

| Script | What it does |
|---|---|
| `npm run start:dev` | run with file watching |
| `npm run build` / `npm run start:prod` | compile / run the compiled app |
| `npm run docker:up` / `docker:down` | start / stop Postgres and Redis |
| `npm run docker:app:up` / `:down` / `:logs` / `:seed` | run the API in a container too (compose `app` profile) |
| `npm run migration:run` / `migration:revert` | apply / undo the last migration |
| `npm run migration:generate -- src/database/migrations/Name` | write a migration from entity changes (review it before running) |
| `npm run migration:create -- src/database/migrations/Name` | an empty migration to fill in by hand |
| `npm run seed` | create the demo users |
| `npm run format` / `lint` / `lint:check` | Prettier / ESLint with fixes / ESLint check only |
| `npm test` / `test:cov` | unit tests / with coverage |
| `npm run test:cov:view` / `test:cov:serve` | coverage report opened in the browser / served at http://localhost:8080 (`coverage/lcov-report/index.html`) |
| `npm run test:e2e` / `test:e2e:random` | API tests / the same in random order |

## Configuration

Everything is read from `.env` (copied from `.env.example`, which documents every
variable). The ones you are most likely to touch:

| Variable | Purpose |
|---|---|
| `PORT` | API port (default `5001`) |
| `DB_*`, `REDIS_*` | where Postgres and Redis are (defaults match `docker-compose.yml`) |
| `JWT_SECRET`, `JWT_EXPIRES_IN` | token signing key and lifetime in seconds. **Use a long random secret outside local development** |
| `FIELD_ENCRYPTION_KEY` | 32-byte key for encrypting the tax id. The app **refuses to start** without a valid one, and refuses the published example key in production |
| `SEED_PASSWORD` | password of the demo users (local only) |
| `RISK_REVIEW_WORKER_ENABLED`, `RISK_REVIEW_CONCURRENCY`, `RISK_REVIEW_ATTEMPTS`, `RISK_REVIEW_BACKOFF_MS` | the background worker |
| `RISK_SIM_LATENCY_MS`, `RISK_SIM_FAILURE_RATE` | make the simulated provider slow or flaky, to see retries |
| `LOG_HTTP`, `LOG_HTTP_BODIES` | access log; bodies are off by default and redacted when on |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `address already in use` on port 5433 or 6379 | something else uses it; stop it, or change `DB_PORT` / `REDIS_PORT` in `.env` (Compose reads them too) |
| `FIELD_ENCRYPTION_KEY ...` on startup | the key is missing or not 32 bytes; copy it from `.env.example` or run `openssl rand -base64 32` |
| login returns `401` for a seeded user | the user was created with an older `SEED_PASSWORD`; see [Demo users](#demo-users) |
| `Cannot reach Postgres` when running e2e tests | `npm run docker:up` first |
| an application stays `riskStatus: PENDING` | the worker is off (`RISK_REVIEW_WORKER_ENABLED=false`) or the API is not running |

## More documentation

* [`docs/DECISIONS.md`](docs/DECISIONS.md): the key design decisions and trade-offs, and what I would do next.
* [`docs/SECURITY.md`](docs/SECURITY.md): what is sensitive and how it is protected, including known limitations.
* [`docs/TESTING.md`](docs/TESTING.md): how the tests are organised and why they are reliable.
