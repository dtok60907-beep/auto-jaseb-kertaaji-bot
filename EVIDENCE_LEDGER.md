# Evidence Ledger

Ledger ini mencatat status berdasarkan bukti. Detail command output yang besar tetap berada di test artifact atau CI; ledger menyimpan referensinya.

## Status milestone

| ID | Milestone | Status | Evidence | Risiko/next gate |
|---|---|---|---|---|
| M00 | Audit NEXO | VERIFIED | `AUDIT_NEXO.md`; source-wide inspection; typecheck/build; dependency audit; migration simulation | Temuan audit wajib menjadi input desain baru |
| M01 | Foundation contract | VERIFIED | `FOUNDATION_SPEC.md`, `DELIVERY_GATES.md`, commit `8b1f2b1` | Keputusan produk bertanda belum diputus tidak boleh diasumsikan |
| M02 | Benchmark harness | VERIFIED | 5/5 Node tests lulus; hard gate event loss dan duplicate tersedia; commit `8b1f2b1` | Adapter belum ada; belum ada angka runtime |
| M03 | Project operating workflow | VERIFIED | `PROJECT_WORKFLOW.md`; cross-reference check; `git diff --check`; 5/5 regression tests; commit `0fbb93a` | Workflow wajib diterapkan pada seluruh unit berikutnya |
| M04 | Telegram runtime selection | IN_PROGRESS | Telethon adapter contract verified locally; belum ada data live | Teleproto adapter, akun uji, benchmark, soak, ADR |

## Unit aktif

### WF-001 — Tetapkan workflow development yang mengikat

- Status: VERIFIED
- Parent: M03
- Outcome: seluruh pekerjaan memiliki lifecycle, batas ukuran, gate, evidence, stop condition, dan reporting contract yang jelas.
- Goal trace: mencegah long-horizon completion illusion dan menjaga fokus pada sistem production client.
- Acceptance criteria:
  - [x] Hierarki dan state pekerjaan didefinisikan.
  - [x] Task contract dan ukuran unit didefinisikan.
  - [x] Siklus spec → design → test → implementation → verification → review tercatat.
  - [x] Gate khusus database, payment, Telegram, jobs, API, frontend, dan deployment tercatat.
  - [x] Stop condition dan pelaporan status tercatat.
  - [x] Dokumen lolos whitespace/diff check.
  - [x] Benchmark harness regression test tetap lulus.
  - [x] Checkpoint Git dibuat.
- Non-goal: membuat adapter Telethon/Teleproto atau memilih runtime.
- Dependencies: `FOUNDATION_SPEC.md`, `DELIVERY_GATES.md`, `ENGINE_BENCHMARK_PROTOCOL.md`.
- Risks/failure modes: workflow terlalu generik, kontradiktif, atau tidak menghasilkan evidence nyata.
- Test plan: cross-reference manual; `git diff --check`; benchmark harness regression test.
- Rollback/recovery: revert commit workflow tanpa memengaruhi product code.
- Expected touch points: dua dokumen root.
- Required evidence: checks lulus dan commit reference.

Penutupan:

- Final status: VERIFIED
- Commit/diff: `0fbb93a`
- Commands/tests: cross-reference file check; `git diff --check`; `npm --prefix spikes/telegram-engine test`
- Result summary: seluruh dokumen referensi ditemukan, whitespace check bersih, 5/5 test lulus.
- Remaining risk: efektivitas workflow harus terus dibuktikan pada unit engineering nyata; dokumen saja tidak menjamin disiplin.
- Rollback note: revert commit workflow tidak mengubah product/runtime code.
- Follow-up units: adapter Telethon, lalu adapter Teleproto.

### TEL-001 — Telethon adapter lifecycle dan error contract

- Status: VERIFIED
- Parent: M04
- Outcome: adapter Python yang dapat diuji tanpa credential dan menjadi dasar skenario benchmark yang seragam.
- Goal trace: mengukur kandidat Telegram engine berdasarkan behavior dan resource, bukan asumsi bahasa.
- Acceptance criteria:
  - [x] Contract lifecycle connect/disconnect/send/receive terdefinisi.
  - [x] Session tidak pernah ditulis ke log atau result.
  - [x] FloodWait, revoked session, forbidden, dan unknown error dipetakan eksplisit.
  - [x] Disconnect idempotent dan tidak meninggalkan task yang dibuat adapter.
  - [x] Unit test tanpa network/credential lulus.
  - [x] Live smoke test command terdokumentasi dan safe failure tanpa credential diverifikasi.
- Non-goal: memilih Telethon sebagai runtime final; membuat worker Jaseb; login akun user.
- Dependencies: `ENGINE_BENCHMARK_PROTOCOL.md`, benchmark harness.
- Risks/failure modes: API Telethon berubah; adapter menyembunyikan error; fake test terlalu berbeda dari live behavior.
- Test plan: Python unit test dengan fake client; static compile; optional live smoke test.
- Rollback/recovery: hapus adapter spike tanpa menyentuh production code.
- Expected touch points: `spikes/telegram-engine/adapters/telethon`.
- Required evidence: test command/output, dependency version, contract review, live-test prerequisites.

Penutupan:

- Final status: VERIFIED (scope adapter lokal saja; bukan runtime selection).
- Commit/diff: `07de492`.
- Acceptance evidence: lifecycle dan error contract ada di `adapter.py`; `SessionConfig` serta `describe()` merahasiakan secret; `smoke.py` hanya connect/authorized/disconnect.
- Commands/tests: `python3 -m unittest discover -s tests -v` (10/10); `.venv/bin/python -m unittest discover -s tests -v` (10/10); `python3 -m compileall -q adapter.py smoke.py`; package wheel install/import; benchmark harness Node test (5/5).
- Result summary: package Telethon 1.44.0 dan error surface berhasil diverifikasi pada Python 3.14.6. `requirements.lock` merekam dependency resolusi.
- Remaining risk: perilaku MTProto nyata, resource, reconnect, event loss, dan disconnect task dari library belum dibuktikan tanpa akun uji; Telethon belum menjadi pemenang.
- Rollback note: adapter spike dapat direvert tanpa menyentuh product/runtime production.
- Follow-up units: adapter Teleproto dengan contract sama, lalu live benchmark kedua kandidat.

### TEL-002 — Teleproto adapter lifecycle dan error contract

- Status: VERIFIED
- Parent: M04
- Outcome: adapter TypeScript yang memenuhi contract benchmark setara Telethon.
- Goal trace: perbandingan runtime tidak valid apabila kandidat memakai lifecycle atau error contract berbeda.
- Acceptance criteria:
  - [x] Dependency Teleproto dipin serta package dapat diinstal/import.
  - [x] Contract lifecycle connect/disconnect/send/receive terdefinisi.
  - [x] Session tidak pernah masuk diagnostic/result.
  - [x] FloodWait, revoked session, forbidden, dan unknown error dipetakan eksplisit.
  - [x] Disconnect dan send serialization diuji tanpa network/credential.
  - [x] Live smoke test command safe tanpa credential dan terdokumentasi.
- Non-goal: memilih Teleproto sebagai runtime final; mengubah benchmark score; menjalankan akun Telegram.
- Dependencies: `ENGINE_BENCHMARK_PROTOCOL.md`, benchmark harness, exact package API Teleproto.
- Risks/failure modes: API library baru berubah; mapping error tidak sesuai runtime; test mock terlalu longgar.
- Test plan: Node test dengan fake client; install/import dependency pinned; smoke setup failure; review declaration package.
- Rollback/recovery: revert adapter spike tanpa product/runtime production code.
- Expected touch points: `spikes/telegram-engine/adapters/teleproto`.
- Required evidence: lockfile, test output, import/API surface check, contract review, smoke prerequisites.

Penutupan:

- Final status: VERIFIED (scope adapter lokal saja; bukan runtime selection).
- Commit/diff: `1d8ba8a`.
- Acceptance evidence: lifecycle/error/redaction contract ada di `adapter.mjs`; direct API import dan error surface Teleproto 1.228.5 diverifikasi; `smoke.mjs` hanya connect/authorized/disconnect.
- Commands/tests: `npm test` (9/9 adapter); `node --check adapter.mjs smoke.mjs`; import/error surface check; safe smoke setup failure; parent benchmark suite (14/14).
- Result summary: dependency lockfile dibuat oleh npm; `npm audit` package spike menunjukkan 0 vulnerability; error mapping JS diperbaiki setelah regression test menemukan global Python-style timeout error tidak ada di Node.
- Remaining risk: MTProto nyata, resource, reconnect, event loss, dan shutdown library belum dibuktikan dengan akun uji; Teleproto belum menjadi pemenang.
- Rollback note: adapter spike dapat direvert tanpa product/runtime production code.
- Follow-up units: runner benchmark live kedua kandidat, soak test, dan ADR runtime.

### BEN-001 — Siapkan controlled live benchmark

- Status: VERIFIED
- Parent: M04
- Outcome: prerequisites, secret boundary, test assets, scenario order, exit condition, dan decision evidence untuk benchmark live tercatat.
- Goal trace: angka runtime hanya valid bila workload, machine, account isolation, dan evidence-nya sama.
- Acceptance criteria:
  - [x] Dedicated-account requirement dan session isolation didefinisikan.
  - [x] Environment template tidak memuat secret dan di-ignore Git.
  - [x] Safe smoke serta controlled behavior/resource/soak phases didefinisikan.
  - [x] Hard exit condition dan runtime decision evidence didefinisikan.
- Non-goal: menjalankan benchmark atau memilih runtime tanpa account authority.
- Dependencies: kedua adapter local verified; `ENGINE_BENCHMARK_PROTOCOL.md`.
- Risks/failure modes: akun test tidak benar-benar terisolasi; result dari environment berbeda dibandingkan; live send dilakukan tanpa target terkontrol.
- Test plan: file ignore check; manual cross-reference protocol/runbook; test adapter tetap dijalankan sebelum credential diberikan.
- Rollback/recovery: dokumen/environment template dapat direvert tanpa product code; `.env` lokal tidak pernah dihapus/dicommit oleh workflow.
- Expected touch points: runbook dan environment template.
- Required evidence: Git ignore check, adapter regression tests, explicit user authority untuk asset live.

Penutupan:

- Final status: VERIFIED (scope environment/runbook preparation saja).
- Commit/diff: `d8887ab`.
- Commands/tests: `git check-ignore -q spikes/telegram-engine/.env`; parent Node suite 14/14; Telethon Python suite 10/10 pada system dan pinned virtualenv.
- Result summary: credential template aman di-ignore, controlled test assets dan exit conditions terdokumentasi.
- Remaining risk: benchmark belum memiliki credential/target test sehingga tidak ada runtime measurement.
- Rollback note: revert runbook commit tidak mengubah adapter atau product code.
- Follow-up units: explicit authority untuk asset live, benchmark execution, soak, dan ADR runtime.

### BEN-002 — Runner benchmark connectivity JSONL

- Status: VERIFIED
- Parent: M04
- Outcome: kedua kandidat memiliki runner satu skenario yang mengeluarkan metadata, latency sample, dan hard assertion dalam JSONL yang sama.
- Goal trace: raw benchmark harus dapat diproses harness yang sama dan failure tidak boleh menjadi output ad-hoc.
- Acceptance criteria:
  - [x] Runner Telethon dan Teleproto hanya menjalankan connect/authorized/disconnect.
  - [x] Output sukses dan gagal sesuai record JSONL protocol.
  - [x] Latency memakai monotonic clock.
  - [x] Gagal di tengah iterasi menghasilkan hard assertion tanpa raw secret/error.
  - [x] Runner dapat diuji dengan fake adapter tanpa network/credential.
- Non-goal: multi-session, send/join/comment, resource soak, atau runtime decision.
- Dependencies: adapter local verified, common summary harness, BEN-001 runbook.
- Risks/failure modes: record drift antar bahasa, latency clock tidak konsisten, failure accidentally disembunyikan.
- Test plan: test fake success/failure per runner, output schema assertion, parent summary consumption untuk Node runner.
- Rollback/recovery: revert runners tanpa mengubah adapter/product code.
- Expected touch points: runner/test/documentation di dua adapter spike.
- Required evidence: unit tests, static check/compile, parent harness result, command documentation.

Penutupan:

- Final status: VERIFIED (scope single-session connectivity runner saja).
- Commit/diff: `da672ff`.
- Commands/tests: parent Node suite 17/17; Telethon Python suite 13/13 pada system dan pinned virtualenv; `node --check`; `compileall`; empty-environment runner output dikonsumsi parent summary harness.
- Result summary: dua runner menghasilkan metadata dan hard assertion JSONL yang kompatibel; environment kosong menghasilkan exit code 1 dan tidak membocorkan credential/raw error.
- Remaining risk: tidak ada connect ke Telegram nyata, multi-session, send, join, comment, resource, atau soak data.
- Rollback note: revert runner tanpa mengubah adapter/product code.
- Follow-up units: explicit authority untuk asset live, live connectivity execution, behavior suite, soak, dan ADR runtime.

### BEN-003 — Live single-session connectivity

- Final status: VERIFIED (connect → authorized → disconnect; tanpa send).
- Commit/diff: evidence commit `docs: record live Telegram connectivity evidence`.
- Acceptance evidence: session Telethon dan Teleproto tervalidasi tanpa menampilkan credential; `.env` tetap di-ignore Git.
- Commands/tests: Telethon `smoke.py` menghasilkan `passed=true`, `state=READY`; Teleproto `smoke.mjs` menghasilkan `passed=true`, `state=READY`.
- Result summary: kedua kandidat berhasil konek ke Telegram dan mengenali akun sebagai authorized pada environment lokal.
- Remaining risk: belum ada pengukuran latency berulang, resource soak, multi-session, join, send, comment, atau behavior suite.
- Rollback note: tidak ada perubahan pada akun Telegram; kedua smoke test selalu disconnect dan tidak mengirim pesan.
- Follow-up units: connectivity benchmark berulang, behavior suite target terkontrol, resource soak, lalu ADR keputusan runtime.

### BEN-004 — Live connectivity benchmark (10 iterasi)

- Final status: VERIFIED (10/10 hard-gate pass per candidate).
- Commit/diff: benchmark runner fix `716d560`.
- Acceptance evidence: Telethon dan Teleproto masing-masing menyelesaikan 10 connect → authorized → disconnect tanpa side effect pesan.
- Commands/tests: Telethon runner `--runs 10`; Teleproto runner `--runs 10`; parent Node suite 18/18 setelah regression test untuk default performance clock.
- Result summary: Telethon median 1335.40 ms, p95 3791.63 ms, max 4274.85 ms; Teleproto median 477.07 ms, p95 1329.56 ms, max 1766.15 ms pada mesin/network yang sama.
- Remaining risk: latency connect bukan representasi throughput/event loop; belum ada behavior suite, send/join/comment, multi-session, atau resource soak.
- Rollback note: benchmark hanya lifecycle koneksi dan disconnect; tidak mengubah akun atau target Telegram.
- Follow-up units: controlled behavior suite dengan target yang disediakan operator, lalu resource soak pada 1/10/50 session.

### BEN-005 — Live controlled target resolve preflight

- Final status: VERIFIED (3/3 controlled target roles resolved per candidate; read-only operation).
- Commit/diff: recorded in the unit commit for this verified change set.
- Acceptance evidence: `resolve_target`/`resolveTarget` implemented in both adapters; runners emit role-scoped JSONL without target values, sessions, or raw errors; all required `.env` keys are set locally and `.env` remains Git-ignored.
- Commands/tests: `npm --prefix spikes/telegram-engine test` (22/22); Telethon Python suite (17/17); `node --check behavior-resolve-targets.mjs`; Python `compileall`; `git diff --check`; live Telethon and Teleproto runners; parent summary harness on both JSONL artifacts.
- Result summary: Telethon resolved `public_group`, `approval_group`, and `discussion_channel` as `Channel` with min/p50/p95/max latency 91.549893/91.901804/92.021945/92.035294 ms. Teleproto resolved the same roles as `Channel` with min/p50/p95/max 78.536020/80.905529/81.069359/81.087562 ms. All four assertions per candidate passed.
- Remaining risk: resolve proves target visibility only; it does not prove join-request state, discussion commenting, send permissions, update delivery, event loss, duplicate side effects, multi-session behavior, or resource soak.
- Rollback note: no Telegram membership or message changed; operation only resolved entities and disconnected.
- Follow-up units: explicit approval for the public-join side-effect test, then controlled text send, discussion comment, receive/catch-up, and resource soak.

### BEN-006 — Live public join behavior

- Final status: VERIFIED (one controlled public-join attempt per candidate; both reached `JOINED`).
- Commit/diff: recorded in the unit commit for this verified change set.
- Acceptance evidence: both adapters resolve the target, invoke the provider join operation once, serialize the side effect per session, map `UserAlreadyParticipantError` to safe `ALREADY_MEMBER`, and keep raw target/error/session data out of JSONL.
- Commands/tests: `npm --prefix spikes/telegram-engine test` (27/27); Telethon Python suite (22/22); syntax/compile checks; live Telethon and Teleproto public-join runners; parent summary harness on both JSONL artifacts.
- Result summary: Telethon `JOINED` in 192.561701 ms; Teleproto `JOINED` in 712.466637 ms. Each candidate produced one passing hard assertion and disconnected cleanly.
- Remaining risk: this proves only public join side effect; approval round trip,
  send permissions, discussion comments, receive/catch-up, duplicate side effects,
  multi-session behavior, and resource soak remain unverified.
- Rollback note: accounts remain members of the controlled public target; no automatic leave was performed because leaving is another external side effect requiring a separate explicit action.
- Follow-up units: controlled text send and discussion comment with explicit checkpoints.

### SCOPE-001 — Approval-required join excluded from live product path

- Final status: SUPERSEDED oleh `DEV-APPROVAL-001` pada 29 Agustus 2026.
- Commit/diff: recorded in the scope-adjustment commit for this change set.
- Historical decision: client flow originally targeted public groups without admin
  approval. Product scope changed before F3; this decision must not guide new code.
- Retained evidence: adapter classification tests remain useful, but production now
  maps that provider result to durable `WAITING_APPROVAL`.
- Verification at the time: Node 27/27 and Telethon 22/22 regressions were green.
- Follow-up units: controlled text send, discussion comment, receive/catch-up, and resource soak.

### DEV-APPROVAL-001 — Persisted join approval untuk Grup LPM dan linked discussion

- Status: VERIFIED
- Parent: Unit F — Engine Jasa Sebar / Auto Komen preparation
- Outcome: Grup LPM dan linked discussion yang membutuhkan persetujuan admin
  tersimpan sebagai `WAITING_APPROVAL`, tidak dianggap gagal, dan otomatis menjadi
  `READY` setelah akun terverifikasi sebagai member.
- Goal trace: target valid tidak boleh hilang hanya karena admission policy Telegram;
  command tetap tertahan sampai akun mempunyai membership yang benar.
- Acceptance criteria:
  - [x] Respons provider `APPROVAL_REQUESTED` menghasilkan state non-final
    `WAITING_APPROVAL` dengan error/status code yang jelas.
  - [x] Pemeriksaan ulang target yang masih menunggu tidak mengirim request join lagi.
  - [x] Setelah membership menjadi `MEMBER`, target otomatis berubah menjadi `READY`.
  - [x] Command broadcast maupun komentar tidak dapat diklaim sebelum preparation
    target terkait `READY`.
  - [x] Claim, transition, retry, dan takeover tetap dilindungi account lease serta
    fencing token.
- Non-goal: menyetujui request sebagai admin grup, bypass policy Telegram, dan live
  Telegram side effect pada unit ini.
- Dependencies: F1 adapter contract, E1 account lease, E3 outbox claim, F2 target preparation.
- Risks/failure modes: duplicate join call setelah crash tepat di window side effect;
  approval tidak pernah diberikan; target/link discussion berubah; akun diganti.
- Test plan: unit state-machine LPM dan discussion; negative/fenced paths; fresh
  PostgreSQL migration dan fixture; full API regression/typecheck.
- Rollback/recovery: forward migration mengembalikan target waiting ke queued/final
  sesuai keputusan operator; migration yang sudah diterapkan tidak diedit.
- Expected touch points: adapter contract, dua preparation service/repository,
  additive PostgreSQL migrations, focused tests, product contract.
- Required evidence: test output, typecheck, migration/fixture result, diff review,
  commit reference.

Penutupan:

- Final status: VERIFIED untuk state machine, persistence, fencing, dan adapter
  contract; live Telegram approval round trip tetap menjadi gate F3/provider.
- Commit/diff: unit commit `feat: support approval-waiting Telegram targets`.
- Acceptance evidence: Grup LPM dan linked discussion mempunyai durable
  `WAITING_APPROVAL`; polling tidak memanggil join kembali; membership `MEMBER`
  mempromosikan target ke `READY`; target inactive, belum ready, atau account-nya
  tidak cocok tidak dapat melepas command.
- Commands/tests: `npm run typecheck`; `npm test` (62/62); fresh PostgreSQL seluruh
  migration dan fixture; `git diff --check`.
- Result summary: polling 30 detik disimpan melalui `available_at` tanpa timer per
  target atau lease yang ditahan; FloodWait mempertahankan state approval; stale
  owner ditolak fencing token.
- Remaining risk: implementasi provider production untuk linked discussion serta
  live request → admin approve → membership aktif belum dibuat/diuji; approval
  yang tidak pernah diberikan tetap menunggu sampai target dinonaktifkan/diedit.
- Rollback note: gunakan forward corrective migration; jangan edit migration V18/V19
  yang telah diterapkan.
- Follow-up units: F3 provider adapter/native forward dan controlled Telegram
  approval round-trip test.

### DEV-F3-001 — Production Teleproto delivery adapter

- Final status: VERIFIED for F3 contract and controlled single-post delivery.
- Commit/diff: recorded in the F3 production Teleproto adapter commit.
- Parent: Unit F3 — Telegram provider adapter
- Outcome: satu adapter production per akun menyediakan lifecycle, target/member
  resolution, linked discussion, join/request approval, text delivery, dan native
  forward lengkap untuk satu post maupun album.
- Goal trace: F4/F5 hanya boleh mengeksekusi outbox melalui adapter yang menjaga
  urutan per session, error taxonomy, attribution, dan receipt provider secara konsisten.
- Acceptance criteria:
  - [x] Session config tidak dapat masuk log/JSON dan session unauthorized gagal jelas.
  - [x] Seluruh operasi satu akun serialized; kegagalan satu adapter tidak memakai
    state global atau memengaruhi adapter akun lain.
  - [x] Target group/channel, membership, dan linked discussion dipetakan ke kontrak
    production tanpa raw provider object bocor.
  - [x] Join mengembalikan `JOINED`, `ALREADY_MEMBER`, atau `APPROVAL_REQUESTED`.
  - [x] Text dikirim tanpa link preview dan menghasilkan provider receipt valid.
  - [x] Source post tunggal diforward lewat tepat satu native forward call.
  - [x] Source post ber-`groupedId` mengambil semua sibling terurut lalu melakukan
    tepat satu native forward call; caption/media tidak direkonstruksi.
  - [x] `SHOW_SOURCE`/`HIDE_SOURCE` dipetakan eksplisit dan tidak memiliki fallback.
  - [x] Error fatal, FloodWait, target/source hilang, write/forward forbidden, transient,
    serta outcome side effect tidak pasti dipetakan dan tidak membocorkan raw detail.
- Non-goal: claim/finish outbox, interval scheduler, monitoring channel, komentar,
  OTP flow, session encryption/decryption, dan deployment process.
- Dependencies: F1 contract, F2 preparation, Teleproto 1.228.5 benchmark evidence.
- Risks/failure modes: nested forward response, album sibling tidak lengkap, linked
  chat tidak ada di response, provider timeout setelah send, library API drift.
- Test plan: fake Teleproto client untuk lifecycle/concurrency/error/shape; exact call
  assertion untuk album/attribution; strict typecheck; pinned lockfile/audit; controlled
  live smoke hanya bila environment target delivery tersedia.
- Rollback/recovery: app engine terpisah dapat direvert tanpa schema/data; runtime
  candidate kembali ke unselected bila hard gate provider atau soak gagal.
- Expected touch points: `apps/engine`, Telegram contract error taxonomy, runtime ADR,
  focused tests dan runbook.
- Required evidence: unit/full tests, typecheck, dependency audit, static import check,
  optional controlled live output, diff review, commit reference.
- Acceptance evidence:
  - Contract provider-neutral dipindah ke `packages/telegram-contract`; engine tidak
    mengimpor source API dan API tidak memiliki dependency Teleproto.
  - Teleproto dikunci tepat pada `1.228.5`; satu adapter memegang satu client/account
    dan seluruh operasinya serialized tanpa state global.
  - RPC memiliki deadline 30 detik. Deadline memutus client dan memfailkan adapter;
    preflight forward bernilai `NOT_SENT`, sedangkan timeout native send/forward
    bernilai `UNKNOWN` agar unit executor berikutnya tidak menggandakan side effect.
  - Forward album mengambil sibling `groupedId`, mengurutkan message ID, lalu memanggil
    `forwardMessages` tepat satu kali. Media/caption tidak diunduh, dibentuk ulang,
    diunggah ulang, atau dipecah berdasarkan tipe.
- Commands/tests:
  - `apps/engine`: `npm test` 15/15, `npm run typecheck`, dan
    `npm audit --omit=dev` menemukan 0 vulnerability.
  - `apps/api`: regression `npm test` 62/62 dan `npm run typecheck`.
  - Controlled live smoke: target `SUPERGROUP`, membership sebelum/sesudah `MEMBER`,
    linked discussion `SUPERGROUP/MEMBER`, text receipt 1, native-forward receipt 1.
- Remaining risk: live smoke di atas memakai source post tunggal `VadeMecums/204`.
  Pencarian read-only untuk fixture album nyata dihentikan saat Telegram memberi
  `FloodWait` dan tidak diulang. Album multi-photo/video/mixed telah lolos exact-call
  contract test, tetapi live album dan multi-session soak/resource gate belum boleh
  diklaim; keduanya masuk verifikasi runtime lanjutan.
- Rollback note: revert aplikasi engine dan shared contract F3; tidak ada schema/data
  migration pada unit ini.
- Follow-up unit: F4 executor outbox harus memakai receipt/side-effect state ini,
  account lease + fencing yang sudah ada, serta tidak boleh blind retry ketika
  `sideEffectState=UNKNOWN`.

### DEV-F4-001 — Fenced Jasa Sebar outbox executor

- Final status: VERIFIED
- Commit/diff: F4 checkpoint commit; satu migration forward-only, executor engine,
  repository PostgreSQL, fixture fresh/upgrade, dan focused tests.
- Parent: Unit F4 — Broadcast command execution
- Outcome: command Jasa Sebar yang targetnya `READY` diklaim dan diselesaikan
  secara atomic di bawah account lease/fencing, lalu dikirim hanya melalui adapter F3.
- Goal trace: wording manual dan native forward harus mempunyai hasil per Grup LPM,
  interval akun yang benar, serta recovery tanpa duplicate side effect.
- Acceptance criteria:
  - [x] Assignment akun `JASEB_WORKER` dipakai ulang oleh user yang sama selama
    langganan aktif; broadcast baru tidak mengambil worker baru dan operation selesai
    tidak melepas assignment. Expiry melepas assignment tanpa menghapus setting.
  - [x] Claim hanya mengambil command `SEND_TEXT`/`FORWARD_MESSAGE` dengan target
    `READY`, account lease/fencing aktif, dan menaikkan `attempt_count` tepat sekali.
  - [x] Payload command divalidasi sebelum Telegram; payload invalid menjadi final
    tanpa provider call.
  - [x] Receipt menyimpan seluruh provider message ID album serta `sentAt`; command,
    target, operation, dan assignment berubah atomik di PostgreSQL.
  - [x] Success menjadwalkan target berikutnya memakai snapshot interval worker atau
    Userbot; interval `0` tetap valid dan tidak ditambah delay buatan.
  - [x] Error retryable `NOT_SENT` dijadwalkan; FloodWait memakai detik provider.
    Retry transient dibatasi dan memakai deterministic backoff.
  - [x] `sideEffectState=UNKNOWN`, crash/takeover, atau fencing loss tidak pernah
    auto-retry dan terlihat sebagai `SIDE_EFFECT_UNCERTAIN`.
  - [x] Status per target tetap independen dan status operation diagregasi dengan
    jelas untuk success, retry, partial final failure, cancel, dan uncertain.
- Non-goal: event listener/matcher Auto Komen, `COMMENT_TEXT` execution, session
  decrypt/registry, shard process supervisor, 24-hour soak, dan deployment Supabase.
- Dependencies: F2 target preparation, F3 provider adapter, E1 account lease,
  E3 outbox claim, broadcast interval snapshot.
- Risks/failure modes: lease hilang sesudah Telegram menerima send, receipt album
  parsial, expiry bersamaan dengan claim, retry storm, dan legacy worker assignment.
- Test plan: pure executor fake adapter/repository; PostgreSQL fixture untuk claim,
  finish, interval, receipt array, fencing, uncertainty, expiry, dan worker reuse;
  fresh seluruh migration serta upgrade rehearsal; full regression/typecheck.
- Rollback/recovery: migration harus forward-only. Command uncertain tidak boleh
  dikembalikan ke retry queue tanpa reconciliation yang membuktikan outcome Telegram.
- Acceptance evidence:
  - Dua operation worker milik satu user memakai satu assignment/account; expiry
    melepasnya dan membatalkan command tersisa tanpa menghapus material atau Grup LPM.
  - Receipt dua message ID tersimpan utuh; FloodWait `100000` detik tidak dipotong;
    interval worker mengunci akun lintas-operation, sedangkan interval Userbot `0`
    tetap dapat langsung mengambil target berikutnya.
  - Integration repository nyata membuktikan partial result
    `FAILED_FINAL + SUCCEEDED` diagregasi `FAILED_FINAL` beserta error target gagal.
  - Setelah lease takeover token `1 → 2`, completion pemilik lama ditolak, receipt
    palsu tidak tersimpan, dan claim pemilik baru merekonsiliasi command/target/
    operation menjadi `SIDE_EFFECT_UNCERTAIN` tanpa resend.
- Commands/tests:
  - Fresh PostgreSQL 16: migration V1–V20 + fixture F4 + integration repository
    `1/1` lulus.
  - Upgrade PostgreSQL 16: V1–V19 + dua assignment legacy + V20 menyisakan tepat
    `1 ACTIVE/RESERVED | 1 RELEASED` tanpa menghapus dua operation.
  - `apps/engine`: `npm test` 23 lulus + 1 integration skip tanpa database;
    integration eksplisit `1/1`; `npm run typecheck` lulus.
  - `apps/api`: regression `62/62`, `npm run typecheck`, dan `npm run check` lulus;
    `git diff --check` lulus.
- Remaining risk: migration belum diterapkan ke project Supabase client. F4 belum
  mempunyai shard runtime supervisor yang acquire/renew lease, decrypt session,
  menjalankan F2 preparation dan F4 executor sebagai loop, serta shutdown bersih.
  Live native-forward album dan multi-session soak tetap merupakan gate runtime,
  bukan sesuatu yang diklaim selesai oleh unit ini.
- Follow-up unit: F5 composition/runtime supervisor per shard untuk menyatukan account
  selection, lease heartbeat, session registry, F2 preparation, dan F4 execution.

### DEV-F5-001 — Engine runtime ownership consolidation

- Final status: VERIFIED
- Commit/diff: F5.1 code-only ownership checkpoint; tidak ada migration atau external
  side effect.
- Parent: Unit F5 — Jasa Sebar runtime orchestration
- Outcome: sharding, account-lease repository, dan F2 broadcast preparation dimiliki
  oleh `apps/engine`; HTTP API tidak lagi menjadi rumah bagi code runtime MTProto.
- Goal trace: F5 hanya dapat membangun satu supervisor yang terpelihara bila seluruh
  lifecycle Telegram berada pada satu application boundary tanpa contract duplikat.
- Acceptance criteria:
  - [x] Modul shard, lease, dan broadcast preparation beserta focused test berpindah
    ke engine; API tidak menyisakan import atau salinan runtime tersebut.
  - [x] F2 tetap memakai `packages/telegram-contract` secara langsung dan seluruh
    state/error/approval behavior tidak berubah.
  - [x] PostgreSQL repository dapat dimuat oleh Node 22 strip-types tanpa syntax
    TypeScript yang membutuhkan transpiler runtime.
  - [x] Engine focused/full test dan typecheck lulus; API full regression/typecheck
    tetap lulus setelah pemindahan.
- Non-goal: session encryption/decryption, runnable-account discovery, lease
  heartbeat, account runner, supervisor loop, live Telegram call, dan migration.
- Dependencies: F2 preparation, E1 lease/fencing, F3 adapter, dan F4 executor yang
  sudah VERIFIED.
- Risks/failure modes: import path salah, contract Telegram terduplikasi, behavior
  F2 berubah saat dipindah, atau file API lama tetap menjadi maintenance debt.
- Test plan: pindahkan focused shard/preparation suites ke engine; import repository
  PostgreSQL di bawah native strip-types; jalankan seluruh engine dan API regression.
- Rollback/recovery: code-only move tanpa schema atau external side effect; revert
  checkpoint F5.1 mengembalikan ownership lama.
- Acceptance evidence: pencarian source/test API tidak menemukan modul atau import
  Jasa Sebar runtime yang dipindah; F2 approval, retry, join, final error, dan fencing
  mempertahankan tujuh test yang sama di engine. Repository PostgreSQL sekarang
  memakai field constructor eksplisit dan berhasil di-import langsung oleh Node 22.
- Commands/tests:
  - Focused engine shard/preparation/repository-load: `11/11` lulus.
  - Full engine: `34` lulus + `1` integration skip tanpa database; typecheck lulus.
  - Full API setelah ownership move: `52/52`; typecheck dan package check lulus.
  - `git diff --check` lulus.
- Remaining risk: engine belum mempunyai session vault, runnable-account discovery,
  heartbeat, runner, atau supervisor. Auto Komen preparation/COMMENT_TEXT masih di
  API dan sengaja tidak dipindah pada unit Jasa Sebar ini; ownership-nya ditangani
  saat runtime Auto Komen dibangun agar scope F5.1 tidak melebar.
- Follow-up unit: DEV-F5-002 session envelope AES-256-GCM dan versioned key-ring
  contract sebelum engine diperbolehkan membaca ciphertext account dari database.

### DEV-F5-002 — Versioned Telegram session envelope

- Final status: VERIFIED
- Commit/diff: F5.2 shared crypto package, security ADR, dan focused negative-path
  suite; tidak ada database/session production yang dibaca atau ditulis.
- Parent: Unit F5 — Jasa Sebar runtime orchestration
- Outcome: API/account onboarding dapat mengenkripsi dan engine dapat mendekripsi
  Telegram StringSession melalui satu AES-256-GCM envelope yang versioned, terikat
  ke account context, dan mendukung rotasi key.
- Goal trace: F5 tidak boleh membaca `encrypted_session` sebelum format ciphertext,
  key selection, authentication failure, dan redaction mempunyai contract tunggal.
- Acceptance criteria:
  - [x] AES-256-GCM memakai random IV 96-bit, authentication tag 128-bit eksplisit,
    dan AAD yang mengikat header + account UUID + account type.
  - [x] Binary envelope menyimpan magic, format/cipher version, panjang IV/tag, dan
    key version; parser menolak truncation, trailing/oversize, serta format asing.
  - [x] Key ring strict menerima beberapa key 256-bit dan satu active version;
    encryption baru memakai active key sementara ciphertext versi lama tetap dapat
    didekripsi selama key lama tersedia.
  - [x] Salah account/type/key version, tamper, unknown key, malformed envelope,
    session kosong/oversize, dan env invalid menghasilkan error code stabil tanpa
    membocorkan key atau plaintext.
  - [x] Object key ring dan error aman untuk stringify/inspection; plaintext buffer
    sementara dihapus setelah operasi sejauh runtime JavaScript memungkinkan.
- Non-goal: membaca database, migration, login OTP/2FA, re-encryption background,
  account discovery, runner, supervisor, KMS/HSM, dan deploy secret production.
- Dependencies: Node 22 `node:crypto`, kolom `encrypted_session` bytea dan
  `encryption_key_version` yang sudah ada.
- Design evidence: Node 22 mendukung AAD dan explicit GCM `authTagLength`; NIST
  SP 800-38D menetapkan GCM sebagai authenticated encryption dan revisinya tetap
  mengarahkan IV 96-bit/tag kuat. NEXO memakai IV 12 byte/tag 16 byte tetapi belum
  memiliki context binding atau key-version envelope.
- Risks/failure modes: IV reuse, short tag diterima diam-diam, context swap antar
  account, key rotation memutus session lama, permissive hex parsing, dan error/log
  menampilkan secret.
- Test plan: round-trip/randomization; rotation; wrong context/version/key; bit-flip
  header/IV/tag/ciphertext; truncation/oversize; strict env parser; redaction.
- Rollback/recovery: package ini belum membaca/menulis production DB. Revert aman;
  envelope format `1` tidak boleh diubah in-place setelah dipakai—perubahan berikutnya
  wajib menambah version parser baru.
- Acceptance evidence:
  - Dua encryption dari account/session sama menghasilkan ciphertext berbeda;
    overhead envelope terbukti tetap `40 byte` dan plaintext tidak muncul di output.
  - Ciphertext key version `1` tetap terbaca setelah active key pindah ke `2`; bila
    old key dilepas lebih awal hasilnya `SESSION_KEY_NOT_FOUND`, bukan data rusak.
  - Wrong account UUID/type serta bit flip IV/tag/ciphertext/trailing byte semuanya
    gagal autentikasi. Magic, format, length, size, dan DB/envelope version mismatch
    ditolak sebelum plaintext dibuat.
  - Key memakai `KeyObject` private; temporary key/plaintext/re-encode Buffer dihapus.
    JSON/string/Node inspection hanya menampilkan marker redacted dan active version.
- Commands/tests:
  - Focused security suite: `6/6` lulus di native Node strip-types.
  - Full engine: `40` lulus + `1` PostgreSQL integration skip tanpa database;
    `npm run typecheck` lulus.
  - Full API regression: `52/52`; typecheck dan package check lulus.
  - Tidak ada dependency runtime baru; `git diff --check` lulus.
- Remaining risk: JavaScript string input/output tidak dapat di-zero secara andal;
  runner harus membatasi lifetime referensinya. Key production belum dibuat/deploy,
  belum ada DB reader/writer, rotasi row background, KMS/HSM, atau live session.
- Follow-up unit: DEV-F5-003 PostgreSQL runnable-account discovery yang hanya boleh
  mengambil ciphertext setelah caller membuktikan account lease/fencing aktif.

### DEV-F5-003 — Fenced runnable-account discovery

- Final status: VERIFIED
- Commit/diff: F5.3 PostgreSQL V21, engine repository contract/implementation,
  SQL fixture, dan PostgreSQL integration suite; belum diterapkan ke Supabase client.
- Parent: Unit F5 — Jasa Sebar runtime orchestration
- Outcome: satu shard engine dapat menemukan akun Jasa Sebar yang benar-benar
  mempunyai pekerjaan eligible, dibangunkan setelah perubahan work commit, lalu
  membaca ciphertext session hanya sesudah memegang account lease/fencing aktif.
- Goal trace: supervisor F5 tidak boleh scan/decrypt seluruh akun, menjalankan akun
  expired/detached, atau membuka session sebelum ownership lintas-process terbukti.
- Acceptance criteria:
  - [x] PostgreSQL dan TypeScript memakai mapping UUID full-128-bit ke shard yang
    identik, dengan validasi `shardCount/shardIndex` yang sama.
  - [x] Discovery hanya mengembalikan metadata aman untuk akun `READY` dengan
    entitlement, worker assignment/Userbot profile, FIFO, target preparation atau
    delivery, account interval, dan runtime retry yang masih eligible.
  - [x] Satu query juga dapat memberi waktu work berikutnya agar supervisor kelak
    memakai timer due-driven; perubahan command/target/account mengirim wake-up
    transaction-safe tanpa membawa session atau payload sensitif.
  - [x] Ciphertext dan key version hanya dapat dimuat oleh caller dengan lease owner
    serta fencing token aktif; caller tanpa lease, token lama, atau lease expired
    ditolak stabil.
  - [x] Runtime connect/retry/degraded/revoked state hanya dapat ditulis pemilik
    lease aktif, menyimpan error code stabil tanpa raw Telegram error.
  - [x] Claim preparation juga menghormati entitlement dan account binding terkini,
    sehingga discovery bukan satu-satunya correctness guard.
- Non-goal: decrypt/connect Telegram, account runner, lease heartbeat, supervisor
  concurrency, executable process, Auto Komen listener, atau live side effect.
- Dependencies: F5.1 engine ownership, F5.2 session envelope, E1 account lease,
  F2 preparation, dan F4 broadcast command executor.
- Risks/failure modes: parity shard SQL/JS meleset, polling akun idle, notification
  hilang saat reconnect, stale discovery melewati expiry/switch, ciphertext bocor di
  list query, lease takeover masih dapat menulis runtime state, dan wake-up storm.
- Test plan: focused contract/repository tests; PostgreSQL 16 fresh V1→V21 fixture;
  upgrade V1→V20→V21 fixture; repository integration untuk discovery, next due,
  LISTEN/NOTIFY, leased session load, stale fencing, dan runtime transition; seluruh
  regression engine/API serta typecheck.
- Rollback/recovery: migration additive dan fungsi replacement; koreksi production
  dilakukan lewat forward migration. Trigger wake-up dapat dilepas tanpa kehilangan
  work karena database tetap source of truth dan supervisor wajib berekonsiliasi.
- Expected touch points: satu migration + SQL fixture, satu repository contract dan
  implementasi engine, focused/integration test, Supabase README, serta ledger.
- Required evidence: fresh/upgrade migration lulus, SQL/JS shard parity terbukti,
  result discovery tidak memiliki session, lease negatif/expired/takeover ditolak,
  notification hanya terlihat setelah commit, dan full regression hijau.
- Acceptance evidence:
  - SQL dan JavaScript menghasilkan shard yang sama untuk UUID rendah, UUID acak,
    serta UUID maksimum pada `shardCount 3` dan `257`; input shard invalid ditolak.
  - Worker dengan runtime retry hanya muncul sebagai future work; Userbot due muncul
    pada shard tepat. Expired entitlement tidak dapat claim preparation, dan delivery
    claim juga tidak dapat melewati runtime backoff walaupun lease masih aktif.
  - List discovery hanya berisi account ID/type/due/flags. Session `deadbeef` tidak
    muncul di object/JSON; load tanpa lease gagal `ACCOUNT_LEASE_NOT_HELD`, sedangkan
    exact owner/token menerima salinan ciphertext dan key version yang benar.
    Role `authenticated` tidak mempunyai SELECT/EXECUTE pada view maupun tiga fungsi
    runtime server-only tersebut.
  - Runtime retry menyimpan stable code + due time; raw error ditolak. Lease takeover
    `1→2` menolak writer lama, dan degraded account tetap mencatat disconnect terakhir
    tanpa menghapus error root cause.
  - Stale preparation/delivery ditemukan sebagai recovery work. Stale delivery
    direkonsiliasi menjadi `SIDE_EFFECT_UNCERTAIN`, bukan dikirim ulang.
  - LISTEN menerima tepat satu wake-up UUID setelah transaksi multi-write commit,
    tidak menerima apa pun sebelum commit atau dari rollback, dan test integration
    dapat dijalankan dua kali berurutan tanpa residue.
- Commands/tests:
  - Fresh PostgreSQL 16: V1→V21 + fixture F5.3 lulus; fixture F4 pada schema V21
    juga lulus setelah claim memakai eligibility projection baru.
  - Upgrade PostgreSQL 16: V1→V20, row legacy, V21, fixture F5.3 lulus; ciphertext
    `c0ffee`, key version `4`, account `READY`, dan workflow `QUEUED` tetap utuh.
  - Full engine dengan F4/F5 database URL: `42/42`, tanpa skip; typecheck lulus.
  - Full API regression: `52/52`; typecheck dan package check lulus.
  - `git diff --check` dan staged diff check lulus; PostgreSQL melaporkan `0`
    koneksi tersisa setelah full integration suite.
- Remaining risk: V21 belum diterapkan ke Supabase client. Repository belum dipakai
  runner untuk decrypt/connect Telegram; wake-up tetap hint sehingga supervisor F5.5
  wajib reconciliation scan setelah start/reconnect. Query discovery belum diuji pada
  volume besar dan jumlah session paralel belum ditentukan—angka itu milik benchmark
  F5.7, jadi unit ini tidak membuat klaim kapasitas/RAM/throughput.
- Follow-up unit: DEV-F5-004 bounded account runner—acquire/heartbeat lease, fenced
  session load + decrypt, connect Teleproto, recovery/F2/F4 drain, runtime result,
  disconnect, release, dan zero-reference plaintext pada seluruh exit path.

### DEV-F5-004 — Bounded fenced account runner

- Final status: VERIFIED (code-only single-account runtime; no live Telegram side effect).
- Commit/diff: F5.4 account-runner checkpoint with explicit policy, serial heartbeat,
  Teleproto factory, focused failure-path tests, and no database migration.
- Parent: Unit F5 — Jasa Sebar runtime orchestration
- Outcome: satu discovered account dapat dijalankan end-to-end oleh engine dengan
  lease heartbeat, session decrypt/connect, bounded F2/F4 work, dan cleanup pasti.
- Goal trace: F5.5 hanya boleh mengatur concurrency akun; seluruh correctness satu
  akun harus sudah berdiri sendiri dan tidak bergantung pada supervisor happy path.
- Acceptance criteria:
  - [x] Runner tidak membaca session atau membuat adapter bila lease dipegang process
    lain; ciphertext baru dimuat/decrypt setelah exact lease/fencing diperoleh.
  - [x] Heartbeat serial memperbarui lease tanpa overlap; renew null/error menghentikan
    work berikutnya dan completion stale tidak dipersist sebagai sukses.
  - [x] Session envelope didecrypt dengan account ID/type; ciphertext copy dihapus
    setelah dipakai dan session plaintext reference runner dilepas setelah factory.
  - [x] Connect sukses mencatat runtime `CONNECTED`; crypto/connect/session error
    dipetakan ke retry/degraded/revoked dengan stable code tanpa raw provider detail.
  - [x] Preparation dan delivery dijalankan bergantian, dibatasi policy eksplisit,
    berhenti pada idle, retry account-level, fatal session, uncertainty, atau fencing.
  - [x] Disconnect, heartbeat stop, dan lease release dijalankan pada seluruh exit
    path; cleanup failure tidak menimpa root-cause result dan tetap observable.
  - [x] Production Teleproto factory menyimpan API hash/session secara private dan
    object inspection/JSON tetap redacted.
- Non-goal: memilih max concurrent sessions, shard supervisor/listener loop, process
  entrypoint, signal shutdown global, Auto Komen runtime, live account, atau load/soak.
- Dependencies: F5.1 F2/F4 engine ownership, F5.2 key ring, F5.3 runtime repository,
  E1 lease repository, dan F3 Teleproto adapter.
- Risks/failure modes: heartbeat overlap, lease hilang ketika side effect berjalan,
  plaintext bertahan di closure, connect fatal dianggap target error, retry loop cepat,
  disconnect/release menutupi error utama, serta satu akun memonopoli engine.
- Test plan: fake repositories/adapter/scheduler untuk held lease, happy drain, idle,
  max budget, crypto failures, connect retry/revoked/conflict, heartbeat loss saat
  connect/action, fatal action, retry/uncertainty stop, disconnect/release failure;
  production scheduler no-overlap; full engine/API regression dan typecheck.
- Rollback/recovery: code-only engine unit tanpa migration/external side effect;
  revert aman. Account lease tetap expiry-based bila process crash sebelum cleanup.
- Expected touch points: runner contract/service, serial heartbeat scheduler,
  Teleproto adapter factory, focused tests, dan ledger.
- Required evidence: call ordering membuktikan lease→session→decrypt→connect; stale
  heartbeat menghentikan work; semua exit cleanup; redaction; focused/full tests hijau.
- Verification evidence:
  - Focused account runner: `15/15`; membuktikan held lease tidak membaca session,
    scheduler failure tetap release lease, non-runnable tidak decrypt, happy F2/F4
    drain, heartbeat loss saat connect/send, command completion stale ditolak fencing,
    crypto/session/connect mapping, action budget, retry/uncertainty stop, cleanup
    observability, serial heartbeat no-overlap, dan secret redaction.
  - Engine typecheck lulus; full engine `55 pass`, `0 fail`, `2 skip`. Dua skip adalah
    PostgreSQL integration yang memerlukan test database URL; F5.4 tidak mengubah SQL,
    sedangkan repository/migration F5.3 terakhir sudah lulus full DB integration.
  - Full API regression `52/52`; API typecheck dan package syntax check lulus.
  - `git diff --check` lulus dan tidak ada session/API hash nyata di fixture test.
- Remaining risk: runner belum dikomposisikan oleh supervisor/process production,
  belum diuji dengan live account, dan angka concurrency/RSS/throughput belum dipilih.
  Itu sengaja menjadi F5.5–F5.7; unit ini tidak mengklaim kapasitas multi-account.
- Follow-up unit: F5.5 shard supervisor yang memakai reconciliation scan + wake-up
  hint, bounded concurrency, dedupe in-flight account, dan graceful shutdown global.

### DEV-F5-005 — Shard supervisor and graceful drain

- Final status: VERIFIED (code-only shard orchestration; no live Telegram side effect).
- Commit/diff: F5.5 supervisor contract/service, focused race/failure tests, dan tanpa
  database migration atau process deployment change.
- Parent: Unit F5 — Jasa Sebar runtime orchestration
- Outcome: satu process engine mengorkestrasi discovered account milik shard-nya ke
  runner F5.4 tanpa overlap per akun, tanpa concurrency tak terbatas, dan tanpa
  bergantung pada keandalan notification PostgreSQL.
- Goal trace: supervisor hanya mengatur scheduling multi-account. Lease, session,
  Telegram side effect, fencing, dan cleanup satu akun tetap milik runner F5.4.
- Acceptance criteria:
  - [x] Initial dan periodic reconciliation memakai `listDue`; wake-up PostgreSQL
    hanya hint yang coalesced dan notification hilang tidak kehilangan work permanen.
  - [x] Hanya account milik shard yang diterima; discovery invalid/wrong-shard tidak
    pernah mencapai runner dan dilaporkan dengan stable event code.
  - [x] Concurrency dibatasi policy eksplisit dan account ID yang sedang/pending tidak
    pernah dijalankan overlap walaupun scan/wake-up terjadi berulang.
  - [x] Account contention/runner failure memiliki deferral koordinasi lokal agar
    tidak menciptakan hot loop; budget exhaustion tetap dapat melanjutkan backlog.
  - [x] Scan, subscription, observer, dan runner rejection tidak mematikan loop atau
    membocorkan raw error; snapshot counters menunjukkan kondisi sebenarnya.
  - [x] Stop idempotent menutup subscription, berhenti menerima work baru, menunggu
    seluruh runner aktif selesai, dan mengembalikan summary immutable.
- Non-goal: memilih angka concurrency production, membuka koneksi process/ENV,
  signal handler OS, live Telegram, Auto Komen runtime, load/soak, dan autoscaling.
- Dependencies: F5.3 discovery/wakeup repository, shard parity, dan F5.4 account runner.
- Risks/failure modes: duplicate wakeups, scan overlap, due in-flight account menutup
  discovery account lain, runner rejection unhandled, LISTEN outage, busy loop pada
  lease contention, stop race yang memulai work baru, serta observer merusak runtime.
- Test plan: fake repository/runner untuk initial reconciliation, concurrency peak,
  duplicate wakeup/in-flight dedupe, wrong shard/invalid discovery, lost-notify periodic
  recovery, subscription/scan/runner/observer failure, contention deferral, serta stop
  ketika runner masih aktif dan stop kedua kalinya.
- Rollback/recovery: code-only unit tanpa migration atau external side effect; revert
  supervisor tidak memengaruhi correctness runner/account lease F5.4.
- Expected touch points: supervisor contract/service, focused tests, dan ledger.
- Required evidence: focused race/failure tests, full engine/API regression,
  typecheck, diff check, serta explicit remaining-risk statement.
- Verification evidence:
  - Focused supervisor `10/10`: policy/shard fail-fast, concurrency peak, unique
    account run, duplicate wakeup/in-flight dedupe, lost-notify periodic recovery,
    wrong-shard/invalid discovery rejection, invalid runner-result redaction,
    subscription retry, scan/runner/observer isolation, contention deferral, budget
    continuation, dan idempotent graceful stop saat runner masih aktif.
  - Focused suite diulang tiga process paralel (`30/30`) untuk memeriksa flakiness
    timer, coalesced wake-up, contention deferral, dan stop race; seluruhnya lulus.
  - Subscription startup failure tidak mematikan reconciliation dan dicoba ulang
    memakai policy eksplisit; shutdown race menutup subscription yang baru tersambung.
  - Engine typecheck lulus; full engine `65 pass`, `0 fail`, `2 skip`. Dua skip tetap
    test PostgreSQL yang memerlukan database URL dan tidak terkait perubahan code-only
    F5.5; repository F5.3 sudah lulus full DB integration pada checkpoint sebelumnya.
  - Full API regression `52/52`; API typecheck dan package syntax check lulus.
  - Error/result/event hanya membawa stable code; raw error fake tidak muncul pada
    observer atau immutable stop summary.
- Remaining risk: supervisor belum dikomposisikan dengan PostgreSQL/key ring/runner
  dalam process entrypoint production, belum menerima signal OS, dan belum diuji load
  atau live Telegram. Nilai concurrency/reconciliation/retry tetap konfigurasi wajib,
  bukan angka kapasitas yang diklaim aman sebelum benchmark F5.7.
- Follow-up unit: F5.6 production composition—strict ENV parsing, repository/key-ring/
  runner/supervisor wiring, process identity, readiness, signal drain, dan startup
  failure cleanup; setelah itu F5.7 benchmark memilih angka deployment berbasis data.

### DEV-F5-006 — Production engine composition and lifecycle

- Status: VERIFIED
- Parent: Unit F5 — Jasa Sebar runtime orchestration
- Outcome: F5.3–F5.5 dapat dijalankan sebagai satu engine production dengan config
  fail-fast, secret redaction, resource ownership jelas, readiness jujur, dan drain
  process yang tidak memotong runner aktif.
- Delivery split:
  - F5.6a: strict config, PostgreSQL resource, runner/supervisor wiring, process UUID,
    idempotent core stop, serta rollback bila open/probe/supervisor startup gagal.
  - F5.6b: HTTP live/ready, serial DB readiness monitor, signal/fatal handler,
    executable entrypoint, dan deployment ENV example/runbook minimum.
- Acceptance criteria:
  - [x] Semua capacity/timing production wajib eksplisit di ENV; tidak ada angka
    concurrency hasil tebakan yang diam-diam menjadi default deployment.
  - [x] Database URL, Telegram API hash, dan session key ring tidak muncul pada JSON,
    inspect, error publik, structured lifecycle event, atau fixture repository.
  - [x] Database diprobe sebelum ready; seluruh repository, F5.4 runner, dan F5.5
    supervisor dikomposisikan dengan instance UUID serta shard/policy yang sama.
  - [x] Failure pada open/probe/supervisor/health startup menjalankan rollback resource
    yang sudah terbuka dan hanya mengembalikan stable error + cleanup codes.
  - [x] Readiness menjadi false saat starting, DB gagal melewati threshold, stopping,
    atau failed; kembali true setelah probe recovery tanpa restart.
  - [x] `SIGTERM`/`SIGINT` dan fatal process event memulai satu drain idempotent,
    berhenti menerima work, menunggu runner, menutup health/database, dan melepas handler.
  - [x] Entrypoint tidak mencetak secret/raw error dan tidak membuka Telegram/session
    sebelum config serta database startup gate lulus.
- Non-goal: menentukan angka production final, load/soak, deployment mutation,
  Auto Komen runtime, frontend, alert backend, atau live Telegram side effect.
- Dependencies: F5.2 key ring, F5.3 repositories, F5.4 runner, F5.5 supervisor.
- Risks/failure modes: silent ENV default, duplicate process identity, URL bocor lewat
  inspect, lazy DB dianggap sehat, partial-start resource leak, signal handler ganda,
  readiness tetap hijau saat DB mati, forced exit memotong disconnect, dan stop race.
- Test plan: table-driven config negative paths/redaction; fake database/supervisor untuk
  exact wiring, startup failure di setiap boundary, cleanup order, stop idempotency;
  fake health/signal/clock untuk readiness recovery dan drain; focused/full regression.
- Rollback/recovery: code-only engine composition dan docs; belum mengubah schema,
  Supabase, Telegram, atau deployment sehingga revert aman.
- Required evidence: focused lifecycle tests, redaction assertions, full engine/API,
  typecheck, dependency audit, diff check, dan remaining-risk statement.
- F5.6a status: VERIFIED.
  - Strict config mewajibkan seluruh angka runner/supervisor/database/health dan
    memvalidasi relasi heartbeat/lease serta command/account lease sebelum resource
    dibuka; shard `1/0` pun harus ditulis eksplisit pada ENV production.
  - Database URL, API hash, dan key ring berada di private field; JSON/inspect/string,
    config error, startup error, core snapshot, dan stop summary sudah diuji redacted.
  - Composition test membuktikan satu random process UUID menjadi `leaseOwner` runner,
    serta runtime repository yang sama menghubungkan discovery supervisor dan F5.4.
  - Open/probe/instance/composition/supervisor failure diuji satu per satu; database
    yang sudah terbuka selalu dicoba tutup dan cleanup failure memakai stable code.
  - Focused config/core `5/5`, engine typecheck lulus, full engine `70 pass`, `0 fail`,
    `2 skip`, dan full API `52/52`. Dua skip tetap integration test yang memerlukan
    test database URL; unit F5.6a tidak mengubah SQL/repository behavior.
- F5.6a checkpoint remaining scope: HTTP readiness, runtime probe, process signal/fatal
  drain, dan executable entrypoint ditutup oleh F5.6b; actual Supabase tetap release gate.
- F5.6b status: VERIFIED.
  - HTTP `/health/live` dan `/health/ready` mempunyai respons/status stabil tanpa
    membocorkan dependency detail; test membuka listener localhost nyata dan menguji
    starting, ready, callback failure, method invalid, route invalid, dan close idempotent.
  - Startup dan runtime database probe mempunyai deadline client-side eksplisit;
    timeout meminta cancellation Postgres.js dan config menolak timeout yang melebihi
    interval probe. Readiness turun hanya setelah threshold dan pulih sesudah probe sukses.
  - `SIGTERM`, `SIGINT`, fatal event, repeated signal, partial handler install, rollback,
    cleanup failure, dan stop idempotency diuji. Tidak ada `process.exit()` paksa yang
    dapat memotong runner/account disconnect; cleanup incomplete menghasilkan exit code 1.
  - Executable `npm run start:production`, placeholder-only `.env.example`, dan runbook
    Supabase direct/session-mode + health/shutdown/rollback telah tersedia. Transaction
    pooler tidak dipakai karena wake-up path membutuhkan session-level `LISTEN/NOTIFY`.
    Default logger menekan wake-up/account-success hot-path dan probe-failure berulang;
    lifecycle, first failure, readiness transition, recovery, dan failure tetap terlihat.
  - Focused F5.6b lifecycle `11/11`; engine typecheck lulus; final full engine `81 pass`,
    `0 fail`, `2 skip`; full API `52/52` plus typecheck/check; npm audit engine dan API
    masing-masing `0 vulnerabilities`; diff check dilakukan pada final checkpoint.
- Remaining risk: dua PostgreSQL integration test full-suite memerlukan `F4_DATABASE_URL`/
  `F5_DATABASE_URL`; repository terkait sudah pernah lulus ephemeral PostgreSQL pada F5.3,
  tetapi composition ini belum dijalankan terhadap project Supabase client. Signal test
  memakai process target deterministik, bukan mengirim OS signal ke process dengan DB/
  Telegram nyata. Angka capacity, drain grace, CPU/RSS, throughput, dan perilaku soak belum
  diklaim aman—semuanya wajib diukur di F5.7 sebelum deployment production.
- Follow-up unit: F5.7 benchmark/load/soak dan deployment sizing berbasis hasil ukur,
  lalu staging dengan Supabase nyata serta release/rollback rehearsal.

### DEV-F5-007A — Reproducible supervisor load harness

- Status: VERIFIED
- Parent: Unit F5.7 — Production engine capacity and soak evidence
- Outcome: jalur orchestration F5.5 dapat diberi beban akun sintetis secara
  reproducible dan menghasilkan JSONL yang memisahkan correctness hard gate dari
  CPU/RSS/event-loop/throughput/drain measurement.
- Goal trace: angka concurrency tidak boleh dipilih dari intuition atau microbenchmark
  ad-hoc; workload, machine, config, raw sample, dan cara merangkum harus dapat diaudit.
- Delivery split:
  - F5.7a: supervisor-only harness dan local baseline tanpa DB/Telegram.
  - F5.7b: production repository/lease/outbox path dengan PostgreSQL dan provider fake.
  - F5.7c: controlled multi-session Telegram serta soak 1 jam lalu 24 jam.
  - F5.7d: capacity envelope, deployment sizing, dan ADR final dari seluruh evidence.
- Acceptance criteria:
  - [x] Seluruh workload input eksplisit dan tervalidasi; tidak ada concurrency atau
    jumlah akun tersembunyi sebagai default benchmark.
  - [x] Warm-up dipisahkan dari sample; metadata mencatat runtime, platform, CPU,
    commit, workload, dan scope limitation tanpa secret/environment dump.
  - [x] Setiap sample memakai supervisor production yang sama dan mengukur duration,
    throughput, CPU, RSS, heap, event-loop delay, peak concurrency, dan drain duration.
  - [x] Event loss, duplicate account execution, runner failure, concurrency violation,
    incomplete drain, dan cleanup error menjadi hard assertion, bukan sekadar metric.
  - [x] Timeout/invalid input berakhir jelas, resource selalu dihentikan, dan raw error
    tidak masuk JSONL.
  - [x] Output kompatibel dengan benchmark summarizer yang sudah ada dan CLI memberi
    exit non-zero bila satu hard gate gagal.
  - [x] Focused/full regression, typecheck, dependency audit, raw local artifact, dan
    reproducible summary tersedia sebelum unit ditutup.
- Non-goal: mengklaim kapasitas production, mengukur Supabase/network/Telegram,
  memilih angka deployment final, menjalankan live side effect, atau soak 1/24 jam.
- Dependencies: F5.5 supervisor, F5.6 lifecycle evidence, benchmark JSONL protocol.
- Risks/failure modes: benchmark mengukur fake latency alih-alih orchestration,
  sample terlalu singkat, GC/noise disalahartikan, output tidak deterministic,
  timeout meninggalkan supervisor/timer, atau hard failure tertutup percentile bagus.
- Test plan: table-driven config/CLI validation; deterministic fake repository dan
  runner untuk exact-once/concurrency; injected loss/failure/timeout; JSONL redaction;
  existing summarizer consumption; full engine/API regression.
- Rollback/recovery: code-only benchmark path tanpa migration, DB, Telegram, atau
  deployment side effect; revert tidak mengubah production engine runtime.
- Expected touch points: benchmark module/CLI/tests, package script, protocol/runbook,
  local sanitized artifact, summarizer bila kontrak lama terbukti kurang ketat.
- Required evidence: focused results, local machine metadata, raw JSONL + generated
  summary, explicit orchestration-only label, regression/audit/diff, commit reference.
- Harness checkpoint status: VERIFIED; implementation commit `db100d5`.
  - Focused suite `5/5`, lalu tiga process paralel pada versi sebelum warm-up gate
    correction `12/12`; final typecheck dan focused suite sesudah correction `5/5`.
  - Full engine `86 pass`, `0 fail`, `2 skip`; full API `52/52` plus typecheck/check;
    npm audit engine/API masing-masing `0 vulnerabilities`.
  - Smoke JSONL berhasil dikonsumsi summarizer existing dan dinilai `eligible=true`.
    Percobaan pertama membuktikan banner `npm run` merusak JSONL; runbook sekarang
    mewajibkan `npm run --silent` saat stdout diarahkan ke artifact.
  - Adversarial review menemukan warm-up failure sempat tidak memengaruhi eligibility;
    correction sekarang menyimpan failure assertion tanpa metric warm-up dan langsung
    menghentikan benchmark pada hard-gate failure.
- Local measurement evidence:
  - Commit bersih `db100d5`; Node `v22.23.2`; Intel i5-7360U 4 logical CPU, RAM 8 GiB;
    tujuh case `1:1` sampai `100:20`, masing-masing 3 warm-up + 10 measured sample,
    synthetic runner 10 ms, dan seluruh policy/workload tercatat di metadata.
  - Raw JSONL 1,891 record tersimpan lokal di ignored directory dengan SHA-256
    `b490a30d8ac9757a4f7b2acd6cb74d7338a6b7bdd97db39e19d31a44cd4853c0`;
    sanitized reproducible summary dan interpretation report disimpan di
    `apps/engine/benchmark-results`.
  - Summarizer menghasilkan `eligible=true`, hard assertion `560/560`, event loss `0`,
    duplicate execution proxy `0`, dan tidak ada runner/cleanup/concurrency/drain failure.
  - Pada synthetic 10 ms runner, throughput median sekitar `97.35 runs/s` untuk
    `100:1` dan `1,893.67 runs/s` untuk `100:20`; p95 duration masing-masing
    `1,033.17 ms` dan `54.94 ms`. Ini membuktikan scaling orchestration lokal saja.
- Final remaining risk: RSS peak sekitar 60–63 MiB adalah whole-process synthetic
  baseline, bukan memory/session. PostgreSQL, Supabase pool, lease/outbox query,
  decrypt, Teleproto session, Telegram latency/FloodWait, real drain, network, dan
  memory growth/soak belum diukur; tidak ada angka F5.7a yang boleh langsung menjadi
  production capacity atau termination grace.
- Follow-up unit: F5.7b production repository/lease/outbox load dengan PostgreSQL dan
  controlled fake provider; setelah itu F5.7c Telegram multi-session + soak.

### DEV-F5-007B — Supabase repository/lease/outbox integration

- Status: VERIFIED (scope database path + fake Telegram provider)
- Parent: Unit F5.7 — Production engine capacity and soak evidence
- Outcome: production PostgreSQL schema dan runtime contract dijalankan pada project
  Supabase nyata dengan Telegram provider tetap fake.
- Acceptance criteria:
  - [x] Project target dan baseline kosong diverifikasi sebelum migration.
  - [x] Seluruh 21 migration existing diterapkan berurutan dan contract runtime
    `acquire_account_lease`, claim/finish broadcast, discovery, serta session loader ada.
  - [x] Additive advisor migration menghapus duplicate index, menutup seluruh foreign
    key tanpa covering index, dan mengubah 17 policy agar `auth.uid()` dievaluasi sekali.
  - [x] Advisor sesudah koreksi tidak memiliki warning; enam info RLS tanpa policy
    tetap dipertahankan untuk tabel service-only.
  - [x] Transactional Supabase fixture membuktikan 11 assertion lease/outbox/agregasi
    dan seluruh data di-rollback.
  - [x] Dedicated Node gate gagal dengan exit `2` saat database URL tidak ada, sehingga
    integration test tidak dapat hijau karena skip diam-diam.
  - [x] Repository Node production dan commit-time `LISTEN/NOTIFY` lulus melalui
    direct/session Postgres connection ke project yang sama.
  - [x] Load matrix PostgreSQL, resource measurement, sanitized artifact, dan summary
    selesai sebelum unit ditutup.
- Current evidence: 22 remote migration record; 24 public tables, 49 routines, 93
  indexes; post-correction advisor hanya melaporkan unused-index info pada database
  kosong; dedicated Supabase gate `2/2` tanpa skip membuktikan outbox aggregation,
  fencing/takeover, shard parity, runtime backoff, commit-only/coalesced NOTIFY, rollback
  silence, dan cleanup; setelah load harness ditambahkan, engine regression `91 pass`,
  `0 fail`, `2 optional PostgreSQL skip`, API regression `52/52`, kedua typecheck
  bersih, dan dependency audit engine/API masing-masing `0 vulnerabilities`.
- Load-harness smoke evidence: case `1:1`, satu measured sample melalui Supabase
  session pooler lulus seluruh 11 hard gate; fake-provider call tepat `1`, duplicate
  side effect `0`, active lease `0`, executor duration sekitar `518.72 ms`, fixture
  setup `2977.25 ms`, dan cleanup `1064.06 ms`. Query MCP sesudah run memverifikasi
  operation, command, account, assignment, auth fixture, dan active lease semuanya `0`.
  Smoke ini hanya memvalidasi harness; belum menjadi capacity measurement karena
  dijalankan sebelum checkpoint commit dan tanpa load matrix.
- Final load evidence: commit `d36b4e8`, matrix `1:1,10:1,10:5,25:5,50:10`, satu
  warm-up + tiga measured sample per case, raw JSONL 331 record dengan SHA-256
  `8055cb9e55e28dba6518c8b3dd65a247501acecd06181335f26aba81904a0841`.
  Summarizer resmi menghasilkan `eligible=true`, hard assertion `165/165`, duplicate
  side effect `0`, dan tidak ada timeout, execution, aggregation, lease, atau cleanup
  failure. Pada case `50:10`, executor duration median `3509.41 ms`, p95 `4198.10 ms`,
  throughput median `14.25 command/s`, RSS peak maksimum `76,296,192 byte`, dan
  event-loop p99 maksimum `6.60 ms`. Detail boundary dan seluruh case ada di
  `apps/engine/benchmark-results/F5.7B_SUPABASE_RESULT.md`.
- Test-isolation correction: gate pertama menangkap cross-file NOTIFY karena Node test
  berjalan paralel serta fixture broadcast lama tidak dibersihkan. Runner sekarang
  serial, assertions memfilter account fixture sendiri, dan cleanup selalu menghapus
  workflow sebelum user sesuai dependency FK. Rerun lulus dan remote row count kembali 0.
- F5.7b-R Railway evidence: VERIFIED pada dedicated service `ams`, commit `9023d60`.
  Fresh GitHub build menyalin kedua package internal dan selesai `SUCCESS` dengan
  331 record, 165/165 hard assertion, dan 0 failure. Matrix sama menghasilkan batas
  `50:10` dengan duration p50 `7154.76 ms`, p95 `7929.85 ms`, throughput median
  `6.988 command/s`, RSS peak `96,088,064 byte`, dan event-loop p99 maksimum
  `5.89 ms`. Query saat run melihat fixture `25:5`; query sesudah run membuktikan
  operation, command, account, assignment, auth fixture user, dan active lease nol.
  Detail ada di `apps/engine/benchmark-results/F5.7B_RAILWAY_RESULT.md`.
- Deployment recovery evidence: deployment awal commit `1b5309d` gagal sebelum DB
  karena image lama tidak membawa package repository-relative. Failure tersebut tidak
  dijadikan benchmark; fresh build commit `9023d60` memakai root monorepo context dan
  lulus. Runbook mencatat signature serta larangan memakai redeploy image gagal.
- Remaining gate: F5.7c controlled Telegram multi-session dan soak 1 jam/24 jam.
  Angka fake-provider ini belum boleh dipakai sebagai capacity promise atau Railway
  sizing final.
- Non-goal: Telegram live send, production capacity claim, atau perubahan data
  client di luar fixture benchmark yang selalu dibersihkan.

### DEV-001 — Backend package catalog domain

- Final status: VERIFIED (first production product-code unit).
- Commit/diff: recorded in the package-catalog development commit.
- Outcome: runtime-validated catalog for `JASEB_WORKER` and `USERBOT` packages, including price, duration, features, max LPM targets, max accounts, configurable interval range, display order, and active status.
- Acceptance evidence: invalid values produce field-level issues; zero price/minimum interval are allowed; interval bounds are enforced; package output and checkout entitlement snapshot are immutable; no frontend hardcode is involved.
- Commands/tests: `npm test` (4/4); `npm run check`; `npm run typecheck` with pinned TypeScript 5.9.2; `npm audit` (0 vulnerabilities); `git diff --check`.
- Remaining risk: no persistence, API transport, authorization, or database migration yet; those are separate units and are not implied complete by this domain module.
- Rollback note: remove `apps/api` package-catalog unit without affecting Telegram benchmark spike.
- Follow-up units: PostgreSQL schema/migration for packages and entitlement snapshots, then API contract/authorization.

### DEV-002 — Core broadcast workflow contract

- Final status: VERIFIED (deterministic broadcast planner; no live Telegram side effect).
- Commit/diff: recorded in the core-workflow development commit.
- Outcome: broadcast fan-out creates one ordered idempotent send command per target for both worker and userbot modes.
- Acceptance evidence: duplicate targets, invalid payloads, ownership fields, and idempotency keys have explicit outcomes; one target cannot silently create cross-account commands.
- Commands/tests: initial unit `npm test` in `apps/api`; current regression suite is recorded under DEV-006.
- Remaining risk: this unit does not persist commands, execute Telegram side effects, or measure live queue/CPU/RSS.
- Rollback note: remove `apps/api/src/workflows/core-workflows.ts` and its tests without affecting the package catalog or Telegram spike. The old direct auto-comment placeholder was removed before any API or engine integration because it contradicted the later product requirement that approval is the default.
- Follow-up units: auto-comment contract (DEV-006), then its persistence and runtime pipeline.

### DEV-003 — Supabase PostgreSQL foundation migration

- Final status: VERIFIED (fresh migration and database-level ownership guards).
- Commit/diff: recorded in the Supabase schema commit.
- Outcome: Supabase migration defines package catalog, entitlement snapshots, encrypted Telegram account metadata, workflow operations, idempotent outbox commands, account leases/fencing, timestamps, indexes, and RLS read boundaries.
- Acceptance evidence: package and interval constraints, userbot feature requirement, sensitive payload-key checks, operation-account ownership trigger, command-operation account match trigger, and service-role-only session/lease tables are encoded in SQL.
- Commands/tests: ephemeral PostgreSQL 16 fresh apply with 6 tables; valid worker/userbot/operation/command inserts; expected ownership violations rejected; `git diff --check`.
- Remaining risk: Supabase CLI is not installed locally; migration has not yet been applied to the client's Supabase project. RLS behavior with real Supabase JWT claims and backup/restore remain release gates.
- Rollback note: apply a forward corrective migration or restore the Supabase backup; do not edit an already-applied migration in place.
- Follow-up units: Supabase project connection/preview migration, then API repository for package CRUD and outbox transaction.

### DEV-004 — Broadcast and auto-comment workflow persistence

- Final status: VERIFIED (fresh + upgrade migration with workflow ownership guards).
- Commit/diff: recorded in the workflow-persistence migration commit.
- Outcome: broadcast targets preserve per-target interval/preparation/delivery state; worker assignment is exclusive while active; comment rules belong only to their userbot owner; incoming posts and rule matches are deduplicated; each outbox command has exactly one verified workflow context.
- Acceptance evidence: `SIDE_EFFECT_UNCERTAIN` is explicit and cannot auto-retry by policy; a command must match its broadcast target or comment rule/discussion target; userbot ownership mismatch and target-context mismatch are rejected inside PostgreSQL.
- Commands/tests: ephemeral PostgreSQL 16 applies base migration then upgrade migration; valid worker broadcast and userbot comment paths insert one target/match/two commands; expected userbot-ownership, command-target, and rule/post-context violations fail; `git diff --check`.
- Remaining risk: no API transaction, engine claim loop, safe regex runtime, or live Telegram send/comment yet. RLS policy behavior with actual Supabase JWT infrastructure remains to be run against a connected Supabase project.
- Rollback note: migration is additive except status-check expansion; corrective changes must be a new forward migration, never an edit of an applied migration.
- Follow-up units: DEV-005 admin package version CRUD, then DEV-006 atomic broadcast operation/outbox creation.

### DEV-005 — Admin package version CRUD

- Final status: VERIFIED (server-only repository plus Fastify route contract).
- Commit/diff: recorded in the package CRUD commit.
- Outcome: admin can create a package and publish an updated immutable version; public reads see active packages only; admin reads include inactive packages.
- Acceptance evidence: runtime validation reuses the package domain contract; duplicate package code, missing package, invalid input, and missing admin authorization have stable API responses; writes call PostgreSQL functions that atomically create a package version and update the catalog projection.
- Commands/tests: `npm test` in `apps/api` (13/13); strict TypeScript check; direct PostgreSQL repository integration against all Supabase migrations (create → publish version 2 → list); `npm audit --omit=dev` (0 vulnerabilities); `git diff --check`.
- Remaining risk: the authorizer is an injected contract, not production Telegram identity yet; routes are not deployed or connected to the client Supabase project; payment and entitlement issuance remain intentionally out of scope.
- Rollback note: API route removal is reversible; package history is append-only and a bad publish is corrected by a new version, not mutation of the historical snapshot.
- Follow-up units: DEV-006 atomic broadcast operation, target records, worker reservation, and outbox command creation.

### DEV-006 — Divisi dan Auto Komen Menfess domain contract

- Final status: VERIFIED (domain contract only; tanpa database atau Telegram side effect).
- Commit/diff: pending checkpoint commit for this unit.
- Outcome: Divisi mempunyai mode `APPROVAL_REQUIRED` sebagai default dan `AUTO_SEND` sebagai opsi. Match mode approval hanya menghasilkan kandidat `PENDING_REVIEW`; Tepat menghasilkan tepat satu command komentar; OOT tidak menghasilkan command; Auto Send menghasilkan tepat satu command tanpa review.
- Acceptance evidence: konfigurasi Divisi tervalidasi dan immutable; kandidat menyimpan snapshot template/keyword; snapshot wajib berasal dari Divisi; duplicate decision menghasilkan `ALREADY_DECIDED` tanpa command kedua; mode Auto Send tidak menerima callback review.
- Commands/tests: `npm test` di `apps/api` (16/16); `npm run typecheck`; `npm run check`; `git diff --check`.
- Remaining risk: callback Tepat/OOT belum atomik di PostgreSQL, belum ada schema Divisi/channel/kandidat, belum ada notifikasi bot atau executor Telegram. Strategi pemilihan satu template dari beberapa template belum diputuskan dan sengaja tidak diasumsikan.
- Rollback note: hapus domain contract dan dokumentasi ini; tidak ada data/migrasi/side effect Telegram yang perlu dipulihkan.
- Follow-up units: DEV-007 contract materi Jasa Sebar, lalu DEV-008 migration Divisi, materi/target Jasa Sebar, kandidat, decision, dan outbox constraint.

### DEV-007 — Materi Jasa Sebar contract

- Final status: VERIFIED (domain contract only; tanpa database atau Telegram side effect).
- Commit/diff: pending checkpoint commit for this unit.
- Outcome: Jasa Sebar menerima wording manual (`TEXT`) atau link post channel publik (`FORWARD`). Forward mempunyai toggle `SHOW_SOURCE`/`HIDE_SOURCE` yang terpisah dari identitas akun pengirim; pengiriman dari userbot maupun worker admin tetap memakai identitas akun yang benar-benar mengirim.
- Acceptance evidence: link sumber dinormalisasi ke post channel publik; private/invite/malformed link ditolak; payload TEXT dan FORWARD tidak dapat dicampur; attribution memiliki default eksplisit `SHOW_SOURCE`; output immutable.
- Commands/tests: `npm test` dan `npm run typecheck` di `apps/api`; `git diff --check`.
- Remaining risk: provider preflight belum membuktikan akun user/worker dapat membaca dan forward sumber, perilaku hide-source belum dibenchmark pada Telethon/Teleproto, dan persistence/snapshot per command belum ada.
- Rollback note: hapus domain contract dan dokumentasi ini; tidak ada data/migrasi/side effect Telegram yang perlu dipulihkan.
- Follow-up units: DEV-008 migration untuk Divisi + Jasa Sebar material/Grup LPM + kandidat/decision/outbox constraints, lalu API CRUD.

### DEV-008 — Jasa Sebar setting persistence

- Final status: VERIFIED (migration additive; belum diterapkan ke project Supabase).
- Commit/diff: pending checkpoint commit for this unit.
- Outcome: menyimpan materi `TEXT`/`FORWARD` dan konfigurasi Grup LPM milik user dengan ownership, constraint payload, dan read boundary yang tidak dapat tercampur antar-user.
- Acceptance evidence: material TEXT/FORWARD eksklusif melalui CHECK constraint; sumber forward hanya menerima username channel publik structural, post ID positif, dan attribution source; target Grup LPM unik case-insensitive per user; target tidak dikunci ke akun/worker sebelum operation; RLS functional test membuktikan owner membaca data sendiri sementara user lain membaca nol baris.
- Commands/tests: ephemeral PostgreSQL 16 menerapkan fresh V1→V4 lalu fixture, dan upgrade V1→V3→V4 lalu fixture; kedua jalur lulus, termasuk negative payload/dedupe test dan role `authenticated` RLS test; `git diff --check` pending final review.
- Remaining risk: migration belum dijalankan pada Supabase project; API belum memvalidasi/menulis setting ini; source preflight, album media/photo/video forwarding, target join, worker allocation, dan side effect Telegram sengaja belum dibuat.
- Rollback note: additive migration; bila sudah diterapkan, koreksi melalui forward migration dan jangan edit V4 di tempat.
- Follow-up units: DEV-009 persistence Divisi/Auto Komen candidates dan review decision, lalu API CRUD per domain.

### DEV-009 — Auto Komen Divisi dan review persistence

- Final status: VERIFIED (migration additive; belum diterapkan ke project Supabase).
- Commit/diff: pending checkpoint commit for this unit.
- Outcome: menyimpan Divisi, keyword, template, channel target, kandidat post, dan keputusan Tepat/OOT dengan invariant lintas process untuk outbox komentar.
- Acceptance evidence: Divisi/channel hanya menerima user-owned Userbot; satu channel target dapat dipetakan ke banyak Divisi tetapi unik per akun; kandidat memverifikasi account/channel/template/keyword/mode/discussion snapshot; review Tepat/OOT one-to-one immutable; command approval harus `COMMENT_QUEUED` dan memiliki Tepat; OOT dan kandidat tanpa Tepat ditolak; Auto Send valid tanpa review.
- Commands/tests: PostgreSQL 16 ephemeral fresh V1→V5 dan upgrade V1→V4→V5, masing-masing menjalankan fixture positive/negative dan RLS `authenticated`; keduanya lulus. Fixture mencakup ownership mismatch, template lintas Divisi, duplicate review, command tanpa Tepat, command OOT, Auto Send, dan owner-versus-user-lain read isolation. `git diff --check` pending final review.
- Remaining risk: migration belum dijalankan pada Supabase project; API CRUD, template selection strategy, update matcher/deduplication engine, bot callback atomic, command claim, dan Telegram send sengaja belum dibuat.
- Rollback note: additive migration; koreksi dilakukan dengan forward migration, tidak mengedit migration yang telah diterapkan.
- Follow-up units: DEV-010 API CRUD Jasa Sebar, lalu DEV-011 API CRUD Divisi/channel/template dan decision transaction.

### DEV-010 — API CRUD setting Jasa Sebar

- Final status: VERIFIED (API composition/repository; belum di-deploy dan identity production belum dipasang).
- Commit/diff: pending checkpoint commit for this unit.
- Outcome: user terautentikasi dapat membuat, melihat, memperbarui, dan menghapus materi TEXT/FORWARD serta Grup LPM miliknya sendiri melalui API versioned.
- Acceptance evidence: actor user hanya berasal dari injected authorization adapter; request menolak field tidak didukung, link sumber invalid, payload campuran, dan target invalid; repository selalu memfilter `user_id` pada read/update/delete; resource user lain menjadi not found; duplicate target menjadi `LPM_TARGET_EXISTS`.
- Commands/tests: `npm test` di `apps/api` (28/28); `npm run typecheck`; `npm run check`; PostgreSQL 16 ephemeral integration memakai migration V1–V4 membuktikan create/list/update/delete TEXT/FORWARD/target, conversion TEXT→FORWARD, duplicate case-insensitive, dan owner lain tidak dapat read/update/delete; `git diff --check` pending final review.
- Remaining risk: authorizer Telegram production, entitlement limit, operation/outbox, source/target preflight, UI, dan deployment belum ada; material delete belum memiliki policy untuk operation yang kelak sudah memakai material karena operation belum dibuat.
- Rollback note: route/repository dapat direvert; data setting tetap aman dan tidak ada external side effect.
- Follow-up units: DEV-011 API CRUD Divisi/channel/template, lalu DEV-012 atomic Tepat/OOT decision dan outbox command transaction.

### R1-001 — Verifikasi Telegram Mini App initData

- Final status: VERIFIED
- Parent: R1 — Production API & identity
- Outcome: backend dapat membuktikan identitas Telegram Mini App dari raw
  `initData` sebelum data user dipakai oleh route bisnis.
- Goal trace: canary, ownership, admin role, entitlement, dan subscription harus
  terikat pada identitas Telegram yang tervalidasi, bukan header/user ID buatan
  client.
- Acceptance criteria:
  - [x] HMAC-SHA-256 mengikuti algoritma resmi Telegram dengan perbandingan
    constant-time.
  - [x] `hash`, `auth_date`, dan `user` wajib ada serta hanya boleh muncul sekali.
  - [x] Encoding rusak, duplicate field, signature salah, data kedaluwarsa, dan
    timestamp terlalu jauh di masa depan ditolak dengan error code stabil.
  - [x] Telegram user ID dipertahankan sebagai string agar tidak kehilangan
    presisi pada boundary berikutnya.
  - [x] Field Telegram baru yang sah tidak ditolak hanya karena belum dikenal
    aplikasi.
  - [x] Bot token dan raw `initData` tidak pernah masuk output, error, inspect,
    atau JSON serialization.
  - [x] Typecheck, focused test, seluruh API test, dan diff check lulus.
- Non-goal: mapping Telegram user ke UUID internal, admin lookup, allowlist,
  penerbitan session API, dan wiring ke Fastify.
- Dependencies: dokumentasi resmi Telegram Mini Apps; Node.js `crypto`.
- Risks/failure modes reviewed: urutan field memakai comparison byte-stable,
  fixture HMAC dihitung independen, duplicate key ditolak sebelum autentikasi,
  dan timestamp boundary diuji eksplisit.
- Commands/tests: focused Node test 8/8; seluruh API test 60/60;
  `npm run typecheck`; `git diff --check`.
- Result summary: signature palsu/tampered, stale/future, malformed encoding,
  duplicate field, dan user invalid ditolak tanpa membocorkan input atau bot
  token. Field Telegram tambahan tetap ikut ditandatangani dan diterima.
- Remaining risk: verifier stateless hanya menolak replay yang kedaluwarsa.
  Penggunaan ulang di dalam freshness window ditutup oleh session exchange pada
  R1-002; mapping Telegram ID ke UUID internal juga belum dibuat.
- Rollback note: verifier dan focused test dapat direvert tanpa migration,
  credential mutation, atau side effect eksternal.
- Follow-up units: R1-002 session exchange dan Fastify identity wiring, lalu
  R1-003 admin role serta ownership boundary.

### R1-002A — Canonical Telegram application user

- Final status: VERIFIED
- Parent: R1 — Production API & identity
- Outcome: satu Telegram user tervalidasi selalu dipetakan secara atomik ke satu
  UUID user internal tanpa email/nomor telepon sintetis dan tanpa bergantung pada
  Telegram session account yang menjalankan fitur.
- Goal trace: subscription, setting, ownership, serta pergantian akun Telegram
  harus tetap mengikuti identitas Mini App user dan tidak berubah ketika session
  worker/userbot dilepas atau diganti.
- Acceptance criteria:
  - [x] `app_users` menjadi parent UUID canonical bagi seluruh foreign key user
    pada schema bisnis.
  - [x] Telegram user ID positif, muat dalam batas 52-bit Telegram, dan unik.
  - [x] Upsert identitas bersifat atomic dan idempotent pada login bersamaan;
    perubahan nama/username hanya memperbarui profile snapshot, bukan UUID.
  - [x] Migrasi upgrade membackfill UUID legacy sebelum foreign key dialihkan dan
    tidak menghapus setting atau operation.
  - [x] Tabel serta function identitas tidak dapat dipanggil role browser
    `anon`/`authenticated`; hanya backend database role yang mengaksesnya.
  - [x] Fresh migration, upgrade migration, focused repository test, seluruh API
    test, typecheck, dan diff check lulus.
- Non-goal: menerbitkan bearer session API, replay consumption, role admin,
  canary allowlist, entitlement, dan wiring authorizer Fastify.
- Dependencies: R1-001; PostgreSQL; keputusan API-only business boundary.
- Risks/failure modes: duplicate first login lintas process, UUID berubah saat
  profile Telegram berubah, data legacy kehilangan parent, atau direct browser
  access membuka data identitas.
- Test plan: migration fixture fresh dan upgrade; concurrent upsert Telegram ID
  yang sama; upsert profile berubah; ID invalid; FK legacy dan FK baru; privilege
  checks; fake-SQL repository mapping; regression API penuh.
- Rollback/recovery: sebelum deploy, revert migration/code. Setelah migration
  diterapkan, rollback memakai forward migration yang mengembalikan foreign key
  hanya jika parent `auth.users` untuk semua UUID telah dipulihkan; data
  `app_users` tidak dihapus pada rollback darurat.
- Expected touch points: satu migration, identity repository, focused test, dan
  ledger.
- Required evidence: command/result migration fresh+upgrade, concurrency result,
  privilege result, test counts, diff, dan commit.
- Commit/diff: `4bdbce7` (`feat: add canonical Mini App users`).
- Commands/tests: `scripts/test-app-users-migration.sh` membuktikan fresh,
  upgrade, race, dan dua integration fixture engine; API default suite 62 pass +
  1 opt-in DB skip; focused real-PostgreSQL 1/1; engine 120 pass + 3 opt-in
  integration skip; API/engine typecheck; syntax/diff check.
- Result summary: login paralel untuk Telegram ID sama menghasilkan satu row dan
  UUID yang sama; snapshot dengan `auth_date` terbaru menang. Tiga belas foreign
  key bisnis kini menuju `app_users`, sedangkan public FK menuju `auth.users`
  menjadi nol. Migration Supabase remote `app_users` berhasil dan proof yang
  di-rollback menghasilkan `identity_rows=1`, `app_user_foreign_keys=13`, serta
  akses browser `false`.
- Advisor result: security advisor hanya melaporkan INFO RLS tanpa policy pada
  tabel backend-only (deny-all yang disengaja); performance advisor hanya
  melaporkan index belum digunakan karena seluruh tabel production masih kosong.
- Remaining risk: raw `initData` belum ditukar menjadi bearer session dan replay
  dalam freshness window belum ditutup; keduanya sengaja menjadi R1-002B. Row
  legacy tanpa Telegram ID didukung untuk upgrade, tetapi project remote memiliki
  nol row legacy sehingga tidak memerlukan reconciliation.
- Rollback note: source dapat direvert sebelum consumer session dibuat. Schema
  remote tidak di-drop; rollback darurat harus berupa forward migration dan hanya
  boleh mengalihkan FK kembali setelah semua UUID mempunyai parent yang valid.
- Follow-up units: R1-002B one-time session exchange/replay prevention, lalu
  R1-002C production Fastify authorizer wiring.

### R1-002B1 — Atomic Mini App session issuance

- Final status: VERIFIED
- Parent: R1-002B — One-time session exchange dan replay prevention
- Outcome: verified Telegram `initData` dapat ditukar tepat satu kali menjadi
  bearer token acak; database hanya menyimpan hash token dan hash `initData`.
- Goal trace: route bisnis memerlukan credential pendek yang dapat dicabut dan
  tidak boleh menerima raw Telegram `initData` pada setiap request.
- Acceptance criteria:
  - [x] Token mempunyai minimal 256-bit entropy, format ketat, TTL eksplisit, dan
    raw token hanya muncul pada hasil issuance.
  - [x] Identity upsert dan session insert terjadi dalam satu transaction/function
    database tanpa external network call di dalam transaction.
  - [x] Hash `initData` unik membuat exchange kedua menghasilkan status replay dan
    tidak membuat session kedua.
  - [x] Lookup hanya mengembalikan session yang belum revoked dan belum expired.
  - [x] `anon`/`authenticated` tidak dapat membaca table atau menjalankan function
    session; token/initData mentah tidak tersimpan.
  - [x] Fresh + upgrade migration, concurrent replay test, token redaction test,
    regression API/engine, typecheck, dan diff check lulus.
- Non-goal: endpoint HTTP, header Bearer parser, Fastify authorizer, admin role,
  canary allowlist, refresh token, dan scheduled cleanup session.
- Dependencies: R1-001 dan R1-002A.
- Risks/failure modes: network response hilang setelah token dibuat, duplicate
  request paralel, token hash collision, expired/revoked session diterima, raw
  secret masuk persistence/error, dan pertumbuhan row session.
- Test plan: deterministic entropy unit test; malformed policy; fake repository;
  PostgreSQL first exchange/replay/concurrency/expiry/revoke; DB secret scan;
  role privilege check; fresh dan upgrade migration.
- Rollback/recovery: source dapat direvert; schema additive dipertahankan. Session
  dapat direvoke tanpa mengubah user/settings; corrective schema memakai forward
  migration.
- Expected touch points: satu migration, session service/repository, focused unit
  dan PostgreSQL integration test, migration harness, ledger.
- Required evidence: exact test counts, database assertions, remote migration
  proof/advisor, diff, dan commit.
- Commit/diff: `3b6714a` (`feat: issue one-time Mini App sessions`).
- Commands/tests: focused auth/repository 6/6; PostgreSQL harness 2/2 API
  integration + 2/2 engine integration serta seluruh fresh/upgrade SQL gate;
  API default suite 66 pass + 2 real-DB opt-in skip; engine 120 pass + 3 opt-in
  skip; API/engine typecheck; syntax dan diff check.
- Result summary: token `jas_` memakai 32 random byte dan database hanya menerima
  SHA-256 32-byte untuk token serta `initData`. Dua exchange paralel menghasilkan
  tepat satu session; request lain mendapat `TELEGRAM_INIT_DATA_ALREADY_USED`.
  Lookup aktif berhenti menerima token segera setelah revoke atau expiry.
- Remote evidence: migration Supabase `api_sessions` berhasil. Proof transaction
  yang di-rollback menunjukkan `session_rows=1`, dua hash masing-masing 32 byte,
  `anon_can_select=false`, `authenticated_can_issue=false`, dan tidak ada column
  raw secret.
- Advisor result: hanya INFO RLS tanpa policy untuk tabel backend-only (deny-all
  disengaja) serta index belum digunakan karena database production masih kosong;
  tidak ada warning/error baru.
- Remaining risk: bila response pertama hilang setelah commit, retry initData yang
  sama ditolak dan frontend harus meminta user membuka ulang Mini App. Cleanup row
  session kedaluwarsa wajib masuk operational maintenance sebelum public launch.
  Endpoint exchange dan Bearer parser sengaja menjadi R1-002B2/R1-002C.
- Rollback note: source dapat direvert; schema remote additive tetap dipertahankan.
  Seluruh session dapat direvoke tanpa menghapus `app_users` maupun setting.
- Follow-up units: R1-002B2 HTTP exchange route dengan error mapping, lalu
  R1-002C Bearer authorizer untuk seluruh route bisnis.

### R1-002B2 — HTTP Mini App session exchange

- Status: VERIFIED
- Parent: R1-002B — One-time session exchange dan replay prevention
- Outcome: Mini App dapat menukar satu raw `initData` melalui endpoint versioned
  dan menerima bearer token dengan response/error contract yang aman.
- Goal trace: frontend membutuhkan satu pintu login Telegram sebelum seluruh
  request bisnis memakai session API internal.
- Acceptance criteria:
  - [x] `POST /v1/auth/telegram` hanya menerima JSON object dengan tepat satu
    `initData` string dan batas ukuran yang sama dengan verifier.
  - [x] Success mengembalikan token/user/expiry tanpa field internal serta memakai
    `Cache-Control: no-store` dan `Pragma: no-cache`.
  - [x] malformed JSON/body, invalid signature, expired/future data, replay, dan
    dependency failure mempunyai HTTP status + error code stabil yang berbeda.
  - [x] Error/response gagal tidak pernah mengecho raw `initData`, token candidate,
    stack, atau detail database.
  - [x] Route bersifat opt-in dalam `createApi` sehingga test/legacy composition
    tidak memperoleh authorizer palsu.
  - [x] Focused negative-path test, full API regression, typecheck, syntax, dan
    diff check lulus.
- Non-goal: membaca Authorization header, mengautentikasi route bisnis, admin role,
  allowlist, rate control, refresh/revoke endpoint, dan frontend.
- Dependencies: R1-001 dan R1-002B1.
- Risks/failure modes: token tercache proxy/browser, body besar menghabiskan
  resource, raw secret masuk error, parse error memakai format Fastify default,
  atau dependency error membocorkan query.
- Test plan: success; missing/extra/non-string/oversized body; malformed JSON;
  seluruh Telegram verifier code; replay; entropy/persistence failure; response
  header dan secret absence; regression penuh.
- Rollback/recovery: route/composition additive dapat direvert tanpa schema atau
  session existing; session yang sudah diterbitkan tetap mengikuti TTL/revoke.
- Expected touch points: auth route, `createApi` option, focused route test, ledger.
- Required evidence: test counts, payload/header assertions, diff, dan commit.
- Commit/diff: `fc018c3` (`feat: expose Mini App session exchange`).
- Acceptance evidence:
  - success response hanya membawa bearer token, expiry, dan public user identity;
  - seluruh response endpoint memakai `Cache-Control: no-store` dan
    `Pragma: no-cache`;
  - invalid request, terlalu besar, signature invalid, kedaluwarsa, future clock,
    replay, dan dependency failure dipetakan ke status/code publik yang stabil;
  - test memastikan raw `initData`, detail database, dan stack tidak muncul;
  - tanpa `telegramSessionIssuer`, endpoint tidak terdaftar dan menghasilkan 404.
- Commands/tests:
  - focused auth route: 5/5 pass;
  - full API: 71 pass, 0 fail, 2 integration PostgreSQL opt-in skip;
  - `npm run typecheck`, `npm run check`, dan `git diff --check`: pass.
- Result summary: HTTP exchange siap menjadi satu-satunya pintu penerbitan API
  session dari Telegram Mini App, tetapi belum mengautentikasi route bisnis.
- Remaining risk: response yang hilang setelah session tersimpan tetap menuntut
  user membuka ulang Mini App karena replay ditolak. Rate control dan Bearer
  authorizer sengaja dipisahkan ke unit berikutnya.
- Rollback note: route dan composition option bersifat additive; revert source
  tidak mengubah schema maupun session existing.
- Follow-up units: R1-002C Bearer authorizer untuk route bisnis, lalu R1-003 role
  admin yang terpisah dari identitas user.

### R1-002C — API-session Bearer authorizer

- Status: VERIFIED
- Parent: R1-002 — Canonical Mini App identity dan API session
- Outcome: seluruh route bisnis user dapat memakai bearer token hasil exchange
  sebagai `app_users.id`, tanpa bergantung pada Telegram runtime session.
- Goal trace: subscription dan setting harus melekat ke identitas Mini App user,
  sehingga pergantian akun Telegram worker/userbot tidak mengubah data bisnis.
- Acceptance criteria:
  - [x] Authorization hanya menerima satu bearer token dengan format session
    internal `jas_` yang tepat; malformed input ditolak sebelum query database.
  - [x] Token hanya di-hash SHA-256; raw token tidak diteruskan ke repository,
    response, atau error.
  - [x] Session aktif menghasilkan actor `app_users.id`; unknown, revoked, dan
    expired session menghasilkan kontrak 401 route existing.
  - [x] Dependency failure menghasilkan 503 `AUTH_TEMPORARILY_UNAVAILABLE`, bukan
    401 palsu atau error database mentah.
  - [x] `createApi` memakai repository session sebagai authorizer user production,
    sedangkan injected authorizer legacy/test tetap tersedia secara mutually
    exclusive.
  - [x] Focused test, full API regression, typecheck, syntax, dan diff check lulus.
- Non-goal: admin role, canary allowlist, refresh/logout/revoke HTTP endpoint, rate
  control, package enforcement, dan frontend.
- Dependencies: R1-002B1 dan R1-002B2.
- Risks/failure modes: token longgar diterima, raw token masuk log/error, revoked
  session lolos, outage DB disamarkan sebagai logout, atau dummy authorizer menang
  atas repository production.
- Test plan: valid token/hash/actor; malformed scheme/token tanpa DB call; unknown
  session; repository throw; createApi production precedence dan legacy mode.
- Rollback/recovery: authorizer dan composition additive; legacy/test path tetap
  tersedia tanpa mengubah schema/session existing.
- Expected touch points: auth authorizer, `createApi` composition/error mapping,
  focused tests, dan ledger.
- Required evidence: exact hash assertion, route status/body, test counts, diff,
  dan commit.
- Commit/diff: `ab742dd` (`feat: authorize API sessions on user routes`).
- Acceptance evidence:
  - parser hanya menerima `Bearer jas_` dengan payload base64url 43 karakter;
  - sembilan bentuk header malformed menghasilkan 401 tanpa satu pun query session;
  - repository menerima SHA-256 32-byte yang identik dengan hash expected dan tidak
    pernah menerima raw bearer token;
  - session aktif mengalirkan canonical user UUID ke kedua query broadcast setting;
  - lookup null (unknown/revoked/expired) menghasilkan 401 `USER_REQUIRED`;
  - repository failure menghasilkan 503 `AUTH_TEMPORARILY_UNAVAILABLE`, `no-store`,
    tanpa token, password marker, atau query detail;
  - type union `createApi` memisahkan `apiSessions` production dari injected
    `authorizeUser` legacy/test.
- Commands/tests:
  - focused authorizer/composition: 5/5 pass;
  - full API: 76 pass, 0 fail, 2 PostgreSQL integration opt-in skip;
  - `npm run typecheck`, `npm run check`, dan `git diff --check`: pass.
- Result summary: bearer session kini dapat mengautentikasi seluruh route bisnis
  user yang terdaftar melalui `createApi`; admin authorization tetap jalur terpisah.
- Remaining risk: belum ada HTTP revoke/logout, cleanup session kedaluwarsa, rate
  control endpoint login, maupun role admin. Production entrypoint lengkap juga
  belum dirangkai; unit ini baru menyediakan composition yang fail-closed.
- Rollback note: revert authorizer/composition mengembalikan injected authorizer;
  schema, `app_users`, dan session existing tidak berubah.
- Follow-up units: R1-003 role/admin authorization, lalu R2 canary allowlist maksimal
  15 user sebelum membuka integrasi fitur production.

### R1-003 — Database-backed admin authorization

- Status: VERIFIED
- Parent: R1 — Production API dan identity boundary
- Outcome: endpoint admin hanya dapat dipakai app user dengan session aktif dan
  grant admin aktif yang disimpan backend-only.
- Goal trace: owner/admin harus dapat mengatur paket, entitlement, worker, dan
  setting user tanpa memberi hak tersebut kepada semua user Mini App.
- Acceptance criteria:
  - [x] Tabel grant admin mengacu ke `app_users`, mempertahankan revocation state,
    memakai RLS deny-by-default, dan tidak dapat dibaca role browser.
  - [x] Tidak ada self-promotion HTTP; bootstrap/grant owner merupakan operasi
    database deployment terkontrol.
  - [x] Satu lookup terindeks memverifikasi hash bearer, session aktif, serta grant
    admin aktif dan mengembalikan canonical actor ID.
  - [x] User biasa, admin revoked, session unknown/revoked/expired, dan malformed
    header ditolak sebelum handler admin menjalankan repository bisnis.
  - [x] Dependency failure menghasilkan 503 aman tanpa token/query detail.
  - [x] Composition production mewajibkan user-session dan admin-access repository
    bersama; injected authorizer hanya tersedia pada mode legacy/test.
  - [x] SQL fixture, repository/route test, full regression, typecheck, dan remote
    Supabase proof lulus sebelum status VERIFIED.
- Non-goal: UI pengelolaan admin, multi-role/RBAC generik, canary allowlist, audit
  perubahan setting, subscription/payment, dan frontend.
- Dependencies: R1-002C.
- Risks/failure modes: session user biasa diterima sebagai admin, admin revoked
  tetap aktif, dua query per request menambah latency, browser membaca daftar admin,
  atau mode production masih menerima dummy admin authorizer.
- Test plan: fresh SQL grant/revoke/RLS; exact hash lookup; route admin allow/deny;
  malformed no-query; outage safe 503; composition typecheck; remote advisor.
- Rollback/recovery: source dapat kembali ke injected authorizer; tabel additive
  dipertahankan agar grant/revoke tidak hilang dan tidak memengaruhi data bisnis.
- Expected touch points: migration/SQL fixture, admin repository/authorizer,
  `createApi`, focused integration test, ledger.
- Required evidence: query count/hash, route response, SQL assertions, test counts,
  remote migration/proof/advisor, diff, dan commit.
- Commit/diff: `dcd642d` (`feat: enforce database-backed admin access`).
- Acceptance evidence:
  - `app_admins.user_id` adalah PK/FK ke `app_users`, menyimpan `granted_at` dan
    revocation boundary yang tervalidasi;
  - RLS aktif, privilege `anon`/`authenticated` dicabut, dan tidak ada policy atau
    endpoint self-promotion;
  - repository memakai satu join `api_sessions` + `app_admins`, token hash unique
    index dan admin PK, serta memfilter kedua revocation dan expiry session;
  - route proof: admin aktif 200 dan business repository dipanggil; lookup null 403
    tanpa business access; malformed header 403 tanpa lookup;
  - repository outage 503 `AUTH_TEMPORARILY_UNAVAILABLE` + `no-store`, tanpa raw
    token, password marker, atau query detail;
  - production composition mewajibkan pasangan `apiSessions` + `adminAccess`, dan
    melarang injected user/admin authorizer pada branch type yang sama.
- Commands/tests:
  - focused user/admin authorizer: 9/9 pass;
  - full API: 80 pass, 0 fail, 3 PostgreSQL integration opt-in skip;
  - ephemeral PostgreSQL fresh/upgrade/RLS proof: seluruh marker APP_USERS,
    API_SESSIONS, dan APP_ADMINS pass; API integration 3/3 dan engine 2/2 pass;
  - `npm run typecheck`, `npm run check`, dan `git diff --check`: pass.
- Remote evidence: Supabase migration `app_admins` berhasil dan tercatat. Remote
  transaction membuktikan session+grant resolve, revoke langsung menolak, RLS aktif,
  browser roles denied, token-hash index ada, dan rollback menyisakan 0 proof row.
  Security advisor hanya memberi INFO RLS-no-policy yang disengaja untuk tabel
  backend deny-all; performance advisor hanya unused-index INFO pada database kosong.
- Result summary: user biasa dan admin kini memakai bearer session yang sama, tetapi
  hak admin ditentukan grant database terpisah dan dapat dicabut tanpa logout user.
- Remaining risk: owner pertama belum di-bootstrap karena belum ada login production;
  grant harus dilakukan sesudah owner menghasilkan `app_users` row. Belum ada audit
  log role, UI role management, atau session revoke/logout endpoint.
- Rollback note: source authorizer dapat direvert, tetapi tabel/grant remote additive
  dipertahankan agar state admin tidak hilang; rollback proof tidak meninggalkan data.
- Follow-up units: R2 canary allowlist maksimal 15 user, termasuk bootstrap owner
  yang eksplisit dan admission gate sebelum fitur production dibuka.

### R2-001 — Canary admission registry dan hard cap

- Status: VERIFIED
- Parent: R2 — Canary maksimal 15 Mini App users
- Outcome: operator dapat pre-admit Telegram user ID, kapasitas aktif mustahil
  melewati 15, dan revoke admission langsung mencabut seluruh API session user.
- Goal trace: production dibuka bertahap untuk 1–2 user dan dinaikkan perlahan,
  tetapi tidak pernah melampaui 15 selama canary.
- Acceptance criteria:
  - [x] Registry backend-only menerima Telegram user ID sebelum first login dan
    menyimpan active slot/revocation state tanpa bergantung pada account session.
  - [x] Constraint database membatasi tepat 15 slot unik; concurrency atau direct
    write tidak dapat menciptakan user aktif ke-16.
  - [x] Operasi admission/revoke tunggal mempunyai status stabil, serialized, dan
    hanya dapat dieksekusi backend role.
  - [x] Revoke melepaskan slot dan atomically merevoke semua API session terkait;
    setting, entitlement, dan `app_users` tidak dihapus.
  - [x] Browser roles tidak dapat membaca registry atau menjalankan fungsi admission.
  - [x] Fresh/upgrade SQL fixture dan integration regression lulus.
- Non-goal: gate pada session exchange (R2-002), UI admin, admission lewat public
  HTTP, penghapusan user/setting, dan subscription publik.
- Dependencies: R1-003.
- Risks/failure modes: race menghasilkan user ke-16, revoke tidak mematikan bearer
  existing, direct write melewati limit, atau canary terikat ke session/account kerja.
- Test plan: admit 15; user ke-16 ditolak; revoke mencabut session dan melepas slot;
  slot dipakai ulang; browser privilege denied; rollback menyisakan nol fixture.
- Rollback/recovery: migration additive dipertahankan; belum dipakai login sampai
  R2-002 sehingga source dapat direvert tanpa memblokir user existing.
- Expected touch points: migration, SQL fixture/upgrade proof, migration runner,
  ledger.
- Required evidence: active count/slot uniqueness, revoke session proof, privilege,
  fresh/upgrade markers, remote proof, diff, dan commit.
- Commit/diff: `2272923` (`feat: enforce fifteen-user canary capacity`).
- Acceptance evidence:
  - registry memakai Telegram user ID langsung sehingga calon user dapat di-admit
    sebelum `app_users` atau Telegram account session dibuat;
  - active admission wajib memegang satu unique slot 1..15, sehingga schema sendiri
    menutup kemungkinan user aktif ke-16;
  - security-definer function diserialisasi advisory transaction lock dan hanya
    memberi status `ADMITTED`, `ALREADY_ADMITTED`, `LIMIT_REACHED`, `REVOKED`, atau
    `NOT_ADMITTED`;
  - service role hanya memperoleh SELECT table + EXECUTE function; browser role
    tidak memperoleh keduanya dan direct service-role mutation tidak tersedia;
  - revoke mengosongkan slot dan merevoke seluruh `api_sessions` melalui canonical
    `app_users.telegram_user_id`, tanpa menghapus user/data bisnis;
  - slot yang dilepas terbukti dapat dipakai calon berikutnya dan active count tetap 15.
- Commands/tests:
  - ephemeral PostgreSQL fresh/upgrade/RLS: seluruh APP_USERS, API_SESSIONS,
    APP_ADMINS, dan CANARY_ADMISSIONS marker pass;
  - API PostgreSQL integration 3/3 dan engine PostgreSQL regression 2/2 pass;
  - `git diff --check`: pass.
- Remote evidence: Supabase migration `canary_admissions` berhasil dan tercatat.
  Transaction proof memasukkan 15, menolak user ke-16, merevoke bearer session,
  memakai ulang slot 1, mempertahankan active count 15, dan rollback menyisakan
  0 row. RLS aktif serta `anon`/`authenticated` denied. Security advisor hanya INFO
  RLS-no-policy yang disengaja untuk backend deny-all table.
- Result summary: hard cap canary 15 kini dijamin database dan revoke admission
  langsung mematikan session API tanpa menyentuh setting/langganan user.
- Remaining risk: session exchange belum memeriksa registry, sehingga schema ini
  belum membatasi login sampai R2-002 diterapkan. Operator bootstrap/runbook belum
  ditutup sampai R2-003.
- Rollback note: table/function remote additive dipertahankan; karena belum di-wire
  ke exchange, revert source tidak mengubah perilaku login existing.
- Follow-up units: R2-002 atomic canary gate pada session exchange dan response
  `CANARY_ACCESS_REQUIRED`, lalu R2-003 owner bootstrap/runbook.

### R2-002 — Atomic canary gate pada session exchange

- Status: VERIFIED
- Parent: R2 — Canary maksimal 15 Mini App users
- Outcome: hanya Telegram user ID dengan admission aktif yang dapat memperoleh API
  session; penolakan tidak membuat `app_users` atau session parsial.
- Goal trace: registry R2-001 harus benar-benar menjadi pintu masuk production,
  bukan sekadar daftar yang tidak dipakai runtime.
- Acceptance criteria:
  - [x] Check admission terjadi di function transaksi sebelum identity upsert dan
    session insert, menutup TOCTOU serta partial user/session row.
  - [x] Repository/domain mengenali `ACCESS_DENIED` tanpa bergantung pada raw error
    PostgreSQL atau string query.
  - [x] HTTP exchange memetakan penolakan ke 403 `CANARY_ACCESS_REQUIRED`, no-store,
    tanpa membocorkan initData atau database detail.
  - [x] User admitted tetap menerima session normal; replay, expiry, entropy, dan
    dependency error contract existing tidak berubah.
  - [x] Revoke admission membuat bearer existing invalid dan exchange berikutnya
    kembali ditolak.
  - [x] Fresh/upgrade migration, focused tests, full regression, typecheck, dan
    remote proof lulus.
- Non-goal: admission HTTP/UI, owner bootstrap, subscription publik, dan menghapus
  registry setelah canary.
- Dependencies: R2-001.
- Risks/failure modes: gate hanya di aplikasi sehingga race lolos, denied login tetap
  membuat user row, denied status berubah menjadi 503, atau test identity memenuhi
  cap production.
- Test plan: denied no-row; admitted created; replay unchanged; revoke session;
  denied response safe; upgrade preserves session; remote rollback proof.
- Rollback/recovery: migration dapat diganti function versi pre-gate; registry dan
  session existing tetap dipertahankan.
- Expected touch points: canary gate migration/fixture, session repository/domain,
  HTTP mapping/tests, migration runner, ledger.
- Required evidence: zero denied rows, status/body/header, regression counts, remote
  transaction rollback, diff, dan commit.
- Commit/diff: `48d77d2` (`feat: gate API sessions by canary admission`).
- Acceptance evidence:
  - `issue_telegram_mini_app_session` memvalidasi request lalu memeriksa active
    admission sebelum memanggil identity upsert atau session insert;
  - denied result adalah typed `ACCESS_DENIED` dengan seluruh ID/expiry null, bukan
    PostgreSQL exception string;
  - repository meneruskan typed result, issuer mengubahnya menjadi domain error,
    dan HTTP mengembalikan 403 `CANARY_ACCESS_REQUIRED` + no-store;
  - denied fixture membuktikan nol `app_users` dan nol `api_sessions`; admitted user
    tetap menghasilkan `CREATED` dan replay contract existing tetap lulus;
  - revoke admission merevoke bearer existing dan exchange berikutnya kembali
    menghasilkan `ACCESS_DENIED`.
- Commands/tests:
  - focused issuer + auth HTTP: 10/10 pass;
  - full API: 81 pass, 0 fail, 3 PostgreSQL integration opt-in skip;
  - ephemeral PostgreSQL fresh/upgrade: seluruh identity/session/admin/canary marker
    pass, termasuk `CANARY_SESSION_GATE_NO_PARTIAL_ROWS_OK`;
  - API PostgreSQL integration 3/3 dan engine regression 2/2 pass;
  - `npm run typecheck`, `npm run check`, dan `git diff --check`: pass.
- Remote evidence: Supabase migration `canary_session_gate` berhasil dan tercatat.
  Remote transaction membuktikan denied no-row, admitted CREATED, revoke session,
  dan denied-after-revoke; rollback menyisakan 0 admission/user/session proof row.
- Result summary: registry canary kini menjadi atomic login gate production dan
  user di luar daftar memperoleh error yang jelas tanpa partial state.
- Remaining risk: belum ada owner/canary user nyata yang dimasukkan; jika API
  dideploy sebelum bootstrap R2-003, semua login akan benar-benar ditolak. Public
  subscription kelak memerlukan migration eksplisit untuk melepas gate canary.
- Rollback note: function dapat dikembalikan ke versi pre-gate; registry, user,
  settings, dan session existing tidak perlu dihapus.
- Follow-up units: R2-003 owner bootstrap + admission runbook, lalu production API
  composition/entrypoint sebelum fitur canary dijalankan.

### R2-003A — Canary/operator bootstrap tooling

- Status: VERIFIED
- Parent: R2 — Canary maksimal 15 Mini App users
- Outcome: operator dapat admit/revoke/list canary dan grant/revoke admin melalui
  CLI terverifikasi tanpa menyalin SQL atau mengekspos credential/session.
- Goal trace: owner dan 1–2 tester awal harus bisa dibootstrap repeatably sebelum
  API production dinyalakan, lalu admission dinaikkan perlahan hingga maksimal 15.
- Acceptance criteria:
  - [x] CLI hanya menerima Telegram numeric user ID canonical dan command eksplisit;
    database URL hanya dari environment dan tidak pernah dicetak.
  - [x] admit/revoke memakai function hard-cap R2-001; grant admin gagal jelas bila
    owner belum pernah login/memiliki `app_users` row.
  - [x] list hanya menampilkan operational admission/admin state, tanpa nama user,
    bearer, initData, Telegram account session, atau database detail.
  - [x] Semua failure eksternal dipetakan ke stable operator code dan exit non-zero,
    bukan raw PostgreSQL error.
  - [x] Runbook menetapkan urutan admit owner → first login → grant admin → admit
    tester 1–2, verifikasi, revoke, dan larangan melewati 15.
  - [x] Unit/integration test, regression, typecheck, dan diff check lulus.
- Non-goal: public/admin HTTP endpoint, dashboard UI, actual owner ID admission,
  production API deploy, dan subscription publik.
- Dependencies: R2-002.
- Risks/failure modes: admin digrant sebelum identity ada, CLI membocorkan DATABASE_URL,
  operator melewati hard cap via SQL, atau revoke canary menghapus setting.
- Test plan: command parsing; admit/list; grant-before-login; grant/revoke admin;
  revoke admission/session; sanitized failure; runbook command syntax.
- Rollback/recovery: CLI/runbook additive dapat direvert; database state hanya berubah
  saat operator menjalankan command eksplisit.
- Expected touch points: operator repository/service/CLI/tests, package script,
  API runbook/README, ledger.
- Required evidence: CLI outputs/statuses, integration state, no-secret assertions,
  test counts, diff, commit.
- Commit/diff: `7a1bb64` (`feat: add safe canary operator tooling`).
- Acceptance evidence:
  - parser hanya menerima `list`, `admit`, `revoke`, `grant-admin`, dan
    `revoke-admin` dengan Telegram ID integer 1..4503599627370495;
  - operator admission selalu memanggil `set_canary_admission`, sedangkan admin
    grant mencari canonical `app_users` dan mengembalikan `APP_USER_NOT_FOUND` bila
    first login belum terjadi;
  - list hanya membawa Telegram ID, slot/timestamps, `appUserReady`, dan
    `adminActive`; tidak ada nama, token, initData, account session, atau DB URL;
  - CLI membaca `DATABASE_URL` dari environment, memakai satu non-prepared pooler
    connection, dan menutupnya pada success/failure;
  - invalid input/missing URL/provider failure menjadi stable JSON code + non-zero
    exit; test membuktikan secret URL, password marker, dan raw query tidak keluar;
  - runbook menetapkan admit owner sebelum deploy, first login sebelum admin grant,
    hanya 1–2 tester awal, verifikasi list, serta revoke tanpa hapus data.
- Commands/tests:
  - focused operator unit: 3/3 pass;
  - PostgreSQL operator integration: 1/1 pass dalam API integration 4/4;
  - full API: 84 pass, 0 fail, 4 PostgreSQL integration opt-in skip;
  - engine PostgreSQL regression 2/2 dan seluruh migration marker pass;
  - `npm run typecheck`, `npm run check`, dan `git diff --check`: pass.
- Result summary: bootstrap canary/admin kini repeatable melalui CLI terverifikasi,
  bukan SQL manual, serta tidak memperluas public HTTP attack surface.
- Remaining risk: actual owner belum di-admit karena numeric Telegram user ID owner
  belum diberikan. Admin grant baru dapat dilakukan sesudah owner menyelesaikan
  first login terhadap API production.
- Rollback note: tooling/runbook additive; revert source tidak mengubah admission,
  admin grant, user, session, atau setting yang sudah ada.
- Follow-up units: R2-003B actual owner admission/login/admin grant, sesudah production
  API composition/entrypoint tersedia; lalu admit 1–2 tester pertama.

### R1-004A — Production API configuration boundary

- Status: VERIFIED
- Parent: R1-004 — Production API entrypoint
- Outcome: API production gagal sebelum membuka port bila secret, connection policy,
  auth lifetime, atau readiness policy tidak lengkap/invalid.
- Goal trace: canary tidak boleh dijalankan memakai implicit dev defaults atau config
  yang berbeda diam-diam antara local dan Railway.
- Acceptance criteria:
  - [x] DATABASE_URL dan Telegram bot token tervalidasi tetapi disimpan private dan
    tidak pernah muncul pada JSON/string/inspect/error.
  - [x] Seluruh angka pool, auth TTL/freshness, health, dan shutdown mempunyai range
    eksplisit; tidak ada angka kapasitas production yang default diam-diam.
  - [x] Prepared-statement policy wajib eksplisit untuk compatibility pooler.
  - [x] Host/PORT tervalidasi untuk Railway/local tanpa menerima whitespace/path.
  - [x] Error hanya mengandung stable code + nama field, tidak mengandung value.
  - [x] `.env.example`, unit test matrix, typecheck, syntax, dan diff check lulus.
- Non-goal: membuka koneksi DB/port, repository composition, logging, CORS, Railway
  deployment, owner bootstrap, dan frontend.
- Dependencies: R1-003 dan R2-002.
- Risks/failure modes: secret tercetak saat startup, zero/negative pool, readiness
  timeout melebihi interval, session TTL unsafe, atau prepared mode berubah diam-diam.
- Test plan: valid full config; missing/malformed secret; every numeric boundary;
  timeout relation; boolean; host/port; JSON/string/inspect redaction.
- Rollback/recovery: config module additive dan belum menjadi startup path.
- Expected touch points: production config/tests, `.env.example`, package check, ledger.
- Required evidence: invalid-field matrix, secret absence assertions, test counts,
  diff, commit.
- Commit/diff: `ffec4a5` (`feat: validate production API configuration`).
- Acceptance evidence:
  - DATABASE_URL wajib PostgreSQL URL dengan host/user/password/database; bot token
    wajib nonempty, bounded, dan tanpa whitespace;
  - kedua secret private-field hanya dapat diambil composition code dan tidak muncul
    dalam JSON, string, inspect, maupun config error;
  - 13 production numbers mempunyai explicit lower/upper bound: pool/connect/idle/
    lifetime/close, session TTL, initData freshness/skew, port, readiness interval/
    timeout/threshold, dan shutdown grace;
  - readiness timeout wajib tidak melebihi interval; prepared statements hanya
    menerima literal `true`/`false`; host menolak path/whitespace;
  - `.env.example` meninggalkan seluruh nilai operasional kosong agar deployment
    wajib mengisi angka hasil sizing, bukan menerima default diam-diam;
  - config error hanya `API_CONFIG_INVALID:<field>` dan JSON `{code, field}`.
- Commands/tests:
  - focused production config: 4/4 pass, termasuk 26 lower/upper invalid cases;
  - full API: 88 pass, 0 fail, 4 PostgreSQL integration opt-in skip;
  - `npm run typecheck`, `npm run check`, dan `git diff --check`: pass.
- Result summary: startup configuration boundary siap dipakai entrypoint dan aman
  untuk Railway/Supabase pooler tanpa implicit capacity values.
- Remaining risk: config belum membuka DB/port dan belum menjadi executable startup;
  nilai nyata Railway belum diisi/diukur pada API runtime.
- Rollback note: module/.env template additive dan belum mengubah runtime existing.
- Follow-up units: R1-004B production repository/auth composition, lalu R1-004C
  health/readiness/lifecycle/Railway start contract.

### R1-004B — Production API dependency composition

- Status: VERIFIED
- Parent: R1-004 — Production API entrypoint
- Outcome: satu composition path memasang seluruh repository PostgreSQL, Telegram
  Mini App verifier/session issuer, dan user/admin session authorizer ke API.
- Goal trace: production tidak boleh menjalankan fake/legacy authorizer atau lupa
  memasang route fitur yang sudah dibangun/test terpisah.
- Acceptance criteria:
  - [x] PostgreSQL client memakai seluruh database policy config termasuk explicit
    prepared-statement mode dan bounded pool.
  - [x] Package, entitlement, broadcast setting/operation, Auto Komen, userbot profile,
    worker, API session, dan admin access memakai Postgres repository production.
  - [x] Telegram verifier/issuer memakai secret + freshness/TTL config yang sama
    dengan HTTP exchange.
  - [x] Production composition hanya memakai `apiSessions` + `adminAccess`, tidak
    injected fake user/admin authorizer.
  - [x] PostgreSQL integration membuktikan public route, denied canary login,
    admitted login, bearer user route, dan bearer admin route dalam satu app.
  - [x] Full regression, typecheck, syntax, dan diff check lulus.
- Non-goal: listen/health/readiness/shutdown, logging, CORS, payment, owner nyata,
  Railway deploy, dan frontend.
- Dependencies: R1-004A dan R2-002.
- Risks/failure modes: satu repository tidak di-wire, auth config berbeda dari
  config validator, prepared statements salah untuk pooler, atau legacy authorizer
  masuk production.
- Test plan: ephemeral PostgreSQL compose; package 200; denied 403 no row; admit
  exchange 200; bearer user 200; DB admin grant then admin 200; cleanup.
- Rollback/recovery: composition additive dan belum menjadi executable startup.
- Expected touch points: production database/composition, integration test/runner,
  ledger.
- Required evidence: real route statuses/data ownership, repository path, test counts,
  diff, commit.
- Commit/diff: `9fc6313` (`feat: compose the production API stack`).
- Acceptance evidence:
  - database factory meneruskan max/connect/idle/lifetime/prepared config langsung
    ke `postgres` client; close timeout tetap menjadi lifecycle R1-004C;
  - composition memasang Postgres repository package, broadcast settings/operation,
    Auto Komen, entitlement, userbot profile, worker, API session, dan admin access;
  - verifier memakai bot token + initData age/skew config, issuer memakai session TTL
    config, dan createApi production branch hanya menerima session/admin repository;
  - real PostgreSQL app membuktikan public packages 200; unadmitted login 403 + no
    user row; admitted signed Telegram login 200; bearer broadcast settings 200;
    non-admin 403; DB admin grant lalu admin packages 200;
  - request nyata Auto Komen dan userbot 200, worker admin 200, serta missing
    broadcast operation 404 membuktikan optional production repositories terpasang;
  - integration pertama menemukan lima constructor parameter-properties yang gagal
    pada Node strip-only runtime; semuanya diubah menjadi standard fields dan proof
    import/start berikutnya lulus.
- Commands/tests:
  - ephemeral PostgreSQL API integration 5/5, termasuk composition E2E 1/1;
  - engine PostgreSQL regression 2/2 dan seluruh migration marker pass;
  - full API: 88 pass, 0 fail, 5 PostgreSQL integration opt-in skip;
  - `npm run typecheck`, expanded `npm run check`, dan `git diff --check`: pass.
- Result summary: seluruh backend API dan auth kini memiliki satu production-only
  wiring path yang telah dijalankan terhadap PostgreSQL nyata.
- Remaining risk: composition belum melakukan DB startup probe, listen HTTP,
  readiness transition, logging, atau graceful shutdown. `createProductionApiDatabase`
  baru akan dipanggil executable main pada R1-004C.
- Rollback note: composition additive; runtime syntax fixes semantik-equivalent dan
  aman dipertahankan walau composition direvert.
- Follow-up units: R1-004C executable lifecycle/health/Railway start contract, lalu
  R2-003B actual owner admit/login/admin grant.

### R1-004C — Production API executable lifecycle and Railway contract

- Status: VERIFIED
- Parent: R1-004 — Production API entrypoint
- Outcome: production API kini membuka koneksi PostgreSQL dan port HTTP melalui satu
  executable path, menyediakan liveness/readiness yang dependency-aware, serta
  melakukan drain idempotent saat Railway mengirim `SIGTERM`.
- Goal trace: owner/canary tidak boleh dijalankan pada composition-only app yang
  tidak memiliki startup probe, deployment gate, atau bounded shutdown.
- Acceptance criteria:
  - [x] Startup database probe harus lulus sebelum readiness menjadi 200; kegagalan
    membuka/probe DB, composition, listen, atau monitor menghasilkan stable code dan
    membersihkan resource yang sudah terbuka.
  - [x] `/health/live` hanya membuktikan proses HTTP hidup, sedangkan
    `/health/ready` merefleksikan startup, runtime DB failure threshold, recovery,
    dan draining tanpa mengekspos raw provider/config detail.
  - [x] Probe database mempunyai timeout dan cancellation; pool close idempotent dan
    memakai close timeout yang sudah divalidasi config.
  - [x] `SIGTERM`, `SIGINT`, uncaught exception, dan unhandled rejection masuk ke
    satu drain; monitor berhenti, HTTP berhenti menerima request, koneksi aktif
    dipaksa tutup setelah grace, lalu pool database ditutup.
  - [x] Docker entrypoint menjalankan Node langsung sebagai PID 1 dan deployment
    runbook menetapkan Dockerfile path, readiness healthcheck, restart policy, serta
    Railway draining time yang lebih panjang dari application grace.
  - [x] Unit lifecycle, full API regression, PostgreSQL/socket integration,
    migration regression, typecheck, syntax, dan diff check lulus.
- Non-goal: membuat Railway service, mengisi production variables, actual deploy,
  continuous monitoring, owner admission/login, frontend, dan payment.
- Dependencies: R1-004A dan R1-004B.
- Risks/failure modes: DB lambat membuat release gagal readiness, readiness tetap
  hijau setelah dependency gagal, signal dipotong package manager, request menggantung
  melewati grace, pool tidak tertutup, atau startup error membocorkan credential.
- Test plan: health state matrix; DB timeout/cancel/close; startup rollback; runtime
  threshold/recovery; idempotent/error-tolerant shutdown; forced HTTP close; repeated
  and fatal signals; real PostgreSQL + real socket; invalid executable config.
- Rollback/recovery: executable/Dockerfile additive; revert kembali ke composition-
  only tanpa mengubah schema, user, settings, admission, session, atau entitlement.
- Expected touch points: production database/application/health/process/main,
  Dockerfile, package scripts, Railway runbook, PostgreSQL runner, tests, ledger.
- Required evidence: stable health bodies/status, ordered cleanup, no raw error,
  real network response, closed port after stop, full regression counts, diff/commit.
- Commit/diff: `282a69d` (`feat: run production API lifecycle`).
- Acceptance evidence:
  - executable membaca satu `ProductionApiConfig`, membuka bounded PostgreSQL pool,
    menjalankan cancellable startup probe, memasang seluruh production composition,
    register health routes, lalu listen pada exact `API_HOST` + Railway `PORT`;
  - dua kegagalan DB berturut-turut pada threshold 2 mengubah readiness 200 menjadi
    503 `DATABASE_UNAVAILABLE`; probe sukses berikutnya memulihkan 200 tanpa restart;
  - stop berulang mengembalikan promise yang sama dan urutannya terbukti monitor →
    HTTP → database; cleanup failure dikumpulkan sebagai code tanpa menghentikan
    cleanup berikutnya atau menampilkan raw exception;
  - forced-close test membuktikan koneksi tersisa baru diputus setelah grace habis;
    process handler test membuktikan repeated signal hanya memulai satu drain dan
    fatal event menetapkan exit non-zero;
  - executable dengan environment kosong gagal tertutup sebagai JSON
    `API_CONFIG_INVALID` + field saja, tanpa value/stack/credential;
  - real PostgreSQL integration membuka socket HTTP, menerima 200 dari live, ready,
    dan package route, lalu `SIGTERM` summary bersih dan port tidak dapat diakses lagi.
- Commands/tests:
  - focused production lifecycle: 7/7 pass;
  - full API: 95 pass, 0 fail, 6 PostgreSQL integration opt-in skip;
  - ephemeral PostgreSQL API integration: 6/6 pass, termasuk composition E2E dan
    executable real-socket lifecycle; engine PostgreSQL regression: 2/2 pass;
  - seluruh fresh/upgrade migration marker app user/session/admin/canary pass;
  - `npm run typecheck`, `npm run check`, dan `git diff --check`: pass;
  - Docker image build tidak dapat dijalankan karena Docker/Colima daemon lokal tidak
    aktif; CLI tersedia tetapi socket daemon tidak ada. Ini dicatat sebagai external
    deployment proof yang harus ditutup pada deploy Railway pertama.
- Result summary: R1-004 kini mempunyai production-only executable yang fail closed,
  dependency-aware, signal-aware, dan telah dibuktikan pada PostgreSQL serta HTTP
  socket nyata; bukan lagi sekadar kumpulan route yang hanya dapat di-inject test.
- Remaining risk: image dan environment nyata Railway belum dibangun/dijalankan;
  healthcheck Railway hanya deploy gate, bukan continuous monitor. Nilai pool/probe/
  drain perlu dibuktikan lagi pada service Railway, dan draining time dashboard wajib
  melebihi `API_SHUTDOWN_GRACE_MS`.
- Rollback note: revert commit `282a69d`; tidak ada rollback database atau data user.
- Follow-up units: deploy contract verification di Railway, lalu R2-003B actual owner
  admission/first login/admin grant; setelah itu R3 account lifecycle.

### R1-004D — Railway production deployment verification

- Status: VERIFIED
- Parent: R1-004 — Production API entrypoint
- Outcome: API production aktif pada project Railway khusus Kertaaji, bersumber dari
  GitHub `main`, dibangun oleh Dockerfile API, lolos database-backed readiness, dan
  dapat diakses melalui TLS public domain dengan auth boundary tetap tertutup.
- Goal trace: lifecycle lokal R1-004C harus dibuktikan pada environment Railway dan
  Supabase nyata sebelum owner/canary bootstrap dilakukan.
- Acceptance criteria:
  - [x] Project/service production terpisah dari project benchmark dan Nexo.
  - [x] GitHub source, Docker build, healthcheck, replica, overlap, drain, dan runtime
    policy dikelola oleh Railway IaC modern, bukan Config-as-Code deprecated atau
    dashboard-only setting.
  - [x] DATABASE_URL dan bot token tetap hanya di Railway sebagai `preserve()`;
    plan/log/repository tidak memuat nilainya.
  - [x] Railway image build, startup PostgreSQL probe, dan `/health/ready` deploy gate
    lulus pada commit yang sama dengan executable terverifikasi.
  - [x] Public TLS live/ready/package route 200; user route tanpa session 401 dan
    admin route tanpa admin session 403.
  - [x] IaC plan setelah apply bersih dan dependency IaC tidak memiliki vulnerability.
- Non-goal: owner admission/login/admin grant, Telegram account connection, frontend,
  continuous monitoring, custom domain, payment, dan engine production deploy.
- Dependencies: R1-004C dan Railway/Supabase production credentials.
- Risks/failure modes: secret tercatat di source/log, Docker context tidak lengkap,
  health hanya menguji process bukan DB, deploy menimpa Nexo/benchmark, drain lebih
  pendek dari application grace, IaC drift, atau public domain melewati authorizer.
- Test plan: redacted variable presence; dry-run no destroy; apply; inspect deployment
  manifest/build/start logs; public HTTP live/ready/package; unauthenticated user/admin;
  second plan drift; dependency audit; repository secret scan.
- Rollback/recovery: Railway dapat rollback ke successful deployment digest; IaC
  source/health changes dapat di-plan/revert tanpa mengubah Supabase data atau secret.
- Expected touch points: `.railway/railway.ts`, pinned IaC package/lock, deployment
  runbook, Railway project/service state, ledger.
- Required evidence: plan/apply diff, image digest, deployment status/manifest,
  startup event, public status/body, auth denials, clean plan, zero secret match.
- Commit/diff: `da97c06` (`infra: codify Railway API deployment`).
- Acceptance evidence:
  - dedicated project `Auto Jaseb Kertaaji Production` memiliki satu service
    `kertaaji-api`; active benchmark dan Nexo project tidak disentuh;
  - initial IaC plan hanya menunjukkan GitHub source + `/health/ready`, 0 destroy;
    native policy plan berikutnya mengganti empat redundant platform variables dengan
    Docker/deploy fields eksplisit dan tidak menghapus secret/resource;
  - first release membuktikan image dapat dibangun tetapi fail closed pada quoted
    DATABASE_URL sebagai stable `API_CONFIG_INVALID:DATABASE_URL`; URL diparse ulang
    dari local env tanpa dicetak, lalu release berikutnya sukses;
  - successful deployment `36f3b054-f7a4-4b64-90c9-974b7084f340` memakai image
    digest `sha256:ce2d541f29a182ad9082998d5a1b54bbdbaa99388d49fc31918fbf6422f25b4d`;
  - manifest sukses menunjukkan Dockerfile `/apps/api/Dockerfile`, build V3, satu
    replica, healthcheck `/health/ready` timeout 300s, overlap 5s, drain 35s,
    runtime V2, restart `ON_FAILURE`, dan application tidak sleep;
  - watch paths membatasi GitHub auto-deploy pada Docker input API: `.dockerignore`,
    API Dockerfile, dependency manifests, `apps/api/src/**`, dan
    `packages/telegram-contract/**`; frontend, test, runbook, env example, dan ledger
    tidak membakar build API yang tidak relevan;
  - deploy log hanya menunjukkan `API_READINESS_CHANGED ready=true` dan
    `API_APPLICATION_STARTED host=0.0.0.0 port=8080`, tanpa credential/error;
  - public domain `https://kertaaji-api-production.up.railway.app` mengembalikan
    HTTP/2 200 untuk live, ready RUNNING, dan empty package catalog; broadcast route
    tanpa bearer menghasilkan 401 `USER_REQUIRED`, admin package route menghasilkan
    403 `ADMIN_REQUIRED`.
- Commands/tests:
  - `railway config plan --verbose` setelah apply: already up to date;
  - Railway build: `npm ci --omit=dev`, 0 vulnerability, image export/push pass;
  - public HTTP: live 200, ready 200, packages 200, user unauthenticated 401,
    admin unauthenticated 403;
  - pinned `railway@3.11.0`: `npm audit --omit=dev` found 0 vulnerabilities;
  - secret scan hanya menemukan `TELEGRAM_BOT_TOKEN: preserve()`, tidak ada URL,
    token value, session, atau password di `.railway` tracked files;
  - `git diff --check`: pass.
- Result summary: production API kini benar-benar aktif di Railway dengan Supabase
  dependency readiness dan reproducible project-level IaC; kegagalan config pertama
  juga membuktikan fail-closed/error redaction berjalan pada platform nyata.
- Remaining risk: Railway healthcheck hanya deployment gate; continuous monitoring
  masih R10. Belum ada owner/canary identity nyata, package publik memang masih kosong,
  dan engine Telegram belum dideploy sebagai runtime production.
- Rollback note: rollback service ke deployment sukses di atas atau revert/apply
  `da97c06`; tidak ada database migration/data rollback.
- Follow-up units: R2-003B admit owner → first Mini App login → grant admin, lalu R3
  account lifecycle. Owner numeric Telegram user ID diperlukan untuk memulai bootstrap.

### R2-003B — Actual owner bootstrap

- Status: IMPLEMENTED_UNVERIFIED
- Parent: R2-003 — Canary admission operations
- Outcome: owner nyata telah masuk slot canary pertama melalui operator database resmi;
  numeric Telegram user ID hanya disimpan pada `.env` lokal yang di-ignore Git.
- Acceptance evidence:
  - operator mengembalikan `ADMITTED` dengan slot `1`;
  - read-back menunjukkan tepat satu admission aktif dan target owner ditemukan;
  - `appUserReady: false` dan `adminActive: false` dipertahankan; sistem tidak membuat
    application user palsu atau memberi admin sebelum login Telegram Mini App pertama;
  - `.env.example` hanya memuat nama `CANARY_OWNER_TELEGRAM_USER_ID` tanpa value,
    sedangkan runbook memakai ekspansi env dan tidak menulis ID ke source/command docs.
- Commands/tests:
  - `git check-ignore -v apps/api/.env`: ignored oleh root `.gitignore`;
  - focused canary operator test: pass;
  - production operator `admit` + redacted `list`: admission aktif `1`, slot `1`,
    target present, app user belum ready, admin belum aktif;
  - `git diff --check`: pass.
- Result summary: boundary canary production sudah terbuka hanya untuk owner, tetapi
  admin bootstrap sengaja belum selesai sampai identitas Mini App tervalidasi backend.
- Remaining risk: belum ada successful owner Mini App login, bearer session nyata,
  atau admin route proof; `grant-admin` sekarang harus menghasilkan
  `APP_USER_NOT_FOUND` dan tidak boleh dibypass.
- Rollback note: `revoke` melepaskan slot dan session tanpa menghapus settings/data;
  file `.env` lokal dapat dihapus tanpa mengubah database admission.
- Follow-up units: owner membuka Mini App production sekali; verifikasi
  `appUserReady: true`; jalankan env-backed `grant-admin`; buktikan admin route.

### R3-001 — Telegram account lifecycle foundation

- Status: VERIFIED
- Outcome: proses authorization Telegram kini memiliki state server-only yang
  bounded, expiring, dan version-fenced; session final tetap terpisah dari Mini App
  identity, subscription, profile, serta setting. Logout/revocation menghancurkan
  ciphertext dan lease tanpa menghapus profile atau interval user.
- Goal trace: user dapat mengganti atau logout akun terhubung tanpa kehilangan
  langganan/setting, sementara expired subscription cukup menghentikan runtime dan
  tidak memaksa Telegram login ulang.
- Acceptance criteria:
  - [x] Hanya satu auth flow aktif per canonical Mini App user; TTL 60–900 detik.
  - [x] State transition memakai expected version dan stale request tidak menimpa
    state terbaru.
  - [x] Terminal flow selalu menghapus encrypted transient state; schema tidak
    menyediakan kolom OTP atau password 2FA.
  - [x] `CONNECTING`/`REVOKED` tidak boleh memiliki session; account runnable wajib
    memiliki ciphertext + key version sebagai pasangan.
  - [x] Explicit logout idempotent, menghapus ciphertext dan account lease, detach
    active profile, tetapi mempertahankan profile dan broadcast interval.
  - [x] Runtime Telegram revocation mengubah profile menjadi `NEEDS_REAUTH` dan stale
    runner kehilangan lease.
  - [x] Repository hanya mengembalikan metadata + `sessionPresent`; tidak pernah
    mengembalikan ciphertext, OTP, 2FA, atau provider object.
  - [x] Fresh/upgrade, concurrency, API/engine regression, Supabase advisor, remote
    integration, cleanup, dan Railway health mempunyai bukti nyata.
- Non-goal: request OTP ke Telegram, verifikasi code/2FA, final account provisioning,
  public HTTP lifecycle routes, dan UI. Semua itu milik R3-002/R3-003.
- Commits: `f82d083` (`feat: add Telegram account lifecycle foundation`) dan
  `c87c7bb` (`perf: cover completed Telegram account lookup`).
- Acceptance evidence:
  - local migration runner: fresh + legacy upgrade pass; historical `REVOKED` session
    dibersihkan, sedangkan `READY` session dan profile interval tetap ada;
  - PostgreSQL integration: concurrent begin menghasilkan tepat satu `CREATED` dan
    satu `ACTIVE_FLOW_EXISTS` untuk ID flow yang sama; stale version ditolak;
  - logout pertama `REVOKED`, logout kedua `ALREADY_REVOKED`; account tidak aktif,
    ciphertext/key/lease hilang, profile `DISCONNECTED`, interval tetap `41`;
  - Supabase preflight menunjukkan 28 migration lama lengkap, lifecycle table belum
    ada, `telegram_accounts=0`, dan `app_users=0`; tidak ada legacy data yang diubah;
  - production migration history kemudian berisi
    `telegram_account_lifecycle` dan `telegram_account_lifecycle_indexes`;
  - schema proof production: lifecycle table + RLS + active-flow index + empat
    function tersedia, `CONNECTING` valid, session/key nullable, row account/flow nol;
  - advisor menemukan missing covering index untuk `completed_account_id`; follow-up
    migration menutupnya dan advisor ulang tidak lagi melaporkan unindexed FK;
  - remote repository integration 1/1 pass dan cleanup proof kembali menunjukkan
    fixture app user/account/auth flow nol serta seluruh production account/flow nol;
  - API Railway setelah kedua migration tetap `alive` dan `ready/RUNNING`.
- Commands/tests:
  - `scripts/test-app-users-migration.sh`: API PostgreSQL 7/7, engine PostgreSQL 2/2,
    seluruh marker identity/session/admin/canary/lifecycle pass;
  - full API: 95 pass, 0 fail, 7 opt-in PostgreSQL skip;
  - full engine dengan izin local socket: 120 pass, 0 fail, 3 PostgreSQL/live skip;
  - production Supabase lifecycle repository: 1 pass, 0 fail, 0 skip;
  - `npm run typecheck`, native strip check, dan `git diff --check`: pass.
- Advisor disposition:
  - RLS-without-policy INFO untuk auth-flow table disengaja: anon/authenticated tidak
    memiliki table/function privileges; hanya backend service role yang diberi akses;
  - expiry/completed-account index `unused` INFO diabaikan sementara karena database
    dan auth-flow table masih kosong; index dibutuhkan oleh expiry scan dan FK cleanup.
- Rollback note: sebelum traffic authorization, rollback additive function/table/
  trigger/constraint dimungkinkan, tetapi jangan mengembalikan ciphertext dari row
  yang sudah berstatus `REVOKED`. Tidak ada production user/account data saat apply.
- Follow-up units: R3-002 Telegram connect transport + HTTP contract, lalu R3-003
  user list/switch/detach/logout route dan R3-004 engine handoff.

### R3-002 — Durable Telegram connect API

- Status: VERIFIED
- Outcome: user dengan entitlement Userbot aktif dapat memulai login Telegram,
  mengirim OTP, melanjutkan 2FA bila diperlukan, membatalkan flow, dan menyelesaikan
  koneksi akun melalui state PostgreSQL terenkripsi yang aman terhadap restart dan
  multi-replica. API tidak menyimpan OTP/password dan tidak memakai login map di RAM.
- Goal trace: langganan serta setting tetap dimiliki `app_users`; sesi Telegram yang
  dapat diganti hanya menjadi eksekutor, sehingga account switch/logout berikutnya
  tidak perlu memindahkan konfigurasi user.
- Acceptance criteria:
  - [x] Request-code, OTP, 2FA, cancel, verified `getMe`, dan final account activation
    mempunyai kontrak HTTP user-only, exact body, bounded body, dan `no-store`.
  - [x] Setiap OTP/2FA attempt diklaim atomically memakai status + expected version;
    submit bersamaan tidak dapat memakai transient state yang sama.
  - [x] Transient flow dan final session memakai AES-256-GCM dengan AAD domain berbeda
    serta terikat masing-masing ke auth-flow UUID dan account UUID.
  - [x] OTP/password tidak diserialisasi; terminal flow membersihkan transient state;
    ciphertext tidak pernah dikembalikan oleh API.
  - [x] OTP/2FA salah memulihkan flow dengan version baru; subscription expiry
    membatalkan flow sebelum provider call berikutnya.
  - [x] Teleproto temporary client selalu disconnect saat sukses maupun provider error;
    flood response menjadi error stabil tanpa internal sleep/interval produk.
  - [x] Verified provider identity, encrypted final session, active account pointer,
    dan flow completion disimpan atomically dengan global provider-account fencing.
  - [x] Production Supabase migration, remote repository integration, Railway secrets,
    deployment exact commit, health, dan unauthenticated route guard telah dibuktikan.
- Commits: `28353b3` (`feat: isolate Telegram auth flow encryption`), `834ab52`
  (`feat: fence Telegram authorization completion`), dan `ca5cc33`
  (`feat: complete durable Telegram authorization API`).
- Acceptance evidence:
  - production migration `telegram_account_authorization` terpasang; completion FK
    memakai cascade yang konsisten dengan invariant `SUCCEEDED`, dan function claim/
    completion hanya dapat dieksekusi backend service role;
  - production cleanup membuktikan fixture kembali nol untuk `app_users`, profile,
    account, dan auth flow;
  - lima runtime variable Telegram hadir dan lolos validasi bentuk tanpa nilainya
    dicetak; Railway IaC plan menunjukkan 0 add, 1 safe watch-path change, 0 destroy;
  - deployment Railway untuk exact commit `ca5cc33` berstatus `SUCCESS`;
  - production `/health/live` mengembalikan `alive`, `/health/ready` mengembalikan
    `ready/RUNNING`, dan connect endpoint tanpa bearer mengembalikan tepat
    `401 USER_REQUIRED` tanpa mengirim OTP.
- Commands/tests:
  - full API: 108 pass, 0 fail, 0 cancelled, 8 opt-in PostgreSQL skip;
  - focused authorization: 39 pass, 0 fail, 1 opt-in skip;
  - full migration runner: API PostgreSQL 8/8 dan engine PostgreSQL 2/2;
  - remote production lifecycle/authorization integration: 2/2 pass;
  - `npm run typecheck`, `npm run check`, dan `git diff --check`: pass.
- Remaining risk: belum dilakukan login Telegram real-user melalui endpoint production;
  tindakan itu sengaja menunggu UI/aksi eksplisit user agar sistem tidak mengirim OTP
  tanpa konteks. Shared session key yang sama wajib direferensikan oleh engine saat
  R3-004, bukan digenerate ulang pada service engine.
- Rollback note: sebelum ada account production, route dapat dilepas dan runtime
  variables dipertahankan; migration additive dapat dinonaktifkan tanpa menyentuh
  subscription/settings. Jangan merotasi/menghapus key version selama ciphertext dari
  versi tersebut masih ada.
- Follow-up units: R3-003 account list/switch/detach/logout API, kemudian R3-004
  encrypted-session handoff ke engine.

## Template penutupan unit

```markdown
### TASK-ID — Judul

- Final status: VERIFIED | IMPLEMENTED_UNVERIFIED | BLOCKED | REJECTED
- Commit/diff:
- Acceptance evidence:
- Commands/tests:
- Result summary:
- Remaining risk:
- Rollback note:
- Follow-up units:
```
