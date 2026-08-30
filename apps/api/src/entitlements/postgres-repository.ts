import type { Sql } from "postgres";
import type { EntitlementRepository, EntitlementView } from "./repository.ts";

type Row = { id: string; user_id: string; package_id: string; package_type: "JASEB_WORKER" | "USERBOT"; status: string; starts_at: string; expires_at: string; max_lpm_groups: number; max_channel_targets: number };
function view(row: Row): EntitlementView { return Object.freeze({ id: row.id, userId: row.user_id, packageId: row.package_id, packageType: row.package_type, status: row.status, startsAt: row.starts_at, expiresAt: row.expires_at, maxLpmGroups: row.max_lpm_groups, maxChannelTargets: row.max_channel_targets }); }
export class PostgresEntitlementRepository implements EntitlementRepository {
  readonly sql: Sql;
  constructor(sql: Sql) { this.sql = sql; }
  async grant({ userId, grant }: Parameters<EntitlementRepository["grant"]>[0]) { const rows = await this.sql<{ id: string }[]>`select public.grant_entitlement(${userId}::uuid, ${grant.packageId}::uuid, ${grant.durationDays}, ${grant.maxLpmGroups}, ${grant.maxChannelTargets})::text as id`; return this.readOne(rows[0].id); }
  async list(userId: string) { const rows = await this.sql<Row[]>`select e.id::text,e.user_id::text,e.package_id::text,e.package_snapshot->>'packageType' package_type,e.status,e.starts_at::text,e.expires_at::text,e.max_lpm_groups,e.max_channel_targets from public.entitlements e where e.user_id=${userId}::uuid order by e.created_at desc`; return Object.freeze(rows.map(view)); }
  async extend(id: string, durationDays: number) { const rows = await this.sql<{ ok: boolean }[]>`select public.extend_entitlement(${id}::uuid, ${durationDays}) ok`; return rows[0]?.ok ? this.readOne(id) : null; }
  async revoke(id: string) { const rows = await this.sql<{ ok: boolean }[]>`select public.revoke_entitlement(${id}::uuid) ok`; return rows[0]?.ok ?? false; }
  private async readOne(id: string) { const rows = await this.sql<Row[]>`select e.id::text,e.user_id::text,e.package_id::text,e.package_snapshot->>'packageType' package_type,e.status,e.starts_at::text,e.expires_at::text,e.max_lpm_groups,e.max_channel_targets from public.entitlements e where e.id=${id}::uuid`; if (!rows[0]) throw new Error("entitlement was not persisted"); return view(rows[0]); }
}
