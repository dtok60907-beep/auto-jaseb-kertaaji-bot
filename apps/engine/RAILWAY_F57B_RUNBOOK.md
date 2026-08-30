# F5.7b-R Railway PostgreSQL benchmark

This is an isolated Railway service that runs the F5.7b production
lease/outbox/repository path with a fake Telegram provider. It must be deployed to
the dedicated benchmark project, never to a NEXO or product project.

The service starts HTTP immediately. Railway must health-check `/health/ready` with
a timeout long enough for the matrix; it becomes ready only after every benchmark
hard gate passes. `/health/live` only proves that the benchmark process is running.
`/benchmark/summary` returns metrics with no database URL, credential, session, or
provider error detail.

## Required variables

| Variable | Value for first Railway baseline |
|---|---|
| `DATABASE_URL` | Supabase session-pooler URL; never use transaction pooler |
| `F57B_COMMIT` | exact Git commit of the deployed harness |
| `F57B_CASES` | `1:1,10:1,10:5,25:5,50:10` |
| `F57B_SAMPLES` | `3` |
| `F57B_WARMUP` | `1` |
| `F57B_DATABASE_MAX_CONNECTIONS` | `12` |
| `F57B_DATABASE_CONNECT_TIMEOUT_SECONDS` | `15` |
| `F57B_PROVIDER_LATENCY_MS` | `0` |
| `F57B_MONITOR_INTERVAL_MS` | `5` |
| `F57B_TIMEOUT_MS` | `60000` |
| `F57B_ACCOUNT_LEASE_SECONDS` | `60` |
| `F57B_COMMAND_LEASE_SECONDS` | `60` |

Railway injects `PORT`. The service deliberately does not require Telegram API or
session-encryption variables, because this stage must not open a real Telegram
session.

## Service configuration

- Root directory: repository root (`/`)
- Dockerfile: `apps/engine/Dockerfile`
- Health path: `/health/ready`
- Health timeout: 900 seconds
- Sleep: disabled
- Restart policy: `NEVER`, so a failed run is inspected instead of silently repeated
- Watch paths: `apps/engine/**`, `packages/telegram-contract/**`, and
  `packages/telegram-session-crypto/**`

## Deployment and evidence

Deploy the clean commit with the Railway CLI to the dedicated project/service. Wait
for `/health/ready` to return 200, collect the structured completion log and the
safe `/benchmark/summary`, then query Supabase to confirm no fixture rows remain.

This evidence validates the selected Railway region/container path only. It does not
permit production sizing until F5.7c controlled Telegram sessions and soak complete.
