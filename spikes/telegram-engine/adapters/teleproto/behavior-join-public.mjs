/** Join one controlled public Telegram target and report only safe state. */

import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { SessionConfig, createTeleprotoAdapter } from "./adapter.mjs";

const SCENARIO = "join_public_target";
const CANDIDATE = "teleproto";
const ADAPTER_VERSION = "teleproto@1.228.5";

function metadata() {
  return {
    type: "metadata",
    candidate: CANDIDATE,
    runtime: "node",
    runtimeVersion: process.version,
    adapterVersion: ADAPTER_VERSION,
    scenarioSet: "behavior-public-join-v1",
  };
}

function failureCode(error) {
  return typeof error?.code === "string" && error.code ? error.code : "PUBLIC_JOIN_FAILED";
}

export async function runJoinPublic({ createAdapter, target, now = () => performance.now() }) {
  const records = [metadata()];
  const adapter = createAdapter();
  try {
    await adapter.connect();
    const started = now();
    const result = await adapter.joinPublicTarget(target);
    const elapsedMs = Math.max(0, now() - started);
    const state = result.state;
    const passed = state === "JOINED" || state === "ALREADY_MEMBER";
    records.push({
      type: "sample",
      candidate: CANDIDATE,
      scenario: SCENARIO,
      sessions: 1,
      metric: "join_latency",
      value: elapsedMs,
      unit: "ms",
      targetRole: "public_group",
      joinState: state,
    });
    records.push({
      type: "assertion",
      candidate: CANDIDATE,
      scenario: SCENARIO,
      name: "public_join_succeeded",
      passed,
      hardGate: true,
      targetRole: "public_group",
      joinState: state,
    });
    return { records, passed };
  } catch (error) {
    records.push({
      type: "assertion",
      candidate: CANDIDATE,
      scenario: SCENARIO,
      name: "public_join_succeeded",
      passed: false,
      hardGate: true,
      targetRole: "public_group",
      code: failureCode(error),
    });
    return { records, passed: false };
  } finally {
    try {
      await adapter.disconnect();
    } catch {
      // Preserve the original assertion; this runner never retries the join.
    }
  }
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
    result = await runJoinPublic({
      createAdapter: () => createTeleprotoAdapter(config),
      target: required("TELEGRAM_TEST_PUBLIC_TARGET"),
    });
  } catch (error) {
    result = {
      records: [
        metadata(),
        {
          type: "assertion",
          candidate: CANDIDATE,
          scenario: SCENARIO,
          name: "public_join_succeeded",
          passed: false,
          hardGate: true,
          targetRole: "public_group",
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
