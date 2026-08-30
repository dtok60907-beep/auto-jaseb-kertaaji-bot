import type { Sql } from "postgres";
import type { BroadcastMaterial } from "../domain/broadcast-material.ts";
import type { BroadcastOperationRepository, BroadcastOperationTargetView, BroadcastOperationView } from "./repository.ts";

type Payload = { accountMode: "JASEB_WORKER" | "USERBOT"; intervalSeconds: number; material: BroadcastMaterial & { id: string } };
type OperationRow = { id: string; account_id: string; status: string; payload: Payload };
type TargetRow = { id: string; source_lpm_target_id: string; telegram_target_ref: string; sequence_number: number; preparation_status: string; delivery_status: string; last_error_code: string | null };
function target(row: TargetRow): BroadcastOperationTargetView { return Object.freeze({ id: row.id, sourceLpmTargetId: row.source_lpm_target_id, telegramTargetRef: row.telegram_target_ref, sequenceNumber: row.sequence_number, preparationStatus: row.preparation_status, deliveryStatus: row.delivery_status, lastErrorCode: row.last_error_code }); }
function view(row: OperationRow, targets: readonly TargetRow[]): BroadcastOperationView {
  const payload = row.payload;
  if (!payload || (payload.accountMode !== "JASEB_WORKER" && payload.accountMode !== "USERBOT") || !Number.isInteger(payload.intervalSeconds) || payload.intervalSeconds < 0 || !payload.material || typeof payload.material.id !== "string") throw new Error("invalid broadcast operation payload");
  return Object.freeze({ id: row.id, accountId: row.account_id, accountMode: payload.accountMode, status: row.status, intervalSeconds: payload.intervalSeconds, material: Object.freeze(payload.material), targets: Object.freeze(targets.map(target)) });
}
export class PostgresBroadcastOperationRepository implements BroadcastOperationRepository {
  readonly sql: Sql;
  constructor(sql: Sql) { this.sql = sql; }
  async create(input: Parameters<BroadcastOperationRepository["create"]>[0]) {
    const rows = await this.sql<{ result_status: "CREATED" | "IDEMPOTENT"; operation_id: string }[]>`
      select result_status, operation_id::text
        from public.create_broadcast_operation(
          ${input.userId}::uuid, ${input.accountMode}, ${input.materialId}::uuid,
          ${this.sql.array([...input.targetIds])}::uuid[], ${input.idempotencyKey}
        )
    `;
    const result = rows[0];
    if (!result) throw new Error("broadcast operation was not persisted");
    const operation = await this.get({ userId: input.userId, operationId: result.operation_id });
    if (!operation) throw new Error("broadcast operation was not readable after creation");
    return Object.freeze({ status: result.result_status, operation });
  }
  async get(input: Parameters<BroadcastOperationRepository["get"]>[0]) {
    const operations = await this.sql<OperationRow[]>`
      select id::text, account_id::text, status, payload
        from public.workflow_operations
       where id = ${input.operationId}::uuid and user_id = ${input.userId}::uuid
         and operation_type = 'BROADCAST'
    `;
    const operation = operations[0];
    if (!operation) return null;
    const targets = await this.sql<TargetRow[]>`
      select id::text, source_lpm_target_id::text, telegram_target_ref, sequence_number,
             preparation_status, delivery_status, last_error_code
        from public.broadcast_targets
       where operation_id = ${operation.id}::uuid
       order by sequence_number
    `;
    return view(operation, targets);
  }
}
