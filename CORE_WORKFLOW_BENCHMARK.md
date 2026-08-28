# Core Workflow Benchmark

Dokumen ini memindahkan fokus pengukuran ke dua alur inti produk. Benchmark ini menguji correctness dan isolasi workflow sebelum provider Telegram nyata dipasang.

## Workload A — Broadcast Jaseb

Satu operation memiliki satu account/worker, satu materi, dan daftar target grup. Planner wajib menghasilkan tepat satu command per target, mempertahankan ownership account, serta memberi idempotency key stabil per `operationId + targetId`.

Variasi workload:

- 1, 10, 50, dan 100 target per operation;
- worker operator dan userbot user;
- materi pendek, panjang, unicode, dan materi kosong/terlalu panjang;
- target sukses, target tidak ditemukan, target write-forbidden, timeout, dan FloodWait classification;
- satu target gagal tidak boleh membatalkan target lain;
- retry operation tidak boleh membuat duplicate command.

## Workload B — Auto Komentar MF

Satu incoming channel post dievaluasi terhadap rule regex milik user. Post yang tidak match tidak menghasilkan side effect. Post yang match menghasilkan paling banyak satu comment command ke discussion target, dengan dedupe key stabil per `ruleId + channelPostId`.

Variasi workload:

- no-match, single-match, multi-rule match, duplicate update, dan update terlambat;
- discussion target tersedia, hilang, atau write-forbidden;
- caption kosong, unicode, newline, dan panjang maksimum;
- 1, 10, dan 50 session dengan rule dan channel berbeda;
- regex invalid atau pattern berbahaya harus ditolak/diisolasi sebelum masuk hot path.

## Matrix pengukuran

Setiap kandidat engine dan implementasi workflow diukur pada workload yang sama:

| Dimensi | Nilai |
|---|---|
| Session | 1 / 10 / 50 |
| User aktif | 1 / 10 / 50 |
| Broadcast target | 1 / 10 / 50 / 100 |
| Comment event rate | 1 / 10 / 50 event per menit per session |
| Mix | broadcast-only / comment-only / 50:50 / burst 80:20 |
| Durasi | 15 menit correctness, 1 jam trend, 24 jam release gate |

## Hard gates

- Broadcast command count = target count; comment command count = expected match count.
- Duplicate side effect = 0 pada retry, duplicate update, timeout, dan restart simulation.
- Event loss = 0 untuk input yang diterima harness.
- Failure isolation: satu account/target gagal tidak menghentikan account/target lain.
- Ownership tidak boleh silang antar user, worker, session, target, atau operation.
- Invalid transition dan invalid regex ditolak dengan error code yang stabil.
- Latency, queue depth, CPU, RSS, reconnect, dan error code dicatat per workflow; angka p50/p95 tidak menggantikan hard gates.

Live Telegram send/comment hanya dijalankan setelah planner, idempotency, error isolation, dan fake-clock tests lulus. Live run tetap satu operation terkontrol dan tidak diulang otomatis setelah side effect.
