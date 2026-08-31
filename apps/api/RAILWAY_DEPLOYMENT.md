# Railway API deployment contract

This service must be created in the dedicated Railway project for the Kertaaji
system. It must not reuse an existing Nexo service.

## Build and deploy settings

- Repository: `dtok60907-beep/auto-jaseb-kertaaji-bot`
- Dockerfile path: `/apps/api/Dockerfile`
- Healthcheck path: `/health/ready`
- Healthcheck timeout: `300` seconds
- Restart policy: `ON_FAILURE`
- Start command: leave empty; the Dockerfile starts Node directly as PID 1.
- Draining time: greater than `API_SHUTDOWN_GRACE_MS / 1000`. For a 30 second
  application grace period, configure at least 35 seconds.

Railway injects `PORT`; the service must bind `API_HOST=0.0.0.0`. Every other
required variable is listed in `.env.example`. Secrets belong in Railway's
Variables screen and must never be committed.

The project-level desired state lives in `.railway/railway.ts`, including the
Dockerfile, healthcheck, restart, overlap, and draining policies. Apply it only after
reviewing `railway config plan`; `DATABASE_URL` and `TELEGRAM_BOT_TOKEN` use
`preserve()` so their values remain in Railway and never enter source control.

`/health/live` proves only that the HTTP process is alive. `/health/ready` returns
200 only after the startup database probe passes, and changes to 503 after the
configured number of consecutive runtime database-probe failures or during drain.

Railway's deployment healthcheck gates a new release but is not a continuous
production monitor. Continuous alerting remains an R10 observability unit.
