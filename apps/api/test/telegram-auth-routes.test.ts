import assert from "node:assert/strict";
import test from "node:test";

import { createApi } from "../src/app.ts";
import { TelegramMiniAppAuthError } from "../src/auth/telegram-mini-app.ts";
import { TelegramSessionExchangeError } from "../src/auth/telegram-session-issuer.ts";
import type { AutoCommentSettingsRepository } from "../src/auto-comment/repository.ts";
import type { BroadcastSettingsRepository } from "../src/broadcast/repository.ts";
import type { EntitlementRepository } from "../src/entitlements/repository.ts";
import type { PackageRepository } from "../src/packages/repository.ts";

const RAW_INIT_DATA = "auth_date=1800000000&user=signed&hash=secret-signature";
const ACCESS_TOKEN = `jas_${"A".repeat(43)}`;
const USER_ID = "11111111-1111-4111-8111-111111111111";
const issued = Object.freeze({
  accessToken: ACCESS_TOKEN,
  tokenType: "Bearer" as const,
  userId: USER_ID,
  telegramUserId: "900000008",
  expiresAt: "2027-01-15T20:00:00.000Z",
});

type Exchange = (initData: string) => Promise<typeof issued>;

function app(exchange?: Exchange) {
  const options = {
    packages: {} as PackageRepository,
    broadcasts: {} as BroadcastSettingsRepository,
    autoComments: {} as AutoCommentSettingsRepository,
    entitlements: {} as EntitlementRepository,
    authorizeAdmin: async () => null,
    authorizeUser: async () => null,
  };
  return exchange
    ? createApi({ ...options, telegramSessionIssuer: { exchange } })
    : createApi(options);
}

function assertNoSecrets(body: string): void {
  assert.equal(body.includes(RAW_INIT_DATA), false);
  assert.equal(body.includes("database-password"), false);
  assert.equal(body.includes("stack"), false);
}

test("exchanges valid initData with an exact no-store public response", async (t) => {
  const calls: string[] = [];
  const api = app(async (initData) => { calls.push(initData); return issued; });
  t.after(() => api.close());
  const response = await api.inject({ method: "POST", url: "/v1/auth/telegram", payload: { initData: RAW_INIT_DATA } });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers.pragma, "no-cache");
  assert.deepEqual(response.json(), {
    accessToken: ACCESS_TOKEN,
    tokenType: "Bearer",
    expiresAt: issued.expiresAt,
    user: { id: USER_ID, telegramUserId: issued.telegramUserId },
  });
  assert.deepEqual(calls, [RAW_INIT_DATA]);
});

test("rejects malformed, extra, and oversized input before calling the issuer", async (t) => {
  let calls = 0;
  const api = app(async () => { calls += 1; return issued; });
  t.after(() => api.close());
  const cases = [
    { payload: {}, status: 400, code: "INVALID_TELEGRAM_AUTH_REQUEST" },
    { payload: { initData: RAW_INIT_DATA, userId: "forged" }, status: 400, code: "INVALID_TELEGRAM_AUTH_REQUEST" },
    { payload: { initData: 123 }, status: 400, code: "INVALID_TELEGRAM_AUTH_REQUEST" },
    { payload: { initData: "x".repeat(16_385) }, status: 413, code: "TELEGRAM_AUTH_REQUEST_TOO_LARGE" },
  ];
  for (const fixture of cases) {
    const response = await api.inject({ method: "POST", url: "/v1/auth/telegram", payload: fixture.payload });
    assert.equal(response.statusCode, fixture.status);
    assert.deepEqual(response.json(), { code: fixture.code });
    assert.equal(response.headers["cache-control"], "no-store");
    assertNoSecrets(response.body);
  }
  assert.equal(calls, 0);
});

test("maps Telegram verification, replay, and dependency failures to stable public errors", async (t) => {
  const fixtures: ReadonlyArray<Readonly<{ error: Error; status: number; code: string }>> = [
    { error: new TelegramMiniAppAuthError("TELEGRAM_INIT_DATA_HASH_INVALID"), status: 401, code: "TELEGRAM_AUTH_INVALID" },
    { error: new TelegramMiniAppAuthError("TELEGRAM_INIT_DATA_EXPIRED"), status: 401, code: "TELEGRAM_AUTH_EXPIRED" },
    { error: new TelegramMiniAppAuthError("TELEGRAM_INIT_DATA_FUTURE"), status: 401, code: "TELEGRAM_AUTH_CLOCK_INVALID" },
    { error: new TelegramSessionExchangeError("TELEGRAM_INIT_DATA_ALREADY_USED"), status: 409, code: "TELEGRAM_AUTH_REPLAYED" },
    { error: new TelegramSessionExchangeError("API_SESSION_ENTROPY_INVALID"), status: 503, code: "AUTH_TEMPORARILY_UNAVAILABLE" },
    { error: new Error("database-password query detail"), status: 503, code: "AUTH_TEMPORARILY_UNAVAILABLE" },
  ];
  for (const fixture of fixtures) {
    const api = app(async () => { throw fixture.error; });
    t.after(() => api.close());
    const response = await api.inject({ method: "POST", url: "/v1/auth/telegram", payload: { initData: RAW_INIT_DATA } });
    assert.equal(response.statusCode, fixture.status);
    assert.deepEqual(response.json(), { code: fixture.code });
    assert.equal(response.headers["cache-control"], "no-store");
    assertNoSecrets(response.body);
  }
});

test("scoped parser errors use the stable auth contract", async (t) => {
  const api = app(async () => issued);
  t.after(() => api.close());
  const malformed = await api.inject({
    method: "POST",
    url: "/v1/auth/telegram",
    headers: { "content-type": "application/json" },
    payload: "{broken-json",
  });
  assert.equal(malformed.statusCode, 400);
  assert.deepEqual(malformed.json(), { code: "INVALID_TELEGRAM_AUTH_REQUEST" });
  assert.equal(malformed.headers["cache-control"], "no-store");
  assertNoSecrets(malformed.body);

  const tooLarge = await api.inject({
    method: "POST",
    url: "/v1/auth/telegram",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ initData: "x".repeat(21_000) }),
  });
  assert.equal(tooLarge.statusCode, 413);
  assert.deepEqual(tooLarge.json(), { code: "TELEGRAM_AUTH_REQUEST_TOO_LARGE" });
  assert.equal(tooLarge.headers["cache-control"], "no-store");
});

test("auth route is absent when createApi has no production issuer", async (t) => {
  const api = app();
  t.after(() => api.close());
  const response = await api.inject({ method: "POST", url: "/v1/auth/telegram", payload: { initData: RAW_INIT_DATA } });
  assert.equal(response.statusCode, 404);
});
