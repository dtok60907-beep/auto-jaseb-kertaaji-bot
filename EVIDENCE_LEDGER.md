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
