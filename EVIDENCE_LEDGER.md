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
- Remaining risk: this proves only public join side effect; send permissions, discussion comments, receive/catch-up, duplicate side effects, multi-session behavior, and resource soak remain unverified. Approval-required is intentionally out of the live product path and covered only by classification tests.
- Rollback note: accounts remain members of the controlled public target; no automatic leave was performed because leaving is another external side effect requiring a separate explicit action.
- Follow-up units: controlled text send and discussion comment with explicit checkpoints.

### SCOPE-001 — Approval-required join excluded from live product path

- Final status: VERIFIED.
- Commit/diff: recorded in the scope-adjustment commit for this change set.
- Decision: client flow targets public groups without admin approval. No approval-required target is required in `.env`, live benchmark assets, or the behavior sequence.
- Safety boundary: adapter error mapping for `JOIN_APPROVAL_REQUIRED` remains intact so an unexpected restricted target fails clearly without retry or hidden delay; only stub/classification tests cover it.
- Verification: `ENGINE_BENCHMARK_PROTOCOL.md`, `FOUNDATION_SPEC.md`, `LIVE_BENCHMARK_RUNBOOK.md`, and both resolve runners agree on the reduced scope; Node 27/27 and Telethon 22/22 regressions remain green.
- Follow-up units: controlled text send, discussion comment, receive/catch-up, and resource soak.

### DEV-001 — Backend package catalog domain

- Final status: VERIFIED (first production product-code unit).
- Commit/diff: recorded in the package-catalog development commit.
- Outcome: runtime-validated catalog for `JASEB_WORKER` and `USERBOT` packages, including price, duration, features, max LPM targets, max accounts, configurable interval range, display order, and active status.
- Acceptance evidence: invalid values produce field-level issues; zero price/minimum interval are allowed; interval bounds are enforced; package output and checkout entitlement snapshot are immutable; no frontend hardcode is involved.
- Commands/tests: `npm test` (4/4); `npm run check`; `npm run typecheck` with pinned TypeScript 5.9.2; `npm audit` (0 vulnerabilities); `git diff --check`.
- Remaining risk: no persistence, API transport, authorization, or database migration yet; those are separate units and are not implied complete by this domain module.
- Rollback note: remove `apps/api` package-catalog unit without affecting Telegram benchmark spike.
- Follow-up units: PostgreSQL schema/migration for packages and entitlement snapshots, then API contract/authorization.

### DEV-002 — Core broadcast and auto-comment workflow contract

- Final status: VERIFIED (deterministic planner; no live Telegram side effect).
- Commit/diff: recorded in the core-workflow development commit.
- Outcome: broadcast fan-out creates one ordered idempotent send command per target for both worker and userbot modes; regex-triggered MF comment planning emits no command for no-match, one command for a match, and suppresses duplicate updates by stable rule/channel/post key.
- Acceptance evidence: duplicate targets, invalid payloads, invalid regex, missing discussion target, ownership fields, and idempotency keys have explicit outcomes; one target/event cannot silently create cross-account commands.
- Commands/tests: `npm test` in `apps/api` (9/9); `npm run check`; `npm run typecheck`; `git diff --check`.
- Remaining risk: this unit does not persist commands, execute Telegram side effects, or measure live queue/CPU/RSS. Arbitrary regex execution still requires a bounded/safe regex runtime decision before production exposure.
- Rollback note: remove `apps/api/src/workflows/core-workflows.ts` and its tests without affecting the package catalog or Telegram spike.
- Follow-up units: PostgreSQL outbox/idempotency schema, workflow executor with per-account serialization, then controlled multi-session workload benchmark.

### DEV-003 — Supabase PostgreSQL foundation migration

- Final status: VERIFIED (fresh migration and database-level ownership guards).
- Commit/diff: recorded in the Supabase schema commit.
- Outcome: Supabase migration defines package catalog, entitlement snapshots, encrypted Telegram account metadata, workflow operations, idempotent outbox commands, account leases/fencing, timestamps, indexes, and RLS read boundaries.
- Acceptance evidence: package and interval constraints, userbot feature requirement, sensitive payload-key checks, operation-account ownership trigger, command-operation account match trigger, and service-role-only session/lease tables are encoded in SQL.
- Commands/tests: ephemeral PostgreSQL 16 fresh apply with 6 tables; valid worker/userbot/operation/command inserts; expected ownership violations rejected; `git diff --check`.
- Remaining risk: Supabase CLI is not installed locally; migration has not yet been applied to the client's Supabase project. RLS behavior with real Supabase JWT claims and backup/restore remain release gates.
- Rollback note: apply a forward corrective migration or restore the Supabase backup; do not edit an already-applied migration in place.
- Follow-up units: Supabase project connection/preview migration, then API repository for package CRUD and outbox transaction.

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
