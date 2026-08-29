import assert from "node:assert/strict";
import test from "node:test";
import { createApi } from "../src/app.ts";
import type { AutoCommentSettingsRepository } from "../src/auto-comment/repository.ts";
import type { BroadcastSettingsRepository } from "../src/broadcast/repository.ts";
import type { EntitlementRepository } from "../src/entitlements/repository.ts";
import type { PackageRepository } from "../src/packages/repository.ts";
import type { UserbotProfileRepository, UserbotProfileView } from "../src/userbot-profiles/repository.ts";

const USER = "12121212-1212-1212-1212-121212121212";
const OTHER = "34343434-3434-3434-3434-343434343434";
class EmptyPackages implements PackageRepository { async create(): Promise<never> { throw new Error("unused"); } async publish(): Promise<null> { return null; } async list(): Promise<readonly []> { return []; } }
class EmptyBroadcasts implements BroadcastSettingsRepository { async listMaterials(): Promise<readonly []> { return []; } async createMaterial(): Promise<never> { throw new Error("unused"); } async updateMaterial(): Promise<null> { return null; } async deleteMaterial(): Promise<boolean> { return false; } async listLpmTargets(): Promise<readonly []> { return []; } async createLpmTarget(): Promise<never> { throw new Error("unused"); } async updateLpmTarget(): Promise<null> { return null; } async deleteLpmTarget(): Promise<boolean> { return false; } }
class EmptyAutoComments implements AutoCommentSettingsRepository { async listSettings() { return { accounts: [], divisions: [], channelTargets: [] } as const; } async createDivision(): Promise<never> { throw new Error("unused"); } async updateDivision(): Promise<null> { return null; } async deleteDivision(): Promise<boolean> { return false; } async createKeyword(): Promise<null> { return null; } async deleteKeyword(): Promise<boolean> { return false; } async createTemplate(): Promise<null> { return null; } async updateTemplate(): Promise<null> { return null; } async deleteTemplate(): Promise<boolean> { return false; } async createChannelTarget(): Promise<never> { throw new Error("unused"); } async updateChannelTarget(): Promise<null> { return null; } async deleteChannelTarget(): Promise<boolean> { return false; } async attachChannel(): Promise<"NOT_FOUND"> { return "NOT_FOUND"; } async detachChannel(): Promise<boolean> { return false; } async decideCandidate(): Promise<never> { throw new Error("unused"); } }
class EmptyEntitlements implements EntitlementRepository { async grant(): Promise<never> { throw new Error("unused"); } async list(): Promise<readonly []> { return []; } async extend(): Promise<null> { return null; } async revoke(): Promise<boolean> { return false; } }
class FakeProfiles implements UserbotProfileRepository {
  private profiles = new Map<string, UserbotProfileView>();
  async get(userId: string) { return this.profiles.get(userId) ?? null; }
  async updateBroadcastInterval(userId: string, intervalSeconds: number) { const previous = this.profiles.get(userId); const profile: UserbotProfileView = { id: `profile:${userId}`, status: previous?.status ?? "DISCONNECTED", broadcastIntervalSeconds: intervalSeconds, activeAccount: previous?.activeAccount ?? null }; this.profiles.set(userId, profile); return profile; }
  async attach(): Promise<never> { throw new Error("unused"); }
  async detach(): Promise<boolean> { return false; }
}
function app(options: { admin?: boolean; user?: string | null } = {}) { return createApi({ packages: new EmptyPackages(), broadcasts: new EmptyBroadcasts(), autoComments: new EmptyAutoComments(), entitlements: new EmptyEntitlements(), userbotProfiles: new FakeProfiles(), authorizeAdmin: async () => options.admin ? { id: "admin" } : null, authorizeUser: async () => options.user === undefined ? { id: USER } : options.user ? { id: options.user } : null }); }

test("Userbot Jasa Sebar interval belongs to the profile and zero is valid", async (t) => {
  const server = app(); t.after(() => server.close());
  const set = await server.inject({ method: "PUT", url: "/v1/userbot/profile/broadcast-interval", payload: { intervalSeconds: 0 } });
  const get = await server.inject({ method: "GET", url: "/v1/userbot/profile" });
  assert.equal(set.statusCode, 200);
  assert.equal(set.json().profile.broadcastIntervalSeconds, 0);
  assert.equal(JSON.stringify(get.json()).includes("session"), false);
});

test("admin can transparently configure a user's Jasa Sebar interval without connection access", async (t) => {
  const server = app({ admin: true }); const denied = app({ admin: false }); t.after(() => server.close()); t.after(() => denied.close());
  const set = await server.inject({ method: "PUT", url: `/v1/admin/users/${OTHER}/userbot/profile/broadcast-interval`, payload: { intervalSeconds: 75 } });
  const invalid = await server.inject({ method: "PUT", url: `/v1/admin/users/${OTHER}/userbot/profile/broadcast-interval`, payload: { intervalSeconds: -1 } });
  const noAdmin = await denied.inject({ method: "PUT", url: `/v1/admin/users/${OTHER}/userbot/profile/broadcast-interval`, payload: { intervalSeconds: 75 } });
  assert.equal(set.json().profile.broadcastIntervalSeconds, 75);
  assert.deepEqual(invalid.json().code, "INVALID_USERBOT_BROADCAST_INTERVAL");
  assert.deepEqual(noAdmin.json(), { code: "ADMIN_REQUIRED" });
});
