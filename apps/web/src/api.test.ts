import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  attachAutoCommentChannel,
  createAdminBroadcastCampaign,
  createAdminTextBroadcastMaterial,
  createAutoCommentChannelTarget,
  createAutoCommentDivision,
  createAutoCommentKeyword,
  createAutoCommentTemplate,
  createBroadcastCampaign,
  createBroadcastLpmTarget,
  createBroadcastOperation,
  createForwardBroadcastMaterial,
  createTextBroadcastMaterial,
  deleteAutoCommentChannelTarget,
  deleteAutoCommentDivision,
  deleteAutoCommentKeyword,
  deleteAutoCommentTemplate,
  detachAutoCommentChannel,
  exchangeTelegramInitData,
  getAdminBroadcastSettings,
  getAutoCommentSettings,
  getBroadcastHistory,
  getBroadcastOperation,
  getBroadcastSettings,
  getCurrentAdminBroadcastCampaign,
  getCurrentBroadcastCampaign,
  listTelegramAccounts,
  stopAdminBroadcastCampaign,
  stopBroadcastCampaign,
  updateAdminBroadcastLpmTarget,
  updateAutoCommentChannelTarget,
  updateAutoCommentDivision,
  updateAutoCommentTemplate,
  updateBroadcastLpmTarget,
  updateTextBroadcastMaterial,
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

  it("loads Jasa Sebar settings including the resolved account mode", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ materials: [], lpmTargets: [], accountMode: "USERBOT" }), { status: 200 })));

    await expect(getBroadcastSettings("jas_test")).resolves.toEqual({ materials: [], lpmTargets: [], accountMode: "USERBOT" });
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

  it("creates a FORWARD broadcast material", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ kind: "FORWARD", sourceLink: "https://t.me/contoh/123", sourceAttribution: "HIDE_SOURCE", active: true });
      return new Response(JSON.stringify({
        material: { id: "material-2", kind: "FORWARD", source: { channelUsername: "contoh", messageId: 123, canonicalLink: "https://t.me/contoh/123" }, sourceAttribution: "HIDE_SOURCE", active: true },
      }), { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(createForwardBroadcastMaterial("jas_test", "https://t.me/contoh/123", "HIDE_SOURCE")).resolves.toMatchObject({ id: "material-2", kind: "FORWARD" });
  });

  it("updates an existing material in place instead of creating a new one", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body))).toEqual({ kind: "TEXT", text: "wording baru", active: true });
      return new Response(JSON.stringify({ material: { id: "material-1", kind: "TEXT", text: "wording baru", active: true } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateTextBroadcastMaterial("jas_test", "material-1", "wording baru")).resolves.toMatchObject({ text: "wording baru" });
  });

  it("creates an LPM target", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ telegramTargetRef: "@contoh", label: null, active: true });
      return new Response(JSON.stringify({ target: { id: "target-1", telegramTargetRef: "@contoh", label: null, active: true } }), { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(createBroadcastLpmTarget("jas_test", { telegramTargetRef: "@contoh", label: null })).resolves.toMatchObject({ id: "target-1" });
  });

  it("updates an existing LPM target in place", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body))).toEqual({ telegramTargetRef: "@lain", label: "Grup baru", active: true });
      return new Response(JSON.stringify({ target: { id: "target-1", telegramTargetRef: "@lain", label: "Grup baru", active: true } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateBroadcastLpmTarget("jas_test", "target-1", { telegramTargetRef: "@lain", label: "Grup baru" })).resolves.toMatchObject({ telegramTargetRef: "@lain" });
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

  it("paginates riwayat sebar with a before cursor", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("/v1/broadcast/history?before=");
      return new Response(JSON.stringify({ entries: [], nextCursor: null }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getBroadcastHistory("jas_test", "2026-09-01T00:00:00.000Z_target-1")).resolves.toEqual({ entries: [], nextCursor: null });
  });

  it("starts, reads, and stops a recurring campaign", async () => {
    const campaign = {
      id: "campaign-1", accountMode: "USERBOT", materialId: "material-1", targetIds: ["target-1"],
      intervalSeconds: 300, status: "ACTIVE", errorCode: null, lastCycleAt: null, nextCycleAt: "2026-09-01T00:00:00.000Z",
      lastOperationId: null,
    };
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ accountMode: "USERBOT", materialId: "material-1", targetIds: ["target-1"], intervalSeconds: 300 });
      return new Response(JSON.stringify({ campaign }), { status: 201 });
    }));
    await expect(createBroadcastCampaign("jas_test", {
      accountMode: "USERBOT", materialId: "material-1", targetIds: ["target-1"], intervalSeconds: 300,
    })).resolves.toMatchObject({ id: "campaign-1", status: "ACTIVE" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ campaign }), { status: 200 })));
    await expect(getCurrentBroadcastCampaign("jas_test")).resolves.toMatchObject({ id: "campaign-1" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ campaign: null }), { status: 200 })));
    await expect(getCurrentBroadcastCampaign("jas_test")).resolves.toBeNull();

    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      return new Response(null, { status: 204 });
    }));
    await expect(stopBroadcastCampaign("jas_test", "campaign-1")).resolves.toBeNull();
  });

  it("manages a user's Jasa Sebar as admin, scoped by userId in the URL", async () => {
    const USER_ID = "target-user-1";

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain(`/v1/admin/users/${USER_ID}/broadcast/settings`);
      return new Response(JSON.stringify({ materials: [], lpmTargets: [], accountMode: "USERBOT" }), { status: 200 });
    }));
    await expect(getAdminBroadcastSettings("jas_admin", USER_ID)).resolves.toMatchObject({ accountMode: "USERBOT" });

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain(`/v1/admin/users/${USER_ID}/broadcast/materials`);
      expect(JSON.parse(String(init?.body))).toEqual({ kind: "TEXT", text: "materi admin", active: true });
      return new Response(JSON.stringify({ material: { id: "material-9", kind: "TEXT", text: "materi admin", active: true } }), { status: 201 });
    }));
    await expect(createAdminTextBroadcastMaterial("jas_admin", USER_ID, "materi admin")).resolves.toMatchObject({ id: "material-9" });

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain(`/v1/admin/users/${USER_ID}/broadcast/lpm-targets/target-9`);
      return new Response(JSON.stringify({ target: { id: "target-9", telegramTargetRef: "@lain", label: null, active: true } }), { status: 200 });
    }));
    await expect(updateAdminBroadcastLpmTarget("jas_admin", USER_ID, "target-9", { telegramTargetRef: "@lain", label: null })).resolves.toMatchObject({ id: "target-9" });

    const campaign = {
      id: "campaign-9", accountMode: "USERBOT", materialId: "material-9", targetIds: ["target-9"],
      intervalSeconds: 300, status: "ACTIVE", errorCode: null, lastCycleAt: null, nextCycleAt: "2026-09-02T00:00:00.000Z",
      lastOperationId: null,
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain(`/v1/admin/users/${USER_ID}/broadcast/campaigns`);
      return new Response(JSON.stringify({ campaign }), { status: 201 });
    }));
    await expect(createAdminBroadcastCampaign("jas_admin", USER_ID, {
      accountMode: "USERBOT", materialId: "material-9", targetIds: ["target-9"], intervalSeconds: 300,
    })).resolves.toMatchObject({ id: "campaign-9" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ campaign }), { status: 200 })));
    await expect(getCurrentAdminBroadcastCampaign("jas_admin", USER_ID)).resolves.toMatchObject({ id: "campaign-9" });

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain(`/v1/admin/users/${USER_ID}/broadcast/campaigns/campaign-9/stop`);
      expect(init?.method).toBe("POST");
      return new Response(null, { status: 204 });
    }));
    await expect(stopAdminBroadcastCampaign("jas_admin", USER_ID, "campaign-9")).resolves.toBeNull();
  });

  it("loads Auto Komen settings", async () => {
    const settings = { accounts: [], divisions: [], channelTargets: [] };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ settings }), { status: 200 })));

    await expect(getAutoCommentSettings("jas_test")).resolves.toEqual(settings);
  });

  it("creates, updates, and deletes an Auto Komen division", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ accountId: "account-1", name: "Jual Beli", mode: "APPROVAL_REQUIRED", active: true });
      return new Response(JSON.stringify({ division: { id: "division-1", accountId: "account-1", name: "Jual Beli", mode: "APPROVAL_REQUIRED", active: true, keywords: [], templates: [], channelTargetIds: [] } }), { status: 201 });
    }));
    await expect(createAutoCommentDivision("jas_test", { accountId: "account-1", name: "Jual Beli", mode: "APPROVAL_REQUIRED", active: true })).resolves.toMatchObject({ id: "division-1" });

    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body))).toEqual({ name: "Jual Beli", mode: "AUTO_SEND", active: true });
      return new Response(JSON.stringify({ division: { id: "division-1", accountId: "account-1", name: "Jual Beli", mode: "AUTO_SEND", active: true, keywords: [], templates: [], channelTargetIds: [] } }), { status: 200 });
    }));
    await expect(updateAutoCommentDivision("jas_test", "division-1", { name: "Jual Beli", mode: "AUTO_SEND", active: true })).resolves.toMatchObject({ mode: "AUTO_SEND" });

    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("DELETE");
      return new Response(null, { status: 204 });
    }));
    await expect(deleteAutoCommentDivision("jas_test", "division-1")).resolves.toBeNull();
  });

  it("adds and removes a keyword from a division", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ keyword: "promo" });
      return new Response(JSON.stringify({ keyword: { id: "keyword-1", keyword: "promo" } }), { status: 201 });
    }));
    await expect(createAutoCommentKeyword("jas_test", "division-1", "promo")).resolves.toEqual({ id: "keyword-1", keyword: "promo" });

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain("/v1/auto-comment/divisions/division-1/keywords/keyword-1");
      expect(init?.method).toBe("DELETE");
      return new Response(null, { status: 204 });
    }));
    await expect(deleteAutoCommentKeyword("jas_test", "division-1", "keyword-1")).resolves.toBeNull();
  });

  it("creates and updates a division template", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ text: "Terima kasih", displayOrder: 0, active: true });
      return new Response(JSON.stringify({ template: { id: "template-1", text: "Terima kasih", displayOrder: 0, active: true } }), { status: 201 });
    }));
    await expect(createAutoCommentTemplate("jas_test", "division-1", { text: "Terima kasih", displayOrder: 0, active: true })).resolves.toMatchObject({ id: "template-1" });

    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body))).toEqual({ text: "Terima kasih banyak", displayOrder: 0, active: true });
      return new Response(JSON.stringify({ template: { id: "template-1", text: "Terima kasih banyak", displayOrder: 0, active: true } }), { status: 200 });
    }));
    await expect(updateAutoCommentTemplate("jas_test", "division-1", "template-1", { text: "Terima kasih banyak", displayOrder: 0, active: true })).resolves.toMatchObject({ text: "Terima kasih banyak" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    await expect(deleteAutoCommentTemplate("jas_test", "division-1", "template-1")).resolves.toBeNull();
  });

  it("creates and updates a channel target", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ accountId: "account-1", sourceChannelRef: "@menfess", active: true });
      return new Response(JSON.stringify({ channelTarget: { id: "channel-1", accountId: "account-1", sourceChannelRef: "@menfess", discussionTargetRef: null, resolutionStatus: "QUEUED", lastErrorCode: null, active: true, divisionIds: [] } }), { status: 201 });
    }));
    await expect(createAutoCommentChannelTarget("jas_test", { accountId: "account-1", sourceChannelRef: "@menfess", active: true })).resolves.toMatchObject({ id: "channel-1" });

    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body))).toEqual({ sourceChannelRef: "@menfess", active: false });
      return new Response(JSON.stringify({ channelTarget: { id: "channel-1", accountId: "account-1", sourceChannelRef: "@menfess", discussionTargetRef: null, resolutionStatus: "QUEUED", lastErrorCode: null, active: false, divisionIds: [] } }), { status: 200 });
    }));
    await expect(updateAutoCommentChannelTarget("jas_test", "channel-1", { sourceChannelRef: "@menfess", active: false })).resolves.toMatchObject({ active: false });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    await expect(deleteAutoCommentChannelTarget("jas_test", "channel-1")).resolves.toBeNull();
  });

  it("attaches and detaches a channel target to a division with PUT/DELETE and no body", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain("/v1/auto-comment/divisions/division-1/channel-targets/channel-1");
      expect(init?.method).toBe("PUT");
      expect(init?.body).toBeUndefined();
      return new Response(null, { status: 204 });
    }));
    await expect(attachAutoCommentChannel("jas_test", "division-1", "channel-1")).resolves.toBeNull();

    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("DELETE");
      return new Response(null, { status: 204 });
    }));
    await expect(detachAutoCommentChannel("jas_test", "division-1", "channel-1")).resolves.toBeNull();
  });
});
