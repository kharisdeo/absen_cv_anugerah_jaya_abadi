# Prompt siap dijalankan di Luna 6.0

Target model: **GPT-6 Luna (gpt-6-luna)**. Pilih model tersebut pada pemilih model sebelum menjalankan prompt; menyebut nama model di teks tidak mengganti model sesi. Paket ini disiapkan untuk Luna, dan belum dieksekusi oleh Luna.

Struktur scope, constraints, output dan validation yang eksplisit mengikuti pendekatan [OpenAI Docs untuk keluarga GPT-6](https://developers.openai.com/api/docs/guides/latest-model#prompting-best-practices). Pembagian satu task per run merupakan pilihan kerja proyek ini; kualitas hasil tetap harus diperiksa dengan evidence.

## Cara memakai

1. Buka workspace dan pilih GPT-6 Luna.
2. Tempel **prompt awal** untuk mulai AUD-01.
3. Setelah selesai, gunakan **prompt lanjutan** atau pilih **prompt per task**. Pada chat baru, tempel **aturan bersama** lalu prompt task.
4. Jika task sudah dikerjakan setelah audit, validasi kondisi terbaru sebelum mengedit.

## Prompt awal — langsung mulai task pertama

```text
Audit tersedia di docs/audit/2026-10-14. Kerjakan AUD-01: perbaiki SQL dashboard karyawan sampai ada bukti regression yang benar.

Baca AGENTS.md yang berlaku bila ada, lalu bagian relevan dari docs/PRD.md, docs/TODO-implementation-plan.md, docs/DECISIONS.md, docs/audit/2026-10-14/LAPORAN-AUDIT.md dan BREAKDOWN-TASK.md. Periksa git status sebelum mengedit.

Temuan konkret: apps/api/src/modules/dashboard/prisma-repository.ts menghasilkan filter e.id/e.account_id, tetapi tabel employees diberi alias employee. Repository asli gagal pada PostgreSQL dengan 42P01 missing FROM-clause entry for table "e". Tes dashboard-prisma-repository.test.ts justru mengharapkan e.id.

Perbaiki alias secara minimal tanpa membuang pemeriksaan employeeId + accountId server-side. Tambahkan regression SQL nyata pada database CI terisolasi dan fixture dua employee untuk membuktikan owner scoping. Jangan ubah data database proyek atau produksi. Pertahankan perubahan lokal pengguna di apps/api/src/config/env.ts.

Gunakan Node >=22.12, pnpm 11.25.0, Fastify/Prisma/React/Vite yang sudah ada. Tidak perlu rewrite stack atau upgrade massal. Raw attendance immutable, audit append-only, WIB Asia/Jakarta, pending berbeda dari ABSENT, dan bukti liveness client bukan bukti server.

Audit mencatat PostgreSQL smoke terpisah gagal pada parser cookie prefix s: (AUD-02). Jangan menyatakan smoke penuh lulus atau mengubah cookie runtime untuk mengakali masalah ini. Lakukan regression query task ini secara terpisah bila smoke masih terhalang.

Jalankan tes relevan, pnpm check, dan verifikasi PostgreSQL sesuai scope. Laporkan command/exit/result aktual serta kegagalan di luar scope. Jangan klaim browser/device/storage cloud teruji bila belum dijalankan. Jangan commit, push, deploy, atau provision layanan berbayar tanpa instruksi/otorisasi yang berlaku.

Hasil akhir: ringkasan masalah/perbaikan, file yang berubah, bukti tes, status AUD-01 COMPLETE/PARTIAL beserta alasan, dan dependency berikutnya. Lakukan pekerjaan sekarang, jangan berhenti pada rencana. Batasi perubahan ke AUD-01.
```

## Aturan bersama untuk chat/run task lain

```text
Anda mengerjakan monorepo Absensi CV Anugerah Jaya Abadi. Gunakan source terkini, bukan hanya klaim status checkpoint lama. Baca instruksi repository, PRD 2.0, TODO, DECISIONS, API/OpenAPI dan bagian task pada docs/audit/2026-10-14/BREAKDOWN-TASK.md. Temuan ada di LAPORAN-AUDIT.md dan matriks 73 task di MATRIKS-BACKLOG.md.

Kerjakan tepat satu task yang ditentukan di bawah sampai outcome konkret dan reviewable. Cek dependencies; jangan membangun ulang bagian yang sudah berfungsi. Pilih implementasi minimal dalam Fastify/TypeScript/Prisma/PostgreSQL dan React/Vite PWA existing. Jangan rewrite atau upgrade dependency di luar kebutuhan task.

Periksa git status dan pertahankan perubahan pengguna, terutama env.ts path root .env. Jangan membaca/mencetak secret asli. Gunakan fixture sintetis dan database uji terisolasi. Jangan migrate/reset/seed database pengguna atau produksi untuk tes. Ikuti sandbox approval jika operasi membutuhkan akses tambahan.

Decision locks: WIB Asia/Jakarta; waktu server otoritas; raw attendance tidak ditimpa correction; audit append-only; minimal dua Admin aktif; owner/role/store scope diperiksa server; selfie kamera langsung tanpa gallery; lokasi hanya saat absensi tanpa background tracking; private image dengan signed URL singkat; pending dan ABSENT berbeda; liveness flag client bukan trusted evidence.

Jika kebijakan bisnis belum diputuskan, selesaikan analisis source, proposal decision table, acceptance dan artefak teknis dahulu. Minta keputusan hanya pada ambiguity aturan bisnis. Lanjutkan pekerjaan independen. Jangan mengubah policy diam-diam dan jangan menyamarkan partial sebagai complete.

Verifikasi dengan tes perilaku relevan dan pnpm check setelah implementasi. SQL/transaction memerlukan PostgreSQL nyata pada DB test; kamera/GPS/PWA/provider memerlukan pemisahan bukti DOM/mock dari device/provider. Laporkan gagal/blocked dengan sebab dan command; jangan skip test/menurunkan assertion agar hijau. Update API/OpenAPI/DECISIONS ketika kontrak berubah.

Jangan commit/push/deploy/provision resource berbayar di luar otorisasi. Siapkan dahulu perubahan lokal/runbook/konfigurasi yang dapat direview.

Output akhir singkat: task/status; perubahan/file; command/hasil; acceptance terpenuhi/belum; blocker/risiko; task berikutnya. Simpan sanitized evidence pada status task. Bukti audit 14 Oktober 2026 adalah baseline, bukan hasil run Anda saat ini.
```

## Prompt lanjutan — pilih task siap berikutnya

```text
Dengan aturan bersama paket audit, periksa hasil task sebelumnya dan dependency di BREAKDOWN-TASK.md. Pilih satu task TODO prioritas tertinggi yang prerequisites-nya terbukti, lalu kerjakan sampai acceptance terpenuhi. Sebutkan task dan alasannya singkat sebelum bekerja. Jika perlu keputusan bisnis/provider, siapkan artefak keputusan dan bagian independen; jangan menebak approval. Jangan jalankan seluruh backlog sekaligus. Laporkan status aktual/evidence tanpa menganggap COMPLETE dari run sebelumnya otomatis valid.
```

## Prompt per task

### AUD-01 — SQL dashboard employee

```text
Kerjakan AUD-01 sesuai BREAKDOWN-TASK.md dan aturan bersama. Fokus e.id/e.account_id vs alias employee pada dashboard CTE. Pertahankan ownership server. Ubah regression mock yang salah, jalankan repository di PostgreSQL serta fixture A/B. Acceptance: /me/dashboard tidak gagal 42P01 dan tidak membuka data employee lain. Gunakan reproduce-dashboard.ts sebagai bukti baseline, bukan tes yang dianggap sudah lulus.
```

### AUD-02 — Cookie smoke PostgreSQL

```text
Kerjakan AUD-02 setelah AUD-01. Baca readSignedSessionCookie dan signer library terpasang. Cookie valid tidak memakai prefix s: yang diasumsikan tes. Validasi dengan signer/unsigner, token asli dan case tampered; pertahankan HttpOnly/SameSite/Path checks. Jangan ubah signed cookie runtime atau sekadar menghapus assertion. Acceptance: smoke penuh lulus pada DB CI fresh dan invalid signature ditolak.
```

### AUD-03 — Quality suite stabil

```text
Kerjakan AUD-03. Baseline pnpm check timeout pada monthly-report-xlsx.test.ts, tetapi API --maxWorkers 2 lulus 514 tes. Ukur contention/import dan pilih worker budget local/CI yang beralasan. Hindari skip dan blanket timeout increase. Acceptance: pnpm check default lulus dan XLSX tetap membuktikan parity/WIB/untrusted text. Catat konfigurasi/runtime aktual.
```

### AUD-04 — Root env regression

```text
Kerjakan AUD-04. Pertahankan perubahan lokal env.ts ../../../../.env. Verifikasi source dan compiled dist mencari root env, shell precedence dan secure-runtime startup memakai fixture sintetis. Update README mengenai DATABASE_URL/SESSION_SECRET/APP_ORIGIN HTTPS di staging/production. Jangan cetak/mengubah .env pengguna. Acceptance: regression loader lulus dan startup docs sesuai kode.
```

### AUD-05 — GPS tanpa fix tetap tercatat

```text
Kerjakan AUD-05. Dialog mensyaratkan captured dan API memerlukan koordinat, sehingga GPS denied/timeout tanpa fix menghalangi attempt. Siapkan kontrak nullable evidence/failure reason sesuai PRD, lalu persist pending attempt/selfie/receipt tanpa koordinat palsu. Update API/OpenAPI/schema bila perlu. Uji denied/unavailable/timeout/inaccurate fix/replay/owner scope. Acceptance: upaya relevan tercatat dan tidak diberi Valid/ABSENT karena GPS gagal.
```

### AUD-06 — Offline lintas tanggal

```text
Kerjakan AUD-06 sesuai dependency. Baca receipt-based workDate dan daily exact-key reconciliation. Tulis decision record atribusi shift/tanggal, server time evidence dan delay vs clock drift; minta keputusan bila belum terkunci sebelum dependent code. Sesudah keputusan, uji capture D sync D+1, shift malam, cutoff+2, >24h, clock manipulation, ABSENT dan closing di PostgreSQL. Jangan jadikan waktu browser otoritas atau membuka Valid dengan flag client.
```

### AUD-07 — Desain liveness evidence

```text
Kerjakan desain AUD-07. Baca detector null, hasTrustedLivenessEvidence=false, sealed selfie dan consent. Hasilkan kontrak implementable untuk detector/challenge/server verification/TTL/replay/privacy/unsupported/performa/tests. Jelaskan batas bukti browser. Acceptance: desain reviewable dengan success/failure criteria dan pending fallback. Jangan aktifkan Valid atau klaim liveness produksi selesai.
```

### AUD-08 — Implementasi liveness/verifier

```text
Kerjakan AUD-08 hanya dengan kontrak AUD-07 disepakati. Implementasikan detector/challenge dan server-verifiable evidence, pisahkan trusted result dari claim client. Uji spoofed flags/replay/expiry/missing face/unsupported/timeout/trusted success. Acceptance: Valid hanya ketika semua gate terbukti, unsupported pending, raw video tidak disimpan tanpa policy. Device/provider acceptance PARTIAL bila belum diuji.
```

### AUD-09 — Watermark gambar

```text
Kerjakan AUD-09. Metadata bukan pixel watermark. Buat derivative privat dengan nama DB, receipt waktu server WIB dan lokasi benar/label unavailable. Pertahankan original/sealing/retensi kedua objek. Uji artifact gambar, ukuran/scoping/render failure. Acceptance: watermark terlihat dan watermarkApplied hanya true sesudah sukses, tanpa URL publik.
```

### AUD-10 — Kebijakan koreksi/closing

```text
Kerjakan desain AUD-10. Buat decision table correction tanpa original, H+3 hari kerja, SLA/approver/scope, close tanggal 3, pending saat closing, Admin override dan reopen policy. Gunakan PRD/schema. Selesaikan proposal/contoh acceptance/keputusan terbuka sebelum meminta keputusan produk. Jangan implementasikan workflow dengan asumsi baru. Acceptance: policy reviewable, original immutable dan audit utuh.
```

### AUD-11 — Koreksi backend

```text
Kerjakan AUD-11 dengan keputusan AUD-10. Buat correction service/routes/repository, actor session/H+3/scope/record baru/audit atomic/employee lock konsisten. Update API/OpenAPI. Uji original immutable, unauthorized/duplicate/deadline/approval/closing/concurrency PostgreSQL. Acceptance: correction efektif dan terlacak tanpa menimpa raw attendance.
```

### AUD-12 — UI koreksi dan report parity

```text
Kerjakan AUD-12 setelah backend correction. Buat employee form/review dan sambungkan arahan koreksi checkout. Integrasikan effective source pada dashboard/JSON/XLSX; jangan sekadar hapus ignoreCorrections tanpa semantics. Uji correction/original trace/scope/SLA/closed/parity. Acceptance: angka/status konsisten dan UI mempunyai flow nyata.
```

### AUD-13 — Monthly closing

```text
Kerjakan AUD-13 dengan policy AUD-10 dan correction terintegrasi. Implementasikan preview/close/idempotency/badge/export metadata/lock mutasi server/Admin override reason. Uji race closing vs sync/job/correction dan audit atomic. Acceptance: period protected, non-Admin read-only, reopen hanya sesuai keputusan.
```

### AUD-14 — Request policy/scope historis

```text
Kerjakan AUD-14. Siapkan keputusan overtime Supervisor vs Admin, overlap lintas tipe, multi-store/global dan snapshot historis saat assignment berubah. Tetapkan retention surat dokter terpisah dari selfie. Setelah keputusan, implementasikan snapshot/backfill aman dan approval/overlap PostgreSQL tests. Acceptance: perubahan jadwal tidak membuka IDOR dan overtime sesuai policy.
```

### AUD-15 — Saldo cuti

```text
Kerjakan AUD-15 dengan policy kuota/akrual/carry-over/prorata/reservation eksplisit. Buat ledger/balance, approval/reversal atomic dan UI. Jangan menebak jatah tahunan/placeholder. Uji holiday/year boundary/concurrent request/ownership. Acceptance: opening+earned-used-reserved menghasilkan remaining konsisten dan diaudit.
```

### AUD-16 — Settings operasional

```text
Kerjakan AUD-16. Petakan decision locks ke provider config/settings; pisahkan secrets dari Admin-editable policy. Tetapkan effective date/snapshot. Implementasikan bounds/Admin-only API/UI/reason/audit diff. WIB tetap Asia/Jakarta. Acceptance: UI/service memakai sumber sama dan perubahan batas tidak menghitung ulang histori diam-diam.
```

### AUD-17 — QR/Wi-Fi/supervisor alternatives

```text
Kerjakan AUD-17 bertahap. Signed QR store-scoped TTL 30–60s/replay prevention, Wi-Fi trusted request IP, lalu supervisor authenticated/scoped confirmation. Jangan percaya forwarded header tanpa trust-proxy policy. Uji expiry/replay/store mismatch/forged header/unauthorized. Acceptance: bukti metode tersimpan, fallback gagal tetap pending.
```

### AUD-18 — Assisted attendance

```text
Kerjakan AUD-18 setelah policy akun sendiri/perangkat bantuan disepakati. Desain limited assisted context tanpa bypass device binding sesi biasa. Implementasikan selfie/helper audit/expiry/scope/review. Acceptance: ASSISTED selalu pending, server identity, perangkat pribadi tidak diganti diam-diam, abuse tests lulus.
```

### AUD-19 — Disruption retry/batch correction

```text
Kerjakan AUD-19 dengan policy correction/closing/mapping dampak disepakati. Tambah durable key/fingerprint/replay POST disruption. Preview/apply batch append-only dan recovery via key, bukan asumsi pagination. Uji duplicate/unknown response/conflict/scope/closed. Acceptance: retry tidak menggandakan record/audit dan raw attendance tidak berubah.
```

### AUD-20 — Private storage provider proof

```text
Kerjakan AUD-20. Siapkan validation/runbook sebelum meminta provisioning; gunakan staging yang diotorisasi. Buktikan anonymous deny, signed PUT/read CORS/TTL/headers/ownership/store scope, sealed immutability/deletion/encryption/attachment privacy. Redact token/URL/secret. Acceptance: provider assertions aktual; tanpa akses selesaikan lokal dan laporkan PARTIAL.
```

### AUD-21 — Scheduler dan retention dry-run

```text
Kerjakan AUD-21 dengan cadence/worker disepakati. Tambah dry-run tanpa delete/write, scheduling daily/retention, bounded retry/exclusion, metrics/failure alerts. Uji idempotency/purge references/dry-run side effects. Acceptance: scheduled run/alert terbukti pada environment diotorisasi; angka dan audit tetap utuh.
```

### AUD-22 — Full flow E2E/reconciliation

```text
Kerjakan AUD-22 untuk fitur dengan prerequisites siap. Bangun login→consent/password/device→attendance→review→correction→report/XLSX→closing dengan HTTP/DB nyata dan browser/provider sesuai gate. Fixture A/B, Supervisor lintas toko, multi-shift, pending/rejected, late offline, disruption, unknown outcome/concurrency wajib. Acceptance: parity dan IDOR terbukti; scope belum diuji tetap PARTIAL.
```

### AUD-23 — Staging/backup/restore

```text
Kerjakan AUD-23 dalam otorisasi. Siapkan config/runbook/validation dahulu, provision/deploy hanya bila diizinkan. Verifikasi routing/build/start/readiness/TLS, backup encrypted offsite daily 30 hari/weekly 3 bulan, metrics/alerts/rollback/restore terisolasi. Acceptance: RPO<=24h/RTO<=4h terukur, DB/object references konsisten; template bukan bukti deploy.
```

### AUD-24 — Device matrix/performance/pilot

```text
Kerjakan AUD-24 dengan perangkat/staging tersedia. Uji Chrome Android 9+/Safari iOS 15+, install/camera/GPS/airplane mode/reload/suspend/quota/device replacement/assisted. Ukur 200 employee/20 store, halaman<=3s, attendance<=10s pada 4G acuan, payload<=300KB. Catat device/network/pass-fail. Acceptance: pilot blockers ditutup, koordinat/radius toko, dua Admin, reviewer/incident owner dan handover tervalidasi.
```

### AUD-25 — Advisory uuid/ExcelJS

```text
Kerjakan AUD-25. Baca GHSA-w5hq-g745-h8pq pada uuid@8.3.2 transitif ExcelJS, periksa reachability/API compatibility. Pilih patch compatible atau risk decision owner+tenggat bila patch tidak aman. Jangan force major override tanpa tes. Acceptance: fresh audit/XLSX round-trip/lockfile evidence; risiko sementara eksplisit jika belum remediasi.
```

### AUD-26 — Status terbaru/release gate

```text
Kerjakan AUD-26 berdasarkan evidence aktual. Sinkronkan README/docs index/TODO/go-live gate, pertahankan checkpoint historis dengan tanggal. Pisahkan local/PostgreSQL/browser/device/provider/production, link evidence dan owner blockers. Sertakan keputusan scope 2FA Admin. Acceptance: tidak ada COMPLETE semu, commands/links valid, rollback/incident owner/dependencies jelas.
```

## Template hasil Luna

```text
Task: AUD-XX — judul
Status: COMPLETE / PARTIAL / BLOCKED
Perubahan: [perilaku dan file]
Bukti: [command, exit code, jumlah tes/assertion]
Acceptance: [terpenuhi dan belum]
Risiko/dependency: [konkret]
Berikutnya: [satu task yang prerequisites-nya siap]
```

BLOCKED pada template ini adalah status task implementasi; bukan alasan menghentikan analisis/artefak lokal yang masih dapat dikerjakan.
