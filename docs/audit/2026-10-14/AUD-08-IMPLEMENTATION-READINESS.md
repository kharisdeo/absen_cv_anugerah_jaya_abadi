# AUD-08 — Kesiapan implementasi liveness verifier

Tanggal: 2026-10-15  
Status implementasi: **BLOCKED / NOT STARTED** karena kontrak AUD-07 masih berupa proposal dan keputusan privasi/model belum disetujui.  
Status artefak lokal: **SELESAI**; blocker implementasi tidak menghentikan analisis dan persiapan ini.

## Ringkasan

Prompt AUD-08 mengizinkan implementasi hanya setelah kontrak AUD-07 disepakati. Dokumen [AUD-07-DESIGN.md](./AUD-07-DESIGN.md) menyediakan proposal implementable, tetapi belum ada persetujuan owner atas model/provider, threat class dan FAR/FRR thresholds, pemrosesan frame yang memerlukan consent, TTL/retention metadata, dan batas performa. Karena itu tidak ada kode production, schema, route, model dependency, atau status `VALID` yang diubah pada AUD-08.

Persiapan ini tetap menyelesaikan pekerjaan lokal yang tidak memerlukan keputusan tersebut: memetakan source saat ini, menyiapkan urutan implementasi dan acceptance matrix, serta memisahkan komponen yang dapat diuji dengan synthetic verifier dari proof yang membutuhkan keputusan/provider/device. Semua offline attempt tetap pending; klaim liveness browser tidak dianggap trusted.

## 1. Peta implementasi saat ini

| Bagian                 | Kondisi aktual                                                                                                                                                                                                             | Konsekuensi AUD-08                                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Web challenge          | `liveness.ts` memilih blink/turn lokal (`Math.random`), timeout 15 detik, detector optional; default tidak ada.                                                                                                            | Belum ada nonce atau instruksi server. Jangan menyamakan state `passed` lokal dengan verifier result.                               |
| Camera capture         | `getUserMedia` menangkap satu JPEG <=200 KiB; audio tidak diminta; stream dihentikan.                                                                                                                                      | Tidak ada evidence sequence untuk server membedakan blink/turn. Menambah sequence memerlukan kontrak privacy dan payload baru.      |
| Request                | Attendance body menerima `{ faceDetected, passed }` sebagai claim client.                                                                                                                                                  | Claim boleh dimanipulasi. Server harus mengabaikan field ini untuk keputusan trust.                                                 |
| Backend gate           | `hasTrustedLivenessEvidence=false`; selfie capture tersimpan false/false; validasi evidence saat ini memeriksa image ownership/bytes, bukan liveness.                                                                      | Semua attendance tetap pending dari gate liveness. `VALID` tidak boleh dibuka sebelum verifier + seluruh gate terbukti.             |
| Identity/authorization | Authenticated Employee, session, approved device binding, owner check dan idempotency sudah tersedia pada attendance/selfie flow.                                                                                          | Challenge/evidence harus menggunakan identitas server itu; tidak menerima employee/device owner dari body sebagai otoritas.         |
| Private image          | Upload intent menghasilkan staging/sealed object dan signed URL pendek untuk selfie statis; retention selfie default 12 bulan.                                                                                             | Jangan memakai selfie bucket/TTL untuk video atau frame sequence. Jangan mengubah retention tanpa keputusan.                        |
| Consent/logging        | Consent purposes belum menyebut transient frame sequence processing; logger punya redaction selfie/blob/URL, tetapi belum ada field frame sequence/biometric evidence.                                                     | Consent/version dan redaction middleware/proxy/APM harus diuji sebelum endpoint evidence hidup. Allowlist purpose lama tidak cukup. |
| Tests                  | Web `liveness.test.ts`, `camera-capture.test.tsx`, dan `camera-capture-dialog.dom.test.tsx`: 3 files / 23 tests lulus. Fake detector/DOM tidak membuktikan accuracy, anti-spoof, server trust, perangkat atau performance. | Gunakan sebagai regression UI/state saja; tambah API/DB verifier tests dan device/provider proof.                                   |

Rujukan: `apps/web/src/components/attendance/liveness.ts`, `camera-capture.ts`, `CameraCaptureDialog.tsx`, `apps/api/src/modules/attendance/index.ts`, `prisma-repository.ts`, `selfie-upload.ts`, `app.ts`, schema `AttendanceAttempt`/`SelfieCapture`, dan `docs/DECISIONS.md` BE-015/BE-018.

## 2. Gate yang perlu disepakati sebelum production implementation

| Gate                      | Keputusan/konfirmasi yang diperlukan                                                                                                                                        | Jika belum tersedia                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Kontrak AUD-07            | Owner/security menerima threat model, server-verification boundary, status failure dan urutan UX. Proposal belum merupakan persetujuan.                                     | Jangan mengubah trusted gate.                                               |
| Data processing & consent | Policy/version yang disetujui untuk pemrosesan sementara sequence/frame, tujuan anti-fraud, siapa mengakses hasil, retention metadata; persetujuan vendor bila third-party. | Jangan kirim frame ke model/server/provider baru; fallback pending.         |
| Model/runtime/provider    | Model/SDK dan region/routing, ownership model, cost ceiling, SLA, dependency/license/security review. Jangan pilih provider atau endpoint eksternal diam-diam.              | Adapter unavailable; jangan menganggap synthetic verifier sebagai liveness. |
| Threat target             | Attack classes dalam scope, false-accept (FAR) dan false-reject (FRR) thresholds, dataset/device coverage dan pemilik sign-off.                                             | Tidak boleh klaim anti-spoof/security-ready atau mengaktifkan `VALID`.      |
| Challenge policy          | TTL challenge (usulan 120s), instruction set/rotation, expiry/replay UX, batas frame/bytes. Upload URL TTL saat ini bukan challenge TTL.                                    | Feature flag tetap OFF; server clock sebagai satu-satunya expiry authority. |
| Performance               | End-to-end target mengikuti PRD <=10s pada 4G, benchmark p95 liveness usulan <=3s setelah camera ready, hard timeout usulan 15s lalu pending. Uji perangkat nyata.          | Tidak menyatakan performance acceptance lulus.                              |
| Persisted metadata        | Kategori hasil/reason/version dan jangka retensinya; jangan menyimpan raw frames/embeddings atau mengasumsikan retention selfie 12 bulan berlaku.                           | Tidak membuat migration production yang mengunci retention.                 |
| Offline policy            | AUD-06 menetapkan capture date hanya candidate yang wajib review dan timestamp perangkat bukan bukti tepercaya. Belum ada bukti offline yang dapat diverifikasi server.     | Semua offline attempt tetap pending; tidak ada offline auto-`VALID`.        |

## 3. Batas kerja aman tanpa approval

Yang boleh disiapkan untuk test/local tanpa klaim production:

- Interface internal `LivenessVerifier` dan deterministic fake pada test saja, tidak dipasang sebagai production verifier.
- Unit/route tests yang membuktikan spoofed client flags tidak mengubah trusted result maupun status attendance; status server tetap pending.
- Contract test untuk challenge expiry, owner/device binding, idempotent exact retry, replay conflict, timeout/unavailable, response allowlist, logger redaction, dan cleanup buffer menggunakan synthetic bytes.
- Schema/API proposal dan migration plan sebagai dokumen; migration tidak diterapkan ke user DB.
- Benchmark harness dengan synthetic fixtures bila tidak memproses wajah karyawan.

Yang tidak boleh dilakukan sebelum persetujuan: memasang model/SDK baru untuk biometrik; mengirim frame/video ke pihak ketiga; mengubah consent text legal; menyimpan raw sequence/embedding; menandai claim browser sebagai trusted; mengaktifkan feature flag; membuka status `VALID`; atau menyatakan device/security/provider acceptance lulus.

Interface test-only bukan bukti liveness. Implementasi provider adapter yang selalu mengembalikan `UNAVAILABLE` dapat dipakai untuk memastikan fail-closed wiring, tetapi tidak menyelesaikan AUD-08 acceptance.

## 4. Urutan implementasi setelah gate disetujui

1. **Kontrak dan threat gate:** catat keputusan model/provider, threat thresholds, consent/version, TTL, retention, payload caps, unsupported/offline policy dan reviewer/sign-off. Review route/session/device bindings.
2. **Server challenge primitive:** CSPRNG nonce, actor/device/session/type binding, server `issuedAt`/`expiresAt`, atomic one-use/replay control dan idempotency association. Feature flag default OFF; challenge tidak memuat secret atau PII.
3. **Verifier port:** server-owned interface menerima transient bounded evidence + challenge; production implementation hanya adapter pilihan yang security-reviewed. Client flags tidak pernah dipassing sebagai trusted result.
4. **Ephemeral evidence transport:** streaming/body limits, TLS, deadline/abort, body logging off (API/proxy/APM), in-memory processing, zero persistence for raw sequence, cleanup pada seluruh exit path.
5. **Attendance transaction:** hasil kategoris + verifier version terikat attempt atomik; status `VALID` hanya jika verifier verified dan seluruh business, location, actor, consent, shift, offline/review gates lulus. Hasil unavailable/fail tetap pending atau stable denial sesuai kontrak; race/replay ditangani transactionally.
6. **Frontend:** tampilkan challenge yang diterima dari server, status camera/model/network, retry/review fallback; satu JPEG selfie tetap terpisah; tidak simpan frame ke IndexedDB/offline queue.
7. **Verification:** API/DB tests, logger/redaction probes, race/concurrency/replay, PostgreSQL fresh disposable, POC anti-spoof threshold review, privacy review, lalu Chrome Android/Safari iOS/device performance pilot.
8. **Enablement:** baru setelah acceptance tertulis dan staging approval, canary feature flag, monitor aggregate latency/failure only, rollback switch tested. AUD-08 tetap PARTIAL jika device/provider/privacy gate belum tersedia.

## 5. Acceptance matrix yang siap dijalankan

| Skenario                                                                                  | Bukti required                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claim `passed=true` tanpa trusted server result                                           | Tidak ada trusted result/`VALID`; DB hanya menyimpan claim untuk audit bila memang schema mengizinkan, tidak menggunakannya sebagai verdict.                                    |
| Trusted verifier success + seluruh gate lulus                                             | Server-only result terikat challenge & attempt; liveness memenuhi satu gate saja. Status final dihitung dengan gate lain; fixture test tidak menyatakan model akurat.           |
| Trusted verifier success + gate lain gagal/pending (offline, geofence, cross-date review) | Attendance tetap pending/review, bukan `VALID`.                                                                                                                                 |
| Challenge expired tepat di expiry dan +1ms                                                | Server clock boundary konsisten; tidak ada liveness success; bound attempt pending dengan reason expired sesuai usulan AUD-07.                                                  |
| Challenge replay / concurrent two consumers                                               | Exact retry key+fingerprint mengembalikan receipt awal; key baru/replay tidak memperoleh verifier success kedua; satu consumer menang di PostgreSQL.                            |
| Challenge actor/device/type mismatch atau nonce invalid                                   | Reject pre-processing dengan safe response; tidak mengungkap owner lain; tidak ada frame persisted/diproses; audit tidak berisi nonce/frame.                                    |
| Unsupported, missing face, false challenge response, timeout, model exception, 5xx        | Never verified; cleanup/abort; pending fallback jika attempt telah diterima, tanpa false receipt sebelum attempt accepted.                                                      |
| Consent missing/revoked/version mismatch                                                  | Tidak ada pemrosesan evidence; consent gate server efektif; no frame/body in logs, traces, database, storage.                                                                   |
| Privacy/retention probe                                                                   | Raw sequence, frame bytes, embeddings, signed URLs, nonce mentah tidak ada di DB/object store/log/APM/test output; metadata hanya field allowlist dan retention yang disetujui. |
| Browser/device + attack suite                                                             | Hasil FAR/FRR dan latency dilaporkan per device/lighting/threat class dengan owner sign-off; fake detector bukan pengganti.                                                     |

## 6. Keputusan minimum untuk membuka code task

1. Apakah Anda menyetujui **prinsip** AUD-07: sequence hanya diproses transient server-side, raw video/frame tidak disimpan, client claim tidak trusted, dan seluruh jalur unsupported/offline tetap pending? (Ya / ubah desain.)
2. Jika ya, siapa yang menyediakan/menyetujui **model atau provider** dan **threshold FAR/FRR/threat target**? Tanpa itu kita dapat menguji fail-closed adapter, tetapi tidak menghasilkan liveness verifier production.
3. Apakah perusahaan menyetujui **purpose/consent baru** untuk pemrosesan sementara frame liveness dan retention metadata kategoris? Wording legal tetap harus disediakan/di-approve owner, bukan dibuat sebagai keputusan teknis.

**Kesimpulan:** readiness artifact ini selesai lokal; AUD-08 production implementation belum dimulai dan tidak boleh ditandai COMPLETE. Tidak ada kode, schema, OpenAPI, provider, deploy, atau perubahan status bisnis pada task ini. Blocker keputusan tidak menghentikan artefak/tes lokal yang independen.
