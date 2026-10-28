# AUD-19 — Disruption retry / batch correction

Status checkpoint: 2026-10-15. Implementation status: **PARTIAL**. The durable idempotency slice for creating a system-disruption record is implemented locally. Batch preview/apply remains gated by unresolved correction, review, mapping, and monthly-closing policy from AUD-10–13. `BLOCKED` for that implementation slice does not stop independent local analysis or verification.

## Scope and current behavior

### Implemented locally: disruption POST idempotency

- `POST /api/v1/admin/system-disruptions` requires a random UUID v4 `Idempotency-Key`; existing Admin session, same-origin, rate-limit, and `no-store` controls remain in force.
- The service normalizes store UUID, timestamp-to-UTC, and trimmed reason before computing a SHA-256 request fingerprint. The key is SHA-256 hashed and scoped by the authenticated Admin account ID. Raw key and fingerprint are not returned to the client.
- The database uniqueness boundary is `(created_by_user_account_id, idempotency_key_hash)`. A matching retry returns the original record; same actor/key with a different normalized payload returns HTTP 409 `IDEMPOTENCY_KEY_REUSED`. Missing or invalid keys return HTTP 400.
- New disruption row and `system_disruption.create` audit event are committed through the same Prisma transaction. A concurrent unique-key winner is looked up after rollback and replayed only if the fingerprint matches; no second audit is written.
- Replays retain HTTP 201 and the same public DTO shape; no separate replay flag is exposed.
- Web UI holds the pending key and input in the page model after network/5xx ambiguity, disables creating a different disruption, and offers an identical same-key retry. A successful retry clears the pending state. A hard reload discards that in-memory key and payload; durable server idempotency cannot help unless the client still has the original key. Do not create another record until the uncertain outcome is resolved by the current-page retry or an operator verifies the record.
- The migration is present but **not applied to any database**. No production or staging provider was used.

### Not implemented: batch correction

No preview/apply endpoint, manifest, correction ledger, or batch UI is added. Existing disruption creation does not update raw attendance rows or existing daily attendance statuses. Any policy that changes `PRESENT`, `LATE`, or `ABSENT` retrospectively must be append-only and separately auditable; it cannot be inferred from the disruption time range.

## Policy and implementation gates

Before implementing correction, the authorized product owner must resolve and record at least:

1. Which source/status mappings are eligible (including existing `PRESENT`, `LATE`, `ABSENT`, pending/rejected review, and already-corrected records), and whether correction may ever remove or replace a decision.
2. Correction deadline, approval actor/role, reviewer scope, and whether approval differs by store, incident, or attendance state.
3. Whether monthly recap close at the third day is authoritative, the timezone/cutoff, and what happens to a correction submitted after close: reject, reopen/revision, or a separately versioned adjustment. Define treatment for a pending review at close.
4. Whether previews bind to an immutable source snapshot/revision or are recomputed at apply time; define behavior when attendance or policy changes between preview and apply.
5. Whether the batch is global or store-scoped, which Admin/Supervisor may preview/apply, whether one actor may approve their own batch, and how historical assignment scope is resolved.
6. Whether the user's previously selected offline `captureDate` remains only a review candidate, never a server-approved work date by itself. This must not be silently overridden by batch correction.

These decisions must be reflected in `docs/DECISIONS.md` and the PRD/TODO before production mutation code is started. AUD-10/AUD-11/AUD-12/AUD-13 readiness documents remain the policy map.

## Batch correction design and acceptance plan (not code)

The implementation proposal must use a durable, immutable batch identity and a payload/snapshot fingerprint. Preview must enumerate the full authorized candidate set deterministically and record its scope, source revision/checkpoint, policy version, date range, counts by status, and per-target before/after intent. It must not depend on ordinary page pagination or on the UI's current visible page.

Apply must require an authorized actor, explicit confirmation, the same idempotency key/fingerprint, and an unchanged eligible snapshot/policy (or return a clear conflict requiring a fresh preview). In one database transaction, it must append correction entries referencing original attendance/status records, append audit history, and persist the batch result. It must never overwrite or delete raw attendance. Replaying the same actor/key/fingerprint returns the original result without duplicate correction or audit; key reuse with a different fingerprint conflicts. Closed-period guards, row locks/serializable conflict handling, and preview/apply races require PostgreSQL integration tests.

Required tests before calling that slice ready:

| Scenario                                              | Expected evidence                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Duplicate POST / batch apply after a lost response    | Same durable result; one record/correction and one audit event                                   |
| Same key with changed payload/scope/snapshot          | 409; no new mutation/audit                                                                       |
| Concurrent identical apply                            | One winning batch; all retries return its result                                                 |
| Concurrent attendance review/change after preview     | Apply conflicts or follows the owner-approved snapshot rule; no silent overwrite                 |
| Wrong role, employee, store, or historical assignment | Denied before data disclosure/mutation                                                           |
| Closed month, pending review, prior correction        | Exact owner-approved behavior, covered at both service and PostgreSQL transaction level          |
| Correction result in reports/XLSX/dashboard           | Shared effective-status resolver and stable before/after/audit reconciliation                    |
| Raw attendance immutability                           | Database assertions compare raw rows before/after apply                                          |
| Unknown response then retry                           | Retry with same durable key recovers; different key cannot duplicate the same acknowledged batch |

## Local evidence collected

- API targeted tests: `system-disruption.test.ts`, `system-disruption-prisma-repository.test.ts`, `routes/system-disruptions.test.ts` — **3 files, 21 tests passed**.
- Web targeted tests: API client, model, and DOM tests for system disruptions — **3 files, 11 tests passed**. These are Vitest/jsdom checks, not a real browser run.
- Prisma schema validation passed using `prisma validate`; no migration or database was run.
- Prettier check and `git diff --check` passed. The repository-wide TypeScript check still exits nonzero because of existing diagnostics across unrelated modules/tests (including installed Vitest matcher-type diagnostics); the AUD-19 service/route errors found during review were corrected. This does not constitute a clean project-wide typecheck.
- The Prisma repository tests use fakes. PostgreSQL transaction atomicity, unique-key race, migration application, real HTTP+DB behavior, browser reload recovery, provider, and deployment remain unverified.

## Changed files for this slice

- `apps/api/prisma/schema.prisma`
- `apps/api/prisma/migrations/20261015020000_system_disruption_idempotency/migration.sql`
- `apps/api/src/modules/system-disruption/index.ts`
- `apps/api/src/modules/system-disruption/prisma-repository.ts`
- `apps/api/src/routes/system-disruptions.ts`
- `apps/api/test/modules/system-disruption.test.ts`
- `apps/api/test/modules/system-disruption-prisma-repository.test.ts`
- `apps/api/test/routes/system-disruptions.test.ts`
- `apps/web/src/api/system-disruptions-api.ts`
- `apps/web/src/pages/system-disruptions-model.ts`
- `apps/web/src/pages/AdminSystemDisruptionsPage.tsx`
- `apps/web/test/system-disruptions-api.test.ts`
- `apps/web/test/system-disruptions-model.test.ts`
- `apps/web/test/system-disruptions.dom.test.tsx`
- `docs/API.md`
- `docs/openapi.yaml`

The list describes files touched by the broader AUD-19 slice; several of these files also contain earlier AUD-06/AUD-09 work. Preserve those independent changes.
