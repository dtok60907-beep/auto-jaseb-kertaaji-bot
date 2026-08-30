import type { Sql } from "postgres";

import type { ActiveAdminSession, AdminAccessRepository } from "./admin-access-repository.ts";

type ActiveAdminRow = Readonly<{
  session_id: string;
  user_id: string;
  expires_at: string;
}>;

export class PostgresAdminAccessRepository implements AdminAccessRepository {
  readonly sql: Sql;

  constructor(sql: Sql) {
    this.sql = sql;
  }

  async findActiveByTokenHash(tokenHash: Uint8Array): Promise<ActiveAdminSession | null> {
    const rows = await this.sql<ActiveAdminRow[]>`
      select session.id::text as session_id,
             session.user_id::text,
             session.expires_at::text
        from public.api_sessions session
        join public.app_admins admin
          on admin.user_id = session.user_id
         and admin.revoked_at is null
       where session.token_hash = ${Buffer.from(tokenHash)}
         and session.revoked_at is null
         and session.expires_at > now()
       limit 1
    `;
    const row = rows[0];
    return row ? Object.freeze({
      sessionId: row.session_id,
      userId: row.user_id,
      expiresAt: row.expires_at,
    }) : null;
  }
}
