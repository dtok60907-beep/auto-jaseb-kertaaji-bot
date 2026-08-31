import type { AuthFlow, AuthorizationResult, IssuedSession, TelegramAccount } from "./types";

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
