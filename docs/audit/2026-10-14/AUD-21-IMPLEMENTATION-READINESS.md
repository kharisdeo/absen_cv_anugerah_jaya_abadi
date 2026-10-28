# AUD-21 — Scheduler dan selfie retention dry-run

Checkpoint: 2026-10-15 (Asia/Jakarta). Status: **PARTIAL**. A bounded, read-only selfie-retention preview mode is implemented and locally tested. No database-backed dry-run, provider scheduler, alert channel, or staging execution was performed. `BLOCKED` for environment execution does not stop local analysis and test work.

## Policy and scope

- The recorded project decision requires a daily retention schedule. `SELFIE_RETENTION_MONTHS` defaults to 12, calculated from server receipt time. This task does not select an exact daily time, timezone conversion in a provider scheduler, alert destination, or worker resource.
- DigitalOcean App Platform is the selected staging target. Its existing pre-provisioning runbook says a scheduled job is only suitable if its cadence supports the job. No App Platform app/job, database, storage bucket, or credentials exist in this workspace; the daily schedule is not installed.
- The selfie worker handles watermark backfill, attached selfie/staging cleanup, and expired upload-orphan cleanup. Doctor-note/medical attachments remain excluded: their retention/deletion policy is not defined and must not inherit selfie retention.
- No mutating retention job was run. No database, object storage, or `.env` was accessed or changed.

## Local implementation

- `pnpm --filter @absen/api retention:dry-run` invokes `tsx src/jobs/selfie-retention.ts --dry-run`.
- The dry-run branch requires only `DATABASE_URL`, constructs the Prisma repository, and does not instantiate `S3PrivateSelfieStorage`. It invokes only `previewRetentionCandidates`; it cannot call `watermarkPendingBatch`, `purgeExpiredBatch`, storage reads/writes/deletes, `claimExpiredPending`, database update/delete, audit writes, or transactions.
- The repository makes four deterministic `findMany` reads, each capped at 500 rows: retained attachments pending watermark, attached staging copies, expired attached selfies, and expired pending upload intents with both staging and sealed keys. The CLI prints only `previewedAt`, the sample size, candidate counts, per-category `batchLimitHit` flags, and `mutationsPerformed: false`; it emits no row ID, employee data, object key, or URL.
- `batchLimitHit` means the bounded sample reached 500; it does **not** prove additional rows exist. This is a capped candidate sample, not an exact total or a consistent database snapshot. The four read queries can observe concurrent changes independently; rerun after activity settles or use the actual job's conditional claim/transaction behavior for mutation.
- The mutating `retention:run` path remains separate and unchanged in intent. Existing runner is bounded to at most 100 batches of 500, stops on failure/partial purge, returns nonzero when there are failures or the cap is reached, and logs aggregate counts only. Existing deletion/state-clear ordering and `purgeClaimedAt` coordination are retained. A real concurrent worker and reference-preservation guarantee still require PostgreSQL tests.

### Safe commands

Run a preview only against an explicitly approved, non-production database after access and data scope are confirmed. Do not print or paste the database URL:

```text
pnpm --filter @absen/api retention:dry-run
```

The mutating command is **not** part of this validation and must not be used as a substitute for dry-run:

```text
pnpm --filter @absen/api retention:run
```

## Validation matrix

| Check                                                                                          | Local evidence                                                                                                                                     | Remaining acceptance evidence                                                                            |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Dry-run only dispatches the injected preview and handles preview failure generically           | Runner tests; no error detail is emitted                                                                                                           | Execute CLI in an approved disposable/staging DB and record redacted aggregate output                    |
| Candidate predicates match retention categories and reads are capped/deterministically ordered | Prisma repository test asserts all four filters, ordering, and `take`                                                                              | Verify result counts against a known synthetic DB fixture                                                |
| Dry-run has no database write/delete/transaction or storage side effect                        | Mock test asserts no `updateMany`, `deleteMany`, capture update, or `$transaction`; service mock test asserts no `inspectObject` or `deleteObject` | PostgreSQL statement/log observation and synthetic object bucket checks in authorized staging            |
| Watermark + purge loop is bounded; failure/cap produces nonzero                                | Existing runner tests plus current targeted suite                                                                                                  | Scheduled nonzero exit must reach an owner-approved alert receiver                                       |
| Expiry preserves attendance/audit and clears reference only after delete                       | Existing unit/repository mock tests cover ordering, retries, rollback, and claim conflicts                                                         | PostgreSQL transaction/race test and provider delete/retry/version behavior                              |
| Daily scheduler is installed with correct timezone and duplicate-run behavior                  | Project policy says daily; no scheduler resource is installed                                                                                      | Owner chooses run window/timezone and worker; observe scheduled execution and at least one failure alert |
| Medical note attachments are not expired by selfie job                                         | Current code prefix/schema separation and no attachment retention job                                                                              | Owner must define a separate note retention policy before adding a purge/lifecycle rule                  |

## Local evidence collected

- API focused suite: `test/jobs/selfie-retention-runner.test.ts`, `test/modules/selfie-upload.test.ts`, `test/modules/selfie-upload-prisma-repository.test.ts`, and `test/routes/attendance-selfie-uploads.test.ts` — **4 files, 45 tests passed**.
- Prettier check passed for the AUD-21 implementation files. No migration was created or applied.
- `tsc --noEmit -p tsconfig.json` still exits nonzero with 316 diagnostics across the API project, including test matcher typing. The production build-project check (`tsc --noEmit -p tsconfig.build.json`) still exits nonzero with 19 diagnostics in existing unrelated repositories/storage adapters (Prisma error narrowing and S3 client typing). Neither check reported diagnostics in the changed AUD-21 production retention/service/repository files; this is not a project-wide typecheck pass.
- The CLI was **not** run: no authorized DB URL was available for an environment-backed run. The repository tests use mocked Prisma, not PostgreSQL. No storage/provider, scheduler, deployment, alert, or actual dry-run side-effect trace was observed.

## Deployment, metrics, and alert runbook (not executed)

Before activating the daily job, the owner/operator must approve the staging account/resource, expected cost, run window, timezone, synthetic test data, and alert recipient. Confirm the deployment runbook's region and exact App Platform source commit; use a dedicated worker/job component that has private network/database access and server-side storage secrets only when the mutating path runs. Keep the preview command free of storage credentials. Do not place secrets in job arguments, source, run logs, or evidence.

1. Verify `/api/v1/ready` and database connectivity in authorized staging. Run `retention:dry-run` first and preserve only the aggregate JSON. If any category is at its sample cap, record it as capped, not as a total.
2. Confirm the owner-approved daily schedule maps to `Asia/Jakarta`; provider cron timezone semantics must be checked against the actual account configuration. Do not invent a specific clock time in the App Spec.
3. Run the mutating command only on the approved schedule. Require a single active job instance or prove safe concurrency with PostgreSQL before allowing overlap. Existing row claims are not a substitute for an observed provider-level singleton guarantee.
4. Capture aggregate run ID, source commit, start/end time, exit code, batch-limit status, watermarked count, attached-purge count, staging-purge count, and failure count. Never log object key, signed URL, account credential, selfie, employee identity, or medical content.
5. Alert on nonzero exit, thrown database/storage error, repeated partial failures, or `reachedBatchLimit: true`. The alert must reach a named incident owner and link to a redacted run record. A JSON log and process exit code alone are not proof that an alert was delivered.
6. Re-run after a failed batch to confirm delete/metadata retries are idempotent and no attendance/audit rows or unrelated attachment objects were removed. Use synthetic records only.

No live metrics backend, alert receiver, job schedule, or retention run currently exists. Do not represent these steps as provider evidence.

## Dependencies and next decisions

- Owner/operator: provision/identify approved staging and database, approve cost and synthetic test window, select exact daily run window/timezone and named incident recipient.
- Platform operator: confirm how App Platform scheduled jobs source the repository image/command, inject only required runtime secrets, avoid overlapping runs, capture exit status, and deliver failure alerts. The local App Spec is not provider validation.
- Test owner: run dry-run against disposable PostgreSQL with synthetic counts; add/execute disposable-PostgreSQL concurrency and metadata-reference assertions; then observe the real scheduled run and alert.
- Product owner: define medical-note attachment retention separately. Keep current selfie lifecycle from touching `attendance-requests/doctor-notes/`.

AUD-21 remains **PARTIAL** until an authorized scheduled environment run, provider/DB side-effect evidence, and a delivered failure alert are reviewed. A mocked dry-run test or runbook is not equivalent to those acceptance criteria.
