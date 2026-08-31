# Jaseb Client API

Production backend foundation for the client-specific Jaseb/Userbot system.

The first domain unit is the package catalog. Package benefits are validated at runtime and copied into an immutable entitlement snapshot at checkout. No package rule is hardcoded in a frontend or Telegram worker.

The broadcast workflow contract covers fan-out only. Auto Komen Menfess has a separate Divisi/review contract: approval is the default, Auto Send is optional, and no comment command may exist before a Tepat decision for an approval-required candidate.

The HTTP composition exposes package catalog routes and user-owned Jasa Sebar setting routes. `GET /v1/broadcast/settings` returns the actor's materials and Grup LPM targets; CRUD routes under `/v1/broadcast/materials` and `/v1/broadcast/lpm-targets` accept manual wording or a public-channel forward link. The production Telegram identity adapter is intentionally injected and will be connected in the identity unit.

Run the unit tests from this directory:

```bash
npm test
npm run check
```

Production starts through `npm start` or the API Dockerfile. Deployment settings,
health semantics, and Railway drain requirements are documented in
[`RAILWAY_DEPLOYMENT.md`](./RAILWAY_DEPLOYMENT.md).

Controlled owner/tester admission is documented in
[`CANARY_BOOTSTRAP_RUNBOOK.md`](./CANARY_BOOTSTRAP_RUNBOOK.md). The operator is a
deployment tool, not a public API or Mini App feature.
