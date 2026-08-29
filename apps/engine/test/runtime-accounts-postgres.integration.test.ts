import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";

import { PostgresBroadcastRuntimeAccountRepository } from "../src/runtime-accounts/postgres-repository.ts";
import { shardIndexForAccount } from "../src/runtime-sharding/shard.ts";

const databaseUrl = process.env.F5_DATABASE_URL?.trim();

const pause = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function waitUntil(predicate: () => boolean, timeoutMilliseconds = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate() && Date.now() < deadline) await pause(10);
  if (!predicate()) throw new Error("RUNTIME_WAKEUP_TIMEOUT");
}

test("PostgreSQL runtime discovery is shard-safe, fenced, and commit-woken", { skip: !databaseUrl }, async () => {
  const sql = postgres(databaseUrl!, { max: 2 });
  const repository = new PostgresBroadcastRuntimeAccountRepository(sql);
  const userId = "60606060-6060-6060-6060-606060606060";
  const accountId = "61616161-6161-6161-6161-616161616161";
  const operationId = "62626262-6262-6262-6262-626262626262";
  const targetId = "63636363-6363-6363-6363-636363636363";
  const commandId = "64646464-6464-6464-6464-646464646464";
  const leaseOwner = "65656565-6565-6565-6565-656565656565";
  const takeoverOwner = "66666666-6666-6666-6666-666666666666";
  const cleanup = () => sql.begin(async (transaction) => {
    await transaction`delete from public.workflow_operations where user_id = ${userId}::uuid`;
    await transaction`delete from auth.users where id = ${userId}::uuid`;
  });
  await cleanup();
  const wakeups: string[] = [];
  const subscription = await repository.subscribeWakeups((accountId) => wakeups.push(accountId));

  try {
    const parityIds = [
      "00000000-0000-0000-0000-000000000001",
      "00000000-0000-0000-0000-000000000002",
      "00000000-0000-0000-0000-000000000003",
      "61616161-6161-6161-6161-616161616161",
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
    ];
    const parityRows = await Promise.all(parityIds.map(async (accountId) => {
      const [row] = await sql<{ shard_index: number }[]>`
        select public.runtime_shard_index(${accountId}::uuid, 257) shard_index
      `;
      return { account_id: accountId, shard_index: row!.shard_index };
    }));
    assert.deepEqual(
      parityRows.map((row) => [row.account_id, row.shard_index]),
      parityIds.slice().sort().map((id) => [id, shardIndexForAccount(id, 257)]),
    );

    await sql.begin(async (transaction) => {
      await transaction`insert into auth.users (id) values (${userId}::uuid)`;
      await transaction`
        insert into public.entitlements (
          user_id, package_snapshot, status, starts_at, expires_at,
          max_lpm_groups, max_channel_targets
        ) values (
          ${userId}::uuid,
          ${transaction.json({ packageId: "f53-integration", packageType: "USERBOT", features: ["JASEB", "AUTO_COMMENT_MF"], maxTargetsPerMinute: 1, maxAccounts: 1, intervalMinSeconds: 0, intervalMaxSeconds: 3600 })},
          'ACTIVE', now() - interval '1 minute', now() + interval '1 day', 10, 10
        )
      `;
      await transaction`
        insert into public.telegram_accounts (
          id, owner_user_id, account_type, label, encrypted_session,
          encryption_key_version, status
        ) values (
          ${accountId}::uuid, ${userId}::uuid, 'USERBOT', 'F5.3 integration',
          decode('deadbeef', 'hex'), 9, 'READY'
        )
      `;
      await transaction`
        insert into public.userbot_profiles (
          user_id, active_account_id, status, broadcast_interval_seconds
        ) values (${userId}::uuid, ${accountId}::uuid, 'CONNECTED', 0)
      `;
      await transaction`
        insert into public.workflow_operations (
          id, user_id, account_id, operation_type, status, idempotency_key, payload
        ) values (
          ${operationId}::uuid, ${userId}::uuid, ${accountId}::uuid,
          'BROADCAST', 'READY', 'f53-integration-operation',
          ${transaction.json({ accountMode: "USERBOT", material: { kind: "TEXT", text: "promo" } })}
        )
      `;
      await transaction`
        insert into public.broadcast_targets (
          id, operation_id, telegram_target_ref, interval_seconds,
          sequence_number, preparation_status
        ) values (${targetId}::uuid, ${operationId}::uuid, '@f53_integration', 0, 1, 'READY')
      `;
      await transaction`
        insert into public.workflow_commands (
          id, operation_id, account_id, kind, target_id, idempotency_key,
          payload, broadcast_target_id
        ) values (
          ${commandId}::uuid, ${operationId}::uuid, ${accountId}::uuid,
          'SEND_TEXT', '@f53_integration', 'f53-integration-command',
          ${transaction.json({ material: { kind: "TEXT", text: "promo" } })},
          ${targetId}::uuid
        )
      `;
      await pause(50);
      assert.deepEqual(wakeups, [], "NOTIFY must not escape an uncommitted transaction");
    });

    await waitUntil(() => wakeups.includes(accountId));
    assert.equal(wakeups.filter((value) => value === accountId).length, 1, "duplicate wakeups in one transaction must coalesce");

    const wakeupCountBeforeRollback = wakeups.length;
    await assert.rejects(
      sql.begin(async (transaction) => {
        await transaction`
          update public.workflow_commands
             set available_at = available_at + interval '1 second'
           where id = ${commandId}::uuid
        `;
        throw new Error("INTENTIONAL_ROLLBACK");
      }),
      /INTENTIONAL_ROLLBACK/,
    );
    await pause(100);
    assert.equal(wakeups.length, wakeupCountBeforeRollback, "rolled-back work must not emit a wakeup");

    const shard = { shardCount: 3, shardIndex: shardIndexForAccount(accountId, 3) } as const;
    const due = await repository.listDue({ shard, limit: 10 });
    assert.deepEqual(due, [{
      accountId,
      accountType: "USERBOT",
      nextDueAt: due[0]?.nextDueAt,
      hasPreparationWork: false,
      hasDeliveryWork: true,
      requiresRecovery: false,
    }]);
    assert.equal("encryptedSession" in due[0]!, false);
    assert.equal(JSON.stringify(due).includes("deadbeef"), false);
    assert.equal((await repository.findNext({ shard }))?.accountId, accountId);

    await assert.rejects(
      repository.loadSession({ accountId, leaseOwner, fencingToken: 1n }),
      /ACCOUNT_LEASE_NOT_HELD/,
    );
    await sql`select * from public.acquire_account_lease(${accountId}::uuid, ${leaseOwner}::uuid, 120)`;
    const loaded = await repository.loadSession({ accountId, leaseOwner, fencingToken: 1n });
    assert.equal(loaded?.accountType, "USERBOT");
    assert.equal(loaded?.encryptionKeyVersion, 9);
    assert.equal(Buffer.from(loaded!.encryptedSession).toString("hex"), "deadbeef");

    assert.equal(await repository.recordResult({
      accountId,
      leaseOwner,
      fencingToken: 1n,
      result: { status: "FAILED_RETRYABLE", errorCode: "TELEGRAM_CONNECT_TIMEOUT", retryAfterSeconds: 45 },
    }), true);
    assert.deepEqual(await repository.listDue({ shard, limit: 10 }), []);
    const next = await repository.findNext({ shard });
    assert.equal(next?.accountId, accountId);
    assert.ok(Date.parse(next!.nextDueAt) > Date.now() + 35_000);
    assert.equal(await repository.loadSession({ accountId, leaseOwner, fencingToken: 1n }), null);
    const claimDuringRuntimeRetry = await sql`
      select * from public.claim_next_broadcast_command(
        ${accountId}::uuid, ${leaseOwner}::uuid, 1, 60
      )
    `;
    assert.equal(claimDuringRuntimeRetry.length, 0, "delivery claim must enforce runtime backoff independently");

    await sql`
      update public.account_leases set lease_until = now() - interval '1 second'
       where account_id = ${accountId}::uuid
    `;
    const [takeover] = await sql<{ result_status: string; fencing_token: string }[]>`
      select result_status, fencing_token::text
        from public.acquire_account_lease(${accountId}::uuid, ${takeoverOwner}::uuid, 120)
    `;
    assert.deepEqual(takeover, { result_status: "TAKEN_OVER", fencing_token: "2" });
    assert.equal(await repository.recordResult({
      accountId,
      leaseOwner,
      fencingToken: 1n,
      result: { status: "CONNECTED" },
    }), false);
    assert.equal(await repository.recordResult({
      accountId,
      leaseOwner: takeoverOwner,
      fencingToken: 2n,
      result: { status: "CONNECTED" },
    }), true);
    assert.equal((await repository.loadSession({ accountId, leaseOwner: takeoverOwner, fencingToken: 2n }))?.accountId, accountId);
  } finally {
    await cleanup();
    await subscription.close();
    await sql.end({ timeout: 5 });
  }
});
