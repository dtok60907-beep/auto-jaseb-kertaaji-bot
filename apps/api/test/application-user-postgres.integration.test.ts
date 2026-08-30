import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";

import type { TelegramMiniAppIdentity } from "../src/auth/telegram-mini-app.ts";
import { PostgresApplicationUserRepository } from "../src/identity/postgres-repository.ts";

const databaseUrl = process.env.API_DATABASE_URL?.trim();
const telegramUserId = "900000002";

function identity(authDateSeconds: number, firstName: string): TelegramMiniAppIdentity {
  return Object.freeze({
    telegramUserId,
    authDateSeconds,
    queryId: `query-${authDateSeconds}`,
    firstName,
    lastName: null,
    username: null,
    languageCode: "id",
    isPremium: false,
    allowsWriteToPm: false,
  });
}

test("concurrent first login resolves one UUID and preserves the newest profile", { skip: !databaseUrl }, async () => {
  const sql = postgres(databaseUrl!, { max: 4 });
  const repository = new PostgresApplicationUserRepository(sql);
  try {
    await sql`delete from public.app_users where telegram_user_id = ${telegramUserId}::bigint`;
    const [older, newer] = await Promise.all([
      repository.resolve(identity(1_800_000_000, "Older")),
      repository.resolve(identity(1_800_000_001, "Newer")),
    ]);
    assert.equal(older.id, newer.id);

    const rows = await sql<{ id: string; first_name: string; count: number }[]>`
      select min(id::text) as id, min(first_name) as first_name, count(*)::integer as count
        from public.app_users
       where telegram_user_id = ${telegramUserId}::bigint
    `;
    assert.deepEqual(rows[0], { id: older.id, first_name: "Newer", count: 1 });
  } finally {
    await sql`delete from public.app_users where telegram_user_id = ${telegramUserId}::bigint`;
    await sql.end({ timeout: 5 });
  }
});
