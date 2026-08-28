# Telethon Adapter Spike

Pinned candidate: `Telethon==1.44.0`.

Adapter ini hanya membuktikan lifecycle dan error contract untuk benchmark. Ia tidak memiliki database, queue durable, OTP flow, worker pool, atau feature production.

## Local verification tanpa Telegram

```bash
python3 -m unittest discover -s tests -v
python3 -m compileall -q adapter.py smoke.py
```

## Live smoke test akun uji

Live smoke hanya connect → cek authorized session → disconnect. Ia tidak mengirim pesan, tidak menjalankan OTP, dan tidak mencetak credential.

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock
.venv/bin/python -m pip install --no-deps .
TELEGRAM_TEST_API_ID=... \
TELEGRAM_TEST_API_HASH=... \
TELEGRAM_TEST_SESSION=... \
.venv/bin/python smoke.py
```

Connect benchmark (mengeluarkan JSONL; tidak mengirim pesan):

```bash
TELEGRAM_TEST_API_ID=... \
TELEGRAM_TEST_API_HASH=... \
TELEGRAM_TEST_SESSION=... \
.venv/bin/python benchmark_connect.py --runs 10
```

Gunakan API ID/hash dan StringSession milik akun uji khusus. Jangan memakai akun worker atau user production untuk benchmark.

## Contract

- `connect()` memastikan session authorized dan idempotent saat sudah ready.
- `disconnect()` idempotent.
- `send_message()` hanya berjalan ketika state `READY`.
- `add_new_message_handler()` menerima handler async.
- Error dipetakan ke code stabil tanpa mencetak raw exception atau secret.
- `FLOOD_WAIT` dikembalikan ke engine policy; Telethon disetel agar tidak tidur diam-diam.
