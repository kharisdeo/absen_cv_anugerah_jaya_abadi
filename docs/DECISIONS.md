# Keputusan Arsitektur

Catatan ini mencakup keputusan fondasi BE-001. Keputusan bisnis di PRD dan decision
lock pada task plan tetap menjadi sumber kebenaran untuk perilaku produk.

## Keputusan yang sudah ditetapkan

| Area               | Keputusan                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Monorepo           | pnpm workspace TypeScript dengan `apps/*` dan `packages/*`.                                                         |
| API                | Fastify REST API dalam `apps/api`, berjalan sebagai ESM di Node.js.                                                 |
| API versioning     | Prefix `/api/v1`; liveness `GET /api/v1/health`, readiness `GET /api/v1/ready`.                                     |
| Persistence target | PostgreSQL dengan Prisma, sesuai arahan pemilik proyek.                                                             |
| Web app            | React + Vite PWA di `apps/web` pada task frontend mendatang.                                                        |
| Shared contracts   | `packages/contracts` pada task integrasi mendatang.                                                                 |
| Deployment         | Runtime aplikasi tetap containerized dan vendor-agnostic; target staging DigitalOcean, production belum diputuskan. |

## Keputusan deployment staging

- Keputusan pemilik proyek ini berlaku **khusus staging** dan tidak menyetujui atau
  menetapkan provider yang sama untuk production.
- Frontend Vite static site dan API Fastify ditempatkan di DigitalOcean App Platform,
  region `SGP`. App Platform mencantumkan static site dan dynamic app pada region
  tersebut ([ketersediaan region App Platform](https://docs.digitalocean.com/products/app-platform/details/availability/)).
- Database staging direncanakan memakai DigitalOcean Managed PostgreSQL Standard
  single-node 1 GiB di `SGP1` (non-HA), dengan estimasi mulai sekitar $15/bulan.
  PostgreSQL tersedia di region tersebut; fitur managed mencakup enkripsi
  in-transit/at-rest dan backup harian dengan PITR tujuh hari. Harga aktual dan
  ketersediaan plan harus dikonfirmasi pada akun/region sebelum provisioning
  ([region PostgreSQL](https://docs.digitalocean.com/products/databases/postgresql/details/availability/),
  [fitur PostgreSQL](https://docs.digitalocean.com/products/databases/postgresql/details/features/),
  [harga PostgreSQL](https://docs.digitalocean.com/products/databases/postgresql/details/pricing/)).
- Selfie staging disimpan di DigitalOcean Spaces `SGP1` dalam bucket private. Jangan
  membuka object/bucket secara publik atau mengaktifkan Spaces CDN untuk object selfie.
  Akses baca tetap melalui signed URL berumur pendek yang dibuat server setelah
  otorisasi; access key hanya berada di server. Spaces Standard base subscription $5/bulan
  mencakup 250 GiB storage dan 1.024 GiB outbound transfer; pemakaian di atas kuota dapat
  dikenai biaya. Spaces menyediakan private object dan
  presigned URL ([region Spaces](https://docs.digitalocean.com/products/spaces/details/availability/),
  [izin file dan presigned URL](https://docs.digitalocean.com/products/spaces/how-to/set-file-permissions/)).
- App Platform scheduled jobs hanya boleh dipakai bila cadence minimum 15 menit
  memenuhi kebutuhan job. Job yang perlu berjalan lebih sering menggunakan always-on
  worker; revisi arsitektur memerlukan justifikasi eksplisit sebelum implementasi
  ([batas jadwal scheduled jobs](https://docs.digitalocean.com/products/app-platform/how-to/manage-jobs/)).
- Pemilihan staging ini tidak mengikat implementasi aplikasi ke DigitalOcean: container
  dan konfigurasi vendor-agnostic tetap dipertahankan. Account/resource provisioning,
  domain, secrets, konfigurasi bucket, dan verifikasi aktual terhadap account/provider
  masih pending.

### Estimasi biaya dan batas kapasitas staging

Estimasi baseline sekitar **$30/bulan** (belum termasuk pajak atau overage), dan bukan
persetujuan biaya. Asumsi: satu instance API memakai plan fixed baru `apps-s-1vcpu-1gb-fixed`
($10/bulan; 1 shared vCPU, 1 GiB RAM; kuota outbound 100 GiB/bulan), satu PostgreSQL
Standard single-node 1 GiB RAM (mulai sekitar $15/bulan; non-HA), dan satu Spaces Standard
subscription ($5/bulan; 250 GiB storage dan 1.024 GiB outbound transfer).
Static site Vite di app yang sama dengan komponen API berbayar diasumsikan $0 biaya
tambahan. Harga/kelayakan region, tax, dan biaya aktual wajib dikonfirmasi di akun
DigitalOcean sebelum owner menyetujui provisioning. Overage bandwidth/storage dapat
menambah biaya.

Plan API berkapasitas tetap dan tidak menyediakan manual maupun autoscaling; sizing ini
khusus staging dan harus diuji terhadap beban sebelum pilot. Kuota transfer App Platform
dipool pada tingkat team; transfer tambahan saat ini dikenakan $0,02/GiB. PostgreSQL
single-node bersifat non-HA sehingga bukan konfigurasi production. Untuk Spaces Standard,
storage di atas 250 GiB dikenakan $0,02/GiB/bulan dan outbound transfer di atas 1.024 GiB
dikenakan $0,01/GiB; verifikasi tarif aktual pada akun.

## Standar backend

- Modular monolith: setiap area produk memiliki direktori di
  `apps/api/src/modules/<area>`. Daftar awal mengikuti task plan: `auth`, `employee`,
  `store`, `schedule`, `attendance`, `request`, `report`, `audit`, `notification`, dan
  `backup`.
- API error menggunakan `application/problem+json` sesuai RFC 9457. Response memakai
  `type`, `title`, `status`, `detail`, `instance`, serta extension `code` dan
  `requestId`. Error 5xx tidak mengirim detail internal kepada client.
- Logging menggunakan Pino bawaan Fastify dalam format terstruktur. Request ID dibuat
  server-side. Header authorization/cookie dan nama field sensitif umum di-redact;
  request body tidak dicatat.
- Environment dibaca dari `process.env` dan divalidasi dengan Zod saat proses mulai.
  Nilai runtime dasar memiliki default aman untuk local development; variabel rahasia
  belum diperlukan pada fondasi ini.
- TypeScript memakai ESM `NodeNext` dan strict checks. Prettier menangani format,
  ESLint flat config menangani lint, dan Vitest menjalankan test API.
- `GET /api/v1/health` adalah liveness check proses saja dan tetap independen dari DB.
  `GET /api/v1/ready` memeriksa DB secara terpisah; route tanpa session, selalu no-store,
  mempertahankan plugin keamanan HTTP global, dan hanya mengembalikan status generik.

## Evidensi BE-027/DEP-005 — readiness lokal

- Saat `DATABASE_URL` tersedia, runtime memakai Prisma tagged SQL statis `SELECT 1`;
  tanpa konfigurasi callback readiness, probe fail closed. Exception query tidak diteruskan
  ke response.
- `GET /health` tidak memanggil probe dan tetap 200 ketika readiness gagal. `GET /ready`
  mengembalikan 200/`ok` atau 503/`unavailable` serta `Cache-Control: no-store`.
- Route tests memakai fake callback/Prisma dan auth harness untuk memastikan error sensitif
  tidak bocor, probe bisa diakses tanpa session, serta header keamanan global tetap diterapkan.
  Ini hanya bukti lokal; PostgreSQL live, staging smoke test, dan deployment belum diverifikasi.

## Batas BE-001

- BE-001 tidak membuat schema/migration Prisma, koneksi PostgreSQL, atau generated
  client. Fondasi tersebut ditambahkan pada BE-003.
- Belum ada autentikasi, authorization policy, endpoint produk, model domain, atau
  aturan bisnis dalam API.
- BE-001 sendiri tidak memilih vendor hosting/database/storage; target DigitalOcean
  untuk staging kini ditetapkan pada bagian “Keputusan deployment staging”. Provider
  production dan notifikasi tetap belum dipilih.

## Keputusan BE-003 — database dan migrasi

- PostgreSQL memakai Prisma ORM 7.10.0; `prisma`, `@prisma/client`, dan
  `@prisma/adapter-pg` dipatok ke versi yang sama agar CLI, generated client, dan
  runtime adapter tidak berbeda major/minor. Prisma 8 tidak dipakai.
- Prisma 7 generator memakai provider `prisma-client` dengan output khusus di
  `apps/api/src/generated/prisma`; file hasil generate tidak disimpan di Git.
- URL datasource CLI berasal langsung dari `process.env.DATABASE_URL`. Config memakai
  string kosong jika URL belum ada agar validasi dan generate tidak meminta database;
  perintah migrasi tetap memerlukan URL yang valid. API tetap dapat start tanpa URL.
- Runtime Prisma PostgreSQL menggunakan driver adapter `@prisma/adapter-pg` dengan
  `pg`. BE-003 hanya menyiapkan dependensi dan client generation; belum membuat
  PrismaClient singleton, repository, atau koneksi saat startup.
- Timestamp kejadian memakai PostgreSQL `TIMESTAMPTZ(3)`; tanggal bisnis memakai
  `DATE`; jam shift memakai `TIME(0)` tanpa zona karena merupakan jam dinding lokal.
  Koordinat disimpan sebagai `DECIMAL`, bukan floating point.
- Setiap percobaan absensi dipertahankan sebagai record. Unique idempotency key
  mencegah replay kiriman yang sama; unique index parsial membatasi satu record
  aktif yang sudah valid/disetujui per karyawan/tanggal/jenis, sambil tetap
  mengizinkan percobaan pending atau ditolak tersimpan.
- Maksimal satu device binding berstatus `APPROVED` per karyawan dijaga dengan
  partial unique index PostgreSQL. Index parsial, check constraints tambahan, dan
  trigger audit append-only berada di migration SQL karena tidak seluruhnya dapat
  dinyatakan di Prisma schema.
- Data selfie disimpan sebagai metadata dan private object key. Setelah retensi,
  object key dapat dikosongkan dan metadata bukti tetap dipertahankan.
- Audit log tidak memiliki `updatedAt`; trigger PostgreSQL menolak `UPDATE`,
  `DELETE`, dan `TRUNCATE`. Aplikasi tetap perlu memberi role database dengan hak
  minimum dan tidak menyediakan operasi mutasi audit.

## Keputusan BE-002 — environment

- `NODE_ENV` menerima `development`, `test`, `staging`, dan `production`.
- API memuat `.env` dari root repository memakai `process.loadEnvFile` bawaan Node.js;
  environment yang sudah disediakan oleh shell/deployment tidak ditimpa. Tidak ada
  dotenv dependency tambahan.
- `TIMEZONE` kosong/tidak disetel default ke `Asia/Jakarta`; setelah trim hanya nilai itu yang
  diterima. Nilai lain ditolak saat startup sesuai PRD NFR-07, dengan diagnostic yang menyebut
  nama konfigurasi dan aturan tanpa mengulang nilai input.
- `DATABASE_URL` boleh tidak disetel sampai implementasi database menggunakannya;
  bila disetel, nilainya harus memakai protokol PostgreSQL.
- `SESSION_SECRET` tidak wajib pada local/test. Production mewajibkannya dengan
  panjang minimal 32 karakter dan minimal 16 karakter berbeda. Validasi ini tidak
  mengungkap nilai secret di pesan error.
- Storage menggunakan nama env generik `STORAGE_*` agar aplikasi tetap vendor-agnostic.
  Untuk staging, targetnya Spaces `SGP1` dengan bucket private dan signed URL singkat
  dari server; keputusan ini tidak memilih provider storage production. Bila
  dikonfigurasi, bucket, access key, dan secret key diwajibkan; endpoint boleh kosong
  untuk provider yang menyediakan endpoint default.
- Notifikasi memakai `NOTIFICATION_PROVIDER` dan `NOTIFICATION_CREDENTIALS` generik;
  credentials boleh kosong bila provider tidak memerlukannya. Provider belum dipilih.
- `SELFIE_RETENTION_MONTHS` default ke nilai PRD, 12. `FEATURE_FLAGS` adalah JSON
  object berisi boolean dan default ke object kosong; nama flag dan default bisnis
  tidak ditebak pada fondasi ini.
- `.env.example` hanya berisi default non-secret. Health endpoint local tetap dapat
  start tanpa database, auth, storage, atau notification secrets.

## Toolchain

Versi utama dependency dibatasi dengan rentang semver dan versi dependency transitive
akan dikunci oleh `pnpm-lock.yaml` setelah install di lingkungan dengan akses registry.
Node.js minimum ditetapkan `22.12.0` untuk mendukung toolchain pengujian saat ini;
runtime yang dipakai saat fondasi dibuat adalah Node.js `24.19.0`.

## Keputusan DEP-001 — local development dan seed demo

- Pengembangan lokal memakai Compose dengan image PostgreSQL `17.11-alpine3.24`,
  named volume `absen_cv_anugerah_jaya_abadi_local_postgres_data`, healthcheck
  `pg_isready`, dan port `127.0.0.1:5433:5432`. Tidak ada layanan database produksi,
  managed database, atau object-storage vendor yang dipilih.
- Password database dan password akun demo hanya berasal dari root `.env` yang
  di-ignore Git. `.env.example` hanya berisi default non-secret dan placeholder kosong.
  Prisma CLI serta API memuat `.env` root tanpa menimpa environment shell/CI.
- Seed memerlukan `SEED_DEMO_DATA=true`, hanya berjalan pada `NODE_ENV=development`
  atau `test`, dan menolak URL selain PostgreSQL dengan user `absen_local`, host
  `127.0.0.1`, port `5433`, serta database `absen_local_demo`. Seeder juga memeriksa
  nama database dan user yang benar-benar terhubung. Password di-hash dengan util
  Argon2id auth yang sama dan `mustChangePassword` tetap aktif. Upsert memakai UUID
  fixture tetap; record lain tidak dihapus.
- Seed membuat dua Admin aktif, satu Supervisor dan satu Employee dengan profil/NIK
  sintetis, satu toko DEMO pada koordinat `0,0`, shift weekday dan penugasannya hanya
  untuk Employee, hari libur far-future, serta satu pengajuan cuti `PENDING` tanpa
  lampiran sebagai fixture status yang didukung schema. Masing-masing dari empat akun
  memakai password demo terpisah dari environment lokal.
- Saat keputusan seed ini dibuat, schema belum memiliki relasi supervisor-to-store scope
  maupun aggregate `DailyAttendance`. BE-017 kemudian menambah tabel assignment Supervisor
  khusus; `EmployeeStore` tetap hanya menyatakan keanggotaan Employee pada store dan
  `assignedByUserAccountId` tidak pernah memberi Supervisor scope. Seed tidak membuat
  attendance/attempt, status absensi harian, device, selfie, koordinat absensi, atau bukti
  palsu; juga tidak mengarang assignment Supervisor.

## Keputusan BE-011 — toko dan assignment karyawan

- Schema Prisma yang ada sudah mencakup field toko, koordinat `DECIMAL(9,6)`, default
  radius `10` meter dan batas akurasi `30` meter, kolom `INET`, serta relasi many-to-many
  `EmployeeStore` dengan unique key komposit dan FK `RESTRICT`; BE-011 tidak memerlukan
  perubahan schema atau migration. API menghilangkan field default yang tidak dikirim
  agar nilai default di schema tetap menjadi satu-satunya sumber runtime.
- Nama toko dibatasi secara teknis maksimal 160 karakter dan alamat maksimal 500
  karakter di API. Kolom PostgreSQL tetap `TEXT`; batas API membatasi payload input,
  bukan aturan bisnis atau batas database. Teks dipangkas di kedua sisi dan string
  kosong ditolak, sementara alamat boleh `null`.
- Latitude/longitude harus finite, dalam rentang fisik inklusif (`-90..90` dan
  `-180..180`), dan memiliki maksimal enam angka desimal. Nilai yang melebihi presisi
  ditolak, tidak dibulatkan diam-diam, karena kolom tujuan berpresisi `DECIMAL(9,6)`.
- `wifiPublicIp` menerima hanya satu alamat IPv4 atau IPv6 literal yang valid; CIDR,
  interface zone, dan hostname bukan alamat yang diterima. `null` menghapus nilai.
  Radius dan batas akurasi menerima bilangan bulat positif sampai maksimum tipe
  PostgreSQL `INTEGER` (`2,147,483,647`); tidak ditambahkan batas bisnis lain.
- Store tidak dihapus permanen; endpoint deactivate mengubah `isActive` dan relasi
  maupun histori attendance dipertahankan. Perubahan konfigurasi toko dan assignment
  dicatat dengan before/after. Untuk memenuhi audit koordinat toko tanpa membuka
  koordinat absensi atau lokasi karyawan, `AuditService` hanya mempertahankan field
  `latitude`/`longitude` tingkat teratas untuk aksi Admin `store.create`,
  `store.update`, dan `store.deactivate`; key sensitif lain dan koordinat bersarang
  tetap disanitasi.
- Assignment memakai `PUT` idempotent dan `DELETE` idempotent. Penyimpanan assignment
  menggunakan insert yang mengabaikan benturan unique komposit sehingga request PUT
  paralel tidak menggandakan assignment maupun audit. Audit dibuat hanya saat keadaan
  relasi benar-benar berubah. Menghapus assignment atau mengubah koordinat/radius
  tidak menulis atau mengubah record attendance historis.

## Keputusan FE-001 — PWA shell dan route guard

- Web menggunakan React + Vite di `apps/web`, sesuai keputusan arsitektur monorepo.
  API base URL default adalah relative `/api/v1`; Vite dev proxy meneruskan `/api` ke
  `http://127.0.0.1:3000`, dan dapat dioverride dengan `VITE_API_PROXY_TARGET`. Vite
  dev server dibuka melalui `http://localhost:5173`, sama persis dengan default
  development `APP_ORIGIN` backend untuk pemeriksaan CSRF/Origin.
- Status sesi dihidrasi dari `GET /api/v1/auth/me` menggunakan cookie sesi dan
  `credentials: include`; password, token, dan role tidak disimpan di localStorage.
  Hanya HTTP 401 berarti unauthenticated; kegagalan jaringan/server menampilkan state
  unavailable dan tidak membuka route terlindungi.
- Route `/employee/*`, `/supervisor/*`, dan `/admin/*` membandingkan role server-derived
  dengan role route. Consent/password awal dan device binding non-approved menahan akses
  ke shell data; otorisasi sebenarnya tetap wajib dilakukan backend.
- `vite-plugin-pwa` menghasilkan manifest dan service worker. Strategi update adalah
  prompt agar worker baru tidak memaksa reload tanpa tindakan pengguna. Precache hanya
  asset statis shell; API path dikecualikan dari navigation fallback dan tidak ada
  runtime cache untuk respons API, auth, attendance, foto, lokasi, atau data personal.
  Offline mode pada task ini hanya menjamin shell terbuka; belum mendukung submit absensi.
- Manifest menyediakan mark SVG yang dapat diskalakan. Browser yang mendukung prompt
  instalasi memakai `beforeinstallprompt`; Safari iOS mendapat petunjuk manual
  Share → Add to Home Screen. Area attendance dan master data tetap placeholder sampai
  task terkait selesai.
- Ikon instalasi berupa PNG 192×192 dan 512×512, ditambah Apple touch icon 180×180;
  generator PNG memakai Node built-ins tanpa dependensi runtime baru. Orientasi tidak
  dikunci agar dashboard supervisor/admin dapat digunakan pada desktop maupun landscape.

## Keputusan FE-002 — Design system dan state model

- Label dan tone status disimpan terpusat di `apps/web/src/domain/attendance-state.ts`;
  validation, status harian, dan status pengajuan memakai domain terpisah. Transition
  client hanya mengizinkan pasangan yang sama dengan state machine backend.
- Komponen UI menggunakan HTML semantik, label/error relationship, native `<dialog>`
  untuk pengelolaan fokus modal, dan scroll horizontal untuk tabel pada layar sempit.
  Ukuran kontrol sentuh minimal 44 px dan menghormati `prefers-reduced-motion`.
- Error API ditampilkan dari allowlist `code` yang memang dikeluarkan backend. Field
  `detail`, `title`, `instance`, request ID, dan kode yang tidak dikenal tidak dirender;
  error jaringan dan layanan unavailable memiliki pesan Indonesia yang aman.
- `DesignSystemExamples` menjadi gallery/story tanpa menambah route produk; test
  server-render membuktikan seluruh status/error contoh, semantik komponen, dan aturan
  responsif tanpa dependency UI-test tambahan.

## Keputusan FE-003 — Login dan onboarding

- Login, consent, dan penggantian password menggunakan endpoint backend dengan cookie
  HttpOnly (`credentials: include`); password hanya berada di state form sementara dan
  session/auth token tidak disimpan di storage browser.
- Urutan onboarding di client mengikuti server: persetujuan policy terbaru, ganti
  password awal, lalu pemeriksaan device binding. Teks policy/purposes hanya berasal
  dari `GET /api/v1/consents/current` dan ditampilkan apa adanya; client hanya mengirim
  versi serta `accepted: true`.
- Backend saat ini mensyaratkan `deviceToken` dan `deviceName` bagi non-Admin, tetapi
  pemilik belum menetapkan penyimpanan ID instalasi browser. Karena itu belum ada
  fingerprint atau ID/token perangkat yang dibuat/disimpan client; helper injection
  default kosong. Login Admin berjalan, sedangkan login karyawan menunggu keputusan ID.
- Backend menyamakan kredensial salah dan akun terkunci sebagai `INVALID_CREDENTIALS`.
  UI menampilkan advisory generik 5 kegagalan/15 menit tanpa timer atau klaim status
  lockout untuk username tertentu; countdown presisi tidak tersedia tanpa mengubah
  kontrak backend dan meninjau risiko enumerasi akun.
- Password baru divalidasi terhadap batas server yang tersedia (required, maksimum
  1.024 karakter dan 4.096 byte) serta konfirmasi sama; client tidak menambah syarat
  kompleksitas yang belum ditentukan.

## Keputusan FE-004 — Shell dashboard per role

- Satu konfigurasi navigasi role menjadi sumber route menu dan route yang dilindungi.
  Karyawan hanya mendapat ringkasan/status diri, jadwal, riwayat, cuti, dan pengajuan;
  Supervisor mendapat antrean verifikasi/pengajuan tanpa pemilih toko client; Admin
  mendapat ringkasan operasional, master data, approval, dan laporan.
- Employee `/employee` memakai `useEmployeeDashboard({})` → `GET /api/v1/me/dashboard`.
  Bagian status hari ini hanya memakai `today[]` dari response: empty hanya bila array kosong;
  shift, status, tanggal kerja, dan jam berasal dari item server. Browser tidak menentukan
  tanggal bisnis dan UI tidak menyimpulkan status tidak hadir. Loading/error memakai
  `AsyncState`; error mempunyai retry dan pesan aman melalui `toUserErrorMessage`.
- Supervisor `/supervisor` memakai `useAdminDashboard({})` → `GET /api/v1/dashboard` tanpa
  filter tanggal, `storeId`, atau `shiftId`; hanya page/pageSize default yang dikirim.
  Server menentukan tanggal bisnis dan membatasi data dengan `supervisorStoreAssignment`.
  UI hanya merender `summary.waitingVerification` dan `summary.pendingRequests`; angka,
  termasuk nol untuk antrean kosong, hanya muncul dari response sukses. Error memakai
  pemetaan aman dan retry. Response endpoint yang ada juga memuat daftar/ranking karyawan
  dalam cakupan yang diizinkan server, tetapi halaman Supervisor tidak merender detail itu;
  minimisasi payload di backend berada di luar FE-004A.
- Route/guard dan `/admin` tetap tidak berubah; Admin tetap memakai `AdminDashboardPage`.
  Tombol absensi dan antrean offline Employee dipertahankan apa adanya.
- Bukti lokal FE-004A: `role-home-dashboard.test.tsx`, `role-shell.test.tsx`, dan
  `employee-dashboard-pages.test.tsx` lulus (3 file, 20 tes). Tes mencakup loading, error
  aman/retry, empty, sukses untuk kedua ringkasan, dan request Supervisor tanpa filter scope.
- Sisa verifikasi FE-004: belum ada browser visual QA atau database aktif di workspace ini;
  kontrak role/scope diperiksa dari implementasi server dan tes client, bukan dari sesi
  supervisor pada PostgreSQL live. Dashboard admin dan halaman detail alur tetap berada
  pada task masing-masing.

## Keputusan FE-005 — Foto kamera lokal tanpa pengiriman

- Hanya dashboard Karyawan yang menampilkan aksi `Foto sementara`. Membuka dialog
  tidak meminta izin; `getUserMedia` baru dipanggil setelah klik `Aktifkan kamera`
  dengan `facingMode: user`. Tidak ada input file/galeri dan Supervisor/Admin tidak
  memuat dialog kamera.
- Frame disalin dari video langsung ke canvas, dibatasi maksimal 1.600 px pada sisi
  terpanjang, lalu dienkode sebagai JPEG. Kualitas dan resolusi diturunkan berulang
  hingga ukuran paling banyak 200 KiB; jika batas tidak tercapai, foto tidak tersedia.
- Semua track dihentikan segera setelah frame disalin, juga saat mulai ulang, dialog
  ditutup, atau komponen dilepas. Preview memakai object URL sementara; URL lama
  dicabut saat ambil ulang dan URL terakhir dicabut saat penutupan/unmount.
- Foto/blob hanya disimpan di state/memori komponen. Tidak ada upload, storage,
  offline queue, GPS, liveness, watermark, waktu browser resmi, atau finalisasi
  absensi. UI selalu menjelaskan bahwa absensi belum dikirim/dicatat.
- Tes FE-005 berjalan sebagai unit/component-render tests dengan dependency yang telah
  tersedia. Belum ada browser/camera live QA; izin kamera dan perangkat fisik belum
  diuji pada matriks browser/perangkat.

## Keputusan FE-007 — capture lokasi eksplisit tanpa geofence client

- `LocationCaptureController` hanya memanggil `getCurrentPosition` dari metode `start()`;
  `useLocationCapture` tidak meminta izin di render atau effect. FE-008 harus memanggil
  `captureLocation()` langsung dari aksi Masuk/Pulang yang dipilih pengguna. Dashboard,
  history, dan aksi `Foto sementara` tidak memulai GPS.
- Capture memakai `enableHighAccuracy: true`, `maximumAge: 0`, dan satu jendela monotonic
  maksimal 60 detik dari aksi eksplisit. Setiap permintaan browser dibatasi 10 detik;
  timeout, posisi tidak tersedia, dan akurasi di atas batas toko dicoba ulang setelah
  jeda teknis 1 detik. Izin ditolak tidak diulang otomatis. Deadline lokal tetap
  membatasi total waktu walau browser terlambat memanggil callback.
- Koordinat dan akurasi hanya hidup di snapshot memory untuk diserahkan oleh integrasi
  FE-008; tidak ada localStorage, IndexedDB, log, API call, atau persisten. Cancel/reset/
  unmount menghapus snapshot dan mengabaikan callback yang datang terlambat.
- Client memvalidasi rentang fisik dan finite value saja. Retry untuk akurasi hanya
  memakai batas toko dari konfigurasi server bila tersedia; tidak ada ambang hard-coded,
  perhitungan jarak/radius, atau penetapan status `Valid` di browser. UI hasil capture
  hanya menampilkan akurasi perangkat dan menunggu validasi server, serta menjelaskan
  bahwa belum ada absensi yang dikirim/disimpan.
- FE-007 belum menyambungkan capture ke dashboard/submit; tombol Masuk/Pulang dan
  pengiriman absensi tetap menunggu FE-008. Test unit/component tidak menggantikan uji
  permission/GPS perangkat nyata pada INT-008.

## Keputusan BE-012A — Shift, penugasan, dan hari libur

- Task ini mengimplementasikan kalender dan shift berdasarkan penugasan per karyawan.
  Pengelompokan karyawan belum diimplementasikan karena PRD menyebut grup, tetapi
  skema awal belum mendefinisikan entitas atau aturan keanggotaannya; pemilik produk
  perlu memilih definisi grup sebelum perubahan model data.
- Hari kerja shift wajib eksplisit, unik, dan memakai ISO 1–7 (Senin–Minggu); minimal
  satu hari harus dipilih. Jam shift adalah waktu lokal/wall-clock WIB; jam selesai
  yang lebih kecil dari jam mulai berarti melewati tengah malam, sedangkan nilai yang
  sama ditolak. `breakMinutes` dan `lateToleranceMinutes` adalah integer non-negatif.
- Batas `effectiveFrom` dan `effectiveTo` inklusif. Penugasan untuk karyawan yang sama
  tidak boleh tumpang tindih pada toko yang sama, atau antara cakupan global dan toko.
  Penugasan pada dua toko spesifik berbeda boleh tumpang tindih; resolver memilih
  cakupan global ditambah cakupan toko yang diminta dan mengembalikan konflik jika
  lebih dari satu penugasan efektif.
- Penugasan shift khusus toko hanya bisa dibuat untuk toko aktif yang sudah menjadi
  keanggotaan karyawan. Penugasan baru tidak memakai shift nonaktif. Pembuatan dan
  perubahan cakupan/tanggal dikunci transaksional per karyawan agar pemeriksaan overlap
  tidak berlomba pada request paralel.
- Penonaktifan shift ditolak jika ada penugasan yang masih berlaku mulai tanggal bisnis
  WIB saat ini atau sesudahnya. Aturan shift (jam, istirahat, toleransi, hari kerja)
  tidak dapat diubah setelah dipakai attendance; buat shift baru. Relasi attendance
  historis juga mencegah perubahan penugasan yang mengeluarkan tanggal absensi dari
  cakupannya. Penonaktifan assignment menyimpan `effectiveTo` inklusif dan diaudit.
- Hari libur nasional memakai `storeId = null`; hari libur toko memakai toko tertentu.
  Resolver menggabungkan keduanya. Unik nasional sudah dijaga partial unique index
  PostgreSQL pada migrasi awal, sedangkan unik toko dijaga constraint komposit.
  Pembuatan, perubahan, dan penghapusan diaudit; perlindungan tanggal tertutup menunggu
  task penutupan rekap BE-026 dan tidak diasumsikan dalam BE-012A.
- Migrasi `0004_schedule_work_days_required` menghapus default `[]` yang bertentangan
  dengan constraint hari kerja 1–7 pada migrasi awal; constraint validasi yang ada
  tetap diberlakukan.

## Keputusan BE-013 — kontrak create attendance attempt

- Hanya principal `UserRole.EMPLOYEE` dengan employee ID dan device binding server-side
  berstatus `APPROVED` yang dapat mengirim attempt. Tidak ada `deviceId` dari client;
  actor, binding ID, dan device hash berasal dari authenticated session/database dan
  diverifikasi ulang di transaksi saat insert.
- Payload strict dan maksimal 300 KiB. Field identity/server-owned/final (`employeeId`,
  `serverTime`, `distanceMeters`, geofence result, status, dan `deviceId`) ditolak.
  `storeId` opsional hanya merupakan selection hint tak tepercaya yang divalidasi oleh
  BE-014 terhadap assignment aktif. Timestamp client tetap disimpan sebagai waktu yang
  dilaporkan, sedangkan `receivedAt` dibuat database/server-side.
- Idempotensi memakai unique key PostgreSQL `(employee_id, idempotency_key)`. Lookup
  awal bukan lock; pada pelanggaran unique repository membaca winner yang sudah commit
  dan mengembalikan replay hanya jika employee, binding, dan fingerprint payload cocok.
  Record attempt serta audit minimal ditulis dalam satu transaksi, sehingga duplicate
  tidak membuat audit/record kedua.
- Tiga nilai lokasi yang dilaporkan client disimpan di `attendance_attempts`, tetapi
  tidak masuk audit atau response. Receipt tetap tidak menyatakan lokasi benar dan
  bukan status attendance.
- Selfie reference disimpan hanya sebagai hash; verifier BE-015 memastikan intent aktif,
  object private, byte signature/MIME/ukuran, employee, dan binding cocok. Fresh attempt
  menyalin bukti ke key privat yang tidak dapat ditimpa URL client dan mengonsumsi intent
  tepat satu kali dalam transaksi penyimpanan attempt. Receipt `RECEIVED` bukan final
  attendance. `proofCode` hanya boleh kosong atau `null` sampai BE-019 menyediakan generator.
- Tidak ada live PostgreSQL race/migration test tanpa `DATABASE_URL`; unit/repository
  test menguji race winner dan pemetaan unique error. Migration tetap harus diverifikasi
  dengan Prisma validate/generate dan ditinjau terhadap schema.

## Keputusan BE-014 — geofence server-side

- Jarak dihitung server-side memakai great-circle Haversine dengan mean Earth radius
  IUGG (`6,371,008.8 m`) dan disimpan 6 desimal. Validitas geofence hanya berarti jarak
  tidak melebihi radius toko dan akurasi yang dilaporkan tidak melebihi batas toko;
  kolom jarak `DECIMAL(14,6)` dapat menyimpan hingga jarak antipodal maksimum Bumi;
  hasil ini bukan status absensi final.
- Store diambil hanya dari relasi `EmployeeStore` aktif dan `Store.isActive`. Jika
  hanya ada satu, server memilih otomatis. Bila ada beberapa, `storeId` opsional dari
  client dipakai semata sebagai hint dan harus cocok dengan assignment; tanpa hint,
  attempt tetap dicatat dengan `STORE_SELECTION_REQUIRED`. Hint yang tidak ditugaskan
  tidak disimpan sebagai relasi dan menghasilkan `STORE_NOT_ASSIGNED`. Tidak ada store
  aktif menghasilkan `NO_ACTIVE_ASSIGNED_STORE`.
- Attempt menyimpan store terpilih, distance, radius dan batas akurasi snapshot, hasil
  geofence, serta flag exact repeated-coordinate. Hasil tetap berada di record attempt;
  tidak membuat atau mengesahkan record `Attendance`. Lokasi tidak masuk audit/response.
- Pemeriksaan exact repeated-coordinate dibatasi ke employee yang sama dan memakai
  equality pada koordinat 6 desimal yang disimpan; employee row dilock dalam transaksi
  sehingga dua attempt bersamaan tidak melewatkan flag tersebut. Ini hanya flag untuk
  review, bukan penolakan atau bukti spoofing.
- Browser PWA tidak menyediakan indikator mock-location yang dapat dipercaya. PRD juga
  belum menentukan ambang perpindahan/kecepatan tidak wajar. Deteksi mock dan impossible
  jump tetap terbuka dan tidak boleh disimulasikan sebagai lolos/gagal sampai pemilik
  proyek memilih sumber sinyal dan aturan bisnisnya.

## Keputusan FE-014A/B — layar Admin lokasi toko

- `/admin/stores` tetap di bawah route guard Admin. Halaman membaca store, employee, dan
  assignment dari API; tidak memakai fixture/fake count dan tidak menganggap data browser
  sebagai otoritas. API server tetap memeriksa role untuk setiap request.
- Field dan validasi frontend mengikuti kontrak BE-011: koordinat dalam rentang bumi
  maksimal enam desimal, radius/batas akurasi integer positif, dan Wi-Fi hanya satu literal
  IPv4/IPv6. Nilai awal radius 10 m dan akurasi 30 m berasal dari default schema yang telah
  ada, bukan keputusan UI baru. UI tidak menampilkan verdict geofence.
- Nonaktifkan memakai endpoint `deactivate` setelah konfirmasi; UI tidak menyediakan delete
  permanen atau reaktivasi karena API tidak mendukungnya. Assignment karyawan dapat berlaku
  pada lebih dari satu toko; penambahan baru dibatasi pada toko aktif dan employee aktif.
  Penghapusan assignment perlu konfirmasi dan status setelah mutasi dimuat kembali dari server.
- Nama/alamat/koordinat/radius/akurasi/IP hanya tampil di area route Admin. Endpoint yang
  menolak akses ditampilkan sebagai error aman; detail internal response tidak ditampilkan.

## Keputusan FE-014C — layar Admin profil karyawan

- `/admin/employees` menggunakan API admin employee yang sudah ada dan tetap berada di
  bawah role guard Admin. Halaman hanya mengelola NIK, nama, jabatan, serta tanggal mulai;
  akun login, password, role, dan device binding tetap merupakan fitur terpisah.
- Buat profil memakai status default server/schema. UI menampilkan status aktif/tidak aktif,
  menyediakan edit profil dan penonaktifan dengan konfirmasi, tetapi tidak menyediakan hard
  delete atau reaktivasi. Perubahan status umum melalui `PATCH` tidak ditawarkan sampai
  kebijakan reaktivasi disepakati.
- Pencarian hanya memfilter daftar yang sudah dimuat di browser dan tidak mengubah cakupan
  data server. Error NIK duplikat dan error server ditampilkan melalui pesan allowlist yang
  aman; data sampel tidak dipakai.

## Keputusan FE-014D — layar Admin akun dan persetujuan perangkat

- `/admin/accounts` menampilkan akun publik dan daftar binding berstatus pending dari
  endpoint Admin. Token/hash perangkat dan password lama tidak tersedia di DTO dan tidak
  boleh diminta atau direkonstruksi oleh frontend.
- Password create yang dihasilkan server ditampilkan sekali di dialog sementara React; tutup
  dialog menghapus state. Reset menerima password sementara dari Admin, mengirimkannya hanya
  ke endpoint reset, lalu mengosongkan input setelah sukses. Tidak ada password di localStorage,
  sessionStorage, URL, atau log. Policy input mengikuti batas endpoint; frontend tidak menambah
  aturan kompleksitas yang belum disepakati.
- Ubah role/status/tautan profil dan nonaktifkan akun perlu konfirmasi. Minimal dua Admin aktif
  ditegakkan server-side; UI tidak menghitung batas dari snapshot daftar yang dapat stale.
  Approval perangkat memperingatkan bahwa binding approved lama dapat dicabut otomatis; revoke
  hanya dapat dilakukan setelah konfirmasi dan hasil pending dimuat ulang dari server.
- Tautan karyawan mencegah pemilihan profil yang sudah tertaut ke akun lain; race atau konflik
  tetap diselesaikan oleh API. Pembuatan profil karyawan tidak otomatis membuat akun.

## Keputusan FE-014E — katalog shift Admin

- Katalog memakai menu dan route Admin yang sudah ada, `/admin/schedules` (label navigasi
  `Jadwal & shift`); tidak menambahkan route/menu `/admin/shifts`. Role guard langsung tetap
  berasal dari konfigurasi route Admin, sementara request tetap menuju `/api/v1/admin/shifts`.
- Halaman hanya membuat, membaca, mengubah field katalog, dan menonaktifkan shift. Create
  mengikuti default aktif server; edit tidak mengirim `isActive`. Nonaktifkan memakai endpoint
  khusus setelah konfirmasi; tidak ada hard delete atau kontrol reaktivasi.
- Hari kerja ditampilkan sebagai ISO Senin=1 sampai Minggu=7. Form mengikuti batas kontrak
  server untuk waktu, integer menit non-negatif, dan minimal satu hari unik; tidak menambahkan
  aturan shift malam/lembur, assignment, hari libur, kelompok, atau variasi per hari. Semua
  data berasal dari API dan pesan error tidak menampilkan response mentah.

## Keputusan FE-014F — penugasan shift per karyawan

- Assignment diintegrasikan sebagai section pada halaman dan route Admin yang sudah ada,
  `/admin/schedules`; tidak menambahkan route atau menu baru. Semua mutasi hanya tersedia di
  halaman Admin yang sama dan tetap dilindungi role guard.
- Daftar, create, edit, dan penetapan tanggal akhir memakai kontrak
  `/api/v1/admin/shift-assignments`. Referensi employee, store, keanggotaan employee-store,
  dan shift berasal dari API Admin yang tersedia. Form create hanya menawarkan employee aktif,
  shift aktif, dan store aktif yang telah ditugaskan ke employee; server tetap otoritatif.
- `storeId = null` ditampilkan sebagai global/seluruh toko. Tanggal berlaku inklusif; tanggal
  mulai wajib diisi dan tanggal akhir opsional. UI tidak mengisi tanggal dari jam browser.
  Mengakhiri assignment meminta tanggal eksplisit dan memakai endpoint deactivation, bukan
  delete. Data historis tetap ditampilkan.
- Edit mengirim PATCH hanya untuk field yang berubah dan tidak mengirim PATCH kosong. UI tidak
  menghitung/simulasikan konflik overlap; konflik, histori attendance, dan validasi final
  ditentukan server lalu ditampilkan memakai pesan aman dari allowlist.
- Tidak ada assignment grup atau override toleransi per employee karena kontrak/schema belum
  mendukungnya. Jadwal/assignment tidak dipakai untuk menyimpulkan status attendance.
- Batas scope frontend: UI memfilter employee aktif, tetapi implementasi repository create saat
  ini baru memeriksa keberadaan employee dan belum memvalidasi status aktif. Request langsung
  ke API masih dapat melewati filter itu; jangan menganggapnya enforcement server. Perbaikan
  validasi backend dicatat sebagai blocker terpisah dan tidak diubah dalam task frontend ini.

## Keputusan FE-014G — kalender hari libur Admin

- Kalender hari libur adalah section di halaman dan route Admin `/admin/schedules`; tidak ada
  route/menu baru dan katalog shift maupun assignment tetap berjalan seperti sebelumnya.
- Daftar menggunakan `/api/v1/admin/holidays`; filter semua scope menghilangkan `storeId`, filter
  nasional mengirim `storeId=national`, dan filter toko mengirim UUID. Pilihan toko dibaca dari
  Admin API dan mencakup seluruh toko yang dikembalikan server, termasuk yang tidak aktif;
  status toko ditampilkan sebagai informasi, bukan larangan client-side.
- Create/edit mengirim `storeId: null` untuk nasional atau UUID toko. Admin harus memilih tanggal
  dan cakupan secara eksplisit; form tanggal dan pemilih bulan kalender tidak memiliki nilai
  bawaan dari waktu/browser. Tidak ada impor atau tebakan hari libur nasional otomatis.
- CRUD mengikuti status HTTP dan DTO kontrak. Delete memerlukan konfirmasi; validasi cakupan,
  keunikan per scope/tanggal, konflik, dan hasil final tetap otoritatif di server. Error hanya
  ditampilkan melalui pesan aman allowlist; loading, kosong, error/retry, dan mutasi memiliki
  state UI tersendiri.
- Kalender hanya menampilkan catatan hari libur dan tidak menginferensikan hari kerja atau
  mengubah status attendance. Proteksi tanggal closing bulanan belum tersedia pada BE-012 dan
  menunggu BE-026; UI tidak mengunci tanggal atau menjanjikan perlindungan tersebut.

## Keputusan BE-015 — private selfie upload, access, watermark metadata, dan retensi

- Provider tidak dipilih; adapter memakai AWS SDK S3 generik dengan endpoint opsional.
  Storage kosong membuat selfie upload/verification/read gagal tertutup dengan 503.
  Bucket wajib private dan public-access blocking diaktifkan oleh operator; presigned URL
  bukan pengganti bucket policy. Bucket versioning/Object Lock wajib nonaktif karena worker
  menghapus current object key dan tidak menghapus versi lama. Browser storage CORS harus
  hanya mengizinkan origin aplikasi, PUT, dan header `Content-Type` serta
  `x-amz-meta-referencehash`.
- Intent memakai UUID acak yang hanya dipulangkan sekali ke client; database menyimpan
  SHA-256 reference, owner, device binding, tipe, ukuran deklarasi, expiry, dan key acak.
  Signed PUT berlaku 30–300 detik (default 120), tidak menetapkan ACL public, dan staging
  object yang tak dipakai dihapus oleh retention worker setelah intent kedaluwarsa.
- Saat submit attendance, server membaca object, memeriksa metadata/hash, ukuran aktual
  maksimum 200 KiB, MIME deklarasi, signature gambar, serta dimensi positif. Bytes valid
  ditulis ke key accepted privat yang telah dicadangkan server memakai conditional
  `If-None-Match: *`; client tidak pernah mendapat signed URL ke key accepted. Pengikatan
  intent, metadata watermark, dan attempt berjalan dalam satu transaksi; intent
  pending/expired/owner-device mismatch tidak dapat
  dikonsumsi. Signed staging URL yang tersisa tidak dapat mengubah salinan accepted.
- Metadata watermark yang disimpan adalah nama employee dari database, waktu receipt
  server, latitude/longitude atau label lokasi unavailable. AUD-09 menambahkan derivative JPEG
  privat melalui Sharp; original accepted tidak diubah, read URL hanya menunjuk derivative,
  dan `watermarkApplied` baru true setelah rendering, object write, serta transaksi status sukses.
  Worker retention juga melakukan backfill derivative untuk selfie terlampir yang belum
  di-watermark sebelum menghapus foto kedaluwarsa. Ini tetap bukan hasil liveness verification.
  MIME dan signature tidak membuktikan secara kriptografis bahwa sumber foto adalah stream
  kamera; frontend wajib tetap hanya menyediakan camera capture, bukan file picker.
- Signed GET pada route legacy Admin tetap hanya tersedia untuk Admin melalui
  `GET /api/v1/admin/attendance-attempts/:attemptId/selfie-url`, berlangsung selama TTL yang
  sama, dan hanya untuk evidence yang belum melewati retention. Akses review Supervisor
  disediakan terpisah melalui route BE-017 yang memeriksa assignment toko di server.
- `SELFIE_RETENTION_MONTHS` default 12 dihitung sejak server menerima attempt. Worker
  `pnpm --filter @absen/api retention:run` menghapus foto accepted yang kedaluwarsa, staging
  copy setelah attach, serta staging/sealed orphan ketika intent kedaluwarsa; key dihapus
  dari metadata sambil mempertahankan attendance dan watermark. Delete object diulang aman
  bila proses crash setelah penghapusan sebelum update database. Sebelum menghapus orphan,
  worker mengklaim intent expired di database dan transaksi attach mensyaratkan claim kosong,
  sehingga purge tidak dapat berlomba menghapus object dari attempt yang sedang dibuat.
  Scheduler produksi belum dipilih; deployment wajib memasang jadwal harian dan
  memantau exit code non-zero sebelum fitur dinyatakan siap produksi.
- Implementasi lokal AUD-09 belum membuktikan migration/database race pada PostgreSQL disposable
  atau perilaku object storage provider nyata. Docker image PostgreSQL tidak berhasil selesai
  dipersiapkan pada sesi audit; tidak ada database proyek atau provider yang disentuh.

## Keputusan BE-016 — aturan check-in/check-out

- Business date berasal dari `receivedAt` server dalam `Asia/Jakarta`; `clientRecordedAt`
  hanya disimpan sebagai waktu yang dilaporkan perangkat. Assignment shift harus tunggal,
  aktif untuk work date, hari tersebut harus hari kerja, dan store hint tetap divalidasi
  terhadap assignment/geofence server.
- Raw attempt dan audit receipt tetap disimpan walau aturan shift menolak request. Penolakan
  disimpan sebagai `RULE_REJECTED` dengan kode stabil, membuat audit alasan, dan tidak membuat
  baris `Attendance`. Bila aturan lolos, `Attendance`, selfie, dan location proof dibuat
  atomik dan attendance dimulai pada `PENDING_VERIFICATION`; BE-016 tidak menyetujui atau
  menolak attendance final.
- Satu check-in aktif non-`REJECTED` (termasuk `PENDING_VERIFICATION`/`PENDING_OFFLINE`)
  memblokir check-in berikutnya untuk tanggal kerja itu. Ini mencegah dua baris provisional
  yang sama-sama dapat disetujui kemudian. Lock row employee menserialisasi pemeriksaan ini
  terhadap attempt lain yang melalui repository API. Record `REJECTED` tidak memblokir attempt
  baru; unique idempotency tetap menjaga retry request yang sama.
- Check-out mensyaratkan check-in aktif yang belum ditolak, shift assignment dan work date
  sama, serta server receipt setelah waktu check-in. Check-in `PENDING_VERIFICATION` dianggap
  event provisional yang dapat dipasangkan dengan checkout, bukan dianggap telah valid atau
  disetujui. Jika pemilik bisnis menghendaki checkout menunggu approval, aturan ini harus
  dikonfirmasi dan diubah sebelum produksi.
- Shift malam dapat di-check-out sampai waktu pulang terjadwal pada hari kalender berikutnya;
  setelah batas itu API meminta koreksi dan tidak menutup shift lama otomatis. Toleransi telat
  diterapkan ke waktu server. Pulang cepat memperhitungkan izin disetujui. Hasil timing dicatat
  dalam audit metadata; ringkasan akhir-hari `Tidak absen pulang` dan agregasi lateness masih
  menunggu task report/verification terkait.
- Attendance yang lolos BE-016 mulai berstatus `PENDING_VERIFICATION` dan menunggu workflow
  BE-017 untuk diputuskan; BE-016 tidak menyetujui atau menolak otomatis. Karena database lokal
  belum dikonfigurasi, migrasi BE-015–BE-017 tervalidasi lewat Prisma tetapi belum diterapkan.

## Keputusan BE-017 — verification workflow dan Supervisor store scope

- Scope Supervisor berasal hanya dari `SupervisorStoreAssignment` (pasangan akun Supervisor
  dan toko), yang dapat dikelola Admin lewat `/api/v1/admin/supervisor-store-assignments`.
  Tidak ada tanggal efektif/status tambahan. `EmployeeStore.assignedByUserAccountId` dan input
  client tidak dipakai sebagai otoritas scope. Semua queue/detail/decision/history/selfie query
  menerapkan assignment di database; relasi store yang null tidak cocok dengan filter `is` dan
  karena itu tidak dapat diakses Supervisor.
- Queue/detail menyertakan waktu server asli dan waktu device, ringkasan employee/store,
  method/network, nama perangkat secukupnya, lokasi/accuracy/distance, signed URL selfie private,
  history attendance sebelumnya, serta `dueAt` dan `overdue` yang dihitung dari waktu server.
  URL bersifat sementara/no-store; route review selfie memeriksa lagi status pending dan scope
  assignment pada query sebelum meminta signed URL storage.
- Decision hanya menerima `PENDING_VERIFICATION` dan memakai conditional update dalam transaksi
  serializable. Status, metadata reviewer, audit, serta notification internal commit atomik;
  konflik/replay tidak menghasilkan audit atau notification tambahan. Reason wajib untuk reject.
  Keputusan tidak menyentuh `serverTime`, `deviceTime`, atau waktu attendance asli.
- Audit tidak menyimpan lokasi, IP/hash perangkat, foto, URL/key selfie, atau secret. Notification
  ditujukan hanya ke `Employee.accountId` jika tersedia; jika null, keputusan tetap disimpan dan
  diaudit, tetapi notification dilewati tanpa fallback ke akun reviewer dan tanpa mencatat data
  pribadi sebagai pengganti.
- SLA 24 jam hanya menurunkan `dueAt` dan indikator `overdue`; tidak ada perubahan status/waktu
  otomatis. Migrasi hanya divalidasi lewat Prisma pada environment ini dan belum diterapkan ke DB.

## Keputusan implementasi AUD-05 — attempt tanpa GPS fix

- Request absensi menerima `location: null` hanya bersama failure reason terbatas:
  `PERMISSION_DENIED`, `POSITION_UNAVAILABLE`, atau `TIMEOUT`. Failure reason adalah
  laporan client yang tidak dipercaya sebagai verdict dan tidak dapat menentukan status
  kehadiran.
- Koordinat, akurasi, snapshot geofence, dan relasi store tetap `NULL` bila tidak ada fix;
  sistem tidak mengisi `0,0`. Selfie tetap melewati intent private, diperiksa owner/device,
  disegel, lalu ditautkan ke `AttendanceAttempt` dengan idempotency/fingerprint yang sama
  seperti attempt biasa.
- Attempt no-fix berhenti sebagai `RECEIVED`; `Attendance` dan `LocationProof` tidak dibuat
  karena tidak ada bukti lokasi. Receipt tidak mengandung `attendanceId` atau
  `validationStatus`. Guard daily-status mengenali attempt `RECEIVED` pada jendela shift agar
  sinkronisasi GPS gagal tidak otomatis membuat `ABSENT`.
- Batas workflow: halaman/endpoint verifikasi yang ada membaca `Attendance`, bukan raw
  `AttendanceAttempt`. Karena itu selfie no-fix sudah tersegel dan terikat pada receipt, tetapi
  belum muncul sebagai item review yang dapat diputuskan Admin/Supervisor. Receipt tidak boleh
  dipresentasikan sebagai `PENDING_VERIFICATION` pada domain Attendance; jalur review attempt
  no-fix tetap pekerjaan terpisah.
- Fix yang ada tetapi akurasinya buruk tetap disimpan apa adanya dan dinilai server melalui
  geofence; ia bukan alasan untuk menghilangkan koordinat terbaik. Status final `VALID` tetap
  memerlukan seluruh gate server yang sudah ada.
- Tidak ada perubahan pada upload kamera langsung, owner scope, atau replay: attempt yang
  sama hanya direplay bila actor, binding device, idempotency key, dan fingerprint cocok.
- Verifikasi lokal AUD-05: API terkait 105 tes dan web terkait 25 tes lulus; Prisma
  memvalidasi schema; seluruh 13 migrasi diterapkan pada PostgreSQL 17 disposable. Regression
  PostgreSQL membuktikan attempt/selfie no-fix tersimpan, replay tetap owner-scoped, tidak ada
  `Attendance`/`LocationProof`/`SelfieCapture`, dan daily-status mengembalikan `blocked` alih-alih
  membuat `ABSENT`. Ini bukan pengujian provider object-storage atau browser/perangkat produksi.

## Keputusan implementasi BE-018 — offline sync

- Endpoint yang sama menerima antrean offline setelah perangkat kembali tersambung. Selfie tetap
  harus dikirim melalui intent private yang ada sebelum submit attempt; endpoint tidak menerima
  foto mentah. Session, role Employee, binding device yang disetujui, kepemilikan intent, dan
  idempotency key tetap diperiksa seperti request online.
- `AttendanceAttempt.receivedAt` dari database adalah server receipt time otoritatif. Server
  membandingkannya dengan `clientRecordedAt` tanpa mengganti salah satu timestamp. Drift absolut
  `> 5 menit` atau interval receipt-minus-device `> 24 jam` mengharuskan
  `PENDING_VERIFICATION`. Tepat 24 jam belum melewati ambang umur, tetapi tetap memerlukan review
  karena drift absolutnya melampaui 5 menit; kedua kondisi memang memakai aturan OR dari PRD.
- Belum ada verifier liveness server-side: flag liveness yang dikirim client bukan bukti tepercaya
  dan `SelfieCapture` offline tetap menyimpan `faceDetected=false` serta `livenessPassed=false`.
  Karena itu, untuk saat ini semua Attendance offline tetap `PENDING_VERIFICATION`, termasuk saat
  klaim client menyatakan pass. Jangan aktifkan jalur offline `VALID` sebelum ada bukti liveness
  yang diverifikasi server.
- Syarat lain untuk dapat dipertimbangkan bagi jalur `VALID` adalah waktu dalam ambang, metode
  laporan `GPS`/`OFFLINE`, geofence `WITHIN_LIMITS`, tidak ada repeated coordinate, dan seluruh
  aturan bisnis existing lulus. Kegagalan geofence atau repeated coordinate tetap menjadi raw
  attempt dengan Attendance `PENDING_VERIFICATION` untuk review; kegagalan aturan shift/check-in/out
  tetap mempertahankan raw attempt sebagai `RULE_REJECTED` sesuai kontrak existing.
- Semua Attendance offline memakai enum terpusat `ValidationMethod.OFFLINE` dan
  `NetworkStatus.OFFLINE`; `AttendanceAttempt.reportedMethod` tetap menyimpan metode yang dilaporkan
  untuk audit. `Attendance.serverTime` tetap database receipt; `deviceTime` serta waktu capture
  selfie/lokasi mempertahankan timestamp perangkat. Tidak ada route edit/delete bagi Employee dan
  tidak ada status enum baru.
- Pada implementasi saat keputusan ini ditulis, business date/shift masih ditentukan berdasarkan
  WIB dari server receipt (`row.receivedAt`), dan belum memenuhi klarifikasi produk AUD-06 di bawah.
  Jangan menganggap perilaku existing tersebut sebagai keputusan final untuk antrean D→D+1.
- Implementasi dan unit/repository/route tests BE-018 tersedia lokal dengan gate liveness fail-closed.
  Pada checkpoint awal BE-018, PostgreSQL integration belum dijalankan. AUD-05 kemudian menjalankan
  regression PostgreSQL disposable untuk no-fix receipt/ABSENT, tetapi cakupan itu tidak membuktikan
  matriks lengkap BE-018/AUD-06. Offline auto-`VALID` tetap tertahan sampai server dapat
  memverifikasi liveness.

## Keputusan produk AUD-06 — kandidat tanggal capture offline

- Dikonfirmasi pengguna pada 2026-10-15: bila absensi offline ditangkap pada tanggal D lalu baru
  tersinkron pada D+1, tanggal capture menjadi **kandidat tanggal kerja** dan wajib ditinjau; tanggal
  capture tidak langsung menjadi `workDate` final.
- `AttendanceAttempt.receivedAt`/`Attendance.serverTime` tetap waktu receipt server resmi dan tidak
  boleh ditimpa oleh waktu perangkat. `clientRecordedAt` tetap evidence yang tidak tepercaya; ia
  boleh membantu reviewer mengevaluasi kandidat, tetapi tidak menjadi otoritas waktu atau dasar
  tunggal status `VALID`.
- Sebelum reviewer berwenang menyelesaikan atribusi, jangan merekonsiliasi kandidat ke daily
  attendance sebagai hasil final. Seluruh absensi offline tetap `PENDING_VERIFICATION`; flag
  liveness dari client tidak membuka status `VALID`.
- Belum diputuskan apakah kandidat dengan tanggal tidak masuk akal atau tanpa shift/assignment cocok
  harus tetap disimpan pada antrean review atau ditolak dan diarahkan ke pengajuan koreksi. Jangan
  mengunci behavior implementasi untuk kasus tersebut sebelum keputusan produk tersedia.
- Implementasi saat ini memakai tanggal WIB receipt dan jalur review yang ada hanya menampilkan
  `Attendance`, bukan raw `AttendanceAttempt` tanpa Attendance. Maka penerapan keputusan ini
  membutuhkan jalur review raw attempt atau desain proses setara; keputusan tersebut bukan klaim
  bahwa fitur review itu sudah tersedia.

## Keputusan implementasi BE-024 — dashboard, metrik waktu, dan notifications

- Tanggal default dashboard dihitung dari waktu server dalam `Asia/Jakarta`; validasi startup
  memastikan `TIMEZONE` hanya dapat bernilai tersebut. Employee tidak dapat memilih tanggal atau identitas sendiri. Filter
  tanggal eksplisit divalidasi sebagai kalender `YYYY-MM-DD`, bukan diparse sebagai instant.
- Trend/ranking saat ini menggunakan window 30 tanggal kalender inklusif yang berakhir pada tanggal
  dashboard yang diminta; tanggal masa depan ditolak berdasarkan tanggal bisnis server agar
  jadwal yang belum berjalan tidak dihitung sebagai belum check-in. Ranking provisional
  memprioritaskan jumlah shift terlambat; total
  `minutesAfterScheduledStart` menjadi tie-break sebelum nama/ID. `lateDays` ditampilkan tetapi
  bukan kunci urut pertama. PRD tidak menetapkan tie-break; kontrak implementasi ini terdokumentasi
  agar dapat diubah secara eksplisit. Keputusan produk masih diperlukan apakah ranking seharusnya
  mengutamakan total menit net setelah toleransi alih-alih frekuensi shift terlambat.
- Klasifikasi terlambat berasal dari `isLate` pada audit attendance dan memakai toleransi shift.
  Nilai audit `minutesAfterScheduledStart` adalah durasi sejak jadwal mulai, sehingga termasuk
  grace/tolerance. API tidak menyebutnya “menit telat” atau mengurangi toleransi; output memakai
  `minutesAfterScheduledStart` dan `totalMinutesAfterScheduledStart`.
- Dashboard hanya menganggap absent jika row `DailyAttendanceStatus` berstatus `ABSENT` telah
  dibuat oleh job. Job existing memakai cutoff akhir shift + dua jam (termasuk akhir shift malam
  pada hari kalender berikutnya). Sebelum cutoff belum ada row absent; jika job belum berjalan
  setelah cutoff, dashboard tetap menampilkan `NOT_CHECKED_IN`, bukan menginfer status berdasarkan
  jam. Scheduler harus dijalankan/dimonitor. Job menghitung cutoff pada WIB (+07:00), konsisten
  dengan `TIMEZONE` yang dibatasi ke `Asia/Jakarta` saat startup.
- Cakupan Supervisor diambil dari `SupervisorStoreAssignment` berdasarkan akun session; store/shift
  filter tambahan di-AND-kan dengan assignment. Employee dashboard memakai pasangan akun-Employee
  serta pagination pada query history/request. `historyFrom`/`historyTo` adalah batas kalender
  inklusif pada `Attendance.workDate`, divalidasi sebagai kalender tanpa konversi instant/timezone;
  masing-masing boleh sendiri, dan hanya rentang terbalik yang ditolak. Filter history tidak
  mengubah status hari ini atau daftar request. Jam mulai/akhir shift pada status Employee berasal
  dari `WorkShift` sebagai `HH:mm:ss` wall-clock, sehingga nilai akhir shift malam tetap dapat lebih
  kecil daripada nilai mulai. Notification list/read dibatasi `userAccountId`
  session; unread count dihitung per akun dan mark-read idempotent. GET menggunakan no-store.
- Proyeksi status per shift bersama mengklasifikasikan check-in `VALID`/`APPROVED` tanpa check-out
  `VALID`/`APPROVED` sebagai `MISSING_CHECKOUT` (PRD §7: “Ada masuk tanpa pulang”). Holiday dan
  attendance pending tetap mendahului cabang tersebut (`HOLIDAY`, lalu `WAITING_VERIFICATION`);
  checkout valid/disetujui mempertahankan klasifikasi `PRESENT`/`LATE`. Ini tidak menambah field
  `DashboardSummary`. Regresi repository hanya memeriksa bentuk SQL lewat mock Prisma; PostgreSQL
  live dan hasil eksekusi query belum diverifikasi.
- Notification event request baru, request decision, dan attendance pending verifikasi adalah
  event internal dalam transaksi sumbernya. Event approval/rejection verifikasi BE-017 yang telah
  ada tidak dibuat ulang atau dipindah; tetap ditujukan ke Employee tertaut dalam transaksi
  keputusan. Tidak ada notification provider eksternal.
- Schema tidak memiliki entitlement/accrual/ledger cuti. Field saldo cuti sengaja tidak dikirim,
  bukan `0` atau tebakan. FR-35 saldo/sisa cuti tetap PARTIAL sampai pemilik produk menentukan
  sumber kuota, periode, aturan akrual, carry-over, serta dampak request pending/approved/rejected.
- Repository diuji dengan mock query terparameterisasi, namun PostgreSQL belum tersedia pada
  workspace (belum ada `DATABASE_URL`/service DB yang dapat diuji). Kinerja normal, pemakaian
  index aktual, dan query plan `EXPLAIN (ANALYZE, BUFFERS)` belum terbukti; harus diverifikasi
  terhadap dataset realistis sebelum rilis.

## Keputusan implementasi FE-011 — tampilan data Employee

- Tiga halaman memakai `GET /api/v1/me/dashboard` dengan scope pemilik dari cookie session server. Browser tidak mengirim identitas employee, tanggal dashboard, atau store scope. Filter `historyFrom`/`historyTo` hanya mengubah query riwayat; perubahan filter mereset pagination ke halaman pertama dan hasil request sebelumnya tidak boleh menimpa filter baru.
- Tanggal `workDate` dan rentang pengajuan ditampilkan sebagai date-only tanpa pergeseran timezone. `serverTime` yang merupakan instant ditampilkan dalam WIB. Status validation pada riwayat selalu memakai enum/status dari server; `PENDING_OFFLINE` dan `PENDING_VERIFICATION` memiliki keterangan berbeda dan tidak disimpulkan ulang di client.
- Jadwal menampilkan hanya `today[]`, bukan jadwal masa depan. Jam `HH:mm:ss` tidak dikonversi menjadi instant; bila `end < start`, UI menyatakan selesai pada hari kalender berikutnya dari tanggal kerja yang disediakan server. Status jadwal memiliki presentasi lengkap untuk seluruh enum dashboard BE-024; tidak menggunakan cast ke enum status harian yang lebih sempit.
- UI riwayat tidak merender GPS, selfie/foto, evidence, atau data orang lain. Ringkasan request di halaman cuti dibatasi lima request terbaru dan hanya memuat jenis, rentang tanggal, serta status; alasan/lampiran tetap di halaman pengajuan FE-012.
- Saldo cuti tidak tersedia pada schema/API BE-024. FE-011 tidak menampilkan saldo `0` maupun estimasi. Saldo tetap PARTIAL sampai keputusan produk menetapkan sumber kuota/ledger, periode, accrual, carry-over, dan perlakuan request pending/approved/rejected. UI menautkan employee ke `/employee/requests` untuk pengajuan dan pemeriksaan status.
- Verifikasi lokal FE-011: 48 web test files/255 tests, web typecheck, production build/performance budget, workspace lint, Prettier check file berubah, dan `git diff --check` lulus. Build masih memberi warning chunk JavaScript >500 kB, tetapi initial asset budget lulus. Pemeriksaan otomatis lokal tidak menggantikan browser/device smoke test atau integrasi PostgreSQL live; keduanya tetap gate sebelum menyatakan rilis tervalidasi penuh.

## Keputusan implementasi FE-015 — dashboard Admin

- Dashboard memakai route role Admin yang telah terdaftar, tepat `/admin`; route-policy yang sama tetap menolak akses direct Employee dan Supervisor. Tidak ada perubahan pada navigasi atau halaman master data.
- Query memakai `GET /api/v1/dashboard`, sesi cookie, `credentials: include`, dan `cache: no-store`. Date dikirim hanya bila pengguna memilih tanggal kalender `YYYY-MM-DD`; filter kosong berarti tanggal bisnis server dan UI menyebutnya “Hari ini (tanggal server)”. Client tidak mengisi tanggal dari jam browser atau mengonversi date-only ke instant. Tanggal pilihan masa depan/invalid menghasilkan safe error dan tetap memungkinkan perubahan filter.
- Client hanya menerima key query `date`, `storeId`, `shiftId`, `page`, `pageSize`; store/shift harus UUID, response DTO dan status enum harus cocok tepat dengan kontrak, trend harus berisi 30 tanggal berurutan berakhir pada tanggal query (jika dipilih), dan page/pageSize response harus sesuai request/default. Timestamp harus memuat kalender, jam, dan zona yang valid.
- `notCheckedIn` response mencakup status `NOT_CHECKED_IN` dan `ABSENT`; keduanya diberi label masing-masing dari nilai API. Ringkasan juga mengikuti nilai API. UI tidak mengubah belum check-in menjadi tidak hadir berdasarkan waktu.
- Store dan shift dimuat dari client master data yang tersedia, tanpa polling berulang; pilihan nonaktif tidak disaring dan dilabeli “(nonaktif)” agar data historis tetap dapat difilter. Filter kosong tidak dikirim. Perubahan date/store/shift mengembalikan page daftar ke 1.
- Poll dashboard setiap 60 detik hanya jika document terlihat; interval dijaga agar tidak overlap selama request query saat ini masih berjalan. Menjadi visible memicu refresh yang sama, tombol manual refresh tersedia, dan query change/unmount membersihkan interval/listener serta membatalkan fetch dengan AbortController.
- Grafik tren dibangun tanpa dependency chart, memberi angka tekstual melalui detail 30 tanggal. Ranking ditampilkan sesuai urutan API (jumlah shift terlambat lalu total elapsed dari jadwal mulai); teks menggunakan istilah “menit sejak jadwal mulai, termasuk toleransi” dan tidak mengklaim menit bersih setelah grace. `lateDays` adalah angka tampilan, bukan penentu urutan.
- Dashboard tidak menambah keputusan produk terkait ranking, toleransi, absent, atau timezone; kontrak BE-024 tetap menjadi sumber kebenaran. Verifikasi lokal terbaru FE-015: 51 web test files/274 tests dan 46 API test files/392 tests lulus; workspace typecheck, production build/performance budget, lint, Prettier check, dan `git diff --check` lulus. Build memberi warning chunk JS 578,32 kB (>500 kB), tetapi initial asset budget lulus pada 648.702/665.600 byte raw dan 168.504/184.320 byte gzip. Verifikasi ini tidak membuktikan browser/perangkat nyata atau PostgreSQL/query plan.

## Keputusan implementasi FE-014 — Admin master data

- FE-014 tetap PARTIAL. UI yang ada memakai route/API Admin yang sudah terdaftar untuk profil karyawan, akun dan device binding, toko/assignment karyawan, katalog shift/assignment per karyawan, dan hari libur. Tidak menambah route atau endpoint frontend baru.
- Perubahan lokasi yang dapat mengubah evaluasi absensi berikutnya (latitude/longitude, radius, batas akurasi, IP Wi-Fi) harus dikonfirmasi sebelum endpoint PATCH dipanggil. Ringkasan konfirmasi hanya memuat label field, bukan nilai; batal tidak mengirim request, sukses hanya menerima DTO dari server, dan error mempertahankan modal/record lama untuk retry. Konfirmasi UI tidak menggantikan validasi server dan tidak mengirim field tambahan.
- Aksi akun/device serta deaktivasi/pencabutan/penghapusan yang sudah tersedia tetap menggunakan konfirmasi yang ada. PRD belum mengklasifikasikan seluruh edit non-destruktif shift/assignment/hari libur sebagai sensitif atau tidak; konfirmasi tambahan ditunda sampai kriteria itu ditetapkan, bukan ditebak.
- FE-014 tidak membuat UI konfigurasi SLA, retention, validation alternatives, maupun form pengelolaan gangguan sistem; form/list gangguan Admin kemudian ditambahkan pada FE-017 sesuai API BE-023. Mass correction tetap menunggu keputusan produk. Tidak membuat input `reason` atau override pada mutasi master data FE-014 karena route tersebut tidak menerima alasan.
- Tes FE-014 memeriksa route guard, kontrak API, validasi form, dan model konfirmasi perubahan pengaturan lokasi (request hanya setelah persetujuan; pada kegagalan record lama tidak berubah dan safe error tetap tersedia). Verifikasi lokal pada turn ini: 51 web test files/274 tests dan web typecheck lulus; Prettier serta `git diff --check` lulus. Production build/performance budget, workspace lint, browser/device smoke test, dan integrasi database live belum dijalankan pada checkpoint ini.

## Keputusan implementasi BE-023 — pencatatan gangguan sistem

- API Admin `POST/GET /api/v1/admin/system-disruptions` menggunakan `SystemDisruption` dan constraint schema/migration existing; tidak memerlukan migration. `storeId: null` berarti scope global; nilai UUID berarti satu toko yang harus ada. Pembuat/status aktif ditetapkan server, timestamp wajib ISO dengan zona, `endsAt` strictly setelah `startsAt`, dan reason wajib setelah trim.
- `GET` mencakup semua scope saat tanpa filter; filter `storeId` adalah equality untuk toko tersebut, tidak menggabungkan global. Hasil stabil diurut `startsAt DESC, id DESC` dengan page size maksimum 50. API route ini tidak mengubah atau menghapus record.
- Record gangguan boleh overlap dan tidak dideduplikasi karena schema tidak memiliki exclusion constraint/unique identity untuk interval; masing-masing record tetap tersimpan/audited. POST tidak idempotent karena schema/kontrak tidak menyediakan durable idempotency key. Retry dapat membuat record dan event audit baru. Menambah dedupe berbasis interval/reason tidak dipilih karena itu akan mengarang identitas bisnis.
- Daily ABSENT guard tetap memakai rentang setengah-terbuka (`starts_at < shift_end && ends_at > shift_start`); batas yang hanya bersentuhan tidak memblokir. Guard hanya menghindari insert ABSENT baru; pembuatan gangguan tidak memodifikasi status daily yang telah tersimpan, attendance raw, atau status PRESENT/LATE.
- Route menambahkan `system_disruption.create` melalui `AuditService` append-only setelah repository create. Keterbatasan pola ini: kedua write belum satu transaksi; kegagalan penyimpanan audit setelah record tersimpan perlu ditangani sebagai operational risk sampai audit transaction boundary bersama tersedia. Audit tests mengonfirmasi aktor, scope, waktu, reason, dan request ID.
- Mass correction tetap blocker bisnis, bukan endpoint/side effect: PRD belum menyebut row/status target, mapping, record PRESENT/LATE/ABSENT yang boleh dikoreksi, period/closing constraints, atau retry identity. Tidak ada bulk update, enum change, attendance mutation, status remapping, atau audit batch yang dibuat. BE-023 tetap PARTIAL.

## Keputusan implementasi BE-007A — Admin audit-log read API

- Route aktif `GET /api/v1/admin/audit-logs`, hanya menerima query filter `actorUserAccountId`, `action`, `entityType`, `entityId`, `from`, `to`, `page`, dan `pageSize`. Zod strict query schema menolak key tak dikenal, tipe/range salah, timestamp tanpa zona atau tanggal kalender tidak valid; filter kemudian diteruskan ke normalizer `AuditService.list` yang juga memvalidasi format/domain dan rentang waktu.
- Actor berasal dari sesi cookie/server-side yang diverifikasi; tidak ada role dari request body. `AuditService` menolak Supervisor/Employee sebelum repository `findMany`. Response `Cache-Control: no-store`, default rate limit 30/menit (mengikuti `sensitiveRateLimit` bila tersedia), page <= 10.000, pageSize <= 100, urutan `occurredAt DESC, id DESC`, serta pagination `{items,page,pageSize,hasNextPage}`.
- DTO membangun ulang allowlist field PRD: `id`, `actorUserAccountId`, `occurredAt`, `clientIp`, `deviceIdHash`, `action`, `entityType`, `entityId`, `beforeData`, `afterData`, `reason`, `requestId`. Route hanya GET; POST/PUT/PATCH/DELETE tidak terdaftar dan menghasilkan 404 Problem Details.
- Verifikasi route menggunakan `AuditService` asli dan fake in-memory `AuditLogRepository`; tidak menjalankan Prisma/PostgreSQL live. Suite terfokus `pnpm --filter @absen/api test test/modules/audit.test.ts test/routes/audit-logs.test.ts` lulus (2 file/13 tes). Full `pnpm check` lulus: API 51 file/431 tes, web 62 file/355 tes; format, lint, typecheck, dan build turut lulus. `git diff --check` exit 0. OpenAPI memuat 50 path/67 operasi setelah route ini ditambahkan. Verifikasi tidak mencakup PostgreSQL live atau UI frontend.

## Keputusan implementasi BE-007B — audit-event coverage untuk workflow aktif

- PRD section 8 dan acceptance terkait dibandingkan dengan route/service aktif sebelum perubahan. Seluruh kelompok aksi yang saat ini tersedia sudah memiliki panggilan audit; tidak ditemukan aksi wajib aktif yang sama sekali belum memanggil audit. Perubahan implementasi produksi dibatasi pada ketepatan snapshot `auth.password.reset`: repository sebelumnya mengembalikan akun sesudah reset, sehingga service keliru memakai state sesudah sebagai `before`.
- `PrismaAuthRepository.resetPassword` kini mengunci row `user_accounts` dengan `SELECT ... FOR UPDATE` (pola yang telah dipakai `rotatePassword`), mengambil `before`, melakukan reset dan pencabutan session di transaksi yang sama, lalu mengembalikan `{ before, after }`. `AuthService` tetap memakai action `auth.password.reset` dan bentuk before/after yang sama; nilai before kini benar-benar pre-update. Tidak ada perubahan schema, respons route, password/session behavior, authorization, atau data kredensial yang dimasukkan ke audit.

| Acceptance PRD / aksi aktif                                   | Source dan event/action yang dipanggil                                                                                                                                       | Test path dan bukti                                                                                                                                                                                            |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login sukses/gagal, logout, perubahan/reset password          | `apps/api/src/modules/auth/service.ts`: `auth.login.success`, `auth.login.failure`, `auth.logout`, `auth.password.change`, `auth.password.reset`                             | `apps/api/test/modules/auth-service.test.ts` menegaskan action/actor/entity/outcome; `apps/api/test/modules/auth-prisma-repository.test.ts` menegaskan pre-image dan post-image di satu transaksi ber-row-lock |
| Akun dan hak akses: create, perubahan role/status, deactivate | `apps/api/src/modules/account/index.ts`: `account.create`, `account.update`, `account.deactivate`                                                                            | `apps/api/test/modules/account.test.ts` membuktikan role change sebagai `account.update`, status dan deactivation snapshots                                                                                    |
| Karyawan: create, update, deactivate                          | `apps/api/src/modules/employee/index.ts`: `employee.create`, `employee.update`, `employee.deactivate`                                                                        | `apps/api/test/modules/employee.test.ts` membuktikan action dan status before/after                                                                                                                            |
| Device binding: enroll, approve, revoke/reactivate            | `apps/api/src/modules/device-binding/index.ts`: `device_binding.enrolled`, `device_binding.approved`, `device_binding.revoked`, `device_binding.reactivated`                 | `apps/api/test/modules/device-binding.test.ts` dan `apps/api/test/modules/device-binding-admin.test.ts`; tes memeriksa token/hash rahasia tidak ikut tersimpan                                                 |
| Toko/radius dan employee-store assignment                     | `apps/api/src/modules/store/index.ts`: `store.create`, `store.update`, `store.deactivate`, `store.employee_assigned`, `store.employee_unassigned`                            | `apps/api/test/modules/store.test.ts` membuktikan radius before/after, no-op, assignment, dan unassignment                                                                                                     |
| Supervisor-store assignment                                   | `apps/api/src/modules/supervisor-store-assignment/prisma-repository.ts`: `supervisor.store.assign`, `supervisor.store.unassign`                                              | `apps/api/test/modules/supervisor-store-assignment.test.ts` membuktikan assignment dan penghapusan atomik bersama event audit                                                                                  |
| Shift, assignment shift, dan hari libur                       | `apps/api/src/modules/schedule/index.ts`: `schedule.shift.create/update/deactivate`, `schedule.assignment.create/update/deactivate`, `schedule.holiday.create/update/delete` | `apps/api/test/modules/schedule.test.ts` membuktikan seluruh action tersebut dan before/after untuk update/deactivation                                                                                        |
| Attendance attempt, rule rejection, dan attendance record     | `apps/api/src/modules/attendance/prisma-repository.ts`: `attendance.attempt.create`, `attendance.attempt.rule_rejected`, `attendance.record.create`                          | `apps/api/test/modules/attendance-attempt-prisma-repository.test.ts` membuktikan urutan action, transaksi attempt+audit, dan tidak memasukkan koordinat mentah/selfie reference                                |
| Persetujuan/penolakan verifikasi attendance                   | `apps/api/src/modules/attendance/prisma-verification-repository.ts`: `attendance.verification.approve`, `attendance.verification.reject`                                     | `apps/api/test/modules/attendance-verification-prisma-repository.test.ts` membuktikan actor, status transition, reason, request ID, dan tidak memasukkan bukti lokasi/selfie                                   |
| Pembuatan dan keputusan pengajuan yang didukung               | `apps/api/src/modules/attendance-requests/prisma-repository.ts`: `attendance_request.create`, `attendance_request.approve`, `attendance_request.reject`                      | `apps/api/test/modules/attendance-requests-prisma-repository.test.ts` membuktikan action, actor, transition, reason, serta tidak mengaudit object key privat                                                   |
| Gangguan sistem                                               | `apps/api/src/modules/system-disruption/index.ts`: `system_disruption.create`                                                                                                | `apps/api/test/modules/system-disruption.test.ts` membuktikan actor, scope, waktu, reason, dan request ID                                                                                                      |

- Invariant umum diuji pada `apps/api/test/modules/audit.test.ts`: actor/action/entity, snapshots, reason, client IP, device hash, timestamp dari persistence, dan penyaringan key sensitif (termasuk password/token/GPS/selfie). `apps/api/test/routes/audit-logs.test.ts` membuktikan endpoint hanya read-only. Pengujian database live untuk trigger append-only PostgreSQL dan transaksi repository tidak dilakukan.
- Verifikasi task: subset audit/reset 11 file / 116 tes lulus; full `pnpm check` lulus (format, lint, typecheck, API 52 file / 436 tes, web 66 file / 370 tes, kedua production build). Tidak ada PostgreSQL/provider live, Docker, atau deployment.
- Tetap **PARTIAL**. Tidak tersedia route/workflow correction (termasuk mass correction), export, monthly closing, ataupun override yang dapat diaudit; `CORRECTION` juga tidak termasuk request type yang diterima service saat ini. Tidak menambahkan event, route, status, atau workflow tebakan. Penyelesaian membutuhkan task fitur/kebijakan terkait.

## Keputusan implementasi FE-017 — notifikasi dan gangguan sistem

- Notifikasi menggunakan halaman reusable pada path persis `/employee/notifications`, `/supervisor/notifications`, dan `/admin/notifications`. Path/menu terdaftar di `ROLE_NAVIGATION`, sehingga route guard existing tetap menjadi sumber kebenaran akses; frontend tidak membuat aturan role paralel. UI menggunakan `GET /api/v1/notifications` untuk filter ALL/READ/UNREAD, pagination dan `unreadCount`, serta `PATCH /api/v1/notifications/:notificationId/read` untuk mark-read milik akun aktif. Client memvalidasi DTO/enum/timestamp/query secara ketat dan memakai session cookie, `no-store`, abort, serta state loading/error/empty.
- Form dan riwayat gangguan hanya untuk Admin pada `/admin/system-disruptions`, memakai `GET/POST /api/v1/admin/system-disruptions` dan store master-data yang ada. Pilihan global dikirim sebagai `storeId: null`; riwayat mengikuti filter, pagination, dan `isActive` dari API. Jam `datetime-local` selalu ditafsirkan sebagai Asia/Jakarta lalu diserialisasi eksplisit dengan offset `+07:00`, tidak memakai timezone browser.
- Sebelum POST wajib ada konfirmasi; model membatasi satu request in-flight. Penolakan HTTP 4xx adalah hasil definitif, sedangkan network/status 0, HTTP 5xx, atau respons sukses yang tidak lolos validasi dianggap ambigu. Karena endpoint POST tidak idempotent dan daftar berpaginasi tanpa snapshot konsisten, hasil ambigu mengunci POST secara permanen pada UI. Tombol verifikasi membuka daftar semua scope mulai halaman 1 dan pagination tetap tersedia sebagai petunjuk pemeriksaan, bukan bukti record tidak tersimpan; UI tidak menyediakan cara untuk membuka kembali POST. Hasil yang masih tidak jelas harus direkonsiliasi manual oleh pengelola sistem.
- Pada checkpoint FE-017 sebelum FE-017A, status masih PARTIAL: UI filter audit belum dibuat meskipun API daftar audit tersedia. UI audit kemudian diselesaikan pada FE-017A; mass correction tetap belum dibuat karena target record/status, mapping, batas closing, dan dampak attendance belum didefinisikan. Tidak ada mutasi massal.
- `pnpm check` lulus: Prettier check, workspace lint, recursive typecheck, tests, dan production build. Web: 58 file/320 test; API: 50 file/424 test. Initial assets 652,169/665,600 byte raw dan 169,968/184,320 byte gzip, sehingga batas initial load lulus. Vite tetap memberi advisory satu JS chunk 581.78 kB (>500 kB); dua halaman FE-017 dibuat lazy-loaded agar tidak masuk initial bundle. `git diff --check` lulus. Pemeriksaan browser visual/device tidak dilakukan karena CUA/browser visual unavailable pada task sebelumnya; smoke test browser nyata tetap belum terbukti.

## Keputusan implementasi FE-017A — Admin audit-log read-only UI

- UI hanya terdaftar pada path persis `/admin/audit-logs` di `ROLE_NAVIGATION.ADMIN`, berlabel `Audit log`, dan dimuat lewat lazy import statically analyzable di `RolePage`. Guard existing tetap menjadi kontrol route; tidak ada akses Employee/Supervisor maupun otorisasi client paralel.
- Client terpisah memakai `GET /api/v1/admin/audit-logs`, session cookie, `cache: no-store`, `AbortSignal`, allowlist query, serta validasi exact keys dan tipe DTO, UUID versi/varian yang diterima backend, timestamp berzona waktu, pagination, dan object JSON. Filter `action`/`entityType` mengikuti batas 1–100 dan pola query API; response string tetap mengikuti schema DTO API yang tidak menetapkan pola/batas tersebut. Error UI memakai pesan aman design-system/`toUserErrorMessage` tanpa menampilkan detail server. Tidak ada operasi mutasi.
- Filter tanggal memakai `input type="date"`; awal tanggal diserialisasi sebagai `00:00:00.000+07:00` dan akhir sebagai `23:59:59.999+07:00`, sehingga kedua batas bersifat inklusif di Asia/Jakarta. UI menampilkan waktu dalam `Asia/Jakarta` dan JSON before/after sebagai teks `JSON.stringify` di elemen `<pre>` yang dapat dibuka/tutup.
- Tes web terfokus lulus: 4 file/14 tes, mencakup query/response client, no-store/error safety, filter/pagination/loading/error/empty/abort/stale response, route exact Admin-only/cross-role denial, dan rendering loading. Mass correction tetap blocker dan FE-017 tidak dinyatakan complete.
- Verifikasi checkpoint FE-017A: `pnpm check` lulus (Prettier, lint, typecheck, tests, production build); web 65 file/366 tes dan API 51 file/431 tes. Initial web assets 327,401/665,600 byte raw dan 100,159/184,320 byte gzip, keduanya di bawah budget. `git diff --check` exit 0. Browser visual dan database live tidak diuji.

## Keputusan implementasi INT-012A — route-level bundle splitting

- Seluruh page module yang dipilih oleh `RolePage` dimuat dengan `React.lazy` dan dynamic import yang statically analyzable. Login/onboarding, status publik, session/auth, app shell, serta `RequireRole` tetap berada pada eager entry. `RequireRole` masih menjadi parent route guard di `App`; page dan fallback hanya dirender setelah guard mengizinkan akses. Semua halaman memakai fallback design-system yang accessible (`role="status"`, `aria-live="polite"`).
- Tidak ada perubahan pada `ROLE_NAVIGATION`, path route, pemetaan role/page, fallback route `/admin/reports`, API, atau hak akses server. Regression tests membandingkan semua path terdaftar, men-stream setiap halaman pada route yang diizinkan, dan memverifikasi direct URL lintas-role tidak menghasilkan lazy fallback maupun isi halaman terlindungi.
- Full `pnpm check` lulus: web 59 file/323 test; API 50 file/424 test; format, lint, typecheck, dan build juga lulus. Entry JS produksi menjadi 302,970 bytes (302.97 kB minified; 94.91 kB gzip), dibanding baseline sebelum split 581.78 kB. Largest route page chunk `RoleHome`: 66.25 kB (17.81 kB gzip). Tidak ada Vite chunk warning di atas 500 kB; batas warning tidak diubah. Initial assets: 326,948/665,600 byte raw dan 100,029/184,320 byte gzip, dalam budget.
- INT-012 tetap PARTIAL: tes SSR dan ukuran artifact tidak membuktikan home <=3 detik atau alur absensi <=10 detik pada 4G. Browser runtime/visual/device, network shaping, dan workload PostgreSQL realistis tidak tersedia dan belum dinyatakan lulus.

## Keputusan implementasi FE-013A — unduh surat dokter oleh reviewer

- Detail pengajuan hanya menyediakan aksi untuk `requestType === 'SICK' && hasAttachment === true`. Klik pertama meminta `GET /api/v1/attendance/requests/:requestId/attachment-url` dengan sesi cookie dan `cache: no-store`; antrean dan render detail tidak meminta signed URL. Otorisasi scope tetap menjadi tanggung jawab server.
- Response harus tepat `{ url, expiresAt }`. URL divalidasi memakai kebijakan validator signed-selfie yang sudah ada: HTTPS, HTTP hanya untuk loopback development, dan tidak boleh memuat userinfo. UI tidak menampilkan object key atau URL sebagai teks dan tidak merender lampiran inline.
- Setelah klik pertama sukses, UI menampilkan tautan unduh sementara yang tetap memerlukan klik kedua. Tautan memakai `target="_blank"`, `rel="noreferrer noopener"`, serta `referrerPolicy="no-referrer"`; kontrak server menetapkan disposition download. URL berada hanya pada memori komponen selama TTL, dihapus saat expiry, pergantian request, atau unmount. Error dapat dicoba ulang secara manual; tidak ada auto-retry dan request ganda ditahan.
- Verifikasi lokal FE-013A: `pnpm check` lulus (API 50 file/424 test, web 59 file/329 test, format, lint, typecheck, dan kedua build); initial assets web 326.948/665.600 byte raw dan 100.025/184.320 byte gzip. `git diff --check` lulus. Ini menyelesaikan alur frontend lokal saja. Private bucket policy, provider ACL/enkripsi, retention/penghapusan, serta perilaku browser/perangkat nyata belum diverifikasi; tidak ada security/provider sign-off dan status keseluruhan FE-013 tetap PARTIAL.
- INT-006A adds 14 mounted React DOM regression tests in `apps/web/test/request-review-attachment.dom.test.tsx`, using direct `happy-dom@20.11.2` devDependency, React `act`, synthetic URL data, and deterministic expiry timers. They exercise clicks, loading, duplicate suppression, error/manual retry, link safety, expiry, request reset, and abort. The existing SSR/reducer tests remain intact.
- Full `pnpm check` after INT-006A passed: web 60 files/343 tests; API 50 files/425 tests; format, lint, typecheck, and both builds. happy-dom is a virtual DOM only; this does not establish browser navigation, actual storage URL access/expiry, device behavior, or E2E coverage. FE-013 remains PARTIAL, with no provider/security sign-off.

## Keputusan implementasi INT-006B — empty-state setelah POST gangguan ambigu

- Empty-state normal `Belum ada gangguan tercatat` tidak berubah. Hanya kondisi `submissionOutcomeUncertain && status === 'ready' && items.length === 0` memakai teks netral bahwa hasil daftar yang dimuat kosong, tetapi itu bukan bukti POST gagal atau record tidak tersimpan. Warning dan penguncian POST yang sudah ada tetap utuh; tidak ada klaim record tidak ada atau ajakan mengulang POST.
- `apps/web/test/system-disruptions.dom.test.tsx` menambah dua mounted test dengan React `createRoot`/`act`, mock API/store deterministik, dan shim `showModal`/`close` yang dipulihkan setelah test. Tes meliputi state kosong normal, POST tidak terjadi saat mount/preview, konfirmasi sebelum satu POST, kegagalan network status 0, review kosong, serta penguncian yang menolak submit ulang. Tidak ada jaringan nyata.
- Focused test lulus 2/2; `pnpm check` lulus dengan web 61 file/345 tes dan API 50 file/425 tes, termasuk format, lint, typecheck, dan production build.
- Bukti terbatas pada happy-dom virtual DOM; bukan browser nyata atau E2E. Tidak ada perubahan API/backend, schema, route, atau business rule.

## Keputusan implementasi INT-006C — mounted role-guard direct-route regression

- `apps/web/test/role-route-guard.dom.test.tsx` uses React `createRoot`/`act`, `MemoryRouter`, `Routes`, the real `RequireRole` exported by `App.tsx`, a mocked `useSession` hook, and the actual `/access-denied` route element with `AccessDeniedPage`. Representative paths for Admin, Supervisor, and Employee are validated against `ROLE_NAVIGATION`; protected children are synthetic markers.
- Ten mounted tests cover each role accessing its own registered path, all six cross-role direct URLs ending at `/access-denied` without a protected marker or either loading fallback, and a loading session remaining on the loading state. `LocationProbe` observes the router pathname after redirects; `fetch` is stubbed and asserted not to run. Existing SSR all-routes and static cross-role tests remain intact.
- Evidence is limited to happy-dom virtual DOM and `MemoryRouter`. It does not prove real address-bar/browser navigation, device or session integration, or browser-to-API E2E. No route table, access policy, app code, API, or business rule was changed; INT-006 remains PARTIAL.

## Keputusan implementasi INT-006D — mounted application route-table/navigation regression

- `apps/web/test/app-routing.dom.test.tsx` mounts the real `App` and `BrowserRouter`, using the production `ROLE_NAVIGATION` map and a controlled authenticated-session fixture. It opens every registered navigation target for the matching role, checks redirects and absence of protected navigation links for cross-role direct URLs, and checks the three canonical `/` landing routes. The audit found no production path/role mismatch; coverage now spans the composed route table rather than only isolated policy/guard harnesses.
- The focused route suite passed 4 files / 24 tests. Independent `pnpm check` passed formatting, lint, API/web typecheck, API 52 files / 454 tests, web 68 files / 378 tests, and both production builds.
- `happy-dom`, mocked session, and stubbed fetch do not prove real browser/server deep-link behavior, backend authorization, PostgreSQL, or device behavior. No production route, access policy, API, or business rule changed; INT-006 and INT-007 remain PARTIAL.

## Keputusan implementasi INT-006E — mounted first-login and onboarding flow

- `apps/web/test/auth-onboarding-flow.dom.test.tsx` mounts the actual `App` and uses a deterministic `fetch` fixture to drive an unauthenticated employee URL through login, server-defined consent, first password change, refreshed authenticated session, and the canonical Admin landing route. Tests also cover consent/password onboarding and unavailable-session direct-route denial, no consent POST before checkbox acceptance, exact policy version/body, no work-area API access while blocked, credentialed no-store auth requests, clearing password inputs, and no password/token in browser local/session storage.
- Focused suite passed 1 file / 4 tests; independent web typecheck passed. This is happy-dom with a fake in-process server, not browser-to-production-API/PostgreSQL E2E. No production code or routing behavior changed; FE-003 real-browser usability and INT-006/INT-007 remain PARTIAL.

## Keputusan verifikasi DEP-001B — local HTTP startup and SPA routing smoke

- Starting `pnpm dev:all` inside the restricted sandbox failed before the API listened because Node `os.userInfo()` returned `uv_os_get_passwd / ENOMEM`. A temporary escalation was used only to run localhost servers and HTTP requests; the task's own API/Vite session was stopped afterward. Existing listeners on ports `5173` and `5174` were not stopped; Vite selected `5175`.
- The three role deep links `/employee/history`, `/supervisor/requests`, and `/admin/reports` returned HTML 200 with the application root. Vite's proxied `/api/v1/health` returned JSON 200. `/api/v1/auth/me` returned 404 because this run had no `DATABASE_URL` and `server.ts` intentionally omits auth routes when Prisma is absent. Do not interpret the latter as a path mismatch or as successful unauthenticated-session behavior; a configured PostgreSQL run must verify the expected 401/login flow.
- DEP-001 remains PARTIAL until local PostgreSQL/Compose setup, migration, seed, database-backed auth, and the remaining setup steps are verified. These HTTP checks are not browser/device testing or browser-to-database E2E.

## Keputusan implementasi INT-009A — regresi authorization Supervisor pada route Admin-only

- PRD role matrix §3 membatasi data karyawan, akun, dan master toko ke Admin; PRD keamanan §8 mewajibkan pemeriksaan akses server-side. Perubahan task ini hanya menambah regression tests pada `employees.test.ts`, `accounts.test.ts`, dan `stores.test.ts`; tidak ada perubahan route, path, policy, schema, atau production code karena seluruh percobaan Supervisor ditolak.
- Employee route tests memakai `AuthenticatedSession` Supervisor fixture dan payload/ID valid; mutasi menyertakan Origin yang diizinkan. List, detail, create, update, dan deactivate masing-masing harus berakhir 403/`FORBIDDEN` sebelum EmployeeService dipanggil.
- Account route tests memperoleh sesi cookie Supervisor melalui AuthService dan device-binding fixture dengan binding disetujui. List/detail, create Admin, update role/status, dan deactivate harus ditolak sebelum AccountService/repository; row, hash tersimpan, dan audit tetap.
- Store route tests memperoleh sesi cookie dari auth fixture sebagai Supervisor. List/detail, create, update koordinat/radius, deactivate, list assignment, assign, dan unassign ditolak sebelum StoreService; snapshot store/employee/assignment, input repository, dan audit tetap.
- Semua denial memeriksa `Cache-Control: no-store`, body `FORBIDDEN`, serta tidak adanya sentinel nama/NIK/password/hash/koordinat yang relevan. Suite terarah lulus 3 file / 23 tes. Full `pnpm check` lulus: API 52 file / 439 tes, web 66 file / 370 tes, format, lint, typecheck, dan kedua production build.
- Bukti adalah route-level hermetic: Employee memakai sesi request fixture; Account/Store memakai auth/session dan repository fake/in-memory. Ini bukan pengujian session/database production atau query PostgreSQL. INT-009 tetap PARTIAL sampai query authorization dan write-denial diverifikasi dengan PostgreSQL live; scope, IDOR lintas toko, race, dan backlog route yang belum tersedia tetap mengikuti TODO INT-009.

## Keputusan implementasi FE-009A — IndexedDB queue close/reopen regression

- `apps/web/test/offline-attendance-queue-indexeddb.test.ts` menginjeksi factory `fake-indexeddb` baru untuk setiap test ke kelas produksi `IndexedDbQueueStorage`; test tidak memakai `MemoryQueueStorage`. Factory yang sama dan `OFFLINE_QUEUE_DATABASE` yang sama dipakai saat reopen, dan database dihapus setelah storage ditutup untuk menjaga isolasi deterministik.
- Snapshot key/entry dibaca kembali dari IndexedDB. Test memastikan entry hanya berisi routing opaque, IV, dan ciphertext; employee UUID, koordinat, timestamp capture, serta sentinel byte foto tidak muncul plaintext. Key AES-GCM yang dibaca kembali tetap `extractable: false`. Queue owner lain tidak dapat memperoleh entry lewat `list` maupun `get`; setelah storage pertama ditutup, instance queue baru dapat mendekripsi pending payload dan menghasilkan byte foto yang identik.
- `fake-indexeddb@6.2.5` ditambahkan sebagai devDependency `@absen/web` setelah metadata registry dapat diakses. Tidak ada perubahan behavior produksi. Contract queue ini tidak menerima NIK; verifikasi identitas terbatas pada employee UUID yang diberikan dan ketiadaan field `nik` pada record.
- Bukti ini adalah regression test terhadap implementasi simulasi IndexedDB, bukan Chrome/Safari, reload/close browser sungguhan, perangkat nyata, atau verifikasi seluruh alur offline. FE-009 tetap PARTIAL sampai tes browser/device dan gate lain dalam TODO selesai.

## Keputusan implementasi INT-009B — Supervisor ditolak pada route jadwal Admin-only

- `apps/api/test/routes/schedule.test.ts` memakai sesi Supervisor yang diterbitkan oleh fixture auth; production route dan access policy tidak diubah karena seluruh route telah menolak role non-Admin.
- Lima belas request meliputi list/detail/create/update/deactivate shift; list/detail/create/update/deactivate shift assignment; dan list/detail/create/update/delete holiday. Path, query, Origin, serta payload mutasi sesuai schema route aktif agar denial menguji otorisasi.
- Setiap request memeriksa 403/`FORBIDDEN`, `Cache-Control: no-store`, tidak adanya sentinel, serta nol pemanggilan `ScheduleService`, repository, audit, atau mutasi.
- Bukti terarah: schedule route suite 1 file / 18 tes lulus; verifikasi independen workspace `pnpm check` lulus: API 52 file / 454 tes, web 67 file / 371 tes, format, lint, typecheck, dan build API/PWA.
- Fixture/Fastify injection dan repository fake hanya membuktikan boundary route; tidak membuktikan sesi/database production, PostgreSQL, scope assignment live, race, atau deployment. INT-009 tetap PARTIAL hingga gate yang belum tersedia pada TODO selesai.

## Keputusan implementasi FE-009B — lease sinkronisasi IndexedDB

- `apps/web/test/offline-attendance-queue-indexeddb.test.ts` menggunakan beberapa instance production `IndexedDbQueueStorage` pada factory `fake-indexeddb` yang sama; tidak memakai `MemoryQueueStorage` untuk assertion lease.
- Dua regression test membuktikan tepat satu pemenang pada concurrent acquisition, non-owner token tidak dapat release, owner token dapat release, serta expired lease dapat di-takeover tepat saat `expiresAt` dengan satu pemenang.
- Hasil terarah: 1 file / 3 tes (termasuk close/reopen FE-009A) lulus. Verifikasi independen akhir `pnpm check` lulus: API 52 file / 454 tes, web 67 file / 373 tes, format, lint, typecheck, dan kedua build. Fake IndexedDB menguji adapter/transaction contract, bukan browser nyata, cross-tab antar-browser, atau distributed lock; FE-009 tetap PARTIAL sampai device/browser gates selesai.

## Keputusan implementasi DEP-004B — patch dependency advisory transitif Prisma

- Tetap menggunakan Prisma `7.10.0`; tidak melakukan upgrade major/preview. Advisory `GHSA-ggr8-5vv4-36mx` menandai `deepmerge-ts` sebelum `8.0.0`, dan `GHSA-3f6p-5ww8-9rcr` menandai `mysql2` sebelum `3.22.0`. Root `pnpm-workspace.yaml` memberi temporary overrides `deepmerge-ts@7.1.5 -> 8.0.2` dan `mysql2@3.15.3 -> 3.24.4`; lockfile mencatat versi tujuan tersebut. Rujukan upstream: https://github.com/advisories/GHSA-ggr8-5vv4-36mx, https://github.com/advisories/GHSA-3f6p-5ww8-9rcr, https://github.com/prisma/orm/pull/30189, dan https://github.com/prisma/orm/pull/30314.
- Audit penuh yang disimpan di `docs/DEP-004B-pnpm-audit.json` melaporkan 0 advisory dari 751 dependency; audit independen `pnpm audit --audit-level=high` juga lulus. `pnpm --filter @absen/api db:validate` lulus. Pin bersifat sementara: tinjau/hapus hanya setelah rilis Prisma stabil memasok versi aman secara transitif, kemudian regenerasi lockfile dan ulangi audit.
- Satu web test exhaustive untuk lazy route timeout pada batas 5 detik; batas test itu dinaikkan khusus menjadi 15 detik, tanpa menghapus assertion. Parent mengulang `pnpm check` dan lulus: format, lint, typecheck, web 69 file / 382 tes, API 52 file / 454 tes, Prisma Client generation, kedua production build, serta asset budget 327.818/665.600 byte raw dan 100.303/184.320 byte gzip. Eksekusi workflow GitHub Actions tetap belum diverifikasi; tidak ada deployment.

## Keputusan verifikasi FE-009C — logout/unmount antrean offline

- Regression test baru `apps/web/test/offline-attendance-queue-logout.dom.test.tsx` memasang komponen produksi `EmployeeOfflineAttendanceQueue` dan menggunakan `IndexedDbQueueStorage` pada factory `fake-indexeddb` bersama, bukan `MemoryQueueStorage`.
- Tes pertama menunggu signed selfie upload yang sedang berjalan, melepas komponen, memastikan `AbortSignal` terpicu dan tidak ada request attendance attempt/receipt, lalu menutup dan membuka ulang antrean serta memverifikasi pending capture tetap dapat dibaca sebagai antrean milik employee yang sama. Snapshot raw yang tersimpan tetap tidak mengandung ID owner, waktu capture, koordinat, atau sentinel foto dalam plaintext.
- Tes kedua melakukan unmount owner awal dan mount owner berbeda; row lama tidak muncul dan tidak ada request jaringan. Focused suite lulus 1 file / 2 tes; bukti hanya mencakup happy-dom dan fake IndexedDB, bukan logout/restart browser/device nyata. Implementasi runtime tidak berubah.
- Parent verification sesudah FE-TEST-ROBUSTNESS-002: focused suites FE-009C 1 file / 2 tes dan route-table 1 file / 5 tes lulus; full `pnpm check` lulus format, lint, typecheck, web 70 file / 384 tes, API 52 file / 454 tes, Prisma generate, kedua production build, dan asset budget 327.818/665.600 byte raw serta 100.303/184.320 byte gzip. Batas bukti tetap happy-dom/fake IndexedDB, bukan browser/device nyata.

## Keputusan verifikasi FE-TEST-ROBUSTNESS-002 — exhaustive mounted route table

- `apps/web/test/app-routing.dom.test.tsx` memasang App nyata berulang untuk setiap route navigation langsung dan role yang diizinkan. Dalam workspace penuh, satu tes exhaustive melewati default Vitest 5 detik saat web/API suites berjalan serentak meskipun focused suite selesai dalam 2,37 detik.
- Timeout hanya dinaikkan untuk test tersebut menjadi 15 detik; assertion direct URL, seluruh route-role mapping, render page, redirect, dan access-denied tetap sama. Tidak ada perubahan pada production routing, guard, atau business logic.
- Focused route suite lulus 1 file / 5 tes dan verifikasi parent `pnpm check` lulus: web 70 file / 384 tes, API 52 file / 454 tes, build API/PWA serta asset budget. Ini tetap regression virtual-DOM, bukan browser-to-API E2E.

## Keputusan verifikasi BE-002A — fail-fast environment dan diagnostic tanpa secret

- `apps/api/test/config-env.test.ts` menambahkan test parameterized untuk `DATABASE_URL` yang wajib pada `staging`/`production`, `SESSION_SECRET` yang harus tersedia, panjang minimal, dan ragam karakter minimum pada kedua mode tersebut. Test tambahan memastikan `CONSENT_POLICY_VERSION` dan `CONSENT_POLICY_TEXT` harus berpasangan dan diagnostic konfigurasi tidak membocorkan sentinel nilai database password, session secret, origin credential, storage key, atau policy text.
- Tidak ada perubahan production config, default, atau requirement; hanya synthetic values dipakai. Focused suite lulus 1 file / 21 tes. Parent `pnpm check` lulus: API 52 file / 467 tes, web 70 file / 384 tes, format/lint/typecheck, Prisma Client generation, kedua production build, dan asset budget 327.818/665.600 byte raw serta 100.303/184.320 byte gzip.
- Ini adalah regresi lokal pada parser konfigurasi, bukan bukti secret/runtime telah dipasang atau environment staging/production tervalidasi. Tidak ada `.env` dibuat dan tidak ada deployment.

## Keputusan implementasi BE-002B — timezone bisnis hanya Asia/Jakarta

- Parser environment menerima default saat `TIMEZONE` tidak disetel/kosong dan menerima nilai
  eksplisit `Asia/Jakarta`; zona IANA valid lain ditolak saat startup. Diagnostic menyebut key dan
  aturan NFR-07 tanpa mengulang nilai konfigurasi.
- Alasannya, PRD NFR-07 mewajibkan seluruh kalkulasi menggunakan WIB, sementara job daily status
  dan SQL kalender memang tetap memakai `Asia/Jakarta`. Membatasi config mencegah deployment
  terlihat berhasil dengan timezone non-default yang hasil perhitungannya tidak konsisten.
- Kompatibilitas: deployment yang menetapkan `TIMEZONE` ke nilai selain `Asia/Jakarta` kini gagal
  saat startup dan harus mengubah config ke `Asia/Jakarta`; config kosong/tidak disetel tetap
  memakai default. Tidak ada migrasi, perubahan kalender/SQL/frontend, atau perubahan data.

## Keputusan implementasi INT-005A — PostgreSQL CI migration/readiness smoke

- `apps/api/test/postgres-smoke.ts` tetap merupakan script integrasi terpisah dari suite unit (`test:postgres`, bukan `*.test.ts`). Bagian readiness membuat Prisma Client PostgreSQL nyata dan memberi `createDatabaseReadinessProbe(prisma)` ke `buildApp`, lalu memeriksa `/api/v1/ready` (200, body generik saja, `Cache-Control: no-store`) dan `/api/v1/health` (200, body generik saja).
- Job `postgres-integration` di `.github/workflows/ci.yml` menggunakan service sementara `postgres:17.11-alpine3.24`, sama dengan `compose.yaml`, dummy username/password khusus container, health check, dan mapping `5432:5432` karena job berjalan langsung pada Ubuntu hosted runner. Job menghasilkan Prisma Client, menjalankan `db:migrate:deploy`, lalu `test:postgres`. Permission workflow tetap `contents: read`; tidak membutuhkan GitHub/repository secrets.
- **Batas bukti:** konfigurasi lokal dan script tersedia, tetapi PostgreSQL/GitHub Actions evidence masih pending. INT-005 tetap PARTIAL.

## Keputusan implementasi INT-005B — PostgreSQL-backed auth/session smoke

- `test:postgres` kini juga membangun `AuditService`/`PrismaAuditLogRepository`, `ConsentService`/`PrismaConsentRepository`, `PrismaAuthRepository`, `createArgon2AuthService`, `createPrismaClient`, dan `buildApp` yang nyata. Consent policy sengaja kosong sehingga login tetap menguji kontrak `consentRequired: true` tanpa menciptakan teks kebijakan legal.
- Sebelum fixture ditulis, script mewajibkan URL CI PostgreSQL yang persis dan memeriksa `current_database()` serta `current_user`; fixture menggunakan UUID/username acak dan Argon2. Smoke memeriksa login, cookie bertanda tangan, `/me`, satu session row, audit login/logout, pencabutan saat logout, dan penolakan cookie setelah logout.
- Migrasi membuat tabel audit append-only. `finally` mencabut setiap session fixture yang masih aktif dan menutup app/client. Akun synthetic serta audit auth dipertahankan sampai ephemeral database job dihancurkan: penghapusan akun memicu aksi FK `ON DELETE SET NULL` sebagai UPDATE pada `audit_logs`, yang ditolak trigger immutable. Trigger dan privilege database untuk mengubahnya tetap tidak tersentuh.
- **Batas bukti:** auth/session smoke telah dikonfigurasi secara lokal, tetapi tidak dijalankan tanpa database ephemeral terverifikasi; PostgreSQL dan GitHub Actions evidence masih pending. INT-005 tetap PARTIAL.

## Keputusan verifikasi INT-005C — PostgreSQL audit append-only trigger

- Smoke memeriksa katalog PostgreSQL sebelum probe: trigger `public.audit_logs_reject_update_delete` harus terdaftar, aktif (`O` atau `A`), terpasang pada `public.audit_logs`, memakai `public.reject_audit_log_mutation`, dan memiliki tipe `BEFORE ROW UPDATE OR DELETE` yang diharapkan. Koneksi probe juga memeriksa `current_database()` dan `current_user` terhadap nilai ephemeral CI yang diizinkan.
- Satu row audit sintetis login/logout dipilih sebagai target. UPDATE dan DELETE dicoba satu per satu dalam transaksi tersendiri; `ROLLBACK` selalu dicoba pada jalur sukses maupun gagal, dan kegagalan rollback menggagalkan smoke. Masing-masing operasi hanya dinyatakan lulus bila PostgreSQL mengembalikan SQLSTATE `55000` dan pesan spesifik operasi dari trigger. Seleksi semua kolom audit fixture sebelum/sesudah harus identik. Script tidak mengubah status trigger dan tidak mengubah atau menghapus audit row secara committed; tidak ada perintah `COMMIT` pada probe.
- **Batas bukti:** verifikasi ini baru dikonfigurasi dalam `test:postgres`; tidak dijalankan dengan database lokal. PostgreSQL live dan GitHub Actions evidence masih pending, sehingga INT-005 tetap PARTIAL.

## Keputusan verifikasi INT-005D — employee-scoped attendance idempotency

- Smoke memakai URL CI ephemeral dan koneksi PostgreSQL yang sama yang sudah lolos guard database/user. Dalam satu transaksi dibuat dua Employee, dua DeviceBinding, serta tiga AttendanceAttempt sintetis dengan UUID key idempotency yang sama: attempt pertama pada Employee A harus masuk, key yang sama pada Employee B harus masuk, dan pengulangan untuk Employee A harus ditolak oleh SQLSTATE `23505` dengan constraint `attendance_attempts_employee_idempotency_key`.
- Semua fixture DML berada dalam transaksi yang selalu di-`ROLLBACK`, termasuk ketika duplikat secara tak terduga diterima. Script mengharuskan command rollback terkonfirmasi dan memeriksa bahwa ID fixture tidak tersisa pada ketiga tabel. Kegagalan rollback/absence check menggagalkan smoke; tidak ada `COMMIT`, fixture fields maupun raw database errors yang dicetak. Pemeriksaan ini tidak mengubah route/service, schema, migrasi, trigger, atau aturan audit.
- **Batas bukti:** skenario kini terkonfigurasi pada `test:postgres`, tetapi tidak dijalankan dengan DB lokal. Bukti PostgreSQL live dan GitHub Actions masih pending; skenario ini memverifikasi constraint secara sequential, bukan race/concurrency. INT-005 tetap PARTIAL.

## Keputusan verifikasi INT-005E — PostgreSQL-backed concurrent login lockout

- Smoke memakai satu fixture ADMIN sintetis tambahan dengan username/UUID acak dan password Argon2; exact URL CI ephemeral serta identitas database dan user dari kedua koneksi tetap diperiksa sebelum ada fixture write. Lima `POST /api/v1/auth/login` dengan password salah dikirim bersamaan melalui Fastify/Prisma nyata memakai Origin yang diizinkan. Masing-masing wajib menghasilkan respons generik `401` dengan `Cache-Control: no-store`, tanpa `Set-Cookie` atau echo identifier/password. Batas default route 10 permintaan per 15 menit tidak diubah: bersama satu login lifecycle sebelumnya dan satu percobaan benar saat terkunci, total hanya tujuh login.
- Setelah lima respons selesai, row PostgreSQL harus menunjukkan `failedLoginAttempts = 5` dan `lockedUntil` masih di masa depan serta tidak melampaui durasi 15 menit pada `LOCK_DURATION_MS` di auth service. Harus ada lima event `auth.login.failure` dan nol session. Percobaan password yang benar saat terkunci wajib tetap menerima respons generik yang sama, tidak mengubah penghitung/waktu lock, menambah satu event failure, dan tidak membuat session.
- Tidak menghapus kedua akun sintetis maupun audit row append-only; `finally` hanya mencabut session yang terkait kedua UUID fixture dan menutup app/klien. Akun/audit fixture dipertahankan hingga disposable CI database dihancurkan. Tidak ada perubahan production auth, route, schema, migration, rate limit, dependency, atau workflow.
- **Batas bukti:** checks lokal aman dapat memvalidasi format, lint, typecheck, build, dan unit suite, tetapi tidak menjalankan PostgreSQL smoke. Database live dan GitHub Actions tetap belum diverifikasi; INT-005 tetap PARTIAL.

## Keputusan verifikasi INT-005F — PostgreSQL-backed expired-lock recovery

- Setelah seluruh assertion INT-005E, smoke mengubah hanya kolom `lockedUntil` milik fixture ADMIN sintetis kedua menjadi timestamp eksplisit 60 detik di masa lalu; assertion setup memastikan `failedLoginAttempts` masih lima. Guard exact `DATABASE_URL` dan identitas database serta user dari kedua koneksi tetap harus lolos sebelum fixture write.
- Correct-password login berikutnya tetap melewati Fastify, service auth, dan Prisma PostgreSQL nyata. Smoke mensyaratkan HTTP 200, `Cache-Control: no-store`, signed HttpOnly/SameSite cookie, bentuk response publik dengan key tepat dan tanpa echo password/token, `failedLoginAttempts = 0`, `lockedUntil = null`, serta tepat satu session aktif untuk fixture tersebut.
- Total delapan login request dalam smoke ini (satu lifecycle login utama, lima password salah, satu password benar saat lockout, satu recovery) tetap di bawah rate limit production default 10 per 15 menit; batas rate produksi tidak diubah. `finally` mencabut semua session aktif untuk kedua ID fixture yang persis, lalu menutup Fastify dan Prisma. Akun sintetis serta audit rows immutable tetap sampai database CI disposable dihancurkan; tidak ada penghapusan akun/audit, DDL/trigger changes, atau perubahan production auth, schema, migration, dependency, maupun workflow.
- **Batas bukti:** skenario recovery kini terkonfigurasi saja. Smoke tidak dijalankan lokal, tidak ada database lokal yang ditulis, dan GitHub Actions belum dipicu/diamati; PostgreSQL live/CI masih pending. INT-005 tetap PARTIAL.

## Keputusan verifikasi INT-005G — pure unit test untuk guard URL PostgreSQL smoke

- `assertEphemeralDatabaseUrl` dipindahkan tanpa mengubah allowlist atau perilakunya dari `postgres-smoke.ts` ke helper test-only `apps/api/test/postgres-smoke-guard.ts`. Script smoke tetap memanggil guard sebelum `runPostgresSmoke`; kedua pemeriksaan identitas database/user pada koneksi Prisma dan koneksi probe tidak diubah.
- `apps/api/test/postgres-smoke-guard.test.ts` hanya mengimpor helper murni. Tes menerima URL CI yang persis dan menolak nilai kosong/malformed, host atau IP berbeda, user/password, port, database, schema, query tambahan/duplikat, fragment, encoding URL, dan whitespace akhir. Seluruh kasus penolakan memastikan diagnostic tidak mengulang URL atau credential sentinel.
- **Batas bukti:** tes tidak membaca `.env`, membuka koneksi, menjalankan Docker, atau menulis database. Tes hanya memverifikasi allowlist sebelum koneksi; bukan bukti perilaku PostgreSQL/Prisma/Fastify runtime. Smoke PostgreSQL dan GitHub Actions tetap pending, sehingga INT-005 tetap PARTIAL.

## Keputusan verifikasi INT-005H — PostgreSQL concurrent attendance idempotency

- Smoke menyiapkan Employee dan DeviceBinding sintetis acak dalam transaksi terpisah pada database CI ephemeral yang URL, nama database, dan user-nya sudah lolos guard. Setiap koneksi fixture/insert/observer memeriksa `current_database()` dan `current_user` sebelum DML.
- Sebelum fixture dibuat, smoke memastikan koneksi observer memiliki hak `EXECUTE` untuk `pg_blocking_pids(integer)`; jika tidak, probe gagal sebelum fixture write. Hak fungsi tersebut memang dibatasi PostgreSQL secara default ([system information functions](https://www.postgresql.org/docs/17/functions-info.html)). Smoke ini hanya untuk service database ephemeral pada CI, bukan untuk dijalankan pada Managed PostgreSQL staging.
- Dua sesi PostgreSQL berbeda menjalankan insert dengan employee dan idempotency UUID yang sama. Sesi pertama menahan insert tanpa commit; observer membuktikan sesi kedua benar-benar menunggu PID pertama melalui `pg_blocking_pids()` sebelum sesi pertama di-commit. Sesi kedua wajib gagal dengan SQLSTATE `23505` dan index `attendance_attempts_employee_idempotency_key`; hanya attempt pertama yang boleh persisten.
- Jalur teardown terlebih dahulu me-rollback transaksi pertama yang masih terbuka untuk melepas lock, menunggu query kedua selesai, lalu me-rollback transaksi kedua. Jika sesi kedua tetap tidak selesai, hanya backend PID probe dengan application name/database/user yang cocok yang boleh dihentikan; PostgreSQL 17 mendukung timeout yang menunggu terminasi aktual ([server signaling functions](https://www.postgresql.org/docs/17/functions-admin.html)). Cleanup fixture dilakukan setelah kedua transaksi dipastikan selesai, dalam urutan attempt → device binding → employee; query akhir memastikan tak ada fixture tersisa. Detail error driver dan nilai fixture tidak dicetak.
- **Batas bukti:** implementasi smoke ini hanya dikonfigurasi secara lokal. PostgreSQL dan GitHub Actions belum dijalankan; tidak ada data lokal, staging, atau production yang ditulis. INT-005 tetap PARTIAL sampai workflow yang memakai PostgreSQL disposable berhasil diamati.

## Keputusan implementasi BE-025 — rekap bulanan dan workbook

- Admin dan Supervisor menggunakan `GET /api/v1/reports/monthly` dan
  `GET /api/v1/reports/monthly/export`; scope Supervisor berasal dari assignment
  session di server dan filter tambahan selalu dipersempit dengan scope tersebut.
- JSON dan XLSX menggunakan satu aggregator yang sama. Workbook memiliki sheet
  `Ringkasan` dan `Detail Harian`; field teks ditulis literal, response `no-store`, dan
  audit export menyimpan periode/filter serta request context saja—bukan data report.
- Pemilik produk mengonfirmasi `workDays` sebagai jumlah tanggal kalender unik per
  karyawan yang memiliki setidaknya satu shift terjadwal yang telah tiba/berjalan dan
  bukan holiday. Beberapa shift pada tanggal yang sama dihitung satu hari. Future shift
  hanya tampil sebagai `NOT_STARTED`, tidak masuk denominator summary. Daily detail
  tetap satu baris per assignment shift/tanggal.
- Menit kerja memakai pasangan attendance `VALID`/`APPROVED`, durasi dibulatkan ke
  menit terdekat lalu dikurangi break shift. Menit telat adalah elapsed sejak jadwal
  mulai, mencakup toleransi, dibulatkan ke menit terdekat; check-in terlambat tetap
  dihitung saat checkout belum ada. Ini konsisten dengan perilaku lokal dashboard, tetapi
  belum disahkan sebagai definisi payroll.
- Lembur hanya mengambil request `OVERTIME` berstatus `APPROVED` yang approver-nya
  Admin. Untuk report yang dibatasi toko, overtime hanya diatribusikan bila assignment
  request dapat diturunkan ke tepat satu toko yang termasuk scope; request ambigu tidak
  boleh bocor ke report toko. Approval lembur final pada PRD masih memerlukan rekonsiliasi
  karena FR-28 dan FR-30 berbeda.
- Corrections belum diterapkan di report sampai workflow BE-022 tersedia. Monthly closing
  BE-026 dan UI report FE-016 juga belum dibuat. Unit, route, serializer, dan repository
  fake bukan bukti PostgreSQL live, rekonsiliasi dashboard, beban 200 karyawan/20 toko,
  atau pembukaan workbook di Microsoft Excel; semua itu tetap gate integrasi.
