# Evidence Ledger

Ledger ini mencatat status berdasarkan bukti. Detail command output yang besar tetap berada di test artifact atau CI; ledger menyimpan referensinya.

## Status milestone

| ID | Milestone | Status | Evidence | Risiko/next gate |
|---|---|---|---|---|
| M00 | Audit NEXO | VERIFIED | `AUDIT_NEXO.md`; source-wide inspection; typecheck/build; dependency audit; migration simulation | Temuan audit wajib menjadi input desain baru |
| M01 | Foundation contract | VERIFIED | `FOUNDATION_SPEC.md`, `DELIVERY_GATES.md`, commit `8b1f2b1` | Keputusan produk bertanda belum diputus tidak boleh diasumsikan |
| M02 | Benchmark harness | VERIFIED | 5/5 Node tests lulus; hard gate event loss dan duplicate tersedia; commit `8b1f2b1` | Adapter belum ada; belum ada angka runtime |
| M03 | Project operating workflow | VERIFYING | `PROJECT_WORKFLOW.md` dan ledger ini | Wajib cek konsistensi, whitespace, test regression, lalu commit |
| M04 | Telegram runtime selection | NOT_STARTED | Belum ada | Telethon + Teleproto adapter, live test account, benchmark, soak, ADR |

## Unit aktif

### WF-001 — Tetapkan workflow development yang mengikat

- Status: VERIFYING
- Parent: M03
- Outcome: seluruh pekerjaan memiliki lifecycle, batas ukuran, gate, evidence, stop condition, dan reporting contract yang jelas.
- Goal trace: mencegah long-horizon completion illusion dan menjaga fokus pada sistem production client.
- Acceptance criteria:
  - [x] Hierarki dan state pekerjaan didefinisikan.
  - [x] Task contract dan ukuran unit didefinisikan.
  - [x] Siklus spec → design → test → implementation → verification → review tercatat.
  - [x] Gate khusus database, payment, Telegram, jobs, API, frontend, dan deployment tercatat.
  - [x] Stop condition dan pelaporan status tercatat.
  - [ ] Dokumen lolos whitespace/diff check.
  - [ ] Benchmark harness regression test tetap lulus.
  - [ ] Checkpoint Git dibuat.
- Non-goal: membuat adapter Telethon/Teleproto atau memilih runtime.
- Dependencies: `FOUNDATION_SPEC.md`, `DELIVERY_GATES.md`, `ENGINE_BENCHMARK_PROTOCOL.md`.
- Risks/failure modes: workflow terlalu generik, kontradiktif, atau tidak menghasilkan evidence nyata.
- Test plan: cross-reference manual; `git diff --check`; benchmark harness regression test.
- Rollback/recovery: revert commit workflow tanpa memengaruhi product code.
- Expected touch points: dua dokumen root.
- Required evidence: checks lulus dan commit reference.

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
