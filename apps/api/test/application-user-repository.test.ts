import assert from "node:assert/strict";
import test from "node:test";
import type { Sql } from "postgres";

import type { TelegramMiniAppIdentity } from "../src/auth/telegram-mini-app.ts";
import { PostgresApplicationUserRepository } from "../src/identity/postgres-repository.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const identity: TelegramMiniAppIdentity = Object.freeze({
  telegramUserId: "4503599627370495",
  authDateSeconds: 1_800_000_000,
  queryId: "query-id",
  firstName: "Kertaaji",
  lastName: "Owner",
  username: "kertaaji_test",
  languageCode: "id",
  isPremium: true,
  allowsWriteToPm: true,
});

function fakeSql(result: readonly Readonly<{ id: string }>[] = [{ id: USER_ID }]) {
  const calls: unknown[][] = [];
  const sql = ((_strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push(values);
    return Promise.resolve(result);
  }) as unknown as Sql;
  return { sql, calls };
}

test("maps every verified identity field and returns a frozen canonical user", async () => {
  const fake = fakeSql();
  const repository = new PostgresApplicationUserRepository(fake.sql);
  const user = await repository.resolve(identity);

  assert.deepEqual(user, { id: USER_ID, telegramUserId: identity.telegramUserId });
  assert.equal(Object.isFrozen(user), true);
  assert.deepEqual(fake.calls, [[
    identity.telegramUserId,
    identity.firstName,
    identity.lastName,
    identity.username,
    identity.languageCode,
    identity.isPremium,
    identity.allowsWriteToPm,
    identity.authDateSeconds,
  ]]);
});

test("fails closed when PostgreSQL does not resolve an application user", async () => {
  const repository = new PostgresApplicationUserRepository(fakeSql([]).sql);
  await assert.rejects(repository.resolve(identity), /APPLICATION_USER_NOT_RESOLVED/);
});
