# Security: sensitive data handling

What is sensitive, how it is protected, and what a production system would add.
Everything here describes the code as it exists today.

## 1. What is sensitive

| Data | Where | Protection |
|---|---|---|
| Passwords | `users.passwordHash` | bcrypt hash only; column is `select: false`, never returned by any endpoint, never logged |
| JWTs / `Authorization` header | requests | never logged; redacted if a body or object is ever logged |
| Owner tax id | `merchant_applications.ownerTaxId` | **encrypted at rest** (field level), masked in responses, redacted in logs |
| Owner email, owner phone | `merchant_applications` | masked in responses, redacted in body logs |
| Owner name, business names | `merchant_applications` | personal data, but needed in every view: not masked |
| `FIELD_ENCRYPTION_KEY`, `JWT_SECRET` | environment | never logged; startup errors never echo them |

## 2. Field-level encryption (`ownerTaxId`)

Implementation: `src/common/security/field-encryption.ts`, applied by a TypeORM
column transformer on the entity.

- **Algorithm:** AES-256-GCM, random 12-byte IV per write, 16-byte auth tag.
- **Stored format:** `v1:<iv>:<authTag>:<ciphertext>` (base64 parts). `v1` is a
  format/key version reserved for rotation.
- **Tamper detection:** GCM authenticates the data. Any change to the IV, tag or
  ciphertext makes decryption fail. Failures raise one generic error (no
  plaintext, key or payload in the message); the API answers `500 Internal server error`.
- **Context binding:** the column name (`merchant_applications.ownerTaxId`) is
  authenticated as additional data, so a ciphertext copied into another column
  does not decrypt.
- **Strict reads:** a plaintext value found in the column is rejected, not
  served. This signals an un-run backfill migration.
- **Key:** `FIELD_ENCRYPTION_KEY`, 32 random bytes, base64 (or 64 hex chars).
  Generate one with `openssl rand -base64 32`.
  - The app **refuses to start** if it is missing or the wrong length (skipped
    only when `NODE_ENV=test`).
  - `.env.example` publishes a development key. It is public, so the app also
    refuses to start with it when `NODE_ENV=production`.
- **Existing data:** migration `EncryptOwnerTaxId` encrypts any plaintext rows
  (idempotent; `down` decrypts). It needs the same key as the running app.

### Consequences of encrypting a column

- It cannot be **searched, sorted, filtered or indexed**: equal inputs encrypt
  to different values on purpose. Nothing in the app needs this today.
- **If lookup by tax id is ever required**, add a *blind index*: a second column
  holding `HMAC-SHA256(blindIndexKey, normalize(taxId))`, with its own key
  separate from the encryption key, indexed and queried by recomputing the HMAC.
  It reveals only equality, and low-entropy identifiers remain guessable by
  anyone holding the HMAC key, so protect that key like the encryption key.
- **Losing the key loses the data.** Back the key up separately from the database.
- **A single undecryptable row fails any request that loads it.** For a list
  that includes the row (ADMIN sees every application) the whole page returns
  500. This fails closed: tampering is loud, never silently served. The
  trade-off is availability; production should alert on these errors and
  repair or quarantine the row rather than catch and hide the error.

## 3. Masking in API responses

`ApplicationResponseDto.from(application, revealSensitive)` is the only place
entities become API output, with an explicit field list.

| Field | Default (everyone) | Format |
|---|---|---|
| `ownerEmail` | masked | `c*********@example.com` (first character + domain) |
| `ownerPhone` | masked | `+*** ******3210` (last 4 digits, formatting kept) |
| `ownerTaxId` | masked | `*******-789` (last 4 characters) |

**Who sees full values:** an **ADMIN**, on **`GET /applications/:id` only**
(`PolicyService.canViewSensitiveOwnerData`). Lists and every write/workflow
response (create, update, submit, assign, decision) stay masked, even for ADMIN.
Reviewers and sales users always see masked values.

Why this narrow: full contact and identity data is needed rarely, so access is
an explicit, single-purpose request instead of a side effect of listing.

Not exposed at all: `passwordHash`, `riskResult` (until the risk-review pack
decides who may see provider detail).

## 4. Logging

`src/common/middleware/http-logging.middleware.ts` writes one line per request:

```
POST /auth/login 401 65ms requestId=<uuid> userId=-
```

- **Never logged:** query strings, request/response headers, response bodies,
  passwords, tokens, `Authorization`, tax ids.
- **Request bodies** are off by default. With `LOG_HTTP_BODIES=true` they are
  logged **after `redact()`**, which replaces the value of any key containing
  `password`, `secret`, `token`, `authorization`, `apikey`, `cookie`,
  `credential`, `taxid`, `privatekey` or `encryptionkey`, plus contact keys
  (`email`, `phone`). Matching is by substring on a normalized key name, so it
  errs toward over-redaction. Use only for debugging, never in production.
- Server errors (`5xx`) are logged by the exception filter with a stack trace and
  the request id; the client only ever receives a generic message.
- `LOG_HTTP=false` disables the access log (it is off under Jest by default).
- `redact()` is the shared helper for any other place that must serialize
  objects, for example audit metadata.

## 5. Risk review (background jobs)

- **Queue payloads hold ids only** (`{ applicationId, run }`). Redis never
  receives business data, owner contact details or tax ids; the worker reads the
  application from Postgres.
- **The provider is sent business facts only** (business type, volume, ticket
  size, currency, an idempotency key). Owner name, email, phone and tax id are
  never passed on (data minimization).
- **Failures store a code, not a message**: `{ failure: { code, attempts } }`.
  Raw provider error text is logged at `warn` (the simulator's contain nothing
  sensitive; a real provider's should be reviewed before logging) but never
  persisted. The failed BullMQ job is kept in Redis for inspection and also
  holds the error text, so treat Redis as an operational store with the same
  access controls as the database.
- **`riskResult` (provider detail) is visible to ADMIN and REVIEWER, on the
  single-application detail view only.** The sales user sees `riskStatus` and
  `riskScore` but not flags or the provider reference; lists never include it.
- **Queue isolation:** `QUEUE_PREFIX` namespaces every Redis key. The test suite
  uses a unique prefix per run so test jobs can never be picked up by a
  developer's or an environment's worker.

## 6. Audit trail

Implementation: `src/audit/`. One row in `audit_logs` per significant action.

**What is recorded**

| Action | Written by | Metadata |
|---|---|---|
| `APPLICATION_CREATED` | create | initial status |
| `APPLICATION_UPDATED` | edit | the changed field **names**, never the values |
| `APPLICATION_SUBMITTED` | submit | from/to status, risk-review run |
| `REVIEWER_ASSIGNED` | assign | reviewer, previous reviewer, whether it was a re-assignment |
| `DECISION_RECORDED` | decision | decision and reason (free text, sanitized) |
| `RISK_REVIEW_STARTED` / `COMPLETED` / `FAILED` | worker | run, score and level, or failure code and attempts |
| `RISK_REVIEW_RETRY_REQUESTED` | admin retry | run |
| `LOGIN_SUCCEEDED` / `LOGIN_FAILED` | login | failure reason (`UNKNOWN_EMAIL`, `BAD_PASSWORD`, `INACTIVE_USER`) and the masked email |

Each row has: actor id and role (null for system actions and unknown-email
logins), action, entity type and id, sanitized metadata, a correlation id and a
timestamp (`clock_timestamp()`, so rows in one transaction stay distinct and
ordered).

The **client** still receives one generic `401` for every login failure; only
the audit trail knows the real reason.

**One write path, in the same transaction.** `AuditService.record(event, manager)`
is the only way a row is written. Every state change runs in one database
transaction that contains both the change and its audit row, so the trail can
neither miss a change nor describe one that was rolled back. The test suite
proves both directions: a failing audit insert undoes the change (and no
background job is queued for it), and a failure *after* the audit insert removes
that row too.
- **Fail closed:** if the audit row cannot be written, the action fails (`500`).
  Availability is traded for completeness. A system that must stay up when the
  audit store is down would need an outbox instead.
- Work that is not in Postgres (queueing the risk-review job) happens after the
  commit; see `RiskReviewService.enqueue` for that trade-off.

**Sanitizing.** Everything passes through `sanitizeAuditMetadata` before it is
stored: values under secret-looking keys (password, token, authorization,
secret, api key, cookie, tax id) become `[REDACTED]`; values under `*email*` and
`*phone*` keys are masked; emails and phone numbers inside any other string are
masked; uuids are left intact; depth, array length, string length and total size
are bounded. Two honest limits: free-text masking is a **heuristic** (it cannot
recognise a tax id written in a sentence), so the real protection is that
callers pass ids, enums and counts, and edits record field names rather than
values; and a reviewer's decision `reason` is stored (sanitized) because the
reason is the point of the record.

**Correlation.** For API actions the correlation id is the request id (the
`x-request-id` response header and the access-log line); for worker actions it is
the BullMQ job id. It is carried through async code with `AsyncLocalStorage`.

**Append-only.**
- The application has no update or delete path (`AuditService` has none).
- A database trigger additionally rejects `UPDATE` and `DELETE` on the table.
  This stops application bugs and casual edits; it is **not a security boundary**
  against someone with database access, who can disable the trigger or set the
  maintenance flag (`SET LOCAL app.audit_maintenance = 'on'`) that test clean-up
  and a deliberate, reviewed data fix use. In production also revoke
  `UPDATE`/`DELETE` on `audit_logs` from the application's database role, and
  consider shipping rows to write-once storage.
- There are no foreign keys: the trail must outlive the users and applications it
  describes.

**Reading.** `GET /applications/:id/audit` is **ADMIN-only**, oldest first,
paginated. Not the owner and not the assigned reviewer: the trail shows other
people's actions and system events. There is no search, export or UI.

**Not covered yet.** Reads of sensitive data (an ADMIN revealing a tax id) are
not recorded; there is no tamper-evident chaining (hash of the previous row); a
burst of failed logins writes a row each, so login needs rate limiting; there is
no retention or archival policy.

## 7. Authentication notes

- JWTs are signed with `JWT_SECRET` and expire after `JWT_EXPIRES_IN` seconds.
- Login failures (unknown email, wrong password, inactive user) return the same
  generic `401`, and a dummy bcrypt comparison runs for unknown emails so response
  time does not reveal which accounts exist.
- Role and user id are taken from the verified token only, never from the
  request body or headers.

## 8. What production would add

- **Key management:** keep `FIELD_ENCRYPTION_KEY` in a KMS or secrets manager,
  not a `.env` file; use **envelope encryption** (a KMS-wrapped data key per
  tenant or per table) so the master key never leaves the KMS.
- **Key rotation:** the `v1` prefix exists for this. Add a key id to the format,
  keep old keys for reading, write with the newest, and re-encrypt in the
  background. Not implemented.
- **Audit of access:** record every ADMIN reveal of sensitive owner data in the
  audit trail (not done today).
- **Transport and storage:** TLS everywhere, encrypted database volumes and
  backups, restricted database roles.
- **Hardening:** rate limiting on login, refresh/revocable tokens, secret
  scanning in CI, alerting on decryption failures and repeated 401s.
- **Tamper-evident audit log** (hash chaining or write-once storage).
- **Data lifecycle:** retention limits and deletion of tax ids for rejected
  applications.
