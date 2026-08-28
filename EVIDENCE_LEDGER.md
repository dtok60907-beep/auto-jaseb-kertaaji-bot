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
