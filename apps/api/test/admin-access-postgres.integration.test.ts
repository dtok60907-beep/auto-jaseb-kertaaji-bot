import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";

import { PostgresAdminAccessRepository } from "../src/auth/postgres-admin-access-repository.ts";
import { hashApiSessionToken } from "../src/auth/telegram-session-issuer.ts";

const databaseUrl = process.env.API_DATABASE_URL?.trim();
const telegramUserId = "900000011";
const tokenHash = hashApiSessionToken(`jas_${"C".repeat(43)}`);
const initDataHash = hashApiSessionToken("admin-access-init-data-proof");

test("single admin lookup obeys grant, admin revocation, session revocation, and expiry", { skip: !databaseUrl }, async () => {
  const sql = postgres(databaseUrl!, { max: 2 });
  const repository = new PostgresAdminAccessRepository(sql);
  try {
    await sql`delete from public.app_users where telegram_user_id = ${telegramUserId}::bigint`;
    const users = await sql<{ id: string }[]>`
      insert into public.app_users (telegram_user_id, first_name, last_authenticated_at)
      values (${telegramUserId}::bigint, 'Admin Repository Proof', now())
      returning id::text
    `;
    const userId = users[0].id;
    await sql`
      insert into public.api_sessions (user_id, token_hash, init_data_hash, expires_at)
      values (${userId}::uuid, ${tokenHash}, ${initDataHash}, now() + interval '1 hour')
    `;
    await sql`insert into public.app_admins (user_id) values (${userId}::uuid)`;

    const active = await repository.findActiveByTokenHash(tokenHash);
    assert.equal(active?.userId, userId);

    await sql`update public.app_admins set revoked_at = now() where user_id = ${userId}::uuid`;
    assert.equal(await repository.findActiveByTokenHash(tokenHash), null);

    await sql`update public.app_admins set revoked_at = null where user_id = ${userId}::uuid`;
    await sql`update public.api_sessions set revoked_at = now() where user_id = ${userId}::uuid`;
    assert.equal(await repository.findActiveByTokenHash(tokenHash), null);

    await sql`
      update public.api_sessions
         set revoked_at = null,
             created_at = now() - interval '1 hour',
             expires_at = now() - interval '1 second'
       where user_id = ${userId}::uuid
    `;
    assert.equal(await repository.findActiveByTokenHash(tokenHash), null);
  } finally {
    await sql`delete from public.app_users where telegram_user_id = ${telegramUserId}::bigint`;
    await sql.end({ timeout: 5 });
  }
});
