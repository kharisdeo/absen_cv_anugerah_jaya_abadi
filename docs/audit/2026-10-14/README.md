# Paket audit proyek — 14 Oktober 2026

Audit terhadap working tree `3938cfcb2f23be68fd3d5251ba2bf4140cd3393e`, termasuk perubahan lokal pada `apps/api/src/config/env.ts`.

- [Laporan audit dan bukti temuan](./LAPORAN-AUDIT.md)
- [Matriks seluruh 73 task backlog asal](./MATRIKS-BACKLOG.md)
- [Breakdown task tindak lanjut](./BREAKDOWN-TASK.md)
- [Prompt siap pakai untuk GPT-6 Luna](./PROMPT-LUNA-6.0.md)

Urutan awal: **AUD-01 → AUD-02 → AUD-03 → AUD-04 → AUD-05**. Task yang menunggu keputusan bisnis harus menyelesaikan artefak keputusan terlebih dahulu; kode lain yang tidak bergantung pada keputusan tersebut tetap dapat dikerjakan.

Kesimpulan: implementasi sudah luas, tetapi **belum memenuhi gate produksi**. Query dashboard karyawan gagal pada PostgreSQL; smoke test PostgreSQL juga gagal karena parser cookie pada tes. API 514 tes lulus pada pengulangan dengan dua worker, web 406 tes lulus, dan build lulus. Hasil ini tidak menghapus kegagalan `pnpm check` awal dan tidak membuktikan alur browser/perangkat/provider nyata.

Audit ini tidak memperbaiki kode bisnis, mengubah backlog asal, menerapkan migrasi ke database proyek, melakukan deploy, atau mengirim perubahan ke remote. Database CI sementara tanpa volume digunakan untuk bukti reproduksi lalu dihapus melalui penghentian container `--rm`.

File bukti `.txt` dan JSON berada pada direktori ini. Script reproduksi hanya memakai database CI yang diizinkan guard; jangan mengubahnya untuk database produksi. Target model prompt adalah `gpt-6-luna`; prompt disusun pada audit ini untuk dijalankan oleh Luna, bukan hasil eksekusi Luna.

## Status pelaksanaan prompt

- AUD-01 selesai lokal; perbaikan dashboard tervalidasi dengan regression PostgreSQL disposable.
- AUD-02 parsial: parser cookie smoke diperbaiki dan diuji, tetapi smoke autentikasi penuh
  masih menerima HTTP 500 dari login employee sintetis.
- AUD-03 selesai lokal: API 517/517 dan web 406/406 lulus setelah worker Vitest dibatasi.
- AUD-04 selesai lokal untuk loader env dan dokumentasi; API global typecheck/build masih
  gagal karena 19 error type yang telah ada di modul lain.
- Acceptance inti AUD-05 selesai lokal: no-fix receipt/selfie, replay/owner scope, dan
  pencegahan false `ABSENT` lulus pada PostgreSQL disposable. Raw no-fix attempt belum masuk
  antrean review Attendance; provider storage dan browser/perangkat nyata juga belum diuji.
  Verifikasi penuh setelah perubahan: API 525/525, web 411/411,
  lint/format/diff-check lulus, dan semua 13 migrasi diterapkan pada PostgreSQL 17 disposable.
- AUD-06: keputusan produk D→D+1 dicatat—tanggal capture hanya `candidateWorkDate` yang wajib
  direview, sedangkan `receivedAt`/`serverTime` tetap bukti waktu resmi dan tidak boleh otomatis
  menghasilkan `VALID`. Analisis serta PRD/decision record diperbarui; lima file tes API terkait
  lulus 75/75. Implementasi candidate/review dan regression PostgreSQL AUD-06 belum selesai.
  Kasus candidate tanpa shift cocok/tanggal tidak masuk akal masih memerlukan keputusan; ini tidak
  menghentikan artefak lokal independen.
- AUD-07 selesai sebagai desain lokal di [AUD-07-DESIGN.md](./AUD-07-DESIGN.md): kontrak server
  verifier/challenge, nonce/binding/expiry/replay, privacy/consent, failure fallback, offline caveat,
  performance dan test acceptance terdokumentasi. Tiga file test liveness/camera web lulus 23/23.
  Tidak ada kode produksi berubah; detector/model/server verifier, PostgreSQL race, consent baru,
  private provider, serta browser/perangkat nyata belum dibuktikan. `VALID` tetap tertutup oleh
  trusted-liveness gate.
- AUD-08: readiness/urutan implementasi dicatat di
  [AUD-08-IMPLEMENTATION-READINESS.md](./AUD-08-IMPLEMENTATION-READINESS.md). Implementasi
  production belum dimulai karena proposal AUD-07 dan keputusan provider/model, threat threshold,
  consent, TTL/retention, serta performance belum disetujui. Tidak ada kode/schema/provider yang
  berubah; artefak lokal tetap diselesaikan sesuai aturan bahwa BLOCKED implementasi tidak
  menghentikan analisis atau dokumen independen.
- AUD-09 selesai lokal: source selfie immutable dan JPEG turunan privat memuat nama karyawan,
  receipt server WIB, koordinat atau label lokasi unavailable; URL review hanya menunjuk turunan
  setelah write + commit, sedangkan retention menghapus kedua object dan worker dapat backfill
  selfie legacy. API 536/536 lulus, termasuk artifact-pixel, render failure, review scoping dan
  retensi. Prisma validate lulus. Migrasi belum dieksekusi pada PostgreSQL disposable karena
  Docker image pull tidak tuntas pada sesi ini; provider storage dan deployment tidak diuji.
- AUD-10 selesai sebagai proposal desain di [AUD-10-DESIGN.md](./AUD-10-DESIGN.md).
  Dokumen memetakan koreksi tanpa original, deadline H+3/SLA, approver/scope, close tanggal 3,
  pending, override, revision/reopen, acceptance, dan skenario race. Konflik kebijakan PRD vs
  TODO dinyatakan eksplisit; belum ada pilihan owner yang diubah menjadi keputusan final.
  Implementasi AUD-11/AUD-13 tetap menunggu policy tersebut, tetapi analisis/readiness lokal
  independen tetap dapat diselesaikan.
- AUD-11 implementasi masih gated; readiness lokal selesai di
  [AUD-11-IMPLEMENTATION-READINESS.md](./AUD-11-IMPLEMENTATION-READINESS.md). Dokumen memetakan
  decision-to-code, service/route/schema yang akan berubah, lock/transaksi/audit, security dan
  PostgreSQL race tests tanpa memilih policy atau menyentuh kode. Ini tidak menghalangi analisis
  parity frontend/report AUD-12 yang dapat dilakukan tanpa backend correction aktif.
- AUD-12 readiness lokal selesai di
  [AUD-12-IMPLEMENTATION-READINESS.md](./AUD-12-IMPLEMENTATION-READINESS.md). Ia memetakan UI,
  kontrak correction yang dibutuhkan dan ketidaksamaan jalur `ignoreCorrections` dashboard vs
  monthly report; tidak mengubah kode atau memilih DTO/policy. Implementasi menunggu AUD-10/11,
  sedangkan analisis closing AUD-13 tetap dapat diselesaikan terpisah.
- AUD-13 readiness lokal selesai di
  [AUD-13-IMPLEMENTATION-READINESS.md](./AUD-13-IMPLEMENTATION-READINESS.md). Artefak
  memetakan skema recap yang sudah ada, guard `CLOSED` yang masih parsial, keputusan owner AUD-10,
  rancangan revision/idempotency/lock, dan acceptance/race matrix PostgreSQL. Implementasi
  monthly closing belum dimulai; tidak ada keputusan policy yang ditebak atau database/provider
  yang disentuh.
- AUD-14 readiness lokal selesai di
  [AUD-14-IMPLEMENTATION-READINESS.md](./AUD-14-IMPLEMENTATION-READINESS.md). Artefak
  mencatat konflik approval lembur, overlap, request scope dan histori assignment, strategi
  snapshot/backfill, kontrol IDOR, serta retention surat dokter yang dipisahkan dari selfie.
  Implementasi tetap menunggu keputusan owner; verifikasi PostgreSQL/provider belum dilakukan.
- AUD-15 readiness lokal selesai di
  [AUD-15-IMPLEMENTATION-READINESS.md](./AUD-15-IMPLEMENTATION-READINESS.md). Kuota, accrual,
  carry-over, prorata, reservation/debit dan laporan tetap tidak dipilih; dokumen memetakan
  opsi ledger, invariant, authorization, backfill, dan test matrix. Verifikasi independen
  lokal: API 62/62 dan web 49/49 tes lulus; PostgreSQL concurrency, migration/backfill,
  browser/perangkat dan policy bisnis belum diverifikasi.
- AUD-16 readiness lokal selesai di
  [AUD-16-IMPLEMENTATION-READINESS.md](./AUD-16-IMPLEMENTATION-READINESS.md). Artefak memisahkan
  CRUD toko/shift yang sudah ada dari policy global yang belum diputuskan, serta menegaskan
  rahasia dan konfigurasi deployment tetap ops-only. Verifikasi independen: API store/schedule/
  audit 54/54 tes lulus; PostgreSQL race, versioned effective settings, provider dan browser
  belum diverifikasi.
- AUD-17 readiness/design lokal selesai di
  [AUD-17-IMPLEMENTATION-READINESS.md](./AUD-17-IMPLEMENTATION-READINESS.md). Enum QR/Wi-Fi/
  Supervisor tidak dianggap proof; dokumen merinci threat model, trusted proxy, replay, scope,
  retention dan staged test. Verifikasi independen: API geospatial/attempt/store/verification
  92/92 lulus; QR/Wi-Fi/Supervisor integration, PostgreSQL, provider, proxy dan device nyata
  tetap belum diuji.
- AUD-18 readiness lokal selesai di
  [AUD-18-IMPLEMENTATION-READINESS.md](./AUD-18-IMPLEMENTATION-READINESS.md). Desain assisted
  mempertahankan identitas employee, binding reguler dan status pending; helper harus memakai
  identity/scope sendiri. Verifikasi baseline API auth/device-binding/attempt/selfie/review:
  118/118 tes lulus; alur assisted nyata belum dibuat atau diuji.
- Checkpoint 2026-10-15 — AUD-19 **PARTIAL**: durable idempotency POST disruption sudah
  diimplementasikan secara lokal (API 21/21, web 11/11, Prisma validate, format/diff check).
  Batch correction preview/apply tetap gated oleh policy owner AUD-10–13; migrasi belum
  diterapkan ke database, dan browser reload/provider/PostgreSQL race belum dibuktikan.
  Rincian serta acceptance matrix ada di
  [AUD-19-IMPLEMENTATION-READINESS.md](./AUD-19-IMPLEMENTATION-READINESS.md).
- Checkpoint 2026-10-15 — AUD-20 **PARTIAL**: runbook dan matriks provider Spaces disiapkan di
  [AUD-20-IMPLEMENTATION-READINESS.md](./AUD-20-IMPLEMENTATION-READINESS.md). Validasi adapter
  lokal/mock 9 file / 85 tes lulus; akun, bucket, key, staging, CORS/TLS/enkripsi, signed URL
  dan deletion/version behavior provider belum diuji. Tidak ada provisioning atau deployment.
- Checkpoint 2026-10-15 — AUD-21 **PARTIAL**: CLI `retention:dry-run` hanya melakukan query
  kandidat baca-saja terbatas 500 per kategori dan tidak membuat S3 client atau menjalankan
  watermark/purge. API 4 suite / 45 tes lulus. Dry-run DB belum dijalankan; scheduler harian,
  metrik/alert live, dan bukti PostgreSQL/provider masih belum ada. Lihat
  [AUD-21-IMPLEMENTATION-READINESS.md](./AUD-21-IMPLEMENTATION-READINESS.md).
- Checkpoint 2026-10-15 — AUD-22 **PARTIAL**: peta E2E dan matriks rekonsiliasi tersedia di
  [AUD-22-IMPLEMENTATION-READINESS.md](./AUD-22-IMPLEMENTATION-READINESS.md). Route/service/web
  local: API 12 file / 84 tes dan web 12 file / 69 tes lulus; Docker Engine ditolak oleh OS,
  PostgreSQL/browser/provider nyata belum diuji. Koreksi/closing belum memiliki route, dan
  kandidat tanggal capture offline belum dapat ditinjau/finalisasi.
- Checkpoint 2026-10-15 — AUD-23 **PARTIAL**: readiness deployment dan matriks backup/restore
  ada di [AUD-23-IMPLEMENTATION-READINESS.md](./AUD-23-IMPLEMENTATION-READINESS.md). App Spec
  serta runbook tetap template lokal; tidak ada deployment/backup/restore staging atau production.
  Daily encrypted offsite retention, isolated restore, RPO <=24 jam, RTO <=4 jam, TLS, alert,
  dan konsistensi object reference belum dibuktikan.
- Checkpoint 2026-10-15 — AUD-24 **PARTIAL**: device/performance/pilot matrix tersedia di
  [AUD-24-IMPLEMENTATION-READINESS.md](./AUD-24-IMPLEMENTATION-READINESS.md). Belum ada Chrome
  Android/Safari iOS fisik, staging, uji 200 karyawan/20 toko, pengukuran 4G, geofence lokasi,
  atau pilot owner/handover yang diverifikasi; test DOM/IndexedDB tetap simulasi.
- Checkpoint 2026-10-15 — AUD-25 **PARTIAL**: reachability `uuid@8.3.2` ditelusuri pada source
  ExcelJS dan round-trip XLSX lulus 1/1. Fresh `pnpm audit` belum berjalan karena Corepack tidak
  dapat menjangkau registry; major override tidak dibuat. Risiko belum diterima owner dan perlu
  keputusan sebelum staging. Rincian ada di
  [AUD-25-IMPLEMENTATION-READINESS.md](./AUD-25-IMPLEMENTATION-READINESS.md).
- Checkpoint 2026-10-15 — AUD-26 **NOT GO-LIVE READY**: status tiap boundary (local,
  PostgreSQL, browser/device, provider/staging, production), owner blockers, rollback/incident
  gap, serta keputusan scope 2FA yang belum dibuat dirangkum dalam
  [AUD-26-RELEASE-STATUS.md](./AUD-26-RELEASE-STATUS.md). Ini snapshot lokal; tidak ada
  deployment atau external provisioning.

Di template ini, `BLOCKED` mencatat status implementasi task itu sendiri; status tersebut
tidak menghentikan analisis, keputusan, dokumen, test fixture, atau artefak lokal lain yang
tidak membutuhkan prasyarat tersebut. Gate eksternal yang belum tersedia tetap ditandai
terpisah sebagai parsial dan tidak diklaim selesai.
