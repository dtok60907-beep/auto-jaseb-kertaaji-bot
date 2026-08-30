import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";

import type { SendLatencySummary, SoakFixtureCounts } from "./telegram-soak.ts";

export type SoakPrefixes = Readonly<{ commandPrefix: string; accountPrefix: string }>;
export type SoakAccountIdentity = Readonly<{ accountId: string; userId: string }>;
export type SoakPerAccountState = Readonly<{
  accountId: string;
  accountStatus: string;
  succeeded: number;
  pending: number;
  inFlight: number;
  failedRetryable: number;
  failedFinal: number;
  uncertain: number;
}>;

export interface TelegramSoakStore {
  listAccounts(accountPrefix: string): Promise<readonly SoakAccountIdentity[]>;
  enqueueBurst(input: Readonly<{
    runId: string;
    burstIndex: number;
    accounts: readonly SoakAccountIdentity[];
    targetRef: string;
    sendIntervalSeconds: number;
    label: string;
  }>): Promise<number>;
  readCounts(prefixes: SoakPrefixes): Promise<SoakFixtureCounts>;
  readPerAccount(prefixes: SoakPrefixes): Promise<readonly SoakPerAccountState[]>;
  readSucceededPerAccountAfter(prefixes: SoakPrefixes, afterIso: string): Promise<readonly Readonly<{ accountId: string; succeededAfter: number }>[]>;
  readSendLatencies(commandPrefix: string): Promise<SendLatencySummary>;
  readMalformedReceiptCount(commandPrefix: string): Promise<number>;
  readSucceededAfter(commandPrefix: string, afterIso: string): Promise<number>;
  cleanupBurstOperations(commandPrefix: string): Promise<number>;
  countBurstOperations(commandPrefix: string): Promise<number>;
}

const EMPTY_LATENCY: SendLatencySummary = Object.freeze({
  sendsSucceeded: 0,
  latencyP50Milliseconds: 0,
  latencyP95Milliseconds: 0,
  latencyMaxMilliseconds: 0,
});

export function createPostgresTelegramSoakStore(sql: Sql): TelegramSoakStore {
  const store: TelegramSoakStore = {
    async listAccounts(accountPrefix) {
      const rows = await sql<{ account_id: string; user_id: string }[]>`
        select distinct account.id::text as account_id, operation.user_id::text as user_id
          from public.telegram_accounts account
          join public.workflow_operations operation on operation.account_id = account.id
         where operation.idempotency_key like ${accountPrefix + "%"}
           and account.status = 'READY'
         order by account_id
      `;
      return Object.freeze(rows.map((row) => Object.freeze({ accountId: row.account_id, userId: row.user_id })));
    },

    async enqueueBurst(input) {
      const operationIds = input.accounts.map(() => randomUUID());
      const targetIds = input.accounts.map(() => randomUUID());
      const commandIds = input.accounts.map(() => randomUUID());
      const operationKeys = input.accounts.map((_account, index) => `f57c-${input.runId}-b${input.burstIndex}-a${index + 1}`);
      const commandKeys = operationKeys.map((key) => `${key}-cmd`);
      const accountIds = input.accounts.map((account) => account.accountId);
      const userIds = input.accounts.map((account) => account.userId);
      const text = `F5.7c soak ${input.runId} ${input.label}`;

      await sql.begin(async (transaction) => {
        await transaction`
          insert into public.workflow_operations (
            id, user_id, account_id, operation_type, status, idempotency_key, payload
          )
          select operation_id, user_id, account_id, 'BROADCAST', 'READY', operation_key,
                 ${transaction.json({ accountMode: "JASEB_WORKER", material: { kind: "TEXT", text } })}
            from unnest(
              ${transaction.array(operationIds)}::uuid[],
              ${transaction.array(userIds)}::uuid[],
              ${transaction.array(accountIds)}::uuid[],
              ${transaction.array(operationKeys)}::text[]
            ) fixture(operation_id, user_id, account_id, operation_key)
        `;
        await transaction`
          insert into public.broadcast_targets (
            id, operation_id, telegram_target_ref, interval_seconds,
            sequence_number, preparation_status
          )
          select target_id, operation_id, ${input.targetRef}, ${input.sendIntervalSeconds}, 1, 'QUEUED'
            from unnest(
              ${transaction.array(targetIds)}::uuid[],
              ${transaction.array(operationIds)}::uuid[]
            ) fixture(target_id, operation_id)
        `;
        await transaction`
          insert into public.workflow_commands (
            id, operation_id, account_id, kind, target_id, idempotency_key,
            payload, broadcast_target_id
          )
          select command_id, operation_id, account_id, 'SEND_TEXT', ${input.targetRef}, command_key,
                 ${transaction.json({ material: { kind: "TEXT", text } })}, target_id
            from unnest(
              ${transaction.array(commandIds)}::uuid[],
              ${transaction.array(operationIds)}::uuid[],
              ${transaction.array(accountIds)}::uuid[],
              ${transaction.array(commandKeys)}::text[],
              ${transaction.array(targetIds)}::uuid[]
            ) fixture(command_id, operation_id, account_id, command_key, target_id)
        `;
      });
      return input.accounts.length;
    },

    async readCounts(prefixes) {
      const rows = await sql<{ metrics: Record<string, number> }[]>`
        with fixture_accounts as (
          select distinct account.id, account.status
            from public.telegram_accounts account
            join public.workflow_operations operation on operation.account_id = account.id
           where operation.idempotency_key like ${prefixes.accountPrefix + "%"}
        ), fixture_commands as (
          select command.id, command.status from public.workflow_commands command
            join public.workflow_operations operation on operation.id = command.operation_id
           where operation.idempotency_key like ${prefixes.commandPrefix + "%"}
        )
        select json_build_object(
          'accounts_ready', (select count(*) from fixture_accounts where status = 'READY'),
          'accounts_revoked', (select count(*) from fixture_accounts where status = 'REVOKED'),
          'accounts_degraded', (select count(*) from fixture_accounts where status = 'DEGRADED'),
          'commands_created', (select count(*) from fixture_commands),
          'commands_succeeded', (select count(*) from fixture_commands where status = 'SUCCEEDED'),
          'commands_pending', (select count(*) from fixture_commands where status = 'PENDING'),
          'commands_in_flight', (select count(*) from fixture_commands where status in ('CLAIMED', 'SENDING')),
          'commands_failed_retryable', (select count(*) from fixture_commands where status = 'FAILED_RETRYABLE'),
          'commands_failed_final', (select count(*) from fixture_commands where status = 'FAILED_FINAL'),
          'commands_uncertain', (select count(*) from fixture_commands where status = 'SIDE_EFFECT_UNCERTAIN'),
          'active_leases', (select count(*) from public.account_leases lease
            where lease.account_id in (select id from fixture_accounts) and lease.lease_until > now())
        ) metrics
      `;
      const metrics = rows[0]?.metrics ?? {};
      return Object.freeze({
        accountsReady: Number(metrics.accounts_ready ?? 0),
        accountsRevoked: Number(metrics.accounts_revoked ?? 0),
        accountsDegraded: Number(metrics.accounts_degraded ?? 0),
        commandsCreated: Number(metrics.commands_created ?? 0),
        commandsSucceeded: Number(metrics.commands_succeeded ?? 0),
        commandsPending: Number(metrics.commands_pending ?? 0),
        commandsInFlight: Number(metrics.commands_in_flight ?? 0),
        commandsFailedRetryable: Number(metrics.commands_failed_retryable ?? 0),
        commandsFailedFinal: Number(metrics.commands_failed_final ?? 0),
        commandsUncertain: Number(metrics.commands_uncertain ?? 0),
        activeLeases: Number(metrics.active_leases ?? 0),
      });
    },

    async readPerAccount(prefixes) {
      const rows = await sql<{
        account_id: string; account_status: string; succeeded: number; pending: number;
        in_flight: number; failed_retryable: number; failed_final: number; uncertain: number;
      }[]>`
        with fixture_accounts as (
          select account.id, account.status
            from public.telegram_accounts account
           where exists (
             select 1 from public.workflow_operations seed
              where seed.account_id = account.id
                and seed.idempotency_key like ${prefixes.accountPrefix + "%"}
           )
        ), burst_commands as (
          select command.account_id, command.status
            from public.workflow_commands command
            join public.workflow_operations operation on operation.id = command.operation_id
           where operation.idempotency_key like ${prefixes.commandPrefix + "%"}
        )
        select accounts.id::text as account_id, accounts.status as account_status,
               count(commands.status) filter (where commands.status = 'SUCCEEDED')::int as succeeded,
               count(commands.status) filter (where commands.status = 'PENDING')::int as pending,
               count(commands.status) filter (where commands.status in ('CLAIMED', 'SENDING'))::int as in_flight,
               count(commands.status) filter (where commands.status = 'FAILED_RETRYABLE')::int as failed_retryable,
               count(commands.status) filter (where commands.status = 'FAILED_FINAL')::int as failed_final,
               count(commands.status) filter (where commands.status = 'SIDE_EFFECT_UNCERTAIN')::int as uncertain
          from fixture_accounts accounts
          left join burst_commands commands on commands.account_id = accounts.id
         group by accounts.id, accounts.status
         order by accounts.id
      `;
      return Object.freeze(rows.map((row) => Object.freeze({
        accountId: row.account_id,
        accountStatus: row.account_status,
        succeeded: Number(row.succeeded ?? 0),
        pending: Number(row.pending ?? 0),
        inFlight: Number(row.in_flight ?? 0),
        failedRetryable: Number(row.failed_retryable ?? 0),
        failedFinal: Number(row.failed_final ?? 0),
        uncertain: Number(row.uncertain ?? 0),
      })));
    },

    async readSucceededPerAccountAfter(prefixes, afterIso) {
      const rows = await sql<{ account_id: string; succeeded_after: number }[]>`
        with fixture_accounts as (
          select account.id from public.telegram_accounts account
           where exists (
             select 1 from public.workflow_operations seed
              where seed.account_id = account.id
                and seed.idempotency_key like ${prefixes.accountPrefix + "%"}
           )
        )
        select accounts.id::text as account_id,
               count(command.id) filter (where command.status = 'SUCCEEDED')::int as succeeded_after
          from fixture_accounts accounts
          left join public.workflow_commands command on command.account_id = accounts.id
           and command.status = 'SUCCEEDED'
           and command.provider_sent_at is not null
           and command.provider_sent_at >= ${afterIso}::timestamptz
           and command.operation_id in (
             select id from public.workflow_operations where idempotency_key like ${prefixes.commandPrefix + "%"}
           )
         group by accounts.id
         order by accounts.id
      `;
      return Object.freeze(rows.map((row) => Object.freeze({ accountId: row.account_id, succeededAfter: Number(row.succeeded_after ?? 0) })));
    },

    async readSendLatencies(commandPrefix) {
      const rows = await sql<{ latencies: number[] | null }[]>`
        select array_agg(extract(epoch from (command.provider_sent_at - command.created_at)) * 1000
                         order by extract(epoch from (command.provider_sent_at - command.created_at)) * 1000)::float8[] latencies
          from public.workflow_commands command
         where command.operation_id in (
                 select id from public.workflow_operations where idempotency_key like ${commandPrefix + "%"}
               )
           and command.status = 'SUCCEEDED' and command.provider_sent_at is not null
      `;
      const latencies = [...(rows[0]?.latencies ?? [])].sort((left, right) => left - right);
      if (latencies.length === 0) return EMPTY_LATENCY;
      const percentile = (ratio: number) => latencies[Math.min(latencies.length - 1, Math.floor(ratio * latencies.length))]!;
      return Object.freeze({
        sendsSucceeded: latencies.length,
        latencyP50Milliseconds: percentile(0.5),
        latencyP95Milliseconds: percentile(0.95),
        latencyMaxMilliseconds: latencies[latencies.length - 1]!,
      });
    },

    async readMalformedReceiptCount(commandPrefix) {
      const rows = await sql<{ malformed: number }[]>`
        select count(*)::int malformed
          from public.workflow_commands command
          join public.workflow_operations operation on operation.id = command.operation_id
         where operation.idempotency_key like ${commandPrefix + "%"}
           and command.status = 'SUCCEEDED'
           and cardinality(command.provider_message_ids) <> 1
      `;
      return rows[0]?.malformed ?? 0;
    },

    async readSucceededAfter(commandPrefix, afterIso) {
      const rows = await sql<{ succeeded: number }[]>`
        select count(*)::int succeeded
          from public.workflow_commands command
          join public.workflow_operations operation on operation.id = command.operation_id
         where operation.idempotency_key like ${commandPrefix + "%"}
           and command.status = 'SUCCEEDED'
           and command.provider_sent_at >= ${afterIso}::timestamptz
      `;
      return rows[0]?.succeeded ?? 0;
    },

    async cleanupBurstOperations(commandPrefix) {
      const rows = await sql<{ deleted: number }[]>`
        with deleted as (
          delete from public.workflow_operations
           where idempotency_key like ${commandPrefix + "%"}
          returning id
        )
        select count(*)::int deleted from deleted
      `;
      return rows[0]?.deleted ?? 0;
    },

    async countBurstOperations(commandPrefix) {
      const rows = await sql<{ remaining: number }[]>`
        select count(*)::int remaining from public.workflow_operations
         where idempotency_key like ${commandPrefix + "%"}
      `;
      return rows[0]?.remaining ?? 0;
    },
  };
  return Object.freeze(store);
}
