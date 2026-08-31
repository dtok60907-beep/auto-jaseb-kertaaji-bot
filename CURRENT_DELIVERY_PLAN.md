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
| Mini App UI | Implemented, deployed, unverified | Web production sudah `RUNNING` di `https://kertaaji-web-production.up.railway.app`; E2E Telegram nyata belum dilakukan. |

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

Status: **IMPLEMENTED_UNVERIFIED**

Implementasi commit `35c7e1f` di `apps/web` memakai React, Vite, TypeScript, dan
container Nginx. Test API client `3/3`, production build Vite, dependency audit
`0 vulnerabilities`, serta API CORS preflight dan API test suite lulus. Image
production dibuild Railway dari commit `4186a3e`; healthcheck `/health` lulus.
Domain web aktif, tetapi uji Telegram nyata belum dilakukan.

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

Status saat ini: **IN_PROGRESS** pada preflight canary. Owner sudah admitted di
slot 1 production dan status awal `appUserReady: false`, `adminActive: false`.
Login Telegram nyata tetap harus dimulai oleh owner dari Mini App.

- Outcome: satu user canary melakukan login nyata yang disetujui secara eksplisit
  dan memastikan session dapat dipakai engine lalu dilepas.
- Acceptance:
  - connect, engine claim, dan logout/detach menghasilkan state yang benar;
  - tidak ada raw session/OTP/key di response atau log;
  - engine lama tidak dapat lanjut setelah logout/switch;
  - cleanup dan bukti dicatat.
- Non-goal: load test, multi-account rollout, atau mengirim broadcast ke target
  production tanpa otoritas terpisah.
- Dependency: D1 dan D3 selesai, serta user memberi otoritas untuk memakai akun uji.
- Preflight evidence: operator `admit` mengembalikan `ALREADY_ADMITTED` pada slot 1;
  operator `list` mengonfirmasi admission aktif tanpa app user atau admin grant.
- Bot API `getMe` valid untuk `@DjaruumUserbot`; default menu button `Buka Kertaaji`
  sudah diarahkan ke URL Mini App production dan diverifikasi dengan `getChatMenuButton`.
- Next action: owner membuka menu `Buka Kertaaji` pada `@DjaruumUserbot` di Telegram,
  lalu menyelesaikan login Mini App dari
  `https://kertaaji-web-production.up.railway.app` dan memberi konfirmasi agar
  smoke connect akun userbot dimulai.

### D5 — Userbot Jaseb configuration flow

- Outcome: user berentitlement aktif dapat membuat dan menjalankan konfigurasi
  Jaseb pada akun sendiri.
- Acceptance: ditulis sebagai task contract baru setelah D4; scope dibatasi ke
  satu alur create → validate target → execute → observe status.
- Non-goal: Auto Komentar dan payment.

### D6 — Auto Komentar vertical slices

- Outcome: konfigurasi channel/divisi, incoming post, review Tepat/OOT, dan
  comment execution dibangun satu slice per satu slice.
- Dependency: D5 dan keputusan produk terkait channel MF.

## Yang sengaja tidak dikerjakan sekarang

- Fitur AI/RAG/X Lead, Redis, Kubernetes, atau redesign visual.
- Billing provider sebelum keputusan provider dan policy produk dibuat.
- Live Telegram side effect tanpa otoritas eksplisit.
- Refactor engine/API yang tidak diperlukan oleh D1–D4.
