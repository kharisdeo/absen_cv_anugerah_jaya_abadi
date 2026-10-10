# PRD Ringkas Website Absensi CV Anugerah Jaya Abadi

## Ringkasan

Aplikasi web untuk mencatat check-in/check-out karyawan, mengelola izin dan koreksi, serta menyediakan rekap bagi HR dan pimpinan.

Dokumen ini merupakan draft berbasis asumsi karena folder proyek belum berisi requirement tertulis. Asumsi utama: terdapat role Karyawan, HR/Admin, dan Pimpinan; timestamp memakai waktu server Asia/Jakarta; lokasi dapat dicatat bila diizinkan.

## Tujuan

- Mengurangi pencatatan absensi manual.
- Menyediakan data kehadiran yang konsisten dan mudah ditelusuri.
- Mempercepat rekap untuk HR dan pimpinan.

## Role dan Fitur MVP

| Role | Fitur |
|---|---|
| Karyawan | Login, check-in, check-out, riwayat, izin, koreksi absensi |
| HR/Admin | Kelola karyawan, jadwal, hari libur, absensi, persetujuan, laporan, ekspor |
| Pimpinan | Dashboard ringkasan, melihat laporan, menyetujui izin/koreksi |

## Aturan Bisnis Utama

- Satu karyawan hanya memiliki satu record absensi per tanggal kerja.
- Check-out hanya tersedia setelah check-in.
- Waktu berasal dari server dengan zona waktu Asia/Jakarta.
- Status dihitung dari jadwal kerja dan toleransi keterlambatan.
- Izin dan koreksi memiliki status `pending`, `approved`, atau `rejected`.
- Data yang sudah disetujui tidak dihapus permanen; perubahan tercatat pada audit log.

## Kebutuhan Non-Fungsional

Keamanan berbasis role, password ter-hash, validasi server, responsif di desktop/mobile, audit log, dan target respons dashboard maksimal 3 detik pada beban normal.

## Kriteria Penerimaan

1. Pengguna dapat login dan melihat dashboard sesuai role.
2. Karyawan dapat check-in dan check-out tanpa duplikasi.
3. Sistem menghitung status hadir/terlambat berdasarkan jadwal.
4. HR dapat memfilter dan mengekspor rekap.
5. Pengajuan izin/koreksi dapat disetujui atau ditolak dengan histori.
6. Pengguna tidak dapat mengakses data di luar haknya.

Lihat [PRD lengkap](./PRD-dan-diagram-absensi.md) untuk user story, data utama, indikator keberhasilan, dan pertanyaan yang perlu divalidasi.
