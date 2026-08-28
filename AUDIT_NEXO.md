# Audit NEXO untuk Fondasi Sistem Client

Tanggal audit: 28 Agustus 2026
Sumber: `/Users/user/Downloads/auto-jaseb-nexo-main`
Tujuan: menilai infrastruktur backend NEXO untuk dipakai sebagai fondasi sistem client, bukan memperbaiki produk NEXO asli.

## Keputusan singkat

Arsitektur dasarnya layak diwarisi: satu engine multi-tenant, pemisahan API dan engine, sharding, cache konfigurasi berbasis version, queue per akun, enkripsi session, serta state persiapan grup.

Source tidak layak dicopy lalu hanya diganti tampilan. Billing, scheduler worker, kepemilikan runtime akun userbot, idempotency pengiriman, model paket, error tracking, dan validation perlu didesain ulang sebelum production.

## Verifikasi yang benar-benar dijalankan

- Inventaris seluruh source, package, migration, route, schema, dan deployment docs.
- `npm ci` berhasil pada salinan sementara di `/tmp`; source asli tidak disentuh.
- Typecheck server dan engine berhasil.
- Production build miniapp berhasil.
- `prisma validate` berhasil.
- `npm audit --omit=dev` menemukan 8 vulnerability level high dan 0 critical.
- Tidak ditemukan test/spec milik project, CI workflow, atau Dockerfile.
- Fresh migration ke PostgreSQL standar gagal di migration pertama karena extension `vector` tidak tersedia.
- Pada simulasi audit yang hanya mengganti kolom vector menjadi text di salinan `/tmp`, seluruh 26 migration berhasil dipasang.
- Setelah 26 migration, Prisma mendeteksi schema drift pada default `updatedAt` tabel `nexo_workers` dan `nexo_worker_groups`.

Catatan: simulasi tanpa vector bukan perubahan yang diusulkan ke NEXO asli. Itu hanya membuktikan migration lain dapat berjalan dan dependency pgvector berasal dari AI/RAG.

## Temuan prioritas

### P0 — wajib selesai sebelum sistem client menerima pembayaran/kiriman

1. Interval per target worker dapat dilanggar

   Scheduler menghitung target yang sudah eligible, tetapi ketika hasilnya kosong malah memilih target dari semua target. Akibatnya paket yang menjanjikan interval target 30 menit dapat mengirim mengikuti interval global worker 4–10 menit.

   Dampak: pengiriman lebih sering dari konfigurasi admin, risiko spam, dan kontrak paket tidak akurat.

2. Pembayaran bisa PAID tanpa akses

   `settlePayment` mengubah status payment menjadi `PAID`, lalu memberikan entitlement di operasi terpisah. Jika proses crash atau database gagal setelah status PAID tetapi sebelum grant selesai, retry berikutnya berhenti di jalur `alreadyPaid` dan akses tidak pernah diberikan.

   Dampak: uang masuk, akses customer tidak aktif permanen sampai intervensi manual.

3. Akun userbot tidak memiliki runtime lease

   DB lease hanya dipasang untuk akun worker NEXO. Runner akun user biasa hanya memakai sharding. Saat rolling deploy, dua engine dengan shard yang sama dapat membuka session Telegram yang sama.

   Dampak: `AUTH_KEY_DUPLICATED`, reconnect paksa, kiriman ganda, atau session mati.

4. Pengiriman Telegram belum idempotent secara end-to-end

   Beberapa flow mengirim ke Telegram dahulu lalu menyimpan hasil ke database. Crash pada celah itu membuat sistem tidak tahu pesan sudah terkirim dan dapat mengirim ulang. Unique constraint setelah send tidak mencegah side effect Telegram yang sudah terjadi.

   Dampak: komentar atau broadcast ganda.

### P1 — wajib selesai sebelum production umum

5. Timeout worker tidak membatalkan operasi Telegram

   Wrapper timeout hanya berhenti menunggu promise. Promise Telegram lama tetap hidup. Setelah worker dikarantina dan lease berpindah, operasi lama masih dapat selesai dan melanjutkan side effect tanpa pengecekan generasi/lease baru.

6. Regex buatan user dapat memblokir seluruh engine

   Regex bebas dijalankan oleh JavaScript `RegExp` terhadap pesan Telegram. Pattern dengan catastrophic backtracking dapat menahan event loop Node dan ikut menghentikan tenant lain dalam process yang sama.

7. Logout memiliki race dengan engine

   API hanya memastikan toggle feature sudah OFF. Engine dapat memerlukan hingga satu siklus sync untuk berhenti, tetapi server langsung membuka dan mencabut session yang mungkin masih dipegang engine.

8. Penanganan FloodWait memotong wait Telegram menjadi maksimal 300 detik

   Jika Telegram meminta wait di atas 300 detik, runner mencoba lagi lebih awal. Pengaturan client boleh menghapus delay buatan sistem, tetapi wait wajib dari Telegram tetap harus dihormati agar akun tidak makin dibatasi.

9. Dependency production memiliki vulnerability high

   Temuan mencakup direct dependency `@fastify/static` dan Prisma, serta dependency transitif routing/parsing. Upgrade perlu diuji karena sebagian fix meminta major version.

10. Fresh deployment tidak portable dan schema mengalami drift

    Migration mengasumsikan pgvector tersedia. Setelah vector disisihkan untuk simulasi, semua migration berhasil tetapi hasil migration tidak persis sama dengan schema Prisma pada dua kolom `updatedAt`.

### P2 — desain dan maintainability

11. Paket belum benar-benar configurable

    Harga dapat dioverride dari database, tetapi daftar paket, hari, feature, Max Jaseb, dan limit target masih hardcoded. Kebutuhan client memerlukan entitas Plan/PlanVersion yang dikelola admin.

12. Runtime validation API tidak konsisten

    TypeScript generic tidak memvalidasi JSON saat runtime. Beberapa boolean memakai `Boolean(value)`, sehingga string `"false"` dianggap `true`. Angka juga tidak selalu mempunyai batas maksimum yang jelas.

13. Error state belum mempunyai kontrak terpadu

    Beberapa flow sudah bagus dengan `issueCode`, `issueMessage`, dan state precheck. Flow lain hanya menyimpan `failed`, `lastError`, atau menelan error database. Tidak ada operation ID untuk menelusuri satu aksi user dari API sampai engine.

14. Resource usage efisien untuk skala kecil-menengah, tetapi polling tumbuh linear

    Satu process menangani banyak akun—ini bagus. Namun setiap akun aktif menyalakan beberapa loop database sendiri dan polling per channel. Perkiraan idle dasar sekitar 23 query/menit/akun sebelum trafik pesan; 100 akun aktif dapat menghasilkan sekitar 39 query/detik hanya dari loop dasar.

15. Invariant satu akun per user tidak dijaga database

    Banyak code memakai `findFirst` atau `accounts[0]`, tetapi `Account.userId` tidak unique. Produk client harus memilih secara eksplisit: satu akun per user, atau multi-account dengan limit dari paket.

16. Job background tertentu dapat overlap

    Beberapa scheduler server menggunakan `setInterval` tanpa mutex/claim job. Pada giveaway dan notifikasi, overlap/restart dapat menghasilkan percobaan notifikasi ganda. Modul ini tidak perlu diwarisi jika bukan scope client.

## Yang dipertahankan

- Monorepo TypeScript dan pemisahan `server`, `engine`, `miniapp`, `core`, `db`.
- Satu engine multi-tenant; bukan satu process per akun.
- Sharding deterministik berdasarkan account ID.
- Supervisor runner yang dapat start/stop berdasarkan state database.
- Config version untuk menghindari reload konfigurasi besar setiap tick.
- Queue pengiriman sequential per akun dan governor per akun sebagai fondasi.
- AES-256-GCM untuk session/API hash, dengan tambahan versioning key pada sistem baru.
- Verifikasi Telegram Mini App `initData`, ownership query, dan admin guard.
- State machine persiapan grup: checking, join required, pending approval, ready, failed.
- Pemisahan akun worker platform dan akun userbot milik user.

## Yang ditulis ulang

- Scheduler broadcast worker dan pemilihan target eligible.
- Billing settlement dan entitlement dalam transaction/outbox yang idempotent.
- Runtime lease untuk semua session Telegram, bukan hanya worker platform.
- Job claim/idempotency pengiriman dan fencing token untuk operasi lama.
- Logout/reconnect handshake antara API dan engine.
- Model paket, versi paket, subscription snapshot, limit target/LPM, dan interval.
- Validation schema semua endpoint mutasi.
- Error taxonomy dan operation tracking per user, akun, target, serta aksi.
- Scheduler database menjadi shared/batched agar tidak membuat loop kosong per akun.
- Connection pool limit eksplisit lintas provider dan jumlah replica.
- Migration baseline bersih untuk produk client, bukan membawa seluruh sejarah NEXO.
- Seluruh frontend, visual identity, wording, navigation, dan admin experience.

## Yang dibuang dari fork client

- `packages/ai` dan dependency OpenAI.
- AI classifier, RAG, embedding, pgvector, seller profile AI, dan suggestion AI.
- X lead finder, X collector Python, tabel serta scheduler X.
- Dead-write scrape/RAG data.
- Giveaway, community recommendations, profile interview, atau fitur lain yang tidak masuk scope final.
- Frontend NEXO lama; hanya pola Telegram bridge dan API error primitive yang boleh dijadikan referensi.

## Bentuk produk client yang disarankan

### Tipe paket

1. `JASEB_WORKER`
   - Menggunakan akun worker milik client.
   - User mengatur target dan materi sesuai limit paket.
   - Engine menentukan worker yang available dan memegang lease eksklusif.

2. `USERBOT`
   - User menghubungkan akun Telegram sendiri.
   - Mencakup Jaseb self-account dan Auto Komentar MF.
   - Delay/interval dapat diatur user dalam batas paket; FloodWait Telegram tetap menjadi state wajib, bukan delay buatan tersembunyi.

### Data paket yang harus bisa diubah admin

- nama dan status paket;
- tipe paket;
- harga;
- durasi hari;
- feature yang termasuk;
- jumlah maksimal target/LPM;
- jumlah akun bila multi-account diizinkan;
- interval minimum/maksimum yang boleh dipilih user;
- versi paket dan snapshot benefit ketika checkout;
- urutan tampilan.

Perubahan paket baru tidak boleh diam-diam mengubah benefit subscription yang sudah dibeli. Payment menyimpan snapshot harga, hari, feature, dan limit saat checkout.

### State aksi yang terlihat user/admin

Setiap aksi async mempunyai `operationId`, actor, account/worker, target, state, progress, error code, pesan singkat, retryable, dan timestamp.

State minimum:

- `QUEUED`
- `CHECKING`
- `JOINING`
- `WAITING_APPROVAL`
- `READY`
- `SENDING`
- `SUCCEEDED`
- `FAILED_RETRYABLE`
- `FAILED_FINAL`
- `CANCELLED`

Pesan error harus berasal dari taxonomy, misalnya `SESSION_REVOKED`, `TARGET_NOT_FOUND`, `JOIN_APPROVAL_REQUIRED`, `CHAT_WRITE_FORBIDDEN`, `FLOOD_WAIT`, `PACKAGE_LIMIT_REACHED`, atau `WORKER_UNAVAILABLE`. Raw error Telegram disimpan untuk admin/log, bukan dilempar mentah ke user.

## Arsitektur target

```text
Telegram Mini App / Bot
          |
     Fastify API
          |
   PostgreSQL + outbox/jobs
          |
   Engine supervisor
      /         \
Worker runners  Userbot runners
      \         /
  per-session lease + fencing token
          |
      Telegram MTProto
```

API hanya mencatat desired state dan operation. Engine mengklaim job secara atomic. Semua side effect penting memakai idempotency key, lease, dan fencing token. UI membaca progress tanpa menunggu join atau resolve grup selesai di satu HTTP request.

## Tahapan implementasi dengan bukti selesai

1. Freeze scope dan acceptance criteria.
2. Buat baseline monorepo bersih tanpa AI/X/frontend lama.
3. Buat schema baru, migration fresh-install, dan test migration.
4. Implement auth, plan version, checkout snapshot, billing idempotent, dan test crash window.
5. Implement operation/job/error model dan contract test API.
6. Implement worker pool dengan lease/fencing serta integration test dua engine.
7. Implement Jaseb Worker beserta interval/limit test berbasis fake clock.
8. Implement Userbot connect/logout handshake dan multi-session collision test.
9. Implement Auto Komentar MF dan send idempotency test.
10. Bangun frontend custom setelah kontrak API stabil.
11. Jalankan E2E, soak test, dependency audit, backup/restore, dan deployment rehearsal.

Sebuah tahap hanya diberi tanda selesai jika test dan acceptance criteria-nya lulus. Build berhasil tidak dianggap bukti correctness.

## Status source asli

Tidak ada file di `/Users/user/Downloads/auto-jaseb-nexo-main` yang diubah selama audit. Dependency install, database sementara, dan simulasi migration dilakukan pada salinan `/tmp`.
