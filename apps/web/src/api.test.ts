import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  exchangeTelegramInitData,
  listTelegramAccounts,
} from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("web API client", () => {
  it("exchanges Telegram init data without persisting or sending a bearer", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.headers).toBeInstanceOf(Headers);
      expect((init?.headers as Headers).get("authorization")).toBeNull();
      expect(JSON.parse(String(init?.body))).toEqual({ initData: "signed-init-data" });
      return new Response(JSON.stringify({
        accessToken: "jas_test",
        tokenType: "Bearer",
        expiresAt: "2026-09-01T00:00:00.000Z",
        user: { id: "user-1", telegramUserId: "telegram-1" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(exchangeTelegramInitData("signed-init-data")).resolves.toMatchObject({ accessToken: "jas_test" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends the bearer and preserves safe account metadata", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect((init?.headers as Headers).get("authorization")).toBe("Bearer jas_test");
      return new Response(JSON.stringify({ accounts: [{
        id: "account-1",
        label: "@contoh",
        status: "READY",
        active: true,
        sessionPresent: true,
        authenticatedAt: null,
        revokedAt: null,
        lastErrorCode: null,
      }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(listTelegramAccounts("jas_test")).resolves.toHaveLength(1);
  });

  it("turns server failures into stable ApiError codes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: "USER_REQUIRED" }), { status: 401 })));

    await expect(listTelegramAccounts("expired-token")).rejects.toEqual(new ApiError(401, "USER_REQUIRED"));
  });
});
