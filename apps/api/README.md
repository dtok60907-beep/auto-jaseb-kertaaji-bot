# Jaseb Client API

Production backend foundation for the client-specific Jaseb/Userbot system.

The first domain unit is the package catalog. Package benefits are validated at runtime and copied into an immutable entitlement snapshot at checkout. No package rule is hardcoded in a frontend or Telegram worker.

Run the unit tests from this directory:

```bash
npm test
npm run check
```
