import assert from "node:assert/strict";
import test from "node:test";
import { createApi } from "../src/app.ts";
import type {
  BroadcastLpmTargetView,
  BroadcastMaterialView,
  BroadcastSettingsRepository,
} from "../src/broadcast/repository.ts";
import type { PackageRepository } from "../src/packages/repository.ts";
import type { AutoCommentSettingsRepository } from "../src/auto-comment/repository.ts";

class EmptyPackages implements PackageRepository {
  async create(): Promise<never> { throw new Error("not used"); }
  async publish(): Promise<null> { return null; }
  async list(): Promise<readonly []> { return []; }
}

class EmptyAutoComments implements AutoCommentSettingsRepository {
  async listSettings() { return { accounts: [], divisions: [], channelTargets: [] } as const; }
  async createDivision(): Promise<never> { throw new Error("not used"); }
  async updateDivision(): Promise<null> { return null; }
  async deleteDivision(): Promise<boolean> { return false; }
  async createKeyword(): Promise<null> { return null; }
  async deleteKeyword(): Promise<boolean> { return false; }
  async createTemplate(): Promise<null> { return null; }
  async updateTemplate(): Promise<null> { return null; }
  async deleteTemplate(): Promise<boolean> { return false; }
  async createChannelTarget(): Promise<never> { throw new Error("not used"); }
  async updateChannelTarget(): Promise<null> { return null; }
  async deleteChannelTarget(): Promise<boolean> { return false; }
  async attachChannel(): Promise<"NOT_FOUND"> { return "NOT_FOUND"; }
  async detachChannel(): Promise<boolean> { return false; }
}

class FakeBroadcastSettings implements BroadcastSettingsRepository {
  private materialRows: Array<BroadcastMaterialView & { userId: string }> = [];
  private targetRows: Array<BroadcastLpmTargetView & { userId: string }> = [];
  private nextId = 1;

  async listMaterials(userId: string): Promise<readonly BroadcastMaterialView[]> {
    return this.materialRows.filter((row) => row.userId === userId).map((row) => this.materialView(row));
  }

  async createMaterial(input: Parameters<BroadcastSettingsRepository["createMaterial"]>[0]): Promise<BroadcastMaterialView> {
    const id = this.id();
    const row = Object.freeze({ id, userId: input.userId, ...input.material, active: input.active });
    this.materialRows.push(row);
    return this.materialView(row);
  }

  async updateMaterial(input: Parameters<BroadcastSettingsRepository["updateMaterial"]>[0]): Promise<BroadcastMaterialView | null> {
    const index = this.materialRows.findIndex((row) => row.id === input.id && row.userId === input.userId);
    if (index < 0) return null;
    const row = Object.freeze({ id: input.id, userId: input.userId, ...input.material, active: input.active });
    this.materialRows[index] = row;
    return this.materialView(row);
  }

  async deleteMaterial(input: Parameters<BroadcastSettingsRepository["deleteMaterial"]>[0]): Promise<boolean> {
    const index = this.materialRows.findIndex((row) => row.id === input.id && row.userId === input.userId);
    if (index < 0) return false;
    this.materialRows.splice(index, 1);
    return true;
  }

  async listLpmTargets(userId: string): Promise<readonly BroadcastLpmTargetView[]> {
    return this.targetRows.filter((row) => row.userId === userId).map((row) => this.targetView(row));
  }

  async createLpmTarget(input: Parameters<BroadcastSettingsRepository["createLpmTarget"]>[0]): Promise<BroadcastLpmTargetView> {
    if (this.targetRows.some((row) => row.userId === input.userId && row.telegramTargetRef.toLowerCase() === input.target.telegramTargetRef.toLowerCase())) {
      throw Object.assign(new Error("duplicate"), { code: "23505" });
    }
    const row = Object.freeze({ id: this.id(), userId: input.userId, ...input.target });
    this.targetRows.push(row);
    return this.targetView(row);
  }

  async updateLpmTarget(input: Parameters<BroadcastSettingsRepository["updateLpmTarget"]>[0]): Promise<BroadcastLpmTargetView | null> {
    const index = this.targetRows.findIndex((row) => row.id === input.id && row.userId === input.userId);
    if (index < 0) return null;
    if (this.targetRows.some((row, rowIndex) => rowIndex !== index && row.userId === input.userId && row.telegramTargetRef.toLowerCase() === input.target.telegramTargetRef.toLowerCase())) {
      throw Object.assign(new Error("duplicate"), { code: "23505" });
    }
    const row = Object.freeze({ id: input.id, userId: input.userId, ...input.target });
    this.targetRows[index] = row;
    return this.targetView(row);
  }

  async deleteLpmTarget(input: Parameters<BroadcastSettingsRepository["deleteLpmTarget"]>[0]): Promise<boolean> {
    const index = this.targetRows.findIndex((row) => row.id === input.id && row.userId === input.userId);
    if (index < 0) return false;
    this.targetRows.splice(index, 1);
    return true;
  }

  private id() {
    const suffix = String(this.nextId++).padStart(12, "0");
    return "00000000-0000-0000-0000-" + suffix;
  }

  private materialView(row: BroadcastMaterialView & { userId: string }): BroadcastMaterialView {
    const { userId: _userId, ...view } = row;
    return view;
  }

  private targetView(row: BroadcastLpmTargetView & { userId: string }): BroadcastLpmTargetView {
    const { userId: _userId, ...view } = row;
    return view;
  }
}

function app({
  userId = "11111111-1111-1111-1111-111111111111",
  adminId = "",
  broadcasts = new FakeBroadcastSettings(),
}: {
  userId?: string;
  adminId?: string;
  broadcasts?: BroadcastSettingsRepository;
} = {}) {
  return createApi({
    packages: new EmptyPackages(),
    broadcasts,
    autoComments: new EmptyAutoComments(),
    authorizeAdmin: async () => adminId ? { id: adminId } : null,
    authorizeUser: async () => userId ? { id: userId } : null,
  });
}

test("user creates and lists manual and forward Jasa Sebar materials", async (t) => {
  const server = app();
  t.after(() => server.close());
  const text = await server.inject({ method: "POST", url: "/v1/broadcast/materials", payload: { kind: "TEXT", text: "Promo kos" } });
  const forward = await server.inject({ method: "POST", url: "/v1/broadcast/materials", payload: { kind: "FORWARD", sourceLink: "https://t.me/KosPutri_Bali/123", sourceAttribution: "HIDE_SOURCE", active: false } });
  const settings = await server.inject({ method: "GET", url: "/v1/broadcast/settings" });

  assert.equal(text.statusCode, 201);
  assert.deepEqual(text.json().material, { id: "00000000-0000-0000-0000-000000000001", kind: "TEXT", text: "Promo kos", active: true });
  assert.equal(forward.statusCode, 201);
  assert.deepEqual(forward.json().material, {
    id: "00000000-0000-0000-0000-000000000002",
    kind: "FORWARD",
    source: { channelUsername: "KosPutri_Bali", messageId: 123, canonicalLink: "https://t.me/KosPutri_Bali/123" },
    sourceAttribution: "HIDE_SOURCE",
    active: false,
  });
  assert.equal(settings.json().materials.length, 2);
});

test("material and target mutations validate input and hide missing resources", async (t) => {
  const server = app();
  t.after(() => server.close());
  const invalid = await server.inject({ method: "POST", url: "/v1/broadcast/materials", payload: { kind: "FORWARD", sourceLink: "https://t.me/private" } });
  const unknown = await server.inject({ method: "POST", url: "/v1/broadcast/lpm-targets", payload: { telegramTargetRef: "@lpm_bali", active: true, ignored: true } });
  const missing = await server.inject({ method: "PUT", url: "/v1/broadcast/materials/00000000-0000-0000-0000-000000000099", payload: { kind: "TEXT", text: "baru", active: true } });

  assert.deepEqual(invalid.json(), { code: "INVALID_BROADCAST_MATERIAL", issues: [{ field: "sourceLink", code: "PUBLIC_POST_LINK_REQUIRED" }] });
  assert.deepEqual(unknown.json(), { code: "INVALID_LPM_TARGET", issues: [{ field: "ignored", code: "UNSUPPORTED" }] });
  assert.deepEqual(missing.json(), { code: "MATERIAL_NOT_FOUND" });
});

test("LPM target duplicate, update, and delete have stable responses", async (t) => {
  const server = app();
  t.after(() => server.close());
  const created = await server.inject({ method: "POST", url: "/v1/broadcast/lpm-targets", payload: { telegramTargetRef: "@lpm_bali", label: "LPM Bali", active: true } });
  const duplicate = await server.inject({ method: "POST", url: "/v1/broadcast/lpm-targets", payload: { telegramTargetRef: "@LPM_BALI", active: true } });
  const id = created.json().target.id;
  const updated = await server.inject({ method: "PUT", url: `/v1/broadcast/lpm-targets/${id}`, payload: { telegramTargetRef: "@lpm_bali", label: "Bali", active: false } });
  const deleted = await server.inject({ method: "DELETE", url: `/v1/broadcast/lpm-targets/${id}` });

  assert.deepEqual(duplicate.json(), { code: "LPM_TARGET_EXISTS" });
  assert.deepEqual(updated.json().target, { id, telegramTargetRef: "@lpm_bali", label: "Bali", active: false });
  assert.equal(deleted.statusCode, 204);
});

test("broadcast settings requires a user actor", async (t) => {
  const server = app({ userId: "" });
  t.after(() => server.close());
  const result = await server.inject({ method: "GET", url: "/v1/broadcast/settings" });
  assert.deepEqual(result.json(), { code: "USER_REQUIRED" });
});

test("a different user cannot observe or mutate another user's material", async (t) => {
  const shared = new FakeBroadcastSettings();
  const owner = app({ broadcasts: shared });
  const other = app({ userId: "22222222-2222-2222-2222-222222222222", broadcasts: shared });
  t.after(() => owner.close());
  t.after(() => other.close());
  const created = await owner.inject({ method: "POST", url: "/v1/broadcast/materials", payload: { kind: "TEXT", text: "khusus owner" } });
  const id = created.json().material.id;
  const settings = await other.inject({ method: "GET", url: "/v1/broadcast/settings" });
  const mutate = await other.inject({ method: "PUT", url: `/v1/broadcast/materials/${id}`, payload: { kind: "TEXT", text: "ambil alih", active: true } });

  assert.deepEqual(settings.json(), { materials: [], lpmTargets: [] });
  assert.deepEqual(mutate.json(), { code: "MATERIAL_NOT_FOUND" });
});

test("admin can transparently manage the selected user's broadcast settings", async (t) => {
  const shared = new FakeBroadcastSettings();
  const ownerId = "11111111-1111-1111-1111-111111111111";
  const owner = app({ userId: ownerId, broadcasts: shared });
  const admin = app({ userId: "", adminId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", broadcasts: shared });
  t.after(() => owner.close());
  t.after(() => admin.close());

  const created = await owner.inject({ method: "POST", url: "/v1/broadcast/materials", payload: { kind: "TEXT", text: "wording user" } });
  const id = created.json().material.id;
  const viewed = await admin.inject({ method: "GET", url: `/v1/admin/users/${ownerId}/broadcast/settings` });
  const updated = await admin.inject({
    method: "PUT",
    url: `/v1/admin/users/${ownerId}/broadcast/materials/${id}`,
    payload: { kind: "TEXT", text: "wording dibantu admin", active: true },
  });
  const visibleToOwner = await owner.inject({ method: "GET", url: "/v1/broadcast/settings" });

  assert.equal(viewed.statusCode, 200);
  assert.equal(viewed.json().materials[0].text, "wording user");
  assert.deepEqual(updated.json().material, { id, kind: "TEXT", text: "wording dibantu admin", active: true });
  assert.equal(visibleToOwner.json().materials[0].text, "wording dibantu admin");
});

test("admin setting routes require admin authorization and a valid selected user", async (t) => {
  const noAdmin = app({ userId: "" });
  const admin = app({ userId: "", adminId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });
  t.after(() => noAdmin.close());
  t.after(() => admin.close());

  const forbidden = await noAdmin.inject({ method: "GET", url: "/v1/admin/users/11111111-1111-1111-1111-111111111111/broadcast/settings" });
  const invalidUser = await admin.inject({ method: "GET", url: "/v1/admin/users/bukan-uuid/broadcast/settings" });

  assert.deepEqual(forbidden.json(), { code: "ADMIN_REQUIRED" });
  assert.deepEqual(invalidUser.json(), { code: "INVALID_USER_ID" });
});
