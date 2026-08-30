import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";

import { PostgresCanaryOperatorRepository } from "../src/operations/postgres-canary-operator-repository.ts";

const databaseUrl = process.env.API_DATABASE_URL?.trim();
const telegramUserId = "900000505";

test("operator bootstraps admission then admin without exposing account/session material", { skip: !databaseUrl }, async () => {
  const sql = postgres(databaseUrl!, { max: 2 });
  const repository = new PostgresCanaryOperatorRepository(sql);
  try {
    await sql`delete from public.canary_admissions where telegram_user_id = ${telegramUserId}::bigint`;
    await sql`delete from public.app_users where telegram_user_id = ${telegramUserId}::bigint`;

    assert.deepEqual(await repository.setAdmission(telegramUserId, true), {
      status: "ADMITTED", telegramUserId, slot: 1,
    });
    assert.deepEqual(await repository.setAdmin(telegramUserId, true), {
      status: "APP_USER_NOT_FOUND", telegramUserId,
    });

    await sql`
      insert into public.app_users (telegram_user_id, first_name, last_authenticated_at)
      values (${telegramUserId}::bigint, 'Operator Proof', now())
    `;
    assert.deepEqual(await repository.setAdmin(telegramUserId, true), {
      status: "ADMIN_GRANTED", telegramUserId,
    });
    const admitted = (await repository.list()).find((row) => row.telegramUserId === telegramUserId);
    assert.deepEqual(admitted, {
      telegramUserId,
      slot: 1,
      admittedAt: admitted?.admittedAt,
      revokedAt: null,
      appUserReady: true,
      adminActive: true,
    });

    assert.deepEqual(await repository.setAdmin(telegramUserId, false), {
      status: "ADMIN_REVOKED", telegramUserId,
    });
    assert.deepEqual(await repository.setAdmission(telegramUserId, false), {
      status: "REVOKED", telegramUserId, slot: 1,
    });
    const final = (await repository.list()).find((row) => row.telegramUserId === telegramUserId);
    assert.equal(final?.slot, null);
    assert.equal(final?.appUserReady, true);
    assert.equal(final?.adminActive, false);
  } finally {
    await sql`delete from public.canary_admissions where telegram_user_id = ${telegramUserId}::bigint`;
    await sql`delete from public.app_users where telegram_user_id = ${telegramUserId}::bigint`;
    await sql.end({ timeout: 5 });
  }
});
