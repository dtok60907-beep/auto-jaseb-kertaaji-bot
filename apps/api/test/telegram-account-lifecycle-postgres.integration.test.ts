import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";

import { PostgresTelegramAccountLifecycleRepository } from "../src/telegram-accounts/postgres-repository.ts";

const databaseUrl = process.env.API_DATABASE_URL;

test("account lifecycle serializes auth flows and destroys only session-bound state", { skip: !databaseUrl }, async () => {
  const sql = postgres(databaseUrl!, { max: 4, prepare: false });
  const repository = new PostgresTelegramAccountLifecycleRepository(sql);
  const telegramUserId = 9_000_011_060;
  let userId: string | null = null;
  try {
    const users = await sql<{ id: string }[]>`
      select public.upsert_telegram_mini_app_user(
        ${telegramUserId}::bigint, 'Repository Owner', null, null, 'id',
        false, false, now()
      )::text id
    `;
    userId = users[0]!.id;

    const [first, second] = await Promise.all([
      repository.beginAuthFlow(userId, 600),
      repository.beginAuthFlow(userId, 600),
    ]);
    assert.deepEqual(new Set([first.result, second.result]), new Set(["CREATED", "ACTIVE_FLOW_EXISTS"]));
    assert.equal(first.id, second.id);
    assert.equal(first.version, 1n);

    const encryptedState = Uint8Array.from([1, 2, 3, 4]);
    const transitioned = await repository.transitionAuthFlow({
      userId,
      authFlowId: first.id!,
      expectedVersion: 1n,
      nextStatus: "CODE_REQUIRED",
      encryptedState,
      encryptionKeyVersion: 1,
    });
    assert.equal(transitioned.result, "UPDATED");
    assert.equal(transitioned.status, "CODE_REQUIRED");
    assert.equal(transitioned.version, 2n);
    assert.deepEqual([...encryptedState], [1, 2, 3, 4]);

    const stale = await repository.transitionAuthFlow({
      userId,
      authFlowId: first.id!,
      expectedVersion: 1n,
      nextStatus: "VERIFYING",
      encryptedState: Uint8Array.from([5, 6, 7, 8]),
      encryptionKeyVersion: 1,
    });
    assert.equal(stale.result, "VERSION_CONFLICT");
    assert.equal(stale.version, 2n);

    const accountId = "41414141-4141-4141-8141-414141414141";
    await sql`
      insert into public.telegram_accounts (
        id, owner_user_id, account_type, label, provider_user_id,
        encrypted_session, encryption_key_version, status
      ) values (
        ${accountId}::uuid, ${userId}::uuid, 'USERBOT', 'Repository account',
        ${telegramUserId + 1}::bigint, ${Buffer.from([9, 8, 7])}, 1, 'READY'
      )
    `;
    await sql`
      insert into public.userbot_profiles (
        user_id, active_account_id, status, broadcast_interval_seconds
      ) values (${userId}::uuid, ${accountId}::uuid, 'CONNECTED', 41)
    `;
    await sql`
      insert into public.userbot_profile_accounts (profile_id, account_id, status)
      select id, ${accountId}::uuid, 'ATTACHED'
        from public.userbot_profiles where user_id = ${userId}::uuid
    `;

    const before = await repository.listOwnedAccounts(userId);
    assert.equal(before.length, 1);
    assert.equal(before[0]?.active, true);
    assert.equal(before[0]?.sessionPresent, true);
    assert.equal("encryptedSession" in before[0]!, false);

    assert.equal(await repository.revokeSession(userId, accountId), "REVOKED");
    assert.equal(await repository.revokeSession(userId, accountId), "ALREADY_REVOKED");
    const after = await repository.listOwnedAccounts(userId);
    assert.equal(after[0]?.status, "REVOKED");
    assert.equal(after[0]?.active, false);
    assert.equal(after[0]?.sessionPresent, false);

    const profiles = await sql<{ status: string; active_account_id: string | null; broadcast_interval_seconds: number }[]>`
      select status, active_account_id::text, broadcast_interval_seconds
        from public.userbot_profiles where user_id = ${userId}::uuid
    `;
    assert.deepEqual(profiles[0], {
      status: "DISCONNECTED",
      active_account_id: null,
      broadcast_interval_seconds: 41,
    });
  } finally {
    if (userId) {
      await sql`
        delete from public.userbot_profile_accounts
         where profile_id in (
           select id from public.userbot_profiles where user_id = ${userId}::uuid
         )
      `;
      await sql`delete from public.userbot_profiles where user_id = ${userId}::uuid`;
      await sql`delete from public.telegram_accounts where owner_user_id = ${userId}::uuid`;
      await sql`delete from public.app_users where id = ${userId}::uuid`;
    }
    await sql.end({ timeout: 5 });
  }
});
