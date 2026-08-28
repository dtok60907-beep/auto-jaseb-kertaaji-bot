import assert from "node:assert/strict";
import test from "node:test";
import { BroadcastTargetValidationError, validateBroadcastLpmTarget } from "../src/domain/broadcast-target.ts";

test("validates and freezes a broadcast LPM target", () => {
  const target = validateBroadcastLpmTarget({
    telegramTargetRef: "  @lpm_bali  ",
    label: "  LPM Bali  ",
    active: true,
  });

  assert.deepEqual(target, { telegramTargetRef: "@lpm_bali", label: "LPM Bali", active: true });
  assert.equal(Object.isFrozen(target), true);
});

test("broadcast LPM target has field-level validation errors", () => {
  assert.throws(
    () => validateBroadcastLpmTarget({ telegramTargetRef: "", label: "", active: "yes" }),
    (error: unknown) => {
      if (!(error instanceof BroadcastTargetValidationError)) return false;
      assert.deepEqual(error.issues, [
        { field: "telegramTargetRef", code: "REQUIRED" },
        { field: "label", code: "REQUIRED" },
        { field: "active", code: "MUST_BE_BOOLEAN" },
      ]);
      return true;
    },
  );
});
