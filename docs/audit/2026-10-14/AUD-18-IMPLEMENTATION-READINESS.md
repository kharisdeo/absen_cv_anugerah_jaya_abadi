# AUD-18 — Readiness assisted attendance

**Status artefak:** analisis/readiness lokal selesai. **Status implementasi:** gated sampai owner menyetujui policy akun/perangkat bantuan. `BLOCKED` berlaku pada implementasi task ini, bukan artefak lokal. Tanggal review: 15 Oktober 2026.

## Ringkasan

PRD menyatakan karyawan dapat dibantu memakai HP toko/Supervisor dengan akun karyawan sendiri dan selfie; hasil wajib diberi label assisted dan otomatis `Perlu verifikasi`. Jika tidak ada perangkat, jalurnya laporan saat itu lalu koreksi sesuai batas waktu. Hal ini harus dibedakan dari request koreksi, attendance-review Supervisor, atau karyawan memakai akun Supervisor.

Attendance attempt saat ini mensyaratkan principal `EMPLOYEE`, employee ID, dan device binding server-side berstatus `APPROVED`. Login/session/device-binding adalah gate reguler. Membuka route, menurunkan gate, mengizinkan shared credential, atau mengganti binding personal dengan device toko akan menjadi bypass keamanan. Belum ada kontrak limited assisted context, consent, actor/helper, expiry/replay, scope dan audit yang menghubungkan PRD ke workflow aman. Tidak ada source/schema/provider change pada AUD18.

Jika policy disetujui, employee tetap subject attendance dan helper dibuktikan terpisah. Context bantuan tidak mewarisi role employee, tidak menukar device binding akun, tidak menerima employeeId/helperId/storeId sebagai otoritas browser, dan selalu menghasilkan record pending review. Ini target desain, bukan fitur yang tersedia.

## Bukti checkout

| Fakta                   | Bukti                                                                                                                               | Implikasi                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Assisted requirement    | PRD §5.2/fallback meminta akun employee sendiri, selfie dari HP toko/Supervisor, label assisted, status Perlu verifikasi.           | Acceptance minimum adalah pending; helper/device consent dan fallback perlu keputusan. |
| Session/device identity | Auth principal memuat role, account, employee, binding ID/status; login mengikat sesi ke binding.                                   | Jangan menyamar sebagai Employee dari sesi Supervisor/helper.                          |
| Attempt gate            | `attendance/authorization.ts` menerima hanya employee dengan `employeeId`, binding ID dan binding `APPROVED`.                       | Jangan menghapus assertion agar assisted melewati gate.                                |
| Attempt receipt         | Route attendance attempt mengambil principal dari session; service mengikat owner, idempotency, selfie/location dan server receipt. | Subject, assignment, server time dan scope harus dari server.                          |
| Selfie                  | Camera capture, staged evidence owner/device-bound, seal/private storage dan scoped review sudah ada; no gallery upload.            | Jangan menerima gallery file/helper selfie atau object key/token dari client.          |
| Validation              | Trusted-liveness evidence saat ini false; pending state/review terpisah dari valid/approved.                                        | Assisted tidak auto-valid dan selfie tidak sendirinya membuktikan presence.            |
| Supervisor              | Store assignment dan review scope dicek server pada workflow terkait.                                                               | Review route bukan izin membuat assisted attendance lintas toko.                       |
| Audit                   | Attempt/verification menulis audit dan sanitizer melindungi token/selfie/location.                                                  | Assisted perlu mencatat actor/helper tanpa menyimpan bukti sensitif mentah.            |

Sumber utama: `docs/PRD.md` (assisted/fallback/privacy), `docs/DECISIONS.md` (auth/device binding, attempt/selfie/review), `docs/TODO-implementation-plan.md` (BE-010/FE-014/FE-005/FE-018), `apps/api/src/modules/attendance/authorization.ts`, `attendance/index.ts`, `attendance/prisma-repository.ts`, auth/session, device-binding, selfie upload, supervisor store assignment, verification routes/repository, dan `apps/api/prisma/schema.prisma`. Line number harus di-refresh saat implementasi.

## Keputusan owner yang wajib sebelum coding

| ID     | Pertanyaan                                                              | Opsi yang dapat ditimbang, belum final                                                                                                                    | Risiko jika ditebak                                                           |
| ------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| AST-01 | Bagaimana employee terautentikasi bila binding personal tidak tersedia? | Limited enrollment di perangkat publik; helper memulai context dan employee membuktikan akun melalui faktor terpisah; atau tetap gunakan laporan/koreksi. | Password employee dipakai bersama atau helper bertindak sebagai employee.     |
| AST-02 | Apakah HP toko/Supervisor boleh menjadi binding personal?               | Pertahankan binding pribadi; context ephemeral terpisah, bukan binding.                                                                                   | Menghapus kontrol satu device approved per employee atau mengambil alih sesi. |
| AST-03 | Bagaimana consent/identity dua pihak dibuktikan?                        | Konfirmasi explicit, employee re-auth, atau mekanisme approved privacy/security.                                                                          | Attendance dibuat tanpa sepengetahuan employee.                               |
| AST-04 | Siapa helper yang sah dan scope-nya?                                    | Active Supervisor assigned pada store; Admin hanya bila ditetapkan.                                                                                       | Cross-store IDOR atau bantuan tanpa scope.                                    |
| AST-05 | Expiry, nonce, replay, retry dan attendance target?                     | Context singkat, sekali pakai, employee/helper/store/type bound, retry idempotent.                                                                        | Context digunakan ulang untuk orang atau shift lain.                          |
| AST-06 | Apakah assisted offline didukung?                                       | V1 online-only; offline tetap pending dengan candidate date/review.                                                                                       | Jam helper menggantikan server receipt atau stale payload dianggap valid.     |
| AST-07 | Evidence/retention/reviewer?                                            | Metadata minimum, private selfie sesuai policy, review oleh scoped role.                                                                                  | Kebocoran bukti atau retensi yang salah.                                      |
| AST-08 | Apa yang terjadi pada normal flow saat binding pending/revoked?         | Assisted flow dipisahkan; tidak mengubah regular session/device status.                                                                                   | Bypass auth normal atau membuka fitur lain pada shared device.                |

Tidak ada pilihan di atas yang ditetapkan oleh dokumen ini. Policy akun employee sendiri dan perangkat bantuan wajib dicatat sebagai keputusan produk/security/privacy.

## Alur target (proposal, bukan kontrak final)

1. Employee menginisiasi intent dan membuktikan identity melalui mekanisme owner-approved; server mengikat intent pada employee/account aktif, bukan UUID browser.
2. Helper masuk dengan akun sendiri. Server memeriksa role/status dan store assignment; store ambigu/lintas scope ditolak. Helper tidak menerima cookie/token Employee.
3. Server menerbitkan context opaque pendek yang terikat employee, helper, store, attendance type, nonce dan expiry. Penyimpanan/replay consumption durable; tanpa PII di URL/local storage.
4. Kedua pihak memeriksa intent dan consent sesuai policy; selfie diambil live dari camera, bukan gallery atau upload umum.
5. Server memproses satu attempt dengan actor/helper context tervalidasi, receipt server, shift/store assignment, selfie ownership, dan proof yang tersedia. `ASSISTED` dibuat server setelah auth, bukan client claim.
6. Record selalu `PENDING_VERIFICATION`, menampilkan label assisted dan masuk review queue. Review dilakukan actor berwenang sesuai segregation policy; tidak ada auto-VALID.
7. Retry dengan identity sama mengembalikan receipt yang sama; replay context/nonce atau payload berbeda ditolak. Expired/revoked context tidak dapat digunakan.

Jika identity tidak dapat dibuktikan, helper tak berwenang, consent ditolak, camera/storage/verifier unavailable atau context expired, flow berhenti tanpa attendance valid. Fallback adalah laporan/koreksi PRD; jangan backdate dengan jam helper.

## Peta implementasi setelah policy

- **Auth/session:** context purpose/scope terpisah; jangan memakai sesi Supervisor sebagai principal Employee. Jangan melewati `requireRegularAccess`/binding tanpa endpoint terbatas. Mekanisme faktor employee dipilih owner/security.
- **Schema/service:** context dengan employee, helper, store/shift/type, server expiry, nonce/idempotency, consent/result, consumed-at dan audit correlation. Final field bergantung policy. Unique/conditional consume mencegah reuse; method/status dibuat server.
- **Attendance/selfie:** reuse assignment/geofence/receipt/selfie ownership jika cocok; jangan bypass validator, liveness, no-fix, atau immutable attempt. Scoped review image hanya untuk reviewer sah.
- **Authorization:** helper active + store scope sesuai policy; employee ownership diverifikasi server; creator/helper tidak boleh menyetujui event sendiri jika segregation disyaratkan. Cek IDOR employee/store/helper/attempt.
- **Audit/privacy:** audit atomic pada create/consume/decision; actor, helper, store, purpose, request ID, reason/status dan server time seperlunya. Jangan catat password, token, selfie bytes, URL/key, koordinat atau secret.
- **Frontend:** employee consent/identity screen dan helper mode berbeda; tidak menyimpan token lama di local/session storage; clear context/camera setelah selesai/timeout; UI menyatakan status pending. UI bukan authorization.
- **Operations:** online-only bila offline belum diputuskan; CSRF/Origin, no-store/rate-limit; metrics tanpa PII; retention per evidence type; recovery idempotent.

## Acceptance dan test matrix

### Unit/API

- Employee tanpa approved binding tetap menerima error existing untuk normal attendance. Endpoint normal tidak menerima flag helper atau `ASSISTED` untuk bypass.
- Context server-issued, one employee/helper/store/type, short expiry dan single consume; retry sama idempotent; mismatch/expired/revoked/other helper ditolak.
- Helper bukan employee principal; Supervisor active + assigned store; Admin/employee/unassigned/other-store ditolak sesuai policy. Browser tidak dapat memalsukan role/employeeId/storeId/helperId/method/status.
- Consent missing/declined, account mismatch, revoked binding, selfie owner mismatch, no-fix, liveness unverified dan unknown network tidak menghasilkan VALID.
- Attempt selalu PENDING_VERIFICATION dan method ASSISTED dari server; status/label masuk queue. Reviewer authorized dapat memutus dengan reason/audit; helper tidak mengubah status sendiri bila segregation diputuskan.
- Audit/DTO tidak memuat secret/foto/URL/key/koordinat mentah; no-store, Origin/CSRF, rate limit, concealment dan retention diuji.
- Capture hanya live camera; gallery-only file dan token context durable di browser storage ditolak.

### PostgreSQL concurrency

Gunakan database disposable: dua helper consume context sama; retry saat response hilang; perubahan employee assignment/status bersamaan; Supervisor unassign/disable vs consume; binding revoke vs normal attempt; context consume dan insert attempt/audit rollback; duplicate attendance idempotency; review decision bersamaan. Assert paling banyak satu consume/attempt/audit per identity, rollback atomik, scope tepat dan tidak ada VALID.

### Browser/device

Uji Chrome Android dan Safari iOS: camera permission/secure context, shared device dengan dua akun berturutan, back/reload/suspend, expiry, jaringan lemah, online-only, logout dan cleanup state/camera. Helper credential tidak pernah muncul pada employee session/response; shared phone tidak mengubah device binding; status pending selalu jelas. Mock bukan bukti kamera/perangkat nyata.

## Gate dan validasi

Mulai implementasi setelah owner/security/privacy menetapkan AST-01..08, faktor autentikasi employee, device-sharing, helper/reviewer scope + segregation, consent, TTL/replay/offline, status, audit/privacy/retention dan fixture. Backend auth/context + PostgreSQL concurrency mendahului UI. Verifikasi independen lokal: sembilan suite API auth/device-binding/attempt/selfie/review lulus 118/118; ini tidak menguji workflow assisted baru. Tidak ada database/provider/browser test dijalankan dan tidak ada production code/schema/deployment berubah. Dokumen bukan klaim assisted attendance tersedia.
