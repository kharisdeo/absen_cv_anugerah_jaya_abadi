# AUD-24 — Device matrix, performance, and pilot readiness

Checkpoint: 2026-10-15 (Asia/Jakarta). Status: **PARTIAL**. Local source and simulated tests can guide the pilot, but no target Android/iOS device, real mobile browser session, staging environment, store survey, or load-test database was available. No pilot approval or handover is claimed.

## Existing evidence and limits

- PRD requires a mobile PWA, direct camera capture, explicit GPS capture, fair offline handling and HTTPS. The AUD-24 target matrix is Chrome Android 9+ and Safari iOS 15+; the performance targets are home page <=3 seconds, attendance <=10 seconds on a defined 4G reference network, and payload <=300 KB.
- Frontend tests cover camera component state, API submission, encrypted offline queue, queue ownership/logout, IndexedDB behavior under `fake-indexeddb`, and mounted React DOM flows. These tests do not run Chrome/Safari, camera/GPS hardware, permissions, actual airplane mode, device suspend/reload, browser quota eviction, PWA install, or mobile network shaping.
- Current offline queue sync is foreground-driven when the app is open and the Employee session is revalidated; this is not proof of Background Sync support. Local TODO already records no manual device matrix, no real 4G timing, no 200-employee/20-store DB workload, and no usable target device/network setup.
- Admin responsive/UI tests, bundle-size budgets, and DOM tests are not substitutes for real device layout, route/API latency, image transfer measurement or database-backed load.
- Assisted attendance is not an implemented/pilot-ready path. AUD-18 keeps identity/device-boundary decisions gated; do not test a manual fallback that impersonates the employee or bypasses personal device binding.

No browser permissions, physical camera/GPS, staging URL, provider, employee account, `.env`, or database was accessed for this checkpoint.

## Device and functional test matrix (future authorized run)

Record each result independently for every physical device/browser combination; do not collapse all Android/iOS results into a single “mobile passed.” Use synthetic employees and test store locations. The user/customer owner must select realistic coordinates/radii for every pilot store before testing geofence acceptance.

| ID  | Device/test                      | Procedure                                                                                                                                              | Pass evidence / current state                                                                                                                                                                 |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Chrome Android 9+ install/update | Fresh install via supported PWA path, add to home screen, reopen, sign in, update app, direct deep links                                               | Install/reopen/update/route and screenshots with OS/browser/app commit; **not run**                                                                                                           |
| D2  | Safari iOS 15+ install/update    | Add to Home Screen using iOS Safari flow, reopen/restore session, update/relaunch                                                                      | Safari-specific install instructions, persistence and routing; **not run**                                                                                                                    |
| D3  | Permission timing/denial         | Cold start with camera/location denied; verify permission is requested only after user taps the relevant attendance action; grant, revoke, retry       | No idle camera/GPS access; denied permission produces clear recoverable guidance and never silently records valid attendance; **simulated only**                                              |
| D4  | Camera capture                   | Front camera stream, rotate/reopen, cancel, capture, blur/unavailable camera, switch camera if supported; confirm there is no gallery/file-picker path | Capture yields expected supported bytes/dimensions/size; no stale frame or upload on cancel; **no physical camera test**                                                                      |
| D5  | GPS/geofence                     | At each approved store coordinate, test inside/outside radius, accuracy near limit, poor indoor fix, permission denied, timeout and retry              | Log fix accuracy and distance without exposing employee location; server decision and help text match configured store radius; no idle tracking; **no real coordinates/radius validated**     |
| D6  | Airplane/offline                 | Enter airplane mode before attendance, queue one or multiple captures, restore network, open app and sync; include duplicate sync/lost response        | Encrypted pending queue persists, receipt is not falsely shown as server success, retry reuses stable key/body, every item ends acknowledged or clearly pending; current simulated tests only |
| D7  | Reload/suspend/resume            | Queue pending capture; reload, force close, background/suspend across OS timer throttling, resume online/offline                                       | Queue owner/key survives appropriately, no photo/GPS plaintext in persistent storage or user-facing DTO, no duplicate attendance; **no browser/device proof**                                 |
| D8  | Storage quota/eviction           | Fill test origin storage near quota with synthetic queue items, trigger quota denial/clear-site-data/OS eviction, reopen app                           | Clear warning before data loss, no false “saved” receipt, documented recovery; no unbounded retry or corrupted queue; **not run**                                                             |
| D9  | Device replacement/logout        | Revoke old binding, log out, sign in on new device, attempt old pending/new attendance and verify owner binding process                                | Old session/binding cannot submit; queued captures are neither exposed to new user nor silently reassigned; approval/recovery follows approved policy; **not run**                            |
| D10 | Assisted attendance              | Attempt only after AUD-18 identity/helper/scope/consent/expiry/replay design is approved                                                               | Employee identity remains the actor; assisted flag stays pending for review; helper cannot impersonate or bypass binding; currently **not a pilot feature**                                   |
| D11 | Desktop Admin/Supervisor         | Chrome/Edge responsive layouts, review lists/details, evidence expiry, requests, exports, role route denial                                            | No console/route/API error; role-scoped content and keyboard focus work at supported widths; **simulated/local tests only**                                                                   |

### Exact device/network record

For every row record: test ID, date/time/timezone, tester, physical device make/model and OS build, browser name/version, installed-vs-tab mode, app source commit/API version, screen size/scale, battery/thermal state when timing, permission state, synthetic store/coordinate profile, network provider/type, downlink/uplink/RTT/loss/jitter (or the approved network-shaping profile), steps, expected/actual, console/network error summary, duration, pass/fail, sanitized evidence link, and retest owner. Do not capture real employee selfies, credentials, live coordinates, signed URLs, or personal identifiers.

## Performance and capacity acceptance plan

1. Define the reference 4G profile with a repeatable network shaper or documented operator measurements. Record latency, jitter, packet loss and downlink; “4G” alone is not reproducible.
2. Measure a cold-cache first visit/home page and a warm revisit on each reference device. State whether the <=3s target is LCP, full interactive readiness, or another approved metric; record p50/p95 and the measurement tool/version.
3. Measure attendance from explicit tap through camera permission/capture, image processing, GPS fix, upload, server receipt and UI acknowledgment. Report both total and each stage; <=10s must identify whether user-controlled permission/poor-GPS wait is excluded.
4. Clarify the <=300 KB payload boundary before sign-off. Record separately the initial compressed page transfer, every serialized API request, and the selfie bytes/upload transfer; do not omit or silently exclude the selfie. The API selfie cap is 200 KiB, but that does not prove the full attendance exchange stays <=300 KB.
5. Load fixture 200 synthetic active employees across 20 synthetic stores with realistic shifts/device assignments and representative request/review/report workload. Use a disposable PostgreSQL dataset with owner-approved test-only targets; measure p50/p95/p99 latency, throughput, DB CPU/connections/locks, API memory/CPU, error rate and queue backlog. Do not infer DB performance from mocks or from frontend bundle size.
6. Repeat with GPS/camera errors, network interruption, duplicate/retried sync and background/resume. Preserve exact device/network/load configuration so regressions can be reproduced.

No performance observation in this checkpoint establishes any of the numeric targets. Do not label a build-size budget, unit-test duration, localhost response, or synthetic fake-repository benchmark as device/performance acceptance.

## Pilot operational gates

Before employees are invited, verify all of the following with the owner in an authorized staging/pilot:

- Final coordinates, radius and accuracy limit for every store are physically checked at the entry/work area and approved; no coordinate/radius is selected from a desk map alone.
- Two separately controlled Admin accounts exist and both can sign in, recover access and complete least-privilege role workflows; no shared Admin credential.
- Named attendance reviewer(s) and backup are assigned to each store; cross-store review is explicitly tested and denied where not assigned.
- Named incident owner/backup, notification path, escalation response target, support handover and rollback contacts are recorded and exercised.
- Login/consent/password, device approval/replacement, GPS failure, offline pending/reconnect, rejected attendance, lost response, disruption, request/review, report/export and data correction/closing are tested to the extent the feature/policy exists. Correction/closing and assisted flows remain excluded until AUD-10–13/AUD-18 gates are closed.
- Pilot users receive documented instructions for first login, camera/GPS denial, weak GPS, pending/offline receipt, replacement phone, rejected/duplicate attendance and how to contact the reviewer. No user is told pending evidence is valid attendance.
- A daily pilot check reviews failed/suspended queue items, pending attendance/review SLA, geofence complaints, API health/errors, backup state, and unresolved incidents; every exception has an owner.

## Blockers and state

| Blocker                                                                                     | Owner / next action                                                                                            |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| No physical Chrome Android 9+ and Safari iOS 15+ devices/testers                            | Owner supplies/approves device matrix or device-lab window                                                     |
| No staging deployment, TLS host, provider and representative network shaping                | AUD-20/AUD-23 gates and explicit staging approval                                                              |
| Store coordinates/radii/accuracy not physically validated                                   | Operations owner and store representative survey each location                                                 |
| No 200 employee/20 store disposable DB fixture/load target                                  | DB/test owner creates guarded isolated fixture after database availability                                     |
| Exact <=300 KB payload meaning and timing methodology not defined                           | Product/QA agree measurement boundary and reference 4G profile                                                 |
| Two Admins, reviewer/backup, incident owner and handover not validated                      | Owner names operators and completes access/recovery exercise                                                   |
| Offline D→D+1 capture-date candidate must be reviewed but current UI/review flow is missing | Keep this case pending/gated until review attribution flow exists; do not finalize work date from device clock |
| Assisted attendance unresolved; correction/closing routes/policy absent                     | Keep outside pilot scope until AUD-18 and AUD-10–13 decisions/implementation are complete                      |

AUD-24 remains **PARTIAL** until device-specific functional runs, measured performance/load results, geofence verification, two-Admin/reviewer/incident-owner checks and pilot handover are recorded and reviewed. The test matrix itself is not a pilot sign-off.
