import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";

import {
  telegramDeliveryReceipt,
  type NativeForwardRequest,
  type TelegramDeliveryAdapter,
} from "../../../packages/telegram-contract/src/index.ts";
import { PostgresBroadcastExecutorRepository } from "../src/broadcast-executor/postgres-repository.ts";
import { executeNextBroadcast } from "../src/broadcast-executor/service.ts";

const databaseUrl = process.env.F4_DATABASE_URL?.trim();

test("PostgreSQL claim → adapter → aggregation and fencing-safe completion", { skip: !databaseUrl }, async () => {
  const sql = postgres(databaseUrl!, { max: 1 });
  try {
    const userId = "30303030-3030-3030-3030-303030303030";
    const accountId = "31313131-3131-3131-3131-313131313131";
    const materialId = "32323232-3232-3232-3232-323232323232";
    const targetId = "33333333-3333-3333-3333-333333333333";
    const leaseOwner = "34343434-3434-3434-3434-343434343434";
    await sql`insert into auth.users (id) values (${userId}::uuid)`;
    await sql`
      insert into public.entitlements (
        user_id, package_snapshot, status, starts_at, expires_at,
        max_lpm_groups, max_channel_targets
      ) values (
        ${userId}::uuid,
        ${sql.json({ packageId: "f4-integration", packageType: "USERBOT", features: ["JASEB", "AUTO_COMMENT_MF"], maxTargetsPerMinute: 1, maxAccounts: 1, intervalMinSeconds: 0, intervalMaxSeconds: 0 })},
        'ACTIVE', now() - interval '1 minute', now() + interval '1 day', 10, 1
      )
    `;
    await sql`
      insert into public.telegram_accounts (
        id, owner_user_id, account_type, label, encrypted_session,
        encryption_key_version, status
      ) values (${accountId}::uuid, ${userId}::uuid, 'USERBOT', 'F4 integration', decode('00', 'hex'), 1, 'READY')
    `;
    await sql`insert into public.userbot_profiles (user_id, active_account_id, status, broadcast_interval_seconds) values (${userId}::uuid, ${accountId}::uuid, 'CONNECTED', 0)`;
    await sql`insert into public.broadcast_materials (id, user_id, kind, text_content) values (${materialId}::uuid, ${userId}::uuid, 'TEXT', 'integration promo')`;
    await sql`insert into public.broadcast_lpm_targets (id, user_id, telegram_target_ref) values (${targetId}::uuid, ${userId}::uuid, '@f4_integration_lpm')`;
    await sql`select * from public.create_broadcast_operation(${userId}::uuid, 'USERBOT', ${materialId}::uuid, ${sql.array([targetId])}::uuid[], 'f4-integration-operation')`;
    await sql`update public.broadcast_targets set preparation_status = 'READY' where operation_id = (select id from public.workflow_operations where idempotency_key = 'f4-integration-operation')`;
    await sql`select * from public.acquire_account_lease(${accountId}::uuid, ${leaseOwner}::uuid, 120)`;

    let calls = 0;
    const adapter: TelegramDeliveryAdapter = {
      state: "READY",
      async connect() {}, async disconnect() {},
      async resolveTarget(): Promise<never> { throw new Error("unused"); },
      async resolveLinkedDiscussion(): Promise<never> { throw new Error("unused"); },
      async joinPublicTarget(): Promise<never> { throw new Error("unused"); },
      async sendText(input) {
        calls += 1;
        assert.deepEqual(input, { targetRef: "@f4_integration_lpm", text: "integration promo" });
        return telegramDeliveryReceipt(["1101", "1102"], "2030-01-01T00:00:00.000Z");
      },
      async forwardNative(_input: NativeForwardRequest): Promise<never> { throw new Error("unused"); },
    };
    const repository = new PostgresBroadcastExecutorRepository(sql);
    const result = await executeNextBroadcast(adapter, repository, { accountId, leaseOwner, fencingToken: 1n });
    assert.deepEqual(result.status, "SUCCEEDED");
    assert.equal(calls, 1);

    const [persisted] = await sql<{
      command_status: string;
      target_status: string;
      operation_status: string;
      provider_message_ids: string[];
      attempt_count: number;
    }[]>`
      select command.status command_status, target.delivery_status target_status,
             operation.status operation_status, command.provider_message_ids,
             command.attempt_count
        from public.workflow_commands command
        join public.broadcast_targets target on target.id = command.broadcast_target_id
        join public.workflow_operations operation on operation.id = command.operation_id
       where operation.idempotency_key = 'f4-integration-operation'
    `;
    assert.deepEqual(persisted, {
      command_status: "SUCCEEDED",
      target_status: "SUCCEEDED",
      operation_status: "SUCCEEDED",
      provider_message_ids: ["1101", "1102"],
      attempt_count: 1,
    });

    const partialTargetA = "36363636-3636-3636-3636-363636363361";
    const partialTargetB = "36363636-3636-3636-3636-363636363362";
    await sql`
      insert into public.broadcast_lpm_targets (id, user_id, telegram_target_ref)
      values
        (${partialTargetA}::uuid, ${userId}::uuid, '@f4_partial_a'),
        (${partialTargetB}::uuid, ${userId}::uuid, '@f4_partial_b')
    `;
    await sql`
      select * from public.create_broadcast_operation(
        ${userId}::uuid, 'USERBOT', ${materialId}::uuid,
        ${sql.array([partialTargetA, partialTargetB])}::uuid[],
        'f4-partial-operation'
      )
    `;
    await sql`
      update public.broadcast_targets
         set preparation_status = 'READY'
       where operation_id = (
         select id from public.workflow_operations
          where idempotency_key = 'f4-partial-operation'
       )
    `;

    const activeLease = {
      accountId,
      leaseOwner,
      accountFencingToken: 1n,
      commandLeaseSeconds: 60,
    } as const;
    const partialFirst = await repository.claimNext(activeLease);
    assert.equal(partialFirst?.targetRef, "@f4_partial_a");
    assert.equal(await repository.finish({
      commandId: partialFirst!.id,
      accountId,
      leaseOwner,
      accountFencingToken: 1n,
      outcome: { status: "FAILED_FINAL", errorCode: "CHAT_WRITE_FORBIDDEN" },
    }), true);

    const [afterFirstPartial] = await sql<{ status: string; error_code: string }[]>`
      select status, error_code
        from public.workflow_operations
       where idempotency_key = 'f4-partial-operation'
    `;
    assert.deepEqual(afterFirstPartial, { status: "READY", error_code: "CHAT_WRITE_FORBIDDEN" });

    const partialSecond = await repository.claimNext(activeLease);
    assert.equal(partialSecond?.targetRef, "@f4_partial_b");
    assert.equal(await repository.finish({
      commandId: partialSecond!.id,
      accountId,
      leaseOwner,
      accountFencingToken: 1n,
      outcome: {
        status: "SUCCEEDED",
        receipt: telegramDeliveryReceipt(["1201"], "2030-01-01T00:00:02.000Z"),
      },
    }), true);

    const [partialResult] = await sql<{
      operation_status: string;
      error_code: string;
      target_statuses: string[];
    }[]>`
      select operation.status operation_status, operation.error_code,
             array_agg(target.delivery_status order by target.sequence_number) target_statuses
        from public.workflow_operations operation
        join public.broadcast_targets target on target.operation_id = operation.id
       where operation.idempotency_key = 'f4-partial-operation'
       group by operation.id
    `;
    assert.deepEqual(partialResult, {
      operation_status: "FAILED_FINAL",
      error_code: "CHAT_WRITE_FORBIDDEN",
      target_statuses: ["FAILED_FINAL", "SUCCEEDED"],
    });

    const fencedTarget = "37373737-3737-3737-3737-373737373737";
    const takeoverOwner = "38383838-3838-3838-3838-383838383838";
    await sql`
      insert into public.broadcast_lpm_targets (id, user_id, telegram_target_ref)
      values (${fencedTarget}::uuid, ${userId}::uuid, '@f4_fenced')
    `;
    await sql`
      select * from public.create_broadcast_operation(
        ${userId}::uuid, 'USERBOT', ${materialId}::uuid,
        ${sql.array([fencedTarget])}::uuid[], 'f4-fenced-operation'
      )
    `;
    await sql`
      update public.broadcast_targets
         set preparation_status = 'READY'
       where operation_id = (
         select id from public.workflow_operations
          where idempotency_key = 'f4-fenced-operation'
       )
    `;
    const staleClaim = await repository.claimNext(activeLease);
    assert.equal(staleClaim?.targetRef, "@f4_fenced");

    await sql`
      update public.account_leases set lease_until = now() - interval '1 second'
       where account_id = ${accountId}::uuid
    `;
    const [takeover] = await sql<{ result_status: string; fencing_token: string }[]>`
      select result_status, fencing_token::text
        from public.acquire_account_lease(${accountId}::uuid, ${takeoverOwner}::uuid, 120)
    `;
    assert.deepEqual(takeover, { result_status: "TAKEN_OVER", fencing_token: "2" });
    assert.equal(await repository.finish({
      commandId: staleClaim!.id,
      accountId,
      leaseOwner,
      accountFencingToken: 1n,
      outcome: {
        status: "SUCCEEDED",
        receipt: telegramDeliveryReceipt(["must-not-persist"], "2030-01-01T00:00:03.000Z"),
      },
    }), false);

    const takeoverLease = {
      accountId,
      leaseOwner: takeoverOwner,
      accountFencingToken: 2n,
      commandLeaseSeconds: 60,
    } as const;
    assert.equal(await repository.claimNext(takeoverLease), null);
    const [fencedResult] = await sql<{
      command_status: string;
      command_error: string;
      target_status: string;
      target_error: string;
      operation_status: string;
      operation_error: string;
      provider_message_ids: string[];
    }[]>`
      select command.status command_status, command.last_error_code command_error,
             target.delivery_status target_status, target.last_error_code target_error,
             operation.status operation_status, operation.error_code operation_error,
             command.provider_message_ids
        from public.workflow_commands command
        join public.broadcast_targets target on target.id = command.broadcast_target_id
        join public.workflow_operations operation on operation.id = command.operation_id
       where operation.idempotency_key = 'f4-fenced-operation'
    `;
    assert.deepEqual(fencedResult, {
      command_status: "SIDE_EFFECT_UNCERTAIN",
      command_error: "ACCOUNT_LEASE_FENCED",
      target_status: "SIDE_EFFECT_UNCERTAIN",
      target_error: "COMMAND_LEASE_LOST",
      operation_status: "SIDE_EFFECT_UNCERTAIN",
      operation_error: "COMMAND_LEASE_LOST",
      provider_message_ids: [],
    });
  } finally {
    await sql.end();
  }
});
