import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import test from "node:test";

import postgres from "postgres";

import { TelegramSessionKeyRing } from "../../../packages/telegram-session-crypto/src/index.ts";
import {
  provisionTelegramSoakAccounts,
  revokeTelegramSoakAccount,
  cleanupTelegramSoakRun,
  TelegramSoakProvisioningError,
} from "../src/benchmark/telegram-soak-provisioning.ts";
import { createPostgresTelegramSoakProvisioningStore } from "../src/benchmark/telegram-soak-provisioning-store.ts";

const databaseUrl = process.env.DATABASE_URL;

test("PostgreSQL soak provisioning is atomic, encrypted, unique, and revocable", { skip: !databaseUrl }, async () => {
  const sql = postgres(databaseUrl!, { max: 1, prepare: false });
  const runId = `repo-${Date.now().toString(36)}`;
  const providerBase = (BigInt(Date.now()) * 10_000n) + BigInt(randomInt(1_000, 9_999));
  const sessions = ["integration-session-one", "integration-session-two"];
  const keyRing = TelegramSessionKeyRing.fromHexKeys({ activeKeyVersion: 1, keys: { 1: "cd".repeat(32) } });
  const store = createPostgresTelegramSoakProvisioningStore(sql);
  let userIds: readonly string[] = [];
  let accountIds: readonly string[] = [];

  try {
    const result = await provisionTelegramSoakAccounts({
      runId,
      sessions,
      intervalSeconds: 0,
      verifier: { verify: async (session) => ({
        providerUserId: String(providerBase + BigInt(sessions.indexOf(session))),
      }) },
      store,
      keyRing,
    });
    userIds = result.accounts.map((account) => account.userId);
    accountIds = result.accounts.map((account) => account.accountId);

    const rows = await sql<{
      account_id: string;
      provider_user_id: string;
      encrypted_session: Uint8Array;
      encryption_key_version: number;
      assignment_status: string;
      interval_seconds: number;
    }[]>`
      select account.id::text as account_id,
             account.provider_user_id::text as provider_user_id,
             account.encrypted_session,
             account.encryption_key_version,
             assignment.status as assignment_status,
             setting.interval_seconds
        from public.telegram_accounts account
        join public.worker_account_settings setting on setting.worker_account_id = account.id
        join public.worker_assignments assignment on assignment.worker_account_id = account.id
       where account.id = any(${sql.array([...accountIds])}::uuid[])
       order by account.id
    `;
    assert.equal(rows.length, 2);
    for (const row of rows) {
      const sourceIndex = result.accounts.find((account) => account.accountId === row.account_id)!.accountIndex - 1;
      assert.equal(keyRing.decrypt(
        { accountId: row.account_id, accountType: "JASEB_WORKER" },
        { ciphertext: row.encrypted_session, keyVersion: row.encryption_key_version },
      ), sessions[sourceIndex]);
      assert.equal(row.assignment_status, "ACTIVE");
      assert.equal(row.interval_seconds, 0);
    }

    await assert.rejects(() => provisionTelegramSoakAccounts({
      runId: `${runId}-duplicate`,
      sessions: ["different-session-same-account"],
      intervalSeconds: 0,
      verifier: { verify: async () => ({ providerUserId: String(providerBase) }) },
      store,
      keyRing,
    }), (error: unknown) => error instanceof TelegramSoakProvisioningError && error.code === "PROVISIONING_PERSIST_FAILED");

    await revokeTelegramSoakAccount({
      runId,
      accountId: result.accounts[0]!.accountId,
      firedAtIso: new Date().toISOString(),
      store,
    });
    const revoked = await sql<{ account_status: string; assignment_status: string; entitlement_status: string }[]>`
      select account.status as account_status,
             assignment.status as assignment_status,
             entitlement.status as entitlement_status
        from public.telegram_accounts account
        join public.workflow_operations operation on operation.account_id = account.id
        join public.worker_assignments assignment on assignment.operation_id = operation.id
        join public.entitlements entitlement on entitlement.user_id = operation.user_id
       where account.id = ${result.accounts[0]!.accountId}::uuid
         and operation.idempotency_key like ${`f57c-soak-${runId}-seed%`}
    `;
    assert.deepEqual(revoked[0], {
      account_status: "REVOKED",
      assignment_status: "RELEASED",
      entitlement_status: "REVOKED",
    });
    const cleaned = await cleanupTelegramSoakRun({ runId, store });
    assert.equal(cleaned.deletedAccounts, 2);
    assert.equal(cleaned.deletedUsers, 2);
    assert.equal(cleaned.remainingAccounts, 0);
    assert.equal(cleaned.remainingOperations, 0);
    userIds = [];
    accountIds = [];
  } finally {
    try {
      if (userIds.length > 0) {
        await sql.begin(async (transaction) => {
          await transaction`delete from public.workflow_operations where user_id = any(${transaction.array([...userIds])}::uuid[])`;
          await transaction`delete from public.telegram_accounts where id = any(${transaction.array([...accountIds])}::uuid[])`;
          await transaction`delete from auth.users where id = any(${transaction.array([...userIds])}::uuid[])`;
        });
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
});
