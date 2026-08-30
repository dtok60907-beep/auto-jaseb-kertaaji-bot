import type { Sql } from "postgres";

import type {
  CanaryAdminChange,
  CanaryAdmissionChange,
  CanaryOperatorRepository,
  CanaryOperatorView,
} from "./canary-operator.ts";

type AdmissionRow = Readonly<{
  admission_status: CanaryAdmissionChange["status"];
  assigned_slot: number | null;
}>;

type UserRow = Readonly<{ user_id: string }>;

type ViewRow = Readonly<{
  telegram_user_id: string;
  slot: number | null;
  admitted_at: string;
  revoked_at: string | null;
  app_user_ready: boolean;
  admin_active: boolean;
}>;

export class PostgresCanaryOperatorRepository implements CanaryOperatorRepository {
  readonly sql: Sql;

  constructor(sql: Sql) {
    this.sql = sql;
  }

  async setAdmission(telegramUserId: string, enabled: boolean): Promise<CanaryAdmissionChange> {
    const rows = await this.sql<AdmissionRow[]>`
      select admission_status, assigned_slot
        from public.set_canary_admission(${telegramUserId}::bigint, ${enabled})
    `;
    const row = rows[0];
    if (!row) throw new Error("CANARY_ADMISSION_RESULT_MISSING");
    return Object.freeze({
      status: row.admission_status,
      telegramUserId,
      slot: row.assigned_slot,
    });
  }

  async setAdmin(telegramUserId: string, enabled: boolean): Promise<CanaryAdminChange> {
    if (enabled) {
      const rows = await this.sql<UserRow[]>`
        insert into public.app_admins (user_id, granted_at, revoked_at)
        select app_user.id, now(), null
          from public.app_users app_user
         where app_user.telegram_user_id = ${telegramUserId}::bigint
        on conflict (user_id) do update
          set granted_at = excluded.granted_at,
              revoked_at = null
        returning user_id::text
      `;
      return Object.freeze({
        status: rows[0] ? "ADMIN_GRANTED" : "APP_USER_NOT_FOUND",
        telegramUserId,
      });
    }
    const rows = await this.sql<UserRow[]>`
      update public.app_admins admin
         set revoked_at = now()
        from public.app_users app_user
       where admin.user_id = app_user.id
         and app_user.telegram_user_id = ${telegramUserId}::bigint
         and admin.revoked_at is null
      returning admin.user_id::text
    `;
    return Object.freeze({
      status: rows[0] ? "ADMIN_REVOKED" : "ADMIN_NOT_ACTIVE",
      telegramUserId,
    });
  }

  async list(): Promise<readonly CanaryOperatorView[]> {
    const rows = await this.sql<ViewRow[]>`
      select admission.telegram_user_id::text,
             admission.slot,
             admission.admitted_at::text,
             admission.revoked_at::text,
             (app_user.id is not null) as app_user_ready,
             (admin.user_id is not null and admin.revoked_at is null) as admin_active
        from public.canary_admissions admission
        left join public.app_users app_user
          on app_user.telegram_user_id = admission.telegram_user_id
        left join public.app_admins admin
          on admin.user_id = app_user.id
       order by admission.slot nulls last, admission.telegram_user_id
    `;
    return Object.freeze(rows.map((row) => Object.freeze({
      telegramUserId: row.telegram_user_id,
      slot: row.slot,
      admittedAt: row.admitted_at,
      revokedAt: row.revoked_at,
      appUserReady: row.app_user_ready,
      adminActive: row.admin_active,
    })));
  }
}
