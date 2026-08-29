import type { Sql } from "postgres";
import type { WorkerAccountSettingsRepository, WorkerAccountView } from "./repository.ts";

type Row = { id: string; label: string; account_status: WorkerAccountView["accountStatus"]; interval_seconds: number | null; active: boolean | null };
function view(row: Row): WorkerAccountView {
  const availability = row.interval_seconds === null ? "NOT_CONFIGURED" : !row.active ? "DISABLED" : row.account_status !== "READY" ? "ACCOUNT_NOT_READY" : "READY";
  return Object.freeze({ id: row.id, label: row.label, accountStatus: row.account_status, intervalSeconds: row.interval_seconds, active: row.active, availability });
}
export class PostgresWorkerAccountSettingsRepository implements WorkerAccountSettingsRepository {
  constructor(readonly sql: Sql) {}
  async list(): Promise<readonly WorkerAccountView[]> { return Object.freeze((await this.rows()).map(view)); }
  async update(input: Readonly<{ accountId: string; intervalSeconds: number; active: boolean }>): Promise<WorkerAccountView | null> {
    const rows = await this.sql<Row[]>`
      insert into public.worker_account_settings (worker_account_id, interval_seconds, active)
      select id, ${input.intervalSeconds}, ${input.active}
        from public.telegram_accounts
       where id = ${input.accountId}::uuid and account_type = 'JASEB_WORKER'
      on conflict (worker_account_id) do update
        set interval_seconds = excluded.interval_seconds, active = excluded.active
      returning worker_account_id::text as id
    `;
    if (!rows[0]) return null;
    const row = (await this.rows(input.accountId))[0];
    if (!row) throw new Error("worker account setting was not persisted");
    return view(row);
  }
  private rows(accountId?: string) {
    return accountId
      ? this.sql<Row[]>`select account.id::text, account.label, account.status as account_status, setting.interval_seconds, setting.active from public.telegram_accounts account left join public.worker_account_settings setting on setting.worker_account_id = account.id where account.id = ${accountId}::uuid and account.account_type = 'JASEB_WORKER'`
      : this.sql<Row[]>`select account.id::text, account.label, account.status as account_status, setting.interval_seconds, setting.active from public.telegram_accounts account left join public.worker_account_settings setting on setting.worker_account_id = account.id where account.account_type = 'JASEB_WORKER' order by account.created_at, account.id`;
  }
}
