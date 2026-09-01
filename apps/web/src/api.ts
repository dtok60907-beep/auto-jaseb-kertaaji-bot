import type {
  AdminUser,
  AuthFlow,
  AuthorizationResult,
  BroadcastCampaign,
  BroadcastHistoryEntry,
  BroadcastLpmTarget,
  BroadcastMaterial,
  BroadcastOperation,
  CurrentUser,
  Entitlement,
  IssuedSession,
  PackageInput,
  ServicePackage,
  TelegramAccount,
  WorkerAccount,
} from "./types";

const runtimeApiBase = typeof window !== "undefined" ? window.__JASEB_RUNTIME_CONFIG__?.apiBaseUrl : undefined;
const API_ROOT = (runtimeApiBase ?? import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(`${API_ROOT}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, "NETWORK_UNAVAILABLE");
  }

  const raw = await response.text();
  let body: unknown = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
  if (!response.ok) {
    const code = typeof body === "object" && body !== null && "code" in body
      && typeof (body as { code?: unknown }).code === "string"
      ? (body as { code: string }).code
      : "REQUEST_FAILED";
    throw new ApiError(response.status, code);
  }
  return body as T;
}

export function exchangeTelegramInitData(initData: string): Promise<IssuedSession> {
  return request<IssuedSession>("/v1/auth/telegram", {
    method: "POST",
    body: JSON.stringify({ initData }),
  });
}

export async function getCurrentUser(token: string): Promise<CurrentUser> {
  const result = await request<{ user: CurrentUser }>("/v1/me", {}, token);
  return result.user;
}

export async function listTelegramAccounts(token: string): Promise<readonly TelegramAccount[]> {
  const result = await request<{ accounts: readonly TelegramAccount[] }>(
    "/v1/userbot/telegram-accounts", {}, token,
  );
  return result.accounts;
}

export function startTelegramAuthorization(token: string, phoneNumber: string): Promise<AuthorizationResult> {
  return request<AuthorizationResult>("/v1/userbot/telegram-auth-flows", {
    method: "POST",
    body: JSON.stringify({ phoneNumber }),
  }, token);
}

export function submitTelegramCode(
  token: string, flow: Pick<AuthFlow, "id" | "version">, code: string,
): Promise<AuthorizationResult> {
  return request<AuthorizationResult>(`/v1/userbot/telegram-auth-flows/${flow.id}/code`, {
    method: "POST",
    body: JSON.stringify({ version: flow.version, code }),
  }, token);
}

export function submitTelegramPassword(
  token: string, flow: Pick<AuthFlow, "id" | "version">, password: string,
): Promise<AuthorizationResult> {
  return request<AuthorizationResult>(`/v1/userbot/telegram-auth-flows/${flow.id}/password`, {
    method: "POST",
    body: JSON.stringify({ version: flow.version, password }),
  }, token);
}

export function cancelTelegramAuthorization(token: string, flow: Pick<AuthFlow, "id" | "version">): Promise<void> {
  return request<void>(`/v1/userbot/telegram-auth-flows/${flow.id}/cancel`, {
    method: "POST",
    body: JSON.stringify({ version: flow.version }),
  }, token);
}

export function switchTelegramAccount(token: string, accountId: string): Promise<void> {
  return request<void>(`/v1/userbot/telegram-accounts/${accountId}/switch`, { method: "POST" }, token);
}

export function detachTelegramAccount(token: string): Promise<void> {
  return request<void>("/v1/userbot/telegram-accounts/detach", { method: "POST" }, token);
}

export function logoutTelegramAccount(token: string, accountId: string): Promise<void> {
  return request<void>(`/v1/userbot/telegram-accounts/${accountId}/session`, { method: "DELETE" }, token);
}

export async function listAdminUsers(token: string, query = ""): Promise<readonly AdminUser[]> {
  const params = new URLSearchParams();
  if (query.trim()) params.set("q", query.trim());
  const suffix = params.size > 0 ? `?${params}` : "";
  const result = await request<{ users: readonly AdminUser[] }>(`/v1/admin/users${suffix}`, {}, token);
  return result.users;
}

export async function listAdminPackages(token: string): Promise<readonly ServicePackage[]> {
  const result = await request<{ packages: readonly ServicePackage[] }>("/v1/admin/packages", {}, token);
  return result.packages;
}

export async function createAdminPackage(token: string, input: Required<PackageInput>): Promise<ServicePackage> {
  const result = await request<{ package: ServicePackage }>("/v1/admin/packages", {
    method: "POST",
    body: JSON.stringify(input),
  }, token);
  return result.package;
}

export async function updateAdminPackage(token: string, packageId: string, input: Omit<PackageInput, "code">): Promise<ServicePackage> {
  const result = await request<{ package: ServicePackage }>(`/v1/admin/packages/${packageId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  }, token);
  return result.package;
}

export async function listEntitlements(token: string, userId: string): Promise<readonly Entitlement[]> {
  const result = await request<{ entitlements: readonly Entitlement[] }>(`/v1/admin/users/${userId}/entitlements`, {}, token);
  return result.entitlements;
}

export async function grantEntitlement(
  token: string,
  userId: string,
  input: Readonly<{ packageId: string; durationDays: number; maxLpmGroups: number; maxChannelTargets: number }>,
): Promise<Entitlement> {
  const result = await request<{ entitlement: Entitlement }>(`/v1/admin/users/${userId}/entitlements`, {
    method: "POST",
    body: JSON.stringify(input),
  }, token);
  return result.entitlement;
}

export async function extendEntitlement(token: string, entitlementId: string, durationDays: number): Promise<Entitlement> {
  const result = await request<{ entitlement: Entitlement }>(`/v1/admin/entitlements/${entitlementId}/extend`, {
    method: "POST",
    body: JSON.stringify({ durationDays }),
  }, token);
  return result.entitlement;
}

export function revokeEntitlement(token: string, entitlementId: string): Promise<void> {
  return request<void>(`/v1/admin/entitlements/${entitlementId}/revoke`, { method: "POST" }, token);
}

export type BroadcastSettings = Readonly<{
  materials: readonly BroadcastMaterial[];
  lpmTargets: readonly BroadcastLpmTarget[];
  accountMode: "JASEB_WORKER" | "USERBOT" | null;
}>;

export async function getBroadcastSettings(token: string): Promise<BroadcastSettings> {
  return request<BroadcastSettings>(
    "/v1/broadcast/settings", {}, token,
  );
}

export async function createTextBroadcastMaterial(token: string, text: string): Promise<BroadcastMaterial> {
  const result = await request<{ material: BroadcastMaterial }>("/v1/broadcast/materials", {
    method: "POST",
    body: JSON.stringify({ kind: "TEXT", text, active: true }),
  }, token);
  return result.material;
}

export async function createForwardBroadcastMaterial(
  token: string, sourceLink: string, sourceAttribution: "SHOW_SOURCE" | "HIDE_SOURCE",
): Promise<BroadcastMaterial> {
  const result = await request<{ material: BroadcastMaterial }>("/v1/broadcast/materials", {
    method: "POST",
    body: JSON.stringify({ kind: "FORWARD", sourceLink, sourceAttribution, active: true }),
  }, token);
  return result.material;
}

export async function createBroadcastLpmTarget(
  token: string, target: Readonly<{ telegramTargetRef: string; label: string | null }>,
): Promise<BroadcastLpmTarget> {
  const result = await request<{ target: BroadcastLpmTarget }>("/v1/broadcast/lpm-targets", {
    method: "POST",
    body: JSON.stringify({ ...target, active: true }),
  }, token);
  return result.target;
}

export async function createBroadcastOperation(
  token: string,
  input: Readonly<{ accountMode: "JASEB_WORKER" | "USERBOT"; materialId: string; targetIds: readonly string[]; idempotencyKey: string }>,
): Promise<Readonly<{ idempotent: boolean; operation: BroadcastOperation }>> {
  return request<{ idempotent: boolean; operation: BroadcastOperation }>("/v1/broadcast/operations", {
    method: "POST",
    body: JSON.stringify(input),
  }, token);
}

export async function getBroadcastOperation(token: string, operationId: string): Promise<BroadcastOperation> {
  const result = await request<{ operation: BroadcastOperation }>(`/v1/broadcast/operations/${operationId}`, {}, token);
  return result.operation;
}

export async function getBroadcastHistory(
  token: string, before: string | null = null,
): Promise<Readonly<{ entries: readonly BroadcastHistoryEntry[]; nextCursor: string | null }>> {
  const suffix = before ? `?before=${encodeURIComponent(before)}` : "";
  return request<{ entries: readonly BroadcastHistoryEntry[]; nextCursor: string | null }>(
    `/v1/broadcast/history${suffix}`, {}, token,
  );
}

export async function listBroadcastCampaigns(token: string): Promise<readonly BroadcastCampaign[]> {
  const result = await request<{ campaigns: readonly BroadcastCampaign[] }>("/v1/broadcast/campaigns", {}, token);
  return result.campaigns;
}

export async function createBroadcastCampaign(
  token: string,
  input: Readonly<{ accountMode: "JASEB_WORKER" | "USERBOT"; materialId: string; targetIds: readonly string[]; intervalSeconds: number }>,
): Promise<BroadcastCampaign> {
  const result = await request<{ campaign: BroadcastCampaign }>("/v1/broadcast/campaigns", {
    method: "POST",
    body: JSON.stringify(input),
  }, token);
  return result.campaign;
}

export function stopBroadcastCampaign(token: string, campaignId: string): Promise<void> {
  return request<void>(`/v1/broadcast/campaigns/${campaignId}/stop`, { method: "POST" }, token);
}

export async function listWorkerAccounts(token: string): Promise<readonly WorkerAccount[]> {
  const result = await request<{ workers: readonly WorkerAccount[] }>("/v1/admin/worker-accounts", {}, token);
  return result.workers;
}

export async function updateWorkerAccount(
  token: string,
  accountId: string,
  input: Readonly<{ intervalSeconds: number; active: boolean }>,
): Promise<WorkerAccount> {
  const result = await request<{ worker: WorkerAccount }>(`/v1/admin/worker-accounts/${accountId}/settings`, {
    method: "PUT",
    body: JSON.stringify(input),
  }, token);
  return result.worker;
}
