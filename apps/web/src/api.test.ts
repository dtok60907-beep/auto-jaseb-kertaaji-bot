import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  createBroadcastLpmTarget,
  createBroadcastOperation,
  createTextBroadcastMaterial,
  exchangeTelegramInitData,
  getBroadcastOperation,
  getBroadcastSettings,
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

  it("loads Jasa Sebar settings", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ materials: [], lpmTargets: [] }), { status: 200 })));

    await expect(getBroadcastSettings("jas_test")).resolves.toEqual({ materials: [], lpmTargets: [] });
  });

  it("creates a TEXT broadcast material", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ kind: "TEXT", text: "halo semua", active: true });
      return new Response(JSON.stringify({ material: { id: "material-1", kind: "TEXT", text: "halo semua", active: true } }), { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(createTextBroadcastMaterial("jas_test", "halo semua")).resolves.toMatchObject({ id: "material-1" });
  });

  it("creates an LPM target", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ telegramTargetRef: "@contoh", label: null, active: true });
      return new Response(JSON.stringify({ target: { id: "target-1", telegramTargetRef: "@contoh", label: null, active: true } }), { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(createBroadcastLpmTarget("jas_test", { telegramTargetRef: "@contoh", label: null })).resolves.toMatchObject({ id: "target-1" });
  });

  it("creates and reads a broadcast operation", async () => {
    const operation = {
      id: "operation-1", accountId: "account-1", accountMode: "USERBOT", status: "READY", intervalSeconds: 30,
      material: { id: "material-1", kind: "TEXT", text: "halo semua" },
      targets: [{ id: "target-row-1", sourceLpmTargetId: "target-1", telegramTargetRef: "@contoh", sequenceNumber: 1, preparationStatus: "READY", deliveryStatus: "PENDING", lastErrorCode: null }],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ operation, idempotent: false }), { status: 201 })));

    await expect(createBroadcastOperation("jas_test", {
      accountMode: "USERBOT", materialId: "material-1", targetIds: ["target-1"], idempotencyKey: "op-idempotency-key-1",
    })).resolves.toMatchObject({ idempotent: false, operation: { id: "operation-1" } });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ operation }), { status: 200 })));
    await expect(getBroadcastOperation("jas_test", "operation-1")).resolves.toMatchObject({ id: "operation-1", status: "READY" });
  });
});
