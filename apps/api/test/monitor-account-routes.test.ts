import assert from "node:assert/strict";
import test from "node:test";

import { createApi } from "../src/app.ts";
import type { MonitorAccountRepository, MonitorAccountView } from "../src/monitors/repository.ts";

const MONITOR = "70000000-0000-4000-8000-000000000001";

class FakeMonitors implements MonitorAccountRepository {
  item: MonitorAccountView = Object.freeze({
    id: MONITOR,
    label: "Central monitor",
    accountStatus: "READY",
    active: true,
    sourceCount: 8,
    readySourceCount: 7,
    lastRuntimeErrorCode: null,
  });
  async list() { return [this.item]; }
  async setActive(accountId: string, active: boolean) {
    if (accountId !== MONITOR) return null;
    this.item = Object.freeze({ ...this.item, active });
    return this.item;
  }
}

function api(admin: boolean) {
  const empty = {
    async list() { return []; }, async create() { throw new Error("unused"); },
    async update() { return null; }, async remove() { return false; },
  };
  return createApi({
    packages: empty as never,
    broadcasts: empty as never,
    autoComments: empty as never,
    entitlements: empty as never,
    monitors: new FakeMonitors(),
    authorizeUser: async () => null,
    authorizeAdmin: async () => admin ? { id: "admin" } : null,
  });
}

test("admin can inspect and toggle the centralized monitor without exposing its session", async (t) => {
  const server = api(true);
  t.after(() => server.close());

  const listed = await server.inject({ method: "GET", url: "/v1/admin/monitor-accounts" });
  const disabled = await server.inject({ method: "PUT", url: `/v1/admin/monitor-accounts/${MONITOR}`, payload: { active: false } });

  assert.equal(listed.statusCode, 200);
  assert.equal(JSON.stringify(listed.json()).includes("session"), false);
  assert.equal(disabled.statusCode, 200);
  assert.equal(disabled.json().monitor.active, false);
});

test("monitor management requires admin and rejects malformed settings", async (t) => {
  const denied = api(false);
  const server = api(true);
  t.after(() => denied.close());
  t.after(() => server.close());

  const blocked = await denied.inject({ method: "GET", url: "/v1/admin/monitor-accounts" });
  const malformed = await server.inject({ method: "PUT", url: `/v1/admin/monitor-accounts/${MONITOR}`, payload: { active: true, extra: true } });

  assert.deepEqual(blocked.json(), { code: "ADMIN_REQUIRED" });
  assert.equal(malformed.statusCode, 422);
  assert.deepEqual(malformed.json(), { code: "INVALID_MONITOR_ACCOUNT_SETTING" });
});
