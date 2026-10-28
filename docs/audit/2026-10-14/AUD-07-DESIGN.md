# AUD-07 — Desain liveness evidence yang dapat diverifikasi

Tanggal: 2026-10-15  
Status: desain lokal untuk review; bukan implementasi atau persetujuan provider/model.  
Ruang lingkup: kontrak liveness untuk AUD-08 tanpa membuka status `VALID`, mengubah consent legal, menyimpan video mentah, atau mengklaim ketahanan terhadap spoofing browser.

## Ringkasan

Implementasi saat ini memiliki state machine liveness di browser dan interface detector yang dapat diinjeksi untuk tes, tetapi tidak memiliki detector produksi. Browser dapat menyampaikan `faceDetected`/`passed`; backend dengan sengaja menganggap klaim tersebut tidak tepercaya (`hasTrustedLivenessEvidence = false`) dan menyimpan `SelfieCapture.faceDetected=false` serta `livenessPassed=false`. Seluruh alur offline tetap `PENDING_VERIFICATION`.

Rekomendasi AUD-08 adalah memisahkan tiga hal: (1) instruksi/capture UX di browser, (2) evidence singkat yang diproses verifier server-side, dan (3) keputusan kehadiran yang tetap memakai seluruh gate bisnis. Hanya hasil verifier server yang terikat pada challenge, employee, device, jenis absensi, dan satu attempt idempotent boleh memenuhi gate liveness. Hasil itu sendiri tidak cukup untuk membuat attendance `VALID`.

Jika server verifier, consent yang sesuai, konfigurasi model, atau pemeriksaan bukti tidak tersedia, attendance harus tetap `PENDING_VERIFICATION` (atau tidak dikirim jika evidence request secara struktural tidak valid); UI harus menyatakan review diperlukan. Jangan menyimpan raw video, face embedding, atau frame diagnostik. Jangan mengirim evidence ke vendor/layanan pihak ketiga sebelum pemrosesan, consent, residency, kontrak, biaya, dan retensinya diputuskan serta diuji.

## 1. Fakta source saat ini

| Area          | Fakta saat ini                                                                                                                                                                                                                                      | Dampak desain                                                                                                                                 |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Detector      | `apps/web/src/components/attendance/liveness.ts` menerima optional `LivenessDetector`; tidak ada detector default. Interface mengembalikan boolean deteksi wajah dan status instruksi. `FaceDetector` browser tidak dipakai sebagai bukti liveness. | Adapter yang memenuhi interface tetap hanya client signal. Keberhasilan interface tidak boleh dianggap server-trusted.                        |
| Challenge     | Pilihan `blink`/`turn-left`/`turn-right` dibuat lokal memakai `Math.random`; controller membatasi attempt hingga 15 detik dan meng-abort detector saat selesai/timeout/unmount.                                                                     | Pilihan acak lokal adalah UX, bukan nonce atau challenge anti-replay yang dikeluarkan server.                                                 |
| Capture       | Kamera memakai `getUserMedia` tanpa audio; foto statis diambil dari frame langsung, dikompres maksimal 200 KiB, dan stream dihentikan. Tidak ada video/frame sequence yang dikirim sebagai liveness evidence saat ini.                              | Foto statis tidak dapat membuktikan blink/turn. Bukti sequence memerlukan kontrak baru dan penilaian privasi/performa.                        |
| API           | Body attempt berisi claim liveness client. Client dapat mengubah nilai tersebut; request fingerprint/idempotency mencegah replay payload berbeda dengan key yang sama, bukan pemalsuan claim.                                                       | Backend harus mengabaikan claim untuk gate terpercaya dan memakai hasil verifier internal.                                                    |
| Server        | `prisma-repository.ts` menetapkan `hasTrustedLivenessEvidence=false`; selfie `faceDetected` dan `livenessPassed` disimpan false. Attendance dimulai pending; gate tersebut fail-closed.                                                             | Pertahankan perilaku ini sampai verifier dan seluruh acceptance AUD-08 terbukti.                                                              |
| Private image | Selfie merupakan satu gambar privat melalui upload intent, pemeriksaan MIME/signature/ukuran, salinan sealed, dan retention terpisah. Upload URL berumur 30–300 detik (default 120); retention selfie default 12 bulan.                             | TTL upload bukan otomatis TTL liveness challenge. Jangan menyimpan video/sequence di bucket selfie atau memperpanjang retention tanpa policy. |
| Consent       | Purposes yang tersedia meliputi bukti selfie absensi, lokasi saat tombol absensi, pencatatan waktu, rekap, dan retention selfie. Belum ada purpose eksplisit untuk pemrosesan sequence frame/video liveness di server.                              | Legal/owner harus menyetujui wording/version dan tujuan pemrosesan tambahan sebelum verifier sequence diaktifkan.                             |
| Batas bukti   | Tes browser memakai detector fake, fake clock, dan DOM test. Tidak ada device/browser matrix, model produksi, benchmark, atau server verifier yang sudah terbukti.                                                                                  | Semua hasil AUD-07 adalah rancangan; tidak dapat menjadi bukti liveness produksi atau sign-off keamanan.                                      |

Sumber utama: `apps/web/src/components/attendance/liveness.ts`, `camera-capture.ts`, `CameraCaptureDialog.tsx`, `apps/api/src/modules/attendance/prisma-repository.ts`, `apps/api/src/modules/attendance/index.ts`, Prisma `AttendanceAttempt`/`SelfieUploadIntent`/`SelfieCapture`, `apps/api/src/modules/consent/index.ts`, `docs/PRD.md`, dan keputusan BE-015/BE-018 di `docs/DECISIONS.md`.

## 2. Threat model dan invariant

Ancaman yang harus diuji: client mengirim `passed=true` tanpa detector; video/foto layar yang diputar ulang; challenge milik employee/device lain; challenge kedaluwarsa/dipakai ulang; instruksi tidak sesuai; hasil model tidak tersedia/timeout; race dua submit; serta observability/logging yang tanpa sengaja menangkap frame, signed URL, token, atau identitas.

Invariant yang tidak boleh dilanggar:

1. `client.liveness.passed`, `faceDetected`, jam browser, dan status UI tidak pernah menjadi bukti server.
2. Hanya hasil verifier internal yang lolos challenge dan binding server dapat bernilai `VERIFIED`; liveness `VERIFIED` hanyalah satu gate, bukan keputusan final.
3. Semua gate attendance yang sudah berlaku—actor/session/device, shift, geofence, lokasi, duplicate/replay, consent, status offline, dan kebijakan review—tetap wajib lolos sebelum server boleh mempertimbangkan `VALID`.
4. `receivedAt` server tidak diganti oleh waktu perangkat. Offline tanpa bukti server-verifiable yang disepakati selalu pending; claim atau timestamp client tidak membuka `VALID`.
5. Raw video/frame sequence dan face embedding tidak ditulis ke database, object storage, cache persisten, log, trace, analytics, crash report, atau fixture repo. Evidence request hanya diproses singkat di memory/TLS dan dihapus setelah keputusan.
6. Gagal, timeout, unsupported, hasil tidak pasti, versi model tak diizinkan, atau server verifier unavailable tidak pernah dianggap lulus.
7. Salinan selfie tetap melalui private upload/seal/retention yang ada. Liveness pipeline tidak membuka object key atau URL privat kepada client.

Browser biasa tidak menyediakan bukti kriptografis universal bahwa frame datang dari sensor kamera fisik: `getUserMedia` dan challenge UI dapat dipalsukan oleh client yang dikendalikan penyerang. Nonce mengikat request dan mempersulit replay sederhana, tetapi tidak membuktikan keaslian hardware atau mengalahkan deepfake/tampilan ulang yang mampu bereaksi terhadap challenge. Keterbatasan ini harus ditampilkan pada threat review; jangan menyebut fitur sebagai jaminan anti-fraud.

## 3. Kontrak usulan AUD-08

### 3.1 Challenge dan binding server

- Server membuat `challengeId` opak dan nonce kriptografis minimal 128 bit dari CSPRNG. Instruksi dipilih server dari allowlist (misalnya blink atau arah menoleh); jangan mempercayai instruksi yang dipilih client.
- Simpan hanya hash nonce/token di server. Challenge terikat pada authenticated employee, approved device binding, session, tipe `CHECK_IN`/`CHECK_OUT`, versi challenge/verifier yang didukung, `issuedAt`, `expiresAt`, dan status one-use. Store/shift bisa ditambahkan hanya bila kontrak attendance memang sudah mengetahuinya.
- Rekomendasi TTL awal challenge: 120 detik dari waktu server, terpisah dari TTL signed-upload. Nilai ini harus divalidasi pada device matrix; konfigurasi di luar bounds harus gagal saat startup. Jangan memakai waktu browser untuk expiry.
- Challenge dibuat dekat dengan capture dan dikonsumsi atomik bersama attempt/idempotency. Unique constraint/conditional transition harus memastikan satu challenge tidak memberi liveness `VERIFIED` untuk dua attempt. Retry exact request dengan idempotency key dan fingerprint yang sama mengembalikan receipt/verdict tersimpan tanpa menjalankan verifier lagi; key sama dengan payload berbeda tetap konflik.
- Actor, device, type, challenge, atau binding mismatch tidak boleh lulus. Simpan audit/security event minimal tanpa nonce mentah, token, frame, foto, atau URL signed. Detil HTTP denial mengikuti route auth dan tidak membocorkan apakah challenge milik user lain.

### 3.2 Evidence capture dan server verifier

1. Setelah sesi/device dan consent policy yang relevan lolos, browser meminta challenge. UI menunjukkan instruksi server dan timer; camera capture tetap tanpa audio dan tanpa gallery.
2. Browser mengirim sequence singkat beresolusi/ukuran terbatas melalui TLS ke endpoint attendance evidence. Sequence hanya transient payload untuk verifier; bukan upload intent selfie dan bukan object storage. Client metadata tidak mengesahkan waktu capture.
3. Verifier server-side memeriksa challenge nonce/status/expiry/binding, urutan serta batas jumlah/ukuran frame, wajah terlihat cukup pada frame yang dibutuhkan, respons sesuai instruksi, anti-spoof result sesuai threshold versi yang diaktifkan, dan deadline. Model/version/threshold harus immutable dan allowlisted pada deployment.
4. Verifier mengembalikan enum internal `VERIFIED`, `FAILED`, atau `UNAVAILABLE` ditambah reason code aman dan `verifierVersion`. Jangan persist score biometrik mentah atau embedding. Jika diperlukan untuk audit, simpan hasil kategoris, challenge/attempt reference, waktu verifikasi server, dan versi verifier saja dengan retention yang disetujui.
5. Server menghapus buffer frame segera sesudah selesai/timeout/cancel, termasuk error path. Seluruh middleware, APM, reverse proxy, request logger, body capture, dan crash diagnostics wajib mengecualikan body endpoint ini.
6. Selfie final tetap gambar statis sealed yang sekarang. Liveness sequence tidak menjadi lampiran yang dapat diunduh reviewer. Reviewer melihat foto dan metadata attendance yang sudah diizinkan, bukan video mentah.

Pilihan implementasi model/runtime, hosting GPU/CPU, open-source/commercial SDK, dan cost belum dipilih. POC AUD-08 harus mengukur keakuratan/false acceptance dan false rejection pada kondisi perangkat, cahaya, variasi pengguna, serta spoof threat yang disepakati; bila angka tidak memenuhi threshold yang ditetapkan owner/security, matikan verifier dan gunakan pending fallback.

### 3.3 Hasil dan fallback

| Hasil                                                                                                                                              | Dampak attendance                                                                                                                                                                                                                              | UI/operasi                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Server verifier `VERIFIED`, challenge valid, semua gate lain lolos dan jalurnya memang boleh auto-validate                                         | Hanya memenuhi gate liveness; server menghitung keseluruhan status. Offline atau cross-date review yang wajib tetap pending.                                                                                                                   | Tampilkan receipt yang dikeluarkan server; jangan menampilkan hasil lokal sebagai keputusan final.                                              |
| Instruksi gagal, wajah hilang, quality rendah, spoof suspicion, challenge expired/replayed, atau binding mismatch                                  | Tidak membuat `VALID`. Untuk attempt yang secara aturan dapat diterima, simpan hasil pending/review dengan reason code; mismatch/security anomaly boleh ditolak dengan kode stabil sesuai kontrak server. Jangan mengubah raw attendance lama. | Pesan aman untuk coba ulang atau menunggu reviewer; jangan tampilkan skor/threshold internal.                                                   |
| Detector/verifier/browser/model unsupported, permission ditolak, timeout, tab ditutup, jaringan putus, server 5xx, atau versi model tidak tersedia | Tidak pernah dianggap `VERIFIED`. Jika selfie/attempt sudah berhasil diterima menurut aturan attendance, status `PENDING_VERIFICATION`; jika prasyarat capture/request gagal sebelum attempt diterima, jangan memberi receipt keberhasilan.    | Terangkan batas dukungan dan fallback; kamera denied tidak boleh dipalsukan sebagai selfie valid. Assisted flow mengikuti AUD-18, bukan bypass. |
| Exact retry setelah response hilang                                                                                                                | Replay fingerprint yang sama memberikan receipt dan status sebelumnya; satu challenge hanya punya satu hasil.                                                                                                                                  | UI merekonsiliasi attempt dengan key yang sama; tidak meminta challenge baru untuk payload lama.                                                |

Rekomendasi kontrak yang dapat diuji untuk AUD-08: challenge kedaluwarsa pada actor/device yang benar membuat attempt yang bukti dasarnya valid berstatus pending dengan reason `LIVENESS_CHALLENGE_EXPIRED`; challenge yang sudah dipakai untuk idempotency key berbeda ditolak sebagai `409 LIVENESS_CHALLENGE_REPLAYED`; binding actor/device/type yang salah ditolak sebelum evidence diproses, tanpa membocorkan pemilik challenge. Exact replay request dengan fingerprint dan key yang sama mengembalikan receipt awal. Owner/security tetap harus menyetujui reason codes dan UX retry sebelum rute final.

### 3.4 Bentuk kontrak API konseptual (belum API final)

```text
POST /api/v1/attendance/liveness-challenges
Request:  { type: CHECK_IN | CHECK_OUT }
Response: { challengeId, instruction, expiresAt, verifierPolicyVersion }

POST /api/v1/attendance/attempts
Request:  existing attempt + challengeId + transient challenge evidence
Response: existing receipt + server-derived validationStatus
```

Keduanya wajib authenticated Employee, approved device/session dan consent yang sesuai. Rute/DTO final harus menghindari pemaparan nonce mentah, storage keys, scores, model internals, signed URLs, atau bytes evidence dalam response/error. Challenge dapat dipisah endpoint atau digabung dalam flow upload intent hanya setelah threat model dan API review menentukan replay/binding paling aman; snippet di atas ilustratif, bukan perubahan OpenAPI.

Data model konseptual: `LivenessChallenge` menyimpan opaque ID, hash nonce, actor/device/type binding, verifier version, `issuedAt`/`expiresAt`, consumed state dan idempotency relation; record hasil menyimpan enum/reason code dan `verifiedAt` server serta referensi attempt. Jangan menyimpan raw sequence/embedding. Unique constraints harus mencegah satu challenge/hasil memenuhi dua attempt. Schema, cascade/retention, dan audit event harus ditinjau sebelum migration AUD-08.

## 4. Consent, privacy, retensi, dan operational controls

- Consent saat ini tidak eksplisit menyebut pemrosesan sequence frame/video. Sebelum aktivasi, perusahaan harus menyetujui policy/version/purpose yang menjelaskan data apa diproses, tujuan anti-fraud, pemrosesan sementara di server, siapa yang menerima hasil, fallback, dan masa simpan metadata. Consent tidak boleh disimpulkan dari selfie-purpose lama.
- Default design: raw frame sequence diproses memory-only, tanpa object-store key/bucket, disk spool, queue, backup, application log, APM body, vendor SDK telemetry, atau model training. Disable request-body capture/redaction regression wajib.
- Persist hanya minimum categorical verifier result untuk audit, dengan TTL/retention eksplisit dan purge job teruji. Jangan otomatis mewarisi 12 bulan retention foto; owner/privacy harus menetapkan apakah metadata liveness ikut attendance record atau memiliki masa simpan terpisah sebelum migration.
- Jika model hosted pihak ketiga dipertimbangkan, wajib ada persetujuan pemrosesan data, data residency/transfer, DPA/kontrak, retention/training guarantee, private endpoint, SLA, cost ceiling, threat review, dan test anonymous access terlebih dahulu. Tanpa keputusan itu hanya local/staging POC dengan synthetic/consented test data; tidak mengirim biometrik ke endpoint baru.
- Logging metric yang diperbolehkan: total outcome enum, verifier version, latency bucket, timeout/error class, dan aggregate false-reject review rate bila minimization memungkinkan. Hindari employee ID, IP, nonce, frame, face score, URL, serta high-cardinality identifiers. Alert untuk spike failure/unavailable tanpa membuat auto-pass.
- Feature flag default OFF; missing config/model/consent berarti fail-closed ke pending. Rollback harus dapat menonaktifkan challenge/verifier tanpa merusak capture foto/selfie maupun receipt history.

## 5. Acceptance/test matrix AUD-08

Semua otomatis harus memakai synthetic fixture dan deterministic verifier adapter. Test matrix provider/browser/device terpisah dan dilaporkan PARTIAL jika environment tidak tersedia.

| Skenario                                                                                                | Required assertion                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client kirim `passed=true` dan `faceDetected=true` tanpa hasil verifier                                 | Tidak pernah menetapkan trusted result/`VALID`; client flags tidak mengalahkan server.                                                                                                                                                                                             |
| Challenge happy path dan server verifier trusted                                                        | Hasil server tercatat satu kali dengan challenge/actor/device/type/version cocok. Attendance hanya `VALID` bila seluruh gate independen juga benar; tes liveness saja harus tidak mengklaim memenuhi semuanya.                                                                     |
| Challenge replay ke attempt/idempotency berbeda                                                         | Atomic one-use mencegah `VERIFIED` kedua; denial/pending sesuai kontrak; tidak ada attendance/evidence/audit duplikat yang tak disengaja.                                                                                                                                          |
| Exact idempotent retry dengan response sebelumnya hilang                                                | Receipt dan hasil server yang sama direplay; verifier tidak dipanggil ulang; tidak ada record kedua. Payload berbeda dengan key sama tetap conflict.                                                                                                                               |
| Challenge expired tepat di batas, expired +1 ms, nonce salah, type/device/employee mismatch             | Tepat `expiresAt` sudah expired; bound attempt pending dengan reason expired. Reuse challenge oleh key baru mendapat 409; actor/device/type mismatch ditolak sebelum frame diproses. Tidak ada `VERIFIED`/`VALID` atau kebocoran scope. Batas memakai server clock yang diinjeksi. |
| Tidak ada wajah, beberapa wajah bila model membedakan, kualitas buruk, action salah, spoof suspicion    | Tidak pass; raw sequence dihapus; UI/result pending atau safe failure sesuai keputusan.                                                                                                                                                                                            |
| Browser/model/permission unsupported; detector throw; tab hidden/unmount; client/server timeout dan 5xx | Abort/cleanup berjalan, tidak leak stream/buffer, no false pass; pending fallback hanya bila attempt telah diterima.                                                                                                                                                               |
| Consent belum ada/revoked/policy version berubah                                                        | Endpoint tidak memproses frame; tidak ada upload/log persistence; mengikuti consent gate server.                                                                                                                                                                                   |
| DB/storage/log/trace inspection                                                                         | Tidak ada sequence, frame bytes, embeddings, nonce raw, signed URL atau request body pada persistence; hanya metadata minimum allowlisted.                                                                                                                                         |
| Concurrency: dua request memakai challenge sama                                                         | Tepat satu consumer menang; transaksi/unique constraint menjaga satu keputusan; regression PostgreSQL nyata diperlukan sebelum AUD-08 COMPLETE.                                                                                                                                    |
| Offline sync dengan claim true, timestamp depan/manipulasi, challenge lama                              | Tidak auto-`VALID`; pending/review tetap berlaku. Device timestamp bukan challenge time/server proof.                                                                                                                                                                              |

## 6. Performance dan bukti yang dibutuhkan

PRD menetapkan attendance ≤10 detik pada jaringan 4G normal dan selfie ≤200 KiB. State machine client sekarang memiliki timeout 15 detik, sehingga timeout itu sendiri dapat melampaui target total. Proposal acceptance yang perlu diuji pada AUD-08/24: p95 tambahan waktu liveness ≤3 detik setelah permission/camera siap; request server verification berada dalam target end-to-end attendance ≤10 detik pada profil 4G yang ditetapkan; hard deadline 15 detik menghasilkan fallback pending, bukan hang atau pass. Bukti harus mencakup p50/p95/p99, payload total, CPU/memory, thermal behavior, timeout/error rate pada perangkat acuan; jangan klaim target sebelum benchmark nyata.

Urutan verifikasi: unit state/adapter; contract + API tests; PostgreSQL concurrency/replay/retention; server integration dengan mock verifier; POC model terisolasi dan threshold review; consent/security review; real Chrome Android/Safari iOS/browser matrix; performance/pilot. Browser automation dan fake detector hanya membuktikan kontrak UI, bukan liveness dunia nyata. Uji spoof dilakukan pada lingkungan terotorisasi dan dataset yang disepakati, bukan menyimpan wajah/video karyawan tanpa policy.

## 7. Keputusan terbuka dan exit criteria

Sebelum AUD-08 mengaktifkan verifier, owner/security/privacy perlu memutuskan: model/provider/runtime dan region; kategori spoof threat dan FAR/FRR threshold; apakah `VALID` boleh terbuka untuk jalur online setelah semua gate; consent text/version dan tujuan frame processing; raw evidence retention (rekomendasi: nol persistence); retention metadata hasil; TTL challenge (rekomendasi 120 detik); batas jumlah/dimensi/bytes frame; timeout/performance budget; unsupported/expired policy; serta kebutuhan review manusia. Pilihan vendor/biaya tidak ditetapkan oleh dokumen ini.

**AUD-07 acceptance lokal:** fakta detector/server gate/sealed selfie/consent dipetakan; kontrak verifier, nonce/binding/replay/TTL, privacy, failure fallback, offline caveat, performance, threat boundary, dan test matrix disediakan untuk review. **Belum dibuktikan:** detector produksi, server verifier, model accuracy, PostgreSQL race, consent policy yang disetujui, private-provider behavior, browser/device/performance acceptance. Tidak mengubah kode produksi dan tidak mengaktifkan `VALID`.

### Langkah berikut AUD-08

1. Review dan setujui open decisions/consent/security thresholds sebelum memilih model/provider.
2. Implementasikan verifier di belakang feature flag OFF dengan contract internal; pisahkan client claim dari trusted result di DB/API.
3. Tambahkan schema/API idempotency/nonce binding/expiry dan redaction/no-body-logging safeguards.
4. Buktikan test matrix API/PostgreSQL dengan synthetic verifier dan feature flag default OFF.
5. Lakukan model/device/privacy/performance proof pada staging yang secara eksplisit diotorisasi; jangan mengklaim production completion bila gate ini belum tersedia.
