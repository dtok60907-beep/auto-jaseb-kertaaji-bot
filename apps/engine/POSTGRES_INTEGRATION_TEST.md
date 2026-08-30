# F5.7b PostgreSQL integration gate

This gate executes the production PostgreSQL repositories against the migrated
Supabase project while Telegram delivery stays fake. It proves the real database
path for runtime discovery, commit-time wakeups, lease fencing, outbox claim,
completion aggregation, retry blocking, takeover, and fixture cleanup.

It is not a capacity result. F5.7b load measurements are eligible only after this
gate passes through the same connection mode that the Railway engine will use.

## Connection

Place one untracked value in `apps/engine/.env`:

```dotenv
F5_DATABASE_URL=postgresql://...
```

Use a Supabase direct connection or session pooler connection. Do not use the
transaction pooler: the runtime repository keeps a dedicated `LISTEN/NOTIFY`
subscription. Never commit the file or paste the database password into evidence.

Run from `apps/engine`:

```bash
npm run test:postgres
```

Missing configuration is a hard exit `2`; the dedicated gate must never report a
green result by silently skipping integration tests. Every fixture uses reserved
UUIDs and cleans itself after the assertions.
