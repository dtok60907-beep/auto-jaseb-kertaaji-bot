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

export type SessionRole = "ADMIN" | "USER";

export type CurrentUser = Readonly<{
  id: string;
  role: SessionRole;
}>;

export type PackageType = "JASEB_WORKER" | "USERBOT";
export type PackageFeature = "JASEB" | "AUTO_COMMENT_MF";

export type ServicePackage = Readonly<{
  id: string;
  code: string;
  name: string;
  type: PackageType;
  priceIdr: number;
  durationDays: number;
  features: readonly PackageFeature[];
  maxTargetsPerMinute: number;
  maxAccounts: number;
  intervalMinSeconds: number;
  intervalMaxSeconds: number;
  displayOrder: number;
  active: boolean;
  version: number;
}>;

export type PackageInput = Readonly<{
  code?: string;
  name: string;
  type: PackageType;
  priceIdr: number;
  durationDays: number;
  features: readonly PackageFeature[];
  maxTargetsPerMinute: number;
  maxAccounts: number;
  intervalMinSeconds: number;
  intervalMaxSeconds: number;
  displayOrder: number;
  active: boolean;
}>;

export type AdminUser = Readonly<{
  id: string;
  telegramUserId: string;
  firstName: string;
  username: string | null;
  lastAuthenticatedAt: string | null;
  isAdmin: boolean;
}>;

export type Entitlement = Readonly<{
  id: string;
  userId: string;
  packageId: string;
  packageType: PackageType;
  status: string;
  startsAt: string;
  expiresAt: string;
  maxLpmGroups: number;
  maxChannelTargets: number;
}>;

export type WorkerAccount = Readonly<{
  id: string;
  label: string;
  accountStatus: "DISCONNECTED" | "READY" | "DEGRADED" | "REVOKED" | "DISABLED";
  intervalSeconds: number | null;
  active: boolean | null;
  availability: "READY" | "NOT_CONFIGURED" | "DISABLED" | "ACCOUNT_NOT_READY";
}>;
