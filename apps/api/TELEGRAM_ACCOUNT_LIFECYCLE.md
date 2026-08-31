# Telegram account lifecycle

This contract keeps a Mini App user, subscription, settings, and Telegram runtime
session as separate concerns.

## Ownership boundaries

- `app_users.id` owns the subscription and every user-visible setting.
- `userbot_profiles` owns the active account pointer and Userbot broadcast interval.
- `telegram_accounts` owns replaceable Telegram identity/session material.
- Admin may inspect account metadata and help edit settings, but only the owning user
  may start authorization, submit OTP/2FA, switch, detach, or log out an account.
- Telegram session bytes and transient authorization state are server-only and never
  returned by an API view.

## Authorization flow

`telegram_account_auth_flows` permits one active flow per canonical Mini App user.
The active states are `CREATED`, `CODE_REQUIRED`, `PASSWORD_REQUIRED`, and
`VERIFYING`; terminal states are `SUCCEEDED`, `FAILED`, `CANCELLED`, and `EXPIRED`.

Every mutation uses an expected version. A stale request receives a conflict instead
of overwriting newer OTP/2FA progress. Active flows expire after 60–900 seconds.
Terminal transitions clear the encrypted transient state. OTP codes and 2FA
passwords are request-only values and must never be serialized into that state.

## Account actions

| Action | Runtime session | Profile/settings | Subscription |
| --- | --- | --- | --- |
| Detach | Retained encrypted at rest | Profile disconnected; settings retained | Unchanged |
| Switch | Old and new saved sessions retained | Active pointer changes atomically; settings reused | Unchanged |
| Explicit logout | Ciphertext destroyed and lease removed | Profile disconnected; settings retained | Unchanged |
| Telegram revocation | Ciphertext destroyed and lease removed | Profile becomes `NEEDS_REAUTH`; settings retained | Unchanged |
| Subscription expiry | Session is not loaded into engine RAM | Account/profile/settings retained | Entitlement gates both features off |

An expired subscription does not call Telegram logout. Ciphertext at rest consumes no
engine RAM, and retaining it lets a renewed user resume without unnecessary account
authorization. Explicit logout remains available when the user wants Telegram to
forget that connected session.

## Runtime fencing

Only `READY` accounts are discoverable. Logout/revocation removes the account lease,
so stale runners cannot claim new work or load the session again. Existing lease and
command fencing remain the authority for ambiguous in-flight Telegram side effects.

## Next unit

R3-002 supplies the Telegram transport and HTTP routes for request-code, OTP, optional
2FA, verified `getMe`, encrypted session completion, and stable public errors. It must
use these database transitions instead of process-memory-only login state.
