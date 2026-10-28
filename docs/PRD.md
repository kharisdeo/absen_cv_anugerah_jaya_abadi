# PRD Website Absensi CV Anugerah Jaya Abadi

Versi: 2.0  
Sumber: `requirment_absen_cv.pdf` / SRS Sistem Absensi Karyawan Berbasis Web/PWA  
Tanggal: 10 Oktober 2026  
Status: Draft siap validasi bisnis dan teknis

## 1. Ringkasan Produk

Website Absensi CV Anugerah Jaya Abadi adalah aplikasi Progressive Web App (PWA) berbahasa Indonesia yang dibuka melalui browser HP/laptop dan dapat ditambahkan ke layar utama. Karyawan melakukan absen masuk dan pulang menggunakan selfie dari kamera depan secara langsung serta validasi lokasi GPS hanya ketika tombol absen ditekan.

Sistem harus tetap adil ketika GPS tidak akurat, internet terputus, kamera/perangkat bermasalah, atau server mengalami gangguan. Setiap upaya absen disimpan. Kegagalan validasi tidak langsung menjadi `Tidak hadir`, melainkan menjadi `Perlu verifikasi` atau `Absen tertunda` sesuai kasus.

## 2. Tujuan dan Batasan

### Tujuan

- Mencatat kehadiran masuk dan pulang secara akurat serta sulit dimanipulasi.
- Memudahkan admin mengelola karyawan, toko, jadwal, izin, lembur, koreksi, dan rekap.
- Menyediakan prosedur yang adil saat GPS atau internet bermasalah.
- Menyediakan dashboard, rekap bulanan, ekspor Excel, backup, keamanan, dan audit trail.

### Termasuk dalam produk

Login dan hak akses, device binding, absen selfie + GPS, multi-lokasi toko, geofence, jadwal/shift, toleransi telat, mode offline PWA, QR dinamis/Wi-Fi/supervisor sebagai validasi alternatif, izin/sakit/cuti/lembur, koreksi absensi, verifikasi, dashboard, notifikasi, rekap, Excel, closing bulanan, audit log, backup, dan pengaturan privasi.

### Tidak termasuk tahap ini

Payroll, integrasi mesin fingerprint, dan pengenalan wajah otomatis. Liveness check dasar tetap termasuk sebagai anti-curang awal; peningkatan computer vision dapat dipertimbangkan di tahap lanjut.

## 3. Peran dan Hak Akses

| Peran | Cakupan |
|---|---|
| Admin | Seluruh toko, karyawan, akun, aturan, jadwal, pengajuan, verifikasi, laporan, backup, audit, dan pengaturan. Admin dapat juga menjadi karyawan jika memiliki profil karyawan. |
| Supervisor/Kepala Toko (opsional) | Hanya toko yang ditugaskan: melihat riwayat, menyetujui izin/lembur/koreksi, memverifikasi absen, dan konfirmasi hadir. |
| Karyawan | Absen diri sendiri, melihat riwayat/status pribadi, melihat jadwal dan sisa cuti, mengajukan izin/sakit/cuti/lembur/koreksi. Tidak dapat mengekspor laporan. |

Aturan akses selalu diperiksa di server. Karyawan tidak dapat melihat foto, lokasi, atau data karyawan lain. Hanya Admin yang dapat menambah Admin baru; sistem menjaga minimal dua akun Admin aktif.

## 4. User Story Utama

- Sebagai karyawan, saya ingin absen masuk/pulang dengan kamera langsung agar foto galeri tidak dapat digunakan.
- Sebagai karyawan, saya ingin absen tetap tercatat saat offline agar tidak otomatis dianggap tidak hadir.
- Sebagai karyawan, saya ingin mengirim absensi dengan status verifikasi ketika GPS tidak akurat.
- Sebagai karyawan, saya ingin mengajukan izin, sakit, cuti, lembur, atau koreksi dengan bukti.
- Sebagai supervisor, saya ingin memverifikasi absensi dan menyetujui pengajuan hanya untuk toko saya.
- Sebagai admin, saya ingin mengatur lokasi toko, radius, batas akurasi, jadwal, shift, dan toleransi.
- Sebagai admin, saya ingin melihat dashboard per toko dan daftar karyawan yang belum absen.
- Sebagai admin, saya ingin mengunci rekap setelah closing dan mengetahui seluruh perubahan melalui audit log.

## 5. Persyaratan Fungsional

### 5.1 Login dan akun

- `FR-01` Login menggunakan username/NIK dan password; password disimpan dengan bcrypt atau Argon2.
- `FR-02` Satu akun karyawan terikat maksimal satu perangkat terdaftar. Penggantian HP harus disetujui Admin.
- `FR-03` Akun terkunci 15 menit setelah lima kali salah password.
- `FR-04` Sesi berakhir otomatis setelah tidak aktif: Admin 30 menit, Karyawan 7 hari.
- `FR-05` Admin dapat reset password karyawan; login pertama mewajibkan ganti password.
- `FR-06` Login pertama meminta consent mengenai data selfie, lokasi, waktu, tujuan, dan masa simpan.

### 5.2 Absensi selfie dan anti-curang

- `FR-07` Tombol Absen Masuk dan Absen Pulang membuka kamera depan langsung melalui `getUserMedia`.
- `FR-08` Tidak tersedia tombol upload; foto galeri tidak dapat digunakan sebagai sumber selfie.
- `FR-09` Foto berasal dari stream video langsung dan diberi watermark nama, waktu server, serta koordinat.
- `FR-10` Liveness dasar meminta instruksi acak, misalnya berkedip atau menoleh; wajah wajib terdeteksi di frame.
- `FR-11` Foto dikompres maksimal sekitar 200 KB sebelum dikirim.
- `FR-12` Absen pulang hanya dapat dilakukan setelah absen masuk pada hari/shift yang sama. Jika lupa masuk, arahkan ke koreksi.

### 5.3 GPS, geofence, dan validasi alternatif

- `FR-13` Lokasi diambil satu kali saat tombol absen ditekan dengan mode akurasi tinggi; tidak ada tracking terus-menerus.
- `FR-14` Admin dapat membuat banyak lokasi toko. Setiap toko memiliki koordinat, radius, batas akurasi, dan IP Wi-Fi opsional.
- `FR-15` Default radius adalah 10 meter dan default batas akurasi 30 meter; keduanya dapat diubah Admin.
- `FR-16` Status GPS valid jika jarak ke toko <= radius dan akurasi GPS <= batas akurasi.
- `FR-17` Sistem menolak atau menandai mock location, perpindahan tidak wajar, dan koordinat identik yang berulang.
- `FR-18` Karyawan dapat ditugaskan ke satu atau beberapa toko; absensi valid hanya pada toko yang ditugaskan.
- `FR-19` Jika GPS gagal, sistem memberi panduan, menampilkan jarak/akurasi, dan mencoba ulang otomatis maksimal 60 detik.
- `FR-20` Admin dapat mengaktifkan satu atau beberapa validasi alternatif: QR dinamis toko 30-60 detik, IP Wi-Fi publik toko, atau konfirmasi supervisor di tempat.
- `FR-21` Jika seluruh validasi gagal, selfie dan lokasi terbaik tetap disimpan sebagai `Perlu verifikasi` memakai waktu absen asli.

### 5.4 Data absensi dan status validasi

- `FR-22` Setiap absensi menyimpan karyawan, jenis, waktu server, waktu perangkat, foto, koordinat, akurasi, jarak, toko, metode, device ID, IP, status jaringan, dan status validasi.
- `FR-23` Status validasi: `Valid`, `Perlu verifikasi`, `Disetujui admin`, atau `Ditolak`.
- `FR-24` Perubahan status menyimpan approver, waktu, alasan, dan audit log. Waktu server WIB dipakai untuk perhitungan; waktu perangkat hanya pembanding.

### 5.5 Jadwal, izin, lembur, dan koreksi

- `FR-25` Admin membuat shift dengan jam masuk, jam pulang, istirahat, hari kerja, dan penugasan per karyawan/kelompok; jadwal dapat berbeda per hari.
- `FR-26` Toleransi telat dapat diatur per shift dan per karyawan. Sistem menghitung menit keterlambatan.
- `FR-27` Admin mengatur hari libur nasional dan libur toko.
- `FR-28` Karyawan mengajukan izin, sakit dengan foto surat dokter, cuti, dan lembur. Admin/supervisor menyetujui atau menolak dengan catatan.
- `FR-29` Karyawan mengajukan koreksi dengan alasan dan bukti; Admin juga dapat mengoreksi langsung. Koreksi selalu dicatat sebagai record baru yang merujuk data asli.
- `FR-30` Lembur hanya dihitung jika sudah disetujui Admin; pulang melewati jadwal tanpa persetujuan tidak otomatis menjadi lembur.

### 5.6 Dashboard dan notifikasi

- `FR-31` Dashboard Admin per hari dan toko menampilkan hadir, terlambat, belum absen, izin/sakit/cuti, dan `Perlu verifikasi`.
- `FR-32` Daftar belum absen diperbarui otomatis dan dapat difilter berdasarkan toko serta shift.
- `FR-33` Tersedia grafik tren kehadiran/keterlambatan 30 hari dan peringkat keterlambatan terbanyak.
- `FR-34` Admin mendapat notifikasi pengajuan izin, koreksi, lembur, dan verifikasi baru.
- `FR-35` Karyawan melihat status hari ini, riwayat, sisa cuti, dan status semua pengajuan pribadi.

### 5.7 Rekap, Excel, dan closing

- `FR-36` Rekap bulanan per karyawan memuat `workDays` (jumlah tanggal kalender unik per karyawan yang jadwal shiftnya telah tiba/berjalan, tidak termasuk hari libur; beberapa shift pada tanggal yang sama dihitung sebagai satu hari), hadir, jumlah/total menit telat, tidak hadir, izin, sakit, cuti, total jam kerja, dan lembur disetujui.
- `FR-37` Rekap detail harian memuat masuk, pulang, durasi, dan status.
- `FR-38` Ekspor `.xlsx` menerima filter periode, toko, dan karyawan; hasil memiliki sheet ringkasan dan detail.
- `FR-39` Rekap yang sudah closing dikunci. Perubahan setelah closing hanya oleh Admin dengan alasan dan audit log.

## 6. Alur Penanganan Kondisi Khusus

### GPS tidak akurat atau di luar radius

1. Tampilkan jarak, akurasi, dan panduan perbaikan GPS.
2. Coba ulang otomatis maksimal 60 detik.
3. Coba validasi alternatif yang diaktifkan Admin: QR, Wi-Fi, atau supervisor.
4. Jika tetap gagal, simpan sebagai `Perlu verifikasi`, bukan `Tidak hadir`.
5. Admin/supervisor melihat foto, peta, akurasi, riwayat, lalu menyetujui atau menolak dengan alasan. Batas usulan: 1 x 24 jam.

### Internet terputus

PWA yang sudah tersimpan tetap dapat dibuka. Selfie, GPS, dan waktu perangkat disimpan terenkripsi di HP sebagai `Absen tertunda`, dengan kode bukti. Background sync mengirim data saat online. Waktu receipt dari server tetap dicatat sebagai waktu server resmi; `clientRecordedAt` hanya evidence perangkat dan tidak membuktikan sendiri kapan capture terjadi. Jika capture pada tanggal D baru tersinkron pada D+1, tanggal capture hanya menjadi kandidat tanggal kerja (`candidateWorkDate`) dan wajib ditinjau reviewer sebelum atribusi tanggal/shift difinalkan. Kandidat tidak otomatis menjadi `workDate` final dan tidak boleh membuat absensi berstatus `Valid`. Selisih waktu > 5 menit, perubahan jam manual, atau sinkronisasi > 24 jam juga mengharuskan verifikasi; selama bukti liveness belum diverifikasi server, semua absensi offline tetap `Perlu verifikasi`. Karyawan tidak dapat mengedit/menghapus antrean tertunda. Penanganan kandidat yang tidak masuk akal atau tidak memiliki shift cocok masih memerlukan keputusan produk sebelum implementasi.

### Perangkat rusak atau kamera error

Karyawan boleh absen dibantu melalui HP toko/supervisor dengan akun sendiri + selfie; record ditandai `Absen dibantu` dan otomatis `Perlu verifikasi`. Jika tidak ada perangkat, karyawan melapor saat itu dan mengajukan koreksi maksimal H+3 hari kerja.

### Gangguan sistem

Admin dapat menandai rentang waktu dan toko sebagai `Gangguan sistem`. Karyawan terdampak tidak dihitung terlambat/tidak hadir dan Admin dapat melakukan koreksi massal untuk periode tersebut.

### Penentuan tidak hadir

Status `Tidak hadir` hanya dibuat pada akhir hari (jam pulang + 2 jam) jika tidak ada absen masuk, tertunda, atau `Perlu verifikasi`; tidak ada izin/sakit/cuti disetujui atau menunggu; tidak ada koreksi berjalan; dan tidak sedang dalam gangguan sistem. Status dapat diubah lewat koreksi sampai closing bulanan.

## 7. Status Kehadiran Harian

| Status | Kondisi |
|---|---|
| Hadir tepat waktu | Masuk valid/disetujui <= jam masuk + toleransi |
| Terlambat | Masuk valid/disetujui > jam masuk + toleransi |
| Pulang cepat | Pulang sebelum jam pulang tanpa izin |
| Tidak absen pulang | Ada masuk tanpa pulang |
| Menunggu verifikasi | Ada record `Perlu verifikasi` atau `Absen tertunda` |
| Izin/Sakit/Cuti | Pengajuan disetujui |
| Libur | Hari libur atau bukan hari kerja |
| Tidak hadir | Memenuhi seluruh aturan penentuan tidak hadir |

Jam kerja = jam pulang - jam masuk - istirahat. Lembur hanya durasi yang disetujui Admin.

## 8. Keamanan, Privasi, Backup, dan Audit

- Seluruh akses HTTPS/TLS; kamera dan GPS browser hanya bekerja melalui HTTPS.
- Password hash, token HttpOnly/Secure, validasi input, proteksi SQL injection, XSS, CSRF, rate limit login dan pengiriman absensi.
- Foto berada di private object storage dengan signed URL sementara yang kedaluwarsa beberapa menit.
- Admin dapat memakai 2FA OTP email/WhatsApp atau authenticator.
- Lokasi hanya diambil ketika tombol absen ditekan; tidak ada izin lokasi selalu aktif atau tracking latar belakang.
- Consent dikumpulkan saat login pertama.
- Foto selfie disimpan 12 bulan secara default dan dihapus otomatis setelahnya; data angka absensi tetap disimpan.
- Backup database harian minimal 30 hari dan backup mingguan 3 bulan, terenkripsi di lokasi terpisah.
- Uji restore minimal setiap 3 bulan; target RPO maksimal 24 jam dan RTO maksimal 4 jam.
- Audit log immutable mencatat login/gagal login, perubahan karyawan, toko/radius, jadwal, persetujuan/penolakan, koreksi, closing, ekspor, dan hak akses.
- Audit log berisi pelaku, waktu, IP/perangkat, aksi, data sebelum/sesudah, dan alasan; tidak dapat diubah/dihapus termasuk oleh Admin.

## 9. Persyaratan Non-Fungsional

| Kode | Kebutuhan |
|---|---|
| NFR-01 | PWA pada Chrome Android dan Safari iOS, dapat ditambahkan ke layar utama. |
| NFR-02 | Android 9+ dan iOS 15+; admin nyaman di laptop. |
| NFR-03 | Proses absen <= 10 detik pada 4G normal; halaman utama <= 3 detik. |
| NFR-04 | Satu absen <= 300 KB termasuk foto terkompresi dan data. |
| NFR-05 | Ketersediaan server >= 99% per bulan; offline menutup gangguan sementara. |
| NFR-06 | Bahasa Indonesia, tombol besar, maksimal tiga ketukan dari layar utama. |
| NFR-07 | Semua perhitungan menggunakan Asia/Jakarta (WIB). |
| NFR-08 | Minimal 200 karyawan dan 20 lokasi tanpa perubahan arsitektur. |

Arsitektur acuan: frontend PWA + Service Worker + IndexedDB; backend REST API; PostgreSQL/MySQL; private S3-compatible object storage; ekspor server-side dengan PhpSpreadsheet/ExcelJS; hosting berdomain sendiri dan SSL.

## 10. Entitas Data Utama

`karyawan`, `pengguna`, `device_binding`, `lokasi_toko`, `shift_jadwal`, `penugasan_shift`, `absensi`, `bukti_foto`, `bukti_lokasi`, `pengajuan`, `hari_libur`, `gangguan_sistem`, `rekap_bulanan`, `notifikasi`, dan `audit_log`.

## 11. Batas Waktu Operasional

| Kejadian | Batas waktu |
|---|---|
| Verifikasi `Perlu verifikasi` | 1 x 24 jam oleh Admin/Supervisor |
| Sinkronisasi offline | Maksimal 24 jam; setelah itu `Perlu verifikasi` |
| Pengajuan koreksi karyawan | Maksimal H+3 hari kerja |
| Keputusan koreksi | Maksimal 2 hari kerja oleh Admin |
| Closing rekap bulanan | Tanggal 3 bulan berikutnya |

Angka ini dapat diubah Admin pada menu pengaturan.

## 12. Kriteria Penerimaan

- Halaman absensi tidak memiliki input upload galeri.
- Absen 50 m dari toko dengan radius 10 m tidak menjadi `Valid`, tetapi tersimpan `Perlu verifikasi`.
- Perubahan radius memengaruhi absensi berikutnya dan tercatat di audit log.
- Absen dalam mode pesawat tersimpan, terkirim otomatis saat online, dan mempertahankan waktu saat absen.
- Absen `Perlu verifikasi` tidak ditampilkan sebagai `Tidak hadir`.
- Angka ekspor Excel sama dengan rekap di layar.
- Karyawan A tidak dapat membuka data Karyawan B dengan mengubah URL.
- Tidak ada permintaan lokasi saat aplikasi tidak sedang dipakai untuk absen.

## 13. Tahapan Pengembangan

1. **Tahap 1 - inti:** login/hak akses, selfie + GPS, toko/radius, jadwal/toleransi, `Perlu verifikasi`, dashboard dasar.
2. **Tahap 2 - operasional:** offline, izin/cuti/lembur, koreksi, rekap bulanan, Excel, audit log lengkap.
3. **Tahap 3 - penguatan:** QR dinamis, Wi-Fi toko, liveness check, notifikasi, backup teruji, dashboard lanjutan.
