import type { Sql } from "postgres";

import type {
  BroadcastExecutorRepository,
  ClaimedBroadcastCommand,
} from "./repository.ts";

type ClaimRow = Readonly<{
  command_id: string;
  operation_id: string;
  account_id: string;
  kind: string;
  target_id: string;
  payload: unknown;
  attempt_count: number;
  fencing_token: string;
  lease_until: Date | string;
}>;

function claim(row: ClaimRow): ClaimedBroadcastCommand {
  if (
    (row.kind !== "SEND_TEXT" && row.kind !== "FORWARD_MESSAGE")
    || typeof row.target_id !== "string" || !row.target_id.trim()
    || typeof row.payload !== "object" || row.payload === null || Array.isArray(row.payload)
    || !Number.isInteger(row.attempt_count) || row.attempt_count < 1
  ) throw new Error("INVALID_CLAIMED_BROADCAST_COMMAND");
  const leaseUntil = new Date(row.lease_until).toISOString();
  return Object.freeze({
    id: row.command_id,
    operationId: row.operation_id,
    accountId: row.account_id,
    kind: row.kind,
    targetRef: row.target_id,
    payload: Object.freeze(row.payload as Record<string, unknown>),
    attemptCount: row.attempt_count,
    fencingToken: BigInt(row.fencing_token),
    leaseUntil,
  });
}

export class PostgresBroadcastExecutorRepository implements BroadcastExecutorRepository {
  readonly sql: Sql;
  constructor(sql: Sql) { this.sql = sql; }

  async claimNext(input: Parameters<BroadcastExecutorRepository["claimNext"]>[0]): Promise<ClaimedBroadcastCommand | null> {
    const rows = await this.sql<ClaimRow[]>`
      select command_id::text, operation_id::text, account_id::text, kind, target_id,
             payload, attempt_count, fencing_token::text, lease_until
        from public.claim_next_broadcast_command(
          ${input.accountId}::uuid, ${input.leaseOwner}::uuid,
          ${input.accountFencingToken.toString()}::bigint, ${input.commandLeaseSeconds}
        )
    `;
    return rows[0] ? claim(rows[0]) : null;
  }

  async finish(input: Parameters<BroadcastExecutorRepository["finish"]>[0]): Promise<boolean> {
    let rows: readonly { finished: boolean }[];
    if (input.outcome.status === "SUCCEEDED") {
      rows = await this.sql<{ finished: boolean }[]>`
        select public.finish_broadcast_command(
          ${input.commandId}::uuid, ${input.accountId}::uuid, ${input.leaseOwner}::uuid,
          ${input.accountFencingToken.toString()}::bigint, 'SUCCEEDED', null, null,
          ${this.sql.array([...input.outcome.receipt.providerMessageIds])}::text[],
          ${input.outcome.receipt.sentAt}::timestamptz
        ) finished
      `;
    } else if (input.outcome.status === "FAILED_RETRYABLE") {
      rows = await this.sql<{ finished: boolean }[]>`
        select public.finish_broadcast_command(
          ${input.commandId}::uuid, ${input.accountId}::uuid, ${input.leaseOwner}::uuid,
          ${input.accountFencingToken.toString()}::bigint, 'FAILED_RETRYABLE',
          ${input.outcome.errorCode}, ${input.outcome.retryAfterSeconds}, null, null
        ) finished
      `;
    } else {
      rows = await this.sql<{ finished: boolean }[]>`
        select public.finish_broadcast_command(
          ${input.commandId}::uuid, ${input.accountId}::uuid, ${input.leaseOwner}::uuid,
          ${input.accountFencingToken.toString()}::bigint, ${input.outcome.status},
          ${input.outcome.errorCode}, null, null, null
        ) finished
      `;
    }
    return rows[0]?.finished ?? false;
  }
}
