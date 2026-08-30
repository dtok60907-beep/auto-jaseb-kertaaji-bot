import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";

import type { TelegramMiniAppIdentity } from "../src/auth/telegram-mini-app.ts";
import { PostgresApiSessionRepository } from "../src/auth/postgres-api-session-repository.ts";
import {
  hashApiSessionToken,
  TelegramSessionExchangeError,
  TelegramSessionIssuer,
} from "../src/auth/telegram-session-issuer.ts";

const databaseUrl = process.env.API_DATABASE_URL?.trim();
const telegramUserId = "900000004";
const rawInitData = "auth_date=1800000000&user=database-proof&hash=signed-proof";
const identity: TelegramMiniAppIdentity = Object.freeze({
  telegramUserId,
  authDateSeconds: 1_800_000_000,
  queryId: "database-proof",
  firstName: "Database Proof",
  lastName: null,
  username: null,
  languageCode: "id",
  isPremium: false,
  allowsWriteToPm: false,
});

test("concurrent exchange consumes initData once and active lookup obeys revoke and expiry", { skip: !databaseUrl }, async () => {
  const sql = postgres(databaseUrl!, { max: 4 });
  const repository = new PostgresApiSessionRepository(sql);
  let entropyCounter = 0;
  const nowMilliseconds = Date.now();
  const issuer = new TelegramSessionIssuer({
    verifier: { verify: () => identity },
    sessions: repository,
    now: () => nowMilliseconds,
    entropy: () => Uint8Array.from({ length: 32 }, () => ++entropyCounter % 256),
  });
  try {
    await sql`delete from public.app_users where telegram_user_id = ${telegramUserId}::bigint`;
    const outcomes = await Promise.allSettled([
      issuer.exchange(rawInitData),
      issuer.exchange(rawInitData),
    ]);
    const fulfilled = outcomes.filter((outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<TelegramSessionIssuer["exchange"]>>> => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason instanceof TelegramSessionExchangeError, true);
    assert.equal(rejected[0].reason.code, "TELEGRAM_INIT_DATA_ALREADY_USED");

    const counts = await sql<{ users: number; sessions: number }[]>`
      select
        (select count(*)::integer from public.app_users where telegram_user_id = ${telegramUserId}::bigint) users,
        (select count(*)::integer from public.api_sessions session
          join public.app_users app_user on app_user.id = session.user_id
         where app_user.telegram_user_id = ${telegramUserId}::bigint) sessions
    `;
    assert.deepEqual(counts[0], { users: 1, sessions: 1 });

    const tokenHash = hashApiSessionToken(fulfilled[0].value.accessToken);
    const active = await repository.findActiveByTokenHash(tokenHash);
    assert.equal(active?.userId, fulfilled[0].value.userId);
    await sql`update public.api_sessions set revoked_at = now() where id = ${active!.sessionId}::uuid`;
    assert.equal(await repository.findActiveByTokenHash(tokenHash), null);

    await sql`
      update public.api_sessions
         set revoked_at = null,
             created_at = now() - interval '1 hour',
             expires_at = now() - interval '1 second'
       where id = ${active!.sessionId}::uuid
    `;
    assert.equal(await repository.findActiveByTokenHash(tokenHash), null);
  } finally {
    await sql`delete from public.app_users where telegram_user_id = ${telegramUserId}::bigint`;
    await sql.end({ timeout: 5 });
  }
});
