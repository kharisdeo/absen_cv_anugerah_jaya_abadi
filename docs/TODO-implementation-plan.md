# TODO Implementasi Website Absensi CV Anugerah Jaya Abadi

Dokumen ini adalah backlog eksekusi berdasarkan [PRD versi 2.0](./PRD.md). Tujuannya agar developer atau GPT Luna dapat mengerjakan sistem secara berurutan tanpa menebak aturan bisnis.

## 0. Instruksi Eksekusi untuk GPT Luna

1. Baca `docs/PRD.md` dan dokumen ini sebelum menulis kode.
2. Kerjakan task berdasarkan urutan prioritas dan dependensi. Jangan melompati task P0 yang menjadi prasyarat.
3. Jangan mengganti aturan bisnis, status, batas waktu, default, atau hak akses tanpa keputusan eksplisit dari pemilik proyek.
4. Jika requirement teknis belum menentukan library, pilih library yang paling kecil dan stabil, dokumentasikan pilihan di `docs/DECISIONS.md`, lalu lanjutkan. Jangan mengubah perilaku bisnis.
5. Semua waktu bisnis menggunakan `Asia/Jakarta`; simpan timestamp server dalam format timezone-aware. Jangan memakai waktu browser sebagai sumber perhitungan.
6. Semua endpoint wajib memeriksa autentikasi, role, kepemilikan data, dan scope toko di server. UI hiding bukan security.
7. Jangan membuat input upload foto untuk absensi. Foto absensi harus berasal dari stream kamera langsung.
8. Jangan meminta lokasi saat aplikasi tidak sedang menjalankan proses absensi. Tidak ada background tracking.
9. Jangan mengubah absensi asli saat koreksi. Buat record koreksi baru yang menunjuk record asli dan tulis audit log.
10. Jangan menyamakan `Perlu verifikasi`, `Absen tertunda`, dan `Tidak hadir`. Ketiganya berbeda.
11. Setiap task harus menghasilkan: perubahan kode, test yang relevan, dokumentasi singkat, dan bukti verifikasi.
12. Setelah setiap kelompok task selesai, jalankan lint, type-check, unit test, dan build yang tersedia. Jangan menandai selesai hanya karena aplikasi dapat dibuka.

## 1. Decision Lock yang Tidak Boleh Diubah

Nilai berikut berasal dari PRD dan harus menjadi konfigurasi terpusat, bukan hard-code tersebar:

| Key                                       |     Nilai awal | Catatan                                                             |
| ----------------------------------------- | -------------: | ------------------------------------------------------------------- |
| `timezone`                                | `Asia/Jakarta` | Wajib untuk perhitungan bisnis dan tampilan default.                |
| `default_store_radius_m`                  |           `10` | Radius setiap toko dapat diubah Admin.                              |
| `default_gps_accuracy_limit_m`            |           `30` | Batas akurasi setiap toko dapat diubah Admin.                       |
| `gps_retry_window_seconds`                |           `60` | Percobaan ulang lokasi maksimal 60 detik.                           |
| `offline_sync_deadline_hours`             |           `24` | Lewat batas menjadi `Perlu verifikasi`.                             |
| `device_time_drift_limit_minutes`         |            `5` | Selisih waktu device/server lebih besar menjadi `Perlu verifikasi`. |
| `verification_sla_hours`                  |           `24` | SLA verifikasi oleh Admin/Supervisor.                               |
| `correction_submission_deadline_workdays` |            `3` | Pengajuan koreksi maksimal H+3 hari kerja.                          |
| `correction_decision_sla_workdays`        |            `2` | SLA keputusan koreksi oleh Admin.                                   |
| `monthly_closing_day`                     |            `3` | Closing tanggal 3 bulan berikutnya.                                 |
| `selfie_retention_months`                 |           `12` | Foto dihapus otomatis; angka absensi tetap disimpan.                |
| `max_selfie_size_kb`                      |          `200` | Batas target foto sebelum dikirim.                                  |
| `max_attendance_payload_kb`               |          `300` | Target total payload satu absensi.                                  |
| `admin_idle_timeout_minutes`              |           `30` | Sesi admin.                                                         |
| `employee_idle_timeout_days`              |            `7` | Sesi karyawan.                                                      |
| `login_failure_limit`                     |            `5` | Setelah itu akun dikunci.                                           |
| `login_lock_minutes`                      |           `15` | Durasi lockout.                                                     |

Nilai yang masih harus dikonfirmasi bisnis, tetapi tidak boleh ditebak oleh developer:

- Toko mana saja dan koordinatnya.
- Supervisor mana yang ditugaskan ke toko tertentu.
- Apakah QR, Wi-Fi, dan konfirmasi supervisor diaktifkan semuanya atau sebagian.
- Format instruksi liveness yang dipakai pada perangkat target.
- Provider notifikasi dan 2FA.
- Target provider staging sudah ditetapkan terpisah di `docs/DECISIONS.md`; hal yang
  masih perlu keputusan adalah domain dan provider/cloud/object storage production serta
  email pengirim. Jangan menganggap pilihan staging berlaku untuk production.

## 2. Definisi Prioritas dan Definition of Done

- **P0 - wajib sebelum MVP dipakai:** keamanan, login, data inti, absensi online/offline, validasi, hak akses, dan audit dasar.
- **P1 - wajib untuk operasi bisnis:** pengajuan, approval, dashboard, rekap, Excel, closing, notifikasi, backup, dan pemulihan.
- **P2 - penguatan operasional:** QR, Wi-Fi, konfirmasi supervisor, grafik lanjutan, 2FA, dan liveness lebih kuat.
- **P3 - backlog setelah stabil:** optimasi lanjutan dan peningkatan UX/analitik yang tidak mengubah aturan inti.

Task dianggap selesai jika:

- acceptance criteria task terpenuhi;
- unit/integration/e2e test yang relevan lulus;
- authorization negatif sudah diuji;
- error dan audit log tersedia untuk aksi yang diwajibkan;
- dokumentasi API/config diperbarui;
- tidak ada secret, foto asli, token, atau data produksi di repository;
- perubahan dapat dijalankan ulang dari README pada environment bersih.

## 3. Urutan Besar Pengerjaan

```text
BE-001..BE-010 (fondasi dan database)
        |
        +--> FE-001..FE-008 (shell PWA dan autentikasi)
        |
        +--> BE-011..BE-027 (absensi, GPS, offline, status, reports)
                        |
                        +--> FE-009..FE-017 (kamera, GPS, queue, dashboard, reports)
                                        |
                                        +--> BE/FE pengajuan, admin, laporan
                                                        |
                                                        +--> INT-001..INT-020 (e2e, security, device matrix)
                                                                        |
                                                                        +--> DEP-001..DEP-015 (staging, produksi, backup, monitoring)
```

Paralelisasi boleh dilakukan hanya jika dependensi kontrak API, schema, enum, dan acceptance criteria sudah ditulis.

# A. Backend

## A1. Fondasi backend dan data - P0

### BE-001 - Tetapkan arsitektur dan standar backend [P0]

- Pilih framework backend REST sesuai stack proyek.
- Tetapkan struktur module: `auth`, `employee`, `store`, `schedule`, `attendance`, `request`, `report`, `audit`, `notification`, `backup`.
- Tetapkan formatter, linter, type-check, test runner, error format, logging, dan environment config.
- Tetapkan API prefix/version, misalnya `/api/v1`.
- Jangan memasukkan payroll, fingerprint, atau face recognition otomatis.

**Selesai jika:** aplikasi dapat start di local, health endpoint tersedia, lint/type-check/test/build dasar berjalan, dan keputusan stack tercatat.

### BE-002 - Konfigurasi environment dan secrets [P0]

- Buat `.env.example` tanpa secret asli.
- Pisahkan `development`, `test`, `staging`, dan `production`.
- Sediakan config typed untuk database, JWT/session, storage, mail/notifikasi, timezone, retention, dan feature flags.
- Fail fast jika secret wajib kosong di staging/production.
- Jangan log password, token, foto, signed URL, atau payload sensitif.

**Selesai jika:** aplikasi tidak bergantung pada nilai rahasia yang di-hard-code dan environment yang salah menghasilkan error yang jelas.

**BE-002A — verifikasi fail-fast dan redaksi config:** `apps/api/test/config-env.test.ts` kini menguji staging/production menolak `DATABASE_URL` kosong, `SESSION_SECRET` kosong/pendek/kurang beragam, serta pasangan consent yang tidak lengkap; diagnostic invalid tidak boleh memuat sentinel password database, session secret, URL credential, storage key, atau teks kebijakan. Tidak ada perubahan config runtime dan tidak ada secret sungguhan yang dipakai. Parent `pnpm check` lulus: API 52 file / 467 tes, web 70 file / 384 tes, format/lint/typecheck, kedua build, dan asset budget 327.818/665.600 byte raw serta 100.303/184.320 byte gzip. Ini membuktikan test contract lokal; bukan validasi environment atau deployment staging/production.

### BE-003 - Skema database dan migration [P0]

Buat migration untuk minimal tabel berikut:

- `users` / `user_accounts`: username/NIK, password hash, role, status, first-login flag, failed attempts, locked-until, timestamps.
- `employees`: NIK, nama, jabatan, status aktif, relasi akun.
- `device_bindings`: employee, device ID hash, nama perangkat, status pending/approved/revoked, approver.
- `stores`: nama, latitude, longitude, radius, accuracy limit, Wi-Fi public IP, status aktif.
- `employee_stores`: assignment many-to-many.
- `work_shifts`: nama, jam masuk/pulang, istirahat, tolerance, hari kerja.
- `shift_assignments`: employee/group, shift, store, effective date.
- `holidays`: tanggal, keterangan, store scope.
- `attendances`: employee, type, server/device time, status, validation status, method, network status, proof code, device/IP metadata.
- `selfie_captures`: attendance, private object key, size, watermark, face/liveness flags, retention timestamp.
- `location_proofs`: attendance, coordinates, accuracy, distance, mock flag, source.
- `attendance_requests`: leave/sick/annual leave/overtime/correction, dates, reason, attachment, status, approver.
- `attendance_corrections`: original attendance, proposed values, reason, evidence, status.
- `system_disruptions`: time range, store, reason, active flag.
- `monthly_recaps`: period, store scope, status open/closed, closed by/at.
- `notifications`.
- `audit_logs`: append-only fields before/after, actor, IP, device, reason, timestamp.

Tambahkan foreign key, unique constraint, check constraint, index untuk employee/date/status/store, dan idempotency key untuk pengiriman absensi.

**Selesai jika:** migration fresh dan rollback/test database berhasil; constraint mencegah duplikasi absensi yang tidak diizinkan; audit log tidak memiliki update/delete API.

### BE-004 - Enum dan state machine [P0]

Definisikan enum terpusat, bukan string bebas:

- role: `ADMIN`, `SUPERVISOR`, `EMPLOYEE`;
- attendance type: `CHECK_IN`, `CHECK_OUT`;
- validation: `VALID`, `PENDING_VERIFICATION`, `APPROVED`, `REJECTED`, `PENDING_OFFLINE`;
- daily status: `PRESENT`, `LATE`, `EARLY_LEAVE`, `MISSING_CHECKOUT`, `WAITING_VERIFICATION`, `LEAVE`, `SICK`, `ANNUAL_LEAVE`, `HOLIDAY`, `ABSENT`;
- request type: `LEAVE`, `SICK`, `ANNUAL_LEAVE`, `OVERTIME`, `CORRECTION`;
- request status: `PENDING`, `APPROVED`, `REJECTED`, `CANCELLED`.

Tulis transition yang sah. Contoh: `PENDING_OFFLINE -> VALID/PENDING_VERIFICATION`, `PENDING_VERIFICATION -> APPROVED/REJECTED`; tidak ada transisi langsung menjadi `ABSENT`.

**Selesai jika:** transition invalid ditolak oleh service dan memiliki unit test.

### BE-005 - Time, timezone, dan working-day service [P0]

- Semua server memakai `Asia/Jakarta` untuk aturan bisnis.
- Simpan timestamp dengan timezone/UTC yang dapat dikonversi, jangan gunakan string lokal tanpa zona.
- Buat service untuk hari kerja, hari libur nasional/toko, shift lintas tengah malam jika nanti dibutuhkan, toleransi, dan H+N hari kerja.
- Simpan `device_time` terpisah dari `server_time`.

**Selesai jika:** test mencakup pergantian tanggal, hari libur, akhir bulan, dan DST/offset tidak mengubah WIB.

### BE-006 - Authorization policy dan row-level scope [P0]

- Admin dapat semua scope.
- Supervisor hanya dapat employee/store yang ditugaskan.
- Employee hanya dapat record miliknya sendiri.
- Semua query detail/list/export memakai policy scope dari backend.
- Tolak IDOR: mengganti ID di URL tidak boleh membuka data orang lain.
- Jangan menganggap role dari request body; ambil dari session/token yang tervalidasi.

**Selesai jika:** test positif dan negatif tersedia untuk setiap endpoint utama.

### BE-007 - Audit log append-only [P0]

**Status: PARTIAL** — `AuditService`, route daftar Admin read-only (BE-007A), matrix coverage aksi aktif (BE-007B), dan audit event export bulanan BE-025 sudah ada. Workflow correction, monthly closing, dan override belum tersedia.

- Buat `AuditService` yang otomatis mencatat actor, action, entity, entity ID, before/after, reason, IP, device, timestamp.
- Wajib dipanggil untuk login failure/success, reset password, device approval, perubahan employee/store/radius/schedule, approval/rejection, correction, closing, export, permission change, disruption.
- [x] Sediakan read-only filter untuk Admin di `GET /api/v1/admin/audit-logs` dengan actor/action/entity/date filters dan pagination bounded; detail kontrak ada di `docs/API.md` dan `docs/openapi.yaml`.
- [x] API tidak mendaftarkan endpoint update/delete; tes method POST/PUT/PATCH/DELETE membuktikan respons 404 Problem Details.
- [x] Route tests memakai `AuditService` asli dan fake repository untuk memverifikasi Admin-only, query strict, filter/pagination, DTO allowlist, no-store, rate limit, serta akses role non-Admin ditolak sebelum `findMany`.
- [x] Audit regression untuk aksi aktif dipetakan ke event serta test path pada matrix di bawah; snapshot reset password sekarang mengambil nilai sebelum dan sesudah dari transaksi repository yang sama.
- [x] Export rekap bulanan mencatat event `monthly_report.export` berisi periode/filter serta request context, tanpa menyimpan workbook atau data attendance.
- [ ] Tambahkan audit events untuk correction, monthly closing, dan override setelah workflow/endpoint, aktor, state transition, serta kebijakan produk ditetapkan.

| Acceptance PRD / aksi aktif                                          | Source dan event/action                                                                                                                                                            | Test otomatis yang membuktikan                                                                                                      |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Login sukses/gagal, logout, ganti/reset password                     | `apps/api/src/modules/auth/service.ts`: `auth.login.success`, `auth.login.failure`, `auth.logout`, `auth.password.change`, `auth.password.reset`                                   | `apps/api/test/modules/auth-service.test.ts`; snapshot reset dari transaksi: `apps/api/test/modules/auth-prisma-repository.test.ts` |
| Pembuatan akun, perubahan role/permission atau status, nonaktif akun | `apps/api/src/modules/account/index.ts`: `account.create`, `account.update`, `account.deactivate`                                                                                  | `apps/api/test/modules/account.test.ts`                                                                                             |
| Perubahan data dan status karyawan                                   | `apps/api/src/modules/employee/index.ts`: `employee.create`, `employee.update`, `employee.deactivate`                                                                              | `apps/api/test/modules/employee.test.ts`                                                                                            |
| Pendaftaran, approval, pencabutan, dan reaktivasi device binding     | `apps/api/src/modules/device-binding/index.ts`: `device_binding.enrolled`, `device_binding.approved`, `device_binding.revoked`, `device_binding.reactivated`                       | `apps/api/test/modules/device-binding.test.ts`; `apps/api/test/modules/device-binding-admin.test.ts`                                |
| Perubahan toko/radius, assignment dan unassignment karyawan ke toko  | `apps/api/src/modules/store/index.ts`: `store.create`, `store.update`, `store.deactivate`, `store.employee_assigned`, `store.employee_unassigned`                                  | `apps/api/test/modules/store.test.ts`                                                                                               |
| Assignment dan unassignment toko untuk Supervisor                    | `apps/api/src/modules/supervisor-store-assignment/prisma-repository.ts`: `supervisor.store.assign`, `supervisor.store.unassign`                                                    | `apps/api/test/modules/supervisor-store-assignment.test.ts`                                                                         |
| Shift, assignment shift, dan hari libur                              | `apps/api/src/modules/schedule/index.ts`: `schedule.shift.{create,update,deactivate}`, `schedule.assignment.{create,update,deactivate}`, `schedule.holiday.{create,update,delete}` | `apps/api/test/modules/schedule.test.ts`                                                                                            |
| Penerimaan attempt, penolakan aturan, dan pencatatan attendance      | `apps/api/src/modules/attendance/prisma-repository.ts`: `attendance.attempt.create`, `attendance.attempt.rule_rejected`, `attendance.record.create`                                | `apps/api/test/modules/attendance-attempt-prisma-repository.test.ts`                                                                |
| Approve/reject verifikasi attendance                                 | `apps/api/src/modules/attendance/prisma-verification-repository.ts`: `attendance.verification.approve`, `attendance.verification.reject`                                           | `apps/api/test/modules/attendance-verification-prisma-repository.test.ts`                                                           |
| Pembuatan dan keputusan pengajuan yang tersedia                      | `apps/api/src/modules/attendance-requests/prisma-repository.ts`: `attendance_request.create`, `attendance_request.approve`, `attendance_request.reject`                            | `apps/api/test/modules/attendance-requests-prisma-repository.test.ts`                                                               |
| Pencatatan gangguan sistem                                           | `apps/api/src/modules/system-disruption/index.ts`: `system_disruption.create`                                                                                                      | `apps/api/test/modules/system-disruption.test.ts`                                                                                   |

Invariant bersama: `apps/api/test/modules/audit.test.ts` membuktikan actor, action/entity, before/after, reason, IP, device hash, dan timestamp yang disediakan repository/database; tes itu juga membuktikan sanitasi key sensitif. `apps/api/test/routes/audit-logs.test.ts` membuktikan route mutasi tidak tersedia. Trigger append-only PostgreSQL dan transaksi produksi tidak dijalankan terhadap database live pada task ini.

**Selesai jika:** test membuktikan audit dibuat pada aksi wajib dan endpoint update/delete mengembalikan 405/403/404 sesuai desain.

## A2. Auth dan master data - P0

### BE-008 - Login, lockout, session, reset [P0]

- Login username/NIK + password hash bcrypt/Argon2.
- Lima gagal login mengunci akun 15 menit.
- Catat login/gagal login di audit log tanpa menyimpan password.
- Timeout Admin 30 menit; Karyawan 7 hari.
- Reset password oleh Admin; first login wajib ganti password.
- Gunakan cookie HttpOnly/Secure/SameSite atau mekanisme token yang setara.
- Tambahkan rate limit login dan endpoint sensitif.

**Selesai jika:** seluruh FR-01 sampai FR-06 dan skenario lockout/timeout diuji.

### BE-009 - Consent dan privacy policy [P0]

- Endpoint menyimpan versi consent, waktu, user, purpose, dan data yang disetujui.
- Login pertama memblokir fitur sampai consent diterima dan password diganti bila wajib.
- Buat endpoint riwayat consent read-only untuk user/admin sesuai policy.

**Selesai jika:** consent tidak dapat dipalsukan dari client dan versi policy yang diterima tersimpan.

### BE-010 - CRUD employee, account, device binding [P0]

- CRUD employee dan akun oleh Admin.
- Validasi NIK/username unik dan status aktif.
- Device binding otomatis pending pada login/perangkat pertama sesuai desain; maksimal satu device aktif.
- Ganti perangkat harus approval Admin; revoke perangkat lama mengakhiri aksesnya.
- Pastikan minimal dua Admin aktif sebelum Admin dihapus/dinonaktifkan.

**Selesai jika:** CRUD, approval/revoke, validasi minimal dua Admin, audit, dan scope test lulus.

### BE-011 - CRUD store dan assignment [P0]

- CRUD toko: koordinat, radius default 10 m, accuracy default 30 m, IP Wi-Fi opsional, status.
- Assign employee ke satu/beberapa toko.
- Validasi latitude/longitude/radius/accuracy range.
- Simpan perubahan radius/koordinat sebagai audit.

**Selesai jika:** employee hanya dianggap valid di toko yang ditugaskan dan perubahan config tidak mengubah histori absensi lama.

### BE-012 - CRUD shift, assignment, holiday [P0]

- CRUD shift, jam masuk/pulang, istirahat, hari kerja, toleransi.
- Assignment per employee/group dan store dengan effective dates.
- CRUD hari libur nasional dan toko.
- Hindari overlapping assignment yang ambigu atau tolak secara eksplisit.

**Selesai jika:** service dapat menemukan shift efektif untuk employee/store/date dan test konflik assignment tersedia.

## A3. Attendance engine - P0

### BE-013 - Contract create attendance attempt [P0]

Buat endpoint terproteksi untuk mengirim percobaan absensi dengan payload minimal:

```json
{
  "idempotencyKey": "uuid",
  "type": "CHECK_IN",
  "clientRecordedAt": "ISO-8601",
  "networkStatus": "ONLINE",
  "location": { "latitude": 0, "longitude": 0, "accuracyMeters": 0 },
  "validationMethod": "GPS",
  "selfie": { "blob": "multipart/private-upload-reference", "sizeKb": 180 },
  "liveness": { "faceDetected": true, "passed": true },
  "proofCode": null
}
```

Endpoint BE-013 memakai employee dan approved device binding dari authenticated session/server state; `deviceId` tidak dikirim oleh client. Server mengisi waktu penerimaan, IP, hash device dari binding, dan audit. Lokasi pada payload disimpan sebagai klaim attempt, bukan bukti tervalidasi. BE-013 belum memilih toko, menghitung distance, atau menetapkan status final; jangan menerima `employeeId`, `serverTime`, store, distance, atau status final dari client sebagai sumber kebenaran.

**Selesai jika:** schema validation, idempotency, duplicate prevention, payload-size limit, dan error contract terdokumentasi.

### BE-014 - Geospatial validation [P0]

- Hitung jarak server-side dengan formula geodesic yang konsisten.
- Pilih store hanya dari assignment employee atau minta `storeId` lalu validasi assignment.
- Valid jika `distance <= store.radius` dan `accuracy <= store.accuracyLimit`.
- Simpan distance dan accuracy yang dipakai untuk keputusan.
- Tandai mock location, impossible jump, dan koordinat berulang; jangan diam-diam menghapus attempt.

**Selesai jika:** test radius 10 m/30 m, boundary tepat, di luar radius, akurasi buruk, toko tidak ditugaskan, mock, dan repeated coordinate lulus.

### BE-015 - Selfie storage, watermark metadata, retention [P0]

- Terima hanya hasil capture kamera yang sudah dikompres; validasi mime/size/dimensi.
- Simpan object storage private, object key acak, bukan URL publik.
- Simpan metadata watermark nama/server time/coordinate; signed URL hanya untuk role berhak dan kedaluwarsa.
- Jadwalkan purge foto setelah 12 bulan tanpa menghapus data angka absensi.

**Selesai jika:** foto tidak dapat diakses anonymous, signed URL expired, retention job idempotent, dan karyawan tidak dapat membuka foto orang lain.

**Status implementasi lokal:** adapter/storage private, route upload/read, atomic attach, dan purge race-claim telah dibuat; API test dan typecheck lulus. Provider bucket, deployment scheduler harian, dan migration apply belum diverifikasi karena konfigurasi database/storage belum tersedia.

### BE-016 - Check-in/check-out business rules [P0]

- Satu employee/shift/date tidak boleh memiliki check-in duplikat yang valid.
- Check-out hanya setelah check-in pada shift yang sama.
- Lupa check-in mengembalikan error terarah ke koreksi; jangan membuat check-out palsu.
- Simpan raw attempts dan final attendance record sesuai desain.
- Hitung hadir/terlambat menggunakan server time + shift tolerance.

**Selesai jika:** duplicate, out-of-order, cross-shift, late, early leave, missing checkout, dan retry idempotent diuji.

**Status implementasi lokal:** aturan dan record `PENDING_VERIFICATION` tersedia; raw attempt/audit tetap tercatat saat rule ditolak. API test/typecheck lulus. Provisional check-in yang belum ditolak boleh dipasangkan dengan checkout; konfirmasi kebijakan ini masih diperlukan sebelum produksi. Pekerjaan akhir hari untuk status `Tidak absen pulang` belum termasuk BE-016.

### BE-017 - Verification workflow [P0]

- Buat queue `PENDING_VERIFICATION` yang memuat foto, map, accuracy, distance, method, device/network, waktu asli, dan riwayat relevan.
- Admin dapat approve/reject; Supervisor hanya scope tokonya.
- Approval mempertahankan waktu absensi asli.
- Reject wajib reason; keduanya membuat audit dan notification.
- SLA 24 jam menjadi metric/queue indicator, bukan perubahan waktu absensi.

**Selesai jika:** approval scope, reason wajib, state transition, audit, dan waktu asli diuji.

**Status implementasi lokal:** selesai pada BE-017. Scope Supervisor memakai tabel assignment
khusus yang dikelola Admin; store null dan toko yang tidak ditugaskan gagal tertutup. Keputusan,
audit, dan notification atomik; notification hanya dibuat untuk akun employee yang ada (tanpa
fallback ke reviewer). SLA dihitung sebagai indikator saja. Migrasi belum diterapkan ke database
karena belum ada database lokal yang dikonfigurasi.

### BE-018 - Offline sync [P0]

- Endpoint menerima queued attempt dengan idempotency key.
- Server membandingkan device time vs server time: >5 menit atau upload >24 jam => pending verification.
- Jika data wajar, liveness diverifikasi oleh server, GPS/geofence valid, koordinat tidak ditandai berulang, dan semua business rule lulus => validation status `VALID` dengan method/network `OFFLINE`; jangan membuat enum status baru tanpa keputusan bisnis. Liveness gagal/tidak terdeteksi/tidak dapat diverifikasi atau repeated-coordinate harus tetap `PENDING_VERIFICATION`.
- Attempt offline tidak dapat diedit/dihapus employee.
- Duplicate sync mengembalikan hasil attempt sebelumnya, bukan membuat record baru.

**Selesai jika:** airplane mode, delayed sync, clock manipulation, duplicate sync, invalid payload, dan offline invalid GPS diuji.

**Status implementasi lokal (BE-018 saja): selesai untuk penerimaan offline dan gate fail-closed.** Idempotensi, penyimpanan receipt,
penilaian waktu, raw attempt, metode/network, dan tes unit/repository/route tersedia. Gate fail-closed
menahan semua attempt offline di `PENDING_VERIFICATION` karena liveness saat ini hanya klaim client;
jalur `VALID` baru boleh dibuka setelah server dapat memverifikasi liveness dan syarat waktu,
GPS/geofence, repeated-coordinate, serta business rules lulus. Server receipt tetap menjadi sumber
business date/shift; attempt yang melintasi tengah malam WIB dapat terkait tanggal receipt atau
ditolak aturan shift, tidak pernah diam-diam memakai device time. Perubahan ke tanggal capture
memerlukan keputusan bisnis. Integration test PostgreSQL/migrasi belum dijalankan karena tidak ada
`DATABASE_URL` dan Docker daemon tidak aktif.

### BE-019 - Alternative validation feature flags [P1]

- QR dinamis memiliki token bertanda tangan, store scope, expiry 30-60 detik, dan replay prevention.
- Wi-Fi memeriksa public IP yang didaftarkan pada store; jangan mempercayai header client tanpa proxy trust config.
- Supervisor confirmation memakai authenticated supervisor, store scope, timestamp, dan reason.
- Feature dapat diaktifkan per store melalui config; kegagalan alternatif tetap menyimpan attempt.

**Selesai jika:** token expired/replay/store mismatch, IP mismatch, supervisor unauthorized, dan fallback-to-verification diuji.

### BE-020 - Daily status and absent job [P0]

- Status: PARTIAL — evaluator, persistence, CLI job, transactional guards, rekonsiliasi attendance, dan regression tests tersedia; batas offline lintas tanggal dan integrasi workflow correction/closing masih bergantung pada keputusan/pekerjaan terkait.
- `apps/api/src/jobs/daily-attendance-status.ts` dapat dijalankan melalui `pnpm --filter @absen/api daily-status:run`; scheduler production belum dikonfigurasi di repository. Evaluasi menggunakan `Asia/Jakarta`, shift end dari layanan time yang ada, dan grace tepat 2 jam. Kunci unik daily row adalah `(employee_id, shift_assignment_id, work_date)`, sehingga shift/lokasi berbeda pada hari yang sama tidak berbagi status.
- `ABSENT` hanya di-insert jika tidak ada attendance aktif VALID/APPROVED/PENDING_VERIFICATION/PENDING_OFFLINE yang terkait, request LEAVE/SICK/ANNUAL_LEAVE/CORRECTION berstatus PENDING/APPROVED yang mencakup tanggal, correction PENDING terkait, attempt RECEIVED yang belum punya attendance dalam window shift, disruption aktif yang overlap periode/store, atau recap CLOSED. Attendance dan attempt mentah tidak diubah/dihapus. Insert memakai unique-key `DO NOTHING` agar retry aman; hasil job `alreadyExists` hanya berarti key sudah memiliki row, bukan bahwa karyawan hadir.
- Evaluasi ulang dan insert berlangsung dalam transaksi setelah `SELECT employees ... FOR UPDATE`, memakai lock employee yang sama seperti pembuatan attendance. Perubahan jadwal, guard, holiday, attendance, dan closing diperiksa ulang dalam transaksi. Attempt RECEIVED dibatasi ke `received_at >= shift start`, `received_at <= shift end + 2 jam`, dan `received_at <= evaluatedAt`; attempt dari hari berikutnya tidak menahan absence shift lampau.
- Setelah attendance diterima, transaksi submission yang sama hanya merekonsiliasi daily row dengan employee/assignment/workDate yang persis sama, jika status masih ABSENT, belum ditandai koreksi, dan recap belum CLOSED. Status turunan ditetapkan dari validation status dan lateness server-side; operasi ini tidak mengubah raw Attendance/AttendanceAttempt. Attempt/attendance/persisted evidence berada di transaksi yang sama. `clientRecordedAt` tidak dipakai untuk menentukan workDate.
- Correction port tidak menerima status dari pemanggil. Repository memeriksa correction tersimpan berstatus APPROVED, request/schedule/store scope yang relevan, dan recap belum CLOSED; untuk correction CHECK_IN dengan `proposedServerTime`, status PRESENT/LATE dihitung ulang dari shift dan toleransi tersimpan. BE-022 belum menyediakan workflow/service pemanggil correction, dan belum ada service monthly-closing; integrasi serta disiplin lock employee yang sama pada proses closing masih harus diverifikasi saat task tersebut dibuat.
- Holiday tidak dipersist sebagai `HOLIDAY` oleh BE-020; job ini hanya memastikan tanggal non-kerja/libur tidak menjadi ABSENT. National holiday dan holiday pada assignment store tertentu dikenali langsung. Untuk assignment global (`store_id IS NULL`), holiday toko aktif yang terkait employee ditandai ambigu dan absence dilewati—tidak dipropagasikan menjadi holiday untuk semua toko dan tidak dibuat row HOLIDAY. Persistensi `HOLIDAY` diserahkan ke daily-summary/dashboard dengan aturan atribusi store yang jelas.
- Batas offline: server tidak dapat mengamati IndexedDB attempt yang belum tersinkron saat cutoff. Hook memulihkan false ABSENT bila submission kemudian diterima oleh aturan yang ada dan server-resolved `(employee, assignment, workDate)` cocok persis. Jika sync baru diterima setelah tanggal WIB berganti, pipeline yang ada memakai tanggal receipt server untuk resolusi shift (timestamp client bukan otoritas); kaitan ke shift hari sebelumnya tidak dijamin dan memerlukan kontrak BE-018 untuk atribusi lintas tanggal. Attempt yang diterima setelah cutoff juga tidak menjadi blocker retroaktif; rekonsiliasi exact-key adalah jalurnya.
- Bukti regresi: `apps/api/test/modules/daily-attendance.test.ts`, `apps/api/test/modules/daily-attendance-prisma-repository.test.ts`, dan `apps/api/test/modules/attendance-attempt-prisma-repository.test.ts` mencakup WIB/shift malam/+2, hari kerja/libur/holiday ambigu, semua guard, attempt lama lintas cutoff, idempotency, closing/correction, shared-lock/query ordering, serta offline arrival pada tanggal server yang sama.
- Infrastruktur yang tidak diverifikasi: tidak ada `DATABASE_URL` atau Docker daemon; migration PostgreSQL, eksekusi SQL/query plan, konkurensi row-lock nyata, scheduler/cron production, dan deployment tidak diuji. Tes transaksi menggunakan mocks, bukan klaim concurrency PostgreSQL.

**Selesai jika:** semua guard `Tidak hadir`, retry job, timezone, holiday, disruption, dan idempotency diuji.

## A4. Requests, dashboard, reports, audit - P1

### BE-021 - Pengajuan izin, sakit, cuti, lembur [P1]

- Status: **PARTIAL** — route/service/repository BE-021 dan regression tests tersedia memakai schema existing; verifikasi storage cloud dan keputusan bisnis pada konflik approval lembur masih diperlukan.
- `POST/GET /api/v1/attendance/requests`, `GET /:requestId`, `GET /:requestId/attachment-url`, dan `POST /:requestId/decision` tersedia. Jenis BE-021 dibatasi ke LEAVE/SICK/ANNUAL_LEAVE/OVERTIME; CORRECTION ditolak dan tetap untuk BE-022. ID karyawan bersumber dari session; body strict tidak menerima employee/status/approver. Data list/detail serta attachment URL dibatasi di repository berdasarkan owner/Admin/Supervisor.
- Tanggal kalender tervalidasi, end tidak sebelum start. Request PENDING/APPROVED untuk employee yang sama tidak boleh overlap. Pembuatan memakai employee-row lock dan transaksi serializable agar overlap paralel tidak lolos pada PostgreSQL; store hasil jadwal divalidasi terhadap assignment employee.
- Supervisor hanya dapat list/detail jika assignment jadwal relevan pada rentang request mengarah ke satu store unik yang juga ditugaskan kepada employee dan Supervisor. Supervisor dapat melihat overtime hanya dalam scope tersebut. Keputusan atas pengajuan selain overtime memakai aturan scope yang sama; keputusan overtime Supervisor selalu fail closed dengan `REQUEST_REQUIRES_ADMIN`, sedangkan Admin dapat memutusnya. Jadwal store-global, multi-store, tanpa assignment, atau scope yang tidak dapat dibuktikan memerlukan Admin. Store scope tidak dipersist; tidak ada migration karena employee tidak memilih store secara eksplisit. Perubahan jadwal setelah request dapat mengubah hasil derivasi saat review, sehingga snapshot historis store masih perlu keputusan desain.
- Keputusan hanya dari PENDING, wajib catatan, update dan audit append dibuat di satu transaksi. CORRECTION tidak ikut generic lifecycle.
- Lampiran sakit JPEG/PNG/WebP, maksimal 5 MiB, signature diperiksa server-side. Adapter S3 khusus prefix `attendance-requests/doctor-notes/`, key acak buatan server, tidak memakai selfie service/retention. Signed URL download 120 detik hanya setelah repository authorization; key tidak keluar di DTO. Cleanup best-effort jika persist request gagal.
- Regression evidence: `apps/api/test/modules/attendance-requests.test.ts`, `apps/api/test/modules/attendance-requests-prisma-repository.test.ts`, `apps/api/test/modules/private-request-attachment-storage.test.ts`, dan `apps/api/test/routes/attendance-requests.test.ts` menguji lifecycle, date/overlap validation, correction rejection, attachment signature/private read/IDOR termasuk profil karyawan null, scope toko termasuk overtime/global/multi-store, PENDING conditional decision, audit transaction boundary, dan Admin-only overtime calculation.
- **Konfirmasi bisnis diperlukan (PARTIAL):** PRD FR-28/role table mengizinkan Supervisor memutus lembur, tetapi FR-30 menyebut lembur baru dihitung setelah disetujui Admin. Status model hanya menyediakan PENDING/APPROVED/REJECTED dan keputusan final hanya dari PENDING. Karena itu keputusan overtime oleh Supervisor ditolak agar tidak terbentuk request APPROVED tetapi tidak terhitung dan tidak dapat diputus ulang; hanya Admin boleh memutus overtime dan menit dihitung hanya jika approver Admin. Pemilik produk perlu menetapkan apakah butuh tahap second approval/state baru atau keputusan Supervisor boleh dianggap final dan dihitung.
- **Batas private attachment:** bucket policy/public-access block, provider ACL/encryption, akses signed URL nyata, dan masa simpan/penghapusan surat dokter belum ditentukan atau diuji. Adapter tidak menggunakan lifecycle selfie dan tidak mengklaim privacy/retention cloud terverifikasi. Format gambar dan cap teknis 5 MiB perlu dikonfirmasi bila PDF/ukuran berbeda dibutuhkan.
- **Batas validasi:** PostgreSQL/Docker dan storage provider tidak tersedia. Repository/query/transaction/S3 command behavior dites dengan mocks atau signer lokal; migration tidak dibuat, query/concurrency SQL nyata, private bucket policy, dan lifecycle cloud tidak diverifikasi. Overlap lintas tipe memakai kebijakan konservatif yang perlu dikonfirmasi bila overtime boleh berbarengan dengan izin/cuti.

**Selesai jika:** request lifecycle, attachment access, approval scope, overlap, dan overtime calculation diuji.

### BE-022 - Koreksi absensi [P1]

- Employee dapat submit maksimal H+3 hari kerja sesuai konfigurasi.
- Admin dapat membuat koreksi langsung dengan reason wajib.
- Simpan original attendance immutable dan correction record terpisah.
- Approval keputusan maksimal 2 hari kerja menjadi queue/SLA.
- Koreksi setelah closing hanya Admin dengan reason dan audit.

**Selesai jika:** original tidak berubah, batas H+3, approval, closing lock, dan audit diff lulus.

### BE-023 - System disruption [P1]

- Status: **PARTIAL** — API Admin create/list dan audit append tersedia; mass correction tidak diimplementasikan karena definisi dampak ke status/record belum ada di PRD. Tidak mengubah enum, raw attendance, row daily status yang sudah ada, atau status PRESENT/LATE.
- [x] `POST /api/v1/admin/system-disruptions`: Admin-only, store UUID atau `null` global, timestamp ISO eksplisit dengan zona, `endsAt > startsAt`, reason wajib 1–500 karakter setelah trim; status aktif dan pembuat ditentukan server.
- [x] `GET /api/v1/admin/system-disruptions`: Admin-only, paginasi bounded, filter store persis; tanpa filter mencakup scope global dan seluruh toko.
- [x] Repository memakai model/index/FK/check existing; tidak membuat migration/schema baru. Overlap record diterima dan tetap terpisah (schema tidak memiliki unique/exclusion rule); daily guard mempertahankan perbandingan half-open, jadi sentuhan batas bukan overlap.
- [x] Create mencatat audit append `system_disruption.create` dengan aktor, request ID, reason, store/time range; route tidak memberi update/delete.
- [ ] Mass correction: blocker keputusan produk — perlu definisi status target/mapping, data yang boleh berubah, pengaruh pada raw attendance dan daily statuses yang ada, serta batas periode/closing. Tidak aman mengasumsikan efek dari kalimat umum PRD.
- [ ] POST belum idempotent: schema/kontrak tidak menyediakan idempotency key atau unique request token; retry membuat record/audit baru. Perlu keputusan dan penyimpanan key durable sebelum menjanjikan idempotensi.

**Bukti lokal:** `apps/api/test/routes/system-disruptions.test.ts` (auth/wrong role, CSRF, body strict/invalid, global/store scope, overlap rows, pagination, no-store, audit); `apps/api/test/modules/system-disruption.test.ts` (timezone/calendar/end-time/reason/admin/audit/overlap serta retry tanpa idempotency key); `apps/api/test/modules/system-disruption-prisma-repository.test.ts` (store FK, global list/filter/order/page); `apps/api/test/modules/daily-attendance-prisma-repository.test.ts` (guard ABSENT, store-scope predicate, dan batas overlap ketat). PostgreSQL live belum diverifikasi. Mass correction dan POST idempotency tetap blocker, sehingga task tidak dianggap selesai.

### BE-024 - Dashboard query dan notifications [P1]

- [x] Endpoint Admin/Supervisor per tanggal/store/shift, ringkasan status, absent/not checked-in
      paginated list, trend 30 kalender hari, dan ranking dengan query terparameterisasi.
- [x] Employee endpoint untuk status hari ini, history, dan status request pribadi; hanya sumber
      data yang tersedia di schema yang ditampilkan.
- [x] Notification list, unread count, dan owner-only idempotent mark-read.
- [x] Event internal request baru/decision dan attendance pending verification; decision
      verifikasi BE-017 yang sudah atomik tidak diduplikasi.
- [x] Unit/repository/route tests untuk role scope, exact Supervisor store scope + AND filters,
      WIB/configured date, pagination, data kosong, unread/read ownership, idempotency, dan event
      regressions.
- [x] BE-024A: `GET /api/v1/me/dashboard` menerima `historyFrom` dan/atau `historyTo` sebagai batas
      kalender inklusif pada `workDate`; validasi format/tanggal/rentang terjadi sebelum repository,
      dan query tetap mengikat akun session + employee, urutan stabil, serta `pageSize + 1`.
- [x] Employee today items menyertakan `scheduledStartTime`/`scheduledEndTime` (`HH:mm:ss` wall-clock
      dari WorkShift), termasuk shift malam tanpa mengubah waktu akhir menjadi instant.
- [ ] Database integration, query plan/index/performance validation pada PostgreSQL dataset nyata.
- [ ] Saldo cuti: schema belum memiliki entitlement/accrual/ledger; jangan tampilkan nol/estimasi
      sampai produk menetapkan sumber kuota dan aturan accrual/approval.
- [x] Dashboard menolak tanggal bisnis masa depan dengan 400 agar shift mendatang tidak muncul
      sebagai belum check-in; trend/ranking berakhir pada tanggal pilihan yang tidak melewati hari ini.
- [x] Proyeksi status per shift menghasilkan `MISSING_CHECKOUT` untuk check-in valid tanpa checkout
      valid/disetujui. Holiday tetap prioritas pertama dan attendance pending tetap
      `WAITING_VERIFICATION`; jika checkout valid/disetujui ada, klasifikasi `PRESENT`/`LATE` tetap.
      Regresi memeriksa bentuk SQL bersama untuk Admin/Supervisor dan Employee, bukan hasil PostgreSQL.
- [ ] Konfirmasi definisi utama ranking dan apakah nilai yang dikehendaki adalah net menit setelah
      toleransi; nilai saat ini adalah jumlah shift terlambat lalu total elapsed sejak jadwal mulai,
      tanpa mengurangi grace period.
- [x] `TIMEZONE` non-default ditolak saat startup sesuai NFR-07; daily-status job tetap memakai
      cutoff WIB dan tidak mengklaim dukungan kalender non-default.

**Status:** implementasi API dan automated tests lokal tersedia; BE-024 belum sepenuhnya selesai
karena keputusan sumber saldo cuti dan ranking belum ada serta query plan/performa belum dapat diuji
tanpa PostgreSQL. Tanggal masa depan sudah ditangani dengan 400 dan diuji. Regresi klasifikasi status
missing checkout juga mock-backed dan hanya memeriksa SQL yang dibangun; SQL belum dieksekusi pada
PostgreSQL live. **Selesai jika:** blocker produk yang tersisa diputuskan dan DB integration/performa
normal diverifikasi.

### BE-025 - Rekap dan Excel [P1]

**Status: PARTIAL — implementasi backend JSON/XLSX, scope server, audit export, OpenAPI, dan automated tests lokal tersedia; validasi query, rekonsiliasi, dan performa pada PostgreSQL live belum dilakukan.**

- Summary per employee: workdays, present, late count/minutes, absent, leave, sick, annual leave, work hours, approved overtime.
- Daily detail: in, out, duration, daily status, validation status.
- Export `.xlsx` dengan sheet ringkasan dan detail; filter period/store/employee.
- Hasil export harus memakai query/aggregator yang sama dengan layar.
- Logging export ke audit dan batasi role Employee.

**Selesai jika:** angka layar/export sama pada fixture, filter scope aman, file valid dibuka Excel, dan large result tidak timeout.
**Bukti lokal saat ini:** satu service aggregator dipakai JSON dan XLSX; route Admin/Supervisor memiliki session guard, rate limit, no-store, filter strict, dan audit minimal saat export. Test mencakup aggregator/rumus, tanggal kerja unik pada multi-shift, scope Prisma/repository, route, audit, dan round-trip XLSX. Hasil detail dibatasi 25.000 shift-hari. `workDays` menghitung tanggal kalender unik per karyawan dari jadwal non-holiday yang telah tiba/berjalan; beberapa shift pada tanggal yang sama dihitung sekali, sesuai konfirmasi pemilik produk. UI rekap/export FE-016 sudah tersedia. Smoke PostgreSQL INT-005J dikonfigurasi di CI untuk memastikan dua assignment pada tanggal kerja yang sama menghasilkan dua detail dan satu `workDays`; runtime belum dijalankan, dan validasi penuh query/performa, parity dashboard-vs-JSON/XLSX, serta workbook nyata tetap belum terverifikasi. Closing BE-026 dan koreksi BE-022 masih backlog.

### BE-026 - Monthly closing [P1]

- Admin dapat preview lalu close period pada tanggal 3 bulan berikutnya.
- Closed period read-only untuk non-Admin.
- Admin override wajib reason dan audit.
- Export menandai period open/closed.

**Selesai jika:** close idempotent, lock enforcement server-side, override audit, dan reopen policy tidak muncul tanpa keputusan bisnis.

### BE-027 - Backup, retention, observability [P1]

- Daily DB backup 30 hari, weekly 3 bulan, encrypted offsite.
- Foto retention purge 12 bulan.
- Health/readiness endpoint, structured logs, metrics untuk attendance success/pending/rejected/sync delay.
- Restore test playbook dengan target RPO 24 jam/RTO 4 jam.

**Status readiness lokal: SELESAI (bukti lokal saja).** `GET /api/v1/health` tetap liveness independen DB; `GET /api/v1/ready`
memakai Prisma `SELECT 1` bila DB dikonfigurasi, fail closed tanpa DB, mengembalikan status generik,
no-store, dan dapat dipanggil tanpa session. Callback/Prisma fakes, route tests, OpenAPI, dan API docs
menutupi kontrak ini. BE-027 tetap PARTIAL: backup, restore drill, retention deployment, metrics, dan
alerting belum dibuktikan; readiness belum diuji terhadap PostgreSQL live.

**Selesai jika:** backup bisa diverifikasi, restore pernah dites di environment aman, purge tidak menghapus angka absensi, dan alert tersedia.

# B. Frontend PWA

## B1. Fondasi PWA dan akses - P0

### FE-001 - Bootstrap PWA responsif [P0]

- Gunakan TypeScript dan struktur feature-based.
- Tambahkan manifest, service worker, app icons, theme, offline shell, install prompt yang sesuai browser.
- Bahasa Indonesia; tombol utama besar; target maksimal tiga ketukan menuju absensi.
- Pisahkan route Employee, Supervisor, Admin melalui route guard.

**Selesai jika:** PWA dapat di-install di Chrome Android/Safari iOS sesuai kemampuan browser, shell terbuka, dan route tanpa hak akses ditolak.

**FE-001A — kontrak artefak PWA saat build (bukti lokal terbatas).** `apps/web/scripts/check-performance-budget.mjs` mempertahankan gate INT-012 dan memvalidasi manifest hasil build, identitas/display/bahasa/start URL/scope, metadata serta dimensi dan file ikon PNG 192/512, service worker dan Workbox, serta precache shell/manifest/ikon dan artefak statis lokal yang benar-benar ada di output. Parser dibatasi pada literal `precacheAndRoute` yang dihasilkan Workbox dan gagal jelas jika format berubah. Worker juga harus memiliki tepat satu `registerRoute`, yaitu `NavigationRoute` ke `/index.html` dengan denylist `/^\/api\//`; route runtime caching tambahan akan menggagalkan gate.

Verifikasi langsung tanpa `pnpm`: web typecheck lulus; production Vite build ke direktori sementara dan gate PWA/budget lulus; Vitest web 74 file / 393 test lulus; ESLint script dan Prettier kedua file lulus. Initial assets: 327.818/665.600 byte raw dan 100.303/184.320 byte gzip. Ini hanya validasi output build, bukan pengujian install, navigasi, atau offline di browser. FE-001 dan INT-008 tetap **PARTIAL** sampai matriks browser/perangkat nyata dijalankan.

### FE-002 - Design system dan state model [P0]

- Komponen form, button, modal, table, status badge, alert, loading, empty/error state.
- Status badge tidak boleh menyamakan `Valid`, `Perlu verifikasi`, `Absen tertunda`, `Ditolak`, `Tidak hadir`.
- Semua error API dipetakan ke pesan bahasa Indonesia tanpa membocorkan detail internal.
- Buat state machine client yang mengikuti backend, bukan state bebas.

**Selesai jika:** story/example untuk seluruh status dan error tersedia serta responsive test lulus.

### FE-003 - Login, consent, first password, lockout [P0]

- Form username/NIK + password.
- Tampilkan lockout 15 menit tanpa menyebut apakah username ada secara berlebihan.
- Flow login pertama: consent, ganti password, lalu dashboard.
- Session expiry menampilkan pesan dan mengarahkan login.
- Jangan simpan password/token di localStorage jika menggunakan cookie session.

**Selesai jika:** success/failure/lockout/expiry/first login dan keyboard/mobile usability diuji.

### FE-004 - Shell dashboard per role [P0]

- Employee: status hari ini, tombol Masuk/Pulang, history, jadwal, cuti, request.
- Supervisor: toko scope, pending verification, requests.
- Admin: summary toko, pending, belum absen, menu master data.
- Menu tidak cukup sebagai security; selalu tangani 403 dari API.

**Status FE-004A — ringkasan Employee/Supervisor: selesai secara lokal.**

- `/employee` memakai `useEmployeeDashboard({})` (`GET /api/v1/me/dashboard`); `today[]`
  kosong menjadi empty state, dan shift/status/tanggal ditampilkan dari data server tanpa
  menentukan tanggal bisnis di browser atau menyimpulkan `Tidak hadir`. Error aman dapat
  dicoba ulang. Tombol absensi dan antrean offline tidak diubah.
- `/supervisor` memakai `useAdminDashboard({})` (`GET /api/v1/dashboard`) tanpa filter
  tanggal/toko/shift dari browser. Server menentukan tanggal bisnis dan cakupan berdasarkan
  assignment supervisor. UI hanya menampilkan `summary.waitingVerification` dan
  `summary.pendingRequests` setelah response sukses; tidak menampilkan detail karyawan atau
  menyediakan pemilih toko. `/admin` dan route/guard tidak diubah.
- Bukti tes terarah: `role-home-dashboard.test.tsx`, `role-shell.test.tsx`, dan
  `employee-dashboard-pages.test.tsx` — 3 file, 20 tes lulus. Tes memeriksa loading, error
  aman/retry, empty, success, serta URL Supervisor tanpa `date`, `storeId`, dan `shiftId`.
- `pnpm check` lulus setelah implementasi: format, lint, typecheck, API 51 file/431 tes,
  web 66 file/370 tes, serta build API dan web. Aset awal web 327.561/665.600 byte raw dan
  100.216/184.320 byte gzip (keduanya di dalam budget).

**Sisa FE-004 di luar FE-004A:** verifikasi visual di browser dan verifikasi endpoint dengan
PostgreSQL aktif belum dilakukan pada workspace ini. Endpoint Supervisor yang digunakan
tetap mengirim field daftar/ranking dalam payload, walau halaman ini hanya merender dua
counter; minimisasi payload memerlukan task backend tersendiri. Dashboard Admin dan halaman
detail/tindakan masing-masing mengikuti task terpisah.

**Selesai jika:** role matrix PRD terlihat benar dan direct navigation unauthorized ditolak.

## B2. Attendance experience - P0

### FE-005 - Camera capture tanpa upload [P0]

- Gunakan `getUserMedia({ video: { facingMode: "user" } })` atau equivalent.
- Jangan render `<input type="file">` pada flow absensi.
- Tampilkan preview stream, permission guidance, camera error, retry, dan stop track setelah selesai.
- Capture frame dari video canvas; kompres <=200 KB; tampilkan ukuran sebelum submit.
- Watermark nama/waktu server/koordinat harus dibuat memakai data server atau metadata yang disahkan server; client watermark hanya visual tambahan.

**Selesai jika:** tidak ada gallery picker, camera permission denied ditangani, track berhenti, foto tidak over-size, dan memory tidak bocor.

### FE-006 - Liveness dasar dan instruksi acak [P0]

- Tampilkan satu instruksi acak per attempt: berkedip/menoleh sesuai kemampuan library.
- Wajah wajib terdeteksi; gagal liveness tidak boleh submit final sebagai valid.
- Simpan hanya flags/hasil dan foto yang dibutuhkan; jangan menyimpan frame mentah berlebih.
- Sediakan fallback `Perlu verifikasi` bila browser/device tidak mendukung, sesuai keputusan backend, bukan bypass diam-diam.

**Selesai jika:** pass/fail/timeout/permission/device unsupported memiliki state yang jelas dan test manual device matrix dicatat.

**Status lokal FE-006:** state machine, satu instruksi acak (`blink`/`turn-left`/`turn-right`), fallback `Perlu verifikasi`, dan tes deterministik tersedia. Belum ada detector produksi yang dapat dipercaya untuk membuktikan kedipan/menoleh, jadi browser tanpa adapter selalu `unsupported`; foto lokal tidak mengubah atau menetapkan status absensi. Shape Detection API hanya menjanjikan geometri/landmark dan bukan facial-expression detection ([W3C face-detection explainer](https://github.com/w3c/mediacapture-extensions/blob/main/face-detection-explainer.md)). Tidak ada frame/video mentah yang disimpan.

**Device matrix:** belum diuji manual pada Chrome Android, Safari iOS, atau browser desktop; seluruh adapter/perangkat nyata tetap harus diverifikasi sebelum mengaktifkan liveness produksi. Sampai itu dilakukan, hasil yang tidak dapat diverifikasi wajib diperlakukan sebagai `Perlu verifikasi` oleh alur server.

### FE-007 - GPS capture hanya saat absensi [P0]

- Panggil geolocation hanya setelah user menekan Masuk/Pulang dan consent browser tersedia.
- Enable high accuracy, timeout/retry maksimal window 60 detik.
- Tampilkan latitude tidak perlu; tampilkan jarak/akurasi/status yang membantu user.
- Tampilkan panduan GPS lemah/di luar radius.
- Jangan request location saat membuka dashboard, history, atau app idle.

**Selesai jika:** browser permission, timeout, denied, poor accuracy, retry, dan no-background-request teruji.

### FE-008 - Submit online dan status result [P0]

- Gabungkan selfie, liveness, GPS, device ID, network state, client time, idempotency key.
- Tampilkan progress dan cegah double-submit.
- Tampilkan hasil `Valid`, `Perlu verifikasi`, `Absen tertunda`, atau rejected dengan langkah berikutnya.
- Jangan menampilkan sukses sebelum response server tersimpan.

**Selesai jika:** retry tidak membuat duplicate, refresh aman, error network jelas, dan proof code tampil bila tersedia.

**Status lokal FE-008:** alur Employee `/employee` memakai kamera langsung dan satu fix GPS saat aksi dipilih; upload memakai selfie intent → signed PUT dengan header yang diberikan (tanpa cookie) → attempt online strict; receipt divalidasi sebelum UI menampilkan hasil. Retry setelah response attempt tidak diketahui memakai draft, key, dan JSON body yang sama hanya di memori. Liveness unsupported mengirim `false/false`; hasil pending ditampilkan sebagai “Tercatat menunggu verifikasi”. Tes unit/model/component membuktikan urutan API, proteksi double-submit, replay, hasil pending, role, GPS/camera cleanup, dan tanpa gallery. Tidak ada foto, GPS, atau draft offline yang disimpan ke browser storage.

**Batas integrasi FE-008:** API saat ini tidak menyediakan endpoint self-service untuk membaca assignment toko karyawan dan memilih toko. FE tidak mengirim atau menebak `storeId`; bila karyawan multi-store memerlukan pilihan eksplisit, backend perlu menyediakan kontrak assignment yang dibatasi ke karyawan aktif atau menyelesaikan toko di server. Kode `ATTENDANCE_STORE_SELECTION_REQUIRED` ditampilkan dengan panduan menghubungi Admin. Provider object storage belum dikonfigurasi pada workspace ini, sehingga signed PUT hanya diverifikasi dengan mock; uji nyata storage/expiry masih diperlukan.

### FE-009 - Offline queue dengan IndexedDB [P0]

- Simpan queue payload terenkripsi AES-GCM di IndexedDB dengan CryptoKey non-extractable dan scope owner employee; jangan menulis foto, GPS, body, waktu capture, atau metadata sensitif sebagai plaintext browser storage.
- Tampilkan antrean hanya di halaman Employee dan hanya setelah owner/session server terverifikasi. Pending memakai label “Belum tersinkron” serta ID antrean lokal; jangan tampilkan sebagai kode bukti server.
- Sinkronkan serial saat aplikasi terbuka dan sesi employee terverifikasi. Background Sync sengaja tidak digunakan karena service worker tidak dapat memverifikasi owner aktif dengan kontrak saat ini.
- Queue item immutable; replay attempt ambigu memakai idempotency key dan JSON body tersimpan yang sama persis. Urutan sinkronisasi: intent → signed PUT (tanpa cookie) → attempt offline sesuai schema API.
- Receipt valid mengganti payload terenkripsi menjadi receipt-only tombstone: foto, GPS, body, dan data capture lokal dibuang; receipt server tetap dapat ditampilkan. Jangan menghapus item pending secara diam-diam saat logout/error.

**Selesai jika:** airplane mode, reload, browser close/reopen, delayed sync, duplicate ack, quota full, dan logout behavior diuji.

**Status implementasi FE-009:** UI capture hanya menawarkan antrean offline setelah selfie dan GPS tersedia; receipt/status tidak diklaim sebelum server mengakui attempt. Enkripsi, owner scoping, tombstone receipt, retry serial, replay exact-body, serta error/quota/corruption handling memiliki tes unit/integrasi. Background Sync tidak digunakan; fallback sync foreground mensyaratkan sesi karyawan yang diperiksa ulang ke server. Logout/unmount menghentikan sync dan membuang state terdekripsi, tetapi mempertahankan queue terenkripsi yang belum di-ack agar tidak hilang.

**FE-009A — regression coverage IndexedDB close/reopen: selesai lokal.** `apps/web/test/offline-attendance-queue-indexeddb.test.ts` memakai factory `fake-indexeddb` baru pada setiap test dan kelas produksi `IndexedDbQueueStorage`, bukan `MemoryQueueStorage`. Test memeriksa key/entry yang benar-benar tersimpan pada factory tersebut, bentuk metadata dan ciphertext, `CryptoKey` non-extractable setelah structured clone, penolakan baca oleh owner lain, lalu decrypt payload dan byte foto yang sama melalui queue/storage baru setelah close/reopen dengan factory serta nama database yang sama. Pemeriksaan plaintext mencakup employee UUID, koordinat hasil normalisasi, timestamp capture, dan sentinel image bytes; contract queue tidak menerima NIK dan key/entry tidak memiliki field `nik`.

**FE-009B — regression coverage lease IndexedDB: selesai lokal.** Dua tes tambahan memakai beberapa instance `IndexedDbQueueStorage` dengan factory/database yang sama untuk membuktikan satu pemenang saat akuisisi serentak, release hanya oleh token pemilik, serta takeover single-winner tepat pada batas expiry. Factory test tetap terisolasi dan waktu/TTL deterministik; test tidak mengubah production behavior. Bukti terarah: 1 file / 3 tes lulus; verifikasi independen akhir `pnpm check` lulus (API 52 file / 454 tes; web 67 file / 373 tes, termasuk format, lint, typecheck, dan build).

**FE-009C — regression coverage logout/unmount: selesai lokal.** `apps/web/test/offline-attendance-queue-logout.dom.test.tsx` memasang komponen `EmployeeOfflineAttendanceQueue` nyata dengan `createRoot`/`act`, antrean terenkripsi IndexedDB, dan signed-upload fetch fixture deterministik. Dua tes memastikan unmount ketika selfie sedang diunggah meng-abort request, tidak mengirim attempt, dan mempertahankan pending ciphertext yang dapat dibaca kembali setelah close/reopen; mounting untuk employee lain tidak menampilkan antrean pemilik awal. Tidak ada jaringan nyata atau perubahan production behavior. Bukti dibatasi pada happy-dom dan `fake-indexeddb`.

**FE-009D — normalisasi quota pada adapter IndexedDB: selesai lokal.** Satu tes di `apps/web/test/offline-attendance-queue-indexeddb.test.ts` menyuntik `DOMException` `QuotaExceededError` secara deterministik pada `put` entry `fake-indexeddb`, melalui `IndexedDbQueueStorage` dan `OfflineAttendanceQueue` produksi. `enqueue` menolak dengan `OfflineQueueError` berkode `QUOTA`; test memastikan tidak ada entry capture yang tertinggal dan storage tidak memuat sentinel employee, waktu, koordinat, akurasi, atau foto dalam plaintext. Tidak ada perubahan runtime. Parent mengulang tes terarah (file 1 / 4 tes), web typecheck, dan Prettier; semuanya lulus. Ini menguji adapter/error mapping saja, bukan quota browser atau perangkat nyata.

**FE-009E — mounted UI quota recovery: selesai lokal.** `apps/web/test/offline-camera-queue-quota.dom.test.tsx` memount `CameraCaptureDialog` produksi dengan kamera, GPS, canvas, waktu, dan queue sintetis. Tes membuktikan quota menampilkan pesan “belum masuk antrean”, tidak mengklaim sukses/receipt, mempertahankan selfie untuk retry, tidak memanggil network, dan baru menampilkan status antrean lokal setelah enqueue retry benar-benar resolve. Parent memperbaiki fixture timestamp supaya cocok dengan serialisasi UTC produksi; focused test lulus, begitu juga web typecheck, ESLint, Prettier, dan seluruh suite web (74 file / 393 tes). Ini menguji presentasi dan retry UI menggunakan test double, bukan quota IndexedDB/browser/device nyata; adapter quota tetap diuji terpisah oleh FE-009D.

- Verifikasi parent setelah FE-TEST-ROBUSTNESS-002: focused suite FE-009C 1 file / 2 tes dan mounted route-table 1 file / 5 tes lulus; full `pnpm check` lulus format, lint, typecheck, web 70 file / 384 tes, API 52 file / 454 tes, Prisma Client generation, kedua production build, serta asset budget (327.818/665.600 byte raw; 100.303/184.320 byte gzip). Batas happy-dom/fake IndexedDB tetap berlaku.

**Gate verifikasi masih terbuka:** FE-009A/B/C memakai simulasi IndexedDB dan virtual DOM, bukan Chrome/Safari; FE-009D menginjeksi kegagalan write pada `fake-indexeddb`, sedangkan FE-009E menginjeksi hasil quota pada boundary UI. Bukti ini bukan pengujian airplane mode, quota exhaustion pada storage browser nyata, multi-tab, reload/penutupan browser nyata, atau perilaku perangkat. Browser/device smoke test tetap diperlukan sebelum FE-009 dinyatakan lulus penuh.

**Batas kontrak dan threat model:** API saat ini tidak menyediakan `proofCode`; ID antrean lokal bukan kode bukti. Server tetap otoritatif untuk timestamp/work date dan semua offline attempt tetap pending verification; FE tidak menetapkan `VALID` atau bypass liveness. Enkripsi at-rest melindungi salinan database pasif, bukan dari script/XSS aktif pada origin. Jika owner/auth tidak dapat diverifikasi setelah offline/reopen, antrean fail-closed dan tidak dikirim; pemulihan owner tetap memerlukan sesi server terverifikasi.

### FE-010 - Alternative validation UI [P1]

- Tampilkan tombol/flow QR, Wi-Fi indication, atau supervisor confirmation hanya jika feature flag/store mengaktifkan.
- QR scanner tidak boleh menganggap token valid sebelum server memeriksa.
- Jika alternatif gagal, tetap izinkan `Kirim untuk verifikasi`.

**Selesai jika:** feature off tidak terlihat, expiry/error/permission ditangani, dan final status berasal dari server.

## B3. Employee, supervisor, admin screens - P1

### FE-011 - Employee history, schedule, leave balance [P1]

- **Status: PARTIAL** — `/employee/history`, `/employee/schedule`, dan `/employee/leave` kini memuat data dari `GET /api/v1/me/dashboard` dengan sesi cookie, `credentials: include`, serta `cache: no-store`. Role guard/menu yang ada tetap menjadi satu-satunya sumber akses; Supervisor/Admin ditolak untuk ketiga route Employee.
- Client dashboard memakai query/DTO/status allowlist yang ketat. Parameter yang boleh dikirim hanya page/size history/request serta `historyFrom`/`historyTo`; tidak ada `employeeId`, `date`, atau filter scope browser. Pagination history tetap server-side (20 per halaman di UI), filter tanggal kalender inklusif di server dan perubahan tanggal mengembalikan halaman ke 1. Filter kosong tidak dikirim. Request lama dibatalkan dan hasil dilindungi generation guard agar tidak menimpa hasil filter terbaru.
- Riwayat menampilkan tanggal kerja tanpa konversi timezone, jenis masuk/pulang, waktu receipt server dalam WIB, shift/toko, dan validation badge server. `PENDING_OFFLINE` dijelaskan sebagai menunggu sinkronisasi; `PENDING_VERIFICATION` sebagai menunggu pemeriksaan. UI tidak menampilkan GPS, foto, selfie, evidence, ataupun identitas karyawan.
- Jadwal hanya menyebut data hari ini. `scheduledStartTime`/`scheduledEndTime` tetap dibaca sebagai `HH:mm:ss` wall-clock, bukan instant. Jika waktu selesai lebih kecil daripada mulai, UI menyebut tanggal kalender berikutnya berdasarkan tanggal kerja server. Label status memakai pemetaan total atas status response BE-024.
- Saldo cuti **belum tersedia**: UI tidak menampilkan `0`/estimasi dan menyebut bahwa entitlement, accrual, serta carry-over belum ditetapkan. Halaman menyediakan tautan `/employee/requests` dan ringkasan maksimum lima request pribadi terbaru (jenis, rentang tanggal, status saja), tanpa alasan atau lampiran. Ringkasan ini bukan pengganti daftar/form FE-012.
- Loading, error aman dengan retry, empty state, label field, status live, serta layout responsive tersedia pada ketiga halaman. Automated coverage meliputi query/DTO/error, date validation, status pending yang berbeda, shift malam, unavailable balance, privacy/no-overshare, route/menu/role guard, dan perubahan/reset filter yang mengembalikan pagination ke halaman 1.
- Verifikasi lokal FE-011: web tests lulus (48 file, 255 test), web typecheck, web production build/performance budget, workspace lint, Prettier check file berubah, dan `git diff --check` lulus. Build masih memberi warning chunk JavaScript di atas 500 kB; budget aset awal tetap lulus pada 617.817/665.600 byte raw dan 160.524/184.320 byte gzip.
- **Acceptance tetap parsial:** status, riwayat, dan jadwal mengikuti response self-scoped server; saldo cuti baru dapat ditampilkan setelah pemilik produk menetapkan sumber entitlement/ledger, periode, aturan accrual/carry-over, serta dampak request pending/approved/rejected. Database live dan browser/perangkat nyata belum diverifikasi.

### FE-012 - Request forms [P1]

- Status: **PARTIAL** — form dan daftar untuk `LEAVE`, `SICK`, `ANNUAL_LEAVE`, dan `OVERTIME` tersedia di `/employee/requests`; `CORRECTION` menunggu BE-022 dan tidak dikirim/dipalsukan.
- API client mengikuti kontrak BE-021 secara strict: payload create hanya memuat field yang diizinkan per jenis, memakai sesi untuk owner (tanpa `employeeId`/status/approver/store), dan memvalidasi DTO serta paginasi dari server.
- Validasi form: tanggal kalender/rentang, alasan wajib maksimal 1.000 karakter, menit lembur integer positif, serta foto surat dokter wajib khusus sakit (JPEG/PNG/WebP, maksimum 5 MiB, signature file diperiksa sebelum base64 dikirim). Submit ganda dicegah; loading/error/success dan error field dapat diakses.
- Daftar menampilkan status, rentang tanggal, alasan, catatan keputusan, indikator lampiran khusus sakit, dan pagination API. Saldo cuti tidak disimpulkan dari DTO; lembur menjelaskan keputusan final oleh Admin. Signed URL tidak diminta, ditampilkan, atau dicatat.
- Tests: API payload strict/DTO/error, validasi form dan signature file, submit gate, komponen feedback/list/pagination, serta route role gating. Verifikasi lokal: seluruh web tests, typecheck, build, lint workspace, Prettier file berubah, dan `git diff --check`.
- Blocker/remaining: UI koreksi beserta record asli read-only, field usulan, dan deadline H+3 menunggu kontrak BE-022. UI detail/unduh surat dokter belum disediakan; daftar hanya menunjukkan apakah attachment sakit tercatat.

### FE-013 - Supervisor review [P1]

- Status: **PARTIAL** — halaman role-gated tersedia pada `/supervisor/verification`, `/admin/verification`, `/supervisor/requests`, dan `/admin/requests`; peta sengaja belum tersedia karena provider peta, tile, dan pemrosesan koordinat belum dipilih.
- API client verifikasi hanya meminta `page`/`pageSize` (tanpa filter `storeId`); scope toko Supervisor tetap ditentukan server. Antrean memuat loading/error/empty/pagination, detail dan riwayat absensi terbaru, due/overdue, waktu server/perangkat, jenis, status validasi, metode, jaringan, perangkat, serta koordinat/akurasi/jarak.
- Bukti selfie diminta hanya dari endpoint signed URL detail, ditampilkan tanpa referrer, logging, persistent storage, atau custom cache. URL harus HTTPS (HTTP hanya loopback development) dan tidak boleh mengandung kredensial. Refresh menunggu Promise sampai selesai; bukti tanpa sumber tidak menawarkan retry. Hanya error API `404 SELFIE_NOT_FOUND` yang menghapus bukti; network/5xx mempertahankan URL kedaluwarsa/gagal dan tombol retry.
- Keputusan verifikasi mengikuti payload strict BE-017; alasan penolakan wajib dan maksimum 500 karakter. UI menangani sukses, konflik, error, serta URL kedaluwarsa.
- Review request hanya meminta `status=PENDING` dan pagination; tidak mengirim asumsi toko dari browser. Catatan keputusan wajib. Supervisor dapat melihat lembur dalam scope tetapi tidak mendapat aksi keputusan; UI menjelaskan bahwa keputusan harus diteruskan ke Admin. Admin dapat menyetujui/menolak sesuai BE-021.
- Koordinat, akurasi, dan jarak ditampilkan sebagai data teks; tidak ada koordinat karyawan yang dikirim ke provider pihak ketiga. Peta menampilkan status belum tersedia sampai pilihan provider dan kebijakan pemrosesan disetujui. FE-013A menyediakan unduh surat dokter secara lokal melalui endpoint BE-021, tetapi kebijakan private bucket/provider, ACL/enkripsi, serta retention belum diverifikasi.
- FE-013A — selesai pada UI/API client lokal: aksi unduh hanya muncul untuk detail `SICK` dengan `hasAttachment: true`, baru meminta URL setelah tindakan eksplisit, dan memakai sesi cookie, `no-store`, DTO strict, serta validasi URL HTTPS (HTTP hanya loopback development) tanpa userinfo. UI tidak preview atau menampilkan URL; tautan eksternal hanya berada di state komponen sampai expiry, memakai `rel="noreferrer noopener"` dan `referrerPolicy="no-referrer"`, lalu state URL dibuang. Loading/error/expired, retry manual, dan pencegahan klik ganda tersedia. Ini bukan verifikasi kebijakan bucket/provider, ACL/enkripsi/retention, atau sign-off keamanan.
- Tests mencakup endpoint/query/payload strict, no-store, validasi URL signed, guard retry selfie (404 `SELFIE_NOT_FOUND` terkonfirmasi vs transient network/5xx), role/path gating, queue states/pagination, aksi lembur Admin-only, render detail, dan FE-013A endpoint/URL/unduh. Verifikasi FE-013A: `pnpm check` lulus (API 50 file/424 test, web 59 file/329 test, format, lint, typecheck, dan build); initial assets web 326.948/665.600 byte raw dan 100.025/184.320 byte gzip. `git diff --check` lulus; hanya ada peringatan line ending pada perubahan sebelumnya di `docs/README.md` dan `docs/class-diagram.mmd`. Browser/perangkat nyata tidak diuji.
- Historical baseline sebelum INT-012A (build setelah penambahan FE-011): bundel JavaScript 554.49 kB (warning >500 kB); performance-budget lulus dengan initial assets 617,817/665,600 byte raw dan 160,524/184,320 byte gzip. Route-level lazy splitting kemudian diterapkan; lihat bagian INT-012A di bawah untuk hasil saat ini.
- Remaining: pilih provider peta dan kebijakan privasi/pemrosesan sebelum menambah peta; verifikasi kebijakan private bucket/provider, ACL/enkripsi, serta retention surat dokter dan uji pada browser/perangkat nyata. FE-013 tetap PARTIAL sampai blocker yang tersisa ditangani; hasil FE-013A tidak menyatakan provider/security sign-off.

### FE-014 - Admin master data [P0/P1]

- Status: **PARTIAL** — UI Admin memakai route yang sudah ada: `/admin/employees`, `/admin/accounts`, `/admin/stores`, dan `/admin/schedules`; route policy tetap Admin-only dan data/aksi mengikuti endpoint yang tersedia.
- Profil karyawan: daftar, tambah, ubah, dan deaktivasi soft-delete melalui API Admin. Akun login dan profil dipisah. Akun dapat dibuat/diubah/dinonaktifkan, tautan profil dikelola dari daftar server, password reset mengikuti kontrak sementara server, dan permintaan perangkat pending dapat disetujui/dicabut. UI tidak menampilkan hash/token perangkat atau menyimpan password sementara ke storage/log.
- Toko: daftar/detail, buat/edit/nonaktifkan; form memvalidasi koordinat geografis, radius dan batas akurasi positif, serta satu IP Wi-Fi publik. Assignment karyawan toko hanya menawarkan employee aktif dan memakai endpoint assignment server. Perubahan koordinat/radius/batas akurasi/IP Wi-Fi saat edit sekarang meminta konfirmasi sebelum PATCH; dialog hanya menyebut nama field, tidak mengulang nilai konfigurasi. Deaktivasi toko dan penghapusan assignment juga meminta konfirmasi.
- Jadwal: katalog shift memakai jam mulai/selesai, istirahat, toleransi telat, dan hari kerja ISO; assignment shift per karyawan memakai toko, shift, dan rentang tanggal inklusif; kalender hari libur mendukung scope nasional/toko. Form memvalidasi data lokal dan konflik/otorisasi tetap diputuskan server. Deaktivasi shift/assignment dan penghapusan hari libur meminta konfirmasi.
- Aksi akun sensitif (peran, status, tautan profil), reset password, pembuatan/deaktivasi akun, dan approval/revoke perangkat menggunakan dialog konfirmasi. Tidak ada field `reason` untuk mutasi toko, shift, assignment, atau hari libur pada kontrak terkait; UI tidak mengarang alasan/override.
- Tes FE-014 meliputi direct-route/role guard, API payload/DTO/error, validasi form, state model, dan konfirmasi tindakan yang kontraknya tersedia. Tes tambahan memastikan perubahan pengaturan lokasi tidak dikirim sebelum konfirmasi, sukses memperbarui DTO dari server, dan kegagalan mempertahankan data lama serta menampilkan safe error.
- Remaining server/API gap: belum ada endpoint/DTO/config untuk SLA (termasuk batas waktu verifikasi/koreksi/closing yang dapat diubah), retention, atau pemilihan/aktivasi QR/Wi-Fi/supervisor sebagai alternatif validasi. Backend BE-023 kini menyediakan Admin API untuk create/list rentang gangguan; UI/form belum tersedia, dan mass correction tetap menunggu keputusan produk sebelum ada endpoint atau UI. Fitur yang belum memiliki API tidak disimulasikan oleh frontend.
- Remaining product/UI gap: PRD tidak menentukan daftar lengkap field yang dianggap “sensitif”. Konfirmasi sudah mencakup akses akun, aksi destruktif/deaktivasi, serta konfigurasi geofence/Wi-Fi toko; perubahan non-destruktif katalog shift, assignment, dan metadata hari libur masih disimpan lewat form biasa. Perlu klasifikasi produk yang eksplisit sebelum memperluas dialog konfirmasi. UI override dengan alasan belum dibuat karena tidak ada kontrak endpoint yang mendukungnya.
- Verifikasi mandiri setelah FE-014: `pnpm check` lulus, termasuk Prettier, workspace lint, API/web typecheck, API tests **46 file/392 tes**, web tests **51 file/274 tes**, serta API dan web production build. Web build memberi warning chunk JavaScript **578,32 kB** (>500 kB), tetapi performance budget awal lulus pada **648.702/665.600 byte raw** dan **168.504/184.320 byte gzip**. Prettier check file FE-014 berubah dan `git diff --check` lulus; Git hanya mengeluarkan notifikasi LF→CRLF pada `docs/README.md` dan `docs/class-diagram.mmd` yang tidak diubah dalam task ini. Browser/perangkat nyata, GitHub Actions run, dan integrasi database live belum diverifikasi.

### FE-015 - Admin dashboard [P1]

- Status: **selesai secara lokal** pada route Admin yang sudah ada, `/admin`; tidak menambah atau mengubah route master data dan Supervisor. Verifikasi browser/perangkat nyata dan PostgreSQL/query plan tetap belum dilakukan.
- Dashboard memakai `GET /api/v1/dashboard` dengan filter kalender `date` opsional, `storeId`, `shiftId`, serta pagination `page`/`pageSize` untuk daftar `notCheckedIn`. Filter kosong tidak dikirim; pergantian filter mereset halaman daftar ke 1.
- KPI menampilkan `present`, `late`, `notCheckedIn`, `absent`, `leave`, `sick`, `annualLeave`, dan `waitingVerification` persis dari response. Daftar paginasi memetakan status item `NOT_CHECKED_IN` dan `ABSENT` terpisah; UI tidak menyimpulkan absent dari jam/cutoff.
- Client memakai cookie session, `cache: no-store`, AbortSignal, key query runtime allowlist, UUID/date-only validation, DTO/status strict validation, dan memeriksa agar page/pageSize response sesuai query. API invalid/future date ditampilkan sebagai pesan aman dengan petunjuk mengubah/kosongkan tanggal.
- Filter toko/shift memakai API master data yang tersedia; pilihan aktif maupun nonaktif tetap terlihat (nonaktif diberi label). Error opsi ditampilkan aman dengan retry; data opsi hanya dimuat saat halaman dibuka/retry, bukan setiap polling dashboard.
- Polling dashboard setiap 60 detik hanya selama dokumen visible; satu request berjalan per poller/query, refresh manual tersedia, dan timer/listener/request dibersihkan atau dibatalkan saat query berubah/unmount.
- Tren 30 hari dibuat dengan HTML/CSS tanpa library grafik baru dan menyediakan angka/label tekstual. Ranking memakai urutan server; UI menjelaskan `lateCount`, `lateDays`, dan menit sejak jadwal mulai termasuk toleransi, bukan menit bersih setelah grace.
- Automated tests meliputi route/role guard, API query/no-store/strict DTO/status/date/pagination, reset filter, empty/loading/error/response, opsi aktif/nonaktif/error, aksesibilitas trend/ranking, serta interval/visibility/no-overlap/cleanup.
- Verifikasi lokal terbaru: 51 web test files/274 tests dan 46 API test files/392 tests lulus; workspace typecheck, lint, Prettier check, production build, serta performance budget lulus. Build menghasilkan chunk JS 578,32 kB (warning >500 kB); initial assets 648.702/665.600 byte raw dan 168.504/184.320 byte gzip tetap di bawah budget. Browser/perangkat nyata dan PostgreSQL live/query plan tetap belum diverifikasi.

### FE-016 - Reports, Excel, closing [P1]

- **Status: PARTIAL** — UI rekap/filter/export lokal sudah tersedia untuk Admin `/admin/reports` dan Supervisor `/supervisor/reports`; monthly closing belum dibuat karena kebijakan closing dan override belum diputuskan.
- [x] Summary/detail tabs menggunakan filter bulan, toko, dan karyawan yang sama; detail shift dipaginasi 50 row per halaman.
- [x] Ekspor XLSX hanya tersedia pada route Admin/Supervisor; client memvalidasi MIME type dan signature ZIP sebelum browser mengunduh file.
- [x] Supervisor mengambil pilihan filter dari report yang sudah dibatasi server; tidak meminta daftar toko/karyawan Admin dan route tetap terlindungi role guard.
- [x] Error API/export memakai pesan aman, tombol unduh menunjukkan progress, dan request dibatalkan saat halaman ditutup.
- [x] `workDays` ditampilkan sebagai tanggal kalender unik; dua shift pada tanggal yang sama adalah satu hari kerja sesuai konfirmasi pemilik produk.
- [ ] Preview/close period, closed badge, locked state, dan Admin override + reason: tunggu keputusan scope periode, post-close override/reopen, serta audit policy BE-026. Tidak membuat UI/route yang menebak kebijakan.
- Bukti lokal FE-016: 5 file/23 test terfokus lulus; suite web 77 file/406 test, typecheck, lint, Prettier, production build, dan PWA initial-asset budget lulus. Regression tests pada `apps/web/test/monthly-report-*` mencakup scope Supervisor, validasi JSON/XLSX, tampilan, dan paginasi. PostgreSQL live, browser visual, serta rekonsiliasi export dengan data DB belum diverifikasi.

### FE-017 - Audit, notifications, disruption [P1]

- Status: **PARTIAL** — UI notifikasi semua role, form/list gangguan Admin, dan UI audit read-only Admin tersambung ke API aktif. Mass correction masih menunggu keputusan bisnis.
- [x] Halaman notifikasi reusable dengan path persis `/employee/notifications`, `/supervisor/notifications`, `/admin/notifications`; ketiga route masuk melalui `ROLE_NAVIGATION` dan guard existing. Membaca `GET /api/v1/notifications` (ALL/READ/UNREAD, page/pageSize/unreadCount) dan menandai milik akun saat ini dengan `PATCH /api/v1/notifications/:notificationId/read`.
- [x] Client notifikasi memvalidasi DTO, UUID, enum kind, timestamp timezone-aware, pagination, dan key kontrak; fetch memakai cookie/no-store, signal abort, error/loading/empty state, serta refresh daftar sesudah mark-read.
- [x] Halaman Admin `/admin/system-disruptions` memakai master toko yang ada, opsi global (`storeId: null`), riwayat paginasi/filter store, reason wajib, validasi `endsAt > startsAt`, status `isActive` dari DTO, dan konfirmasi sebelum `POST /api/v1/admin/system-disruptions`.
- [x] Input `datetime-local` diperlakukan sebagai Asia/Jakarta dan diserialisasi eksplisit dengan offset `+07:00`; tidak menggunakan zona waktu browser untuk menentukan instant.
- [x] POST dibatasi satu request pada satu waktu. Tidak ada retry otomatis. Error 4xx diperlakukan sebagai penolakan pasti. Hasil network/status 0 atau 5xx (termasuk response sukses yang tidak dapat divalidasi) dikunci permanen pada UI: daftar semua scope dapat diperiksa, tetapi paginasi tidak dianggap bukti ketiadaan dan POST tidak dapat diulang; Admin harus eskalasi untuk rekonsiliasi manual.
- [x] UI Admin read-only di `/admin/audit-logs` memakai API audit aktif, filter actor/action/entity/tanggal inklusif WIB, detail before/after collapsible, dan pagination; route tetap melalui guard role yang ada.
- [ ] Mass correction: blocker requirement — PRD belum menentukan target record/status, mapping, aturan closing, dan dampak pada attendance/daily status; tidak membuat UI/side effect.

**Bukti backend BE-007A (checkpoint sebelum FE-017A):** route suite audit service/route lulus 2 file/13 tes dan full `pnpm check` saat itu lulus: API 51 file/431 tes, web 62 file/355 tes, termasuk Prettier, lint, typecheck, serta build. Test API memakai fake in-memory repository; PostgreSQL live belum diuji. Pada checkpoint BE-007A, UI browser dan frontend audit filter memang belum diverifikasi/dibuat; hasil implementasi dan tes UI FE-017A dicatat pada checkpoint berikutnya.

**Checkpoint FE-017A:** tes terfokus web audit-log dan route-code-splitting lulus (4 file/14 tes), mencakup validasi client, model filter/paging/abort/stale response, exact Admin-only route, dan render loading UI. Run `pnpm check` lulus: web 65 file/366 tes, API 51 file/431 tes; Prettier, lint, typecheck, dan production build lulus. Initial assets web 327,401/665,600 byte raw dan 100,159/184,320 byte gzip (budget lulus). `git diff --check` exit 0. Tidak ada browser visual/live database test; mass correction tetap blocker.

Baris bukti FE-017 berikut mencatat checkpoint historis sebelum BE-007A; angka terbaru task ini tercatat di atas.

**Bukti verifikasi lokal FE-017:** `pnpm check` lulus (Prettier check, lint, recursive typecheck, tests, dan production build). Test web: 58 file/320 test lulus; API: 50 file/424 test lulus. Bukti khusus FE-017 ada di `apps/web/test/notifications-api.test.ts`, `notifications-model.test.ts`, `system-disruptions-api.test.ts`, `system-disruptions-model.test.ts`, dan `fe-017-routing.test.tsx`, termasuk fail-closed sesudah review page 1 dan halaman lanjutan. Initial assets: 652,169/665,600 byte raw dan 169,968/184,320 byte gzip (budget lulus). Vite masih memberi advisory satu JS chunk 581.78 kB melebihi 500 kB; chunk tersebut lazy-loaded pada route baru, sementara budget initial tetap lulus. `git diff --check` juga lulus. Browser visual/device belum diverifikasi karena CUA/browser visual unavailable pada task sebelumnya; automated checks bukan pengganti smoke test browser nyata.

# C. Integrasi dan Quality Assurance

## C1. API contract dan data integration - P0

### INT-001 - OpenAPI contract [P0]

**Status: COMPLETE untuk seluruh route yang saat ini terdaftar.** Saat ini, `docs/openapi.yaml` mencakup 53 path dan 70 operasi aktif, termasuk route readiness `GET /ready` (`GET /api/v1/ready`) dan dua operasi rekap bulanan BE-025; kontrak juga mencakup cookie session, role scope, same-origin requirement untuk operasi tulis, pagination, request/response schemas, idempotency attendance, signed URL, dan Problem Details. `docs/API.md` tetap menjadi kontrak naratif bagi aturan bisnis serta keterbatasan provider. Route audit read-only Admin tercantum; endpoint lain yang belum memiliki route tetap dikecualikan. Perubahan API ke depan wajib memperbarui OpenAPI serta kontrak naratif dalam task backend yang sama.

- Verifikasi kontrak terbaru setelah BE-007A: hitungan aktual 50 path/67 operasi; route baru adalah satu operasi `GET /admin/audit-logs`, Admin-only, dengan response `AuditLogPage` dan query/schema yang dirujuk lokal. Prettier `format:check` memeriksa sintaks YAML; semantic OpenAPI lint eksternal belum dipasang.
- Riwayat verifikasi workspace INT-001 sebelum BE-007A (dipertahankan sebagai bukti historis): `pnpm check` lulus dengan API 46 file/392 tes dan web 51 file/274 tes, lint/typecheck/build API-web. Build web pada run tersebut memberi warning satu JS chunk **578,32 kB** di atas advisory 500 kB; performance budget awal lulus (**648.702/665.600 byte raw**, **168.504/184.320 byte gzip**). Angka tersebut bukan hasil run task BE-007A.
- Verifikasi implementasi BE-007A: suite audit service/route terfokus lulus (2 file/13 tes). `pnpm check` terbaru lulus untuk API 51 file/431 tes dan web 62 file/355 tes, termasuk Prettier, lint, typecheck, test, serta build API/web; `git diff --check` exit 0. Repository pada route test adalah fake in-memory, bukan PostgreSQL live.

Dokumentasikan endpoint, auth, request/response, enum, pagination, error code, idempotency, signed URL, dan role scope. Contract harus menjadi sumber bersama frontend/backend.

Route correction dan monthly closing yang belum diregistrasikan tetap backlog. Report bulanan JSON/XLSX di `/api/v1/reports/monthly` dan `/api/v1/reports/monthly/export`, serta `GET /api/v1/admin/audit-logs`, kini tercantum sebagai endpoint aktif. Endpoint backlog lain hanya ditambahkan ke OpenAPI setelah route, DTO, authorization, serta perilaku server tersedia di task backend terkait.

### INT-002 - API client dan error mapping [P0]

- Status: **DONE** — transport bersama `apps/web/src/api/api-client.ts` dipakai semua wrapper API aktif, termasuk auth dan session; satu-satunya pemanggilan `fetch` aplikasi yang tersisa berada di helper tersebut. DTO tetap divalidasi ketat per domain dan mempertahankan error subclass per-flow agar konteks status/kode/tahap tetap tersedia.
- Enum/status kontrak aktif dipusatkan di `apps/web/src/api/api-contract.ts` sesuai OpenAPI; date/time menerima RFC3339 dengan zona waktu eksplisit, tanggal kalender divalidasi tanpa konversi zona, dan waktu tangkapan diserialisasi sebagai UTC ISO. Receipt `RECEIVED`/`RECORDED` mengikuti kontrak; field receipt opsional tetap opsional.
- Transport mempertahankan `credentials: include`, `cache: no-store`, headers/body persis; upload signed PUT tetap `credentials: omit`. Error HTTP dan offline terpetakan ke aksi pemulihan; parsing Problem Details hanya menyimpan `status`, `code`, dan `requestId`, sedangkan UI memakai allowlist code/status dan tidak menampilkan `title`/`detail` server.
- Konflik 409 tidak menawarkan replay buta: idempotency key yang dipakai untuk payload lain ditandai sebagai `new-attempt` setelah pemeriksaan riwayat; conflict attendance menyediakan CTA untuk membuka riwayat, sedangkan aksi review memperbarui antrean.
- Tests: tes client transport/error/date, DTO receipt, auth API, session API, dan allowlist error. Verifikasi: `node ../../node_modules/vitest/vitest.mjs run test/api-client.test.ts test/session-api.test.ts test/attendance-api.test.ts test/auth-api.test.ts test/design-system.test.tsx` lulus (5 file/64 tes); `pnpm --filter @absen/web test` lulus (53 file/302 tes); `pnpm --filter @absen/web typecheck` lulus; Prettier diterapkan pada file terkait.
- Residual: typed DTO/enum dipelihara manual terhadap OpenAPI; code generation dan pemeriksaan drift otomatis belum dikonfigurasi. Endpoint yang belum terdaftar tidak ditambahkan. Tidak ada perubahan backend/business policy.
- Verifikasi mandiri supervisor: full `pnpm check` pertama menangkap satu unused import dari migrasi; import dihapus dan file diformat. Full `pnpm check` kedua lulus: API 46 file/392 tes, web 53 file/302 tes, lint/typecheck, serta build API/web. Build web masih memberi warning advisory chunk JS **580,02 kB** (>500 kB), sedangkan performance budget awal tetap lulus (**650.409/665.600 byte raw**, **169.409/184.320 byte gzip**).

### INT-003 - Storage integration [P0]

**Status: PARTIAL.** Regression coverage lokal untuk adapter, service, route, repository, dan job sudah ditambah/diperiksa. Verifikasi provider nyata belum dapat dilakukan: project belum memiliki konfigurasi bucket/provider, database live, kredensial, atau scheduler. Test mock/code tidak membuktikan bucket private, ACL/block-public-access, lifecycle provider, maupun penghapusan objek live.

Coverage lokal yang ada sekarang:

- `private-selfie-storage.test.ts`: signed PUT memakai expiry yang tepat dan hanya mengembalikan header wajib `Content-Type` + `x-amz-meta-referencehash`; test memeriksa metadata hash masuk ke `X-Amz-SignedHeaders`. Signed GET menguji expiry dan `response-cache-control=private, no-store`. Upload/seal tidak mengatur ACL publik; sealed object memakai `Cache-Control: private, no-store` dan `If-None-Match: *`.
- `selfie-upload.test.ts` dan `private-selfie-storage.test.ts`: batas 200 KiB (204.800 byte diterima, 204.801 ditolak/tidak diunduh), MIME yang diizinkan, signature/dimensi gambar aktual, metadata hash, byte length dan ETag HEAD/GET; mismatch ETag/metadata/ukuran/MIME ditolak. Key selfie staging/accepted diuji berprefix tetap dan UUID acak, tanpa NIK/session username atau employee ID mentah. Test key doctor-note juga menegaskan UUID tidak memuat NIK/session username, employee ID, atau nama dari DTO.
- `attendance-selfie-uploads.test.ts`: endpoint signed URL memakai `Cache-Control: no-store`; akses session/role/origin diperiksa. `selfie-upload.test.ts` menguji TTL read dibatasi sisa retensi serta tidak menandatangani URL di batas expiry.
- `selfie-upload.test.ts` + `selfie-upload-prisma-repository.test.ts`: cleanup attached/staging/orphan, retry setelah delete gagal/parsial, atomic cleanup pointer, rollback, conditional claim, dan race saat worker lain lebih dulu mengklaim. `selfie-retention.ts` gagal tertutup bila konfigurasi DB/storage tidak tersedia dan mengembalikan exit non-zero saat ada kegagalan/batch belum habis. Scheduler produksi belum dipasang.
- `private-request-attachment-storage.test.ts`, `attendance-requests.test.ts`, dan route tests: surat dokter memakai adapter/prefix `attendance-requests/doctor-notes/` terpisah, signed download singkat dengan disposition attachment dan private/no-store, tanpa ACL publik dan tanpa lifecycle selfie. Signature MIME divalidasi sebelum upload; key attachment UUID acak dan tidak memuat NIK/session username, employee ID, atau nama pada DTO.
- Verifikasi akhir: full API test suite lulus (**46 file / 395 test**); API typecheck lulus; ESLint pada file TypeScript yang disentuh lulus; Prettier check pada file kode/dokumen yang disentuh lulus. `git diff --check` lulus dengan peringatan line-ending pada `docs/README.md` dan `docs/class-diagram.mmd` yang merupakan file pengguna dan tidak diubah. Hasil test hanya lokal (unit/mock), bukan bukti akses kontrol atau retensi provider live.

Perubahan kecil yang dibuat untuk bukti spesifik: metadata `x-amz-meta-referencehash` kini ditetapkan sebagai `unhoistableHeaders` pada presigned PUT, karena pemeriksaan signer menunjukkan sebelumnya metadata berada di query dan tidak termasuk `X-Amz-SignedHeaders`. Ini membuat header wajib metadata benar-benar ditandatangani. Test memeriksa daftar signed headers yang tepat.

Langkah yang tersisa setelah pemilik project menyediakan provider/DB dan lingkungan uji (tanpa menaruh secret di repo):

1. Pemilik memilih dan membuat bucket private; aktifkan pemblokiran akses publik dan policy minimum untuk API/worker. Verifikasi anonymous GET/list ditolak; jangan mengandalkan prefix atau tidak adanya ACL pada command sebagai pengganti policy bucket.
2. Masukkan konfigurasi storage dan `DATABASE_URL` ke secret manager/runtime yang disetujui; jangan menulis kredensial ke dokumen, test, atau `.env` yang di-commit.
3. Pasang scheduler tepercaya minimal harian untuk `pnpm --filter @absen/api retention:run`; pantau exit code, `failures`, dan `reachedBatchLimit`, lalu buktikan staging expired dan selfie yang melewati masa retensi dihapus sementara metadata absensi tetap ada. Tetap gunakan kebijakan retensi aplikasi 12 bulan; jangan menerapkan lifecycle provider ke doctor-note tanpa keputusan terpisah.
4. Jalankan smoke/integration test terhadap bucket dan DB disposable: unsigned access ditolak; signed PUT/GET berhasil hanya selama TTL; content-type/metadata wajib cocok; cache-control private/no-store; upload >200 KiB atau signature mismatch ditolak; delete/retry dan race attach-vs-retention tidak kehilangan objek yang masih dipakai. Jangan mencatat URL bertanda tangan atau secret dalam log.

Tidak ada provider, kredensial, scheduler, migration, maupun deployment yang dibuat dalam task ini; tidak ada klaim private ACL atau retention provider live telah teruji.

## C2. Test pyramid - P0

### INT-004 - Unit tests aturan bisnis [P0]

Cakup timezone, geofence boundary, GPS accuracy, mock/repeated coordinate, late/tolerance, early leave, missing checkout, offline drift, SLA date, H+3 workdays, holiday, disruption, closing lock, overtime approval, and daily absent guard.

**Status: PARTIAL.** Mapping acceptance criteria ke regression evidence:

| Kriteria                           | Bukti unit/regression test                                                                                                                                                                                                                                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Timezone WIB                       | `time.test.ts`: rollover date/month/year dan hasil stabil pada host timezone berbeda.                                                                                                                                                                                                                             |
| Geofence boundary dan GPS accuracy | `geospatial-validation.test.ts`: radius/akurasi tepat batas diterima; di luar radius/akurasi ditandai.                                                                                                                                                                                                            |
| Mock/repeated coordinate           | Repeated-coordinate: `geospatial-validation.test.ts` dan `attendance-attempt-prisma-repository.test.ts` (flag tersimpan dan attempt offline tetap `PENDING_VERIFICATION`). Mock-location belum memiliki sinyal/aturan implementasi.                                                                               |
| Late/tolerance                     | `attendance-business-rules.test.ts` dan `time.test.ts`: waktu server, batas toleransi, dan just-after boundary.                                                                                                                                                                                                   |
| Early leave                        | `attendance-business-rules.test.ts`: izin yang disetujui dan batas akhir shift malam lintas tanggal WIB, termasuk tepat sebelum/pada waktu akhir.                                                                                                                                                                 |
| Missing checkout                   | `attendance-business-rules.test.ts`: hanya ada check-in tanpa check-out yang ditandai.                                                                                                                                                                                                                            |
| Offline drift                      | `attendance-offline-sync.test.ts`: ±5 menit, lebih dari batas, umur sinkronisasi 24 jam, dan timestamp invalid; repository regression di `attendance-attempt-prisma-repository.test.ts`.                                                                                                                          |
| Verification SLA date              | `attendance-verification.test.ts`: dueAt +24 jam, sebelum batas, dan tepat saat batas.                                                                                                                                                                                                                            |
| H+3 workdays                       | `time.test.ts`: penambahan tiga hari kerja mengikuti weekday shift dan melewati libur. Ini hanya menguji utilitas tanggal, bukan enforcement workflow koreksi.                                                                                                                                                    |
| Holiday                            | `schedule.test.ts`, `daily-attendance.test.ts`, dan `daily-attendance-prisma-repository.test.ts`: libur nasional/toko, tanggal non-kerja, dan holiday scope ambigu.                                                                                                                                               |
| Disruption                         | `daily-attendance-prisma-repository.test.ts`: overlap menghalangi insert `ABSENT`; regression BE-023 juga memeriksa predicate half-open (`<`/`>`) sehingga batas bersentuhan bukan overlap. `system-disruptions.test.ts` menguji Admin create/list, audit, dan store scope. Mass correction tetap blocker produk. |
| Closing lock                       | `daily-attendance-prisma-repository.test.ts`: bulan `CLOSED` menahan insert `ABSENT` dan koreksi status. Belum ada monthly-closing/override service.                                                                                                                                                              |
| Overtime approval                  | `attendance-requests.test.ts`: menit hanya terhitung setelah approval Admin dan record yang disetujui non-Admin tidak dihitung. Konflik kebijakan FR-28/FR-30 tetap menunggu pemilik produk (lihat BE-021).                                                                                                       |
| Daily absent guard                 | `daily-attendance.test.ts` dan `daily-attendance-prisma-repository.test.ts`: cutoff WIB, holiday/non-working day, attendance/request/correction/attempt/disruption/closing guards, employee lock, dan retry idempotent.                                                                                           |

**Batas yang belum dapat dipenuhi (tetap PARTIAL):** deteksi mock-location belum diimplementasikan; koreksi karyawan ditolak sampai BE-022 sehingga enforcement H+3 belum dapat diuji; BE-023 kini menyediakan route pengelolaan gangguan, tetapi mass correction belum diimplementasikan karena definisi produk belum cukup; monthly-closing/override service belum tersedia; dan kebijakan final approval lembur masih konflik antara FR-28 dan FR-30. Repository test memakai mock, jadi transaksi/predikat SQL nyata tetap gate integrasi PostgreSQL pada INT-005. Regression BE-023 menguji kontrak dan query predicate secara lokal, bukan database live.

### INT-005 - Backend integration tests [P0]

**Status: PARTIAL — local mock-backed evidence is verified and the migration/readiness, PostgreSQL-backed auth/session, append-only audit-trigger, sequential and concurrent employee-scoped attendance-idempotency, authenticated attendance HTTP/persistence, and two-shift monthly-report smoke checks are configured; PostgreSQL and GitHub Actions runtime evidence remains pending.**

Existing cross-layer Fastify tests use `app.inject()` and exercise route → service → in-memory test repository/provider flows. These remain useful local evidence but do not prove live persistence or database constraints:

- `apps/api/test/routes/auth.test.ts`: login, signed HttpOnly session cookie, `/me`, logout/revocation, origin checks and role-independent session paths through the real `AuthService` with an in-memory repository. `apps/api/test/modules/auth-service.test.ts` covers the five-failure lockout and expiry/reset rules with a fake repository; the Prisma auth adapter is not exercised against PostgreSQL.
- `apps/api/test/routes/attendance-attempts.test.ts`: Employee-only route access, Admin/Supervisor rejection, same-owner idempotent replay across sessions, offline replay and conflicting key/payload behavior through `AttendanceAttemptService` and a memory repository. `apps/api/test/modules/attendance-attempt-prisma-repository.test.ts` separately checks adapter transaction/query calls with mocked Prisma delegates; it does not prove database concurrency/constraints.
- `apps/api/test/routes/attendance-verifications.test.ts`, `attendance-requests.test.ts`, and `stores.test.ts`: Fastify route authorization, Admin/Supervisor/Employee gates where implemented, Supervisor store-scope filtering, and denial behavior with test services/repositories. These are not live authorization queries.
- `apps/api/test/routes/attendance-selfie-uploads.test.ts` and `attendance-verifications.test.ts`: route-level ownership/role checks and `no-store` signed-URL responses with test doubles. `apps/api/test/modules/private-selfie-storage.test.ts`, `selfie-upload-prisma-repository.test.ts`, and related storage tests cover adapter contracts separately with mocked S3/Prisma; no real bucket is contacted.
- `apps/api/test/modules/audit.test.ts` covers audit service validation/sanitization and access rules; auth/store route tests capture audit events with fakes. `PrismaAuditLogRepository` exposes append (`create`) and read (`findMany`) methods only, but immutable behavior/permissions in PostgreSQL are not verified by these tests.

`apps/api/test/postgres-smoke.ts` and `test:postgres` check `/api/v1/health` and database-backed `/api/v1/ready`, then exercise the real Prisma auth repository and Fastify login → `/me` → logout lifecycle against PostgreSQL. The auth fixture is a random synthetic ADMIN with an Argon2 password; the script validates the exact ephemeral CI URL and checks the connected database/user before fixture writes. It verifies the public user response, no-store headers, signed HttpOnly/SameSite cookie, persisted session and audit rows, logout revocation, and rejection of the revoked cookie. It also verifies the migrated `audit_logs_reject_update_delete` catalog entry is enabled on `public.audit_logs` with the expected trigger function and BEFORE ROW UPDATE/DELETE events, then attempts one UPDATE and one DELETE in separate transactions. Each probe must fail with the trigger's exact SQLSTATE/message; afterward both synthetic audit rows must be identical across the selected fields. A further actual-PostgreSQL probe inserts two random synthetic employees, their device bindings, and attempts using the same idempotency UUID: the second employee's attempt must be accepted, while a repeated key for the first employee must fail specifically with SQLSTATE `23505` and constraint `attendance_attempts_employee_idempotency_key`. All of those fixture DML statements are enclosed in one transaction that is always rolled back, even if the duplicate is unexpectedly accepted; rollback command confirmation and zero persisted fixture IDs are required before the assertion passes. A separate random synthetic ADMIN with an Argon2 password exercises BE-008 against the real stack: exactly five concurrent wrong-password requests must each receive the generic 401/no-store response without a cookie or credential echo; PostgreSQL must show five failures and a future `lockedUntil` within the service's 15-minute lock duration, with five generic failure audit rows. A correct-password request while locked must remain the same generic 401, leave the lockout fields unchanged, add its failure audit event, and create no session. INT-005F then sets only that fixture's `lockedUntil` to an explicitly past timestamp, posts the correct password through Fastify, and requires HTTP 200/no-store, a signed HttpOnly/SameSite cookie, the exact public response with no password/token echo, reset `failedLoginAttempts = 0` and `lockedUntil = null`, and exactly one active PostgreSQL session. This makes eight login requests in this smoke, below the unchanged route limit of ten. Database errors and fixture values are suppressed. Each trigger probe always issues `ROLLBACK`, including when an operation unexpectedly succeeds; a rollback failure fails the smoke, and no commit is issued for those probes. `finally` revokes remaining sessions for both exact synthetic account IDs and closes the app/client. Both synthetic accounts and their append-only auth audit rows remain until the disposable CI database is destroyed: deleting either account invokes the audit actor FK's `ON DELETE SET NULL` update, which the immutable audit trigger rejects. The `postgres-integration` GitHub Actions job provisions the existing ephemeral `postgres:17.11-alpine3.24` service, generates Prisma Client, applies migrations with the existing `db:migrate:deploy` step, then runs `test:postgres`; workflow permissions remain read-only and no repository/GitHub secrets are used.

`apps/api/test/postgres-smoke-guard.test.ts` unit-tests the pure `assertEphemeralDatabaseUrl` helper extracted from the smoke script. It accepts the exact CI URL and rejects missing/malformed values plus changes to host/IP, credentials, port, database, schema, query parameters, fragment, URL encoding, or trailing whitespace. Rejections are checked not to echo the supplied URL or credential sentinels. The test imports only the helper and has no environment, filesystem, network, Docker, or database side effects. This validates the pre-connection allowlist only; it does not prove PostgreSQL runtime behavior.

`apps/api/test/postgres-smoke.ts` also configures a concurrent idempotency probe (INT-005H): two identity-checked PostgreSQL sessions submit the same employee/idempotency key; the observer must have explicit `EXECUTE` permission for `pg_blocking_pids(integer)` before fixture DML, and `pg_blocking_pids()` must prove the second session waited on the first before the first transaction is committed. The second insert must fail with SQLSTATE `23505` and the exact employee idempotency index, with one winner before cleanup. Teardown releases the owning transaction first, waits for the blocked query to settle, rolls back the second transaction, then deletes only the exact random attempt/device/employee fixtures and verifies they are absent. This remains a CI-only smoke, not a locally executed test or staging database operation.

`apps/api/test/postgres-smoke.ts` also configures the authenticated attendance HTTP/persistence fixture (INT-005I), using Fastify `app.inject()` and synthetic CI-only data. It logs in a synthetic Employee with an approved device binding and verifies the resulting PostgreSQL session is bound to that device. Before consent, the real attendance route rejects the request without invoking the evidence verifier, inserting an `AttendanceAttempt`, or consuming the pending `SelfieUploadIntent`. The Employee then reads and accepts the explicitly synthetic CI-only consent policy through the real consent HTTP routes. Invalid selfie references and mismatched evidence sizes are rejected; the invalid-size check also confirms no `AttendanceAttempt` is inserted and the pending intent remains unconsumed. An authenticated `CHECK_IN` POST through the real HTTP route must return a `RECORDED` receipt; an identical retry must return the same attempt/attendance IDs as a replay without re-verifying or consuming the selfie intent again. The smoke reads PostgreSQL back to verify the single `AttendanceAttempt`, its assigned shift/store and within-geofence assessment, the linked `Attendance` with sealed selfie and `LocationProof`, and the `SelfieUploadIntent` attached to that attempt. These are configured CI-smoke assertions only: the deterministic evidence verifier uses synthetic references/object keys and does not contact or verify object storage. PostgreSQL and GitHub Actions runtime remain unverified/pending; this is not browser, storage, staging, or live-database evidence.

**Local configuration complete; PostgreSQL execution is pending.** The auth/session, concurrent auth lockout and expired-lock recovery, append-only trigger, sequential/concurrent employee-scoped idempotency, INT-005I authenticated attendance HTTP/persistence, and INT-005J two-shift monthly-report smoke fixtures are configured in the local workspace, and the exact URL guard has pure unit coverage, but the smoke is not run locally without a verified ephemeral database; GitHub Actions has not been triggered or observed. Do not claim PostgreSQL or hosted CI evidence until the existing job succeeds. Guard unit tests do not establish live PostgreSQL behavior. INT-005 remains PARTIAL: scoped reads and real object storage are also unverified. INT-005J does not verify full report query/performance, dashboard-to-JSON/XLSX parity, or an actual workbook. Mock-backed tests and `db:validate` are not PostgreSQL integration coverage.

`apps/api/test/postgres-smoke.ts` also configures a two-shift monthly-report fixture (INT-005J): it creates two distinct synthetic shift assignments for the same synthetic employee, store, and work date, calls the real `PrismaMonthlyReportRepository` through `MonthlyReportService`, and asserts exactly two daily-detail rows but `workDays === 1` in the summary. This is configured CI PostgreSQL evidence only; the database/GitHub Actions runtime has not run.

### INT-006 - Frontend component tests [P0]

**Status: PARTIAL — local state, policy, and rendered-markup evidence exists; interactive browser/device behavior remains unverified.**

| Acceptance area                    | Existing regression evidence                                                                                                                                                                                                                                                                                                                                                                  | Boundary                                                                                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Camera state and permission errors | `apps/web/test/camera-capture.test.tsx` checks safe initial markup and controller transitions; `camera-capture-dialog.dom.test.tsx` mounts the modal to verify action-triggered front-camera/one-shot GPS requests, safe permission denial/retry, gallery exclusion, and track cleanup.                                                                                                       | happy-dom and device mocks do not exercise native permission UI, real camera/GPS hardware, or browser-specific behavior.                            |
| GPS state and permission errors    | `apps/web/test/location-capture.test.ts` covers one-shot location acquisition, error/timeout/accuracy states, retry/cancel behavior, and no background watch; `apps/web/test/location-capture-notice.test.tsx` covers accessible notice markup and coordinate privacy.                                                                                                                        | Notice tests render static markup; native browser permission prompts and actual GPS are not exercised.                                              |
| Liveness state                     | `apps/web/test/liveness.test.ts` covers instruction progression, missing/broken detector, timeout, failure, and permission state; `camera-capture.test.tsx` checks capture gating and the unsupported notice.                                                                                                                                                                                 | No real camera frame or device liveness implementation is claimed.                                                                                  |
| Offline queue state and retry      | `apps/web/test/offline-attendance-queue-view.test.ts` verifies safe row projection; `offline-attendance-queue.test.ts` and `offline-attendance-sync.test.ts` cover encrypted lifecycle/retry; `offline-attendance-queue-network.dom.test.tsx` mounts network/manual-retry states; `offline-camera-queue-quota.dom.test.tsx` mounts quota error, selfie retention, and retry success behavior. | happy-dom/fakes cover these specific interactions only; real quota, network restoration, browser navigation, and device behavior remain unverified. |
| Status badges                      | `apps/web/test/design-system.test.tsx` checks distinct `Perlu verifikasi` and `Absen tertunda` badge labels; employee/review page tests cover status rendering and distinctions.                                                                                                                                                                                                              | Automated visual/color contrast verification is not included.                                                                                       |
| Role route guards                  | `apps/web/test/route-policy.test.ts` covers roles, direct routes, and onboarding gates; `role-shell.test.tsx` and route-specific page tests cover role navigation and page rendering.                                                                                                                                                                                                         | These do not claim a real-browser navigation or device/session integration test.                                                                    |
| Form validation and request errors | `apps/web/test/employee-request-form.test.ts` covers date, reason, overtime, attachment validation and duplicate-submit gating; `employee-requests-component.test.tsx` checks markup; `employee-request-form.dom.test.tsx` mounts the form for accessible errors, submit/loading/success/reset, and safe API-error retention. `api-client.test.ts` covers safe HTTP/transport mapping.        | happy-dom covers these specific interactions only; real browser keyboard/IME, live network, and end-to-end API flow remain unverified.              |
| FE-013A doctor-note download       | `apps/web/test/request-review-attachment.dom.test.tsx` mounts `RequestReviewDetail` with React DOM and happy-dom; it checks eligibility, click/load/retry, safe link attributes, expiry, request reset, and abort.                                                                                                                                                                            | happy-dom is a virtual DOM. It does not prove real-browser navigation, storage access, device behavior, or E2E integration.                         |

#### INT-006A — interactive DOM regression for FE-013A doctor-note download

**Status: COMPLETE for the local virtual-DOM scope; INT-006 remains PARTIAL.**

- `apps/web/package.json` declares `happy-dom@20.11.2` directly as a devDependency; the package metadata requires Node `>=20`, and the workspace uses Node `24.19`. The test uses React `act` and native DOM clicks, with controlled promises and fake timers for expiry. It does not use Testing Library, browser automation, navigation, or real network requests; its URL fixture uses a synthetic `.test` host.
- The 14 mounted tests verify: no URL request on detail render and one request after an eligible click; controls only for Admin/Supervisor `SICK` requests with an attachment; disabled loading and duplicate-click gating; safe temporary link attributes with no URL text or inline preview; safe errors and manual-only retry; expiry removal; URL reset after request change; and abort/stale-result handling on request change and unmount.
- Existing SSR markup and reducer assertions in `review-pages.test.tsx` remain unchanged. Full `pnpm check` passed: web 60 files/343 tests, API 50 files/425 tests, format, lint, typecheck, and both builds. `git diff --check` also passed.
- Evidence stops at happy-dom's virtual DOM. No real-browser, device, navigation, private-storage, or E2E behavior is claimed. INT-006 remains **PARTIAL**; real Chrome Android 9+ / Safari iOS 15+ permissions, camera/GPS hardware, PWA installation, IndexedDB/background behavior, and desktop browser checks remain the separate **INT-008** device/browser matrix gate and were not run here. No application behavior, API, route, or access policy was changed.

#### INT-006B — ambiguous POST empty-state on Admin system disruptions

**Status: COMPLETE for the local virtual-DOM scope; INT-006 remains PARTIAL.**

- The Admin page keeps its regular `Belum ada gangguan tercatat` state. If an ambiguous POST is followed by a ready-but-empty review list, the empty-state now describes only the loaded list and explicitly says it does not prove the POST failed or that the record was not saved. The existing warning, review action, and permanent POST lock are unchanged.
- `apps/web/test/system-disruptions.dom.test.tsx` adds two mounted tests using React `createRoot`/`act`, deterministic API/store module mocks, and a restored dialog prototype shim. It verifies normal empty-state copy, no POST at mount or form preview, one POST only after confirmation, status-0 ambiguity, an empty review result, and no second POST after another submit attempt. No network request is made.
- Focused regression: 2/2 tests pass. Full `pnpm check`: web 61 files/345 tests; API 50 files/425 tests; formatting, lint, typecheck, and both production builds pass.
- happy-dom is a virtual DOM, not a real browser, browser navigation check, or E2E test. No routing, API, schema, or disruption business rule changed; INT-006 remains **PARTIAL**.

#### INT-006C — mounted role-guard direct-route regression

**Status: COMPLETE for the local virtual-DOM scope; INT-006 remains PARTIAL.**

- `apps/web/test/role-route-guard.dom.test.tsx` mounts the real `RequireRole` exported by `App.tsx` under `MemoryRouter`/`Routes`, with the session hook mocked and `fetch` stubbed. Representative routes are checked against `ROLE_NAVIGATION`; the actual `/access-denied` route element uses `AccessDeniedPage`, and a `LocationProbe` observes the redirect path.
- Ten mounted tests cover all three roles allowed on their own registered route, all six cross-role combinations redirecting to `/access-denied` without rendering the protected marker or either loading fallback, and a loading session that stays on the loading state without exposing protected content. Protected children are synthetic markers so no page API or business behavior is exercised. Existing SSR tests for all registered routes and static cross-role denial remain unchanged.
- The test proves mounted React/router behavior in happy-dom only. `MemoryRouter` does not exercise a real browser address bar, browser navigation, device/session integration, or browser-to-API E2E; no route table, policy, app code, API, or business rule was changed. INT-006 remains **PARTIAL**.

#### INT-006D — mounted application route-table/navigation regression

**Status: COMPLETE for the local virtual-DOM scope; INT-006 remains PARTIAL.**

- `apps/web/test/app-routing.dom.test.tsx` mounts the actual `App` with `BrowserRouter` and the existing role navigation. It opens every registered menu destination directly for its assigned role, checks every cross-role direct URL redirects to `/access-denied` without exposing that route's navigation link, and verifies `/` redirects to the canonical landing route for Admin, Supervisor, and Employee. The route table was not found to have a path/role mismatch; the new test closes the gap between policy/isolated page tests and the assembled `App` route table.
- Focused route regression: 4 files / 24 tests passed. Independent workspace `pnpm check` passed: formatting, lint, API/web typecheck, API 52 files / 454 tests, web 68 files / 378 tests, and API/PWA production builds.
- `BrowserRouter` is mounted in happy-dom with a mocked session and stubbed fetch; no real browser, production server deep-link fallback, backend authorization, PostgreSQL, or device behavior is claimed. No production route, API, or business rule changed; INT-006 and INT-007 remain **PARTIAL**.

#### INT-006E — mounted first-login and onboarding flow

**Status: COMPLETE for the local virtual-DOM scope; FE-003's real-browser usability gate and INT-006 remain PARTIAL.**

- `apps/web/test/auth-onboarding-flow.dom.test.tsx` mounts the actual `App` and exercises an unauthenticated deep URL through login, server-supplied consent, initial password change, refreshed session, and the role's canonical dashboard. It verifies consent cannot POST before explicit checkbox acceptance, the exact server policy version is sent, refreshed onboarding state controls route access, direct protected URLs stay closed for onboarding/unavailable sessions, request cookies use `credentials: include` and `cache: no-store`, password inputs clear, and no password/token enters `localStorage` or `sessionStorage`.
- The suite uses a deterministic in-process `fetch` fixture and happy-dom; it is not a real API/database or browser/device test. Focused verification passed: 1 file / 4 tests and web typecheck. No production auth, route, or session code changed.

#### INT-006F — mounted offline queue network state and manual retry

**Status: COMPLETE for the local virtual-DOM scope; INT-006 remains PARTIAL.**

- `apps/web/test/offline-attendance-queue-network.dom.test.tsx` mounts the real `EmployeeOfflineAttendanceQueue` with an isolated `fake-indexeddb` factory. Two tests verify a pending capture stays visible while offline with the sync button disabled and no session/network request; online, an employee session with `deviceBindingStatus: PENDING` is rejected, and clicking manual retry re-checks the session without sending data, displaying a receipt, or deleting the queue item.
- Independent verification passed: focused suite 1 file / 2 tests, complete web suite 71 files / 387 tests, web typecheck, and Prettier. Scope is happy-dom plus fake IndexedDB and a stubbed fetch; this is not real-browser, device, live-network, or API/database E2E evidence. No runtime behavior, API, or route changed; INT-006 and INT-007 remain **PARTIAL**.

#### INT-006G — mounted employee request form interaction

**Status: COMPLETE for the local virtual-DOM scope; FE-012 and INT-006 remain PARTIAL.**

- `apps/web/test/employee-request-form.dom.test.tsx` mounts the production `EmployeeRequestForm` and exercises accessible empty/invalid date errors, no invalid submission, rapid duplicate-submit gating, disabled/loading state, the strict LEAVE payload, success feedback and field reset, plus a synthetic API error that does not leak server detail and preserves entered values for retry.
- Independent verification passed: focused suite 1 file / 3 tests, complete web suite 72 files / 390 tests, web typecheck, and Prettier. happy-dom does not verify real browser keyboard/IME behavior, network, or API/database integration. No runtime behavior, routing, or policy changed; FE-012/INT-006/INT-007 remain **PARTIAL**.

#### INT-006H — mounted camera permission and cleanup flow

**Status: COMPLETE for the local virtual-DOM scope; FE-005/FE-007 and INT-006 remain PARTIAL.**

- `apps/web/test/camera-capture-dialog.dom.test.tsx` mounts the real camera dialog behind a synthetic attendance action. Two tests verify that SSR/closed state makes no device request, the action requests front camera and one-shot high-accuracy GPS only (never `watchPosition`), camera permission denial hides raw browser details and retry succeeds, no gallery input exists, and active stream tracks stop on close/unmount.
- Independent verification passed: focused suite 1 file / 2 tests, complete web suite 73 files / 392 tests, web typecheck, ESLint, and Prettier. Scope is happy-dom with synthetic media/geolocation; it does not prove native permission UI or behavior on Chrome/Safari devices, nor API/database E2E. No runtime, API, or route changed; FE-005/FE-007/INT-006/INT-007 remain **PARTIAL**.

#### INT-006I — mounted offline quota message and retry recovery

**Status: COMPLETE for the local virtual-DOM scope; FE-009 and INT-006 remain PARTIAL.**

- `apps/web/test/offline-camera-queue-quota.dom.test.tsx` exercises the production capture dialog through synthetic camera/GPS/canvas and a queue test double. The test checks the exact quota-safe message, retained selfie/re-enabled action after failure, absence of network/receipt/success claims, then truthful local-pending UI and a single `onQueued` callback only after retry persistence resolves.
- Independent verification passed: focused suite 1 file / 1 test, complete web suite 74 files / 393 tests, web typecheck, ESLint, and Prettier. The UI retry uses a test double; FE-009D separately tests adapter-level `QuotaExceededError` through IndexedDB classes with fake-indexeddb. Neither simulates browser device quota. happy-dom is not real-browser/device/API/database E2E evidence; FE-009/INT-006/INT-007 remain **PARTIAL**.

### INT-007 - End-to-end critical flows [P0]

Automasi minimal:

1. Admin membuat employee, store, shift, assignment.
2. Employee login pertama, consent, ganti password, device binding.
3. Check-in valid dan check-out valid.
4. Check-in di luar radius menjadi pending verification, lalu Supervisor/Admin approve.
5. Offline check-in, reload, online sync, server time/drift check.
6. Duplicate submit tidak menggandakan attendance.
7. Employee request leave/correction, Admin approve/reject.
8. Employee tidak dapat membuka data employee lain.
9. Admin export rekap dan angka sama dengan dashboard.
10. Closing mengunci periode dan override menghasilkan audit.

**Status INT-007: PARTIAL — belum ada automated E2E yang memenuhi kriteria tugas ini.** Audit
runner menemukan Vitest saja: API berjalan pada environment `node`, tanpa browser provider atau
browser automation dependency yang terpasang. Test route Fastify memakai injection; test UI,
service, dan repository memakai batas unit/component masing-masing. Semuanya berguna sebagai
regression coverage, tetapi tidak dihitung ulang sebagai alur browser → API → database E2E.

| Acceptance flow                                                         | Bukti lokal yang sudah ada, bukan E2E                                                                                                                                                                                                                                                                                         | Batas yang belum terverifikasi                                                                                                                                                    |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin membuat employee, store, shift, assignment                        | Test form/UI dan route/service per domain (employee, store, account, schedule)                                                                                                                                                                                                                                                | Tidak ada alur UI berurutan yang menyimpan dan membaca kembali semua entitas melalui PostgreSQL.                                                                                  |
| First login, consent, ganti password, device binding                    | Test auth/account/consent/device-binding pada batas masing-masing                                                                                                                                                                                                                                                             | Tidak ada browser session dan persistence database nyata untuk rangkaian first-login.                                                                                             |
| Check-in/out valid; di luar radius lalu direview                        | Test geospatial, attendance-attempt, selfie-upload, verification, dan dashboard tersedia terpisah                                                                                                                                                                                                                             | Kamera/GPS browser, API proses nyata, storage foto, dan PostgreSQL belum dijalankan bersama.                                                                                      |
| Offline queue, reload, online sync, server drift; duplicate idempotency | Test queue/sync web dan route/service idempotency API tersedia terpisah                                                                                                                                                                                                                                                       | Tidak ada browser automation; PWA app shell belum menyediakan offline attendance submission menurut panduan lokal. Tidak ada alur persistence/sync end-to-end.                    |
| Leave/correction approval; IDOR                                         | Test request dan authorization/IDOR untuk route aktif                                                                                                                                                                                                                                                                         | Correction workflow belum tersedia; hasil repository/authorization belum diuji terhadap database live.                                                                            |
| Dashboard dan export parity                                             | Dashboard API/UI dan UI report Admin/Supervisor memiliki test terpisah; BE-025 menambahkan report JSON/XLSX dengan aggregator bersama dan route/repository tests; INT-005J mengonfigurasi fixture CI PostgreSQL yang menguji dua detail shift pada satu tanggal dan `workDays === 1` melalui repository/service laporan nyata | Fixture INT-005J belum dijalankan dan bukan E2E/parity test: perbandingan dashboard-vs-JSON/XLSX melalui PostgreSQL serta query dan isi workbook nyata tetap belum terverifikasi. |
| Monthly closing, override, audit                                        | Audit/service coverage tersedia untuk operasi yang sudah aktif                                                                                                                                                                                                                                                                | Monthly closing/override workflow belum tersedia; tidak dibuat route atau test fiktif.                                                                                            |

**Blocker lingkungan dan cakupan:** tidak ada `.env` atau `DATABASE_URL`; Prisma memakai PostgreSQL.
Docker Engine tidak berjalan/tersedia pada sesi ini; `STORAGE_ENDPOINT`, `STORAGE_BUCKET`, dan
kredensial storage juga tidak terkonfigurasi. Browser automation/provider tidak terpasang
(`playwright`, `puppeteer`, `cypress`, dan `jsdom`); `happy-dom` hanya tersedia untuk emulasi DOM
virtual INT-006A dan bukan browser. Tidak ada browser atau provider yang diinstal/diunduh. Karena itu
belum ada alur yang layak disebut E2E lokal. Route correction dan monthly closing/override belum ada;
report/export BE-025 kini memiliki UI FE-016 dan regression tests, tetapi belum tercakup E2E. Tidak
ada klaim alur browser ke PostgreSQL untuk fitur tersebut.

**Verifikasi yang feasible:** Vitest API lulus 46 file/396 test dan Vitest web lulus 53 file/302
test, dijalankan langsung dari package masing-masing. Prettier check untuk dokumen ini lulus. Hasil
suite tersebut adalah regression tests, bukan E2E. Fresh migration, seeded multi-role flow, browser
scenarios, serta verifikasi PostgreSQL/storage tetap menunggu dependency yang tercantum di atas.

Smoke HTTP fallback lokal: server Vite 8.3.4 dijalankan langsung melalui Node (tanpa `pnpm install`)
pada `127.0.0.1:5182` dan mengembalikan HTTP 200 untuk `/`, `/employee/history`,
`/supervisor/requests`, dan `/admin/reports`. Keempat respons memiliki HTML app shell yang identik,
dengan `<div id="root"></div>`, `/src/main.tsx`, dan judul `Absensi | CV Anugerah Jaya Abadi`.
Parent menghentikan satu-satunya server yang dijalankan. Bukti ini hanya memverifikasi HTTP SPA
fallback; bukan browser DOM/E2E, role enforcement, API, database, kamera/GPS, instalasi PWA, atau
pengujian perangkat. INT-007 tetap **PARTIAL**.

### INT-008 - Browser/device matrix [P0]

Uji minimal Chrome Android 9+ dan Safari iOS 15+ pada perangkat nyata/representatif, serta Chrome/Edge desktop untuk admin. Catat camera, GPS, PWA install, IndexedDB, background sync, permission, dan performance.

**Status INT-008: PARTIAL — tidak ada perangkat mobile dan tidak ada sesi browser yang dapat dipakai untuk pengujian interaktif.** Tidak ada klaim bahwa kamera, GPS, PWA install, IndexedDB, permission, maupun performance sudah teruji di browser/device sasaran.

**Inventaris lingkungan dan bukti terbatas:** host task adalah Windows. Binary Chrome desktop terpasang (versi file `155.0.8059.39`) dan Edge desktop terpasang (versi file `155.0.4283.45`); inventaris ini bukan bukti browser dijalankan untuk menguji aplikasi. Browser automation yang tersedia hanya menampilkan Codex In-app Browser tanpa tab, dan helper CUA gagal dua kali dengan error `failed to write kernel assets ... path specified`; sesuai instruksi supervisi, UI automation dihentikan dan tidak dicoba lagi. Android 9+ serta iPhone/iPad dengan iOS 15+ atau simulatornya tidak tersedia. Package web hanya mendefinisikan Vitest; tidak ada runner Playwright/Puppeteer/Cypress/DOM browser yang terkonfigurasi. Tidak ada browser/dependency baru yang diinstal atau diunduh.

Web dev server lokal di `http://localhost:5175/` membalas `GET /` dengan HTTP 200 dan HTML berjudul aplikasi; pemeriksaan HTTP ini tidak merender UI atau menguji interaksi browser. API dev server tidak tersedia: menurut supervisi, `pnpm dev:all` gagal dengan `uv_os_get_passwd ENOMEM`. Karena itu tidak ada sesi aplikasi tersambung ke API untuk login atau alur absensi. Tidak ada permission prompt kamera/lokasi yang dibuka atau diterima, tidak ada setting keamanan/privacy yang diubah, dan tidak ada akses service eksternal.

| Target PRD                                        | Ketersediaan di sesi ini                                                                                                              | Camera / GPS / permission                         | PWA install | IndexedDB / background sync                            | Performance  | Hasil                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ----------- | ------------------------------------------------------ | ------------ | ----------------------------- |
| Chrome Android 9+ (perangkat nyata/representatif) | Perangkat/emulator tidak tersedia                                                                                                     | Tidak dijalankan; permission tidak diminta        | Tidak diuji | Tidak diuji pada browser; persistence belum dibuktikan | Tidak diukur | Belum diuji                   |
| Safari iOS 15+ (perangkat nyata/representatif)    | Perangkat/simulator iOS dan Safari tidak tersedia                                                                                     | Tidak dijalankan; permission tidak diminta        | Tidak diuji | Tidak diuji pada browser; persistence belum dibuktikan | Tidak diukur | Belum diuji                   |
| Chrome desktop (admin)                            | Binary versi `155.0.8059.39` ada; tidak ada sesi UI browser yang dapat dikendalikan. Localhost hanya terverifikasi lewat HTTP GET 200 | Tidak dijalankan; tidak membuka/menyetujui prompt | Tidak diuji | Tidak diuji di browser                                 | Tidak diukur | Belum diuji secara interaktif |
| Edge desktop (admin)                              | Binary versi `155.0.4283.45` ada; tidak ada sesi UI browser yang dapat dikendalikan                                                   | Tidak dijalankan; tidak membuka/menyetujui prompt | Tidak diuji | Tidak diuji di browser                                 | Tidak diukur | Belum diuji secara interaktif |

**Inspeksi kode statis saja — bukan hasil matrix browser:** kamera memakai `getUserMedia` dengan `facingMode: 'user'` dan menampilkan fallback saat API/secure context tidak tersedia (`apps/web/src/components/attendance/camera-capture.ts`); lokasi memakai `getCurrentPosition` high-accuracy saat fungsi capture dipanggil (`apps/web/src/components/attendance/location-capture.ts`); PWA mendaftarkan service worker, manifest `standalone`, prompt install browser, dan petunjuk Add to Home Screen untuk iOS (`apps/web/vite.config.ts`, `apps/web/src/components/PwaControls.tsx`). Antrean offline memiliki storage IndexedDB terenkripsi (`apps/web/src/components/attendance/offline-attendance-queue.ts`). Namun Background Sync tidak digunakan: sync hanya foreground saat aplikasi terbuka dan sesi karyawan diverifikasi (`apps/web/src/components/attendance/offline-attendance-sync.ts`). Ini adalah batas implementasi yang diketahui, bukan pengujian dukungan browser. NFR-03 (halaman utama <= 3 detik; proses absen <= 10 detik pada 4G) belum diukur pada perangkat nyata.

**Checklist untuk menuntaskan matrix pada perangkat yang belum diuji:**

1. Catat model perangkat, versi OS, nama/versi browser, tanggal, build aplikasi, dan kondisi jaringan; gunakan lingkungan uji HTTPS serta akun/data sintetis. Jangan memakai data selfie/lokasi karyawan sungguhan.
2. Pada Chrome Android 9+ dan Safari iOS 15+, uji bahwa permission kamera/lokasi baru diminta setelah tindakan absensi yang relevan; operator perangkat memilih Allow/Deny sendiri. Periksa penolakan, retry, kamera depan live tanpa input galeri, lokasi satu-kali, akurasi/radius, dan tidak ada tracking saat aplikasi idle.
3. Uji instalasi PWA dan pembukaan standalone sesuai mekanisme browser/OS, app shell offline, serta persistensi antrean IndexedDB setelah reload dan tutup/buka ulang. Untuk sinkronisasi, catat bahwa implementasi sekarang hanya foreground; jangan tandai Background Sync lulus atau mengharapkan sync saat app ditutup.
4. Pada Chrome dan Edge desktop, jalankan smoke test UI admin dan responsive layout tanpa memerlukan permission kamera/GPS; rekam error console serta kegagalan route/API. Uji alur admin penuh baru setelah API dan database test tersedia.
5. Ukur waktu cold/warm load halaman utama dan alur absensi pada jaringan 4G dengan perangkat nyata, beberapa pengulangan, dan hasil median; bandingkan dengan ambang NFR-03. Pisahkan angka build/performance budget dari pengukuran browser.

**Gate yang lulus pada task ini:** HTTP GET lokal ke `http://localhost:5175/` memberi 200; ini hanya membuktikan dev server mengirim HTML. Pengujian visual/interaktif, camera/GPS, PWA install, IndexedDB runtime, permission timing, dan performance tidak dilakukan. INT-008 tetap PARTIAL sampai checklist perangkat di atas dijalankan dan hasil per browser dicatat. Tidak ada perubahan kode aplikasi, route, atau security/access policy.

## C3. Security and privacy verification - P0

### INT-009 - Authorization/IDOR test [P0]

- Ganti employee ID/store ID/request ID di URL/body.
- Coba Supervisor mengakses toko lain.
- Coba Employee mengakses foto/lokasi/export/audit.
- Coba non-Admin membuat Admin, mengubah radius, closing, backup, atau audit.

Semua harus 403/404 sesuai kebijakan tanpa data bocor.

**Status INT-009: PARTIAL — authorization hardening dan query-shape regression lokal selesai; belum diverifikasi dengan PostgreSQL live.**

| Permukaan aktif                    | Bukti regression yang sudah ada                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Batas / gap yang tersisa                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Employee ID dan data profil        | `employees.test.ts` menguji Supervisor pada list/detail/create/update/deactivate dengan `AuthenticatedSession` fixture, ID/payload valid, dan Origin untuk mutasi; semua 403, service tidak dipanggil, state/audit tetap, body bebas sentinel nama/NIK/hash. Tes Employee tetap ada.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Route-level fixture saja; autentikasi dan persistence PostgreSQL live belum diuji.                                                                                                                                                                                                                                                                                                                                                                                                      |
| Account ID dan elevasi role        | `accounts.test.ts` memakai sesi cookie Supervisor dari auth/device-binding fixture yang disetujui; list/detail, create Admin, update role/status, dan deactivate semuanya 403 sebelum service/repository. State, hash tersimpan, audit tetap; body bebas sentinel akun/password/hash.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Auth/repository fixture hermetic; query dan floor akun di PostgreSQL live belum diverifikasi oleh tes ini.                                                                                                                                                                                                                                                                                                                                                                              |
| Store ID, radius, assignment       | `stores.test.ts` memakai sesi cookie Supervisor fixture; list/detail, create/update radius/koordinat, deactivate, daftar assignment, assign, dan unassign semuanya 403 sebelum service. Snapshot store/employee/assignment, input repository, dan audit tetap; sentinel nama/NIK/koordinat tidak bocor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Route/service/repository fake saja; authorization dan mutasi store/assignment melalui query PostgreSQL nyata belum diuji.                                                                                                                                                                                                                                                                                                                                                               |
| Attendance ID / scope Supervisor   | `attendance-verifications.test.ts` mengirim ID attendance toko lain, ID acak, dan ID malformed. ID lintas toko dan acak memberi 404 yang sama; denial body tidak memuat nama, toko, koordinat, nama perangkat, atau signed URL. Queue filter `storeId` dipertahankan bersama actor scope. `attendance-verification-prisma-repository.test.ts` memeriksa bentuk predicate assignment pada list/detail/decision dan memastikan denial tidak mengubah row, audit, atau notifikasi.                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Predicate tersebut diperiksa dengan Prisma mocks/query-shape, bukan query PostgreSQL live.                                                                                                                                                                                                                                                                                                                                                                                              |
| Employee foto/lokasi/verifikasi    | Route dan service verification tests menolak Employee untuk detail, selfie, dan keputusan sebelum repository/history/storage signer/mutasi dipanggil; body denial diperiksa terhadap sentinel PII. `attendance-selfie-uploads.test.ts` menolak Employee pada signed selfie read; storage hanya dipanggil untuk Admin.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Tidak ada endpoint lokasi mandiri aktif; cakupan lokasi hanya diuji melalui response verifikasi yang ber-role reviewer.                                                                                                                                                                                                                                                                                                                                                                 |
| Attendance attempt / store hint    | `attendance-attempts.test.ts` menguji penolakan role yang bukan Employee, field identitas/otoritas client yang dilarang, scope `storeId` sebagai hint assignment, dan isolasi idempotency antar-employee.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Race/unique-index behavior memerlukan database integration; tidak dibuktikan oleh suite mock.                                                                                                                                                                                                                                                                                                                                                                                           |
| Request ID / lampiran surat dokter | `attendance-requests-prisma-repository.test.ts` membuktikan query detail Employee memuat `employeeId` dari principal dan request milik Employee lain tidak ditemukan. Pada keputusan Supervisor, assignment dibaca sebelum kandidat; predicate kandidat dibatasi ke shift assignment pada store Supervisor dan select scope hanya mengambil ID/jenis/status/tanggal serta store/shift assignments. Test memastikan request lintas toko dan ID acak menghasilkan 404 identik; status non-PENDING tidak mengalahkan 404 sebelum scope, ambiguity yang relevan tetap `REQUEST_REQUIRES_ADMIN`, dan denial tidak membaca proyeksi detail/mutasi/audit/notifikasi. Test alur in-scope memastikan detail baru dibaca setelah scope terbukti dan keputusan tetap menulis update/audit/notifikasi. `docs/API.md` menjelaskan perilaku 404 dan ambiguity; OpenAPI tetap memakai response Problem default yang sudah mencakup error tersebut. | Bukti repository/query-shape memakai Prisma mocks, bukan PostgreSQL live; isolation, predicate SQL aktual, dan race belum terverifikasi. Test route detail/attachment memakai service mock; tidak ada PostgreSQL assertion. Out-of-assignment dan ID acak disimulasikan dengan hasil kandidat kosong berdasarkan filter; verifikasi database nyata tetap diperlukan. Audit read API dan report/export kini aktif; monthly closing, correction, dan lokasi mandiri belum memiliki route. |
| Consent/account query ID           | `auth.test.ts` menolak Employee yang mengirim `accountId` milik akun lain dan memeriksa scope owner untuk history sendiri serta Admin-filtered scope.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Test ini tidak menegaskan body denial bebas dari sentinel PII atau menghitung semua query repository pada denial.                                                                                                                                                                                                                                                                                                                                                                       |

**INT-009A — regresi Supervisor pada permukaan Admin-only:** tiga route suite menambah tiga tes terarah; request memakai input valid pada route aktif dan memeriksa 403/`FORBIDDEN`, `no-store`, tidak adanya kebocoran sentinel, serta tidak adanya pemanggilan service/repository atau mutasi/audit. Hasil terarah: 3 file / 23 tes lulus. Full `pnpm check` lulus (API 52 file / 439 tes; web 66 file / 370 tes; format, lint, typecheck, dan build). Ini bukti route-level hermetic, bukan bukti PostgreSQL live.

**INT-009B — regresi Supervisor pada konfigurasi jadwal Admin-only:** `apps/api/test/routes/schedule.test.ts` menguji 15 route aktif (5 shift, 5 assignment, 5 holiday) menggunakan query/path/payload valid. Semua harus berakhir 403/`FORBIDDEN`, `no-store`, tanpa sentinel, service/repository call, audit, atau mutasi. Suite terarah lulus 1 file / 18 tes. Verifikasi workspace independen: `pnpm check` lulus (API 52 file / 454 tes; web 67 file / 371 tes; format, lint, typecheck, dan kedua build). Bukti ini route-level hermetic; INT-009 tetap PARTIAL sampai PostgreSQL live, IDOR/scope/race yang relevan, dan seluruh permukaan aktif tervalidasi.

**Backlog yang tidak diuji dengan route fiktif:** monthly closing/override, backup, correction
workflow, dan lokasi mandiri tidak terdaftar pada route map maupun `docs/openapi.yaml`. Audit
read-only serta report/export telah memiliki endpoint aktif dan role/scope regression tests.
Test PostgreSQL/IDOR live untuk fitur tersebut tetap memerlukan integrasi database.

**Batas verifikasi:** workspace tidak menyediakan `DATABASE_URL` dan Docker Engine tidak aktif.
Karena itu predicate/query-shape, transaksi, dan conditional update hanya diuji dengan Prisma
mocks; tidak ada klaim bahwa PostgreSQL authorization, isolasi transaksi, atau race behavior telah
divalidasi live. Tidak ada storage live, deployment, atau security certification yang dilakukan.

### INT-010 - Web security test [P0]

Uji HTTPS, secure cookie, CSRF, XSS, SQL injection, SSRF pada storage URL, MIME spoofing, upload size, rate limit, replay/idempotency, CORS, security headers, log redaction.

**Status INT-010: PARTIAL.** The initial INT-010 test-only work added regression coverage for secure production origin configuration, storage URL syntax, hostile API-provided text rendered by the real Employee Admin page, SQL-like input rejected by an active verification filter before service access, and behavioral redaction through an in-process Pino/Fastify logger configured with the exact frozen `loggerRedactions` path set exported by the app. A focused follow-up now also builds `buildApp()` without a logger override, temporarily sets `env.LOG_LEVEL` to `info`, captures `process.stdout.write` locally, and verifies the default app logger emits a probe/censor but none of the fake password, token, cookie, location, or selfie-URL sentinels; the app, stdout spy, and environment value are restored in `finally`. Existing route/service tests also cover Secure/HttpOnly/SameSite cookies, exact-Origin CSRF checks, sensitive-route/login rate limits, employee-scoped idempotency, selfie MIME/signature checks, and the 200 KiB upload limit. A separate follow-up remediation now implements exact-`APP_ORIGIN` credentialed CORS and baseline API response headers, with local regression tests. This changes API security policy/runtime behavior; it does not validate deployment/hosting headers or establish a full security sign-off.

| Kontrol                     | Bukti lokal                                                                                                                                                                                                                                                                                                                                                                                                                                        | Batas validasi                                                                                                                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTPS / secure cookie       | Production `APP_ORIGIN` config regression; auth route asserts `Secure`, `HttpOnly`, and `SameSite=Strict`                                                                                                                                                                                                                                                                                                                                          | TLS termination and browser cookie behavior require a deployed HTTPS environment.                                                                                                                           |
| CSRF                        | Existing route tests reject missing/mismatched `Origin` on state-changing routes                                                                                                                                                                                                                                                                                                                                                                   | No deployed cross-origin browser test.                                                                                                                                                                      |
| XSS                         | SSR test renders hostile employee name/NIK/position through `AdminEmployeesPage`; React emits escaped text                                                                                                                                                                                                                                                                                                                                         | Does not cover browser extensions or active same-origin script compromise.                                                                                                                                  |
| SQL injection               | Active verification `storeId` filter rejects SQL syntax before service call; source audit found parameterized `Prisma.sql` tagged queries and no unsafe raw-query API use                                                                                                                                                                                                                                                                          | No live database query execution; other Prisma ORM filters are not independently injection-tested.                                                                                                          |
| Storage URL / SSRF          | Env tests reject non-HTTP(S), credentials, and fragments on `STORAGE_ENDPOINT`; client URL validation also has unit coverage                                                                                                                                                                                                                                                                                                                       | Runtime object-storage provider is not configured. No signed-upload end-to-end or network-egress/private-address policy validation; storage endpoint is trusted deployment configuration.                   |
| MIME / upload size          | Existing service verifies stored MIME/signature/metadata and rejects corrupted, mismatched, or >200 KiB objects; route rejects unsupported/oversized intent metadata                                                                                                                                                                                                                                                                               | Storage inspection remains mock-backed without the configured provider.                                                                                                                                     |
| Rate limit                  | Existing hermetic route tests assert 429 for login, attendance, accounts, device binding, and signed-upload intent                                                                                                                                                                                                                                                                                                                                 | In-memory/single-instance tests do not prove shared limits across replicas.                                                                                                                                 |
| Replay / idempotency        | INT-009 route tests cover same-employee replay and isolation between employees                                                                                                                                                                                                                                                                                                                                                                     | Database race behavior remains unverified without PostgreSQL integration.                                                                                                                                   |
| CORS / API security headers | Fastify regression tests inject exact configured origin, credentials, `Vary`, finite API methods and `Content-Type` preflight; reject foreign origin, unsupported method/header, and absent allowlist without `Access-Control-Allow-*`. Global response tests cover `nosniff`, `DENY`, and `no-referrer` on success, 404, and 500. A separate active attendance route test confirms foreign-origin mutation remains rejected by exact-Origin CSRF. | Local API behavior only. Still unverified: TLS/browser cross-origin deployment; HSTS/CSP and other web-edge headers; deployed cookie policy; storage provider's separate signed-upload CORS; live database. |
| Log redaction               | In-process test verifies custom Pino/Fastify redaction paths; a separate regression builds `buildApp()` with its default logger, captures stdout locally, and asserts probe/censor presence plus absence of fake password, token, cookie, location, and selfie-URL sentinels                                                                                                                                                                       | Does not prove production log aggregation/retention or external sink behavior.                                                                                                                              |

No external service, browser, PostgreSQL, or deployment was used. Therefore this is not a full security sign-off. Local API CORS and baseline headers now have regression evidence, but validate deployed HTTPS/browser behavior, hosting-side HSTS/CSP and other web headers, storage, and database paths separately.

### INT-011 - Privacy verification [P0]

**Status: PARTIAL** — local regression gates pass, but provider-backed storage, real PostgreSQL transactions, and live device permission behavior remain unverified.

Evidence mapped to criteria:

| Privacy criterion                                                                                                                     | Regression/source evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Boundary and remaining risk                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request location only for a user-started attendance action; never track in background                                                 | `apps/web/test/location-capture.test.ts`: construction/subscription stay idle; explicit `start()` calls `getCurrentPosition` once; `watchPosition` is not called; messages omit coordinates. `apps/web/test/role-shell.test.tsx`: capture is not mounted on ordinary feature navigation and the camera dialog is gated by check-in/out action.                                                                                                                                                 | React SSR/source guard is not a real click-to-permission/browser/device test. No background-location API was added.                                                                                                                                                          |
| Selfie upload/download is private, owner/scope checked, short-lived, and uncached                                                     | `apps/api/test/routes/attendance-selfie-uploads.test.ts`, `attendance-verifications.test.ts`, `apps/api/test/modules/selfie-upload.test.ts`, and `private-selfie-storage.test.ts` cover auth/owner/store scope before signing, indistinguishable denials, `no-store`, TTL caps/expiry, private cache-control, and opaque generated keys.                                                                                                                                                       | Signed URLs intentionally appear only in authorized upload/download response contracts because clients need them; those responses are `no-store` and time-limited. Local signer/mocks do not establish provider ACL, anonymous-access denial, or real URL expiry.            |
| Consent binds authenticated owner and current policy with server facts                                                                | `apps/api/test/routes/auth.test.ts` and `apps/api/test/modules/consent.test.ts` cover forged-field rejection, stale version rejection, principal-derived owner, server acceptance time, current policy version/purposes, idempotency/audit, and omission of hash/IP from public history/response.                                                                                                                                                                                              | Repository tests are local/in-memory; database persistence/concurrency is not live-tested.                                                                                                                                                                                   |
| Logs do not contain raw selfie/photo, precise coordinates, secrets/URLs, or employee identity/contact/IP sentinels                    | `apps/api/test/app.test.ts` captures the default Pino logger. The new synthetic regression initially failed because `employeeId` was emitted; `apps/api/src/app.ts` now redacts employee/account IDs, username, full name, NIK, email, phone, client IP, and remote address in addition to existing token/cookie/selfie/location/URL paths. It also asserts synthetic raw-photo, coordinate, signed-URL, and token sentinels are absent.                                                       | Test covers configured local Pino output, not an external log collector or retention policy. The PRD's immutable business audit trail is a separate data store and intentionally retains its documented actor/IP/device-hash metadata; this task did not change that policy. |
| Attendance receipt and employee-facing offline DTOs do not expose private evidence                                                    | `apps/api/test/routes/attendance-attempts.test.ts` asserts the receipt allowlist and checks synthetic coordinate, selfie reference/bytes, token, owner/device, and signed-URL values are absent. `apps/web/test/offline-attendance-queue.test.ts` asserts IndexedDB stores only ciphertext/opaque metadata; `offline-attendance-queue-view.test.ts` asserts the UI row strips photo, GPS, request body, idempotency/reference, and signed-URL sentinels. Acknowledgement becomes receipt-only. | The encrypted queue must transiently contain/decrypt selfie and GPS in application memory to support the PRD offline flow; this is not plaintext IndexedDB metadata or the employee-facing view DTO. Authorized signed-URL responses are the explicit API exception above.   |
| Object keys and selfie retention do not encode identity; purge removes live selfie while preserving numeric attendance/audit metadata | `apps/api/test/modules/selfie-upload.test.ts` checks random staging/accepted keys and retention expiry/idempotent deletion/retry. `selfie-upload-prisma-repository.test.ts` checks exact capture-pointer clearing, rollback/retry behavior, and that attendance, attempt, and audit rows are not deleted.                                                                                                                                                                                      | Prisma transaction/rollback behavior is tested with mocks, not PostgreSQL. Object deletion is mocked; no live bucket or deployed scheduler is configured.                                                                                                                    |
| Doctor-note storage stays separate from selfie lifecycle                                                                              | `apps/api/test/modules/private-request-attachment-storage.test.ts` asserts the isolated `attendance-requests/doctor-notes/` prefix, no public ACL, and its separate short-lived read URL. `apps/api/test/modules/attendance-requests.test.ts` asserts opaque keys, no key/attachment bytes in DTO, authorization before signing, and cleanup on persistence failure.                                                                                                                           | Doctor-note bucket policy/provider ACL and its own retention/deletion policy are not configured or verified; selfie retention is not applied to it.                                                                                                                          |

Privacy issue found and narrowly patched: the default application logger leaked structured `employeeId` (and the same probe covers other known account/contact/IP fields). The regression test failed before the `loggerRedactions` update and passes after it. No consent/retention policy, route, or storage lifecycle was changed. Other new test assertions verify the attendance receipt allowlist and removal of signed-URL sentinels from the offline UI DTO.

Local final verification by the task agent: API focused suite 10 files / 76 tests; web focused suite 7 files / 61 tests; workspace `pnpm format:check`, `pnpm typecheck`, and `pnpm lint` pass. Independent supervisor verification then ran the full `pnpm check`: API 46 files / 401 tests, web 53 files / 302 tests, format/lint/typecheck and API/web production builds pass. The build retains an advisory 580.02 kB JS chunk (>500 kB), while the configured performance budget passes (650,409/665,600 raw bytes; 169,409/184,320 gzip bytes). All privacy probes use synthetic sentinels. No real photo, location, credential, permission prompt, cloud/provider, database, or remote write was used.

Not verified: real browser click-to-permission and device matrix; live bucket ACL, signed URL access/expiry and deletion; PostgreSQL transaction rollback/concurrency; deployed retention scheduler and environment configuration. No `DATABASE_URL` or object-storage provider credentials were used. This remains a local privacy regression check, not a live privacy/security sign-off.

## C4. Performance and operational integration - P1

### INT-012 - Performance test [P1]

**Status: PARTIAL** — INT-012A route-level code splitting, bundle budgets, and the production attendance HTTP request-body aggregate pass locally. Browser timing and live database workload remain unverified.

- Halaman utama <=3 detik pada target normal.
- Flow absensi <=10 detik pada 4G normal.
- Payload satu absensi <=300 KB.
- Uji minimal 200 employee/20 store fixture.
- Uji dashboard/report/export dengan pagination dan index.

Local gates and evidence:

- Every web production build measures `dist/index.html` and its directly referenced JavaScript/CSS, both raw and gzip (Node gzip level 9). The baseline build measured 531,043 raw bytes and 142,328 gzip bytes. Budgets are 650 KiB raw (665,600 bytes, about 25% above baseline) and 180 KiB gzip (184,320 bytes, about 30% above baseline); these guard bundle growth and do not prove a three-second browser load.
- **INT-012A complete:** every page module dispatched by `RolePage` uses a statically analyzable dynamic import and React `lazy`; login, session/auth, shell, and `RequireRole` stay in the eager app shell. A shared accessible Suspense fallback reports page loading. `ROLE_NAVIGATION`, route paths, route branches, role policy, and API authorization contracts are unchanged.
- Latest full verification after INT-012A: `pnpm check` passed. Web: 59 files / 323 tests; API: 50 files / 424 tests. The minified entry JS chunk is 302,970 bytes (302.97 kB; 94.91 kB gzip), down from the 581.78 kB pre-change entry; the largest route page chunk is `RoleHome` at 66.25 kB (17.81 kB gzip). Vite emits no chunk-over-500-kB advisory, and its default threshold was not changed. Initial assets (HTML plus directly referenced JavaScript/CSS) are 326,948/665,600 raw bytes and 100,029/184,320 gzip bytes; both configured budgets pass.
- `apps/web/test/attendance-api.test.ts` exercises the production prepare/submit builder with a maximum-size 200 KiB selfie Blob, captures the three actual fetch request bodies (intent POST JSON, signed selfie PUT Blob, attendance attempt POST JSON), and asserts their aggregate is <=300 KiB (307,200 bytes). With that deterministic fixture, UTF-8 body sizes are 47 + 204,800 + 388 = 205,235 bytes (200.43 KiB), leaving 101,965 bytes below the cap. This is HTTP body content only; headers and transport framing are excluded.

Unverified:

- Home <=3s and attendance <=10s on normal/4G networks require browser/device timing plus network shaping; no usable browser/CUA session or target-device/network setup is available. These runtime SLA targets are not inferred from build size or unit tests.
- INT-012A route/page and authorization regressions use React streaming/static server rendering in Vitest; no browser runtime, visual rendering, or physical-device SLA was measured.
- The 200 employee/20 store workload requires a database-backed fixture. The safe demo seed contains one employee and one store; Docker/PostgreSQL and `DATABASE_URL` are unavailable. No synthetic repository benchmark was added because it would measure mock/application serialization rather than database throughput.
- Admin and employee dashboard routes exist and accept bounded pagination parameters, but their latency/query plans have not been measured against a realistic database fixture. BE-025 report/export routes are registered, but query plans and load performance are unverified. Schema index declarations alone do not prove dashboard/report query plans or pagination performance; `EXPLAIN ANALYZE`/load validation requires a live PostgreSQL workload.

### INT-013 - Data reconciliation [P1]

**Status: PARTIAL — data reconciliation lintas sumber belum dapat dilakukan.** Audit hanya menemukan sumber aktif berikut:

| Sumber aktif                                                                                           | Yang benar-benar tersedia                                                                                                                                                                                                 | Batas untuk rekonsiliasi                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/dashboard` (`apps/api/src/routes/dashboard.ts`, `modules/dashboard/prisma-repository.ts`) | Ringkasan status per shift terjadwal, daftar `NOT_CHECKED_IN`/`ABSENT` yang dipaginasi, tren 30 hari, dan ranking telat. Query status menggabungkan jadwal, attendance aktif, pengajuan, dan `daily_attendance_statuses`. | Bukan detail lengkap per shift. `scheduledShifts` mengecualikan `HOLIDAY`; summary tidak menyediakan counter holiday, early-leave, missing-checkout, atau unattributed-attendance. Daftar belum check-in hanya mencakup dua status dan bisa terpotong pagination. Karena itu detail yang tersedia tidak dapat dijumlahkan ulang untuk membuktikan seluruh summary atau denominator. |
| `GET /api/v1/me/dashboard`                                                                             | Status shift hari ini, riwayat event attendance mentah karyawan sendiri, dan daftar status pengajuan pribadi, seluruhnya terpaginasikan/terscope.                                                                         | Riwayat event bukan rekap status per shift; tidak menyediakan populasi semua karyawan, status harian final, atau agregat bulanan.                                                                                                                                                                                                                                                   |
| Job `daily-status:run` dan modul `daily-attendance`                                                    | Membuat status `ABSENT` setelah cutoff shift + 2 jam jika seluruh guard lolos; memetakan attendance valid/disetujui atau pending ke status harian.                                                                        | Job menulis status, bukan endpoint summary/detail. Tes service/repository yang tersedia tidak membuktikan rekonsiliasi terhadap PostgreSQL live.                                                                                                                                                                                                                                    |
| `/api/v1/attendance/requests`                                                                          | Pengajuan/keputusan `LEAVE`, `SICK`, `ANNUAL_LEAVE`, dan `OVERTIME`; dashboard membedakan pengajuan izin yang disetujui dari request pending.                                                                             | `CORRECTION` belum menjadi tipe request aktif. Overtime hanya memiliki menit pada record request yang disetujui Admin; tidak ada agregat lembur bulanan. Request bukan sumber rekap attendance tersendiri.                                                                                                                                                                          |

**Perbandingan yang belum tersedia:** monthly JSON/detail dan export XLSX kini aktif pada route map/OpenAPI; fixture unit/route menyamakan hasil serializer dengan aggregator yang sama. Namun belum ada PostgreSQL-backed fixture untuk membandingkan hasil query database/dashboard/monthly/detail/export. Correction dan closing tetap backlog; overtime dihitung di laporan BE-025 tetapi belum masuk agregat dashboard. `PENDING_OFFLINE` yang masih provisional termasuk `WAITING_VERIFICATION`, sehingga dashboard tidak memisahkannya sebagai hitungan offline tersendiri. Hari libur membentuk status shift `HOLIDAY`, tetapi tidak dihitung ke `scheduledShifts` dan tidak memiliki field counter di response summary.

Tes dashboard/daily-attendance yang sudah ada memverifikasi aturan layanan, bentuk query, dan perilaku dengan mock; tes BE-025 tambahan memeriksa aggregator, bentuk query dan filter, route scope, kontrak workbook, serta round-trip workbook memakai dependency ExcelJS. Tes tersebut bukan perbandingan data hasil query PostgreSQL. Formula lokal eksplisit: `workDays` adalah jumlah tanggal kalender unik per karyawan dari jadwal non-holiday yang telah tiba/berjalan; beberapa shift pada tanggal yang sama dihitung sekali. Durasi work pair dibulatkan ke menit terdekat lalu dikurangi break shift; menit telat adalah selisih sejak mulai terjadwal (toleransi disertakan), dibulatkan ke menit terdekat. Denominator tanggal unik telah dikonfirmasi pemilik produk; dashboard ranking tetap mengekspos desimal menit sejak jadwal mulai.

**Syarat menuntaskan INT-013:** jalankan fixture terisolasi pada PostgreSQL untuk membandingkan dashboard, monthly JSON, detail, serta kedua sheet XLSX. UI report Admin/Supervisor kini tersedia pada FE-016. Tambahkan correction/closing ke rekonsiliasi hanya setelah workflow terkait tersedia. Tanpa database tersebut, tidak ada klaim rekonsiliasi live.

### INT-014 - Failure/recovery test [P1]

**Status INT-014: PARTIAL.** No reproducible application failure bug was found during this checkpoint. Local regression coverage was added for offline queue preservation and API timeout/reopen; the existing bounded retention loop was extracted into a testable runner without changing batch size, limit, output fields, cleanup policy, or exit criteria.

| Failure/recovery case                        | Local evidence                                                                                                                                                                                                                                                                                                                                                          | Boundary                                                                                                                                                                                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Offline before sync                          | `apps/web/test/offline-attendance-sync.test.ts` verifies no request starts and encrypted queue item/selfie remain pending.                                                                                                                                                                                                                                              | No real airplane-mode/browser session or service-worker background sync. The app currently syncs in foreground only.                                                                                  |
| API timeout and restart/reopen               | Same test times out the intent request, reopens the queue over the same persistence adapter, then retries successfully. Existing ambiguous-POST coverage persists the frozen request body before dispatch and replays it byte-for-byte after reopen; API route tests verify same-owner idempotent replay.                                                               | Timeout/reopen are deterministic client/queue tests, not a browser process kill or a PostgreSQL concurrency test.                                                                                     |
| Storage timeout and expired signed URL       | Existing `apps/api/test/modules/selfie-upload.test.ts` covers storage-unavailable errors and preserves retry metadata after partial cleanup; `apps/api/test/modules/private-selfie-storage.test.ts` checks generated short-lived URL parameters. The review UI exposes a manual “Muat ulang foto” action after expiry/load failure.                                     | No provider-facing timeout/403/expiry test was added. Real bucket signing, expired-URL rejection/renewal, partial object cleanup, and retry behavior require the configured private storage provider. |
| Duplicate job and retention failure/recovery | `apps/api/test/modules/selfie-upload.test.ts` runs retention cleanup twice and checks idempotence; it verifies failed deletion retains retry metadata and a later run succeeds. `apps/api/test/jobs/selfie-retention-runner.test.ts` checks aggregate results, stop-on-failure, generic thrown-failure result, and nonzero exit outcome after the 100-batch safety cap. | Runner tests exercise local orchestration with a deterministic batch callback; no production scheduler, PostgreSQL, or bucket is configured.                                                          |
| Crash during sync / no duplicate raw attempt | Existing `apps/web/test/offline-attendance-sync.test.ts` simulates an ambiguous response after POST dispatch, then reopens the queue and replays the exact persisted body; API route coverage checks idempotent replay.                                                                                                                                                 | This models an interrupted/ambiguous request and restart boundary, not forcibly terminating a real browser or server process.                                                                         |
| Duplicate webhook / DB failover              | No webhook route or webhook consumer exists in the current route map.                                                                                                                                                                                                                                                                                                   | No cloud webhook/provider or isolated PostgreSQL/`DATABASE_URL` is available; no fake repository is used to claim failover behavior.                                                                  |

Related targeted suites pass: API **8 files / 69 tests** (retention runner, selfie upload/storage, upload repository, offline timing, and attendance/selfie routes) and web **3 files / 25 tests** (offline sync/queue and reviewer API). The job runner unit test exercises batch aggregation/exit decisions with a deterministic callback only; it does not simulate or claim database, storage, scheduler, or provider behavior. No business policy, route, or PRD behavior was changed. Continue to staging with real PostgreSQL, private storage, scheduler, and browser/process restart before marking complete.

# D. Deployment dan Operasional

## D1. Environment - P0

### DEP-001 - Local development reproducible [P0]

- README menjelaskan prerequisite, install, env, migration, seed, test, lint, build, dan run.
- Sediakan seed non-produksi untuk Admin, Supervisor, Employee, store, shift, holiday, dan fixture status.
- Sediakan Docker/compose atau equivalent bila sesuai stack.
- Seed tidak boleh memakai password produksi.

**Status DEP-001B: PARTIAL — web/API server startup and Vite routing smoke passed; database-backed auth is not configured.**

- With `pnpm dev:all` started outside the restricted sandbox, API liveness returned HTTP 200 and Vite served the actual app shell with HTTP 200 for direct requests to `/employee/history`, `/supervisor/requests`, and `/admin/reports`. Vite selected port `5175` because unrelated listeners already occupied `5173` and `5174`; only the process launched for this smoke was stopped, and the other listeners were left untouched.
- The Vite-proxied `GET /api/v1/health` returned HTTP 200. `GET /api/v1/auth/me` returned HTTP 404 in this no-`DATABASE_URL` run because `server.ts` registers auth routes only when Prisma is configured; this is not evidence of an incorrect client path. Login/session, migrations, seed, and PostgreSQL-backed routes were not exercised.
- The normal restricted sandbox could not start the API because Node `os.userInfo()` failed with `uv_os_get_passwd / ENOMEM`; the HTTP smoke therefore used an approved temporary local process outside that sandbox. No user-owned service was stopped. Docker Engine remains unavailable, and the smoke does not establish browser rendering or E2E.

### DEP-002 - Staging infrastructure [P0]

- **Target staging dipilih:** DigitalOcean App Platform region `SGP` untuk Vite static
  frontend dan Fastify API; service API memakai `apps-s-1vcpu-1gb-fixed` (1 shared vCPU,
  1 GiB, 100 GiB outbound allowance) dengan satu instance default; DigitalOcean Managed
  PostgreSQL Standard single-node 1 GiB RAM di `SGP1` (non-HA); DigitalOcean Spaces Standard
  di `SGP1` dengan bucket private (250 GiB storage, 1.024 GiB outbound allowance)
  untuk selfie. Baseline biaya diperkirakan sekitar **$30/bulan**: API $10 + PostgreSQL
  mulai sekitar $15 + Spaces $5; static site diasumsikan $0 incremental dalam app yang
  memiliki API berbayar. Estimasi belum termasuk pajak/overage, belum disetujui, dan harus
  dikonfirmasi pada akun/region. API fixed-size tidak autoscale dan PostgreSQL single-node
  non-HA; allowance/overage transfer dan storage dapat menambah biaya. Ini sizing staging,
  bukan production. Container dan konfigurasi aplikasi tetap
  vendor-agnostic. Rincian dan tautan dokumen resmi ada di
  [`docs/DECISIONS.md`](./DECISIONS.md#keputusan-deployment-staging).
- Jangan membuka object selfie/bucket secara publik atau mengaktifkan Spaces CDN untuk
  selfie. Akses baca memakai signed URL berumur pendek yang diterbitkan server setelah
  otorisasi.
- App Platform scheduled jobs hanya untuk job yang cadence minimum 15 menitnya
  memenuhi kebutuhan. Job dengan cadence lebih rapat memakai always-on worker; usulan
  revisi arsitektur harus memiliki justifikasi eksplisit sebelum implementasi.
- Provision account dan resource, secrets, bucket/access policy, domain staging,
  CORS/cookie/trusted proxy, dan verifikasi aktual ketersediaan/config provider masih
  pending. Notification sandbox juga belum dikonfigurasi.
- HTTPS wajib karena camera/GPS browser hanya bekerja aman di HTTPS.
- Konfigurasikan timezone dan cron/queue setelah resource tersedia.
- [x] DEP-002A local-only: `.do/app.yaml` dan `docs/runbooks/digitalocean-staging.md` menyiapkan static web + API same-origin dengan deploy-on-push mati dan plan API eksplisit `apps-s-1vcpu-1gb-fixed`, tanpa database/Spaces resource atau secret di spec. Estimasi baseline sekitar $30/bulan (bukan persetujuan) dicatat; YAML sintaks lokal, validasi provider/account dan harga aktual masih pending.

**Status DEP-002: PREPARED LOCALLY — target, plan API, dan estimasi biaya staging diperbarui lokal; estimasi belum disetujui. Provisioning, account/region price confirmation, secrets, dan verifikasi provider tetap pending.**

### DEP-003 - Production infrastructure [P1]

- Pisahkan account/project/storage/database produksi dari staging.
- Aktifkan HTTPS/TLS, DNS, HSTS setelah tervalidasi, secure cookies, CORS allowlist.
- Gunakan managed DB/private network bila tersedia.
- Batasi public access ke API yang memang dibutuhkan.

## D2. CI/CD dan release - P0/P1

### DEP-004 - CI pipeline [P0]

- Status: workflow `.github/workflows/ci.yml` disiapkan secara lokal untuk `pull_request`, `push`, dan `workflow_dispatch`; eksekusi GitHub Actions belum diverifikasi.
- Workflow memakai checkout tanpa persist credential, permission minimum `contents: read`, setup pnpm 11.25.0 + Node.js 22 dari `pnpm-lock.yaml` (frozen install), lalu menjalankan `pnpm --filter @absen/api db:validate`, `pnpm audit --audit-level=high`, dan `pnpm check`.
- Audit ini hanya dependency advisory audit level high ke atas; bukan full SAST, code scanning, atau secret scanning. Workflow tidak mengakses secret dan tidak melakukan deployment.
- DEP-004B: root `pnpm-workspace.yaml` mem-pin dependency transitif Prisma yang terdampak advisory: `deepmerge-ts@7.1.5` ke `8.0.2` dan `mysql2@3.15.3` ke `3.24.4`; `pnpm-lock.yaml` diregenerasi. Audit lokal `pnpm audit --audit-level=high` (dengan akses registry) lulus: tidak ada vulnerability yang diketahui; snapshot full audit mencatat 751 dependency dan 0 advisory di seluruh severity (`docs/DEP-004B-pnpm-audit.json`). Prisma schema validation lulus secara independen.
- Pin tersebut sementara sampai rilis Prisma stabil mengadopsi versi aman secara transitif; jangan menghapus atau mengganti pin sebelum lockfile diregenerasi dan audit lulus. Snapshot dan keberadaan workflow tidak membuktikan job GitHub Actions telah berjalan.
- Status verifikasi penuh setelah perubahan pin: `pnpm check` lulus dari parent setelah FE-TEST-ROBUSTNESS-001 dan FE-TEST-ROBUSTNESS-002; format, lint, typecheck, web 70 file / 384 tes, API 52 file / 454 tes, Prisma Client generation, kedua production build, dan asset budget lulus. Timeout khusus pada dua tes exhaustive lazy-routing dinaikkan menjadi 15 detik tanpa mengubah assertion role/path/lazy-load/marker. Initial assets: 327.818/665.600 byte raw dan 100.303/184.320 byte gzip.
- Backend integration tests/live PostgreSQL belum termasuk. Tetap menjadi gate terpisah INT-005 sampai provider database dan `DATABASE_URL` tersedia; `db:validate` hanya memvalidasi schema, bukan menjalankan migrasi pada database.
- Jangan deploy jika P0 check gagal. Validasi lokal YAML tidak menggantikan eksekusi workflow oleh GitHub Actions.

### DEP-005 - Staging deployment [P0]

- Deploy dari commit immutable.
- Jalankan migration terkontrol.
- Jalankan smoke test: health, login, camera page served over HTTPS, API auth, storage signed URL, queue/worker.
- Simpan build/version identifier pada health endpoint.

**Status deployment: NOT STARTED.** Readiness route yang tersedia hanya bukti lokal; PostgreSQL live,
staging, migration deployment, dan HTTPS smoke tests belum dikonfigurasi atau diverifikasi. Kontrak
identifier build lokal siap: `GET /api/v1/health` mengirim `X-App-Version` hanya dari `APP_VERSION`
yang tervalidasi. Binding lokal `APP_VERSION` ke source commit App Platform telah disiapkan; verifikasi
health/header/HTTPS pada deployment aktual masih pending. DigitalOcean adalah target staging yang
dipilih, tetapi belum diprovisioning atau diverifikasi; provider production belum diputuskan.

### DEP-006 - Production release gate [P1]

Sebelum production: semua P0 acceptance lulus; device matrix lulus; security checklist ditandatangani; backup terbaru terverifikasi; rollback image/build tersedia; admin seed dibuat aman; retention/cron/notification/monitoring aktif; owner bisnis menyetujui radius, toko, shift, supervisor, dan metode validasi alternatif. Catat juga keputusan scope Admin 2FA (mandatory/optional, factor, recovery, operator) dan named owner untuk incident/rollback.

**Status release checkpoint 2026-10-15: NOT GO-LIVE READY.** Lihat [AUD-26 release snapshot](./audit/2026-10-14/AUD-26-RELEASE-STATUS.md) untuk pemisahan bukti local, PostgreSQL, browser/device, staging/provider, dan production serta owner blocker. Checkpoint ini tidak mengubah keputusan bisnis dan tidak mengklaim staging atau production sudah diuji.

### DEP-007 - Migration and rollback [P0]

- Migration backward-compatible bila aplikasi rolling deploy.
- Backup sebelum migration berisiko.
- Dokumentasikan rollback dan kapan tidak boleh rollback karena data sudah berubah.
- Jangan memakai `reset database`, `force push`, atau destructive migration di production.
- Runbook repository ditulis di [`docs/runbooks/database-migrations.md`](./runbooks/database-migrations.md): command Prisma yang benar-benar tersedia, pola expand-contract, rollback aplikasi vs database, forward-fix, dan contoh dump/restore yang dikunci ke Compose lokal.

**Status DEP-007: PARTIAL** — dokumentasi repository dan pemeriksaan command/schema tersedia; staging database belum diprovisioning, belum ada migration deployment staging/production yang dibuktikan, dan belum ada backup/restore drill terverifikasi. Belum boleh ditandai COMPLETE.

## D3. Monitoring, backup, recovery - P1

### DEP-008 - Monitoring and alerting [P1]

Pantau uptime, 5xx, latency, login failures, lockouts, attendance success/pending/rejected, offline queue age, verification SLA breach, storage errors, failed jobs, backup age, disk/storage, DB connections, dan SSL expiry.

### DEP-009 - Backup [P1]

- Daily DB backup retention 30 hari.
- Weekly backup retention 3 bulan.
- Enkripsi at rest dan in transit.
- Lokasi backup terpisah.
- Tetapkan policy object storage untuk foto wajah dan jangan memasukkannya ke backup dengan retention yang tidak disetujui.

### DEP-010 - Restore drill [P1]

- Restore ke environment terisolasi minimal setiap 3 bulan.
- Verifikasi user, attendance raw, audit log, request, recap, dan object references.
- Ukur RPO <=24 jam dan RTO <=4 jam.
- Simpan hasil drill dan masalah perbaikan.

### DEP-011 - Retention job [P1]

- Purge selfie yang melewati 12 bulan.
- Pertahankan numeric attendance, audit metadata yang diwajibkan, dan referential integrity.
- Job idempotent, dry-run, metric deleted/skipped/failed, retry aman.

## D4. Go-live dan handover - P1

### DEP-012 - Pilot [P1]

- Pilot dengan sebagian employee dan minimal satu toko.
- Uji indoor/outdoor, radius realistis, GPS 5-20 m error, internet putus, mode pesawat, device replacement, assisted attendance, dan approval SLA.
- Kumpulkan bukti dan issue; jangan memperlebar radius hanya untuk menghilangkan error tanpa keputusan bisnis.

### DEP-013 - Production data setup [P1]

- Import employee/account secara aman.
- Input koordinat/radius/accuracy tiap toko setelah uji lokasi.
- Set assignment employee-store dan shift.
- Set supervisor scope.
- Pastikan dua Admin aktif.

### DEP-014 - Runbook dan training [P1]

Dokumentasikan cara: login pertama, ganti HP, GPS error, approval pending, offline sync, assisted attendance, correction H+3, system disruption, closing, export, backup restore, dan incident escalation.

### DEP-015 - Go-live checklist [P1]

- HTTPS/camera/GPS verified.
- Login/roles/device binding verified.
- Store/radius/shift verified.
- Camera no-gallery verified.
- Offline sync verified.
- Pending verification workflow staffed.
- Dashboard/export/closing verified.
- Backup/restore/monitoring verified.
- Privacy notice/consent approved.
- Rollback owner and incident contact assigned.
- Admin 2FA scope and recovery/operator decision recorded; implementation and test status match that decision.

**Status DEP-015: OPEN.** Tidak ada nama rollback owner atau incident contact dan tidak ada bukti staging drill di checkpoint 2026-10-15. Jangan menyetujui go-live sampai semua item di atas memiliki bukti dan penanggung jawab yang ditetapkan.

## 4. Urutan Sprint yang Disarankan

### Sprint 0 - keputusan dan fondasi

`BE-001..BE-007`, `FE-001..FE-002`, `INT-001`, `DEP-001`.

Output: repo runnable, schema awal, enum, API contract, authorization skeleton, PWA shell, local setup.

### Sprint 1 - akun dan master data

`BE-008..BE-012`, `FE-003..FE-004`, `INT-002`, `INT-005` sebagian.

Output: login aman, role scope, employee/device/store/shift/holiday CRUD.

### Sprint 2 - online attendance

`BE-013..BE-017`, `FE-005..FE-008`, `INT-004..INT-007` critical path.

Output: selfie + liveness + GPS + geofence + valid/pending + verification.

### Sprint 3 - offline dan kondisi khusus

`BE-018..BE-020`, `FE-009`, `INT-008..INT-011`.

Output: offline queue, sync, absent guard, security/privacy test, device matrix awal.

### Sprint 4 - requests dan dashboard

`BE-021..BE-024`, `FE-011..FE-015`.

Output: izin/sakit/cuti/lembur/koreksi, approval, disruption, dashboard, notifications.

### Sprint 5 - reports dan production readiness

`BE-025..BE-027`, `FE-016..FE-017`, `INT-012..INT-014`, `DEP-002..DEP-011`.

Output: rekap/Excel/closing, audit, backup, staging, monitoring, restore drill.

### Sprint 6 - pilot dan go-live

`DEP-012..DEP-015`, `INT-*` regression penuh, lalu production release gate.

## 5. Hal yang Secara Eksplisit Tidak Boleh Dilakukan

- Jangan membuat payroll, fingerprint, atau face recognition otomatis pada fase ini.
- Jangan menerima foto galeri untuk absensi.
- Jangan melakukan tracking lokasi background.
- Jangan menjadikan absen di luar radius sebagai `Tidak hadir`.
- Jangan menghapus attempt yang gagal; ubah status dan simpan alasan.
- Jangan memakai client time sebagai waktu resmi.
- Jangan mengubah attendance asli untuk koreksi.
- Jangan membuat URL foto publik permanen.
- Jangan memberi Supervisor akses lintas toko.
- Jangan menambahkan Admin terakhir jika jumlah Admin aktif akan kurang dari dua.
- Jangan menutup periode atau mengubah radius tanpa audit log.
- Jangan melakukan force-push ke branch utama atau destructive migration production.
