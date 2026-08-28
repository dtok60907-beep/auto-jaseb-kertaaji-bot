# Live Telegram Benchmark Runbook

Status: prerequisite for runtime selection
Scope: controlled Telegram test environment only

## Objective

Collect the real data required by `ENGINE_BENCHMARK_PROTOCOL.md` for Telethon and Teleproto. This runbook does not authorize production use, worker enrollment, customer messaging, or a payment flow.

## Safety boundary

- Use dedicated Telegram test accounts only. Never use client workers, user accounts, or any account with customer groups.
- Use controlled channels/groups owned by the operator.
- Put secrets only in `spikes/telegram-engine/.env`, copied from `.env.example`.
- Never paste API hash, OTP, 2FA password, StringSession, target invite link, or raw benchmark logs containing identifiers into chat or Git.
- Keep one independent session per candidate. Do not attach Telethon and Teleproto to the same saved session concurrently.
- Initial smoke only connects, checks authorization, and disconnects. Send/join/comment scenarios require an explicit controlled-target checkpoint.

## Required test assets

| Asset | Minimum | Why |
|---|---:|---|
| Telegram API ID/hash | 1 application | Both candidates require MTProto application credentials. |
| Dedicated user account | 2 accounts | One account/session per candidate prevents cross-library session collision. |
| Public target group | 1 | Resolve and public join scenario. |
| Approval-required target | 1 | `WAITING_APPROVAL` state scenario. |
| Channel with discussion group | 1 | Controlled comment/reply scenario. |
| Sender/target permissions | test-only | Forward/write failure and success scenarios. |
| Benchmark machine | 1 fixed machine | Ensures resource comparisons are meaningful. |

## Credential setup

1. Copy `spikes/telegram-engine/.env.example` to `spikes/telegram-engine/.env` locally.
2. Fill only dedicated test credentials.
3. Create the Telethon session using the Telethon test account and the Teleproto session using the Teleproto test account.
4. Confirm the two sessions represent different test accounts and are not currently attached to any other benchmark process.
5. Confirm Git ignores `.env` before any command runs:

```bash
git check-ignore -q spikes/telegram-engine/.env
```

## Phased execution

### Phase 1 — Safe connectivity

Run both smoke commands with the test values loaded into the environment. They must only perform connect → authorization check → disconnect.

```bash
set -a
. spikes/telegram-engine/.env
set +a

cd spikes/telegram-engine/adapters/telethon
TELEGRAM_TEST_SESSION="$TELETHON_TEST_SESSION" \
.venv/bin/python smoke.py

cd ../teleproto
TELEGRAM_TEST_SESSION="$TELEPROTO_TEST_SESSION" \
node smoke.mjs
```

Success criterion: both return JSON with `passed: true`; no message is sent. Failure is recorded as an assertion, not retried blindly.

### Phase 2 — Controlled behavior suite

Run the read-only target preflight before any scenario that can change Telegram state. It resolves each configured role and records only the role, entity type, latency, and assertion result. It must pass for all three controlled roles before join/send/comment tests are authorized.

```bash
cd spikes/telegram-engine/adapters/telethon
TELEGRAM_TEST_SESSION="$TELETHON_TEST_SESSION" \
.venv/bin/python behavior_resolve_targets.py > ../../results/raw/telethon-resolve-targets.jsonl

cd ../teleproto
TELEGRAM_TEST_SESSION="$TELEPROTO_TEST_SESSION" \
node behavior-resolve-targets.mjs > ../../results/raw/teleproto-resolve-targets.jsonl
```

The preflight is read-only: it does not join, send, comment, or modify membership. Summarize each JSONL file with the parent harness and stop if any hard assertion fails.

Run one scenario at a time in this order:

1. connect/reconnect;
2. receive new message;
3. catch-up after reconnect;
4. resolve and join public target;
5. approval-required target;
6. text send;
7. discussion comment;
8. forward;
9. FloodWait stub/controlled classification;
10. revoked/invalid session handling;
11. graceful shutdown while idle and while queue is non-empty;
12. crash/recovery test against durable job test harness.

Each scenario must emit JSONL into `results/raw/` and be summarized with the parent harness. A hard gate failure ends that candidate's run.

### Phase 3 — Resource and soak

After correctness passes, run the same workload at 1, 10, and 50 independent sessions. Record:

- RSS and CPU from one external monitor with the same sampling interval for both candidates;
- connect/reconnect latency;
- loop latency;
- event loss and duplicate side effect counters;
- reconnect/error counts;
- memory trend at 1 hour and 24 hours.

Do not compare memory from two different machines, container limits, network paths, or account types.

## Exit conditions

Immediately stop a candidate when any occurs:

- event loss > 0;
- duplicate send/side effect > 0;
- wrong target receives a message;
- session appears in log/result;
- session collision occurs;
- a test account receives Telegram restriction due to the test;
- process does not shut down/recover as expected;
- benchmark machine or network changes mid-run.

Preserve raw result, then investigate before retrying. Do not rerun a failed send scenario automatically.

## Runtime decision evidence

Runtime ADR may be written only after:

- both adapters passed the same controlled suite;
- raw JSONL and reproducible summary exist;
- hard gates are evaluated;
- resource data comes from the same machine;
- soak result is available;
- dependency/version status is captured;
- known limitations and exit strategy are documented.
