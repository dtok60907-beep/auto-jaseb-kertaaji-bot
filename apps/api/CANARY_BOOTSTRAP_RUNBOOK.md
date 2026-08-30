# Canary bootstrap runbook

This runbook admits the owner and only 1–2 initial testers. The database enforces
an absolute maximum of 15 active Telegram user IDs.

## Safety boundary

- Run the operator only from a trusted shell with the backend PostgreSQL session
  pooler URL in `DATABASE_URL`.
- Never print, commit, screenshot, or paste `DATABASE_URL`, bearer tokens, Telegram
  initData, or Telegram account sessions.
- Use the numeric Telegram user ID belonging to the person opening the Mini App.
  This is independent from any Telegram account connected later as a userbot.
- Do not mutate `canary_admissions` directly. The operator function owns slot
  allocation and session revocation.

## Owner bootstrap

From `apps/api`, load `DATABASE_URL` into the current shell without printing it.
Then admit the owner before starting the production API:

```bash
npm run canary:operator -- admit OWNER_TELEGRAM_USER_ID
npm run canary:operator -- list
```

Expected admission status is `ADMITTED` or `ALREADY_ADMITTED`, with a slot from 1
through 15. The list must show `appUserReady: false` until the first successful
Mini App login.

Deploy/start the API, open the Mini App once as the owner, then grant admin:

```bash
npm run canary:operator -- grant-admin OWNER_TELEGRAM_USER_ID
npm run canary:operator -- list
```

`ADMIN_GRANTED` and `adminActive: true` are required before using any admin route.
`APP_USER_NOT_FOUND` means the owner has not completed a successful Mini App login;
do not bypass this by inserting a fake application user.

## Initial testers

Admit only one or two known numeric user IDs, one command at a time:

```bash
npm run canary:operator -- admit TESTER_TELEGRAM_USER_ID
npm run canary:operator -- list
```

Increase admission only after the previous users have completed the agreed feature
checks. `LIMIT_REACHED` is final for the current state; revoke an intended user or
stop admitting users. Never edit slots manually.

## Revoke and recovery

Revoke canary access with:

```bash
npm run canary:operator -- revoke TELEGRAM_USER_ID
```

This releases the slot and revokes existing API sessions. It does not delete the
application user, settings, entitlement, or connected-account records. Re-admitting
the same Telegram user ID restores access with the existing business data.

Revoke only the admin grant while keeping canary access with:

```bash
npm run canary:operator -- revoke-admin TELEGRAM_USER_ID
```

After every change, run `list` and verify the exact target ID, slot, `appUserReady`,
and `adminActive` state. Remove `DATABASE_URL` from the shell when finished.
