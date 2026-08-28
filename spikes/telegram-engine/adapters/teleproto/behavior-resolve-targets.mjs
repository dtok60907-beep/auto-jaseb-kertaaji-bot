/** Resolve controlled Telegram targets without join/send side effects. */

import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { SessionConfig, createTeleprotoAdapter } from "./adapter.mjs";

const SCENARIO = "resolve_controlled_targets";
const CANDIDATE = "teleproto";
const ADAPTER_VERSION = "teleproto@1.228.5";
export const TARGET_ROLES = Object.freeze({
  public_group: "TELEGRAM_TEST_PUBLIC_TARGET",
  discussion_channel: "TELEGRAM_TEST_DISCUSSION_CHANNEL",
});

function metadata() {
  return {
    type: "metadata",
    candidate: CANDIDATE,
    runtime: "node",
    runtimeVersion: process.version,
    adapterVersion: ADAPTER_VERSION,
    scenarioSet: "behavior-resolve-v1",
  };
}

function failureCode(error) {
  return typeof error?.code === "string" && error.code ? error.code : "TARGET_RESOLVE_FAILED";
}

export async function runResolveTargets({ createAdapter, targets, now = () => performance.now() }) {
  const records = [metadata()];
  const adapter = createAdapter();
  try {
    await adapter.connect();
    for (const role of Object.keys(TARGET_ROLES)) {
      const target = targets?.[role]?.trim();
      if (!target) throw new Error(`${TARGET_ROLES[role]} wajib diisi untuk behavior test.`);
      const started = now();
      const resolved = await adapter.resolveTarget(target);
      records.push({
        type: "sample",
        candidate: CANDIDATE,
        scenario: SCENARIO,
        sessions: 1,
        metric: "resolve_latency",
        value: Math.max(0, now() - started),
        unit: "ms",
        targetRole: role,
        entityType: resolved.entityType,
      });
      records.push({
        type: "assertion",
        candidate: CANDIDATE,
        scenario: SCENARIO,
        name: `${role}_resolved`,
        passed: true,
        hardGate: true,
        targetRole: role,
        entityType: resolved.entityType,
      });
    }
  } catch (error) {
    records.push({
      type: "assertion",
      candidate: CANDIDATE,
      scenario: SCENARIO,
      name: "all_targets_resolved",
      passed: false,
      hardGate: true,
      code: failureCode(error),
    });
    return { records, passed: false };
  } finally {
    try {
      await adapter.disconnect();
    } catch {
      // Preserve the original assertion. Resolve runner performs no external writes.
    }
  }

  records.push({
    type: "assertion",
    candidate: CANDIDATE,
    scenario: SCENARIO,
    name: "all_targets_resolved",
    passed: true,
    hardGate: true,
  });
  return { records, passed: true };
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} wajib diisi untuk behavior test akun uji.`);
  return value;
}

async function main() {
  let result;
  try {
    const config = new SessionConfig({
      apiId: Number(required("TELEGRAM_TEST_API_ID")),
      apiHash: required("TELEGRAM_TEST_API_HASH"),
      session: required("TELEGRAM_TEST_SESSION"),
    });
    const targets = Object.fromEntries(Object.entries(TARGET_ROLES).map(([role, name]) => [role, required(name)]));
    result = await runResolveTargets({ createAdapter: () => createTeleprotoAdapter(config), targets });
  } catch (error) {
    result = {
      records: [
        metadata(),
        {
          type: "assertion",
          candidate: CANDIDATE,
          scenario: SCENARIO,
          name: "all_targets_resolved",
          passed: false,
          hardGate: true,
          code: failureCode(error),
        },
      ],
      passed: false,
    };
  }
  for (const record of result.records) process.stdout.write(`${JSON.stringify(record)}\n`);
  process.exitCode = result.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
