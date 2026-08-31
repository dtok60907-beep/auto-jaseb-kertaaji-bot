import type { Sql } from "postgres";

import type { AdminUserRepository, AdminUserView } from "./repository.ts";

type AdminUserRow = Readonly<{
  id: string;
  telegram_user_id: string;
  first_name: string;
  username: string | null;
  last_authenticated_at: string | null;
  is_admin: boolean;
}>;

export class PostgresAdminUserRepository implements AdminUserRepository {
  readonly sql: Sql;

  constructor(sql: Sql) {
    this.sql = sql;
  }

  async list(input: Readonly<{ query: string; limit: number }>): Promise<readonly AdminUserView[]> {
    const query = input.query.trim();
    const pattern = `%${query}%`;
    const rows = await this.sql<AdminUserRow[]>`
      select app_user.id::text,
             app_user.telegram_user_id::text,
             app_user.first_name,
             app_user.username,
             app_user.last_authenticated_at::text,
             (admin.user_id is not null and admin.revoked_at is null) as is_admin
        from public.app_users app_user
        left join public.app_admins admin
          on admin.user_id = app_user.id
       where app_user.telegram_user_id is not null
         and (
           ${query} = ''
           or app_user.telegram_user_id::text = ${query}
           or app_user.first_name ilike ${pattern}
           or coalesce(app_user.username, '') ilike ${pattern}
         )
       order by app_user.last_authenticated_at desc nulls last, app_user.created_at desc
       limit ${input.limit}
    `;
    return Object.freeze(rows.map((row) => Object.freeze({
      id: row.id,
      telegramUserId: row.telegram_user_id,
      firstName: row.first_name,
      username: row.username,
      lastAuthenticatedAt: row.last_authenticated_at,
      isAdmin: row.is_admin,
    })));
  }
}
