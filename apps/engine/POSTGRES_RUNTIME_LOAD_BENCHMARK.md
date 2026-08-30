# F5.7b PostgreSQL runtime load benchmark

This harness measures the production account-lease and broadcast-outbox repository
path against PostgreSQL while Telegram delivery is replaced by a deterministic fake
adapter. It is a database-path baseline, not a Telegram or Railway capacity result.

Each synthetic account owns one Jaseb worker, one entitlement, one operation, one
target, and one command. This mirrors the production ownership constraints instead
of weakening them for the benchmark. Every fixture is isolated and deleted after its
sample.

## Hard gates

Every measured sample must prove:

- completion before the explicit execution timeout;
- zero execution errors and all runner results `SUCCEEDED`;
- exactly one fake-provider call per command and zero duplicate side effects;
- command, operation, and target aggregates all reach `SUCCEEDED`;
- every acquired account lease is released and no active fixture lease remains;
- fixture cleanup succeeds.

A failed hard gate exits `1`. Invalid configuration or an unexpected runtime failure
exits `2` with only a stable error label; the database URL and raw provider errors are
never written to JSONL.

## Connection

Set the ignored `apps/engine/.env` value documented in
`POSTGRES_INTEGRATION_TEST.md`. Use the same Supabase direct/session-pooler mode
planned for Railway, not the transaction pooler.

## Reproducible run

Run from a clean Git commit. No workload setting has a hidden default:

```bash
mkdir -p benchmark-results/raw
npm run --silent benchmark:postgres -- \
  --cases 1:1,10:1,10:5,25:5,50:10 \
  --samples 3 \
  --warmup 1 \
  --db-max-connections 12 \
  --db-connect-timeout-seconds 15 \
  --provider-latency-ms 0 \
  --monitor-interval-ms 5 \
  --timeout-ms 60000 \
  --account-lease-seconds 60 \
  --command-lease-seconds 60 \
  --commit COMMIT_SHA \
  --output benchmark-results/raw/f5.7b-postgres-runtime.jsonl
```

The harness creates the output with no-overwrite semantics only after the complete run;
stdout contains a small completion record rather than raw JSONL. Warm-up assertions
are still hard gates but warm-up metrics are excluded. Fixture setup, executor
duration, and cleanup duration are recorded separately so WAN/cold-pool cost is
visible rather than hidden.

Generate a summary from the repository root:

```bash
node spikes/telegram-engine/src/cli.mjs \
  apps/engine/benchmark-results/raw/f5.7b-postgres-runtime.jsonl \
  > apps/engine/benchmark-results/f5.7b-postgres-runtime-summary.json
```

Before and after the run, verify the controlled project has no unexpected fixture
rows. A passed local-to-Supabase result establishes repository correctness and a WAN
baseline only. Railway sizing remains blocked until the same commit is measured from
Railway, and Telegram capacity remains blocked until F5.7c controlled sessions/soak.
