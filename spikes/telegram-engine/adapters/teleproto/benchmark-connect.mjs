/** One-scenario JSONL benchmark runner: connect -> authorized -> disconnect. */

import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { SessionConfig, createTeleprotoAdapter } from "./adapter.mjs";

const SCENARIO = "connect_authorized_disconnect";
const CANDIDATE = "teleproto";
const ADAPTER_VERSION = "teleproto@1.228.5";
const MAX_RUNS = 1_000;

function metadata() {
  return {
    type: "metadata",
    candidate: CANDIDATE,
    runtime: "node",
    runtimeVersion: process.version,
    adapterVersion: ADAPTER_VERSION,
    scenarioSet: "connect-v1",
  };
}

function failureCode(error) {
  return typeof error?.code === "string" && error.code ? error.code : "BENCHMARK_CONNECT_FAILED";
}

export async function runConnectSamples({ createAdapter, runs, now = performance.now }) {
  if (!Number.isInteger(runs) || runs < 1 || runs > MAX_RUNS) {
    throw new TypeError(`runs must be an integer between 1 and ${MAX_RUNS}`);
  }

  const records = [metadata()];
  for (let index = 0; index < runs; index += 1) {
    const adapter = createAdapter();
    const started = now();
    try {
      await adapter.connect();
      await adapter.disconnect();
    } catch (error) {
      try {
        await adapter.disconnect();
      } catch {
        // Cleanup is best effort only. The hard assertion preserves the real failure.
      }
      records.push({
        type: "assertion",
        candidate: CANDIDATE,
        scenario: SCENARIO,
        name: "all_iterations_passed",
        passed: false,
        hardGate: true,
        iteration: index + 1,
        code: failureCode(error),
      });
      return { records, passed: false };
    }
    records.push({
      type: "sample",
      candidate: CANDIDATE,
      scenario: SCENARIO,
      sessions: 1,
      metric: "latency",
      value: Math.max(0, now() - started),
      unit: "ms",
    });
  }
  records.push({
    type: "assertion",
    candidate: CANDIDATE,
    scenario: SCENARIO,
    name: "all_iterations_passed",
    passed: true,
    hardGate: true,
  });
  return { records, passed: true };
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} wajib diisi untuk benchmark akun uji.`);
  return value;
}

async function main() {
  const index = process.argv.indexOf("--runs");
  const runs = index === -1 ? 10 : Number(process.argv[index + 1]);
  let result;
  try {
    const config = new SessionConfig({
      apiId: Number(required("TELEGRAM_TEST_API_ID")),
      apiHash: required("TELEGRAM_TEST_API_HASH"),
      session: required("TELEGRAM_TEST_SESSION"),
    });
    result = await runConnectSamples({ createAdapter: () => createTeleprotoAdapter(config), runs });
  } catch (error) {
    result = {
      records: [
        metadata(),
        {
          type: "assertion",
          candidate: CANDIDATE,
          scenario: SCENARIO,
          name: "all_iterations_passed",
          passed: false,
          hardGate: true,
          iteration: 0,
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
