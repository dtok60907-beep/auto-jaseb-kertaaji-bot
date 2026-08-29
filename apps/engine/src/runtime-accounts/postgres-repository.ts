import type { Sql } from "postgres";

import type {
  BroadcastRuntimeAccount,
  BroadcastRuntimeAccountRepository,
  LeasedTelegramSession,
  TelegramRuntimeAccountType,
  TelegramRuntimeResult,
} from "./repository.ts";

export const BROADCAST_RUNTIME_WAKEUP_CHANNEL = "jaseb_broadcast_runtime";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type DiscoveryRow = Readonly<{
  account_id: string;
  account_type: string;
  next_due_at: Date | string;
  has_preparation_work: boolean;
  has_delivery_work: boolean;
  requires_recovery: boolean;
}>;

type SessionRow = Readonly<{
  account_id: string;
  account_type: string;
  encrypted_session: Uint8Array;
  encryption_key_version: number;
}>;

function accountType(value: string): TelegramRuntimeAccountType {
  if (value !== "JASEB_WORKER" && value !== "USERBOT") throw new Error("INVALID_RUNTIME_ACCOUNT_TYPE");
  return value;
}

function timestamp(value: Date | string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("INVALID_RUNTIME_TIMESTAMP");
  return parsed.toISOString();
}

function discoveryAccount(row: DiscoveryRow): BroadcastRuntimeAccount {
  return Object.freeze({
    accountId: row.account_id,
    accountType: accountType(row.account_type),
    nextDueAt: timestamp(row.next_due_at),
    hasPreparationWork: row.has_preparation_work,
    hasDeliveryWork: row.has_delivery_work,
    requiresRecovery: row.requires_recovery,
  });
}

function session(row: SessionRow): LeasedTelegramSession {
  if (!Number.isInteger(row.encryption_key_version) || row.encryption_key_version <= 0) {
    throw new Error("INVALID_SESSION_KEY_VERSION");
  }
  return Object.freeze({
    accountId: row.account_id,
    accountType: accountType(row.account_type),
    encryptedSession: Uint8Array.from(row.encrypted_session),
    encryptionKeyVersion: row.encryption_key_version,
  });
}

function runtimeResultParameters(result: TelegramRuntimeResult): readonly [string, string | null, number | null] {
  switch (result.status) {
    case "CONNECTED":
    case "DISCONNECTED":
      return [result.status, null, null];
    case "FAILED_RETRYABLE":
      return [result.status, result.errorCode, result.retryAfterSeconds];
    case "DEGRADED":
    case "REVOKED":
      return [result.status, result.errorCode, null];
  }
}

export class PostgresBroadcastRuntimeAccountRepository implements BroadcastRuntimeAccountRepository {
  readonly sql: Sql;

  constructor(sql: Sql) {
    this.sql = sql;
  }

  async listDue(input: Parameters<BroadcastRuntimeAccountRepository["listDue"]>[0]): Promise<readonly BroadcastRuntimeAccount[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1000) throw new Error("INVALID_DISCOVERY_LIMIT");
    const rows = await this.sql<DiscoveryRow[]>`
      select account_id::text, account_type, next_due_at,
             has_preparation_work, has_delivery_work, requires_recovery
        from public.list_broadcast_runtime_accounts(
          ${input.shard.shardCount}, ${input.shard.shardIndex}, now(), ${input.limit}
        )
    `;
    return Object.freeze(rows.map(discoveryAccount));
  }

  async findNext(input: Parameters<BroadcastRuntimeAccountRepository["findNext"]>[0]): Promise<BroadcastRuntimeAccount | null> {
    const rows = await this.sql<DiscoveryRow[]>`
      select account_id::text, account_type, next_due_at,
             has_preparation_work, has_delivery_work, requires_recovery
        from public.list_broadcast_runtime_accounts(
          ${input.shard.shardCount}, ${input.shard.shardIndex}, 'infinity'::timestamptz, 1
        )
    `;
    return rows[0] ? discoveryAccount(rows[0]) : null;
  }

  async loadSession(input: Parameters<BroadcastRuntimeAccountRepository["loadSession"]>[0]): Promise<LeasedTelegramSession | null> {
    const rows = await this.sql<SessionRow[]>`
      select account_id::text, account_type, encrypted_session, encryption_key_version
        from public.load_telegram_session_for_runtime(
          ${input.accountId}::uuid, ${input.leaseOwner}::uuid,
          ${input.fencingToken.toString()}::bigint
        )
    `;
    return rows[0] ? session(rows[0]) : null;
  }

  async recordResult(input: Parameters<BroadcastRuntimeAccountRepository["recordResult"]>[0]): Promise<boolean> {
    const [status, errorCode, retryAfterSeconds] = runtimeResultParameters(input.result);
    const rows = await this.sql<{ recorded: boolean }[]>`
      select public.record_telegram_account_runtime_result(
        ${input.accountId}::uuid, ${input.leaseOwner}::uuid,
        ${input.fencingToken.toString()}::bigint,
        ${status}, ${errorCode}, ${retryAfterSeconds}
      ) recorded
    `;
    return rows[0]?.recorded ?? false;
  }

  async subscribeWakeups(listener: Parameters<BroadcastRuntimeAccountRepository["subscribeWakeups"]>[0]) {
    const handle = await this.sql.listen(BROADCAST_RUNTIME_WAKEUP_CHANNEL, (payload) => {
      if (UUID.test(payload)) listener(payload.toLowerCase());
    });
    return Object.freeze({ close: () => handle.unlisten() });
  }
}
