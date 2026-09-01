import assert from "node:assert/strict";
import test from "node:test";
import { createApi } from "../src/app.ts";
import type { AutoCommentSettingsRepository } from "../src/auto-comment/repository.ts";
import type { BroadcastCampaignRepository, BroadcastCampaignView } from "../src/broadcast-campaigns/repository.ts";
import type { BroadcastSettingsRepository } from "../src/broadcast/repository.ts";
import type { EntitlementRepository } from "../src/entitlements/repository.ts";
import type { PackageRepository } from "../src/packages/repository.ts";

const MATERIAL = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1";
const TARGET = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1";
const CAMPAIGN = "cccccccc-cccc-cccc-cccc-ccccccccccc1";
const OTHER_USER = "dddddddd-dddd-dddd-dddd-ddddddddddd1";

class EmptyPackages implements PackageRepository { async create(): Promise<never> { throw new Error("unused"); } async publish(): Promise<null> { return null; } async list(): Promise<readonly []> { return []; } }
class EmptyBroadcasts implements BroadcastSettingsRepository { async listMaterials(): Promise<readonly []> { return []; } async createMaterial(): Promise<never> { throw new Error("unused"); } async updateMaterial(): Promise<null> { return null; } async deleteMaterial(): Promise<boolean> { return false; } async listLpmTargets(): Promise<readonly []> { return []; } async createLpmTarget(): Promise<never> { throw new Error("unused"); } async updateLpmTarget(): Promise<null> { return null; } async deleteLpmTarget(): Promise<boolean> { return false; } }
class EmptyAutoComments implements AutoCommentSettingsRepository { async listSettings() { return { accounts: [], divisions: [], channelTargets: [] } as const; } async createDivision(): Promise<never> { throw new Error("unused"); } async updateDivision(): Promise<null> { return null; } async deleteDivision(): Promise<boolean> { return false; } async createKeyword(): Promise<null> { return null; } async deleteKeyword(): Promise<boolean> { return false; } async createTemplate(): Promise<null> { return null; } async updateTemplate(): Promise<null> { return null; } async deleteTemplate(): Promise<boolean> { return false; } async createChannelTarget(): Promise<never> { throw new Error("unused"); } async updateChannelTarget(): Promise<null> { return null; } async deleteChannelTarget(): Promise<boolean> { return false; } async attachChannel(): Promise<"NOT_FOUND"> { return "NOT_FOUND"; } async detachChannel(): Promise<boolean> { return false; } async decideCandidate(): Promise<never> { throw new Error("unused"); } async resolveOwnerId(): Promise<null> { return null; } }
class EmptyEntitlements implements EntitlementRepository { async grant(): Promise<never> { throw new Error("unused"); } async list(): Promise<readonly []> { return []; } async extend(): Promise<null> { return null; } async revoke(): Promise<boolean> { return false; } }

const campaign: BroadcastCampaignView = { id: CAMPAIGN, accountMode: "USERBOT", materialId: MATERIAL, targetIds: [TARGET], intervalSeconds: 300, status: "ACTIVE", errorCode: null, lastCycleAt: null, nextCycleAt: "2026-09-01T12:00:00.000Z", lastOperationId: null };

class FakeCampaigns implements BroadcastCampaignRepository {
  failWith: string | null = null;
  stopped: string[] = [];
  seenUserIds: string[] = [];
  async create({ userId }: { userId: string }) { this.seenUserIds.push(userId); if (this.failWith) throw new Error(this.failWith); return campaign; }
  async getCurrent(userId: string): Promise<BroadcastCampaignView | null> { this.seenUserIds.push(userId); return campaign; }
  async stop({ userId, campaignId }: { userId: string; campaignId: string }) { this.seenUserIds.push(userId); this.stopped.push(campaignId); return campaignId === CAMPAIGN; }
}

function app({
  userId = "user-1",
  adminId = "",
  campaigns = new FakeCampaigns(),
}: { userId?: string | null; adminId?: string; campaigns?: BroadcastCampaignRepository } = {}) {
  return createApi({
    packages: new EmptyPackages(), broadcasts: new EmptyBroadcasts(), autoComments: new EmptyAutoComments(),
    entitlements: new EmptyEntitlements(), broadcastCampaigns: campaigns,
    authorizeAdmin: async () => (adminId ? { id: adminId } : null),
    authorizeUser: async () => (userId ? { id: userId } : null),
  });
}

test("campaign creates, lists, and stops", async (t) => {
  const server = app();
  t.after(() => server.close());

  const created = await server.inject({
    method: "POST", url: "/v1/broadcast/campaigns",
    payload: { accountMode: "USERBOT", materialId: MATERIAL, targetIds: [TARGET], intervalSeconds: 300 },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().campaign.id, CAMPAIGN);

  const listed = await server.inject({ method: "GET", url: "/v1/broadcast/campaigns" });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().campaign.id, CAMPAIGN);

  const stopped = await server.inject({ method: "POST", url: `/v1/broadcast/campaigns/${CAMPAIGN}/stop` });
  assert.equal(stopped.statusCode, 204);
});

test("campaign rejects an interval under the floor and surfaces a conflicting active campaign", async (t) => {
  const server = app();
  t.after(() => server.close());

  const tooShort = await server.inject({
    method: "POST", url: "/v1/broadcast/campaigns",
    payload: { accountMode: "USERBOT", materialId: MATERIAL, targetIds: [TARGET], intervalSeconds: 60 },
  });
  assert.equal(tooShort.statusCode, 422);
  assert.deepEqual(tooShort.json().code, "INVALID_BROADCAST_CAMPAIGN");

  const conflicting = new FakeCampaigns();
  conflicting.failWith = "CAMPAIGN_ALREADY_ACTIVE";
  const conflictServer = app({ campaigns: conflicting });
  t.after(() => conflictServer.close());
  const conflict = await conflictServer.inject({
    method: "POST", url: "/v1/broadcast/campaigns",
    payload: { accountMode: "USERBOT", materialId: MATERIAL, targetIds: [TARGET], intervalSeconds: 300 },
  });
  assert.equal(conflict.statusCode, 409);
  assert.deepEqual(conflict.json(), { code: "CAMPAIGN_ALREADY_ACTIVE" });
});

test("campaign returns null when the user has never created one", async (t) => {
  class NoCampaigns extends FakeCampaigns { async getCurrent(): Promise<BroadcastCampaignView | null> { return null; } }
  const server = app({ campaigns: new NoCampaigns() });
  t.after(() => server.close());
  const result = await server.inject({ method: "GET", url: "/v1/broadcast/campaigns" });
  assert.deepEqual(result.json(), { campaign: null });
});

test("campaign requires authentication and a valid id", async (t) => {
  const server = app();
  const anonymous = app({ userId: null });
  t.after(() => server.close());
  t.after(() => anonymous.close());

  const denied = await anonymous.inject({ method: "GET", url: "/v1/broadcast/campaigns" });
  assert.deepEqual(denied.json(), { code: "USER_REQUIRED" });

  const invalidId = await server.inject({ method: "POST", url: "/v1/broadcast/campaigns/not-a-uuid/stop" });
  assert.equal(invalidId.statusCode, 400);
  assert.deepEqual(invalidId.json(), { code: "INVALID_CAMPAIGN_ID" });
});

test("admin can create, read, and stop a campaign for an arbitrary user", async (t) => {
  const campaigns = new FakeCampaigns();
  const server = app({ adminId: "admin-1", campaigns });
  t.after(() => server.close());

  const created = await server.inject({
    method: "POST", url: `/v1/admin/users/${OTHER_USER}/broadcast/campaigns`,
    payload: { accountMode: "USERBOT", materialId: MATERIAL, targetIds: [TARGET], intervalSeconds: 300 },
  });
  assert.equal(created.statusCode, 201);

  const viewed = await server.inject({ method: "GET", url: `/v1/admin/users/${OTHER_USER}/broadcast/campaigns` });
  assert.equal(viewed.statusCode, 200);
  assert.equal(viewed.json().campaign.id, CAMPAIGN);

  const stopped = await server.inject({ method: "POST", url: `/v1/admin/users/${OTHER_USER}/broadcast/campaigns/${CAMPAIGN}/stop` });
  assert.equal(stopped.statusCode, 204);

  assert.deepEqual(campaigns.seenUserIds, [OTHER_USER, OTHER_USER, OTHER_USER]);
});

test("admin campaign routes reject a non-admin and an invalid user id", async (t) => {
  const nonAdmin = app();
  const admin = app({ adminId: "admin-1" });
  t.after(() => nonAdmin.close());
  t.after(() => admin.close());

  const denied = await nonAdmin.inject({ method: "GET", url: `/v1/admin/users/${OTHER_USER}/broadcast/campaigns` });
  assert.equal(denied.statusCode, 403);
  assert.deepEqual(denied.json(), { code: "ADMIN_REQUIRED" });

  const invalidUser = await admin.inject({ method: "GET", url: "/v1/admin/users/not-a-uuid/broadcast/campaigns" });
  assert.equal(invalidUser.statusCode, 400);
  assert.deepEqual(invalidUser.json(), { code: "INVALID_USER_ID" });
});
