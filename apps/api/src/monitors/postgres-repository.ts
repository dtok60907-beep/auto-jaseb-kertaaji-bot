import type { Sql } from "postgres";

import type { MonitorAccountRepository, MonitorAccountView } from "./repository.ts";

type Row = Readonly<{
  id: string;
  label: string;
  account_status: MonitorAccountView["accountStatus"];
  active: boolean;
  source_count: number;
  ready_source_count: number;
  last_runtime_error_code: string | null;
}>;

function view(row: Row): MonitorAccountView {
  return Object.freeze({
    id: row.id,
    label: row.label,
    accountStatus: row.account_status,
    active: row.active,
    sourceCount: row.source_count,
    readySourceCount: row.ready_source_count,
    lastRuntimeErrorCode: row.last_runtime_error_code,
  });
}

export class PostgresMonitorAccountRepository implements MonitorAccountRepository {
  readonly sql: Sql;
  constructor(sql: Sql) { this.sql = sql; }

  async list(): Promise<readonly MonitorAccountView[]> {
    return Object.freeze((await this.rows()).map(view));
  }

  async setActive(accountId: string, active: boolean): Promise<MonitorAccountView | null> {
    const updated = await this.sql<{ id: string }[]>`
      with deactivated as (
        update public.telegram_accounts
           set monitor_active = false, updated_at = now()
         where ${active}
           and account_type = 'MONITOR'
           and monitor_active
           and id <> ${accountId}::uuid
        returning id
      ), updated as (
        update public.telegram_accounts
           set monitor_active = ${active}, updated_at = now()
         where id = ${accountId}::uuid
           and account_type = 'MONITOR'
           and (select count(*) from deactivated) >= 0
        returning id::text
      )
      select id from updated
    `;
    if (!updated[0]) return null;
    const row = (await this.rows(accountId))[0];
    return row ? view(row) : null;
  }

  private rows(accountId?: string) {
    const select = this.sql<Row[]>`
      select account.id::text,
             account.label,
             account.status as account_status,
             account.monitor_active as active,
             count(source.id)::int as source_count,
             count(source.id) filter (where source.status = 'READY')::int as ready_source_count,
             account.last_runtime_error_code
        from public.telegram_accounts account
        left join public.auto_comment_monitor_sources source
          on source.monitor_account_id = account.id
       where account.account_type = 'MONITOR'
         ${accountId ? this.sql`and account.id = ${accountId}::uuid` : this.sql``}
       group by account.id
       order by account.created_at, account.id
    `;
    return select;
  }
}
