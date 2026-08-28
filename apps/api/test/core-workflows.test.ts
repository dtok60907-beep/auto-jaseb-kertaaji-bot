import assert from "node:assert/strict";
import test from "node:test";
import { planAutoComment, planBroadcast } from "../src/workflows/core-workflows.ts";

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

const rule = { ruleId: "rule-1", accountId: "user-1", regexSource: "promo|diskon", regexFlags: "i", commentText: "tertarik" };

test("auto comment plans only for regex matches and preserves discussion target", () => {
  const result = planAutoComment(rule, { channelId: "channel-1", postId: "post-1", text: "PROMO hari ini", discussionTargetId: "discussion-1" });

  assert.equal(result.status, "PLANNED");
  if (result.status !== "PLANNED") return;
  assert.equal(result.commands.length, 1);
  assert.equal(result.commands[0].discussionTargetId, "discussion-1");
  assert.equal(result.commands[0].idempotencyKey, "comment:rule-1:channel-1:post-1");
});

test("auto comment suppresses no-match, duplicate update, and missing discussion target", () => {
  assert.deepEqual(planAutoComment(rule, { channelId: "channel-1", postId: "post-2", text: "berita biasa", discussionTargetId: "discussion-1" }), { status: "IGNORED_NO_MATCH", commands: [] });
  assert.deepEqual(planAutoComment(rule, { channelId: "channel-1", postId: "post-1", text: "promo", discussionTargetId: "discussion-1" }, new Set(["comment:rule-1:channel-1:post-1"])), { status: "DUPLICATE_SUPPRESSED", commands: [] });
  assert.deepEqual(planAutoComment(rule, { channelId: "channel-1", postId: "post-3", text: "promo" }), { status: "REJECTED", code: "DISCUSSION_TARGET_MISSING", commands: [] });
});

test("invalid regex is rejected before side-effect planning", () => {
  assert.deepEqual(planAutoComment({ ...rule, regexSource: "[" }, { channelId: "channel-1", postId: "post-1", text: "promo", discussionTargetId: "discussion-1" }), { status: "REJECTED", code: "INVALID_REGEX", commands: [] });
});
