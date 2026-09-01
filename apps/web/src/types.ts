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

export type ForwardBroadcastSource = Readonly<{
  channelUsername: string;
  messageId: number;
  canonicalLink: string;
}>;

export type BroadcastMaterialPayload =
  | Readonly<{ kind: "TEXT"; text: string }>
  | Readonly<{ kind: "FORWARD"; source: ForwardBroadcastSource; sourceAttribution: "SHOW_SOURCE" | "HIDE_SOURCE" }>;

export type BroadcastMaterial = Readonly<{ id: string; active: boolean }> & BroadcastMaterialPayload;

export type BroadcastOperationMaterial = Readonly<{ id: string }> & BroadcastMaterialPayload;

export type BroadcastLpmTarget = Readonly<{
  id: string;
  telegramTargetRef: string;
  label: string | null;
  active: boolean;
}>;

export type BroadcastOperationTarget = Readonly<{
  id: string;
  sourceLpmTargetId: string;
  telegramTargetRef: string;
  sequenceNumber: number;
  preparationStatus: string;
  deliveryStatus: string;
  lastErrorCode: string | null;
}>;

export type BroadcastOperation = Readonly<{
  id: string;
  accountId: string;
  accountMode: "JASEB_WORKER" | "USERBOT";
  status: string;
  intervalSeconds: number;
  material: BroadcastOperationMaterial;
  targets: readonly BroadcastOperationTarget[];
}>;

export type BroadcastHistoryEntry = Readonly<{
  id: string;
  accountId: string;
  accountLabel: string;
  telegramTargetRef: string;
  resolvedTitle: string | null;
  sentAt: string;
  bubbleLink: string | null;
}>;

export type BroadcastCampaign = Readonly<{
  id: string;
  accountMode: "JASEB_WORKER" | "USERBOT";
  materialId: string;
  targetIds: readonly string[];
  intervalSeconds: number;
  status: "ACTIVE" | "STOPPED";
  errorCode: string | null;
  lastCycleAt: string | null;
  nextCycleAt: string;
  lastOperationId: string | null;
}>;
