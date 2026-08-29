# Jasa Sebar engine production runbook

This process currently runs the verified Jasa Sebar execution path only: shard
discovery, per-account fenced lease, target preparation, and Telegram-native
text/forward delivery. Auto Komen runtime and final capacity numbers are not part
of F5.6.

## Release prerequisites

1. Use Node.js 22 or newer and install the locked dependencies with `npm ci`.
2. Apply every migration in `supabase/migrations` in filename order. Do not edit a
   migration that has already reached an environment.
3. Use a dedicated PostgreSQL role for the engine with only the schema/function
   access required by the runtime repositories.
4. Use a Supabase direct connection on a network with IPv6, or Supavisor session
   mode on port 5432 for an IPv4-only persistent backend. Do not use transaction
   mode on port 6543: the engine's wake-up path uses session-level `LISTEN/NOTIFY`.
   See the [official Supabase connection guide](https://supabase.com/docs/guides/database/connecting-to-postgres).
5. Store `DATABASE_URL`, Telegram API credentials, and session encryption keys in
   the deployment secret manager. Never commit them or paste them into logs/chat.
6. Fill every field from `.env.example`. Capacity and timing values must come from
   F5.7 load/soak evidence for the selected server and Supabase plan.

`ENGINE_DATABASE_PREPARE_STATEMENTS=false` is the conservative setting for a
pooler. The value is mandatory so connection behavior cannot change silently.

## Start

Production platforms should inject environment variables and run:

```bash
npm run start:production
```

For a local controlled check only, Node can load an untracked file explicitly:

```bash
node --env-file=.env --experimental-strip-types src/production/main.ts
```

Startup order is config validation, database open/probe, repository composition,
shard supervisor start, health listener, readiness monitor, then process signal
handlers. A failure exits non-zero and logs only a stable error code/field.

## Health contract

- `GET /health/live` returns 200 while the Node process can serve HTTP. It does not
  claim PostgreSQL or Telegram delivery is healthy.
- `GET /health/ready` returns 200 only after startup gates pass. It returns 503
  while starting/stopping/failed, or after consecutive database probe failures
  reach `ENGINE_READINESS_FAILURE_THRESHOLD`.
- Each database probe is bounded by `ENGINE_READINESS_PROBE_TIMEOUT_MS`; the value
  must not exceed `ENGINE_READINESS_PROBE_INTERVAL_MS`.
- A successful later probe restores readiness without restarting the process.

The orchestrator should remove a replica from service when readiness is 503, but
must not restart it solely because readiness is temporarily down. Liveness is for
a wedged/dead process; alerting policy belongs to the deployment unit.

## Shutdown and failure

`SIGTERM` and `SIGINT` start one idempotent drain: readiness becomes false, the
monitor stops, the supervisor stops admitting work and waits for active account
runners, then PostgreSQL and health resources close. Fatal process events use the
same drain and set a non-zero exit code. Configure the platform termination grace
period longer than the measured worst-case drain time from F5.7.

Lifecycle logs contain stable codes and operational counters only. Routine wake-up
and successful account-run events are suppressed to keep the hot path lean. Treat any
`*_FAILED`, `*_INCOMPLETE`, sustained `DATABASE_UNAVAILABLE`, or non-zero exit as
an incident input; never add raw PostgreSQL/Telegram error objects to these logs.

## Rollback

F5.6 changes no database schema. Roll back the engine artifact to the previous
verified commit and keep database migrations in place. If startup fails, preserve
the stable lifecycle codes, shard index/count, and sanitized counters for diagnosis.
Do not rotate/delete session data as an automatic rollback action.
