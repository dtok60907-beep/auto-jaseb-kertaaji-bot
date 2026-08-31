export type TelegramAccountAuthFlowStatus =
  | "CREATED"
  | "CODE_REQUIRED"
  | "PASSWORD_REQUIRED"
  | "VERIFYING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "EXPIRED";

export type TelegramAccountAuthFlowResult = Readonly<{
  result: "CREATED" | "ACTIVE_FLOW_EXISTS" | "UPDATED" | "NOT_FOUND" | "FLOW_TERMINAL" | "FLOW_EXPIRED" | "VERSION_CONFLICT";
  id: string | null;
  status: TelegramAccountAuthFlowStatus | null;
  version: bigint | null;
  expiresAt: string | null;
}>;

export type TelegramAccountView = Readonly<{
  id: string;
  label: string;
  status: "CONNECTING" | "DISCONNECTED" | "READY" | "DEGRADED" | "REVOKED" | "DISABLED";
  active: boolean;
  sessionPresent: boolean;
  authenticatedAt: string | null;
  revokedAt: string | null;
  lastErrorCode: string | null;
}>;

export interface TelegramAccountLifecycleRepository {
  beginAuthFlow(userId: string, ttlSeconds: number): Promise<TelegramAccountAuthFlowResult>;
  transitionAuthFlow(input: Readonly<{
    userId: string;
    authFlowId: string;
    expectedVersion: bigint;
    nextStatus: "CODE_REQUIRED" | "PASSWORD_REQUIRED" | "VERIFYING" | "FAILED" | "CANCELLED";
    encryptedState?: Uint8Array;
    encryptionKeyVersion?: number;
    errorCode?: string;
  }>): Promise<TelegramAccountAuthFlowResult>;
  expireAuthFlows(at: string): Promise<number>;
  listOwnedAccounts(userId: string): Promise<readonly TelegramAccountView[]>;
  revokeSession(userId: string, accountId: string): Promise<"REVOKED" | "ALREADY_REVOKED" | "NOT_FOUND">;
}
