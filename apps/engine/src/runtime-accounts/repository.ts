import type { ShardConfig } from "../runtime-sharding/shard.ts";

export type TelegramRuntimeAccountType = "JASEB_WORKER" | "USERBOT";

export type BroadcastRuntimeAccount = Readonly<{
  accountId: string;
  accountType: TelegramRuntimeAccountType;
  nextDueAt: string;
  hasPreparationWork: boolean;
  hasDeliveryWork: boolean;
  requiresRecovery: boolean;
}>;

export type LeasedTelegramSession = Readonly<{
  accountId: string;
  accountType: TelegramRuntimeAccountType;
  encryptedSession: Uint8Array;
  encryptionKeyVersion: number;
}>;

export type RuntimeLeaseIdentity = Readonly<{
  accountId: string;
  leaseOwner: string;
  fencingToken: bigint;
}>;

export type TelegramRuntimeResult =
  | Readonly<{ status: "CONNECTED" | "DISCONNECTED" }>
  | Readonly<{ status: "FAILED_RETRYABLE"; errorCode: string; retryAfterSeconds: number }>
  | Readonly<{ status: "DEGRADED" | "REVOKED"; errorCode: string }>;

export type RuntimeWakeupListener = (accountId: string) => void;
export type RuntimeWakeupSubscription = Readonly<{ close(): Promise<void> }>;

export interface BroadcastRuntimeAccountRepository {
  listDue(input: Readonly<{ shard: ShardConfig; limit: number }>): Promise<readonly BroadcastRuntimeAccount[]>;
  findNext(input: Readonly<{ shard: ShardConfig }>): Promise<BroadcastRuntimeAccount | null>;
  loadSession(input: RuntimeLeaseIdentity): Promise<LeasedTelegramSession | null>;
  recordResult(input: RuntimeLeaseIdentity & Readonly<{ result: TelegramRuntimeResult }>): Promise<boolean>;
  subscribeWakeups(listener: RuntimeWakeupListener): Promise<RuntimeWakeupSubscription>;
}
