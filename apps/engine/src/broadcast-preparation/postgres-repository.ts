import type { Sql } from "postgres";

import type {
  BroadcastPreparationRepository,
  ClaimedBroadcastPreparation,
} from "./repository.ts";

type ClaimRow = Readonly<{
  target_id: string;
  operation_id: string;
  telegram_target_ref: string;
  previous_status: "QUEUED" | "WAITING_APPROVAL";
}>;

export class PostgresBroadcastPreparationRepository implements BroadcastPreparationRepository {
  readonly sql: Sql;

  constructor(sql: Sql) {
    this.sql = sql;
  }

  async claimNext(input: Parameters<BroadcastPreparationRepository["claimNext"]>[0]): Promise<ClaimedBroadcastPreparation | null> {
    const rows = await this.sql<ClaimRow[]>`
      select target_id::text, operation_id::text, telegram_target_ref, previous_status
        from public.claim_next_broadcast_preparation(
          ${input.accountId}::uuid, ${input.leaseOwner}::uuid,
          ${input.accountFencingToken.toString()}::bigint
        )
    `;
    const row = rows[0];
    return row ? Object.freeze({
      targetId: row.target_id,
      operationId: row.operation_id,
      telegramTargetRef: row.telegram_target_ref,
      previousStatus: row.previous_status,
    }) : null;
  }

  async transition(input: Parameters<BroadcastPreparationRepository["transition"]>[0]): Promise<boolean> {
    const rows = await this.sql<{ transitioned: boolean }[]>`
      select public.transition_broadcast_preparation(
        ${input.targetId}::uuid, ${input.accountId}::uuid,
        ${input.leaseOwner}::uuid, ${input.accountFencingToken.toString()}::bigint,
        ${input.expectedStatus}, ${input.status}, ${input.errorCode ?? null},
        ${input.retryAfterSeconds ?? null}, ${input.resolvedTitle ?? null}
      ) transitioned
    `;
    return rows[0]?.transitioned ?? false;
  }
}
