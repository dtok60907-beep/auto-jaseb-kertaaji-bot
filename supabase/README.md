# Supabase database

Migrations in this directory are the source of truth for the product PostgreSQL schema. Apply them with the Supabase CLI or dashboard migration workflow; application code must not create tables at runtime.

The initial migration contains:

- admin-configurable package catalog;
- immutable entitlement snapshot storage;
- encrypted Telegram account/session metadata;
- workflow operations and idempotent outbox commands;
- account leases with fencing tokens;
- broadcast target state and exclusive worker assignments;
- user-owned Jasa Sebar materials (`TEXT` or public-channel `FORWARD`) and Grup LPM settings;
- userbot-owned comment rules, incoming post dedupe, and one match per rule/post;
- explicit `SIDE_EFFECT_UNCERTAIN` state for ambiguous Telegram outcomes;
- RLS policies for user-visible reads, with writes reserved for the server/service role.

`telegram_accounts` and `account_leases` intentionally have no client-facing policies. The API/worker uses the Supabase service role after its own authorization checks.

SQL fixtures under `supabase/tests/` are migration verification artifacts. They run
against an ephemeral PostgreSQL bootstrap that supplies Supabase's `auth.users`,
`auth.uid()`, and `authenticated` role; they do not connect to a Supabase project.
