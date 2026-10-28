# AUD-09 — Watermark gambar privat: readiness

**Status: PARTIAL — implementasi ditahan karena renderer raster tidak tersedia pada runtime aplikasi.** Tidak ada source, schema, migration, dependency, atau konfigurasi produksi yang diubah.

## Temuan

- API hanya memiliki `image-size`, yang membaca tipe/dimensi; `sharp`, `canvas`, dan renderer Node lain tidak tersedia di dependency aplikasi. Pillow yang mungkin ada pada workstation bukan dependency/runtime API dan tidak dipakai.
- Upload saat ini memvalidasi bytes, tipe, ukuran maksimum 200 KiB, lalu menyegel satu object privat dengan `If-None-Match: *`. Metadata nama employee dari DB, `receivedAt` server, serta koordinat atau alasan lokasi gagal tersimpan sebagai JSON; ini bukan watermark visual. `SelfieCapture.watermarkApplied` default `false`.
- URL baca dibuat setelah pemeriksaan role/scope dan masa retensi; retention worker menghapus object dan baru mengosongkan pointer DB setelah delete berhasil. Provider storage belum diverifikasi.

## Desain implementasi saat renderer tersedia

1. Pertahankan original immutable di object key privat yang ada; jangan pernah memberikannya sebagai URL baca biasa. Render bytes di server ke object derivative terpisah. Sumber watermark hanya data DB: nama employee, waktu receipt (`receivedAt`/`serverTime`) diformat eksplisit `Asia/Jakarta`/WIB, serta koordinat yang tersimpan atau label aman seperti `Lokasi tidak tersedia`. Jangan mengambil teks atau flag otoritatif dari client.
2. Simpan pointer original dan derivative secara terpisah pada record capture. `watermarkApplied` tetap `false` sampai render menghasilkan gambar yang valid, derivative tersimpan privat, dan pointer derivative berhasil dipersistenkan. Kegagalan render/storage/DB tidak boleh mengubahnya menjadi `true`; attendance tetap pada status verifikasi yang berlaku.
3. Gunakan key derivative stabil per capture dan conditional create. Pada retry, verifikasi object yang sudah ada sebelum reuse; jangan overwrite original atau menerima derivative yang tidak cocok. Jika DB gagal setelah upload, retry harus dapat mengadopsi object yang cocok atau retention membersihkan orphan.
4. Signed read untuk reviewer harus tetap melalui otorisasi Admin/Supervisor dan scope repository yang ada, TTL singkat dibatasi sisa retensi, dan hanya menunjuk derivative yang sukses. Jangan membuat URL publik atau membuka fallback original tanpa keputusan akses eksplisit.
5. Retention harus menghapus original dan derivative secara idempotent. Pertahankan kedua key sampai semua delete berhasil; baru kosongkan kedua pointer dan tandai penghapusan dalam transaksi DB. Kegagalan parsial harus dapat dicoba ulang tanpa kehilangan pointer ke object yang belum terhapus. Pertahankan attendance/audit sesuai kebijakan BE-015.
6. Tetapkan batas ukuran derivative (maksimum 200 KiB sebagai target awal): encoder boleh menyesuaikan kualitas/resolusi tanpa menghilangkan watermark; bila batas tidak tercapai, gagalkan derivasi dan biarkan `watermarkApplied=false`.

## Tes dan bukti yang diperlukan

- Unit renderer memakai fixture gambar sintetis kecil untuk memastikan teks benar-benar mengubah pixel dan memuat nama DB, timestamp WIB, serta koordinat/label unavailable; periksa signature, MIME, dimensi, dan batas ukuran output.
- Uji render error, input rusak/oversize, write derivative gagal, dan persistensi pointer gagal: `watermarkApplied` harus tetap `false`; retry harus idempotent dan object orphan dapat dibersihkan.
- Uji API bahwa hanya role/scope yang berhak memperoleh signed URL pendek ke derivative; expired/deleted/no-derivative tidak menandatangani URL; tidak ada public URL.
- Uji retention dengan storage fake: kedua object dihapus, kegagalan delete salah satunya mempertahankan pointer untuk retry, dan rerun aman. Tambahkan regression PostgreSQL terisolasi untuk transaksi flag/pointer dan migration sebelum klaim DB acceptance.
- Setelah renderer/runtime dependency disetujui dan tersedia, jalankan tes terfokus selfie/storage/attempt, validasi Prisma + migration pada DB disposable saja, Prettier, lint/typecheck terkait. Jangan membaca `.env`, memakai DB pengguna, atau mengklaim provider/browser/device sudah diuji.

## Blocker dan langkah berikutnya

Network dibatasi dan instruksi AUD-09 melarang memasang atau mengambil dependency/layanan gambar baru. Karena itu tidak ada implementasi pixel yang aman dan portabel pada runtime API saat ini; JSON, SVG wrapper, atau render frontend bukan pengganti. Langkah berikutnya: sediakan/otorisasi renderer yang benar-benar tersedia di runtime API, lalu implementasikan desain di atas dalam task AUD-09. Sampai saat itu acceptance pixel artifact, ukuran derivative, dan lifecycle dua object **belum terpenuhi**.
