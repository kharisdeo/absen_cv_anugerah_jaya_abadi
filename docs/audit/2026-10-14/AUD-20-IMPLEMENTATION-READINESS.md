# AUD-20 — Private storage provider validation/readiness

**Status: PARTIAL** — runbook and validation plan are ready locally; no DigitalOcean
Spaces provider assertion has been run or verified.

Snapshot: 15 October 2026 (Asia/Jakarta). This artifact is preparation for the selected
DigitalOcean staging target only. It does not authorize provisioning, deployment, production
use, or processing real employee evidence.

## Actual state and scope

The staging decision selects a private DigitalOcean Spaces bucket in `SGP1`; the application
and API staging target is DigitalOcean App Platform in `SGP`. The repository's pre-provisioning
runbook explicitly records that no DigitalOcean account, application, database, Spaces bucket,
key, domain, or deployment has been created. For this AUD-20 snapshot, account access, resource
existence, bucket privacy/configuration, credentials, and a reachable staging app are **not
present or not verified**. Selection of a provider is not evidence that its account/resources
exist or satisfy the design.

No provider account, credential, network endpoint, deployment, or paid resource was accessed.
No `.env`, source, schema, migration, README/index, or Git configuration was changed. The only
new file for this task is this artifact. No real employee/selfie/medical-note data may be used
for the eventual staging validation; use synthetic bytes and synthetic identities only.

Relevant contracts reviewed:

- [`docs/DECISIONS.md`](../../DECISIONS.md): staging-only Spaces choice and BE-015 private-selfie contract.
- [`docs/runbooks/digitalocean-staging.md`](../../runbooks/digitalocean-staging.md): pre-provisioning boundary, target regions/configuration, and cost/approval gates.
- [`docs/API.md`](../../API.md): selfie intent/read/retention and sick-request attachment endpoints.
- [`docs/PRD.md`](../../PRD.md): private temporary photo access and 12-month default selfie retention.
- `apps/api/src/modules/attendance/private-selfie-storage.ts` and
  `apps/api/src/modules/attendance-requests/private-request-attachment-storage.ts`.
- Matching adapter/service/route tests under `apps/api/test/modules` and `apps/api/test/routes`.

The AWS SDK S3-compatible adapters show intended requests, not DigitalOcean behavior. In
particular, the selfie adapter does not set a public ACL; application code cannot prove bucket
privacy, public-access blocking, CORS, encryption at rest, versioning, or deletion of old
object versions. Provider documentation/reference links in the existing runbook are setup
references only, not evidence that a bucket is configured or that an assertion passed.

## Application behavior the provider validation must preserve

**Attendance selfies.** An authenticated Employee with an active profile and approved device
requests a one-use opaque upload intent. The API returns a signed PUT URL and the required
`Content-Type` and `x-amz-meta-referencehash` headers; the object key is not returned. Upload
URL TTL is 30–300 seconds (default 120). Staging keys use `attendance/selfie-staging/`. On
attendance submission the server checks the intent owner/device/expiry and reads the object,
then verifies reference metadata, declared and actual type, image signature/dimensions, size
(maximum 200 KiB), and stable ETag. The server writes accepted bytes to a separate reserved
private key with `If-None-Match: *`; clients never receive an accepted-key PUT URL. The accepted
original is immutable from the client path. A private watermarked JPEG derivative is used for
review; the read URL is issued only after server authorization and points to the derivative.
The bucket must be private, with public access blocked; the current decision requires versioning
and Object Lock disabled. CORS is restricted to the exact application origin, PUT, and the two
required upload headers. Selfie retention is 12 months from server receipt by default; expired
staging/orphan and attached staging objects are cleaned by the retention worker.

**Sick-request attachments.** The employee submits a JPEG/PNG/WebP doctor-note image through
the API (maximum 5 MiB); the service checks its byte signature and stores it beneath the
separate `attendance-requests/doctor-notes/` prefix. This adapter also omits public ACL and sets
private/no-store response cache policy. The attachment URL is minted only after the repository
proves request ownership/reviewer scope, expires after 120 seconds, and sets
`Content-Disposition: attachment`; the object key is never returned. Supervisor access is
limited to the uniquely derivable scheduled store assigned to that Supervisor; ambiguous/global
scope fails closed. The attachment adapter has a delete operation but **no agreed attachment
retention/lifecycle policy or scheduled purge**. Do not apply the selfie 12-month rule to medical
notes or configure automatic expiry/deletion for this prefix without a separate owner decision.

For the current UI, selfie signed reads are loaded as an image and doctor notes are opened as a
download link. The current CORS decision is for browser PUT uploads only. Do not broaden read
CORS to `*` or add GET/HEAD merely to make an S3 URL appear private: authorization is the server's
responsibility. If a future client switches to JavaScript `fetch`/canvas for cross-origin reads,
revise the exact-origin CORS contract and retest before shipping.

## Safe execution gate (not performed)

Before any provider validation, the owner/operator must explicitly approve the DigitalOcean
account/project, staging-only scope, selected region/plans and current cost estimate, and a
synthetic-data test window. Confirm that the target is not production. Confirm the exact HTTPS
`APP_ORIGIN`; provision the bucket as private with no public CDN, and verify the required
versioning/Object Lock state. Create a dedicated key with the minimum privileges supported by
the provider and bucket; if access cannot be bounded adequately, record that limitation and get
the owner's risk decision before enabling the integration.

Only after those approvals, configure all required API runtime values together:

| Variable             | Staging intent                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `STORAGE_ENDPOINT`   | `https://sgp1.digitaloceanspaces.com`                                                    |
| `STORAGE_REGION`     | `sgp1`                                                                                   |
| `STORAGE_BUCKET`     | Approved private staging bucket name; never put a secret here.                           |
| `STORAGE_ACCESS_KEY` | Dedicated runtime secret; do not paste into chat, source, shell history, or this report. |
| `STORAGE_SECRET_KEY` | Dedicated runtime secret; same handling as access key.                                   |

Use the approved HTTPS app origin as the sole allowed CORS origin. For selfie upload, allow PUT
and only `Content-Type` plus `x-amz-meta-referencehash`; do not allow public ACL headers. Keep
API access keys server-side and out of the browser. Do not use real evidence during tests. These
are preconditions for a future authorized run, not steps executed by AUD-20.

## Provider validation matrix

Run the provider rows against a newly generated synthetic test object in the approved staging
bucket, not against any employee record. Use one run ID and unique synthetic keys for the run.
Capture assertion, timestamp, staging commit, region, status, and sanitized result. Do not save
full signed URLs, their query strings, credentials, raw request/response dumps, medical content,
employee identifiers, or object keys in this artifact, CI logs, screenshots, or general tickets.

| ID  | Assertion and safe procedure                                                                                                                                                                                                                                                                                                                                                            | Pass condition                                                                                                                                                                                                                                                                                                                               | Evidence class / current state                                                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0  | Confirm actual account/project, `SGP1` bucket identity, app origin, and that this is staging. Confirm owner approval and the cost/plan decision before tests.                                                                                                                                                                                                                           | Operator can identify the actual resource and approved scope without exposing account secrets. No production resource is involved.                                                                                                                                                                                                           | Provider/account assertion. **Not run: account/resource/staging not verified.**                                                                         |
| P1  | From a clean unauthenticated client, issue anonymous `GET` and `HEAD` for a known synthetic object, and anonymous bucket listing. Record only HTTP result and whether any body bytes were returned.                                                                                                                                                                                     | No operation returns object bytes or lists keys. `403` is expected; a non-success `404` is acceptable only if the test also proves no bytes/list access. Never treat obscurity of an object key as access control.                                                                                                                           | Provider assertion. **Not run: no bucket.**                                                                                                             |
| P2  | Inspect bucket access controls in the account and, independently, repeat P1. Check bucket/object ACL or equivalent policy, public-access block, and CDN/public endpoint state.                                                                                                                                                                                                          | Bucket and objects are private; public access/CDN is off; P1 remains denied. No ACL is added by application PUTs.                                                                                                                                                                                                                            | Provider configuration + black-box assertion. **Not run.**                                                                                              |
| P3  | Request a selfie upload intent through the real staging API using a synthetic Employee/device fixture. Without printing the returned URL, inspect its TTL and signed headers in a protected test process; preflight from exact `APP_ORIGIN` for `PUT` and the required headers.                                                                                                         | URL TTL matches the issued `expiresAt` and is within 30–300 seconds (default 120); signature binds `Content-Type` and `x-amz-meta-referencehash`; no ACL/public header is signed. CORS returns the exact origin, permits PUT and only the needed headers; no wildcard origin.                                                                | Provider + staging API/browser assertion. Current local SDK presigner tests are only mocks; **provider not run**.                                       |
| P4  | Upload a synthetic valid image with exactly the signed method/headers from an HTTPS page at the approved app origin. Then test a disallowed origin, altered signed header, wrong method, and an expired URL. Do not reuse a URL after its short test window.                                                                                                                            | Allowed upload succeeds; origin/header/method tampering and expired URL do not create/replace an accepted object. An expired URL is rejected after the advertised expiry. No public ACL is created.                                                                                                                                          | Provider + real browser/network assertion. **Not run.**                                                                                                 |
| P5  | From the real staging UI, perform the signed selfie read path after creating a synthetic attendance record, then repeat after URL expiry. Inspect response headers without retaining the URL.                                                                                                                                                                                           | Only an authorized reviewer obtains a URL; it targets the watermarked derivative, is HTTPS, short-lived (same 30–300-second contract), expires as advertised, and responds `Cache-Control: private, no-store`. Expired access returns no image bytes. Current image-element path does not require JS read CORS.                              | Provider + staging API/browser assertion. **Not run.**                                                                                                  |
| P6  | Test the doctor-note route with a synthetic valid note. Try employee owner, a different employee, Admin, assigned Supervisor with one unambiguous store, Supervisor from another store, and ambiguous/global schedule. For denied cases observe whether a signed URL was minted.                                                                                                        | Only the owner or a reviewer allowed by the current server scope can get a URL; wrong owner/store and ambiguous scope fail closed (same safe not-found behavior where specified) before signing. URL TTL is 120 seconds; download response has attachment disposition and `private, no-store, max-age=0`; DTO/list never reveals object key. | Local service/repository/route tests are mock-based. Provider+staging assertion **not run**.                                                            |
| P7  | Preflight PUT from an unapproved origin and request unsupported methods/headers. Exercise the current UI's image and download navigation with a signed read URL; do not add broad GET CORS.                                                                                                                                                                                             | Unapproved origin cannot read/use a browser PUT response. CORS does not grant anonymous object access. Current read UX works without widening CORS; if it does not, stop and revisit contract rather than using `*`.                                                                                                                         | Provider/browser assertion. **Not run.**                                                                                                                |
| P8  | Complete a synthetic selfie attempt. Reuse/alter the staging upload after sealing and attempt a client write to the accepted key (there must be no client signed URL for it). Inspect the server-side accepted write condition and object bytes/ETag before and after.                                                                                                                  | Accepted write uses `If-None-Match: *`; a duplicate accepted-key write is rejected and accepted bytes remain unchanged. A still-live staging URL cannot mutate the already sealed accepted copy. Read returns only derivative, not original.                                                                                                 | Local adapter test asserts the conditional request; provider assertion needs actual S3-compatible behavior and **is not run**.                          |
| P9  | In bucket settings, verify versioning/Object Lock state. On an isolated synthetic key, test the permitted delete path and then repeat anonymous/authenticated reads. If versioning is enabled, inspect whether old versions remain.                                                                                                                                                     | Versioning and Object Lock are disabled per current selfie contract; synthetic deleted object is no longer readable, and no retained prior version is accessible. Never test deletion on a real record.                                                                                                                                      | Provider/account assertion. **Not run.** If versioning is on or cannot be verified, fail this gate; do not assume `DeleteObject` removed every version. |
| P10 | Verify in-transit TLS for API→Spaces and client→signed URL (HTTPS, valid certificate, no downgrade/redirect to HTTP). Verify at-rest encryption for the actual bucket/account using account-specific evidence or authoritative provider support for this exact service/region.                                                                                                          | All actual endpoints are HTTPS with valid certificate and no secret-bearing redirect. At-rest encryption is affirmatively evidenced for the actual bucket/service, or this item remains open with an explicit owner risk decision.                                                                                                           | TLS black-box + provider/account assertion. Provider docs alone are not an implementation/configuration assertion. **Not run.**                         |
| P11 | Run the retention worker only on a disposable synthetic staging fixture after AUD-21 cadence/worker prerequisites and owner authorization. Cover attached staging object, expired intent/orphan, expired accepted selfie, repeat run after successful delete, and a simulated storage failure. Separately establish an owner policy for doctor-note deletion before any lifecycle rule. | Selfie retention uses server receipt + configured 12-month policy; deletes are idempotent, metadata key becomes null only after success, and attendance/metadata remain. Worker errors are surfaced/non-zero. No doctor-note purge occurs until its separate retention decision is approved.                                                 | Current local worker tests are not provider proof. **Provider run not performed; attachment retention is an unresolved policy gate.**                   |
| P12 | Exercise privacy at the API and browser boundary: inspect DTOs, list/history/dashboard, logs, cache headers, browser storage/referrer behavior, and reviewer download behavior using sentinels.                                                                                                                                                                                         | No object key, access key, signed URL, medical bytes, or selfie bytes appear in public DTOs/logs/storage. API responses use `no-store`; doctor note downloads as attachment; reviewer authorization precedes URL signing; browser sends no referrer to the storage URL.                                                                      | Unit/DOM evidence can cover app behavior only; browser/provider assertion **not run**.                                                                  |

For every provider test, preserve only sanitized output: run ID, commit SHA, region, a non-secret
bucket alias, assertion ID, UTC/WIB time, pass/fail, HTTP status, selected non-sensitive response
headers, and a short redacted diagnostic. Replace any URL with `[SIGNED_URL_REDACTED]`; remove
all query parameters, credential-like headers, object identifiers, account IDs, employee data,
and medical/selfie content. Disable verbose SDK/HTTP signing logs. Evidence with a complete
presigned URL is a bearer credential: revoke/delete the synthetic object and expire the URL,
and treat any leaked copy as credential exposure. Keep raw provider evidence in the approved
restricted evidence location, not in Git.

## Local evidence obtained for this task

Command executed from `apps/api`:

```text
..\..\node_modules\.bin\vitest.cmd run test/modules/private-selfie-storage.test.ts test/modules/private-request-attachment-storage.test.ts test/modules/selfie-upload.test.ts test/modules/selfie-upload-prisma-repository.test.ts test/routes/attendance-selfie-uploads.test.ts test/routes/attendance-verifications.test.ts test/modules/attendance-requests.test.ts test/modules/attendance-requests-prisma-repository.test.ts test/routes/attendance-requests.test.ts
```

Result: exit code 0; 9 test files passed, 85 tests passed. These are local test-suite results
using the repository's fixtures, mocks/fakes, and signed-URL generation code. They do **not**
connect to DigitalOcean Spaces, prove anonymous denial/CORS/TLS/encryption/provider TTL behavior,
run a real browser or PostgreSQL database, or verify deployed ownership/store authorization.
No database migration, deployment, provider API, or credential was used.

## Failure handling and rollback for a future authorized run

1. Stop the test immediately on any anonymous success, wildcard CORS, wrong origin/header
   acceptance, URL lifetime mismatch, public ACL/CDN, accessible accepted-original URL, failed
   owner/store denial, missing encryption evidence, or ambiguous delete/version behavior. Do not
   use the bucket with real evidence.
2. Disable staging evidence creation through the approved operational control/feature setting
   while investigating; the API is designed to fail closed when storage is unavailable. Do not
   change production. Do not “fix” a failure by publishing a bucket, broadening CORS, signing an
   accepted key, or making a URL longer-lived.
3. Revoke/rotate only the dedicated staging key through the owner-controlled provider process
   if it may have leaked. Update the encrypted staging runtime secret through the authorized
   change path; never place replacement values in Git, shell output, or this document.
4. Delete only the exact synthetic keys created by the current run after preserving sanitized
   evidence. Do not use bucket-wide recursive deletion, and do not remove real employee objects
   or database records as rollback. Confirm anonymous denial again after cleanup.
5. Keep the task PARTIAL until failed assertions are corrected, the full matrix is rerun against
   the actual staging provider, and the sanitized evidence has independent review. A runbook,
   unit test, successful presigner output, or provider documentation is not a substitute.

## Acceptance and blockers

| Acceptance item                                                                 | State                                                       |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Actionable Spaces staging runbook/validation prepared locally                   | **Ready in this file**                                      |
| Anonymous deny, actual CORS, signed PUT/read, TTL and response headers          | **Not verified — provider/staging absent or unverified**    |
| Actual owner, device, request and store-scope behavior on deployed API          | **Not verified end-to-end — local tests only**              |
| Sealed-object immutability, provider deletion/version state, at-rest encryption | **Not verified — provider assertions absent**               |
| Selfie retention against provider                                               | **Not verified; worker scheduling is a separate task/gate** |
| Doctor-note retention/deletion                                                  | **Owner policy missing; do not infer selfie policy**        |
| Sanitized provider evidence reviewed                                            | **None exists yet**                                         |

Next dependency: owner-authorized creation/identification of the staging account and resources,
staging API availability, and approved synthetic-data validation window. Resolve the medical-note
retention policy separately before lifecycle/deletion acceptance. Until then AUD-20 remains
**PARTIAL**, not COMPLETE; no provider implementation assertion is claimed.
