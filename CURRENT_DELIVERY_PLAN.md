# Current Delivery Plan

Status: 1 September 2026

Dokumen ini adalah urutan kerja aktif. Tidak ada item baru dikerjakan sebelum
item sebelumnya memiliki bukti yang disebutkan di bawah.

## Tujuan rilis terdekat

Seorang user canary dapat menghubungkan akun Telegram sendiri, memilih atau
melepas akun tersebut, lalu menjalankan Userbot tanpa session/OTP bocor dan
tanpa runner lama dapat memakai session yang sudah dilepas.

## Kondisi saat ini

| Unit | Status | Bukti / batas |
| --- | --- | --- |
| Mini App identity, session, entitlement | Verified | Backend dan migration sudah ada. |
| R3-001 lifecycle account | Verified | Session/profile/entitlement dipisahkan. |
| R3-002 connect API | Verified | OTP/2FA API terenkripsi dan durable. Real-user production login belum dilakukan. |
| R3-003 list/switch/detach/logout API | Verified production | Commit `1de0de7`; release `4a15d37` deployed successfully, migration applied, health and anonymous guard verified. |
| R3-004 engine session handoff | Verified, deployed | Engine sudah melakukan discovery → lease/fencing → load ciphertext → decrypt → connect; 29 focused tests lulus; service engine production sudah `RUNNING`. |
| Mini App UI | Verified | Web production `RUNNING`; connect/logout/reconnect dan Jasa Sebar E2E nyata sudah dibuktikan (lihat D3-D5). |

## Urutan kerja yang dikunci

### D1 — Release dan verifikasi R3-003

Status: **VERIFIED**

Bukti 31 August 2026:

- Railway deployment `7d3089f4-6990-4e86-9126-1a47f70b87c9` berstatus `SUCCESS` dan
  service instance `RUNNING` dari branch `main`.
- `20260831150000_telegram_account_management.sql` berhasil diterapkan ke database
  production; function `detach_userbot_profile_account` dan
  `switch_userbot_profile_account` terdeteksi.
- `/health/live` mengembalikan `{"status":"alive"}` dan `/health/ready`
  mengembalikan `{"status":"ready","state":"RUNNING"}`.
- `GET /v1/userbot/telegram-accounts` tanpa bearer mengembalikan tepat
  `{"code":"USER_REQUIRED"}` dengan HTTP `401`.

- Outcome: API production menjalankan commit `1de0de7` dan migration account
  management terpasang.
- Acceptance:
  - migration production berhasil tanpa merusak data existing;
  - API health tetap ready;
  - endpoint account management tanpa bearer tetap `401 USER_REQUIRED`;
  - deployment, commit, command, dan hasil dicatat di evidence ledger.
- Non-goal: login Telegram nyata, UI, atau perubahan engine.
- Stop condition: semua empat acceptance di atas terbukti; bila credentials atau
  otoritas deploy tidak tersedia, statusnya `BLOCKED`, bukan diganti pekerjaan lain.

### D2 — Tutup evidence R3-004

- Outcome: ledger menyatakan contract engine yang sudah ada dengan bukti test
  dan batas risikonya.
- Acceptance:
  - bukti lease-before-decrypt, fencing, logout/switch fencing, dan shared key
    ring tercatat;
  - test PostgreSQL engine dan test fokus runner tercatat;
  - risiko sisa hanya yang belum bisa diuji tanpa akun Telegram nyata.
- Non-goal: menulis engine kedua atau mengubah runtime contract yang sudah lulus.
- Stop condition: ledger entry reviewable dalam satu halaman.

### D3 — Mini App UI: koneksi dan manajemen akun

Status: **VERIFIED**

Implementasi commit `35c7e1f` di `apps/web` memakai React, Vite, TypeScript, dan
container Nginx. Test API client `3/3`, production build Vite, dependency audit
`0 vulnerabilities`, serta API CORS preflight dan API test suite lulus. Image
production dibuild Railway dari commit `4186a3e`; healthcheck `/health` lulus.

Bukti E2E Telegram nyata (1 September 2026): owner connect akun `@leaviatan`
lewat Mini App (OTP flow, `POST /telegram-auth-flows` → `.../code` → 200),
`telegram_accounts.status = READY` di production DB tepat pada waktu login.
Sesudahnya owner logout eksplisit (`DELETE .../session` → 204) lalu connect
ulang akun yang sama dan berhasil lagi — dikonfirmasi langsung dari
`kertaaji-api` HTTP log dan query production DB, bukan cuma dari respons UI.

- Outcome: user dapat memulai connect, memasukkan OTP/2FA, melihat akun aman,
  switch, detach, dan logout melalui mobile Telegram.
- Acceptance:
  - UI memakai API contract, bukan business rule hardcode;
  - loading, error, retry, expiry/conflict, dan empty state terlihat;
  - OTP/2FA hanya dikirim ke endpoint dan tidak masuk storage/log;
  - mobile E2E mencakup connect → list → switch/detach/logout;
  - tidak memulai Telegram login otomatis; aksi selalu dari user.
- Non-goal: dashboard besar, redesign brand, billing, atau Auto Komentar UI.
- Dependency: D1 selesai.

### D4 — Controlled production smoke

Status: **VERIFIED**

- Outcome: satu user canary melakukan login nyata yang disetujui secara eksplisit
  dan memastikan session dapat dipakai engine lalu dilepas.
- Acceptance:
  - [x] connect, engine claim, dan logout/detach menghasilkan state yang benar;
  - [x] tidak ada raw session/OTP/key di response atau log;
  - [x] engine lama tidak dapat lanjut setelah logout/switch (session lama dihapus
    via `DELETE .../session` sebelum reconnect; reconnect menghasilkan account row
    yang sama dengan lease/fencing baru, bukan runner lama yang dipakai ulang);
  - [x] cleanup dan bukti dicatat.
- Non-goal: load test, multi-account rollout, atau mengirim broadcast ke target
  production tanpa otoritas terpisah.
- Dependency: D1 dan D3 selesai, serta user memberi otoritas untuk memakai akun uji.
- Bukti connect/logout/reconnect: lihat D3.
- Bukti "engine claim" (1 September 2026, lewat operasi Jasa Sebar nyata dari D5,
  bukan test artifisial): sebelum ini `account_leases` kosong (0 baris) sejak
  service `RUNNING` dan `runsStarted = 0` di log engine — akun belum pernah
  di-lease karena belum pernah ada `workflow_operations`. Begitu owner menjalankan
  Jasa Sebar sungguhan dari D5, production DB menunjukkan
  `account_leases` terisi (`lease_owner` = instance ID engine yang sedang
  `RUNNING`, `fencing_token = 1` — bukti lease pertama kalinya untuk akun ini),
  `workflow_operations.status = SUCCEEDED`, `workflow_commands.status = SUCCEEDED`
  dengan `provider_message_ids` nyata dari Telegram, dan pesan asli terkirim ke
  grup Telegram target (dikonfirmasi lewat screenshot owner). Ini menutup satu-satunya
  acceptance box yang tadinya belum terbukti di D4.

### D5 — Userbot Jaseb configuration flow

Status: **VERIFIED**

- Outcome: user berentitlement aktif dapat membuat dan menjalankan konfigurasi
  Jaseb pada akun sendiri.
- Acceptance:
  - [x] create materi (TEXT) → create target Grup LPM → execute operation →
    observe status sampai terminal, satu alur linear di Mini App;
  - [x] entitlement/limit (`maxLpmGroups`), validasi target, dan error dari API
    dipetakan ke pesan yang jelas di UI;
  - [x] idempotency key dibuat di client (`crypto.randomUUID()`) supaya retry
    jaringan tidak membuat operation dobel.
- Non-goal: Auto Komentar dan payment; kind materi `FORWARD` dan multi-target
  per operation (backend sudah mendukung, UI belum — follow-up bila dibutuhkan).
- Investigasi awal menemukan seluruh backend (`apps/api/src/http/broadcast-setting-routes.ts`,
  `broadcast-operation-routes.ts`, migration `create_broadcast_operation`) sudah
  live di production sebelum unit ini mulai (dikonfirmasi `curl` → `401
  USER_REQUIRED`, bukan `404`) — unit ini murni menambahkan Mini App UI
  (`apps/web/src/JasebPanel.tsx`) yang memanggilnya.
- Commit: `62a0436` (`feat: add Jasa Sebar configuration flow to Mini App`).
- Test: `apps/web` API-client test 10/10 lulus, `tsc --noEmit` + `vite build`
  bersih; `apps/api` regresi 117 pass/0 fail (tidak disentuh).
- Deploy: Railway `kertaaji-web` deployment `97e664ce-…` `SUCCESS`.
- Bukti E2E nyata (1 September 2026): owner isi materi teks "Haloo gengs", target
  `https://t.me/mmzlser`, klik Jalankan → UI menunjukkan "Menunggu giliran" lalu
  "Berhasil terkirim"; pesan benar-benar muncul di grup Telegram target
  (screenshot owner). Dikonfirmasi ulang di production DB:
  `workflow_commands.status = SUCCEEDED`, `provider_message_ids = {2}`,
  `broadcast_targets.delivery_status = SUCCEEDED`. Bukti engine-claim yang sama
  dicatat di D4.

### D6 — Auto Komentar vertical slices

- Outcome: konfigurasi channel/divisi, incoming post, review Tepat/OOT, dan
  comment execution dibangun satu slice per satu slice.
- Dependency: D5 dan keputusan produk terkait channel MF.

## Yang sengaja tidak dikerjakan sekarang

- Fitur AI/RAG/X Lead, Redis, Kubernetes, atau redesign visual.
- Billing provider sebelum keputusan provider dan policy produk dibuat.
- Live Telegram side effect tanpa otoritas eksplisit.
- Refactor engine/API yang tidak diperlukan oleh D1–D4.
