import assert from "node:assert/strict";
import test from "node:test";
import { createApi } from "../src/app.ts";
import type { AutoCommentSettingsRepository } from "../src/auto-comment/repository.ts";
import type { BroadcastSettingsRepository } from "../src/broadcast/repository.ts";
import type { EntitlementRepository } from "../src/entitlements/repository.ts";
import type { PackageRepository } from "../src/packages/repository.ts";
import type { WorkerAccountSettingsRepository, WorkerAccountView } from "../src/workers/repository.ts";

const READY = "00000000-0000-0000-0000-000000000701";
const DISABLED = "00000000-0000-0000-0000-000000000702";
class EmptyPackages implements PackageRepository { async create(): Promise<never> { throw new Error("unused"); } async publish(): Promise<null> { return null; } async list(): Promise<readonly []> { return []; } }
class EmptyBroadcasts implements BroadcastSettingsRepository { async listMaterials(): Promise<readonly []> { return []; } async createMaterial(): Promise<never> { throw new Error("unused"); } async updateMaterial(): Promise<null> { return null; } async deleteMaterial(): Promise<boolean> { return false; } async listLpmTargets(): Promise<readonly []> { return []; } async createLpmTarget(): Promise<never> { throw new Error("unused"); } async updateLpmTarget(): Promise<null> { return null; } async deleteLpmTarget(): Promise<boolean> { return false; } }
class EmptyAutoComments implements AutoCommentSettingsRepository { async listSettings() { return { accounts: [], divisions: [], channelTargets: [] } as const; } async createDivision(): Promise<never> { throw new Error("unused"); } async updateDivision(): Promise<null> { return null; } async deleteDivision(): Promise<boolean> { return false; } async createKeyword(): Promise<null> { return null; } async deleteKeyword(): Promise<boolean> { return false; } async createTemplate(): Promise<null> { return null; } async updateTemplate(): Promise<null> { return null; } async deleteTemplate(): Promise<boolean> { return false; } async createChannelTarget(): Promise<never> { throw new Error("unused"); } async updateChannelTarget(): Promise<null> { return null; } async deleteChannelTarget(): Promise<boolean> { return false; } async attachChannel(): Promise<"NOT_FOUND"> { return "NOT_FOUND"; } async detachChannel(): Promise<boolean> { return false; } async decideCandidate(): Promise<never> { throw new Error("unused"); } }
class EmptyEntitlements implements EntitlementRepository { async grant(): Promise<never> { throw new Error("unused"); } async list(): Promise<readonly []> { return []; } async extend(): Promise<null> { return null; } async revoke(): Promise<boolean> { return false; } }
class FakeWorkers implements WorkerAccountSettingsRepository {
  private rows = new Map<string, WorkerAccountView>([
    [READY, { id: READY, label: "Worker Satu", accountStatus: "READY", intervalSeconds: null, active: null, availability: "NOT_CONFIGURED" }],
    [DISABLED, { id: DISABLED, label: "Worker Dua", accountStatus: "DISABLED", intervalSeconds: null, active: null, availability: "NOT_CONFIGURED" }],
  ]);
  async list() { return [...this.rows.values()]; }
  async update({ accountId, intervalSeconds, active }: Parameters<WorkerAccountSettingsRepository["update"]>[0]) {
    const old = this.rows.get(accountId); if (!old) return null;
    const availability = !active ? "DISABLED" : old.accountStatus !== "READY" ? "ACCOUNT_NOT_READY" : "READY";
    const next = { ...old, intervalSeconds, active, availability } as WorkerAccountView; this.rows.set(accountId, next); return next;
  }
}
function app(admin = true) { return createApi({ packages: new EmptyPackages(), broadcasts: new EmptyBroadcasts(), autoComments: new EmptyAutoComments(), entitlements: new EmptyEntitlements(), workers: new FakeWorkers(), authorizeAdmin: async () => admin ? { id: "admin" } : null, authorizeUser: async () => null }); }

test("admin configures a per-worker interval without exposing any session", async (t) => {
  const server = app(); t.after(() => server.close());
  const configured = await server.inject({ method: "PUT", url: `/v1/admin/worker-accounts/${READY}/settings`, payload: { intervalSeconds: 0, active: true } });
  const listed = await server.inject({ method: "GET", url: "/v1/admin/worker-accounts" });
  assert.equal(configured.statusCode, 200);
  assert.deepEqual(configured.json().worker, { id: READY, label: "Worker Satu", accountStatus: "READY", intervalSeconds: 0, active: true, availability: "READY" });
  assert.equal(JSON.stringify(listed.json()).includes("session"), false);
});
test("worker settings require admin and reject invalid input or unknown worker", async (t) => {
  const denied = app(false); const server = app(); t.after(() => denied.close()); t.after(() => server.close());
  const noAdmin = await denied.inject({ method: "GET", url: "/v1/admin/worker-accounts" });
  const invalid = await server.inject({ method: "PUT", url: `/v1/admin/worker-accounts/${READY}/settings`, payload: { intervalSeconds: -1, active: true } });
  const missing = await server.inject({ method: "PUT", url: "/v1/admin/worker-accounts/00000000-0000-0000-0000-000000000799/settings", payload: { intervalSeconds: 60, active: true } });
  assert.deepEqual(noAdmin.json(), { code: "ADMIN_REQUIRED" });
  assert.deepEqual(invalid.json().code, "INVALID_WORKER_ACCOUNT_SETTING");
  assert.deepEqual(missing.json(), { code: "WORKER_ACCOUNT_NOT_FOUND" });
});
