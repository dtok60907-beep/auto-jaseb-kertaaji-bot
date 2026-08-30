import type { Sql } from "postgres";
import type { UserbotProfileRepository, UserbotProfileView } from "./repository.ts";
type Row = { id: string; status: UserbotProfileView["status"]; broadcast_interval_seconds: number; account_id: string | null; label: string | null; account_status: string | null };
function view(row: Row): UserbotProfileView { return Object.freeze({ id: row.id, status: row.status, broadcastIntervalSeconds: row.broadcast_interval_seconds, activeAccount: row.account_id && row.label && row.account_status ? Object.freeze({ id: row.account_id, label: row.label, status: row.account_status }) : null }); }
export class PostgresUserbotProfileRepository implements UserbotProfileRepository {
  readonly sql: Sql;
  constructor(sql: Sql) { this.sql = sql; }
  async get(userId: string) { const rows = await this.rows(userId); return rows[0] ? view(rows[0]) : null; }
  async updateBroadcastInterval(userId: string, intervalSeconds: number) {
    const rows = await this.sql<Row[]>`
      insert into public.userbot_profiles (user_id, broadcast_interval_seconds)
      values (${userId}::uuid, ${intervalSeconds})
      on conflict (user_id) do update set broadcast_interval_seconds = excluded.broadcast_interval_seconds
      returning id::text, status, broadcast_interval_seconds, active_account_id::text account_id,
        null::text label, null::text account_status
    `;
    const profile = rows[0];
    if (!profile) throw new Error("userbot profile interval was not persisted");
    const hydrated = (await this.rows(userId))[0];
    return view(hydrated ?? profile);
  }
  async attach(userId: string, accountId: string) { await this.sql`select public.switch_userbot_profile_account(${userId}::uuid, ${accountId}::uuid)`; const row = (await this.rows(userId))[0]; if (!row) throw new Error("profile was not persisted"); return view(row); }
  async detach(userId: string) { const rows = await this.sql<{ detached: boolean }[]>`select public.detach_userbot_profile_account(${userId}::uuid) detached`; return rows[0]?.detached ?? false; }
  private rows(userId: string) { return this.sql<Row[]>`select p.id::text,p.status,p.broadcast_interval_seconds,p.active_account_id::text account_id,a.label,a.status account_status from public.userbot_profiles p left join public.telegram_accounts a on a.id=p.active_account_id where p.user_id=${userId}::uuid`; }
}
