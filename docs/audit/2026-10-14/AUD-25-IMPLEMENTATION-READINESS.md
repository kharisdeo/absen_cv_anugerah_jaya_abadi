# AUD-25 — UUID/ExcelJS advisory readiness

**Checkpoint:** 2026-10-15  
**Status:** PARTIAL — local reachability and XLSX round-trip checked; fresh dependency audit and owner risk decision remain open.  
**Scope:** assess `GHSA-w5hq-g745-h8pq` for the locked `uuid@8.3.2` transitive dependency of ExcelJS. No package install, dependency override, lockfile edit, environment-secret read, or external project mutation was performed.

## Finding and dependency evidence

- `apps/api/package.json` pins `exceljs` to `4.4.0`.
- `pnpm-lock.yaml` resolves ExcelJS's `uuid` dependency to `8.3.2`; the installed package under `node_modules/.pnpm` agrees. This is a local lock/install observation, not a registry audit.
- The GitHub advisory rates the issue Moderate. It affects `v3()`, `v5()`, and `v6()` when an external output buffer/offset is supplied; patched releases are `11.1.1`, `12.0.1`, and `13.0.1`. The advisory explicitly distinguishes these API methods from uuid package release numbers and says `v4()` checks bounds. See [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq).
- The installed ExcelJS 4.4.0 library has one `require('uuid')` call site found by source search: `lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js`. It imports `v4` and invokes `v4()` without caller-provided buffer or offset. The application uses ExcelJS in `apps/api/src/modules/report/xlsx.ts`; a source/test search found no direct application import of the `uuid` package. This supports “the advisory's vulnerable API path was not found reachable in this application's current ExcelJS use,” not a claim that the dependency is patched or that all future ExcelJS paths are safe.
- ExcelJS's package manifest declares `uuid: ^8.3.0`. A forced `uuid@11.1.1` override would cross that declared major range. No override was made because it has not been compatibility-tested in this repository. The official upstream [ExcelJS manifest](https://github.com/exceljs/exceljs/blob/master/package.json) still shows the 8.x range at this checkpoint. The upstream [PR #3085](https://github.com/exceljs/exceljs/pull/3085) proposing uuid 11 is Draft, has no reviews, and reports its upstream test command blocked; it is not a released fix or acceptance evidence.

## Verification performed

| Check                             | Result                                                                               | Evidence boundary                                                                                                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lockfile and installed dependency | `exceljs@4.4.0` → `uuid@8.3.2`                                                       | Local `apps/api/package.json`, `pnpm-lock.yaml`, and installed package metadata.                                                                                                                                                               |
| Reachability/API use              | Only the ExcelJS `v4()` no-buffer call site found; no direct app `uuid` import found | Static search of the installed ExcelJS `lib` and application source. Not a general SAST proof.                                                                                                                                                 |
| XLSX round-trip                   | **PASS**, 1 file / 1 test                                                            | `apps/api/test/modules/monthly-report-xlsx.test.ts`; synthetic workbook loaded back and assertions passed. Run from `apps/api`: `& ..\..\node_modules\.bin\vitest.cmd run --config vitest.config.ts test/modules/monthly-report-xlsx.test.ts`. |
| Fresh package audit               | **NOT RUN**                                                                          | `pnpm audit --json` stopped in Corepack before command execution while trying to fetch pnpm 11.25.0: registry DNS returned `ENOTFOUND registry.npmjs.org`. This is not an audit result and does not establish zero findings.                   |
| Override compatibility test       | Not applicable; no override made                                                     | No dependency or lockfile change.                                                                                                                                                                                                              |

An earlier audit snapshot in `docs/DEP-004B-pnpm-audit.json` is historical and predates this checkpoint; it must not be used as fresh evidence for this GHSA.

## Temporary risk decision record — pending owner approval

**Assessment:** retain the locked dependency temporarily for the current local build because the affected uuid API was not found reachable through the current ExcelJS call site, while avoiding an untested major override that could break XLSX generation. This is a risk recommendation, **not an approved risk acceptance**. The dependency is still advisory-affected by version and a complete fresh dependency audit was unavailable.

- **Accountable decision owner:** project/product owner for CV Anugerah Jaya Abadi; an individual's name and explicit assignment are not present in the repository.
- **Required decision deadline:** before any staging deployment that exposes the application to users; production go-live is an absolute gate. No calendar date has been approved or invented here.
- **Decision required:** either (1) accept the narrowly evidenced temporary residual risk in writing, with a named owner and review date, while monitoring a released ExcelJS fix; or (2) choose a remediation path and require a fresh audit plus XLSX round-trip/compatibility tests before merge. No acceptance, waiver, or remediation choice is recorded yet.
- **Revisit trigger:** a released ExcelJS version with a patched compatible uuid dependency, a newly found app call to `v3`/`v5`/`v6` with external buffers, or a successful fresh audit in an environment with registry access.
- **Release gate:** do not describe the dependency as clean or mark AUD-25 complete until a fresh audit and an explicit owner decision/remediation are recorded. Do not use `npm audit fix --force` or a blanket major override as a substitute for compatibility tests.

## Next safe actions

1. In a registry-connected environment, run `pnpm audit --json` from the repository root and save the exact timestamped output; inspect the complete report, not only the `high` threshold used by CI.
2. Have the project/product owner name the accountable reviewer and decide risk acceptance/deadline or authorize a tested remediation.
3. If changing ExcelJS or uuid, regenerate the lockfile with the pinned package manager, run the XLSX round-trip and full report tests, review generated XLSX behavior and dependency tree, and rerun the fresh audit. Do not commit or deploy this audit artifact until separately reviewed.
