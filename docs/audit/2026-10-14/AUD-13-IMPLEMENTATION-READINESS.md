# AUD-13 — Readiness implementasi monthly closing

Tanggal review: 15 Oktober 2026. Status artefak: **analisis/readiness lokal selesai**.
Status implementasi: **gated**, bukan selesai. Dokumen ini tidak menetapkan policy owner
dan tidak mengubah source, schema, database, storage provider, atau deployment.

## Ringkasan keputusan teknis

Monthly closing belum merupakan workflow aplikasi. Model `MonthlyRecap` sudah mempunyai
`OPEN`/`CLOSED`, angka agregat, `snapshot`, `closedByUserAccountId`, dan `closedAt`, tetapi
belum ada service/route untuk preview, close, reopen, maupun revision. Guard `CLOSED` yang
ada di sebagian jalur attendance/daily-status hanya pemeriksaan baca di jalur tertentu;
ia belum menjadi protokol lock bersama bagi semua penulis. Karena AUD-10 masih proposal,
implementasi yang memilih scope/cutoff/pending/override sendiri berisiko mengunci atau
mengubah periode secara salah.

Urutan yang aman:

1. Owner menyetujui keputusan AUD-10 untuk scope periode, tanggal 3/cutoff WIB, pending,
   close normal/terlambat, override, reopen, dan persetujuan kedua.
2. Selesaikan BE-022/FE-012 sesuai AUD-11/12 dan tetapkan satu resolver nilai efektif yang
   sama bagi dashboard, laporan JSON/XLSX, preview, serta snapshot closing.
3. Tetapkan kontrak recap/revision/idempotency dan lock protocol. Baru setelah itu buat
   migration, service/repository, routes, UI, dan PostgreSQL regression.

## Fakta dari checkout

- `apps/api/prisma/schema.prisma`, model `MonthlyRecap`: unik `(employeeId, periodStart,
storeId)`, periode berupa `@db.Date`, dan scope toko nullable. `snapshot` adalah JSON
  tunggal; tidak ada nomor revision atau tabel manifest immutable. Constraint unik dengan
  kolom nullable perlu diuji khusus pada PostgreSQL; jangan menyimpulkan `storeId = null`
  sudah menutup duplikasi hanya dari Prisma schema.
- `RecapStatus` hanya `OPEN` dan `CLOSED`. Metadata close yang tersedia satu actor dan satu
  timestamp, tanpa reason, idempotency identity, hash/source revision snapshot, atau
  metadata reopen.
- `apps/api/src/routes/reports.ts` mempunyai GET `/reports/monthly` dan
  `/reports/monthly/export`, bukan preview/close/reopen routes. `MonthlyReportService` dan
  repository membuat laporan saat dibaca; belum ada service closing yang menyimpan snapshot.
- Pemeriksaan `CLOSED` ditemukan pada beberapa jalur attendance/daily status (antara lain
  `attendance/prisma-repository.ts` dan `daily-attendance/prisma-repository.ts`). Sebagian
  menolak perubahan derived status, sebagian mencegah update status tertentu. Ini bukti
  guard parsial, bukan bukti semua writer telah terlindungi atau terserialisasi dengan close.
- Audit transaksi saat ini memakai `transaction.auditLog.create` pada beberapa mutasi.
  Pola itu bisa menjadi acuan atomic audit; jangan menggantinya dengan side effect di luar
  transaksi untuk close/reopen.
- `docs/audit/2026-10-14/AUD-10-DESIGN.md` menandai kebijakan sebagai proposal dan
  menyebut konflik PRD/TODO. Tanggal 3 serta H+3 tidak cukup untuk menyimpulkan cutoff jam,
  scope close, blocker pending, atau kuasa override.

## Keputusan owner yang menjadi gate

Setiap butir perlu jawaban eksplisit di decision record sebelum implementasi domain:

| Area                     | Pertanyaan yang belum diputuskan                                                                                                                     | Dampak jika ditebak                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Scope close              | Global perusahaan, per toko, atau slice employee/store? Bagaimana pegawai multi-store, store null, toko nonaktif, dan employee tanpa shift?          | Recap dapat terlewat, terduplikasi, atau terbuka lintas scope.   |
| Kalender                 | “Tanggal 3” berarti sampai pukul berapa WIB; boleh tutup sebelum tanggal itu; bagaimana close terlambat?                                             | Close dapat terjadi pada cutoff yang salah.                      |
| Preview                  | Entitas apa yang masuk, apakah hasil preview boleh stale, dan apakah preview menghasilkan durable token/hash?                                        | Admin dapat mengonfirmasi data yang berbeda dari snapshot final. |
| Pending/exception        | Status mana yang memblokir: verification, offline, candidate work date, request, correction, disruption? Adakah force-close dengan daftar exception? | Close normal bisa menyembunyikan data belum diputus.             |
| Correction setelah close | Apakah correction ditolak, masuk antrean reopen, atau memerlukan override? Batas waktunya?                                                           | Nilai open report dapat berbeda dari laporan resmi.              |
| Reopen/restatement       | Apakah reopen diizinkan, alasan wajib, second-person approval, revision baru, dan siapa dapat melakukannya?                                          | Histori resmi dapat tertimpa tanpa jejak.                        |
| Report semantics         | Reader memakai snapshot CLOSED atau menghitung live? Bagaimana koreksi/late event ditandai?                                                          | JSON/XLSX/dashboard/rekap bisa tidak konsisten.                  |
| Batas transaksi          | Satu transaksi periode penuh atau manifest/batch? Berapa batas pegawai/row dan recovery parsial?                                                     | Partial close dapat ditampilkan sebagai sukses penuh.            |
| Retensi/audit            | Berapa lama snapshot dan revisions disimpan; field mana yang boleh berada di audit?                                                                  | Bukti payroll/privasi dapat rusak atau bocor.                    |

Tidak ada default yang dipilih dalam dokumen ini. Keputusan tersebut milik product/business
owner, bukan implementer.

## Rancangan implementasi setelah gate kebijakan

### Model dan migrasi

Tinjau model scope terlebih dahulu. Jika perusahaan memutuskan closing dapat direvisi,
jangan overwrite `MonthlyRecap.snapshot`: tambahkan entitas revision/manifest append-only
dengan period/scope, sequence, actor, timestamp, reason, source version/hash, snapshot,
counts, dan predecessor revision. Simpan state current/closed yang dapat direkonsiliasi,
serta durable idempotency key + canonical request fingerprint untuk close dan reopen.
Pilihan skema final bergantung pada scope yang disetujui. Pastikan unique constraint untuk
scope null/global dibuat benar-benar unik di PostgreSQL, misalnya lewat partial unique
indexes atau strategi scope key yang diputuskan; validasi migration fresh dan upgrade.

Jangan menyimpan signed URL, token, koordinat yang tidak diperlukan, object key sensitif,
selfie, atau lampiran mentah pada snapshot/audit. Snapshot hanya memakai field laporan
yang memang disetujui dan memiliki batas retensi.

### Service, akses, dan route

Tambahkan service/repository khusus yang memisahkan:

1. `preview`: role dan scope Admin; hitung blockers/exceptions serta ringkasan dari shared
   effective-source resolver; respons `no-store`; belum melakukan close.
2. `close`: idempotency identity durable; role Admin dan second approver hanya jika policy
   mewajibkan; validasi policy version, scope, cutoff, blockers, dan preview fingerprint;
   re-read setelah memperoleh lock; simpan revision/status dan audit pada transaksi yang
   sama.
3. `reopen`/`override`: hanya bila diizinkan policy, reason wajib, actor kedua/approval
   sesuai policy, dan selalu membuat revision baru; tidak menghapus/menulis ulang versi lama.
4. `read`: satu aturan untuk memilih snapshot resmi saat closed dan live result saat open.
   JSON dan XLSX harus berbagi data/provenance yang sama dan menampilkan status/scope,
   revision, closed-at/by, serta exception sesuai policy.

Gunakan role dari session server, bukan nilai role dari body/UI. Scope Admin/non-Admin harus
diterapkan di server; Supervisor/employee yang read-only tetap mengikuti store/owner scope
existing dan tidak boleh melihat recap global hanya lewat mengganti query. Gunakan skema
request strict, error code aman, `no-store`, rate-limit untuk mutasi sensitif, serta
idempotency conflict saat key sama dipakai pada fingerprint berbeda.

### Transaksi dan serialisasi

Sebelum kode, dokumentasikan satu urutan lock global. Lock per periode/scope harus bersaing
dengan _setiap_ mutasi yang bisa mengubah hasil snapshot: online attendance, offline sync,
verifikasi/review, koreksi dan keputusan request, absensi harian/reconciliation job,
disruption effect, assignment/schedule yang mengubah sumber hari kerja, serta close/reopen.
Pemeriksaan `CLOSED` dilakukan ulang setelah lock diperoleh di dalam transaksi yang sama;
preview lama bukan lock. Semua employee/scope ID dikunci dalam urutan stabil. Hindari
deadlock dari jalur yang lebih dahulu mengunci employee lalu period sementara close
mengunci period lalu employee; pilih dan uji satu urutan untuk seluruh writer.

Jika satu periode/scope tidak aman diproses sebagai transaksi atomik, desain manifest
`PENDING → CLOSING → CLOSED/FAILED` dan progress durable lebih dahulu. Jangan mengembalikan
`sukses penuh` sebelum seluruh slice ditutup; recovery harus idempotent dan dapat membedakan
gagal parsial dari closed.

## Peta file yang kemungkinan disentuh

Ini daftar investigasi/implementasi, bukan klaim file sudah diubah:

- `apps/api/prisma/schema.prisma` + migration baru: revision/manifest, idempotency,
  scope-key/unique indexes, metadata close/reopen berdasarkan keputusan.
- `apps/api/src/modules/report/index.ts` dan `prisma-repository.ts`: extract shared
  effective source + preview/snapshot/read semantics; JSON/XLSX tetap parity.
- Modul baru `apps/api/src/modules/monthly-closing/` (service, contracts, Prisma repository)
  atau lokasi modular yang konsisten dengan pola repo.
- `apps/api/src/routes/` + `apps/api/src/app.ts` + `docs/openapi.yaml` + `docs/API.md`:
  preview/close/read/reopen sesuai policy; strict validation dan role/scope server-side.
- Semua write path di `attendance`, `attendance-verification`, `attendance-requests`,
  `daily-attendance`, schedule/assignment, disruption, dan background jobs: gunakan shared
  close guard/lock protocol, bukan hanya menambah `EXISTS CLOSED` secara terpisah.
- Frontend admin reporting/closing: preview, explicit confirmation, pending blockers,
  closed badge/provenance, reason/approval saat policy meminta; jangan memberi kesan
  period protected sebelum server mengonfirmasi.
- `apps/api/test/postgres-smoke.ts` atau test harness disposable baru: race/transaction
  regression pada PostgreSQL nyata.

## Acceptance dan test plan wajib

### Unit/route tests lokal

- Admin boleh preview/close hanya dalam scope/period yang diizinkan; employee dan Supervisor
  tidak dapat mengubah recap; query/body tambahan ditolak.
- Cutoff WIB, closed date, blocker list, pending/exception policy, stale preview, key retry
  identik, dan key reuse dengan body/scope lain.
- Audit memuat actor, request ID, periode/scope, reason, revision relation, before/after
  tersanitasi; tidak ada secret/bukti foto/lokasi mentah.
- JSON/XLSX dan preview menggunakan resolver, revision, total, timezone, dan provenance
  yang sama.
- Snapshot revision lama tidak berubah saat reopen/reclose; audit/status failure rollback
  bersamaan dengan close, tanpa `CLOSED` parsial.

### PostgreSQL concurrency tests (tidak dapat digantikan mock)

1. Dua close bersamaan dengan key sama menghasilkan satu hasil/revision; key sama dengan
   fingerprint beda memperoleh conflict; audit hanya satu.
2. Close bersamaan dengan sync online/offline, approval correction/request, verification,
   absence job/reconciliation, disruption, dan schedule change: tepat satu urutan commit
   yang sah, tidak ada late write melewati close, dan snapshot mencerminkan semua write
   committed sebelum titik close.
3. Retry setelah client kehilangan response mengembalikan hasil revision yang sama.
4. Forced rollback saat snapshot/revision/audit gagal tidak meninggalkan state closed atau
   event audit orphan; rollback pada setiap batch tidak membuat periode terlapor sukses.
5. Concurrent global/null-store keys tidak menghasilkan duplicate close; batas cakupan
   store vs global tidak menutup atau membocorkan slice lain.
6. Setelah CLOSED, seluruh writer mendapat perilaku yang telah diputuskan; override/reopen
   hanya aktor yang sah dan mempertahankan riwayat revision.
7. Uji deadlock/lock order dengan dua pegawai dan dua writer, serta assertion ulang semua
   data scope; jalankan berulang pada PostgreSQL disposable.

### Browser/API end-to-end

Fixture minimum harus meliputi employee A/B, Supervisor lintas toko, multi-store, multi-shift,
candidate offline tanggal capture (wajib review), pending/rejected/approved, correction,
disruption, dua Admin, dan unknown network outcome. Verifikasi preview → confirm → read
JSON/XLSX → audit/UI badge serta percobaan IDOR dan mutation pasca-close. Fixture tersebut
baru dapat di-finalisasi setelah keputusan AUD-10 dan correction AUD-11/12 tersedia.

## Kriteria keluar dari gate

AUD-13 baru dapat diimplementasikan saat policy AUD-10 disetujui, correction service/report
resolver AUD-11/12 terintegrasi, owner menerima skema histori/reopen dan lock order, serta
database PostgreSQL disposable tersedia. Sesudah itu seluruh migration, route/UI, dan race
matrix di atas harus lulus. Mock/unit saja tidak cukup untuk menyatakan closing atomic.

Pada audit lokal ini tidak ada PostgreSQL/migration run untuk AUD-13, tidak ada race test,
dan tidak ada provider/deployment test. Hasil ini adalah **readiness**, bukan klaim fitur
closing sudah berfungsi atau periode sudah terlindungi.
