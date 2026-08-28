import type { Sql } from "postgres";
import type { UserbotProfileRepository, UserbotProfileView } from "./repository.ts";
type Row = { id: string; status: UserbotProfileView["status"]; account_id: string | null; label: string | null; account_status: string | null };
function view(row: Row): UserbotProfileView { return Object.freeze({ id: row.id, status: row.status, activeAccount: row.account_id && row.label && row.account_status ? Object.freeze({ id: row.account_id, label: row.label, status: row.account_status }) : null }); }
export class PostgresUserbotProfileRepository implements UserbotProfileRepository {
  constructor(readonly sql: Sql) {}
  async get(userId: string) { const rows = await this.rows(userId); return rows[0] ? view(rows[0]) : null; }
  async attach(userId: string, accountId: string) { await this.sql`select public.switch_userbot_profile_account(${userId}::uuid, ${accountId}::uuid)`; const row = (await this.rows(userId))[0]; if (!row) throw new Error("profile was not persisted"); return view(row); }
  async detach(userId: string) { const rows = await this.sql<{ detached: boolean }[]>`select public.detach_userbot_profile_account(${userId}::uuid) detached`; return rows[0]?.detached ?? false; }
  private rows(userId: string) { return this.sql<Row[]>`select p.id::text,p.status,p.active_account_id::text account_id,a.label,a.status account_status from public.userbot_profiles p left join public.telegram_accounts a on a.id=p.active_account_id where p.user_id=${userId}::uuid`; }
}
