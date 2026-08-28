# Teleproto Adapter Spike

Pinned candidate: `teleproto@1.228.5`.

Adapter ini hanya membuktikan lifecycle dan error contract untuk benchmark. Ia tidak memiliki database, queue durable, OTP flow, worker pool, atau feature production.

## Local verification tanpa Telegram

```bash
npm install
npm test
node --check adapter.mjs
node --check smoke.mjs
```

## Live smoke test akun uji

Live smoke hanya connect → cek authorized session → disconnect. Ia tidak mengirim pesan, tidak menjalankan OTP, dan tidak mencetak credential.

```bash
TELEGRAM_TEST_API_ID=... \
TELEGRAM_TEST_API_HASH=... \
TELEGRAM_TEST_SESSION=... \
node smoke.mjs
```

Connect benchmark (mengeluarkan JSONL; tidak mengirim pesan):

```bash
TELEGRAM_TEST_API_ID=... \
TELEGRAM_TEST_API_HASH=... \
TELEGRAM_TEST_SESSION=... \
node benchmark-connect.mjs --runs 10
```

Gunakan API ID/hash dan StringSession milik akun uji khusus. Jangan memakai akun worker atau user production untuk benchmark.

## Contract

- `connect()` memastikan session authorized dan idempotent saat sudah ready.
- `disconnect()` idempotent.
- `sendMessage()` hanya berjalan ketika state `READY` dan menormalkan body Teleproto ke `{ message }`.
- `addNewMessageHandler()` menerima handler async.
- Error dipetakan ke code stabil tanpa mencetak raw exception atau secret.
- `floodSleepThreshold: 0` mencegah Teleproto tidur diam-diam; engine policy yang mencatat dan menjadwalkan FloodWait.
