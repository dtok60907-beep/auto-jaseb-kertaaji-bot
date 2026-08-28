import assert from "node:assert/strict";
import test from "node:test";
import {
  PackageValidationError,
  snapshotEntitlement,
  toPublicPackage,
  validatePackageConfig,
} from "../src/domain/package-catalog.ts";

const validWorker = {
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

test("validates worker and userbot package configurations", () => {
  const worker = validatePackageConfig(validWorker);
  const userbot = validatePackageConfig({
    ...validWorker,
    name: "Userbot Pro",
    type: "USERBOT",
    features: ["JASEB", "AUTO_COMMENT_MF"],
    maxAccounts: 3,
  });

  assert.equal(worker.type, "JASEB_WORKER");
  assert.deepEqual(userbot.features, ["JASEB", "AUTO_COMMENT_MF"]);
  assert.equal(userbot.maxAccounts, 3);
});

test("rejects invalid package values with field-level issues", () => {
  assert.throws(
    () => validatePackageConfig({ ...validWorker, type: "UNKNOWN", durationDays: 0, intervalMinSeconds: 20, intervalMaxSeconds: 10, features: ["JASEB", "JASEB"] }),
    (error: unknown) => {
      if (!(error instanceof PackageValidationError)) return false;
      assert.deepEqual(error.issues, [
        { field: "type", code: "UNSUPPORTED" },
        { field: "durationDays", code: "MUST_BE_POSITIVE_INTEGER" },
        { field: "features", code: "DUPLICATE" },
        { field: "intervalMinSeconds", code: "MUST_NOT_EXCEED_MAXIMUM" },
      ]);
      return true;
    },
  );
});

test("public package and entitlement are immutable snapshots", () => {
  const pkg = toPublicPackage("pkg_userbot", { ...validWorker, type: "USERBOT", features: ["JASEB", "AUTO_COMMENT_MF"] });
  const entitlement = snapshotEntitlement(pkg);

  assert.equal(Object.isFrozen(pkg), true);
  assert.equal(Object.isFrozen(entitlement), true);
  assert.equal(entitlement.packageId, "pkg_userbot");
  assert.equal((entitlement as Record<string, unknown>).name, undefined);
  assert.deepEqual(entitlement.features, ["JASEB", "AUTO_COMMENT_MF"]);
  assert.throws(() => Object.defineProperty(pkg, "name", { value: "changed" }), TypeError);
});

test("zero price and zero minimum interval are allowed, negative values are rejected", () => {
  assert.equal(validatePackageConfig({ ...validWorker, priceIdr: 0, intervalMinSeconds: 0 }).priceIdr, 0);
  assert.throws(() => validatePackageConfig({ ...validWorker, priceIdr: -1 }), PackageValidationError);
});
