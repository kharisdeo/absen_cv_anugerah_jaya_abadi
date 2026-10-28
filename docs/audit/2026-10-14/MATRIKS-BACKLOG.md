# Matriks audit seluruh backlog asal

Sumber: `docs/TODO-implementation-plan.md`, PRD, source dan pemeriksaan pada 14 Oktober 2026. **27 BE + 17 FE + 14 INT + 15 DEP = 73 task.** Ini matriks asesmen audit, bukan perubahan status resmi backlog.

Arti status: **Lokal** = kode/tes lokal tersedia; **Parsial** = cakupan/verification gate belum lengkap; **Gagal** = pemeriksaan audit membuktikan blocker; **Belum** = workflow atau bukti eksekusi belum ditemukan dalam scope review; **Disiapkan** = template/runbook tersedia tanpa eksekusi provider. Status Lokal tetap tidak mengklaim produksi terverifikasi.

## Backend

| Task   | Asesmen         | Bukti/batas utama                                                                                            | Tindak lanjut   |
| ------ | --------------- | ------------------------------------------------------------------------------------------------------------ | --------------- |
| BE-001 | Lokal           | Fastify/TS modular, lint/typecheck/build                                                                     | AUD-03/26       |
| BE-002 | Parsial         | Env tervalidasi; path root perubahan lokal; docs startup tertinggal                                          | AUD-04/16       |
| BE-003 | Lokal + parsial | Prisma validate dan 12 migrations fresh lulus; smoke downstream berhenti                                     | AUD-02/22       |
| BE-004 | Lokal           | State machine dan regression suite                                                                           | AUD-22          |
| BE-005 | Lokal + parsial | WIB/time service; configurable policy belum lengkap                                                          | AUD-06/16       |
| BE-006 | Lokal + parsial | Server owner/store scope; SQL employee salah; live IDOR belum lengkap                                        | AUD-01/22       |
| BE-007 | Parsial         | Append-only service/trigger/read UI; events correction/closing belum                                         | AUD-11/13/22    |
| BE-008 | Lokal + parsial | Auth/lockout/session/reset; smoke cookie parser gagal                                                        | AUD-02/22       |
| BE-009 | Lokal + parsial | Consent policy/version tersedia; purpose untuk transient server liveness evidence belum disetujui            | AUD-07/20/24    |
| BE-010 | Lokal + parsial | Employee/account/device CRUD, dua Admin; assisted flow belum                                                 | AUD-18/22       |
| BE-011 | Lokal           | Store/radius/assignment server; survey lokasi belum                                                          | AUD-22/24       |
| BE-012 | Lokal + parsial | Shift/assignment/holiday; concurrency live belum lengkap                                                     | AUD-22          |
| BE-013 | Parsial         | No-fix receipt/selfie tersimpan; belum ada review queue untuk raw attempt                                    | AUD-08/22       |
| BE-014 | Parsial         | Geofence/fix buruk dinilai server; no-fix selesai, alternatif belum lengkap                                  | AUD-17          |
| BE-015 | Lokal + parsial | Private original + watermark JPEG derivative, scoped reads, dual-object retention; DB/provider proof pending | AUD-08/09/20/21 |
| BE-016 | Parsial         | Check-in/out rules dan provisional pairing; auto-valid belum tersedia                                        | AUD-06/08/22    |
| BE-017 | Lokal + parsial | Review/scope/audit tersedia; live HTTP→DB coverage belum lengkap                                             | AUD-22          |
| BE-018 | Parsial         | D+1 candidate-review belum diimplementasikan; liveness trusted gate tetap tertutup (AUD-07/08)               | AUD-06/08/22    |
| BE-019 | Belum           | QR/Wi-Fi/Supervisor alternatif belum workflow penuh                                                          | AUD-17          |
| BE-020 | Parsial         | Evaluator/CLI/transaction guards; scheduler dan rekonsiliasi candidate setelah review belum                  | AUD-06/11/13/21 |
| BE-021 | Parsial         | Requests/lampiran/approval; policy overtime/scope/overlap/retention terbuka                                  | AUD-14/15/20/22 |
| BE-022 | Belum           | AUD-10 design dan AUD-11 readiness tersedia; correction service/routes menunggu policy owner                 | AUD-10/11/12    |
| BE-023 | Parsial         | Disruption create/list; idempotency/mass correction belum                                                    | AUD-19          |
| BE-024 | Gagal + parsial | Employee SQL `42P01`; admin/dashboard/notifikasi lokal tersedia                                              | AUD-01/12/15/22 |
| BE-025 | Parsial         | JSON/XLSX tersedia; correction diabaikan; live parity belum; timeout tes                                     | AUD-03/12/22    |
| BE-026 | Belum           | Recap model ada; closing design AUD-10 proposal-only, workflow/UI menunggu keputusan owner                   | AUD-10/13       |
| BE-027 | Parsial         | Readiness/logging/retention CLI; backup/restore/metrics deployment belum                                     | AUD-20/21/23    |

## Frontend

| Task   | Asesmen         | Bukti/batas utama                                                                                           | Tindak lanjut |
| ------ | --------------- | ----------------------------------------------------------------------------------------------------------- | ------------- |
| FE-001 | Lokal + parsial | Build PWA/manifest/icons/SW contract lulus; device install belum                                            | AUD-24        |
| FE-002 | Lokal           | UI/state/status components; 406 web tests lulus                                                             | AUD-22/24     |
| FE-003 | Lokal + parsial | Login/consent/password/lockout DOM; real-browser gate belum                                                 | AUD-02/22/24  |
| FE-004 | Parsial         | Role shell tersedia; employee data blocked SQL                                                              | AUD-01/22     |
| FE-005 | Lokal + parsial | Live camera/no gallery capture; backend renders private watermark derivative; provider/device proof pending | AUD-09/20/24  |
| FE-006 | Parsial         | State machine; detector null. AUD-07 design/AUD-08 readiness ada, verifier/device proof belum               | AUD-07/08     |
| FE-007 | Parsial         | GPS retry/cleanup dan online no-fix fallback; browser/device smoke tersisa                                  | AUD-24        |
| FE-008 | Parsial         | Online no-fix receipt tampil; raw-attempt review/liveness/assisted tersisa                                  | AUD-08/18/22  |
| FE-009 | Parsial         | AES-GCM IndexedDB/leases/receipt; foreground only; candidate-date review belum terintegrasi                 | AUD-06/22/24  |
| FE-010 | Belum           | Alternative validation UI belum lengkap                                                                     | AUD-17        |
| FE-011 | Parsial         | History/schedule tersedia tetapi SQL gagal; saldo cuti belum                                                | AUD-01/15     |
| FE-012 | Parsial         | Forms request aktif; correction UI menunggu API/policy, analisis parity AUD-12 masih independen             | AUD-11/12/14  |
| FE-013 | Parsial         | Verification/request review; correction/overtime policy belum lengkap                                       | AUD-12/14/22  |
| FE-014 | Parsial         | Employee/store/account/device/shift/holiday UI; settings lanjut belum                                       | AUD-16        |
| FE-015 | Lokal + parsial | Admin dashboard/model/polling; browser/DB parity belum                                                      | AUD-22/24     |
| FE-016 | Parsial         | Report filter/export tersedia; closing/override belum                                                       | AUD-12/13/22  |
| FE-017 | Parsial         | Audit/notifikasi/disruption UI; uncertain outcome dan mass correction belum                                 | AUD-19/22     |

## Integrasi dan QA

| Task    | Asesmen            | Bukti/batas utama                                                       | Tindak lanjut   |
| ------- | ------------------ | ----------------------------------------------------------------------- | --------------- |
| INT-001 | Lokal              | OpenAPI 53 path/70 operasi aktif; fitur future belum kontrak            | AUD-05/11/13/17 |
| INT-002 | Lokal              | Strict API client/error mapping/no-store; browser network belum penuh   | AUD-22          |
| INT-003 | Parsial            | Adapter/service/route mock; provider private storage belum              | AUD-20          |
| INT-004 | Parsial            | API 514 tes ulang lulus; default XLSX timeout; future workflow belum    | AUD-03/11/13    |
| INT-005 | Gagal + parsial    | Migrations fresh lulus; smoke cookie gagal; employee SQL terbukti gagal | AUD-01/02/22    |
| INT-006 | Parsial            | 77 file/406 tes web, virtual DOM/IndexedDB fake                         | AUD-22/24       |
| INT-007 | Belum lengkap      | Tidak ditemukan automated browser E2E full critical path                | AUD-22          |
| INT-008 | Belum diverifikasi | Chrome Android/Safari iOS/camera/GPS/PWA nyata belum audit              | AUD-24          |
| INT-009 | Parsial            | Negative role/owner/scope mocks; real DB IDOR gate belum lengkap        | AUD-01/22       |
| INT-010 | Parsial            | CSRF/CORS/headers/XSS/redaction local; full live sign-off belum         | AUD-20/22/23/25 |
| INT-011 | Parsial            | Consent/private DTO/retention local; provider/device privacy belum      | AUD-07/14/20/24 |
| INT-012 | Parsial            | Initial asset budget lulus; 4G/device/load DB belum                     | AUD-24          |
| INT-013 | Parsial            | Report source aktif; correction/closing/live reconciliation belum       | AUD-12/13/22    |
| INT-014 | Parsial            | Offline/recovery tests local; failure provider/restore belum            | AUD-21/22/23    |

## Deployment dan operasional

| Task    | Asesmen            | Bukti/batas utama                                                            | Tindak lanjut   |
| ------- | ------------------ | ---------------------------------------------------------------------------- | --------------- |
| DEP-001 | Parsial            | README/compose/seed tersedia; DB migrations audit berhasil; smoke auth gagal | AUD-02/04       |
| DEP-002 | Disiapkan          | DigitalOcean App Spec/runbook local; provisioning tidak diverifikasi         | AUD-20/23       |
| DEP-003 | Belum diverifikasi | Production infra/TLS/secrets/isolation belum audit                           | AUD-23/24       |
| DEP-004 | Parsial            | CI yaml ada; smoke script gagal; high audit tidak gate moderate              | AUD-02/03/25    |
| DEP-005 | Belum diverifikasi | Backlog menyebut NOT STARTED; audit tidak deploy staging                     | AUD-20/23       |
| DEP-006 | Belum lengkap      | Gate production belum terpenuhi                                              | AUD-22/23/24/26 |
| DEP-007 | Parsial            | Runbook migration/rollback; fresh CI migrations lulus; staging restore belum | AUD-23          |
| DEP-008 | Belum diverifikasi | Metrics/alert deployment belum dibuktikan                                    | AUD-21/23       |
| DEP-009 | Belum diverifikasi | Backup encrypted offsite/retention belum dibuktikan                          | AUD-23          |
| DEP-010 | Belum diverifikasi | Restore drill RPO/RTO belum audit                                            | AUD-23          |
| DEP-011 | Parsial            | Retention CLI/runner ada; dry-run/scheduler/provider delete belum            | AUD-21          |
| DEP-012 | Belum diverifikasi | Pilot toko/perangkat/jaringan belum dibuktikan                               | AUD-24          |
| DEP-013 | Belum diverifikasi | Production import/store survey/scope/dua Admin belum dibuktikan              | AUD-24          |
| DEP-014 | Parsial            | Setup/migration/staging runbook; training semua operasi belum lengkap        | AUD-24/26       |
| DEP-015 | Belum lengkap      | Go-live checklist ada sebagai requirement; bukti gate belum lengkap          | AUD-24/26       |

Task Lokal tidak perlu dibangun ulang. Fokus pada bug, integrasi yang belum terbukti, dan workflow yang belum tersedia sesuai [breakdown](./BREAKDOWN-TASK.md).
