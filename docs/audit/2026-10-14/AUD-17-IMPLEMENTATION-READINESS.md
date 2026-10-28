# AUD-17 — Readiness alternatif validasi QR/Wi-Fi/Supervisor

**Status artefak:** analisis/desain readiness lokal selesai. **Status implementasi:** gated; dokumen ini tidak mengaktifkan metode alternatif. `BLOCKED` pada template berlaku untuk implementasi, bukan alasan menghentikan analisis lokal. **Tanggal pemeriksaan:** 15 Oktober 2026 (Asia/Jakarta).

## Ringkasan

Prisma sudah mengenal `ValidationMethod` `GPS`, `QR`, `WIFI`, `SUPERVISOR`, `OFFLINE`, dan `ASSISTED`; request attempt menerima enum metode. Namun label enum atau `reportedMethod` dari client bukan bukti QR berasal dari toko, peer IP berasal dari jaringan toko, atau Supervisor hadir dan berwenang. Source yang diperiksa belum menunjukkan QR challenge/nonce/replay store, pembandingan IP attendance terhadap `Store.wifiPublicIp`, atau assisted check-in yang meminta konfirmasi Supervisor saat itu.

Jalur saat ini tetap fail-closed untuk promosi attendance. Trusted-liveness evidence saat ini bernilai false; jalur online masih memerlukan review, sedangkan offline hanya dapat valid jika syarat server—termasuk GPS dalam batas, koordinat tidak berulang, timing dan trusted-liveness—terpenuhi. Attempt no-fix mensyaratkan failure reason dan menyimpan receipt/review context; no-fix tidak membuktikan lokasi.

Belum disetujui metode yang akan disediakan, exact QR TTL dalam rentang template 30–60 detik, issuer, model replay yang mendukung beberapa karyawan, trusted proxy hops/IP, fallback, evidence dan retention. Langkah aman sekarang adalah keputusan/threat model; production flow tetap gated.

## Evidence source dan fakta checkout

| Area               | Bukti saat ini                                                                                                                                                                          | Batas kesimpulan                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Method             | `ValidationMethod` enum memuat `GPS/QR/WIFI/SUPERVISOR/OFFLINE/ASSISTED`; body attempt menerima nilai enum.                                                                             | Label dari client bukan validasi proof; belum boleh diperlakukan sebagai verified method.                              |
| GPS                | `attendance/geospatial-validation.ts` menghitung Haversine server-side dari store employee assignment, radius dan accuracy limit. Attempt menyimpan store/jarak/batas/hasil geofence.   | Lokasi diperiksa server; fallback tidak boleh melewati assignment/geofence/status pending.                             |
| No-fix             | Body meminta `locationFailureReason` saat `location=null`, dan menolaknya bila lokasi ada.                                                                                              | Kegagalan GPS tidak boleh otomatis menjadi `VALID`.                                                                    |
| Offline/liveness   | `attendance/prisma-repository.ts` menetapkan `hasTrustedLivenessEvidence=false`; offline valid memerlukan syarat tambahan; pada jalur itu metode attendance disimpan sebagai `OFFLINE`. | Client liveness claim tidak dipercaya; AUD17 bukan cara melewati guard ini.                                            |
| QR                 | Enum tersedia, tetapi tidak ditemukan issuer/challenge/signature/expiry/redeem nonce/replay model.                                                                                      | QR proof dan replay prevention belum ada.                                                                              |
| Wi-Fi              | Store CRUD menerima satu literal IPv4/IPv6 pada `wifiPublicIp`; pemakaian attendance verifier tidak ditemukan.                                                                          | Nilai konfigurasi bukan bukti bahwa perangkat berada pada jaringan toko; tidak ada CIDR/egress/trusted-proxy contract. |
| Proxy/IP           | Route memakai `request.ip`; constructor Fastify di `app.ts` tidak menyetel `trustProxy` secara eksplisit.                                                                               | Topologi deploy belum diuji; jangan baca forwarded header langsung atau menganggap IP tepercaya.                       |
| Supervisor         | Workflow verification/review memutus record pending; tidak ditemukan workflow membuat assisted attempt dengan konfirmasi Supervisor in-person.                                          | Review existing tidak sama dengan presence proof atau izin memakai akun/perangkat lain.                                |
| Idempotency/status | Attendance receipt idempotent untuk retry owner; pending verification/offline tetap status terpisah.                                                                                    | Idempotency attendance bukan replay prevention challenge QR; retry tidak boleh mempromosikan status.                   |

Sumber utama: `apps/api/prisma/schema.prisma` (ValidationMethod, Attendance, AttendanceAttempt, LocationProof, Store); `apps/api/src/modules/attendance/index.ts`; `geospatial-validation.ts`; `attendance/prisma-repository.ts`; `apps/api/src/routes/attendance-attempts.ts`; `apps/api/src/modules/store/*`; `apps/api/src/app.ts`; PRD/TODO/DECISIONS. Line number harus diperbarui ketika implementasi dimulai.

## Keputusan yang harus dibuat owner dan ops

| ID     | Keputusan terbuka                                                                              | Opsi pertimbangan, belum final                                                                                                         | Risiko menebak                                                                        |
| ------ | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| ALT-01 | Metode dan urutan rollout; toko pilot; kapan fallback boleh dipakai.                           | QR dulu; Wi-Fi hanya corroborating; Supervisor fallback; atau pertahankan GPS/manual review.                                           | Metode tidak cocok operasi toko dapat membuat false acceptance/rejection.             |
| ALT-02 | Exact TTL 30–60 detik, clock skew, cadence, issuer dan QR display.                             | Pilih nilai setelah uji scan/network; API memvalidasi server time.                                                                     | TTL panjang memudahkan relay; TTL pendek menggagalkan scan lemah.                     |
| ALT-03 | Replay semantics ketika satu QR dipakai beberapa karyawan.                                     | Store challenge multi-employee dengan one redemption per employee/shift + attendance idempotency; atau per-session employee challenge. | One-use global menolak rekan kerja; multi-use tanpa binding mengizinkan replay/relay. |
| ALT-04 | Signing algorithm, key custody/rotation, `kid`, overlap, revocation dan emergency plan.        | Asymmetric signature; private key hanya ops/secret manager; verifier menerima public key versi aktif.                                  | Key di client/browser dapat dipalsukan; rotasi salah memutus QR sah.                  |
| ALT-05 | QR berdiri sendiri, hanya saat GPS unavailable, atau corroboration; status ketika proof gagal. | Proof menjadi evidence dan tetap pending sampai acceptance policy disetujui.                                                           | Fallback diam-diam mengubah pending menjadi VALID.                                    |
| ALT-06 | Wi-Fi trusted egress: NAT/VPN/mobile, IPv4/IPv6, CIDR, DHCP/ISP rotation dan proxy chain.      | Gunakan peer address yang benar-benar diamati server; Wi-Fi sebagai sinyal pendukung.                                                  | Header injection, VPN relay, shared egress atau alamat ISP berubah.                   |
| ALT-07 | Proxy hops/CIDR, TLS termination, forwarded-header overwrite dan direct-origin access.         | Hanya trust proxy yang dikendalikan dan membuang input forwarded dari client.                                                          | Client dapat memalsukan `request.ip`.                                                 |
| ALT-08 | Supervisor actor/store scope, confirmation channel, employee consent, reason dan target.       | Supervisor login sendiri; server resolve identity/store; employee tetap identity sendiri; hasil tetap review sesuai policy.            | Shared credentials, cross-store IDOR atau attendance palsu atas nama employee.        |
| ALT-09 | Bantuan pada perangkat toko dan interaksi device binding/session.                              | Limited assisted context singkat, satu employee, audit; tidak mengganti binding pribadi.                                               | Perangkat bersama menjadi bypass account/device control.                              |
| ALT-10 | Evidence minimal dan retention per proof type.                                                 | Simpan method, store, server time, challenge hash/`kid`, verifier result, reason dan actor seperlunya.                                 | Kurang bukti menyulitkan audit; berlebih meningkatkan risiko privacy.                 |

Threat actor minimum: employee di luar toko memakai foto QR; token di-relay; replay setelah expiry; store mismatch; client mengirim method claim tanpa proof; forged `X-Forwarded-For`; VPN/NAT match; Supervisor lintas toko/tidak aktif; stolen signing key; clock drift; replay DB outage; dan retry dengan hasil network unknown. Trust failure harus menolak proof atau mempertahankan pending/review, tidak mengeluarkan `VALID`.

## Tahapan yang disarankan

1. **P0 — policy dan topology inventory.** Owner menetapkan metode, scope, issuer/reviewer, exact TTL, replay, fallback/status, privacy/retention dan incident owner. Ops memberikan diagram browser → ingress/proxy → API, trusted hops/CIDR, direct-origin guard, QR display, secret manager dan bukti egress IP. Belum ada provisioning/deployment.
2. **P1 — evidence contract fail-closed.** Pisahkan `reportedMethod` dan verified proof outcome; tetapkan server fields, scope, timestamps, idempotency, privacy allowlist dan state transition. Jangan menerima enum client sebagai hasil verification.
3. **P2 — signed QR.** Issuer/verifier server-side, canonical minimal signed payload berisi store scope, `kid`, issued/expiry dan challenge ID; tanpa PII atau credential. Verifier mengecek signature, expiry, store/assignment, server clock dan context. Simpan hash/identity yang diperlukan, bukan bearer token mentah. Replay consumption durable/atomic; kebijakan nonce harus memungkinkan banyak employee sesuai keputusan ALT-03.
4. **P3 — Wi-Fi.** Ambil peer IP dari socket atau proxy chain yang benar-benar dipercaya; jangan parse forwarded header arbitrary. Store dipilih dari assignment server. Tetapkan normalization IPv4/IPv6, proxy, NAT, ISP rotation dan CIDR. Unknown IP, absent setting, ambiguous store, missing proxy config, mismatch atau verifier outage bukan bukti Wi-Fi.
5. **P4 — Supervisor assisted.** Authenticated Supervisor memakai sesinya sendiri; server memeriksa status akun, assignment/scope toko dan employee target; context terikat intent, TTL, reason/consent policy dan audit. Tidak ada perubahan binding pribadi atau request sebagai role employee.
6. **P5 — rollout/recovery.** Feature gate per environment/store, metrics tanpa PII/token, kill switch, alert expiry/replay/mismatch/untrusted proxy/unknown outcome, key rotate/revoke dan fallback manual-review. Aktivasi staging/provider hanya setelah authorization.

## Flow dan keamanan yang diusulkan

`Sesi employee + assignment server → metode yang diizinkan → verifikasi proof/scope di server → receipt + bukti minimal + idempotency → status sesuai policy`.

- GPS success masih tunduk pada geofence/rules saat ini. GPS unavailable/out-of-bounds tidak diubah otomatis menjadi hadir valid.
- QR expired/tampered/wrong-store/replayed, Wi-Fi peer untrusted/mismatch, Supervisor unauthorized, atau proof service unavailable menghasilkan rejection proof dan/atau pending review; bukan implicit valid.
- Retry response ambiguous mengembalikan receipt untuk idempotency yang sama tanpa mengonsumsi proof dua kali. Raw attempt tetap immutable.
- Offline tidak boleh menerima QR/Wi-Fi/Supervisor claim yang belum memiliki kontrak verifikasi cryptographic/online tersendiri. Offline fallback tetap pending/review menurut aturan sekarang.
- Identity, `storeId`, `supervisorId`, role, peer IP dan verification result berasal dari server/session/assignment, bukan body browser. Semua route menerapkan role/scope di server dan concealment lintas toko konsisten.
- QR tidak mengandung PII/selfie/koordinat/secret. Jangan log token/QR image. IP adalah data sensitif: purpose, access, retention dan redaction wajib ditetapkan. Selfie, doctor note dan proof-token retention adalah lifecycle berbeda.
- Signing key, trusted proxy config dan network allowlist adalah ops/secret-manager settings, bukan browser atau Admin-editable policy. Rotasi/revocation dan dual-key overlap harus dapat diuji.
- Rate limit issuer/redeem per actor/device/store dan source yang tervalidasi; jangan membuat shared-IP limit menonaktifkan satu shift/toko.

## Acceptance dan test matrix

### Unit/API

- Tamper signature, unknown/revoked/not-active `kid`, expiry boundary/skew, canonicalization, wrong store, assignment mismatch, invalid claims, duplicate challenge, retry, same-key/different-payload conflict, redaction dan safe errors.
- Challenge reusable oleh beberapa employee sesuai policy; satu employee/shift tidak dapat mengonsumsi berulang; dua concurrent redemption menghasilkan satu proof per idempotency; cross-store dan expired ditolak. Token mentah tidak muncul di read API/log/audit.
- `reportedMethod` saja tidak menghasilkan trusted proof. Client `verifiedMethod`, `storeId`, `supervisorId`, role, peer IP, liveness atau valid flag ditolak/diabaikan sesuai kontrak strict.
- Wi-Fi exact IPv4/IPv6, mapped IPv6, untrusted socket, forged forwarded header, long proxy chain, direct origin, NAT/shared IP, mismatch dan unavailable config. Tambahkan integration dengan reverse proxy nyata untuk trust acceptance.
- Supervisor active/session/scope, cross-store IDOR, consent, context expiry, cancel/retry, device bersama tanpa mengganti binding, dan review state. Existing verification route bukan pengganti test assisted flow.
- Failure matrix mencakup GPS no-fix, QR/replay DB unavailable, Wi-Fi mismatch, Supervisor expired, offline/airplane mode, stale queue, selfie/liveness rejected, timeout dan unknown response. Semua tetap pending/review atau safe rejection.
- No-store, CSRF/Origin, role sebelum repository access, rate limit, redaction token/IP/PII, immutable audit, attachment visibility dan evidence purge.

### PostgreSQL concurrency

Gunakan hanya DB disposable terisolasi setelah schema/policy review. Race dua redemption nonce sama, dua retry attendance satu employee, QR aktif yang sah dipakai dua employee berbeda, invalidasi key vs redemption, assisted confirmation vs Supervisor reassignment, dan receipt vs pending review. Assert unique/lock menghasilkan winner sesuai policy, satu attendance/audit per identity, tidak ada cross-store leak atau partial proof consumption. Uji rollback saat audit gagal dan serialization retry. Mock bukan bukti concurrency.

### Browser/device/proxy pilot

Setelah staging terotorisasi: uji QR display/rotation dan scan Chrome Android/Safari iOS, permission camera/GPS, skew, jaringan lemah/4G, offline queue/reload/suspend, repeated scan, deep link dan expired QR. Verifikasi TLS, proxy-hop dan IP yang dilihat API, direct-origin denial, ISP/NAT nyata. Fixture employee A/B, dua store, Supervisor in/out-of-scope. Catat device/browser/OS/network, source-IP classification dan latency; jangan lampirkan QR/token/PII produksi. Prototype tidak membuktikan production trust.

## Gate keluar dan validasi

Implementasi dibuka setelah policy method/status/fallback/TTL/replay/privacy disetujui, signing-key threat review lulus, ops membuktikan proxy/network topology, durable replay storage tersedia, dan staged test environment diotorisasi. Kerjakan server proof/auth dahulu, baru UI. Acceptance perlu membuktikan expiry/replay/store mismatch/forged header/unauthorized ditolak, evidence tersimpan minimal, fallback tetap pending, serta PostgreSQL/browser/device/proxy tests nyata lulus.

Pada AUD17 ini source diperiksa read-only. Prettier dan `git diff --check` lulus. Verifikasi independen: tujuh suite API geospatial/attendance-attempt/store/verification lulus, 92/92 tes. Tidak ada production code, schema, database, provider, atau deployment diubah. PostgreSQL concurrency, proxy/provider, browser/perangkat belum diuji. Dokumen ini bukan klaim QR/Wi-Fi/Supervisor flow tersedia.
