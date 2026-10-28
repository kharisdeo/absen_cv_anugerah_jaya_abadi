# AUD-09 — Verifikasi watermark gambar

## Perubahan lokal

- `sharp` merender JPEG turunan privat; overlay berisi nama karyawan dari DB, receipt server
  terformat `Asia/Jakarta` dengan label WIB, serta koordinat yang tersimpan atau
  `Lokasi tidak tersedia`.
- Original accepted immutable. Key turunan dicadangkan secara atomik pada intent; object ditulis
  privat memakai mekanisme conditional seal yang sama. Flag `watermarkApplied` baru berubah
  sesudah object ada dan transaksi database menyimpan status/ukuran. Batas turunan 200 KiB
  ditegakkan oleh renderer dan constraint database.
- Signed reads Admin maupun Supervisor scoped tetap memakai pemeriksaan repository yang ada,
  tetapi hanya mengembalikan key turunan yang berstatus applied. Untuk data lama, scope diperiksa
  sebelum render on-demand; job retention tetap menguras backfill secara batch. Render/write/commit
  gagal tertutup; retry attempt idempoten mencoba ulang watermark tanpa membuat attendance valid.
- Retention menghapus original dan turunan sebelum metadata object dibersihkan; flag intent aktif
  kembali false setelah key/ukuran keduanya dibersihkan, sementara flag riwayat `SelfieCapture`
  dipertahankan. Worker retention
  juga menguras antrean watermark legacy, termasuk attempt no-fix yang memiliki metadata lokasi
  unavailable; kegagalan membuat job exit non-zero.

## Verifikasi

- API: `vitest run --config vitest.config.ts` — 60 file, 536 tes lulus.
- `prisma validate --schema apps/api/prisma/schema.prisma` — lulus.
- Tes pixel memeriksa JPEG valid, ukuran, perubahan bytes, dan strip watermark yang tampak pada
  hasil decode; tes service memeriksa signed URL derivative dan failure tidak menerbitkan URL.
- PostgreSQL migration/race belum diuji. Docker image PostgreSQL belum selesai dipersiapkan;
  tidak ada DB project atau bucket/provider nyata yang disentuh. `tsc` keseluruhan masih memiliki
  error baseline di modul/dependency lain; tidak ada error baru yang terfilter pada file AUD-09.

## Batas

Ini bukti implementasi lokal, bukan persetujuan kebijakan biometric/liveness, verifikasi sumber
kamera secara kriptografis, verifikasi provider, atau production readiness. Container hosting
belum dikonfigurasi untuk menjalankan scheduler retention/backfill.
