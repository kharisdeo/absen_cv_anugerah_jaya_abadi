# API contract

Dokumentasi kontrak backend yang sudah tersedia. Spesifikasi machine-readable ada di
[openapi.yaml](openapi.yaml) dan hanya memuat route yang saat ini diregistrasikan server.
Endpoint yang menunggu storage atau alur bisnis berikutnya ditandai sebagai belum aktif;
endpoint tersebut tidak boleh diperlakukan sebagai API aktif oleh frontend. Daftar audit
read-only Admin sudah aktif pada `GET /api/v1/admin/audit-logs`. Rekap bulanan dan
export XLSX Admin/Supervisor tersedia pada endpoint yang dijelaskan di bawah.

## Rekap bulanan dan export — BE-025

### GET `/api/v1/reports/monthly`

Query wajib `month=YYYY-MM`; `storeId` dan `employeeId` adalah filter UUID opsional.
Hanya Admin dan Supervisor. Supervisor scope selalu ditentukan server dari assignment
akun dan filter tidak dapat memperluasnya. Response memuat `summary` per karyawan,
`dailyDetails` per assignment shift/tanggal, filter yang diterapkan, serta string
`definitions` untuk menjelaskan rumus. Response `no-store`; route dibatasi 10 request
per 15 menit.

`workDays` menghitung tanggal kalender unik per karyawan yang memiliki setidaknya satu
shift terjadwal yang telah tiba/berjalan dan bukan hari libur; beberapa shift pada
tanggal yang sama menambah satu hari kerja. Definisi ini telah dikonfirmasi pemilik
produk. Detail tetap memuat satu row per assignment shift/tanggal. Shift masa depan
ditampilkan di detail sebagai `NOT_STARTED`, tetapi tidak masuk hitungan summary.
Hitungan laten mencakup valid/approved check-in yang
melewati toleransi, termasuk kasus tanpa checkout; menit telat dibulatkan ke menit
terdekat sejak jadwal mulai (toleransi tidak dikurangi). Menit kerja dihitung dari
pasangan check-in/out `VALID` atau `APPROVED`, dibulatkan ke menit terdekat, lalu
dikurangi istirahat shift. Pengajuan pending/rejected tidak dihitung sebagai status
izin/sakit/cuti yang disetujui. Correction belum diterapkan sampai workflow BE-022
tersedia. Lembur hanya menghitung pengajuan `OVERTIME` `APPROVED` oleh Admin; pada
laporan yang dibatasi toko, request hanya diatribusikan bila repository dapat
menentukan tepat satu toko yang diizinkan.

### GET `/api/v1/reports/monthly/export`

Filter query sama dengan endpoint JSON. Response adalah workbook `.xlsx` dengan sheet
`Ringkasan` dan `Detail Harian`, diserialisasi dari aggregator yang sama. Export dicatat
di audit sebagai filter/periode saja; workbook dan isi absensi tidak disimpan ke audit.
Response `no-store`; nilai teks ditulis sebagai literal, bukan formula Excel.

Batas verifikasi: API/service/route/repository/workbook tests lokal menggunakan fixture
dan fake repository. UI report Admin/Supervisor tersedia pada FE-016 dengan filter,
ringkasan/detail, paginasi, dan validasi unduhan XLSX client. PostgreSQL query,
rekonsiliasi angka terhadap dashboard pada DB, serta pembukaan workbook dengan Microsoft
Excel belum diuji live. Monthly closing tetap terpisah dan menunggu keputusan BE-026.

## Liveness dan readiness — BE-027 / DEP-005

### GET `/api/v1/health`

Liveness proses API. Endpoint ini tetap tersedia tanpa database dan selalu mengembalikan
`200 { "status": "ok" }` selama proses API dapat menangani request. Jika `APP_VERSION`
disetel, respons juga menyertakan `X-App-Version` dari nilai tersebut. Nilainya harus berupa
identifier ASCII 1–128 karakter yang memakai huruf, angka, `.`, `_`, `+`, atau `-`; jika tidak
disetel, header dihilangkan. Deployment harus mengisi `APP_VERSION` dengan ID commit immutable.
Endpoint ini tidak menyatakan database sehat.

### GET `/api/v1/ready`

Readiness dependency database; dapat dipanggil tanpa session dan selalu memakai
`Cache-Control: no-store`. Jika `DATABASE_URL` tersedia, runtime menjalankan `SELECT 1`
melalui Prisma. Jika probe berhasil, respons `200 { "status": "ok" }`; jika database
tidak dikonfigurasi atau query gagal, respons generik `503 { "status": "unavailable" }`.
Detail exception, URL database, dan credential tidak dikirim ke client. Endpoint tetap
melewati plugin keamanan HTTP global yang sama dengan route lain.

Tes lokal memakai callback/Prisma fake untuk membuktikan kontrak respons, kerahasiaan
error, independensi liveness, serta akses tanpa session. Tes ini tidak membuktikan
koneksi PostgreSQL live, konfigurasi staging, atau deployment.

## Audit log — BE-007A

### GET `/api/v1/admin/audit-logs`

Hanya Admin dengan sesi cookie yang tervalidasi server. Endpoint bersifat read-only,
memakai `Cache-Control: no-store`, dan memiliki rate limit default 30 request per menit
(dapat mengikuti `sensitiveRateLimit` jika dikonfigurasi). Parameter query dikenal secara
ketat; parameter lain ditolak dengan Problem Details `400 INVALID_AUDIT_INPUT`.

Filter opsional: `actorUserAccountId` (UUID), `action`, `entityType`, `entityId`, `from`,
`to`, `page` (default 1, maksimum 10.000), dan `pageSize` (default 50, maksimum 100).
Timestamp `from`/`to` wajib ISO dengan zona waktu, bersifat inklusif, dan `from` tidak
boleh melewati `to`. `action`/`entityType` mengikuti format filter `AuditService`.

Response menggunakan `{ items, page, pageSize, hasNextPage }`. Setiap item hanya memuat
`id`, `actorUserAccountId`, `occurredAt`, `clientIp`, `deviceIdHash`, `action`,
`entityType`, `entityId`, `beforeData`, `afterData`, `reason`, dan `requestId`. Urutan
ditetapkan repository sebagai `occurredAt DESC, id DESC`; `AuditService` mengambil satu
baris tambahan untuk menentukan `hasNextPage`. Tidak tersedia POST, PUT, PATCH, atau
DELETE untuk audit log.

Route tests memakai `AuditService` asli dengan fake in-memory `AuditLogRepository`; tes
membuktikan Admin filter/pagination mapping, DTO allowlist, no-store, role denial sebelum
repository access, query rejection, rate limit, dan tidak adanya mutation route. Tes ini
tidak membuktikan query terhadap PostgreSQL live.

## Gangguan sistem — BE-023

### POST `/api/v1/admin/system-disruptions`

Hanya Admin. Membuat gangguan aktif dengan `startsAt` dan `endsAt` sebagai timestamp ISO
yang menyertakan zona waktu, `reason` wajib (1–500 karakter setelah trim), dan `storeId`
UUID atau `null`/tidak dikirim untuk gangguan global. `endsAt` harus lebih besar daripada
`startsAt`; store yang dipilih harus ada. Request memakai cookie session, same-origin
`Origin`, rate limit sensitif, header `Idempotency-Key` wajib berupa UUID v4 acak,
dan response `Cache-Control: no-store`. Field tambahan,
termasuk `isActive` dan identitas pembuat, ditolak; server selalu menetapkan status aktif
dan pembuat dari session. Respons 201 tidak memuat data akun pembuat.

Server menormalisasi `storeId`, timestamp ke UTC, dan `reason` setelah trim sebelum membuat
fingerprint payload. Key di-scope menurut ID Admin dari session server; DB hanya menyimpan
SHA-256 key dan fingerprint. Pengulangan dengan actor, key, dan payload ternormalisasi yang
sama mengembalikan record yang sama tanpa audit kedua. Key sama dengan payload berbeda
mendapat HTTP 409 `IDEMPOTENCY_KEY_REUSED`; key hilang atau bukan UUID v4 mendapat HTTP 400
`INVALID_IDEMPOTENCY_KEY`. Record, fingerprint, dan audit event ditulis dalam satu transaksi
PostgreSQL, sehingga retry aman setelah client tidak mengetahui apakah respons pertama tiba.
Gunakan key yang sama hanya untuk retry payload yang identik; payload berbeda memerlukan key
acak baru.

```json
{
  "storeId": null,
  "startsAt": "2026-10-11T09:00:00+07:00",
  "endsAt": "2026-10-11T11:00:00+07:00",
  "reason": "Gangguan koneksi pusat"
}
```

Create menambahkan audit event `system_disruption.create` dengan aktor, request ID, reason,
store scope, dan time range. Route tidak menyediakan update/delete; daftar record dan log
audit bersifat append-only dari API ini.

### GET `/api/v1/admin/system-disruptions`

Hanya Admin dan `Cache-Control: no-store`. Query opsional: `storeId` (UUID; memfilter scope
toko persis), `page` (default 1, maksimum 10.000), dan `pageSize` (default 25, maksimum 50).
Tanpa `storeId`, hasil mencakup gangguan global maupun semua toko; hasil berurutan `startsAt`
terbaru lalu ID menurun. Global scope disimpan sebagai `storeId: null`.

Overlap antargangguan tidak ditolak atau digabung: schema tidak memiliki exclusion/unique
constraint untuk interval, sehingga record overlap tetap terpisah. Guard harian memakai
interval setengah-terbuka (`disruption.startsAt < shift.endsAt` dan
`disruption.endsAt > shift.startsAt`); interval yang hanya bersentuhan tepat di batas tidak
overlap. Guard tersebut hanya mencegah insert `ABSENT` baru. Membuat gangguan tidak mengubah
row `daily_attendance_statuses` yang sudah ada, record absensi mentah, atau klasifikasi
`PRESENT`/`LATE`.

Mass correction tetap tidak tersedia sampai produk mendefinisikan status/mapping, target
record, rentang tanggal, dan penanganan terhadap record `PRESENT`/`LATE`/`ABSENT` yang sudah
ada. Implementasi POST idempotency tidak mengubah attendance mentah atau record harian yang
sudah ada; BE-023 tetap PARTIAL sampai koreksi massal beserta policy-nya disepakati dan diuji.

## Selfie privat — BE-015

### POST `/api/v1/attendance/selfie-upload-intents`

Membuat intent upload untuk principal `EMPLOYEE` dengan profil aktif dan device binding
`APPROVED`. Endpoint memerlukan cookie sesi, `Origin` persis sama dengan `APP_ORIGIN`,
rate limit sensitif, dan response `Cache-Control: no-store`. Body menerima `contentType`
`image/jpeg | image/png | image/webp` serta `sizeBytes` integer 1–204800; field tambahan
ditolak.

```json
{ "contentType": "image/jpeg", "sizeBytes": 18432 }
```

HTTP 201 mengembalikan `referenceId` UUID acak, `uploadUrl` PUT bertanda tangan, header
wajib `Content-Type` dan `x-amz-meta-referencehash`, serta `expiresAt`. Upload langsung ke
URL tersebut memakai metode PUT dan hanya header yang diberikan; object key tidak pernah
dikirimkan sebagai field request/response. URL upload berlaku 30–300 detik (default 120).
S3 key bersifat acak di prefix privat `attendance/selfie-staging/`; bucket tidak boleh
public. Endpoint hanya menerima metadata, bukan bytes foto.

Saat `/attendance/attempts` dikirim, server memastikan intent masih berlaku dan milik
employee serta binding sesi, lalu memeriksa object privat: metadata hash, MIME yang
dideklarasikan, ukuran byte aktual dan signature gambar harus cocok. Maksimum tetap
200 KiB. Server menulis bytes terverifikasi ke key privat acak yang dicadangkan untuk
intent dan memakai conditional `If-None-Match: *`, lalu mengikatnya ke attempt dalam
transaksi yang sama. Key accepted tidak pernah ditandatangani untuk client; retry tidak
dapat menimpa foto yang sudah tersegel. Worker membersihkan foto staging setelah attach
serta foto staging/accepted untuk intent yang tak terpakai setelah expiry.
Nama karyawan, waktu penerimaan server, dan koordinat (atau label `Lokasi tidak tersedia`)
tersimpan sebagai metadata watermark. Server membuat JPEG turunan privat dengan watermark
yang dirender ke piksel; foto accepted asli tetap immutable. `watermarkApplied` hanya menjadi
true setelah turunan tersimpan dan status database ter-commit. Read URL Admin/Supervisor hanya
menunjuk turunan tersebut, tidak pernah foto asli. Bila render/storage gagal, submit dapat
memerlukan retry idempoten; bukti belum dapat dibaca dan tidak ada URL original yang diterbitkan.
Retention worker juga memproses antrean watermark legacy sebelum purge. Watermark bukan hasil
face/liveness verification. Sumber foto tetap harus dibatasi UI ke stream kamera; validasi
MIME/bytes sendiri tidak dapat membuktikan asal kamera secara kriptografis.

### GET `/api/v1/admin/attendance-attempts/:attemptId/selfie-url`

Route legacy hanya mengizinkan Admin meminta signed GET URL sementara untuk attempt yang
memiliki selfie dan belum melewati retensi. Jalur review
`GET /api/v1/attendance/verifications/:attendanceId/selfie-url` mengizinkan Admin dan
Supervisor, dengan scope assignment toko ditegakkan repository. Employee dan role lain ditolak;
attempt di luar scope, tanpa bukti, kedaluwarsa, atau tidak ditemukan mengembalikan
`SELFIE_NOT_FOUND`. Kedua jalur hanya menandatangani JPEG derivative privat. Pada read pertama
untuk foto legacy yang belum ber-watermark, backend memeriksa akses lebih dulu, merender dan
menyimpan derivative, lalu baru menerbitkan signed GET URL. Response no-store dan URL hanya
berlaku selama TTL upload yang sama.

### Retensi selfie

Jalankan `pnpm --filter @absen/api retention:run` dari scheduler tepercaya minimal sekali
sehari dengan `DATABASE_URL` dan konfigurasi storage yang sama dengan API. Worker mengambil
batch idempotent, mengklaim intent expired sebelum menghapus orphan agar transaksi attach
tidak dapat berlomba menghapus bukti yang sedang dipakai, menghapus object S3, lalu menandai object key null dan
`deletedAt`; retry setelah crash aman karena delete object idempotent. Foto staging dan
sealed copy untuk intent yang kedaluwarsa ikut dihapus. Attempt, angka absensi, dan metadata watermark tetap
dipertahankan. Worker gagal dengan exit code non-zero bila penyimpanan atau database gagal;
belum ada scheduler/provider yang dipilih atau dipasang.

Error contract untuk endpoint selfie:

| HTTP | `code`                                                                       | Makna                                                                     |
| ---- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 400  | `INVALID_SELFIE_UPLOAD_INTENT`, `INVALID_SELFIE_REFERENCE`                   | Body atau UUID tidak valid.                                               |
| 401  | `UNAUTHENTICATED`                                                            | Sesi tidak ada/tidak sah.                                                 |
| 403  | `CSRF_ORIGIN_REJECTED`, `FORBIDDEN`, `ATTENDANCE_DEVICE_BINDING_REQUIRED`    | Origin, role, profil, atau perangkat tidak memenuhi syarat.               |
| 404  | `SELFIE_NOT_FOUND`                                                           | Attempt tidak memiliki bukti aktif yang boleh dibaca.                     |
| 413  | `PAYLOAD_TOO_LARGE`                                                          | Payload intent melampaui batas request.                                   |
| 429  | `RATE_LIMITED`                                                               | Rate limit sensitif terlampaui.                                           |
| 422  | `ATTENDANCE_EVIDENCE_INVALID`                                                | Intent, object, metadata, signature, atau ukuran tidak cocok.             |
| 503  | `ATTENDANCE_EVIDENCE_VALIDATION_UNAVAILABLE`, `SELFIE_WATERMARK_UNAVAILABLE` | Database/storage/render watermark tidak tersedia; operasi gagal tertutup. |

## POST `/api/v1/attendance/attempts` — BE-013/BE-014

Mengirim satu percobaan absensi dan menerima receipt penerimaan. Endpoint memerlukan
cookie sesi yang sah, `Origin` persis sama dengan `APP_ORIGIN`, dan principal dengan
role `EMPLOYEE`, `employeeId`, serta device binding berstatus `APPROVED`. Response
selalu memakai `Cache-Control: no-store`. Request body maksimum 300 KiB.

Server memperoleh employee dan device binding dari sesi terautentikasi. `deviceId`
tidak diterima dari client; hash ID perangkat yang tersimpan disalin dari binding
server-side. Waktu penerimaan (`receivedAt`), IP request, dan request ID berasal dari
server. Client tidak boleh menentukan `employeeId`, waktu server, jarak, hasil geofence,
status final, status validasi, atau proof code. `storeId` opsional hanya pilihan yang
tidak dipercaya; server memakainya hanya bila cocok dengan assignment aktif employee.

Contoh request:

```json
{
  "idempotencyKey": "00000000-0000-4000-8000-000000000001",
  "storeId": "00000000-0000-4000-8000-000000000003",
  "type": "CHECK_IN",
  "clientRecordedAt": "2026-10-11T10:00:00+07:00",
  "networkStatus": "ONLINE",
  "location": {
    "latitude": -6.2,
    "longitude": 106.8,
    "accuracyMeters": 12.5
  },
  "validationMethod": "GPS",
  "selfie": {
    "blob": "00000000-0000-4000-8000-000000000002",
    "sizeKb": 180
  },
  "liveness": { "faceDetected": true, "passed": true },
  "proofCode": null
}
```

Jika browser tidak memperoleh fix setelah capture/retry, selfie tetap dapat dikirim sebagai
attempt online tanpa koordinat palsu. `location` wajib bernilai `null` dan
`locationFailureReason` wajib salah satu `PERMISSION_DENIED`, `POSITION_UNAVAILABLE`, atau
`TIMEOUT`. Field tersebut adalah bukti kondisi client, bukan keputusan validasi server:

```json
{
  "idempotencyKey": "00000000-0000-4000-8000-000000000011",
  "type": "CHECK_IN",
  "clientRecordedAt": "2026-10-11T10:00:00+07:00",
  "networkStatus": "ONLINE",
  "location": null,
  "locationFailureReason": "PERMISSION_DENIED",
  "validationMethod": "GPS",
  "selfie": {
    "blob": "00000000-0000-4000-8000-000000000002",
    "sizeKb": 180
  },
  "liveness": { "faceDetected": false, "passed": false },
  "proofCode": null
}
```

Schema strict: field yang tidak dikenal ditolak, termasuk `deviceId`, `employeeId`,
`serverTime`, `distanceMeters`, `geofenceResult`, `status`, dan `validationStatus`.
`storeId` opsional harus UUID; ia hanya selection hint, bukan bukti assignment. Timestamp
`clientRecordedAt` harus ISO-8601 dengan UTC offset dan hanya disimpan sebagai waktu
yang dilaporkan client; bukan waktu resmi atau dasar status kehadiran. Enum yang
diterima: `type` = `CHECK_IN | CHECK_OUT`, `networkStatus` = `ONLINE | OFFLINE`, dan
`validationMethod` = `GPS | QR | WIFI | SUPERVISOR | OFFLINE | ASSISTED`. Koordinat
memakai rentang geografis dan maksimal enam desimal; akurasi positif dengan maksimal
dua desimal. Referensi selfie berupa UUID staging privat, bukan foto, URL, atau token;
ukuran aktual harus diverifikasi server dan maksimum 200 KiB. `proofCode` hanya boleh
tidak dikirim atau `null` sampai BE-019 menyediakan proof generator.

### Data dan batas tanggung jawab

- `location.latitude`, `longitude`, dan `accuracyMeters` disimpan pada kolom
  `attendance_attempts.latitude`, `longitude`, dan `accuracy_meters` sebagai lokasi
  yang dilaporkan client. Server menghitung jarak hanya ke store assignment aktif yang
  dipilih/di-resolve, lalu menyimpan snapshot store, jarak, radius, batas akurasi,
  hasil geofence, dan flag koordinat identik berulang. Lokasi tidak disalin ke audit
  maupun response; hasil geofence bukan status absensi final.
- Saat `location` bernilai `null`, ketiga koordinat disimpan sebagai SQL `NULL`, bersama
  `locationFailureReason`. Tidak dibuat `Attendance` maupun `LocationProof`; receipt tetap
  `RECEIVED` tanpa `attendanceId`/`validationStatus`, dan selfie tetap sealed serta tertaut
  privat ke attempt. Attempt yang receipt-nya berada pada jendela shift ikut menahan daily
  reconciliation agar tidak membuat `ABSENT`. Failure reason client tidak pernah mengubah
  attempt menjadi `VALID` atau `ABSENT`. Raw attempt no-fix belum menjadi item dalam antrean
  verifikasi Attendance dan belum memiliki endpoint keputusan; receipt ini hanya konfirmasi
  penerimaan, bukan klaim bahwa review Admin/Supervisor sudah tersedia.
- Nilai tersimpan `geofenceResult`: `WITHIN_LIMITS`, `OUTSIDE_RADIUS`,
  `ACCURACY_EXCEEDED`, `OUTSIDE_RADIUS_AND_ACCURACY_EXCEEDED`,
  `STORE_SELECTION_REQUIRED`, `STORE_NOT_ASSIGNED`, atau `NO_ACTIVE_ASSIGNED_STORE`.
  `repeatedCoordinate` adalah flag review terpisah dan tidak mengubah enum geofence.
- Attempt menyimpan waktu client yang dilaporkan, network/method yang dilaporkan,
  klaim liveness, hash SHA-256 reference selfie, ukuran yang telah diverifikasi, serta
  device hash dari binding server. `liveness.faceDetected` dan `liveness.passed` adalah
  klaim client saja; keduanya bukan hasil liveness/face verification. Foto mentah,
  reference selfie mentah, token, dan device identifier mentah tidak disimpan atau
  ditulis ke log.
- Audit `attendance.attempt.create` ditulis bersama raw attempt. Jika aturan check-in/out
  menolak attempt, raw attempt tetap disimpan sebagai `RULE_REJECTED` beserta audit alasan;
  tidak ada baris `Attendance` yang dibuat. Jika aturan lulus, server juga membuat baris
  `Attendance`, `SelfieCapture`, dan `LocationProof` dalam transaksi yang sama dan menulis
  audit `attendance.record.create`. Audit tidak memuat koordinat atau foto mentah.
- Bila aturan shift lulus dan lokasi tersedia, receipt sukses pertama tetap HTTP `202` dengan
  state `RECORDED`, `attendanceId`, dan status validasi hasil server. Tanpa fix lokasi, receipt
  HTTP `202` tetap `RECEIVED` dan tidak menyatakan Attendance telah dibuat. Attendance online
  dengan lokasi tetap `PENDING_VERIFICATION`. Untuk `networkStatus`
  `OFFLINE`, server menghitung drift absolut dan umur sync memakai `AttendanceAttempt.receivedAt`
  dari database serta `clientRecordedAt` asli: drift `> 5 menit` atau umur `> 24 jam` membuat
  OR, tepat 24 jam tetap `PENDING_VERIFICATION` akibat drift yang melampaui 5 menit. Liveness
  saat ini hanya klaim client dan tidak diverifikasi server, sehingga semua Attendance offline
  fail-closed sebagai `PENDING_VERIFICATION`; klaim pass/tidak gagal dari client tidak dapat
  menghasilkan `VALID`. Sebelum jalur offline dapat menjadi `VALID`, server harus memverifikasi
  liveness serta memastikan kedua ambang waktu tidak terlampaui, metode laporan `GPS`/`OFFLINE`,
  geofence `WITHIN_LIMITS`, tidak repeated-coordinate, dan seluruh aturan shift/check-in/out lulus.
  Geofence gagal atau repeated-coordinate tetap membuat Attendance pending untuk verifikasi, bukan
  valid. `Attendance.method` dan `networkStatus` offline memakai enum terpusat `OFFLINE`, sementara
  `AttendanceAttempt.reportedMethod` tetap menyimpan metode laporan client. Timestamp server tetap
  waktu receipt, sedangkan `deviceTime`, `SelfieCapture.capturedAt`, dan `LocationProof.capturedAt`
  mempertahankan waktu perangkat. Karyawan hanya memiliki endpoint submit; tidak tersedia endpoint
  edit/delete attempt. Attempt yang ditolak aturan bisnis mengembalikan HTTP 409 dengan kode terarah
  dan tetap menyimpan raw attempt.
- Verifier private-selfie-reference tersedia setelah BE-015: ia memeriksa intent aktif,
  owner/device, metadata S3, ukuran dan signature gambar, lalu menyalin foto ke key privat
  yang tidak dapat ditimpa URL client. Existing idempotent record tetap dapat direplay tanpa
  mengonsumsi ulang upload intent.
- Jika employee memiliki satu assignment toko aktif, server memilihnya. Jika memiliki
  beberapa, `storeId` harus cocok dengan assignment aktif; tanpa pilihan, attempt tetap
  disimpan dengan hasil `STORE_SELECTION_REQUIRED`. Pilihan yang tidak ditugaskan tidak
  menjadi relasi store dan menghasilkan `STORE_NOT_ASSIGNED`. Aturan shift memilih assignment
  aktif pada tanggal WIB dari server receipt, bukan tanggal client. Untuk offline queue yang sync
  melewati tengah malam, assignment/work date tanggal receipt yang berlaku; jika tidak cocok,
  attempt bisa ditolak walau device time menunjukkan hari sebelumnya. Tidak ada fallback ke waktu
  device yang belum terverifikasi. Mengubah ini menjadi tanggal capture memerlukan keputusan bisnis.
  Check-in aktif yang belum ditolak (termasuk
  `PENDING_VERIFICATION`) mencegah duplikasi; check-out harus merujuk check-in pada shift dan
  work date yang sama. Shift malam boleh ditutup sampai jam pulang terjadwal pada hari berikutnya;
  sesudahnya server meminta koreksi, bukan membuat checkout terlambat secara otomatis.
  Penilaian terlambat/pulang cepat memakai waktu receipt server; ringkasan penilaian ditulis ke
  audit, bukan dijadikan keputusan `VALID`. Proses akhir hari untuk menandai `Tidak absen pulang`
  belum tersedia.

### Response

Pertama kali diterima (hanya setelah verifier aktif): HTTP `202 Accepted`.

```json
{
  "attemptId": "00000000-0000-4000-8000-000000000003",
  "state": "RECORDED",
  "type": "CHECK_IN",
  "receivedAt": "2026-10-11T03:00:00.000Z",
  "replayed": false,
  "attendanceId": "00000000-0000-4000-8000-000000000019",
  "validationStatus": "PENDING_VERIFICATION"
}
```

Request identik dengan employee + `idempotencyKey` yang sama mengembalikan HTTP 200,
receipt yang sama dengan `replayed: true`. Key yang sama untuk payload atau device
binding berbeda menghasilkan HTTP 409. Unique index PostgreSQL pada
`(employee_id, idempotency_key)` menjadi sumber kebenaran untuk request bersamaan;
lookup awal hanya optimisasi. Insert attempt dan audit dilakukan dalam satu transaksi.

### Error contract

Response memakai Problem Details dengan `code` stabil. UI harus menampilkan hanya pesan
Indonesia dari allowlist, tidak pernah `detail`/`title`/path/request ID dari server.

| HTTP | `code`                                                                                                                                                                                                                                                                                                                                | Makna                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 400  | `INVALID_ATTENDANCE_ATTEMPT`                                                                                                                                                                                                                                                                                                          | Payload salah bentuk, enum, timestamp, UUID, atau field terlarang.                                    |
| 401  | `UNAUTHENTICATED`                                                                                                                                                                                                                                                                                                                     | Sesi tidak ada/tidak sah.                                                                             |
| 403  | `CSRF_ORIGIN_REJECTED`, `FORBIDDEN`, `ATTENDANCE_DEVICE_BINDING_REQUIRED`                                                                                                                                                                                                                                                             | Origin, role, atau binding tidak memenuhi kontrak.                                                    |
| 409  | `IDEMPOTENCY_KEY_REUSED`, `ATTENDANCE_ATTEMPT_CONFLICT`, `ATTENDANCE_CHECK_IN_DUPLICATE`, `ATTENDANCE_CHECK_IN_REQUIRED`, `ATTENDANCE_CHECKOUT_SHIFT_MISMATCH`, `ATTENDANCE_CHECKOUT_OUT_OF_ORDER`, `ATTENDANCE_CHECKOUT_WINDOW_EXPIRED`, `ATTENDANCE_SHIFT_NOT_ASSIGNED`, `ATTENDANCE_SHIFT_AMBIGUOUS`, `ATTENDANCE_NON_WORKING_DAY` | Key dipakai untuk payload berbeda, conflict database, atau aturan check-in/out/shift menolak attempt. |
| 413  | `PAYLOAD_TOO_LARGE`                                                                                                                                                                                                                                                                                                                   | Request melebihi 300 KiB.                                                                             |
| 415  | `UNSUPPORTED_MEDIA_TYPE`                                                                                                                                                                                                                                                                                                              | Request bukan JSON yang didukung.                                                                     |
| 422  | `ATTENDANCE_EVIDENCE_INVALID`                                                                                                                                                                                                                                                                                                         | Referensi private selfie atau ukuran aktual tidak valid.                                              |
| 429  | `RATE_LIMITED`                                                                                                                                                                                                                                                                                                                        | Rate limit sensitif terlampaui (default 5 request per 15 menit).                                      |
| 503  | `ATTENDANCE_EVIDENCE_VALIDATION_UNAVAILABLE`                                                                                                                                                                                                                                                                                          | Verifier/storage tidak tersedia; fresh attempt tidak disimpan.                                        |

## Admin toko dan assignment karyawan — BE-011

Semua endpoint berikut memakai sesi cookie dan hanya dapat digunakan oleh Admin. Response
tidak boleh disimpan oleh cache. Mutasi divalidasi ulang di server dan menghasilkan Problem
Details dengan `code` stabil saat gagal.

| HTTP   | Path                                                    | Fungsi                                                                                                                                   |
| ------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/v1/admin/stores`                                  | Daftar semua toko, termasuk yang tidak aktif.                                                                                            |
| POST   | `/api/v1/admin/stores`                                  | Buat toko; wajib `name`, `latitude`, `longitude`; opsional `address`, `radiusMeters`, `accuracyLimitMeters`, `wifiPublicIp`, `isActive`. |
| GET    | `/api/v1/admin/stores/:storeId`                         | Detail toko.                                                                                                                             |
| PATCH  | `/api/v1/admin/stores/:storeId`                         | Ubah hanya field yang dikirim; field lain tidak berubah.                                                                                 |
| POST   | `/api/v1/admin/stores/:storeId/deactivate`              | Tandai toko tidak aktif. Tidak menghapus histori/assignment dan belum ada endpoint reaktivasi.                                           |
| GET    | `/api/v1/admin/stores/:storeId/assignments`             | Daftar karyawan yang ditugaskan pada toko.                                                                                               |
| PUT    | `/api/v1/admin/stores/:storeId/assignments/:employeeId` | Buat assignment secara idempotent; body kosong.                                                                                          |
| DELETE | `/api/v1/admin/stores/:storeId/assignments/:employeeId` | Hapus assignment secara idempotent; response `204`.                                                                                      |
| GET    | `/api/v1/admin/employees`                               | Daftar karyawan untuk pemilihan assignment; response tidak memuat akun atau data perangkat.                                              |

DTO toko berisi `id`, `name`, `address`, `latitude`, `longitude`, `radiusMeters`,
`accuracyLimitMeters`, `wifiPublicIp`, `isActive`, `createdAt`, dan `updatedAt`. Radius
dan batas akurasi positif dalam meter; default schema saat create adalah 10 dan 30 meter.
Koordinat toko adalah konfigurasi Admin, bukan bukti lokasi ataupun keputusan geofence
untuk suatu attempt. Assignment bersifat many-to-many; hanya employee aktif dapat menerima
assignment baru melalui UI, sedangkan aturan API/database tetap menjadi sumber kebenaran.

Endpoint profil karyawan pada tabel yang sama adalah:

| HTTP  | Path                                             | Fungsi                                                                                 |
| ----- | ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| GET   | `/api/v1/admin/employees/:employeeId`            | Detail profil karyawan.                                                                |
| POST  | `/api/v1/admin/employees`                        | Buat profil; wajib `nik`, `fullName`; opsional `position`, `employmentDate`, `status`. |
| PATCH | `/api/v1/admin/employees/:employeeId`            | Ubah field profil/status yang dikirim.                                                 |
| POST  | `/api/v1/admin/employees/:employeeId/deactivate` | Tandai profil tidak aktif; response DTO, bukan hard delete.                            |

DTO karyawan berisi `id`, `nik`, `fullName`, `position`, `status`, `employmentDate`,
`createdAt`, dan `updatedAt`. NIK, nama, jabatan, dan tanggal mulai divalidasi sesuai batas
route. Endpoint profil tidak membuat akun login atau melakukan persetujuan perangkat.

## Admin akun dan perangkat — BE-010

| HTTP  | Path                                                    | Fungsi                                                                                  |
| ----- | ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| GET   | `/api/v1/admin/accounts`                                | Daftar akun tanpa hash/password.                                                        |
| POST  | `/api/v1/admin/accounts`                                | Buat akun; response `{ account, temporaryPassword }`, password sementara dibuat server. |
| GET   | `/api/v1/admin/accounts/:accountId`                     | Detail akun.                                                                            |
| PATCH | `/api/v1/admin/accounts/:accountId`                     | Ubah field username, role, status, atau employee link yang dikirim.                     |
| POST  | `/api/v1/admin/accounts/:accountId/deactivate`          | Tandai akun tidak aktif; server menegakkan minimal dua Admin aktif.                     |
| POST  | `/api/v1/auth/admin/accounts/:accountId/reset-password` | Body `{ temporaryPassword }`; response menyatakan `mustChangePassword: true`.           |
| GET   | `/api/v1/admin/device-bindings/pending`                 | Daftar binding pending tanpa token/hash perangkat.                                      |
| POST  | `/api/v1/admin/device-bindings/:bindingId/approve`      | Setujui binding; dapat mencabut binding approved lain milik karyawan yang sama.         |
| POST  | `/api/v1/admin/device-bindings/:bindingId/revoke`       | Cabut binding; sesi yang terikat dicabut oleh server.                                   |

Akun menampilkan metadata publik saja (`id`, username, role, status, employee link,
`mustChangePassword`, timestamps). Password dari create hanya dikembalikan pada response
create; reset menerima password sementara yang dimasukkan Admin. Klien tidak boleh menyimpan
password ke storage browser atau log. Semua route memerlukan sesi Admin; mutasi menerapkan
validasi origin dan rate limit sensitif.

## Admin katalog shift — BE-012

Semua endpoint memakai sesi cookie Admin dan response `no-store`. Error menggunakan Problem
Details dengan `code` stabil; klien hanya menampilkan pesan dari allowlist.

| HTTP  | Path                                       | Fungsi                                           |
| ----- | ------------------------------------------ | ------------------------------------------------ |
| GET   | `/api/v1/admin/shifts`                     | Daftar shift dari server, termasuk status aktif. |
| POST  | `/api/v1/admin/shifts`                     | Buat shift.                                      |
| PATCH | `/api/v1/admin/shifts/:shiftId`            | Ubah hanya field yang dikirim.                   |
| POST  | `/api/v1/admin/shifts/:shiftId/deactivate` | Tandai shift tidak aktif; bukan hard delete.     |

Input create memerlukan `name`, `startTime`, `endTime`, dan `workDays`; `breakMinutes`,
`lateToleranceMinutes`, serta `isActive` opsional pada kontrak server. Bila tidak dikirim,
schema server memberi default 0 untuk kedua nilai menit dan `true` untuk status aktif. Input
update menerima subset field tersebut. Waktu menerima format `HH:mm` atau `HH:mm:ss`; menit
adalah integer non-negatif dan `workDays` adalah array unik berisi minimal satu angka ISO
1–7 (Senin–Minggu). Jam mulai dan selesai yang sama ditolak server.

DTO response memuat `id`, `name`, `startTime`, `endTime`, `breakMinutes`,
`lateToleranceMinutes`, `workDays`, `isActive`, `createdAt`, dan `updatedAt`. Deaktivasi
menerima body kosong atau tanpa body dan mengembalikan DTO shift. Tidak tersedia endpoint
hard-delete. UI katalog memakai default aktif server saat membuat shift, tidak mengirim
perubahan `isActive` melalui PATCH, dan hanya menonaktifkan melalui endpoint khusus setelah
konfirmasi.

## Admin penugasan shift per karyawan — BE-012

Semua endpoint memakai sesi cookie Admin dan response `no-store`. Penugasan adalah per
karyawan; kontrak belum menyediakan assignment kelompok. `storeId = null` berarti cakupan
global/seluruh toko. `effectiveFrom` dan `effectiveTo` inklusif. Pemeriksaan overlap dan
validasi histori dilakukan oleh server; klien tidak mensimulasikan aturan konflik.

| HTTP  | Path                                                       | Fungsi                                                                                    |
| ----- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| GET   | `/api/v1/admin/shift-assignments`                          | Daftar; filter opsional `employeeId`, `storeId=global\|<UUID>`, `businessDate`.           |
| POST  | `/api/v1/admin/shift-assignments`                          | Buat assignment per karyawan.                                                             |
| PATCH | `/api/v1/admin/shift-assignments/:assignmentId`            | Ubah subset `workShiftId`, `storeId`, `effectiveFrom`, `effectiveTo`; bukan patch kosong. |
| POST  | `/api/v1/admin/shift-assignments/:assignmentId/deactivate` | Tetapkan `effectiveTo` inklusif; bukan hard delete.                                       |

Create menerima `{ employeeId, workShiftId, storeId?, effectiveFrom, effectiveTo? }`;
`storeId` dapat UUID atau `null` untuk cakupan global. Patch menerima subset field yang sama
kecuali `employeeId`; klien mengirim hanya field yang berubah. Endpoint deactivation menerima
body `{ "effectiveTo": "YYYY-MM-DD" }`. Create mengembalikan HTTP 201; daftar, patch, dan
deactivation mengembalikan DTO HTTP 200.

DTO assignment memuat `id`, `employeeId`, `workShiftId`, `storeId`,
`assignedByUserAccountId`, `effectiveFrom`, `effectiveTo`, `createdAt`, objek `employee`
(`id`, `nik`, `fullName`, `status`), dan objek `workShift` lengkap (DTO katalog shift).
Daftar dapat memuat assignment historis maupun mendatang; jangan menyimpulkan status
attendance dari assignment atau rentang tanggalnya.

Form Admin hanya menawarkan employee `ACTIVE`, shift `ACTIVE`, dan toko `ACTIVE` yang sudah
menjadi assignment employee-store. Referensi memakai endpoint Admin employees, stores,
employee-store assignments, dan shifts yang sudah tersedia. Filter UI bukan pengganti
otorisasi/validasi server. Konflik ditampilkan hanya melalui pesan Indonesia dari allowlist;
response detail mentah tidak ditampilkan. Tidak ada endpoint delete assignment.

Catatan implementasi: repository create assignment saat ini hanya memeriksa keberadaan
employee, belum memeriksa status employee `ACTIVE`. Karena task ini dibatasi ke frontend/docs/test,
UI tetap memfilter employee aktif, tetapi request API langsung masih berpotensi membuat
assignment untuk employee nonaktif. Validasi status di server perlu ditangani pada task backend
terpisah sebelum filter UI dianggap sebagai enforcement.

## Admin hari libur — BE-012

Semua endpoint memakai sesi cookie Admin dan response `no-store`. Error menggunakan Problem
Details dengan `code` stabil; klien hanya menampilkan pesan dari allowlist. `holidayDate`
menggunakan tanggal kalender `YYYY-MM-DD`; waktu bisnis lain tetap ditentukan oleh API.

| HTTP   | Path                                | Fungsi                                                      |
| ------ | ----------------------------------- | ----------------------------------------------------------- |
| GET    | `/api/v1/admin/holidays`            | Daftar hari libur; filter opsional `from`, `to`, `storeId`. |
| POST   | `/api/v1/admin/holidays`            | Buat hari libur.                                            |
| PATCH  | `/api/v1/admin/holidays/:holidayId` | Ubah subset `storeId`, `holidayDate`, `description`.        |
| DELETE | `/api/v1/admin/holidays/:holidayId` | Hapus setelah konfirmasi Admin; response HTTP 204.          |

Filter GET tanpa `storeId` mengembalikan semua scope; `storeId=national` mengembalikan libur
nasional saja; UUID mengembalikan libur untuk toko tersebut. `from` dan `to` adalah batas tanggal
inklusif. Nasional disimpan dengan `storeId: null`, sedangkan libur toko menggunakan UUID toko.

Create menerima `{ holidayDate, description, storeId? }`; response HTTP 201 dan PATCH HTTP 200
mengembalikan DTO `{ id, storeId, holidayDate, description, createdAt }`. Untuk scope nasional,
client mengirim `storeId: null`. PATCH hanya mengirim field yang berubah dan tidak menerima patch
kosong. DELETE tidak melakukan hard delete di client sebelum server mengembalikan HTTP 204.

Keunikan tanggal per scope ditegakkan oleh database/server; konflik dikirim sebagai
`HOLIDAY_DATE_CONFLICT`. Server juga menjadi otoritas untuk validasi toko dan tanggal. Proteksi
tanggal closing bulanan belum menjadi bagian BE-012 dan baru menunggu pekerjaan BE-026; client
tidak menambahkan lock atau menganggap hari libur otomatis tersedia dari kalender nasional.

## Workflow verifikasi attendance — BE-017

Semua endpoint memerlukan cookie sesi dan mengirim `Cache-Control: no-store`. Queue, detail,
URL selfie, dan keputusan hanya untuk Admin/Supervisor; Employee menerima 403. Cakupan
Supervisor ditentukan server melalui relasi `SupervisorStoreAssignment` yang dikelola Admin,
bukan dari `EmployeeStore.assignedByUserAccountId` atau nilai request. Attendance dengan
`storeId: null` tidak dapat diakses Supervisor. Filter `storeId` dari query hanya mempersempit
hasil dan tidak dapat memperluas assignment. Data di luar scope menghasilkan hasil kosong pada
queue atau 404 pada detail/selfie/keputusan.

### GET `/api/v1/attendance/verifications`

Membaca antrean record aktif berstatus `PENDING_VERIFICATION`. Query opsional: `page` (default 1,
minimum 1), `pageSize` (default 25, maksimum 50), dan `storeId` (UUID; irisan dengan scope actor).
Urutan antrean memakai waktu server tertua lebih dahulu. Tiap item memuat employee, toko, jenis
dan tanggal kerja, `serverTime` asli, `deviceTime` dari perangkat, `dueAt` (= `serverTime` + 24 jam),
`overdue` yang dihitung saat dibaca, status, method/network, nama perangkat bila tersedia,
koordinat/accuracy/distance bila tersedia, selfie signed GET URL sementara bila evidence masih
tersedia, dan hingga 10 attendance sebelumnya yang relevan. IP mentah, hash perangkat, object key,
dan credential storage tidak dikembalikan. Signed URL harus diperlakukan sebagai rahasia dan
tidak disimpan/log oleh client.

### GET `/api/v1/attendance/verifications/:attendanceId`

Mengembalikan evidence dan riwayat dengan bentuk item queue yang sama. Hanya attendance aktif
yang masih pending dan berada dalam scope actor yang ditemukan; selain itu 404.

### GET `/api/v1/attendance/verifications/:attendanceId/selfie-url`

Menerbitkan signed GET URL sementara untuk selfie private yang belum melewati retensi. Akses
Supervisor dicek ulang terhadap assignment store di query storage-intent server-side; URL tidak
public dan response no-store. Attendance di luar scope, store null, evidence hilang, atau evidence
kedaluwarsa tidak mengungkap keberadaan objek dan menghasilkan 404.

### POST `/api/v1/attendance/verifications/:attendanceId/decision`

Memerlukan `Origin` yang sama dengan konfigurasi aplikasi. Body strict:

```json
{ "decision": "REJECTED", "reason": "Bukti lokasi perlu diperiksa ulang" }
```

`decision` adalah `APPROVED | REJECTED`; rejection wajib memiliki reason setelah trim (maksimum
500 karakter). Hanya transisi dari `PENDING_VERIFICATION` diterima. Server menjalankan conditional
update dan audit dalam satu transaksi serializable; perubahan status, audit, dan notification
internal bersifat atomik. Konflik, keputusan ulang, atau replay menghasilkan 409. Approval/rejection
hanya mengubah status review dan metadata reviewer; `serverTime`, `deviceTime`, serta waktu kerja
asli tidak diubah. Audit menyimpan status dan reason yang diperlukan, tanpa koordinat, IP/hash
perangkat mentah, foto, signed URL, object key, atau secret storage. Notification hanya ditujukan
ke akun yang tertaut ke employee; jika `Employee.accountId` null, notification tidak dibuat dan
tidak dialihkan ke akun reviewer. Tidak ada identitas/data pribadi tambahan yang ditulis untuk
kasus tanpa akun.

SLA 24 jam hanya dihitung sebagai `dueAt`/`overdue` dari server time asli. Tidak ada job yang
mengubah status atau timestamp otomatis karena SLA terlewati.

## Sumber assignment Supervisor — Admin only

`GET /api/v1/admin/supervisor-store-assignments` menerima filter opsional
`supervisorUserAccountId` dan `storeId`. `POST` pada path yang sama menerima UUID keduanya untuk
membuat assignment; target akun harus ber-role Supervisor dan toko harus ada. `DELETE
/api/v1/admin/supervisor-store-assignments/:supervisorUserAccountId/:storeId` menghapus assignment.
Semua route menolak non-Admin; perubahan menulis audit dalam transaksi. Model hanya mencatat
relasi saat ini dan metadata pembuat/waktu, tanpa tanggal efektif atau status kebijakan tambahan.

## Pekerjaan yang masih di luar kontrak aktif

BE-015 (selfie privat/retensi), BE-016 (aturan check-in/out), BE-017 (workflow verifikasi), dan
BE-018 (offline sync) tersedia secara lokal. Liveness server-side, status akhir hari
`Tidak absen pulang`, dan belum seluruh UI absensi/pengajuan/laporan terhubung ke API. Record
`PENDING_VERIFICATION` tetap provisional dan bukan kehadiran valid/disetujui sampai diputuskan.

## Pengajuan karyawan (BE-021)

`/api/v1/attendance/requests` menyediakan `POST` create dan `GET` list. Request type yang
didukung hanya `LEAVE`, `SICK`, `ANNUAL_LEAVE`, dan `OVERTIME`; `CORRECTION` tetap menjadi
alur BE-022. ID karyawan selalu diambil dari sesi, bukan body. Body bersifat strict, sehingga
`employeeId`, `status`, approver, dan field selain kontrak ditolak.

```json
{
  "requestType": "SICK",
  "startDate": "2026-10-12",
  "endDate": "2026-10-12",
  "reason": "Tidak dapat masuk kerja",
  "doctorNote": { "contentType": "image/jpeg", "dataBase64": "..." }
}
```

Rentang tanggal harus valid dan tidak terbalik. Pengajuan aktif (PENDING/APPROVED) oleh
karyawan yang sama tidak boleh tumpang tindih. Pengajuan lembur memerlukan `requestedOvertimeMinutes`
berupa integer positif; field ini dilarang untuk tipe lain. Pengajuan sakit memerlukan foto
surat dokter JPEG/PNG/WebP, maksimal 5 MiB. File dikirim ke API, diverifikasi signature-nya,
dan diberi object key acak pada prefix `attendance-requests/doctor-notes/`. Adapter, prefix,
dan signed-read path terpisah dari selfie; tidak ada lifecycle/retention selfie yang diterapkan.

`GET /api/v1/attendance/requests/:requestId` dan
`GET /api/v1/attendance/requests/:requestId/attachment-url` hanya membuka data milik karyawan
atau reviewer yang berwenang. Object key tidak pernah dikembalikan. URL lampiran hanya
diterbitkan sesudah authorization server-side, berumur 120 detik, no-store, dan memakai
disposition download. Karyawan tanpa profil Employee tertaut tidak dapat membuka detail atau
menerbitkan URL lampiran.

`POST /api/v1/attendance/requests/:requestId/decision` menerima `{ "decision": "APPROVED" |
"REJECTED", "decisionNote": "..." }`. Keputusan hanya berlaku selama status PENDING; catatan
wajib. Admin dapat memutus semua pengajuan. Supervisor hanya dapat memutus pengajuan yang
jadwalnya membuktikan satu store unik pada rentang itu, store tersebut ditugaskan kepada
karyawan dan Supervisor, dan tidak ada jadwal global/multi-store yang ambigu. Supervisor dapat
melihat pengajuan lembur dalam scope tersebut, tetapi keputusan lembur ditolak dengan
`REQUEST_REQUIRES_ADMIN`; hanya Admin yang dapat menyelesaikannya. Kondisi scope ambigu juga
hanya dapat diputus Admin. Untuk keputusan, repository memeriksa assignment Supervisor lebih
dahulu dengan seleksi scope terbatas; detail pengajuan hanya dibaca setelah akses terbukti.
Permintaan tanpa jadwal relevan di toko Supervisor (termasuk ID acak dan toko lain) memakai
respons 404 yang sama. Jadwal relevan yang beririsan dengan toko Supervisor tetapi ambigu tetap
menghasilkan `REQUEST_REQUIRES_ADMIN`. Status diperiksa setelah scope otorisasi terbukti.
Perubahan status dan audit log dibuat dalam transaksi yang sama.

PRD FR-28 mengizinkan Supervisor memutus lembur, sedangkan FR-30 hanya menghitung lembur
yang disetujui Admin. Karena schema/status tidak memiliki tahap konfirmasi kedua dan keputusan
hanya dapat dilakukan dari PENDING, API fail closed untuk keputusan Supervisor agar request
tidak menjadi final APPROVED tetapi tidak terhitung dan tidak dapat diputus ulang.
`approvedOvertimeMinutes` hanya berisi menit pada request OVERTIME berstatus APPROVED yang
approver-nya Admin. Alur Supervisor untuk lembur tetap PARTIAL sambil menunggu konfirmasi
pemilik produk atau pilihan model approval.

Private bucket policy, provider ACL/encryption/retention, dan signed URL tidak dapat diverifikasi
tanpa konfigurasi storage nyata. Jangan menganggap prefix aplikasi saja membuat bucket private.

## Dashboard, status pribadi, dan notifikasi — BE-024

Semua route memakai session dan `/api/v1`; response dashboard/notifikasi menggunakan
`Cache-Control: no-store`. Business date dihitung dari waktu server dalam `Asia/Jakarta` sesuai
PRD NFR-07; `TIMEZONE` kosong/tidak disetel memakai default tersebut dan nilai lain ditolak saat
API mulai. Jam browser tidak menjadi sumber perhitungan. Tanggal query harus berbentuk kalender valid
`YYYY-MM-DD` (misalnya `2026-02-30` ditolak) dan tidak boleh melewati tanggal bisnis server;
tanggal masa depan menghasilkan 400 `INVALID_DASHBOARD_INPUT`. Page maksimal 10.000 dan
`pageSize` maksimal 50.

### GET `/api/v1/dashboard`

Hanya Admin dan Supervisor. Filter opsional: `date`, `storeId`, `shiftId`, `page`, `pageSize`.
Store dan shift adalah irisan (AND) dengan scope actor. Admin melihat seluruh scope; Supervisor
hanya melihat pasangan employee/shift/store hasil query jadwal yang toko-nya ada pada relasi
`SupervisorStoreAssignment` milik session. Filter request tidak memperluas assignment itu.

Response berisi `summary`, `notCheckedIn`, `trend`, dan `lateRanking`. `summary` menghitung
status per shift terjadwal untuk tanggal pilihan: `present`, `late`, `notCheckedIn`, `absent`,
`leave`, `sick`, `annualLeave`, `waitingVerification`, `pendingRequests`, dan `scheduledShifts`.
`notCheckedIn` pada summary hanya menghitung status `NOT_CHECKED_IN`; field daftar paginasi
`notCheckedIn.items` mencakup status `NOT_CHECKED_IN` dan `ABSENT`, dengan `status` eksplisit
pada setiap item. Status izin/sakit/cuti berasal dari pengajuan berstatus `APPROVED`; status
pengajuan `PENDING` ditampilkan terpisah dan bukan dianggap cuti yang disetujui.

Trend berisi 30 tanggal kalender inklusif dari `date - 29 hari` sampai `date`. Ranking
menggunakan window tanggal yang sama, maksimum 10 orang, urut berdasarkan jumlah shift berstatus
terlambat menurun, lalu total `minutesAfterScheduledStart` menurun, nama, dan ID. `lateDays`
hanya angka hari berbeda dengan keterlambatan dan bukan kunci urut pertama.

Audit absensi menyimpan `isLate` sebagai klasifikasi yang sudah memperhitungkan toleransi shift.
`minutesAfterScheduledStart` tetap durasi server check-in sejak waktu mulai shift terjadwal,
sehingga nilainya **mencakup masa toleransi**. Itu bukan net “menit telat”; API memakai nama
`minutesAfterScheduledStart` dan `totalMinutesAfterScheduledStart` supaya konsumen tidak
menafsirkannya sebagai durasi setelah grace period. Ranking tidak mengurangi toleransi dari
nilai tersebut.

`ABSENT` hanya ditampilkan jika ada row `daily_attendance_statuses` berstatus `ABSENT` yang
dibuat job harian. Job existing baru eligible pada waktu akhir shift + 2 jam (untuk shift malam,
akhir pada tanggal kalender berikutnya). Sebelum cutoff, status tanpa absensi tetap
`NOT_CHECKED_IN`. Sesudah cutoff tetapi sebelum job sukses menulis row, status juga tetap
`NOT_CHECKED_IN`; dashboard tidak menyimpulkan `ABSENT` hanya dari jam. Karena itu scheduler job
harus berjalan dan dipantau. Item `notCheckedIn` dapat berisi kedua status agar Admin tetap dapat
menindaklanjuti keduanya.

`date` menentukan tanggal summary sekaligus ujung window trend/ranking. Tanggal masa depan ditolak
agar shift yang belum berlangsung tidak dihitung sebagai `NOT_CHECKED_IN` atau absent.

### GET `/api/v1/me/dashboard`

Hanya Employee dengan profil yang tertaut pada akun session. Tidak menerima `employeeId`, `date`,
atau filter scope dari client. Query riwayat menerima `historyPage` (default 1), `historyPageSize`
(default 20, maksimum 50), serta filter kalender opsional `historyFrom` dan `historyTo` dengan
format `YYYY-MM-DD`. Masing-masing batas boleh dikirim sendiri; jika keduanya dikirim, nilai awal
harus tidak setelah nilai akhir. Batas inklusif terhadap `workDate` attendance (`>= historyFrom`,
`<= historyTo`), divalidasi sebagai tanggal kalender server-side, dan tidak membatasi tanggal
status hari ini atau daftar request. Tanggal masa depan pada filter history boleh menghasilkan
riwayat kosong. Paginasi stabil berdasarkan `workDate DESC`, `serverTime DESC`, `id DESC`.

Response menyertakan status shift hari ini, riwayat attendance terfilter/paginasi (waktu server,
jenis, status validasi, store/shift), dan status pengajuan pribadi paginasi. Item shift menyertakan
`scheduledStartTime` serta `scheduledEndTime` sebagai jam wall-clock `HH:mm:ss` langsung dari
`WorkShift`; nilainya bukan instant dan shift malam boleh memiliki waktu akhir yang lebih kecil
daripada waktu mulai. Data pribadi tidak mengembalikan reason, lampiran, lokasi, atau evidence.
Saldo/sisa cuti sengaja tidak ada pada response: schema belum memiliki entitlement, accrual, atau
ledger kuota cuti yang dapat menjadi sumber saldo tepercaya.

Pada status shift, check-in `VALID`/`APPROVED` tanpa check-out `VALID`/`APPROVED` menghasilkan
`MISSING_CHECKOUT` (“Ada masuk tanpa pulang”). Jika ada attendance `PENDING_VERIFICATION` atau
`PENDING_OFFLINE`, status tetap `WAITING_VERIFICATION` sesuai prioritas yang ada; holiday juga tetap
diprioritaskan. Checkout yang valid/disetujui mempertahankan klasifikasi `PRESENT`/`LATE`. Ringkasan
dashboard Admin/Supervisor tidak menambahkan counter `MISSING_CHECKOUT`.

### GET `/api/v1/notifications`

Admin, Supervisor, dan Employee membaca notifikasi internal milik akun session saja. Query
opsional: `read=ALL|READ|UNREAD` (default `ALL`), `page` (default 1), dan `pageSize` (default 25,
maksimum 50). Response memberi `items`, pagination, `hasNextPage`, dan `unreadCount` untuk seluruh
notifikasi belum dibaca pada akun itu. Payload internal tidak dikembalikan.

### PATCH `/api/v1/notifications/:notificationId/read`

Memerlukan session dan same-origin `Origin`. Perubahan hanya memakai kombinasi ID notifikasi,
`userAccountId` session, dan kondisi belum dibaca. Mengulang mark-read atas notifikasi milik akun
yang sama mengembalikan waktu baca awal; notifikasi akun lain tampak sebagai 404. Endpoint ini
hanya mengubah status baca, bukan memutus pengajuan atau verifikasi.

Event internal: request baru mengirim satu event generik kepada setiap akun Admin aktif; keputusan
request mengirim event kepada akun Employee tertaut; attendance baru berstatus pending verifikasi
mengirim event generik kepada Admin aktif. Event dibuat di transaksi yang sama dengan create atau
decision terkait. Keputusan verifikasi BE-017 tetap menjadi event terpisah ke akun Employee dan
tetap atomik dengan status/audit. Tidak ada provider eksternal, dan payload/message tidak memuat
reason pengajuan, lokasi, selfie, atau data medis.
