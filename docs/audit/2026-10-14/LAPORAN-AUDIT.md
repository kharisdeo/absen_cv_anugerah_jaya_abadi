# Laporan audit Absensi CV Anugerah Jaya Abadi

Tanggal: **14 Oktober 2026, Asia/Jakarta**. Baseline commit: `3938cfcb2f23be68fd3d5251ba2bf4140cd3393e`. Working tree memiliki perubahan pengguna pada `apps/api/src/config/env.ts`: path `.env` naik empat direktori, sesuai lokasi root dari `src/config` dan `dist/config`. Perubahan tersebut dipertahankan.

## Kesimpulan

Proyek sudah memiliki implementasi modular yang substansial: autentikasi, consent, device binding, master data, jadwal, attendance attempt, storage privat, verifikasi, antrean offline terenkripsi, pengajuan, dashboard, notifikasi, laporan JSON/XLSX, audit, serta CLI job. Menyebutnya hanya fondasi/PWA shell pada README tidak lagi mencerminkan kode.

**Belum layak dinyatakan siap produksi.** Ada satu bug SQL yang direproduksi langsung, satu bug pada smoke-test cookie, kegagalan tes pada konfigurasi default, serta gap workflow dan operasional. Tidak ditemukan advisory high/critical oleh pemeriksaan dependency ini; hal itu bukan sertifikasi keamanan aplikasi.

Tidak diberikan persentase selesai: 73 task backlog memiliki cakupan dan ukuran berbeda, dan banyak status PARTIAL memuat kode selesai tetapi verifikasi perangkat/provider belum selesai.

## Lingkup dan metode

- Membandingkan PRD 2.0, TODO, DECISIONS, API/OpenAPI, schema/migration, implementasi API/web, tests, CI, dan App Spec staging.
- Memeriksa source flow, authorization, evidence, waktu offline, report, dan deployment. Review bersifat terarah, bukan pemeriksaan manual setiap baris kode atau penetration test.
- Menjalankan pemeriksaan lokal dan advisory registry. Node `v24.21.0`, pnpm `11.25.0`.
- Memakai PostgreSQL `17.11-alpine3.24` pada container sementara `codex-absen-audit-20261014`, user/database `absen_ci`, port loopback 5432, tanpa volume proyek. Tidak membaca isi `.env` atau mencetak kredensial nyata.
- Tidak menjalankan uji visual browser, kamera/GPS perangkat nyata, staging/cloud storage, load test 200 karyawan/20 toko, atau restore drill.
- Informasi lama dalam TODO tentang Docker tidak tersedia tidak berlaku pada audit ini: daemon dan image lokal tersedia setelah akses di luar sandbox diizinkan. Database proyek yang ada tidak dimigrasi oleh audit.

## Hasil verifikasi aktual

| Pemeriksaan                                  | Hasil audit                                                                                 | Bukti                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------- |
| `pnpm check`                                 | **Gagal**, exit 1 pada tes API; build belum dijalankan oleh rangkaian ini                   | `quality-check.txt`          |
| Prettier, lint, typecheck                    | Lulus pada rangkaian awal                                                                   | `quality-check.txt`          |
| Tes web                                      | **77 file / 406 tes lulus**                                                                 | `quality-check.txt`          |
| Tes API default                              | **57 file lulus / 1 gagal; 513 tes lulus / 1 gagal**; XLSX timeout 5.000 ms                 | `quality-check.txt`          |
| Tes API ulang `--maxWorkers 2`               | **58 file / 514 tes lulus**                                                                 | `api-tests-bounded.txt`      |
| `pnpm build` terpisah                        | Lulus API/web, kontrak build PWA dan budget initial assets                                  | `build.txt`                  |
| Initial assets web                           | 328.330 / 665.600 byte raw; 100.418 / 184.320 byte gzip                                     | `build.txt`                  |
| Prisma validate                              | Lulus                                                                                       | `schema-validation.txt`      |
| Migration deploy DB CI sementara             | Seluruh 12 direktori migration berhasil diterapkan                                          | `postgres-migrations.txt`    |
| PostgreSQL smoke bawaan                      | **Gagal**, `Session cookie must be signed`; run berhenti, cakupan downstream tidak terbukti | `postgres-smoke.txt`         |
| Reproduksi dashboard memakai repository asli | **Gagal**, PostgreSQL `42P01`, alias `e` tidak ada                                          | `dashboard-reproduction.txt` |
| Probe signed cookie library                  | Prefix `s:` false; signature valid true; tokenMatches true                                  | `cookie-reproduction.txt`    |
| `pnpm audit --json`                          | Exit 1: **1 moderate, 0 high, 0 critical**                                                  | `dependency-audit.json`      |

Tes ulang yang lulus mengindikasikan kontensi worker sebagai kemungkinan penyebab timeout; satu pengulangan tidak cukup untuk menyatakan penyebab pasti. Tidak ada konfigurasi worker/timeout produk yang diubah.

## Temuan

Prioritas di bawah adalah prioritas tindak lanjut audit: **P0** menghalangi alur inti/gate pilot; **P1** perlu untuk operasi yang lengkap; **P2** pemeliharaan/penguatan. Gap requirement bukan otomatis kerentanan yang dapat dieksploitasi.

### F-01 — P0 — Query dashboard karyawan memakai alias SQL yang tidak terdaftar

**Jenis: bug runtime terkonfirmasi.** `apps/api/src/modules/dashboard/prisma-repository.ts:141` menghasilkan `e.id` dan `e.account_id`, sedangkan JOIN pada baris 180 memberi alias `employee`. Pemanggilan `employeeDashboard()` pada baris 494 selalu mengaktifkan filter ini.

Probe repository asli pada PostgreSQL yang sudah dimigrasi menghasilkan `Raw query failed. Code: 42P01. Message: missing FROM-clause entry for table "e"`. Query tetap gagal pada database kosong; data fixture tidak dibutuhkan untuk memicu kesalahan parser.

Dampak: `GET /api/v1/me/dashboard` gagal; UI ringkasan, jadwal, riwayat, dan pengajuan yang bergantung pada response gabungan tidak memperoleh data. Tes `apps/api/test/modules/dashboard-prisma-repository.test.ts:264` justru mengharapkan `e.id`, sehingga mock mempertahankan bug.

Tindakan: **AUD-01**, konsistenkan alias dan tambah tes PostgreSQL yang juga membuktikan owner scoping; jangan membuang filter akun untuk membuat query berhasil.

### F-02 — P0 — Smoke test PostgreSQL salah mengasumsikan format signed cookie

**Jenis: bug harness terkonfirmasi, bukan bukti cookie aplikasi tidak ditandatangani.** `apps/api/test/postgres-smoke.ts:65` mensyaratkan prefix `s:` dan baris 72 mengekstrak token dengan offset prefix itu. Kode runtime `apps/api/src/routes/auth.ts:79` memakai `signed: true`, dan pembacaan memakai `request.unsignCookie()` pada baris 64.

Smoke test gagal pada PostgreSQL sementara dengan `Session cookie must be signed`. Probe menggunakan package `@fastify/cookie` yang terpasang menunjukkan cookie tanpa prefix `s:` **tetap memiliki signature valid**. Asumsi serialization tes salah untuk library ini. Job CI `postgres-integration` menjalankan script yang sama; CI remote tidak dijalankan dalam audit ini.

Tindakan: **AUD-02**, validasi dengan signer/unsigner library serta negative tampering case; jalankan ulang smoke hingga seluruh tahap selesai. Jangan melemahkan opsi cookie produksi.

### F-03 — P1 — Quality command default mengalami timeout XLSX

**Jenis: kegagalan reproduksibilitas tes, kemungkinan kontensi resource.** `apps/api/test/modules/monthly-report-xlsx.test.ts:12` timeout pada suite default; API/web berjalan serentak dan Vitest melaporkan 58/77 worker pada run tersebut. Suite API dengan dua worker kemudian lulus 514 tes.

Tindakan: **AUD-03**, tetapkan worker budget yang sesuai mesin/CI dan ukur tes terfokus; hindari sekadar menaikkan semua timeout. Status `pnpm check` saat audit tetap gagal.

### F-04 — P0 — Jalur absensi otomatis Valid belum tersedia; liveness belum tepercaya

**Jenis: gap implementasi yang disengaja untuk menjaga evidence.** `apps/web/src/components/attendance/liveness.ts:134` memakai detector `null` sebagai default. `apps/api/src/modules/attendance/prisma-repository.ts:374` menetapkan `hasTrustedLivenessEvidence=false`; baris 383–386 mengembalikan `PENDING_VERIFICATION` untuk alur online, dan offline juga selalu pending melalui gate tersebut. Baris 665–666 menyimpan face/liveness hasil server sebagai false.

Dampak: lokasi valid dan selfie tersedia belum menghasilkan otomatis Valid. Beban review manual tinggi; klaim fitur anti-curang selesai tidak tepat. Ini bukan alasan untuk mempercayai flag client atau mengubah pending menjadi Valid tanpa verifier.

Tindakan: **AUD-07/AUD-08**, kontrak bukti, batas kemampuan browser, privacy, dan strategi verifikasi server dahulu; implementasi serta uji spoof/replay sesudah keputusan desain.

### F-05 — P0 — GPS tanpa fix menghalangi penyimpanan attempt

**Jenis: gap alur teridentifikasi dari source, belum diuji perangkat.** `apps/web/src/components/attendance/CameraCaptureDialog.tsx:360–365` hanya mengizinkan submit awal jika `locationSnapshot.status==='captured'`. `apps/api/src/modules/attendance/index.ts:45` mewajibkan object koordinat/akurasi. Foto dengan lokasi denied/timeout/unavailable dan tanpa fix sama sekali tidak dapat dikirim sebagai attempt pending.

PRD FR-19/21 menuntut fallback dan pencatatan upaya; saat koordinat terbaik tidak ada sama sekali, kontrak kegagalan belum tersedia. Berbeda dengan fix akurasi buruk/di luar radius yang sudah dapat disimpan pending.

Tindakan: **AUD-05**, tentukan representasi lokasi tidak tersedia dan alasan kegagalan; server menahan pending, simpan attempt, dan jangan memalsukan koordinat `0,0`.

### F-06 — P0 — Offline lintas tengah malam belum teratribusi ke shift capture

**Jenis: gap kebijakan/implementasi yang didokumentasikan.** Repository attendance baris 445–446 memakai tanggal receipt server sebagai awal resolusi shift. `docs/TODO-implementation-plan.md` bagian BE-018/BE-020 mengakui antrean yang baru sync pada tanggal berikutnya tidak dijamin cocok dengan shift asli. Job server tidak dapat melihat antrean IndexedDB yang belum tersinkron.

Dampak: capture masuk pada hari D dan sync D+1 dapat terkait shift hari berbeda atau ditolak; daily ABSENT hari D belum tentu dipulihkan oleh rekonsiliasi exact-key. `offline-sync.ts` juga mengukur drift dari selisih capture-versus-receipt; delay normal >5 menit ikut dianggap drift sesuai kebijakan konservatif saat ini (`DECISIONS.md` BE-018).

Tindakan: **AUD-06**, keputusan kontrak waktu/shift dan bukti tepercaya harus eksplisit; jangan menjadikan timestamp browser otoritas. Uji malam, cutoff +2 jam, sync >24 jam, clock manipulation, dan correction reconciliation.

### F-07 — P1 — Watermark baru metadata, belum melekat pada gambar

**Jenis: gap FR-09 yang didokumentasikan.** `docs/DECISIONS.md:574–576` menyatakan watermark tidak dibakar ke pixel dan `watermarkApplied` tetap false. Pipeline capture hanya menggambar video dan resize (`camera-capture.ts:76/120`). Metadata server disimpan pada intent.

Tindakan: **AUD-09**, pipeline gambar turunan dengan watermark nama/waktu server/koordinat dan sumber privat, menjaga original dan batas ukuran. Verifikasi artifact gambar, bukan hanya boolean/metadata.

### F-08 — P1 — Koreksi dan monthly closing belum menjadi workflow lengkap

**Jenis: gap fitur operasi.** BE-022/BE-026 masih backlog; request service hanya menerima LEAVE/SICK/ANNUAL_LEAVE/OVERTIME (`attendance-requests/index.ts:17`). UI menyatakan koreksi belum tersedia. Laporan memakai `ignoreCorrections:true` (`report/prisma-repository.ts:101`), dan UI closing belum tersedia pada FE-016.

Dampak: pesan checkout yang mengarahkan ke koreksi belum memiliki alur lengkap; original/correction/report/lock period belum dapat diuji end-to-end. Keberadaan tabel `AttendanceCorrection`/`MonthlyRecap` bukan penyelesaian fitur.

Tindakan: **AUD-10 → AUD-11 → AUD-12 → AUD-13**. Tetapkan scope closing/override/reopen terlebih dahulu, lalu transaksi correction, UI, report reconciliation, serta lock server.

### F-09 — P1 — Kebijakan pengajuan dan scope historis belum dikunci

**Jenis: keputusan produk/desain terbuka.** BE-021 mendokumentasikan konflik role Supervisor untuk lembur vs FR-30 yang mensyaratkan persetujuan Admin. Implementasi saat ini menolak keputusan overtime Supervisor. Scope request dihitung dari assignment jadwal saat review, bukan snapshot saat pengajuan. Overlap lintas tipe dibatasi konservatif.

Dampak: perubahan assignment dapat mengubah reviewer/store attribution pengajuan lama; perilaku approval dan kombinasi izin/lembur perlu kesepakatan sebelum dianggap final.

Tindakan: **AUD-14**, tulis decision table dan snapshot scope; uji perubahan assignment dan batas izin Supervisor. Tambahkan retention policy surat dokter terpisah dari selfie.

### F-10 — P1 — Konfigurasi operasional, saldo cuti, alternatif dan assisted belum lengkap

**Jenis: gap backlog.** `EmployeeLeavePage.tsx` menampilkan saldo belum tersedia karena kuota/akrual/carry-over belum ditetapkan. BE-019/FE-010 belum memiliki workflow QR/Wi-Fi/supervisor lengkap. Belum ada settings UI/API terpadu untuk seluruh SLA/batas yang PRD nyatakan dapat diubah Admin, dan belum ada alur lengkap perangkat bantuan.

Tindakan: **AUD-15–AUD-18**. Device approval UI sudah tersedia pada `AdminAccountsPage.tsx`; jangan mengimplementasikannya ulang. 2FA Admin merupakan penguatan tambahan yang perlu masuk keputusan scope keamanan sebelum go-live.

### F-11 — P1 — Gangguan sistem belum idempotent dan belum merekonsiliasi dampak massal

**Jenis: gap ketahanan/operasi yang didokumentasikan.** BE-023 menyatakan POST retry membuat record/audit baru; mass correction belum memiliki mapping produk. FE-017 mengunci UI pada outcome jaringan tidak pasti, sehingga recovery bergantung pada rekonsiliasi manual.

Tindakan: **AUD-19**, idempotency durable untuk POST dan preview/apply dampak massal setelah kebijakan disepakati. Jangan mengubah raw attendance secara massal.

### F-12 — P0 untuk gate rilis — Scheduler, storage nyata, backup/restore dan staging belum dibuktikan

**Jenis: gap verifikasi/infrastruktur.** CLI daily-status/retention sudah ada; `.do/app.yaml` tidak menjadwalkannya. App Spec memakai `/api/v1/health` sebagai liveness, sehingga readiness database tetap memerlukan release gate sendiri. Template bukan bukti deploy. Bucket privacy, signed upload/read, purge objek live, backup offsite terenkripsi, RPO/RTO, serta monitoring/alert belum dibuktikan.

`retention:run` belum memberikan antarmuka dry-run sebagaimana DEP-011 meminta. Audit tidak membuat resource cloud berbayar dan tidak menguji akun/provider.

Tindakan: **AUD-20–AUD-23**, persiapkan artefak lokal/runbook lebih dahulu, kemudian validasi staging/provider yang telah diotorisasi. Backup/restore dan scheduler menjadi syarat sebelum production gate.

### F-13 — P0 untuk gate rilis — Bukti E2E/perangkat/performa belum tersedia

**Jenis: gap pengujian.** Vitest/happy-dom/fake-indexeddb tidak membuktikan kamera, GPS, install PWA, suspend/reload offline, permissions atau Safari iOS. Smoke bawaan berhenti dini pada F-02; SQL alias F-01 menunjukkan kelemahan tes query-shape yang memakai mocks.

Tindakan: **AUD-22/AUD-24**, E2E HTTP→database→response, parity dashboard/JSON/XLSX, IDOR, database concurrency, browser/device matrix, dan beban data 200 karyawan/20 toko. Budget bundle yang lulus belum membuktikan halaman <=3 detik atau absensi <=10 detik pada 4G.

### F-14 — P2 — Advisory moderate `uuid` transitif melalui `exceljs`

**Jenis: dependency advisory terkonfirmasi registry; exploitability proyek belum dibuktikan.** `uuid@8.3.2`, path `apps__api>exceljs>uuid`, advisory [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq), missing buffer bounds check pada v3/v5/v6 ketika buffer disediakan. Registry melaporkan versi patched >=11.1.1.

Jangan memaksa override major tanpa memeriksa API/CommonJS compatibility ExcelJS dan round-trip XLSX. CI saat ini memakai `--audit-level=high`, sehingga advisory moderate tidak menjadi blocker pada command tersebut.

Tindakan: **AUD-25**, cek reachability dari export, pilih perbaikan compatible atau dokumentasi risiko sementara dengan owner/tenggat; perbarui lockfile hanya bila solusi diuji.

### F-15 — P2 — Dokumentasi status dan startup sudah tidak sinkron

**Jenis: documentation drift.** README masih menyebut fondasi dan tidak menyebut seluruh validasi secure runtime terbaru; `env.ts` sekarang mewajibkan DATABASE_URL/SESSION_SECRET/APP_ORIGIN HTTPS pada staging dan production. Backlog menyimpan angka tes dan pernyataan Docker tidak tersedia dari checkpoint berbeda. Perubahan path `.env` pengguna belum memiliki bukti regression khusus untuk source/build.

Tindakan: **AUD-04/AUD-26**, tes loader precedence/path, ringkasan status terbaru yang memisahkan local/DB/browser/provider, dan tautan bukti. Jangan menghapus checkpoint historis seolah audit lama tidak pernah terjadi.

## Kekuatan implementasi yang perlu dipertahankan

- Cookie signed/HttpOnly/SameSite, exact-origin CSRF, redaction logger dan strict DTO input.
- Authorization server-side owner/store scope dan regression tests negatif.
- Unique constraints, row locking, idempotency attempt, staged/sealed private evidence, audit append-only trigger.
- Pending verification sebagai fallback aman; timestamp server tidak diam-diam diganti waktu browser.
- Antrean offline AES-GCM, owner scoping, lease/tombstone receipt, logout preservation, foreground session re-verification.
- JSON dan XLSX memakai aggregator yang sama; `workDays` menghitung tanggal unik, detail tetap per shift.
- Route lazy loading, contract build PWA, API exclusion service worker, serta budget aset.

## Gate berikutnya

1. Perbaiki F-01/F-02 dan stabilkan pemeriksaan default. Jalankan ulang smoke penuh pada DB terisolasi.
2. Putuskan kontrak GPS failure, offline lintas tanggal, bukti liveness, koreksi/closing, dan approval/kuota cuti.
3. Implementasikan alur lengkap serta rekonsiliasi dengan audit dan scoping tetap utuh.
4. Verifikasi storage/scheduler/backup/restore/staging dan matrix perangkat. Pilot terbatas setelah gate kritis lolos.

Detail task, dependencies, estimasi, dan acceptance criteria berada di [BREAKDOWN-TASK.md](./BREAKDOWN-TASK.md). Seluruh task asal dipetakan di [MATRIKS-BACKLOG.md](./MATRIKS-BACKLOG.md). Audit ini menghasilkan dokumen dan script bukti; tidak menandai task implementasi selesai.
