# F5.7c controlled Telegram soak

This service provisions only explicitly supplied test sessions, runs the real
production engine against one controlled Telegram group, records safe metrics,
and removes every database fixture before it can report a pass.

It belongs in the dedicated benchmark Railway project. Never attach these
variables to the production engine or the old F5.7b database-only service.

## Safety gates before a live run

- Use test Telegram accounts and a controlled target group.
- `F57C_SESSIONS_JSON` is a Railway secret and must never enter Git, logs, CLI
  arguments, artifacts, screenshots, or chat.
- The number of sessions must exactly equal `F57C_EXPECTED_ACCOUNTS`.
- `F57C_APPROVED_COMMAND_COUNT` must exactly match the validated workload.
- The exact Telegram delivery-multiset observer must be merged before claiming
  F5.7c complete. Provider receipt cardinality alone is not duplicate proof.
- Supabase must contain zero F5.7c accounts, operations, entitlements, and leases
  before and after each run.

## Railway service

- Build context: repository root (`/`)
- Dockerfile: `apps/engine/Dockerfile.telegram-soak`
- Health path: `/health/live` (the soak may run for 1 or 24 hours)
- Manual pass endpoint: `/health/ready`
- Safe result endpoint: `/benchmark/summary`
- Restart policy: `NEVER`
- Sleep: disabled
- Watch path after deployment: `.railway/manual-f57c-rerun` only

`/health/live` confirms that the reporter process is alive. It does not mean the
benchmark passed. `/health/ready` returns 200 only after provision, the soak hard
gates, engine shutdown, burst cleanup, and account teardown all pass.

## Required variables

Alongside every production engine variable listed in `.env.example`, configure:

- `F57C_COMMIT`
- `F57C_RUN_ID`
- `F57C_SOAK_MINUTES`
- `F57C_BURST_INTERVAL_SECONDS`
- `F57C_SEND_INTERVAL_SECONDS`
- `F57C_EXPECTED_ACCOUNTS`
- `F57C_APPROVED_COMMAND_COUNT`
- `F57C_TARGET_REF`
- `F57C_MONITOR_INTERVAL_MS`
- `F57C_HEALTH_TIMEOUT_MS`
- `F57C_DB_MAX_CONNECTIONS`
- `F57C_DB_CONNECT_TIMEOUT_SECONDS`
- `F57C_INTERRUPT_AT_MINUTES` (empty when disabled)
- `F57C_REVOKE_ACCOUNT_INDEX` and `F57C_REVOKE_AFTER_MINUTES` (both empty when disabled)
- `F57C_SESSIONS_JSON` (secret)

Without revocation, the approved count is:

```text
(ceil(duration_seconds / burst_interval_seconds) + 1) * account_count
```

The final `+1` is the post-soak health action for every surviving account. Use
the application validator for revocation runs because commands after the revoke
marker exclude the revoked account.

## Execution order

1. Confirm the deployed commit equals `F57C_COMMIT`.
2. Query Supabase and prove the fixture counts are zero.
3. Add the test sessions only through Railway secret variables.
4. Deploy once and observe `/health/live` plus structured logs.
5. Treat `/health/ready = 200` and `passed = true` as necessary but not sufficient
   until the Telegram delivery observer gate is present.
6. Save the safe summary and Railway resource metrics.
7. Query Supabase again and prove accounts, operations, entitlements, and leases
   are zero.
8. Remove the session variable and disable automatic redeploys.

Run 1 hour before 24 hours. Increase session cardinality only after the previous
cardinality passes with zero failed, uncertain, pending, in-flight, leaked lease,
or leaked fixture state.
