import assert from "node:assert/strict";
import test from "node:test";
import { planBroadcast } from "../src/workflows/core-workflows.ts";

test("broadcast creates one ordered idempotent command per target", () => {
  const result = planBroadcast({
    operationId: "op-1",
    accountId: "worker-1",
    accountMode: "JASEB_WORKER",
    targetIds: ["group-a", "group-b", "group-c"],
    text: "materi",
  });

  assert.equal(result.status, "PLANNED");
  if (result.status !== "PLANNED") return;
  assert.deepEqual(result.commands.map((command) => command.targetId), ["group-a", "group-b", "group-c"]);
  assert.equal(new Set(result.commands.map((command) => command.idempotencyKey)).size, 3);
  assert.equal(result.commands.every((command) => command.accountId === "worker-1"), true);
});

test("broadcast rejects duplicate targets and invalid payloads", () => {
  assert.deepEqual(planBroadcast({ operationId: "op-1", accountId: "user-1", accountMode: "USERBOT", targetIds: ["group-a", "group-a"], text: "x" }), { status: "REJECTED", code: "DUPLICATE_TARGET", commands: [] });
  assert.deepEqual(planBroadcast({ operationId: "", accountId: "user-1", accountMode: "USERBOT", targetIds: ["group-a"], text: "x" }), { status: "REJECTED", code: "INVALID_BROADCAST", commands: [] });
});
