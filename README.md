# Merchant Platform API

A NestJS service for merchant onboarding: sales users create and submit merchant
applications, an admin assigns a reviewer, a background job runs a (simulated)
third-party risk check, and the assigned reviewer records the decision. Every
significant action is written to an append-only audit trail.

**Stack:** TypeScript, NestJS 11, PostgreSQL + TypeORM (reviewed migrations),
Redis + BullMQ, JWT auth with role- and object-level authorization, OpenAPI/Swagger,
Jest + Supertest, Docker Compose for local infrastructure.

## Quick start

```bash
npm install
cp .env.example .env          # local development settings
npm run docker:up             # Postgres (:5433) and Redis (:6379)
npm run migration:run         # create the schema
npm run seed                  # demo users (see below)
npm run start:dev             # http://localhost:5001  (Swagger: /docs)
```

Check it is alive: `curl http://localhost:5001/health`.

### Demo users

`npm run seed` creates `admin@`, `reviewer@`, `sales@` and `sales2@example.com`, all
with the password in `SEED_PASSWORD` (`.env`). The seed only creates users that do
**not** exist yet, so changing `SEED_PASSWORD` later does not change existing users'
passwords; to reset them, delete the users first.

## Testing

```bash
npm test                  # unit tests: no infrastructure needed, ~5 s
npm run test:cov          # unit tests with a coverage report
npm run docker:up         # the end-to-end tests need Postgres and Redis
npm run test:e2e          # API tests against real Postgres + Redis, ~10 s
```

The end-to-end suite is self-contained: every test file runs in its own throwaway
database (a clone of a freshly migrated template), so it needs no setup, leaves
nothing behind and **cannot touch your development database**. Details, how to add
an endpoint to the authorization matrix, and the determinism checks are in
[`docs/TESTING.md`](docs/TESTING.md).

## Scripts

| Script | What it does |
|---|---|
| `npm run start:dev` | run with file watching |
| `npm run build` / `npm run start:prod` | compile / run the compiled app |
| `npm run docker:up` / `docker:down` | start / stop Postgres and Redis |
| `npm run migration:run` / `migration:revert` | apply / undo the last migration |
| `npm run migration:generate -- src/database/migrations/Name` | diff entities against the database |
| `npm run migration:create -- src/database/migrations/Name` | an empty migration to fill in |
| `npm run seed` | create the demo users |
| `npm run format` / `lint` / `lint:check` | Prettier / ESLint (fix) / ESLint (check only) |
| `npm test` / `test:cov` / `test:e2e` | unit / coverage / API tests |

## Configuration

Everything is read from `.env` (see `.env.example`): database and Redis addresses,
`JWT_SECRET` and `JWT_EXPIRES_IN`, `FIELD_ENCRYPTION_KEY` (the app refuses to start
without a valid one), logging switches, and the risk-review worker settings
(`RISK_REVIEW_*`, `RISK_SIM_*`). The risk-review worker runs inside the API process
unless `RISK_REVIEW_WORKER_ENABLED=false`.

## Documentation

* [`docs/TESTING.md`](docs/TESTING.md): how the tests are organised and why they are reliable.
* [`docs/SECURITY.md`](docs/SECURITY.md): what is sensitive and how it is protected
  (encryption at rest, masking, redaction, the audit trail, authentication limits).
