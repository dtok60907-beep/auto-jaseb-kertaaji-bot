# ADR — Telegram runtime production candidate

Status: accepted for F3, conditional on remaining hard gates
Date: 29 August 2026

## Decision

Use Node.js 22 + Teleproto `1.228.5` as the production adapter candidate. Keep it
in a separate engine application; the HTTP API does not install or instantiate
MTProto clients.

## Evidence

- Both Telethon and Teleproto passed controlled connect, target resolution, and
  public join behavior.
- Ten-run connectivity benchmark on the same machine/network:
  - Teleproto median `477.07 ms`, p95 `1329.56 ms`, max `1766.15 ms`.
  - Telethon median `1335.40 ms`, p95 `3791.63 ms`, max `4274.85 ms`.
- Teleproto was about `2.8x` faster at median and `2.85x` faster at p95 for the
  measured connect workload.
- The rest of the product backend is TypeScript, so one runtime avoids a second
  language deployment and duplicate internal transport contract.

## Limits of the decision

Connectivity latency is not a memory or long-running throughput benchmark. The
candidate is rejected or reconsidered if native forward/comment correctness,
event-loss tests, multi-session resource measurements, or the 24-hour soak gate
fails. No claim about lower RAM is made until those measurements exist.
