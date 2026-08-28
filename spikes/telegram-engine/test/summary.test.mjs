import assert from "node:assert/strict";
import test from "node:test";
import { parseJsonLines, quantile, summarize } from "../src/summary.mjs";

test("quantile interpolates deterministic percentiles", () => {
  assert.equal(quantile([4, 1, 3, 2], 0.5), 2.5);
  assert.equal(quantile([10], 0.99), 10);
  assert.equal(quantile([], 0.5), null);
  assert.throws(() => quantile([1], 1.1), RangeError);
});

test("valid candidate is eligible and metrics are grouped by scenario/session/unit", () => {
  const records = parseJsonLines([
    JSON.stringify({ type: "metadata", candidate: "telethon", runtime: "python", version: "pinned" }),
    JSON.stringify({ type: "assertion", candidate: "telethon", scenario: "reconnect", name: "recovered", passed: true, hardGate: true }),
    JSON.stringify({ type: "sample", candidate: "telethon", scenario: "connect", sessions: 10, metric: "latency", value: 30, unit: "ms" }),
    JSON.stringify({ type: "sample", candidate: "telethon", scenario: "connect", sessions: 10, metric: "latency", value: 10, unit: "ms" }),
    JSON.stringify({ type: "sample", candidate: "telethon", scenario: "connect", sessions: 10, metric: "event_loss", value: 0, unit: "count" }),
  ].join("\n"));

  const result = summarize(records).telethon;
  assert.equal(result.eligible, true);
  assert.equal(result.assertions.passed, 1);
  assert.equal(result.metrics.find((item) => item.metric === "latency").p50, 20);
});

test("event loss and duplicate side effects fail hard gate even without assertion", () => {
  const records = parseJsonLines([
    JSON.stringify({ type: "metadata", candidate: "teleproto", runtime: "node", version: "pinned" }),
    JSON.stringify({ type: "sample", candidate: "teleproto", scenario: "updates", sessions: 1, metric: "event_loss", value: 1, unit: "count" }),
    JSON.stringify({ type: "sample", candidate: "teleproto", scenario: "restart", sessions: 1, metric: "duplicate_side_effect", value: 2, unit: "count" }),
  ].join("\n"));

  const result = summarize(records).teleproto;
  assert.equal(result.eligible, false);
  assert.deepEqual(result.hardFailures, ["restart:duplicate_side_effect>0", "updates:event_loss>0"]);
});

test("failed hard assertion makes candidate ineligible", () => {
  const records = parseJsonLines([
    JSON.stringify({ type: "metadata", candidate: "telethon", runtime: "python", version: "pinned" }),
    JSON.stringify({ type: "assertion", candidate: "telethon", scenario: "shutdown", name: "no_dangling_task", passed: false, hardGate: true }),
  ].join("\n"));

  const result = summarize(records).telethon;
  assert.equal(result.eligible, false);
  assert.deepEqual(result.hardFailures, ["shutdown:no_dangling_task"]);
});

test("malformed input is rejected instead of silently ignored", () => {
  assert.throws(() => parseJsonLines("not-json"), /line 1: invalid JSON/);
  const result = summarize(parseJsonLines(JSON.stringify({ type: "sample", candidate: "x", scenario: "connect", sessions: 0, metric: "rss", value: 1, unit: "mb" }))).x;
  assert.equal(result.eligible, false);
  assert.match(result.invalid.join(" "), /positive integer/);
  assert.match(result.invalid.join(" "), /metadata/);
});
