import assert from "node:assert/strict";
import test from "node:test";
import { resolveEntitlementAccess } from "../src/entitlements/access.ts";
import type { EntitlementView } from "../src/entitlements/repository.ts";

const future = "2030-01-02T00:00:00.000Z";
const expired = "2029-12-31T00:00:00.000Z";
function entitlement(packageType: EntitlementView["packageType"], status: string, expiresAt: string, maxLpmGroups: number, maxChannelTargets: number): EntitlementView {
  return { id: "e", userId: "u", packageId: "p", packageType, status, startsAt: "2029-01-01T00:00:00.000Z", expiresAt, maxLpmGroups, maxChannelTargets };
}
const now = Date.parse("2030-01-01T00:00:00.000Z");

test("Jasa Sebar uses the highest active LPM allowance across worker and userbot plans", () => {
  const access = resolveEntitlementAccess([
    entitlement("JASEB_WORKER", "ACTIVE", future, 3, 0),
    entitlement("USERBOT", "ACTIVE", future, 8, 4),
  ], "JASEB", now);
  assert.deepEqual(access, { ok: true, limit: 8 });
});
test("Auto Komen requires an active userbot entitlement and differentiates expiration", () => {
  assert.deepEqual(resolveEntitlementAccess([entitlement("JASEB_WORKER", "ACTIVE", future, 9, 0)], "AUTO_COMMENT_MF", now), { ok: false, code: "SUBSCRIPTION_REQUIRED" });
  assert.deepEqual(resolveEntitlementAccess([entitlement("USERBOT", "EXPIRED", expired, 9, 4)], "AUTO_COMMENT_MF", now), { ok: false, code: "SUBSCRIPTION_EXPIRED" });
});
