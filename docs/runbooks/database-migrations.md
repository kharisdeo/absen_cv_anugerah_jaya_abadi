# Runbook migrasi dan pemulihan database

## Status dan batas penggunaan

Runbook ini mengikuti struktur repository saat ini:

- Backend memakai Prisma dengan schema `apps/api/prisma/schema.prisma`, konfigurasi
  `apps/api/prisma.config.ts`, dan direktori migrasi
  `apps/api/prisma/migrations/`.
- Terdapat migrasi bernomor `0001` sampai `0011`. Setiap migrasi memiliki
  `migration.sql`; repository tidak menyediakan file atau command `down` untuk
  membatalkan migrasi.
- `prisma.config.ts` membaca `DATABASE_URL` dari environment proses/CI atau dari
  `.env` di root repository. Nilai environment proses mengalahkan nilai lokal.
- `db:migrate:deploy` hanya tersedia sebagai script package `@absen/api`; tidak ada
  wrapper `pnpm db:migrate:deploy` di root.
- Docker Compose menyediakan database **lokal demo** `absen_local_demo` pada
  `127.0.0.1:5433`, dengan user `absen_local`.

Runbook ini belum membuktikan migration atau restore pada staging/production.
Staging database belum diprovisioning, provider production belum diputuskan, dan
belum ada restore drill yang disaksikan/ditandatangani. Jangan menafsirkan bagian
staging/production sebagai konfigurasi otomatis atau sebagai prosedur khusus
DigitalOcean.

## Aturan keselamatan

1. Perubahan schema production memerlukan change record, approval pemilik layanan
   dan database, release/build immutable yang sudah diuji, serta jendela perubahan
   dan rencana komunikasi yang disetujui.
2. Sebelum migrasi berisiko, harus ada backup yang baru, berhasil, identitas sumber
   dan waktu backup-nya tercatat, serta bukti bahwa backup dapat dipulihkan ke
   lingkungan terisolasi. Pastikan titik pemulihan memenuhi RPO yang disetujui.
   Jika backup atau restore belum terverifikasi, **hentikan release**.
3. Pastikan identitas target (environment, host/cluster, database, dan role) cocok
   dengan change record sebelum menjalankan Prisma. Jangan mencetak atau menyalin
   `DATABASE_URL` untuk memeriksanya; URL itu memuat kredensial. Environment proses
   dapat mengganti `.env` lokal.
4. Jangan pernah menjalankan `prisma migrate reset`, `db push --force-reset`, atau
   destructive migration pada staging/production. Jangan mengedit migration yang
   sudah pernah diterapkan pada environment bersama; buat migrasi baru.
5. Command dalam bagian backup/restore yang dapat dieksekusi hanya ditujukan ke
   Compose lokal yang diikat ke loopback. Command tersebut bukan cara membackup
   atau memulihkan staging/production.

## Persiapan migrasi

Sebelum membuat atau merilis migrasi:

- Tinjau seluruh `migration.sql`, schema sebelum/sesudah, data yang terdampak,
  constraint/index, lock dan durasi yang diperkirakan, kebutuhan backfill, serta
  efek bila proses berhenti di tengah. Jangan hanya mengandalkan perbandingan
  Prisma schema.
- Validasi migrasi pada database non-production yang representatif dan berukuran
  cukup untuk mengungkap lock atau waktu backfill yang berisiko.
- Buat migrasi melalui workflow development lokal yang sesuai; review SQL yang
  dihasilkan sebelum commit. Setelah migrasi pernah diterapkan pada environment
  bersama, perlakukan isi file tersebut sebagai immutable.
- Pastikan versi aplikasi lama dan baru dapat hidup bersamaan selama rolling
  deployment. Hindari satu release yang sekaligus menghapus/merename kolom yang
  masih dibaca oleh versi aplikasi lama.

### Pola expand-contract

Untuk perubahan yang perlu rolling deploy, pisahkan perubahan menjadi tahap yang
kompatibel:

1. **Expand:** tambahkan struktur baru secara additive dan backward-compatible,
   misalnya kolom nullable atau tabel/indeks baru. Jangan menghapus struktur lama.
2. **Deploy kompatibel:** rilis aplikasi yang dapat berjalan dengan schema lama
   dan baru. Bila perlu, lakukan dual-write/dual-read dengan aturan konsistensi dan
   observability yang jelas.
3. **Backfill:** isi data lama secara bertahap, dapat diulang, terukur, dan dengan
   batas beban. Validasi hasilnya menggunakan agregat/constraint tanpa menaruh
   data pribadi ke log.
4. **Alihkan penggunaan:** setelah semua instance versi lama berhenti, alihkan
   pembacaan dan penulisan ke bentuk baru; pantau hasilnya.
5. **Contract terpisah:** hanya pada release berikutnya, setelah masa observasi,
   hapus struktur lama bila seluruh consumer, job, laporan, dan jalur pemulihan
   tidak lagi membutuhkannya serta approval risiko tersedia.

Jangan melakukan expand dan contract sekaligus dalam rolling deploy. Jika tidak
bisa membuktikan kompatibilitas versi aplikasi yang sedang hidup, gunakan jendela
maintenance dan keputusan eksplisit pemilik layanan; jangan mengasumsikan semua
instance berganti versi serentak.

## Alur lokal

Prasyarat: Node.js sesuai `engines` root (`>=22.12.0`), pnpm `11.25.0`, Docker
Compose, dan PostgreSQL client tools (`psql`, `pg_dump`, `pg_restore`, `createdb`)
tersedia jika akan menjalankan contoh backup/restore. Root `.env` harus dibuat dari
`.env.example` bila belum ada, lalu diisi dengan nilai **khusus lokal**. Jangan
menyalin credential staging/production ke `.env` lokal. `pnpm db:start` memerlukan
`POSTGRES_PASSWORD` lokal dan `DATABASE_URL` yang sesuai dengan database Compose.

Jalankan dari root repository di Windows PowerShell:

```powershell
pnpm install --frozen-lockfile
pnpm db:start
```

Sebelum command Prisma, pastikan `.env`/environment efektif benar-benar menunjuk
ke database lokal. Perintah berikut memeriksa identitas koneksi lokal dengan
password prompt; hasilnya tidak menampilkan password:

```powershell
psql --host 127.0.0.1 --port 5433 --username absen_local --dbname absen_local_demo --password --command "SELECT current_database() AS database_name, current_user AS database_user, inet_server_addr() AS server_address, inet_server_port() AS server_port;"
```

Pemeriksaan `psql` di atas menggunakan parameter koneksi tersendiri. Itu tidak
membuktikan bahwa `DATABASE_URL` yang akan dibaca Prisma identik; periksa target
`.env` dan override environment secara lokal tanpa mencetak URL. Jika identitas
Prisma tidak dapat dipastikan, jangan jalankan migrasi.

Command repository yang tersedia:

```powershell
# Status migrasi pada DATABASE_URL efektif; tidak menerapkan perubahan.
pnpm db:migrate:status

# Validasi sintaks/schema Prisma; tidak membuktikan koneksi atau status DB live.
pnpm --filter @absen/api db:validate

# Workflow development lokal untuk membuat/menerapkan migrasi dari perubahan schema.
# Jangan gunakan command ini sebagai prosedur staging/production.
pnpm db:migrate:dev

# Buat Prisma Client dari schema; tidak menerapkan migrasi ke database.
pnpm db:generate

# Simulasikan deployment migrasi pada target yang sudah dipastikan lokal.
pnpm --filter @absen/api db:migrate:deploy
pnpm db:migrate:status
```

`db:migrate:dev` dan `db:migrate:deploy` bukan sinonim: yang pertama adalah
workflow pengembangan dan dapat meminta/membuat migrasi; yang kedua menerapkan
migrasi yang sudah ada. `db:validate` dan `db:generate` tidak membuktikan bahwa
database target tersedia atau migrasinya sudah terpasang. Untuk menjalankan
`db:migrate:deploy` dari root, gunakan filter package API seperti contoh di atas;
`pnpm db:migrate:deploy` tidak didefinisikan.

## Staging dan production

Langkah berikut adalah release gate, bukan klaim bahwa infrastrukturnya sudah
tersedia:

1. Siapkan change record berisi commit/build immutable, daftar migrasi yang akan
   diterapkan, perkiraan lock/downtime, penanggung jawab, jendela perubahan,
   langkah validasi, rencana komunikasi, keputusan rollback aplikasi/database,
   dan kriteria abort.
2. Dapatkan approval eksplisit sebelum perubahan. Verifikasi environment dan
   identitas database secara privat melalui kanal operasi yang disetujui. Gunakan
   role dengan hak minimum yang dibutuhkan; jangan menaruh credential pada argumen
   command, log, tiket, atau output CI.
3. Pastikan backup sebelum migrasi telah berhasil dan **restore drill** yang
   relevan telah lulus. Catat identifier backup, sumber, waktu, checksum/bukti
   integritas yang tersedia, lokasi terlindungi, masa retensi, hasil restore,
   serta siapa yang memverifikasinya. Backup yang hanya terlihat “completed” tanpa
   bukti pemulihan tidak memenuhi gate ini.
4. Dari runner/deployment context yang disetujui dan memiliki `DATABASE_URL`
   melalui secret management, jalankan validasi schema dan cek status migrasi.
   Pastikan output status sesuai dengan migrasi yang direncanakan dan target masih
   benar sebelum melanjutkan:

   ```powershell
   pnpm --filter @absen/api db:validate
   pnpm --filter @absen/api db:migrate:status
   ```

5. Untuk migrasi additive/backward-compatible, terapkan migrasi terencana sebelum
   rolling out aplikasi yang memakainya. Command repository yang tersedia adalah:

   ```powershell
   pnpm --filter @absen/api db:migrate:deploy
   pnpm --filter @absen/api db:migrate:status
   ```

   Jalankan hanya setelah approval, backup/restore gate, dan verifikasi target
   lulus. Jangan menjalankan ulang secara buta setelah error; lihat bagian
   pemulihan di bawah.

6. Deploy versi aplikasi immutable yang sudah diuji. Pantau health API, error
   database, latency/lock, koneksi, job dan antrean, serta alur absensi penting.
   Simpan hasil status migration dan smoke test tanpa credential atau data pribadi.
7. Jika ada langkah contract/destructive, jadwalkan sebagai perubahan terpisah
   setelah semua versi lama dan consumer berhenti, backfill tervalidasi, observasi
   selesai, serta approval baru diperoleh.

Repository belum menyediakan staging `DATABASE_URL`, resource staging, backup
policy yang diverifikasi, atau bukti command deployment berhasil pada database
managed. Workflow CI juga memiliki job terpisah yang menerapkan migrasi pada
PostgreSQL ephemeral GitHub Actions dan menjalankan smoke test; hasil job tersebut
bukan bukti migrasi atau pemulihan staging/production. Keberhasilan run CI terbaru
belum diverifikasi dalam task ini. Jangan menganggap pemilihan target provider
staging sebagai bukti konfigurasi atau perilaku backup/restore provider.

## Memilih rollback atau forward-fix

| Kondisi                                                                                                                      | Tindakan yang diutamakan                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Aplikasi baru bermasalah, schema additive masih kompatibel, dan data belum ditulis dalam format yang hanya versi baru pahami | Hentikan rollout dan kembalikan aplikasi ke build immutable sebelumnya. Pertahankan schema yang sudah diterapkan; pantau versi aplikasi lama terhadap schema baru.                                                                                                                                     |
| Aplikasi baru sudah menulis data baru atau mengubah makna/format data                                                        | Jangan mengasumsikan rollback aplikasi aman. Hentikan perubahan lanjutan, evaluasi compatibility dan dampak data bersama pemilik layanan; biasanya buat forward-fix aplikasi/migrasi.                                                                                                                  |
| `migrate deploy` gagal atau terputus                                                                                         | Hentikan rollout. Catat migration name dan error yang sudah disanitasi, periksa status migrasi dan keadaan schema dengan DBA, lalu putuskan perbaikan. Jangan mengulang, mengedit migration terapan, menghapus baris metadata Prisma, atau menandai status secara manual tanpa rencana yang disetujui. |
| Migration sukses tetapi hasil bisnis/schema salah dan belum ada data yang bergantung padanya                                 | Preferensikan migrasi baru yang memperbaiki keadaan. Rollback schema hanya bila ada prosedur spesifik yang telah direview, terbukti aman, dan disetujui; repository tidak menyediakan down migration.                                                                                                  |
| Data hilang/rusak atau recovery point diperlukan                                                                             | Restore hanya berdasarkan incident/change approval ke database/instance terisolasi baru; validasi, rekonsiliasi perubahan setelah backup, dan rencanakan cutover eksplisit. Restore backup lama atas database aktif dapat menghapus perubahan setelah waktu backup dan bukan tombol “undo”.            |

Prisma `migrate deploy` menerapkan migrasi yang tertunda; ia **tidak menyediakan
down migration atau rollback otomatis**. Repository ini juga tidak memiliki
command/script rollback. Jangan mengarang atau menjalankan command `down` yang
tidak ada. Mengembalikan binary aplikasi tidak membalik perubahan database.

### Kapan forward-fix wajib diprioritaskan

Gunakan migration baru yang maju bila transaksi aplikasi sudah menulis data pada
kolom/tabel baru, backfill sudah mengubah banyak baris, nilai lama sudah ditimpa,
ada attendance/correction/recap/audit event sesudah perubahan, atau beberapa versi
aplikasi sudah membaca/menulis schema baru. Buat perbaikannya idempotent bila
memungkinkan, batasi dan ukur backfill, pertahankan jejak audit, serta uji jalur
kompatibilitas sebelum menjalankannya.

Jangan menghapus atau menurunkan tipe kolom hanya untuk “mengembalikan” versi lama
aplikasi. Kolom tidak boleh dikontraksikan selama masih dibutuhkan oleh instance
lama, job, report, integrasi, backfill/reconciliation, atau pemulihan. Jangan
menghapus data absensi, koreksi, rekap, consent, audit, atau referensi bukti tanpa
retention/legal review dan approval yang relevan. Foreign key dan trigger pada
schema dapat sengaja membatasi penghapusan; jangan menonaktifkan atau mengakalinya.

## Contoh backup dan restore lokal yang terisolasi

Contoh ini **khusus database demo Compose lokal**, bukan staging/production. Host,
port, nama database, dan user dikunci di contoh; guard harus tetap lulus sebelum
command dijalankan. Jika guard gagal, berhenti dan jangan mengubahnya agar
menunjuk environment lain. Backup dapat berisi data pribadi walaupun disebut demo:
simpan hanya jika database dipastikan berisi data sintetis. `$env:TEMP` pada contoh
tidak diklaim terenkripsi. Jika database memuat data pegawai nyata atau data
sensitif, jangan gunakan contoh ini; gunakan prosedur backup yang disetujui dengan
penyimpanan terenkripsi dan akses terbatas. Hapus dump sintetis sesuai kebijakan
setelah drill. Jangan menyimpan file di repository atau mengunggahnya ke layanan
publik.

### Buat dan periksa dump lokal

Jalankan dari root repository. Password diminta secara interaktif oleh `pg_dump`;
jangan menaruh password/URL database dalam command, `PGPASSWORD`, transcript, atau
log. Parameter host/database di bawah adalah nilai non-secret dan hanya untuk
Compose lokal.

```powershell
$ErrorActionPreference = 'Stop'
$DbHost = '127.0.0.1'
$DbPort = 5433
$DbName = 'absen_local_demo'
$DbUser = 'absen_local'
$BackupRoot = Join-Path $env:TEMP 'absen-local-db-backups'
$BackupFile = Join-Path $BackupRoot ("absen_local_demo-{0}.dump" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))

if ($DbHost -ne '127.0.0.1' -or $DbPort -ne 5433 -or $DbName -ne 'absen_local_demo' -or $DbUser -ne 'absen_local') {
  throw 'Guard target lokal gagal; dump dibatalkan.'
}
New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
if (Test-Path -LiteralPath $BackupFile) { throw 'File dump sudah ada; pilih nama baru.' }

pg_dump --host $DbHost --port $DbPort --username $DbUser --dbname $DbName --password --format=custom --no-owner --no-acl --file $BackupFile
if ($LASTEXITCODE -ne 0) { throw 'pg_dump gagal; jangan gunakan file ini.' }

pg_restore --list $BackupFile | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Daftar arsip tidak dapat dibaca; dump belum terverifikasi.' }
Get-FileHash -LiteralPath $BackupFile -Algorithm SHA256
```

Daftar arsip yang terbaca dan checksum adalah pemeriksaan awal, bukan bukti bahwa
seluruh data dapat dipulihkan. Bukti restore baru didapat setelah restore penuh ke
database terisolasi dan validasi di bawah berhasil.

### Pulihkan ke database lokal baru

Restore ini membuat **database baru** dengan prefix khusus dan tidak menggunakan
opsi `--clean` atau `--create`. Jangan ganti host/port/nama tujuan menjadi
environment bersama. Pastikan dump yang dipilih memang file drill lokal yang
diinginkan sebelum melanjutkan.

```powershell
$RestoreHost = '127.0.0.1'
$RestorePort = 5433
$RestoreDb = "absen_restore_drill_{0}" -f (Get-Date -Format 'yyyyMMddHHmmss')
$DbUser = 'absen_local'

if ($RestoreHost -ne '127.0.0.1' -or $RestorePort -ne 5433 -or $RestoreDb -notmatch '^absen_restore_drill_[0-9]{14}$') {
  throw 'Guard target restore lokal gagal; restore dibatalkan.'
}
if (-not (Test-Path -LiteralPath $BackupFile -PathType Leaf)) { throw 'File dump tidak ditemukan.' }

createdb --host $RestoreHost --port $RestorePort --username $DbUser --maintenance-db absen_local_demo --owner $DbUser --template template0 --password $RestoreDb
if ($LASTEXITCODE -ne 0) { throw 'Database drill lokal tidak berhasil dibuat; hentikan proses.' }

pg_restore --host $RestoreHost --port $RestorePort --username $DbUser --dbname $RestoreDb --password --no-owner --no-acl --exit-on-error --single-transaction $BackupFile
if ($LASTEXITCODE -ne 0) { throw 'Restore gagal; pertahankan database drill untuk pemeriksaan dan jangan cutover.' }
```

### Validasi setelah restore

Password kembali diminta secara interaktif. Query berikut hanya menampilkan
identitas database dan metadata schema/migration, bukan baris absensi atau data
pribadi:

```powershell
psql --host 127.0.0.1 --port 5433 --username absen_local --dbname $RestoreDb --password --set ON_ERROR_STOP=1 --command "SELECT current_database() AS database_name, current_user AS database_user, inet_server_addr() AS server_address, inet_server_port() AS server_port;"

psql --host 127.0.0.1 --port 5433 --username absen_local --dbname $RestoreDb --password --set ON_ERROR_STOP=1 --command "SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back FROM public._prisma_migrations ORDER BY started_at;"

psql --host 127.0.0.1 --port 5433 --username absen_local --dbname $RestoreDb --password --set ON_ERROR_STOP=1 --command "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename;"
```

Pastikan identitas menunjukkan `absen_restore_drill_...`, bukan database sumber;
semua migrasi yang diharapkan tercatat selesai; tidak ada migrasi yang tertinggal
atau gagal; dan tabel inti yang diharapkan ada. Setelah itu, jalankan validasi
aplikasi/smoke test hanya dengan konfigurasi non-production yang menunjuk ke
database drill dan layanan eksternal dimatikan atau disandbox. `db:validate`
memvalidasi schema pada source, bukan isi atau kesehatan database yang dipulihkan.
Catat waktu, checksum, hasil, operator, dan kegagalan tanpa mencatat credential
atau data pribadi. Jangan jadikan database drill sebagai production dengan
sekadar mengganti URL.

Untuk backup/restore staging atau production, jangan memakai contoh lokal ini.
Gunakan mekanisme yang nanti disetujui untuk environment tersebut, dengan
identifikasi sumber/target, backup terenkripsi dan akses terbatas, target restore
terisolasi yang dibuktikan bukan production, validasi pasca-restore, persetujuan
cutover, serta rencana rekonsiliasi write setelah recovery point. Detail provider,
retensi, enkripsi, restore semantics, dan prosedur cutover harus diverifikasi
setelah account/resource tersedia; dokumen ini tidak menjanjikan bahwa provider
menyediakannya otomatis.

## Bukti yang masih belum ada

- Staging PostgreSQL belum diprovisioning dan `DATABASE_URL` staging belum tersedia.
- Tidak ada bukti `migrate deploy` berhasil pada staging/production.
- Backup policy/retensi/akses dan instruksi pemulihan provider belum diverifikasi.
- Belum ada restore drill staging/production, pengukuran RPO/RTO, atau validasi
  pasca-restore yang ditandatangani.
- Belum ada approval release database production atau runbook operasional provider.

Karena bukti tersebut belum tersedia, status DEP-007 tetap **PARTIAL**.
