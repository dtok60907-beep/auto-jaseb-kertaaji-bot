# F5.7a supervisor load benchmark

This harness measures the production F5.5 supervisor with a deterministic synthetic
repository and async runner. It isolates orchestration overhead and correctness. It
does not open PostgreSQL, decrypt sessions, connect Telegram, or prove production
capacity.

## Hard gates

Every measured sample must finish before its explicit timeout and have:

- zero missing account executions (`event_loss`);
- zero duplicate account executions (`duplicate_side_effect` proxy);
- zero runner failure and cleanup error;
- observed concurrency no higher than its case limit;
- all expected runs completed;
- supervisor stopped with no pending/in-flight account.

One failed hard gate makes the command exit `1`. Invalid input or an unexpected
harness failure exits `2` and prints only a stable error code to stderr.

## Inputs

There are no workload defaults. Every run must provide:

- one or more `accounts:concurrency` pairs through `--cases`;
- measured sample count and separate warm-up count;
- synthetic runner latency, monitor interval, and sample timeout;
- discovery batch and every supervisor retry/reconciliation interval;
- the Git commit containing the harness.

Example shape only—these values are an experiment matrix, not deployment settings:

```bash
mkdir -p benchmark-results/raw
npm run --silent benchmark:supervisor -- \
  --cases 1:1,10:2,50:5 \
  --samples 10 \
  --warmup 3 \
  --runner-latency-ms 10 \
  --monitor-interval-ms 1 \
  --timeout-ms 5000 \
  --discovery-batch-size 100 \
  --reconciliation-ms 10 \
  --subscription-retry-ms 1000 \
  --contended-retry-ms 1000 \
  --failed-retry-ms 1000 \
  --commit COMMIT_SHA \
  > benchmark-results/raw/f5.7a-supervisor.jsonl
```

`--silent` is mandatory when redirecting `npm run`; otherwise npm's command banner
contaminates stdout and the result is not valid JSONL. Raw artifacts stay ignored.

From the repository root, generate a reproducible summary with:

```bash
node spikes/telegram-engine/src/cli.mjs \
  apps/engine/benchmark-results/raw/f5.7a-supervisor.jsonl \
  > apps/engine/benchmark-results/f5.7a-supervisor-summary.json
```

The summary may be committed after checking that it contains no identifier or secret.
F5.7b must repeat measurement with PostgreSQL/production repositories. F5.7c must
measure controlled Telegram sessions and soak behavior before F5.7d selects capacity.
