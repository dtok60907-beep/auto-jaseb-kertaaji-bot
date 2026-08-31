import type { Sql } from "postgres";

import type {
  TelegramAccountAuthFlowResult,
  TelegramAccountAuthFlowClaim,
  TelegramAccountAuthCompletion,
  TelegramAccountAuthFlowStatus,
  TelegramAccountLifecycleRepository,
  TelegramAccountView,
} from "./repository.ts";

type FlowRow = {
  result_status: TelegramAccountAuthFlowResult["result"];
  auth_flow_id?: string | null;
  auth_flow_status: TelegramAccountAuthFlowStatus | null;
  auth_flow_version: string | bigint | null;
  auth_flow_expires_at: string | null;
};

type AccountRow = {
  id: string;
  label: string;
  status: TelegramAccountView["status"];
  active: boolean;
  session_present: boolean;
  session_authenticated_at: string | null;
  session_revoked_at: string | null;
  last_runtime_error_code: string | null;
};

type ClaimRow = {
  result_status: TelegramAccountAuthFlowClaim["result"];
  auth_flow_status: TelegramAccountAuthFlowStatus | null;
  auth_flow_version: string | bigint | null;
  auth_flow_expires_at: string | null;
  auth_flow_encrypted_state: Buffer | null;
  auth_flow_encryption_key_version: number | null;
};

type CompletionRow = {
  result_status: TelegramAccountAuthCompletion["result"];
  account_id: string | null;
  account_label: string | null;
  auth_flow_version: string | bigint | null;
};

function flow(row: FlowRow, fallbackId: string | null = null): TelegramAccountAuthFlowResult {
  return Object.freeze({
    result: row.result_status,
    id: row.auth_flow_id ?? fallbackId,
    status: row.auth_flow_status,
    version: row.auth_flow_version === null ? null : BigInt(row.auth_flow_version),
    expiresAt: row.auth_flow_expires_at,
  });
}

function account(row: AccountRow): TelegramAccountView {
  return Object.freeze({
    id: row.id,
    label: row.label,
    status: row.status,
    active: row.active,
    sessionPresent: row.session_present,
    authenticatedAt: row.session_authenticated_at,
    revokedAt: row.session_revoked_at,
    lastErrorCode: row.last_runtime_error_code,
  });
}

export class PostgresTelegramAccountLifecycleRepository implements TelegramAccountLifecycleRepository {
  readonly sql: Sql;

  constructor(sql: Sql) {
    this.sql = sql;
  }

  async beginAuthFlow(userId: string, ttlSeconds: number) {
    const rows = await this.sql<FlowRow[]>`
      select result_status, auth_flow_id::text, auth_flow_status,
             auth_flow_version::text, auth_flow_expires_at::text
        from public.begin_userbot_auth_flow(${userId}::uuid, ${ttlSeconds})
    `;
    if (!rows[0]) throw new Error("telegram auth flow was not returned");
    return flow(rows[0]);
  }

  async transitionAuthFlow(input: Parameters<TelegramAccountLifecycleRepository["transitionAuthFlow"]>[0]) {
    const encryptedState = input.encryptedState ? Buffer.from(input.encryptedState) : null;
    try {
      const rows = await this.sql<FlowRow[]>`
        select result_status, auth_flow_status, auth_flow_version::text,
               auth_flow_expires_at::text
          from public.transition_userbot_auth_flow(
            ${input.userId}::uuid,
            ${input.authFlowId}::uuid,
            ${input.expectedVersion.toString()}::bigint,
            ${input.nextStatus},
            ${encryptedState},
            ${input.encryptionKeyVersion ?? null},
            ${input.errorCode ?? null}
          )
      `;
      if (!rows[0]) throw new Error("telegram auth transition was not returned");
      return flow(rows[0], input.authFlowId);
    } finally {
      encryptedState?.fill(0);
    }
  }

  async claimAuthFlowStep(input: Parameters<TelegramAccountLifecycleRepository["claimAuthFlowStep"]>[0]) {
    const rows = await this.sql<ClaimRow[]>`
      select result_status, auth_flow_status, auth_flow_version::text,
             auth_flow_expires_at::text, auth_flow_encrypted_state,
             auth_flow_encryption_key_version
        from public.claim_userbot_auth_flow_step(
          ${input.userId}::uuid,
          ${input.authFlowId}::uuid,
          ${input.expectedVersion.toString()}::bigint,
          ${input.expectedStatus}
        )
    `;
    const row = rows[0];
    if (!row) throw new Error("telegram auth flow claim was not returned");
    return Object.freeze({
      result: row.result_status,
      status: row.auth_flow_status,
      version: row.auth_flow_version === null ? null : BigInt(row.auth_flow_version),
      expiresAt: row.auth_flow_expires_at,
      encryptedState: row.auth_flow_encrypted_state === null
        ? null
        : Uint8Array.from(row.auth_flow_encrypted_state),
      encryptionKeyVersion: row.auth_flow_encryption_key_version,
    });
  }

  async completeAuthFlow(input: Parameters<TelegramAccountLifecycleRepository["completeAuthFlow"]>[0]) {
    const encryptedSession = Buffer.from(input.encryptedSession);
    try {
      const rows = await this.sql<CompletionRow[]>`
        select result_status, account_id::text, account_label, auth_flow_version::text
          from public.complete_userbot_auth_flow(
            ${input.userId}::uuid,
            ${input.authFlowId}::uuid,
            ${input.expectedVersion.toString()}::bigint,
            ${input.providerUserId}::bigint,
            ${input.label},
            ${encryptedSession},
            ${input.encryptionKeyVersion}
          )
      `;
      const row = rows[0];
      if (!row) throw new Error("telegram auth flow completion was not returned");
      return Object.freeze({
        result: row.result_status,
        accountId: row.account_id,
        label: row.account_label,
        version: row.auth_flow_version === null ? null : BigInt(row.auth_flow_version),
      });
    } finally {
      encryptedSession.fill(0);
    }
  }

  async expireAuthFlows(at: string) {
    const rows = await this.sql<{ expired_count: number }[]>`
      select public.expire_userbot_auth_flows(${at}::timestamptz) expired_count
    `;
    return rows[0]?.expired_count ?? 0;
  }

  async listOwnedAccounts(userId: string) {
    const rows = await this.sql<AccountRow[]>`
      select account.id::text, account.label, account.status,
             coalesce(profile.active_account_id = account.id, false) as active,
             account.encrypted_session is not null as session_present,
             account.session_authenticated_at::text,
             account.session_revoked_at::text,
             account.last_runtime_error_code
        from public.telegram_accounts account
        left join public.userbot_profiles profile on profile.user_id = account.owner_user_id
       where account.owner_user_id = ${userId}::uuid
         and account.account_type = 'USERBOT'
       order by account.created_at, account.id
    `;
    return Object.freeze(rows.map(account));
  }

  async revokeSession(userId: string, accountId: string) {
    const rows = await this.sql<{ result_status: "REVOKED" | "ALREADY_REVOKED" | "NOT_FOUND" }[]>`
      select public.revoke_userbot_account_session(
        ${userId}::uuid, ${accountId}::uuid
      ) result_status
    `;
    return rows[0]?.result_status ?? "NOT_FOUND";
  }
}
