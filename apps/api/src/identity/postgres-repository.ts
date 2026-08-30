import type { Sql } from "postgres";

import type { TelegramMiniAppIdentity } from "../auth/telegram-mini-app.ts";
import type { ApplicationUser, ApplicationUserRepository } from "./repository.ts";

type IdentityRow = Readonly<{ id: string }>;

export class PostgresApplicationUserRepository implements ApplicationUserRepository {
  readonly sql: Sql;

  constructor(sql: Sql) {
    this.sql = sql;
  }

  async resolve(identity: TelegramMiniAppIdentity): Promise<ApplicationUser> {
    const rows = await this.sql<IdentityRow[]>`
      select public.upsert_telegram_mini_app_user(
        ${identity.telegramUserId}::bigint,
        ${identity.firstName},
        ${identity.lastName},
        ${identity.username},
        ${identity.languageCode},
        ${identity.isPremium},
        ${identity.allowsWriteToPm},
        to_timestamp(${identity.authDateSeconds})
      )::text as id
    `;
    const id = rows[0]?.id;
    if (!id) throw new Error("APPLICATION_USER_NOT_RESOLVED");
    return Object.freeze({ id, telegramUserId: identity.telegramUserId });
  }
}
