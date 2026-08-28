# Jaseb Client API

Production backend foundation for the client-specific Jaseb/Userbot system.

The first domain unit is the package catalog. Package benefits are validated at runtime and copied into an immutable entitlement snapshot at checkout. No package rule is hardcoded in a frontend or Telegram worker.

The core workflow contract now covers the two primary operations: broadcast fan-out and regex-triggered MF comments. It produces idempotent side-effect commands, suppresses duplicate channel updates, and keeps per-account/target ownership in every command. Provider calls and durable persistence are deliberately separate follow-up units.

The HTTP composition now exposes package catalog routes. `GET /v1/packages` returns active packages. Admin-only routes create a package or publish a new immutable package version; the production auth adapter is intentionally injected and will be connected in the identity unit.

Run the unit tests from this directory:

```bash
npm test
npm run check
```
