export type AccountStatus = "CONNECTING" | "DISCONNECTED" | "READY" | "DEGRADED" | "REVOKED" | "DISABLED";

export type TelegramAccount = Readonly<{
  id: string;
  label: string;
  status: AccountStatus;
  active: boolean;
  sessionPresent: boolean;
  authenticatedAt: string | null;
  revokedAt: string | null;
  lastErrorCode: string | null;
}>;

export type AuthFlow = Readonly<{
  id: string;
  status: "CODE_REQUIRED" | "PASSWORD_REQUIRED";
  version: number;
  expiresAt: string;
  codeDelivery?: "APP" | "SMS";
}>;

export type AuthorizationResult =
  | Readonly<{ status: "CODE_REQUIRED"; flow: AuthFlow }>
  | Readonly<{ status: "PASSWORD_REQUIRED"; flow: AuthFlow }>
  | Readonly<{ status: "CONNECTED"; account: Readonly<{ id: string; label: string }> }>;

export type IssuedSession = Readonly<{
  accessToken: string;
  tokenType: "Bearer";
  expiresAt: string;
  user: Readonly<{ id: string; telegramUserId: string }>;
}>;
