# Foundation Contract — Sistem Jaseb Client

Status: Draft terkunci untuk tahap fondasi
Tanggal: 28 Agustus 2026

Dokumen ini adalah sumber kebenaran tujuan produk selama pembangunan. Keputusan implementasi yang tidak membantu kontrak ini tidak masuk scope.

## 1. Tujuan akhir

Membangun sistem Telegram production-first yang:

- menyediakan paket Jaseb memakai akun worker milik operator;
- menyediakan paket Userbot memakai akun Telegram milik user;
- paket Userbot mencakup Jaseb self-account dan Auto Komentar MF;
- hemat resource tanpa mengurangi correctness, isolasi akun, atau kejelasan error;
- memungkinkan admin mengubah paket tanpa deploy source;
- memiliki frontend custom yang bersih dan tidak membawa identitas NEXO;
- tidak mempunyai fitur AI, RAG, embedding, atau X Lead;
- dapat dipelihara dan dikembangkan tanpa ketergantungan tersembunyi.

## 2. Prinsip keputusan

Urutan prioritas keputusan:

1. Correctness dan konsistensi state.
2. Keamanan session dan isolasi tenant.
3. Kejelasan operasi dan error.
4. Reliability serta recovery.
5. Resource dan biaya.
6. Kecepatan development.

Pilihan dengan penggunaan RAM lebih rendah tidak boleh menang apabila menghasilkan event hilang, side effect ganda, recovery tidak deterministik, atau dependency yang tidak layak dipelihara.

## 3. Scope produk

### 3.1 Jaseb Worker

- User memilih paket, target grup/LPM, dan materi kiriman.
- Sistem mengalokasikan satu worker operator yang eligible.
- Satu worker hanya dimiliki satu engine instance pada satu waktu.
- Pengiriman mengikuti interval paket dan pengaturan yang diizinkan.
- Setiap target mempunyai state persiapan dan state pengiriman sendiri.
- Worker yang bermasalah tidak menghentikan worker atau user lain.

### 3.2 Userbot

- User menghubungkan akun Telegram melalui OTP dan 2FA bila diperlukan.
- Session dienkripsi saat tersimpan.
- User dapat menjalankan Jaseb melalui akun sendiri.
- User dapat menjalankan Auto Komentar pada channel MF yang dipilih.
- User mengatur interval/delay dalam batas paket.
- Logout dan ganti akun menunggu acknowledgement bahwa engine sudah melepas session.

### 3.3 Paket dan subscription

Admin dapat mengatur tanpa deploy:

- nama dan status paket;
- tipe `JASEB_WORKER` atau `USERBOT`;
- harga dan durasi hari;
- feature yang termasuk;
- jumlah maksimal target/LPM;
- jumlah maksimal akun;
- interval minimum dan maksimum yang dapat dipilih user;
- urutan tampil.

Checkout menyimpan snapshot benefit. Perubahan paket setelah pembayaran tidak mengubah hak subscription yang sedang aktif.

### 3.4 Operasi dan error

Setiap proses async menghasilkan `operationId` dan salah satu state:

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

Error minimum memuat `code`, pesan user, detail admin, retryability, account/worker, target, timestamp, dan correlation ID. Raw session, OTP, API hash, dan encryption key tidak pernah masuk log.

## 4. Perilaku yang sengaja tidak dijanjikan

- Sistem tidak menjanjikan bypass limit atau aturan Telegram.
- Sistem tidak menambahkan delay buatan yang tidak dipilih user.
- `FLOOD_WAIT` wajib dari Telegram tetap dihormati dan ditampilkan sebagai state jelas.
- Grup LPM dan grup diskusi channel yang meminta persetujuan admin masuk ke state
  `WAITING_APPROVAL`; request join tidak dikirim ulang selama state tersebut dan
  pekerjaan otomatis lanjut setelah membership terverifikasi.
- Menunggu persetujuan admin adalah dependency eksternal, bukan kegagalan dan bukan
  interval pengiriman. Status serta target yang menunggu harus terlihat jelas.
- Tidak ada AI classifier atau recommendation engine.

## 5. Arsitektur minimum

- TypeScript untuk API, bot, contract, admin, dan frontend.
- PostgreSQL sebagai source of truth.
- Telegram engine dipilih melalui benchmark Telethon versus Teleproto.
- Satu engine process menangani banyak session; tidak ada process per akun.
- Engine memakai queue sequential per session dan concurrency antar-session.
- Semua session mempunyai lease dan fencing token.
- Side effect penting memakai idempotency key.
- Job dan outbox memakai PostgreSQL; Redis/broker baru boleh ditambah setelah metric membuktikan kebutuhan.
- API memiliki ownership tunggal atas schema dan migration database.
- Jika engine memakai bahasa berbeda, aksesnya melalui internal contract sempit dan versioned, bukan duplikasi seluruh ORM.

## 6. Hard acceptance criteria

### Correctness

- Tidak ada duplicate send pada retry, restart, rolling deploy, atau timeout yang disimulasikan.
- Interval target tidak pernah dilanggar pada fake-clock test.
- Satu session tidak dapat diklaim dua engine bersamaan.
- Payment dan entitlement konsisten dalam seluruh crash point yang diuji.
- Logout tidak mencabut session sebelum engine melepaskannya.
- Seluruh state transition invalid ditolak.

### Telegram engine

- Controlled test suite harus lulus 100% untuk connect, reconnect, receive update, join, send, comment, forward, FloodWait, revoked session, graceful shutdown, dan restart recovery.
- Event loss pada controlled input harus 0.
- Duplicate side effect harus 0.
- Kegagalan satu session tidak boleh menghentikan session lain.
- Soak test minimum 24 jam harus selesai tanpa pertumbuhan memory yang tidak kembali ke steady state.

### API dan database

- Seluruh endpoint mutasi mempunyai runtime schema validation.
- Fresh migration dan upgrade migration diuji pada database kosong serta fixture versi sebelumnya.
- Query tenant selalu mempunyai ownership boundary yang diuji.
- Payment webhook idempotent.
- Backup dan restore rehearsal berhasil sebelum production.

### Frontend

- Tidak menyimpan business rule paket sebagai hardcode.
- API client berasal dari contract yang sama dengan server.
- Setiap aksi async menampilkan progress atau terminal error.
- Tidak ada silent failure.
- Mobile Telegram viewport menjadi target utama dan diuji E2E.

## 7. Non-goal versi pertama

- AI/RAG/embedding.
- X/Twitter collector.
- Giveaway dan community recommendation.
- Multi-region active-active.
- Kubernetes.
- Redis atau message broker tanpa bukti bottleneck.
- Analytics warehouse.

## 8. Keputusan produk yang belum boleh diasumsikan

- Nama brand, warna, dan identitas visual.
- Payment provider final.
- Satu atau lebih akun userbot per user.
- Nilai paket aktual: harga, hari, jumlah LPM, dan range interval.
- Kebijakan refund, grace period, dan subscription stacking.
- Channel MF default atau seluruhnya dikelola user.

Bagian tersebut tidak memblokir technology spike, tetapi wajib diputuskan sebelum vertical slice terkait dibangun.
