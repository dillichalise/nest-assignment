# Design decisions

The important choices behind this service, the trade-off each one makes, and what
I would do next. Each entry says what was decided, why, what it costs, and what
the alternative would have been. Where a decision leaves a known weakness, it is
named here rather than hidden.

| # | Decision | Section |
|---|---|---|
| 1 | Hide what you may not see: `404`, not `403` | [link](#1-object-level-denials-answer-404-not-403) |
| 2 | Authorization in layers | [link](#2-authorization-is-enforced-in-layers) |
| 3 | The status table, and compare-and-set instead of locks | [link](#3-statuses-change-through-one-table-and-a-compare-and-set) |
| 4 | Risk review: commit first, then queue | [link](#4-risk-review-runs-in-a-queue-commit-first-then-enqueue) |
| 5 | A simulator behind a provider interface | [link](#5-the-risk-provider-is-a-simulator-behind-an-interface) |
| 6 | Field-level encryption and masking | [link](#6-the-tax-id-is-encrypted-at-the-field-level-and-masked-in-responses) |
| 7 | The audit trail lives in Postgres | [link](#7-the-audit-trail-lives-in-postgres-in-the-same-transaction) |
| 8 | Stateless JWTs (and the gap that leaves) | [link](#8-tokens-are-stateless-jwts) |
| 9 | One error shape, domain errors | [link](#9-one-error-shape-and-domain-errors-instead-of-http-exceptions) |
| 10 | Money as decimal strings | [link](#10-money-is-a-decimal-string-never-a-float) |
| 11 | Migrations only | [link](#11-the-schema-changes-only-through-reviewed-migrations) |
| 12 | The worker runs inside the API | [link](#12-the-worker-runs-inside-the-api-process) |
| 13 | How the tests are built, and what they prove | [link](#13-tests-isolated-databases-a-route-matrix-and-mutation-testing) |
| 14 | Smaller choices | [link](#14-smaller-choices) |
| | What I would do next | [link](#what-i-would-do-next) |

---

## 1. Object-level denials answer `404`, not `403`

**Context.** A SALES user may see only the applications they created; a reviewer
only those assigned to them. When someone asks for an application they may not see,
the API can say "forbidden" (`403`) or "no such thing" (`404`).

**Decision.** `404`, with a body identical to the one for an id that does not exist.
This holds for read, edit and submit. A caller who *can* see the application but
may not perform the action (for example an ADMIN or the owner trying to decide) gets
`403`, since nothing is hidden from them. Role-level refusals (a REVIEWER calling
`POST /applications`) are `403`.

**Consequences.** Application ids cannot be probed to learn what exists or who owns
it, and a foreign edit of a locked application is still `404` rather than a `409`
that would reveal its state. The cost is a slightly less helpful error for a
legitimate user who mistyped an id, and `404` can mask real "forbidden" bugs, which
is why the authorization matrix (see 13) spells out the expected status for every
route and caller. **Alternative:** `403` everywhere is simpler and more honest, and
fine when ids are unguessable and existence is not sensitive; here ids are UUIDs
but the rule is cheap, so I took the stricter option.

## 2. Authorization is enforced in layers

**Decision.** Three layers, each answering a different question:

1. A global **JWT guard** (who are you?) and **roles guard** (may your role call
   this endpoint at all?), driven by `@Public()` / `@Roles()`.
2. A **`PolicyService`** (may *you* touch *this* application?): one place that holds
   the object-level rules, used by services and also expressed as a query filter
   (`applicationScope`) so lists cannot drift from single-object checks. A test
   proves the two always agree.
3. The **services re-check** the same rules, so a new controller cannot skip them.

Identity (id, role) comes only from the verified token, never from a body, query
string or header.

**Consequences.** A bug in one layer is usually caught by the next, and rules are
written once and read in one file. The price is deliberate redundancy: some checks
exist twice. That redundancy is why I tested layers separately (unit tests) and
together (the e2e matrix), and used mutation testing to confirm each layer is
individually pinned. **Alternative:** a policy library (CASL) would give a richer
rule language; for three roles and four object rules a plain service was clearer.

## 3. Statuses change through one table and a compare-and-set

**Decision.** The valid status changes live in a single table
(`application-state-machine.ts`); nothing else decides what is allowed. Who may
trigger a change is separate (the policy layer). Every change is
`UPDATE ... WHERE id = ? AND status = <the status I read>`; if no row matched,
someone else got there first and the caller gets `409`.

**Consequences.** Double-submits, two reviewers deciding at once, and an edit racing
a submit all resolve to exactly one winner without locks, retries or a version
column, and the e2e suite proves it with five simultaneous requests. It guards the
*status*, not concurrent edits of other fields; for this lifecycle that is the
property that matters (last-write-wins on two edits of a draft is acceptable).
**Alternative:** optimistic locking with a version column covers all fields but
adds a column and client round-trips; `SELECT ... FOR UPDATE` would serialise
requests but hold locks across the audit write.

## 4. Risk review runs in a queue: commit first, then enqueue

**Context.** Submitting must return quickly, and the risk call is slow and flaky.

**Decision.** Submit commits "SUBMITTED + riskStatus PENDING + run counter + 1" in
one `UPDATE`, *then* adds a BullMQ job. The job carries only ids
(`{applicationId, run}`), with a deterministic job id so a duplicate enqueue is
ignored. The worker only acts if the application is still waiting for exactly that
run, so running a job twice, running a stale job from an earlier submission, or
running one for an application that moved on all do nothing. Transient failures
retry with exponential backoff (3 attempts, 1 s base); only after the last attempt
(or a non-retryable error) is the review marked `FAILED`, and the failed job is
kept for inspection. An admin can retry a failed review.

**The trade-off I accepted.** Postgres and Redis cannot share a transaction, so
there is a window between "committed" and "enqueued". Committing first can never
leave a job for state that does not exist; if the enqueue *fails*, the review is
marked `FAILED` immediately (retryable), so nothing is silently stuck. What remains
is a crash *between* the commit and the enqueue, which would leave a `PENDING`
review with no job. A transactional outbox (an `outbox` row written in the same
transaction and relayed to Redis), or a reconciler that re-queues old `PENDING`
reviews, closes it; I judged that out of scope for this exercise but it is the
first thing I would add (see below).

**Consequences.** Submit stays fast, results can never be applied twice or out of
order, and failures are visible and recoverable. The run counter is an extra
column, but it is what makes both the job id and the staleness check work.

## 5. The risk provider is a simulator behind an interface

**Decision.** `RiskProviderClient` is an abstract class; the only implementation
simulates a third-party KYB check. Its result is *deterministic* for a given
application (so re-running a job gives the same state) while latency and a failure
rate are configurable to demonstrate retries. Only business facts are sent to it
(business type, volume, ticket size, currency, an idempotency key), never the
owner's name, contact details or tax id.

**Consequences.** The worker, retries and idempotency are fully exercised without a
vendor, and a real client can replace the simulator without touching the worker.
The simulator cannot reveal real-world provider behaviour (rate limits, webhooks,
partial results), so a real integration would need its own contract tests.

## 6. The tax id is encrypted at the field level and masked in responses

**Decision.**

* **Encryption at rest:** `ownerTaxId` is stored as AES-256-GCM
  (`v1:<iv>:<tag>:<ciphertext>`), via a TypeORM column transformer. A fresh random
  IV per write; the GCM tag detects tampering; the column name is authenticated
  data, so a ciphertext copied into another column fails to decrypt. The key comes
  from `FIELD_ENCRYPTION_KEY`; the app refuses to start without a valid one and
  refuses the published example key in production.
* **Masking:** owner email, phone and tax id are masked in every response. Only an
  ADMIN, on the single-application detail view, sees them in full. Lists and all
  write responses stay masked even for ADMIN.
* **Logging:** query strings, headers and (by default) bodies are never logged;
  when body logging is switched on, secrets and contact details are redacted.

**Consequences.** A database dump or backup alone does not expose tax ids. An
encrypted column cannot be searched, sorted or indexed: if lookup by tax id is ever
needed, add a separate keyed hash (a blind index) rather than weakening the
encryption. A single undecryptable row fails any request that loads it, which fails
closed on tampering but means an admin list containing it returns `500` until the
row is repaired; production should alert on that rather than swallow it. The key
lives in an environment variable, which is acceptable for this exercise and not for
production (see below). **Alternative:** database-level encryption (pgcrypto, disk
encryption) protects the disk but not a user with SQL access.

## 7. The audit trail lives in Postgres, in the same transaction

**Decision.** Each significant action writes one row to `audit_logs`, *inside the
same transaction* as the change, through a single `AuditService.record`. If the
audit row cannot be written, the action fails. Metadata is sanitized before storage
(secret-looking keys redacted, emails and phone numbers masked, size bounded), and
edits record field *names*, never values. A database trigger rejects `UPDATE` and
`DELETE`; there are no foreign keys, so the trail outlives the users and
applications it describes. Reading it is ADMIN-only.

**Consequences.** The trail can neither miss a change nor describe one that rolled
back (the e2e suite proves both directions). The cost is *fail closed*: an audit
outage becomes an outage of writes. The trigger stops application bugs and casual
edits but is **not a security boundary** against someone with database access;
production should also revoke `UPDATE`/`DELETE` on the table from the application's
role and ship rows to write-once storage. There is no hash chaining, so tampering
by a privileged user would not be detectable. **Alternative:** a separate audit
store (or an event stream) scales better and isolates failures, at the cost of
losing the same-transaction guarantee unless an outbox is added. For this scale,
atomicity in the database seemed worth more.

## 8. Tokens are stateless JWTs

**Decision.** Login issues an HS256 JWT valid for one hour carrying the user id,
email and role. The guard verifies signature and expiry and trusts the claims; it
does not look the user up.

**The gap this leaves.** A user who is **deactivated, or whose role changes, after
logging in keeps their old access until the token expires** (up to an hour), on
every endpoint except `/auth/me`, which does check. This is documented in
`docs/SECURITY.md` and pinned by a test named "KNOWN LIMITATION" so it cannot change
unnoticed.

**Why accept it.** It keeps authentication fast and free of per-request database
reads, and a one-hour window is a common, bounded trade-off. **Options to close it**,
cheapest first: a per-request user lookup (one indexed read); a Redis deny-list of
revoked users, checked by the guard; shorter-lived access tokens with refresh
tokens.

## 9. One error shape, and domain errors instead of HTTP exceptions

**Decision.** Every error has the same body (`statusCode`, `error`, `message`,
optional `details`, `requestId`, `timestamp`, `path`). Business rules throw *domain
errors* (`ConflictError`, `NotFoundError`, ...) that a global filter maps to HTTP;
services never import HTTP exceptions for business rules. Unknown errors become a
generic `500` with the real cause logged against the request id. Login failures
(unknown email, wrong password, inactive user) are indistinguishable to the client;
the audit trail records the real reason.

**Consequences.** Clients handle one shape; internals do not leak; services stay
transport-agnostic and unit-testable. The cost is a small mapping layer to maintain.

## 10. Money is a decimal string, never a float

**Decision.** Amounts are Postgres `numeric` and travel through the code as decimal
strings; the API accepts a JSON number or numeric string, validates "positive, at
most 2 decimals", and returns strings (`"25000.00"`).

**Consequences.** No binary-float rounding anywhere; the API is exact. Clients must
treat the response amounts as strings. **Alternative:** integer minor units (cents)
is the other standard answer; it needs a currency-aware exponent, which the
exercise does not otherwise require.

## 11. The schema changes only through reviewed migrations

**Decision.** `synchronize` is off (a unit test pins it). Every change is a migration
generated from the entities, read before it runs, with a working `down`. The e2e
suite runs *every* migration from scratch into a template database on each run, and
`migration:generate` reports no changes when run against it, which is how I checked
that the entities and the migrations agree (a manual check, not an automated test).

**Consequences.** Schema changes are explicit and reviewable; deploys are
predictable. Data migrations (the encryption backfill) are written by hand and are
idempotent.

## 12. The worker runs inside the API process

**Decision.** One process serves HTTP and runs the BullMQ worker, with a flag
(`RISK_REVIEW_WORKER_ENABLED`) and a concurrency setting.

**Consequences.** One thing to run locally. In production you would run workers as
their own deployment so heavy jobs cannot starve request handling and the two scale
independently; the flag and the queue boundary already allow that without code
changes. The e2e suite keeps the worker *off* by default so tests that set state by
hand cannot race it.

## 13. Tests: isolated databases, a route matrix, and mutation testing

**Decision.**

* **Unit tests** (about 650, ~5 s) cover business rules with mocked collaborators.
* **End-to-end tests** (over 300, ~10 s) boot the real app against real Postgres
  and Redis. Each test *file* runs in its own database, cloned from a template that
  is freshly migrated on every run, so files run in parallel, never see each other's
  data and cannot reach the development database (guards refuse any database that
  is not clearly a disposable test one).
* An **authorization matrix** states the expected status for every route and every
  kind of caller, and a meta-test fails if the API exposes a route with no row.
* **Mutation testing** was used as evidence rather than a coverage number: about 140
  deliberate bugs against the unit tests, and about 40 access-control and lifecycle
  removals against the e2e suite. Each real one is caught by a named test; the survivors are overlapping
  checks where the other layer holds, and are listed in `docs/TESTING.md`.

**Consequences.** Tests are fast, parallel and deterministic (verified by serial
runs and repeated random-order runs). Mutation testing found real gaps in my first
tests, which is the point of doing it; the cost is a one-off investment in a script
that is not part of the repository.

## 14. Smaller choices

* **NestJS 11, not 12.** 12 is ESM-only and did not work with the Jest setup; 11
  satisfies "NestJS 10+" and is stable.
* **Offset pagination** (`page` + `limit`, capped at 100, stable order with an id
  tie-break): simple and enough here; cursor pagination is better for large, hot
  tables.
* **`riskResult` visibility.** ADMIN and REVIEWER see the provider's detail on the
  detail view; the applicant sees only the status and score.
* **Re-assignment** is allowed while `IN_REVIEW` (a reviewer can be unavailable);
  **ADMIN cannot decide**, to keep operating the queue separate from making risk
  calls.
* **Request ids** are accepted from clients only if they are short and made of safe
  characters, otherwise generated; they appear in responses, logs and audit rows.

---

## What I would do next

In rough priority order.

1. **Close the stateless-token gap** (decision 8): at minimum a per-request user
   lookup, so deactivating a user takes effect at once.
2. **Rate limiting and lockout on login.** Every failed attempt currently writes an
   audit row and costs a bcrypt comparison; both are cheap to abuse.
3. **A transactional outbox (or a reconciler) for the risk-review queue**
   (decision 4), closing the last window where a review can be left `PENDING` with
   no job.
4. **Key management.** Move `FIELD_ENCRYPTION_KEY` and `JWT_SECRET` into a KMS or
   secrets manager; use envelope encryption; implement key rotation (the `v1`
   prefix was reserved for it); add a production check that rejects weak or example
   `JWT_SECRET` values the way the encryption key is already checked.
5. **Observability.** Metrics (request rates and latency, queue depth, failed
   reviews), distributed tracing keyed on the request id, and alerts on decryption
   failures, repeated `401`s and reviews stuck `PENDING`.
6. **A tamper-evident audit trail.** Hash-chain the rows, revoke `UPDATE`/`DELETE`
   from the application role, ship to write-once storage, add retention and export,
   and record every ADMIN reveal of unmasked owner data (not done today).
7. **Deployment.** A multi-stage Dockerfile, running the worker as a separate
   deployment, a CI pipeline (lint, unit, e2e against service containers, a
   migration check), and least-privilege database roles.
8. **A real provider adapter** with idempotency keys, timeouts, circuit breaking and
   webhook handling, plus contract tests against the vendor's sandbox.
9. **API ergonomics.** Cursor pagination, filtering and sorting on more fields,
   refresh tokens, API versioning, and a generated client from the OpenAPI document.
10. **Data lifecycle.** Retention limits, and deletion of tax ids for rejected
    applications.
