import type { Sql } from "postgres";

import type {
  ActiveApiSession,
  ApiSessionIssueInput,
  ApiSessionIssueResult,
  ApiSessionRepository,
} from "./api-session-repository.ts";

type IssueRow = Readonly<{
  result_status: "CREATED" | "REPLAY" | "ACCESS_DENIED";
  resolved_user_id: string | null;
  created_session_id: string | null;
  session_expires_at: string | null;
}>;

type ActiveRow = Readonly<{
  session_id: string;
  user_id: string;
  expires_at: string;
}>;

export class PostgresApiSessionRepository implements ApiSessionRepository {
  readonly sql: Sql;

  constructor(sql: Sql) {
    this.sql = sql;
  }

  async issue(input: ApiSessionIssueInput): Promise<ApiSessionIssueResult> {
    const identity = input.identity;
    const rows = await this.sql<IssueRow[]>`
      select result_status,
             resolved_user_id::text,
             created_session_id::text,
             session_expires_at::text
        from public.issue_telegram_mini_app_session(
          ${identity.telegramUserId}::bigint,
          ${identity.firstName},
          ${identity.lastName},
          ${identity.username},
          ${identity.languageCode},
          ${identity.isPremium},
          ${identity.allowsWriteToPm},
          to_timestamp(${identity.authDateSeconds}),
          ${Buffer.from(input.tokenHash)},
          ${Buffer.from(input.initDataHash)},
          ${input.expiresAt}::timestamptz
        )
    `;
    const row = rows[0];
    if (!row) throw new Error("API_SESSION_NOT_ISSUED");
    if (row.result_status === "REPLAY") return Object.freeze({ status: "REPLAY" });
    if (row.result_status === "ACCESS_DENIED") return Object.freeze({ status: "ACCESS_DENIED" });
    if (!row.resolved_user_id || !row.created_session_id || !row.session_expires_at) {
      throw new Error("API_SESSION_RESULT_INVALID");
    }
    return Object.freeze({
      status: "CREATED",
      userId: row.resolved_user_id,
      sessionId: row.created_session_id,
      expiresAt: row.session_expires_at,
    });
  }

  async findActiveByTokenHash(tokenHash: Uint8Array): Promise<ActiveApiSession | null> {
    const rows = await this.sql<ActiveRow[]>`
      select id::text as session_id, user_id::text, expires_at::text
        from public.api_sessions
       where token_hash = ${Buffer.from(tokenHash)}
         and revoked_at is null
         and expires_at > now()
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
