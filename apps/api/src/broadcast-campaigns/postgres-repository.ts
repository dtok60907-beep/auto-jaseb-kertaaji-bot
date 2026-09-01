import type { Sql } from "postgres";

import type { BroadcastCampaignRepository, BroadcastCampaignView } from "./repository.ts";

type Row = {
  id: string;
  account_mode: "JASEB_WORKER" | "USERBOT";
  material_id: string;
  target_ids: string[];
  interval_seconds: number;
  status: "ACTIVE" | "STOPPED";
  error_code: string | null;
  last_cycle_at: string | null;
  next_cycle_at: string;
  last_operation_id: string | null;
};

function view(row: Row): BroadcastCampaignView {
  return Object.freeze({
    id: row.id,
    accountMode: row.account_mode,
    materialId: row.material_id,
    targetIds: Object.freeze(row.target_ids),
    intervalSeconds: row.interval_seconds,
    status: row.status,
    errorCode: row.error_code,
    lastCycleAt: row.last_cycle_at ? new Date(row.last_cycle_at).toISOString() : null,
    nextCycleAt: new Date(row.next_cycle_at).toISOString(),
    lastOperationId: row.last_operation_id,
  });
}

export class PostgresBroadcastCampaignRepository implements BroadcastCampaignRepository {
  readonly sql: Sql;
  constructor(sql: Sql) { this.sql = sql; }

  async create(input: Parameters<BroadcastCampaignRepository["create"]>[0]): Promise<BroadcastCampaignView> {
    const rows = await this.sql<{ campaign_id: string }[]>`
      select public.create_broadcast_campaign(
        ${input.userId}::uuid, ${input.accountMode}, ${input.materialId}::uuid,
        ${this.sql.array([...input.targetIds])}::uuid[], ${input.intervalSeconds}
      ) campaign_id
    `;
    const campaignId = rows[0]?.campaign_id;
    if (!campaignId) throw new Error("broadcast campaign was not persisted");
    const created = await this.get(campaignId);
    if (!created) throw new Error("broadcast campaign was not readable after creation");
    return created;
  }

  async getCurrent(userId: string): Promise<BroadcastCampaignView | null> {
    const rows = await this.sql<Row[]>`
      select c.id::text, c.account_mode, c.material_id::text, c.target_ids::text[], c.interval_seconds,
             c.status, c.error_code, c.last_cycle_at::text, c.next_cycle_at::text,
             (select o.id::text from public.workflow_operations o
               where o.idempotency_key like ('campaign:' || c.id::text || ':%')
               order by o.created_at desc limit 1) as last_operation_id
        from public.broadcast_campaigns c
       where c.user_id = ${userId}::uuid
       order by c.created_at desc
       limit 1
    `;
    const row = rows[0];
    return row ? view(row) : null;
  }

  async stop(input: Parameters<BroadcastCampaignRepository["stop"]>[0]): Promise<boolean> {
    const rows = await this.sql<{ stopped: boolean }[]>`
      select public.stop_broadcast_campaign(${input.campaignId}::uuid, ${input.userId}::uuid) stopped
    `;
    return rows[0]?.stopped ?? false;
  }

  private async get(campaignId: string): Promise<BroadcastCampaignView | null> {
    const rows = await this.sql<Row[]>`
      select c.id::text, c.account_mode, c.material_id::text, c.target_ids::text[], c.interval_seconds,
             c.status, c.error_code, c.last_cycle_at::text, c.next_cycle_at::text,
             (select o.id::text from public.workflow_operations o
               where o.idempotency_key like ('campaign:' || c.id::text || ':%')
               order by o.created_at desc limit 1) as last_operation_id
        from public.broadcast_campaigns c
       where c.id = ${campaignId}::uuid
    `;
    const row = rows[0];
    return row ? view(row) : null;
  }
}
