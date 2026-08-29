import type { Sql } from "postgres";
import type { ClaimedWorkflowCommand, RuntimeOutboxRepository } from "./repository.ts";

type ClaimedRow = { command_id: string; operation_id: string; account_id: string; kind: string; target_id: string; payload: Record<string, unknown>; fencing_token: string; lease_until: Date | string };
function claimed(row: ClaimedRow): ClaimedWorkflowCommand {
  if (row.kind !== "COMMENT_TEXT") throw new Error("INVALID_COMMENT_COMMAND_KIND");
  return Object.freeze({ id: row.command_id, operationId: row.operation_id, accountId: row.account_id, kind: row.kind, targetId: row.target_id, payload: Object.freeze(row.payload), fencingToken: BigInt(row.fencing_token), leaseUntil: new Date(row.lease_until).toISOString() });
}
export class PostgresRuntimeOutboxRepository implements RuntimeOutboxRepository {
  readonly sql: Sql;
  constructor(sql: Sql) { this.sql = sql; }
  async claimNext(input: Parameters<RuntimeOutboxRepository["claimNext"]>[0]) {
    const rows = await this.sql<ClaimedRow[]>`select command_id::text, operation_id::text, account_id::text, kind, target_id, payload, fencing_token, lease_until from public.claim_next_workflow_command(${input.accountId}::uuid, ${input.leaseOwner}::uuid, ${input.accountFencingToken.toString()}::bigint, ${input.commandLeaseSeconds})`;
    return rows[0] ? claimed(rows[0]) : null;
  }
  async finish(input: Parameters<RuntimeOutboxRepository["finish"]>[0]) {
    const rows = await this.sql<{ finished: boolean }[]>`select public.finish_claimed_workflow_command(${input.commandId}::uuid, ${input.accountId}::uuid, ${input.leaseOwner}::uuid, ${input.accountFencingToken.toString()}::bigint, ${input.status}, ${input.errorCode ?? null}) finished`;
    return rows[0]?.finished ?? false;
  }
}
