import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";

import type { TelegramSoakProvisioningStore } from "./telegram-soak-provisioning.ts";

export function createPostgresTelegramSoakProvisioningStore(sql: Sql): TelegramSoakProvisioningStore {
  const store: TelegramSoakProvisioningStore = {
    async provisionBatch(input) {
      const userIds = input.accounts.map((account) => account.userId);
      const accountIds = input.accounts.map((account) => account.accountId);
      const operationIds = input.accounts.map(() => randomUUID());
      const operationKeys = input.accounts.map((account) => `f57c-soak-${input.runId}-seed-a${account.accountIndex}`);

      await sql.begin(async (transaction) => {
        await transaction`
          insert into auth.users (id)
          select user_id from unnest(${transaction.array(userIds)}::uuid[]) fixture(user_id)
        `;

        await transaction`
          insert into public.entitlements (
            user_id, package_snapshot, status, starts_at, expires_at,
            max_lpm_groups, max_channel_targets
          )
          select user_id,
                 ${transaction.json({
                   packageId: "f57c-soak",
                   packageType: "JASEB_WORKER",
                   features: ["JASEB"],
                   maxTargetsPerMinute: 1,
                   maxAccounts: 1,
                   intervalMinSeconds: 0,
                   intervalMaxSeconds: 3_600,
                 })},
                 'ACTIVE', now() - interval '1 minute', now() + interval '2 days', 1, 0
            from unnest(${transaction.array(userIds)}::uuid[]) fixture(user_id)
        `;

        for (const account of input.accounts) {
          await transaction`
            insert into public.telegram_accounts (
              id, owner_user_id, account_type, label, provider_user_id,
              encrypted_session, encryption_key_version, status
            ) values (
              ${account.accountId}::uuid, null, 'JASEB_WORKER', ${account.label},
              ${account.providerUserId}::bigint, ${account.encryptedSession},
              ${account.encryptionKeyVersion}, 'READY'
            )
          `;
        }

        await transaction`
          insert into public.worker_account_settings (worker_account_id, interval_seconds, active)
          select account_id, ${input.intervalSeconds}, true
            from unnest(${transaction.array(accountIds)}::uuid[]) fixture(account_id)
        `;

        await transaction`
          insert into public.workflow_operations (
            id, user_id, account_id, operation_type, status, idempotency_key, payload
          )
          select operation_id, user_id, account_id, 'BROADCAST', 'SUCCEEDED', operation_key,
                 ${transaction.json({ accountMode: "JASEB_WORKER", material: { kind: "TEXT", text: "F5.7c provisioning seed" } })}
            from unnest(
              ${transaction.array(operationIds)}::uuid[],
              ${transaction.array(userIds)}::uuid[],
              ${transaction.array(accountIds)}::uuid[],
              ${transaction.array(operationKeys)}::text[]
            ) fixture(operation_id, user_id, account_id, operation_key)
        `;

        await transaction`
          insert into public.worker_assignments (operation_id, worker_account_id, user_id, status)
          select operation_id, account_id, user_id, 'ACTIVE'
            from unnest(
              ${transaction.array(operationIds)}::uuid[],
              ${transaction.array(accountIds)}::uuid[],
              ${transaction.array(userIds)}::uuid[]
            ) fixture(operation_id, account_id, user_id)
        `;
      });
    },

    async revokeAccount(input) {
      return sql.begin(async (transaction) => {
        const seedPrefix = `f57c-soak-${input.runId}-seed`;
        const burstPrefix = `f57c-${input.runId}-b`;
        const rows = await transaction<{ account_id: string; user_id: string }[]>`
          select account.id::text as account_id, operation.user_id::text as user_id
            from public.telegram_accounts account
            join public.workflow_operations operation on operation.account_id = account.id
           where account.id = ${input.accountId}::uuid
             and operation.idempotency_key like ${seedPrefix + "%"}
           order by operation.created_at
           limit 1
             for update of account
        `;
        const revoked = rows[0];
        if (!revoked) return false;

        await transaction`
          update public.telegram_accounts
             set status = 'REVOKED', runtime_retry_at = null,
                 broadcast_next_eligible_at = null, updated_at = ${input.firedAtIso}::timestamptz
           where id = ${input.accountId}::uuid
        `;

        await transaction`
          update public.workflow_commands command
             set status = 'CANCELLED', updated_at = ${input.firedAtIso}::timestamptz,
                 lease_until = null, lease_owner = null
           where command.account_id = ${input.accountId}::uuid
             and command.status in ('PENDING', 'FAILED_RETRYABLE')
             and command.operation_id in (
               select id from public.workflow_operations where idempotency_key like ${burstPrefix + "%"}
             )
        `;
        await transaction`
          update public.worker_assignments
             set status = 'RELEASED', released_at = ${input.firedAtIso}::timestamptz,
                 updated_at = ${input.firedAtIso}::timestamptz
           where worker_account_id = ${input.accountId}::uuid
             and status in ('RESERVED', 'ACTIVE')
        `;
        await transaction`delete from public.account_leases where account_id = ${input.accountId}::uuid`;
        await transaction`
          update public.entitlements
             set status = 'REVOKED', updated_at = ${input.firedAtIso}::timestamptz
           where user_id = ${revoked.user_id}::uuid and status = 'ACTIVE'
        `;
        return true;
      });
    },

    async cleanupRun(runId) {
      return sql.begin(async (transaction) => {
        const seedPrefix = `f57c-soak-${runId}-seed`;
        const burstPrefix = `f57c-${runId}-b`;
        const fixtureRows = await transaction<{ account_id: string; user_id: string }[]>`
          select operation.account_id::text as account_id, operation.user_id::text as user_id
            from public.workflow_operations operation
           where operation.idempotency_key like ${seedPrefix + "%"}
           order by account_id
             for update of operation
        `;
        const accountIds = fixtureRows.map((row) => row.account_id);
        const userIds = [...new Set(fixtureRows.map((row) => row.user_id))];

        const deletedOperationRows = await transaction<{ id: string }[]>`
          delete from public.workflow_operations
           where idempotency_key like ${seedPrefix + "%"}
              or idempotency_key like ${burstPrefix + "%"}
          returning id::text
        `;
        if (accountIds.length > 0) {
          await transaction`delete from public.account_leases where account_id = any(${transaction.array(accountIds)}::uuid[])`;
        }
        const deletedAccounts = accountIds.length === 0 ? [] : await transaction<{ id: string }[]>`
          delete from public.telegram_accounts
           where id = any(${transaction.array(accountIds)}::uuid[])
          returning id::text
        `;
        const deletedUsers = userIds.length === 0 ? [] : await transaction<{ id: string }[]>`
          delete from auth.users
           where id = any(${transaction.array(userIds)}::uuid[])
          returning id::text
        `;

        const remainingOperations = await transaction<{ count: number }[]>`
          select count(*)::int as count from public.workflow_operations
           where idempotency_key like ${seedPrefix + "%"}
              or idempotency_key like ${burstPrefix + "%"}
        `;
        const remainingAccounts = accountIds.length === 0 ? [{ count: 0 }] : await transaction<{ count: number }[]>`
          select count(*)::int as count from public.telegram_accounts
           where id = any(${transaction.array(accountIds)}::uuid[])
        `;
        const remainingLeases = accountIds.length === 0 ? [{ count: 0 }] : await transaction<{ count: number }[]>`
          select count(*)::int as count from public.account_leases
           where account_id = any(${transaction.array(accountIds)}::uuid[])
        `;
        return Object.freeze({
          deletedAccounts: deletedAccounts.length,
          deletedUsers: deletedUsers.length,
          deletedOperations: deletedOperationRows.length,
          remainingAccounts: remainingAccounts[0]?.count ?? 0,
          remainingOperations: remainingOperations[0]?.count ?? 0,
          remainingLeases: remainingLeases[0]?.count ?? 0,
        });
      });
    },
  };
  return Object.freeze(store);
}
