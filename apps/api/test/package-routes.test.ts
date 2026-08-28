import assert from "node:assert/strict";
import test from "node:test";
import { createApi } from "../src/app.ts";
import type { BroadcastSettingsRepository } from "../src/broadcast/repository.ts";
import type { AutoCommentSettingsRepository } from "../src/auto-comment/repository.ts";
import { toPublicPackage, type PackageConfig } from "../src/domain/package-catalog.ts";
import type { CreatePackageInput, PackageRepository, PackageView, PublishPackageInput } from "../src/packages/repository.ts";

const config: PackageConfig = {
  name: "Worker Basic",
  type: "JASEB_WORKER",
  priceIdr: 150000,
  durationDays: 30,
  features: ["JASEB"],
  maxTargetsPerMinute: 20,
  maxAccounts: 1,
  intervalMinSeconds: 0,
  intervalMaxSeconds: 3600,
  displayOrder: 1,
  active: true,
};

class FakePackages implements PackageRepository {
  private rows: PackageView[] = [];

  async create(input: CreatePackageInput): Promise<PackageView> {
    if (this.rows.some((row) => row.code === input.code)) {
      throw Object.assign(new Error("duplicate"), { code: "23505" });
    }
    const row = Object.freeze({ ...toPublicPackage(`pkg-${this.rows.length + 1}`, input.config), code: input.code, version: 1 });
    this.rows.push(row);
    return row;
  }

  async publish(input: PublishPackageInput): Promise<PackageView | null> {
    const index = this.rows.findIndex((row) => row.id === input.id);
    if (index < 0) return null;
    const old = this.rows[index];
    const row = Object.freeze({ ...toPublicPackage(old.id, input.config), code: old.code, version: old.version + 1 });
    this.rows[index] = row;
    return row;
  }

  async list({ includeInactive }: { includeInactive: boolean }): Promise<readonly PackageView[]> {
    return this.rows.filter((row) => includeInactive || row.active);
  }
}

class EmptyBroadcastSettings implements BroadcastSettingsRepository {
  async listMaterials(): Promise<readonly []> { return []; }
  async createMaterial(): Promise<never> { throw new Error("not used"); }
  async updateMaterial(): Promise<null> { return null; }
  async deleteMaterial(): Promise<boolean> { return false; }
  async listLpmTargets(): Promise<readonly []> { return []; }
  async createLpmTarget(): Promise<never> { throw new Error("not used"); }
  async updateLpmTarget(): Promise<null> { return null; }
  async deleteLpmTarget(): Promise<boolean> { return false; }
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

function app({ admin = true } = {}) {
  return createApi({
    packages: new FakePackages(),
    broadcasts: new EmptyBroadcastSettings(),
    autoComments: new EmptyAutoComments(),
    authorizeAdmin: async () => admin ? { id: "00000000-0000-0000-0000-000000000001" } : null,
    authorizeUser: async () => ({ id: "00000000-0000-0000-0000-000000000001" }),
  });
}

test("admin creates and publishes an immutable package version", async (t) => {
  const server = app();
  t.after(() => server.close());
  const created = await server.inject({ method: "POST", url: "/v1/admin/packages", payload: { code: "worker-basic", ...config } });
  assert.equal(created.statusCode, 201);
  const first = created.json().package;
  assert.equal(first.version, 1);
  assert.equal(first.priceIdr, 150000);

  const published = await server.inject({ method: "PATCH", url: `/v1/admin/packages/${first.id}`, payload: { ...config, name: "Worker Standard", priceIdr: 200000 } });
  assert.equal(published.statusCode, 200);
  assert.deepEqual(published.json().package, { ...first, name: "Worker Standard", priceIdr: 200000, version: 2 });
  assert.equal(first.priceIdr, 150000);
});

test("public only sees active packages and admin sees inactive packages", async (t) => {
  const server = app();
  t.after(() => server.close());
  await server.inject({ method: "POST", url: "/v1/admin/packages", payload: { code: "hidden", ...config, active: false } });

  const publicList = await server.inject({ method: "GET", url: "/v1/packages" });
  const adminList = await server.inject({ method: "GET", url: "/v1/admin/packages" });
  assert.deepEqual(publicList.json(), { packages: [] });
  assert.equal(adminList.json().packages.length, 1);
});

test("admin authorization and runtime validation fail clearly", async (t) => {
  const noAdmin = app({ admin: false });
  t.after(() => noAdmin.close());
  const denied = await noAdmin.inject({ method: "POST", url: "/v1/admin/packages", payload: { code: "worker", ...config } });
  assert.deepEqual(denied.json(), { code: "ADMIN_REQUIRED" });

  const server = app();
  t.after(() => server.close());
  const invalid = await server.inject({ method: "POST", url: "/v1/admin/packages", payload: { code: "bad code", ...config, durationDays: 0 } });
  assert.equal(invalid.statusCode, 422);
  assert.deepEqual(invalid.json(), {
    code: "INVALID_PACKAGE",
    issues: [
      { field: "code", code: "INVALID_FORMAT" },
    ],
  });
});

test("duplicate code and missing package have stable errors", async (t) => {
  const server = app();
  t.after(() => server.close());
  await server.inject({ method: "POST", url: "/v1/admin/packages", payload: { code: "worker-basic", ...config } });
  const duplicate = await server.inject({ method: "POST", url: "/v1/admin/packages", payload: { code: "worker-basic", ...config } });
  const missing = await server.inject({ method: "PATCH", url: "/v1/admin/packages/missing", payload: config });
  assert.deepEqual(duplicate.json(), { code: "PACKAGE_CODE_EXISTS" });
  assert.deepEqual(missing.json(), { code: "PACKAGE_NOT_FOUND" });
});
