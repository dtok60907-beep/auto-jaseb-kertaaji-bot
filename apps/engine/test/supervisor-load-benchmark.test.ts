import assert from "node:assert/strict";
import test from "node:test";

import {
  SupervisorLoadBenchmarkConfigError,
  validateSupervisorLoadBenchmarkConfig,
  type SupervisorLoadBenchmarkConfig,
} from "../src/benchmark/contracts.ts";
import {
  parseSupervisorLoadArguments,
  runSupervisorLoadCli,
} from "../src/benchmark/run-supervisor-load.ts";
import { runSupervisorLoadBenchmark } from "../src/benchmark/supervisor-load.ts";

function config(overrides: Partial<SupervisorLoadBenchmarkConfig> = {}): SupervisorLoadBenchmarkConfig {
  return {
    commit: "7bac744",
    cases: Object.freeze([{ accounts: 4, concurrency: 2 }]),
    samples: 1,
    warmupSamples: 0,
    runnerLatencyMilliseconds: 2,
    monitorSampleIntervalMilliseconds: 1,
    sampleTimeoutMilliseconds: 500,
    supervisorPolicy: Object.freeze({
      discoveryBatchSize: 4,
      reconciliationIntervalMilliseconds: 10,
      subscriptionRetryMilliseconds: 10,
      contendedAccountRetryMilliseconds: 10,
      failedAccountRetryMilliseconds: 10,
    }),
    ...overrides,
  };
}

function argumentsFor(overrides: Readonly<Record<string, string>> = {}): string[] {
  const values: Record<string, string> = {
    cases: "4:2",
    samples: "1",
    warmup: "0",
    "runner-latency-ms": "1",
    "monitor-interval-ms": "1",
    "timeout-ms": "500",
    "discovery-batch-size": "4",
    "reconciliation-ms": "10",
    "subscription-retry-ms": "10",
    "contended-retry-ms": "10",
    "failed-retry-ms": "10",
    commit: "7bac744",
    ...overrides,
  };
  return Object.entries(values).flatMap(([name, value]) => [`--${name}`, value]);
}

test("benchmark config and CLI require every explicit workload value", () => {
  const parsed = parseSupervisorLoadArguments(argumentsFor({ cases: "1:1,10:2" }));
  assert.deepEqual(parsed.cases, [{ accounts: 1, concurrency: 1 }, { accounts: 10, concurrency: 2 }]);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.cases), true);
  assert.equal(Object.isFrozen(parsed.supervisorPolicy), true);

  const invalid: Array<readonly [string, () => unknown, string]> = [
    ["missing argument", () => parseSupervisorLoadArguments(argumentsFor().slice(0, -2)), "commit"],
    ["unknown argument", () => parseSupervisorLoadArguments([...argumentsFor(), "--mystery", "1"]), "mystery"],
    ["duplicate case", () => validateSupervisorLoadBenchmarkConfig(config({ cases: [{ accounts: 4, concurrency: 2 }, { accounts: 4, concurrency: 2 }] })), "cases"],
    ["concurrency above accounts", () => validateSupervisorLoadBenchmarkConfig(config({ cases: [{ accounts: 2, concurrency: 3 }] })), "cases.0.concurrency"],
    ["invalid commit", () => validateSupervisorLoadBenchmarkConfig(config({ commit: "raw secret" })), "commit"],
  ];
  for (const [label, operation, field] of invalid) {
    assert.throws(operation, (error: unknown) => {
      assert.ok(error instanceof SupervisorLoadBenchmarkConfigError, label);
      assert.deepEqual(error.publicData(), { code: "BENCHMARK_CONFIG_INVALID", field }, label);
      return true;
    });
  }
});

test("production supervisor load emits complete metrics and exact-once hard gates", async () => {
  const result = await runSupervisorLoadBenchmark(config({ warmupSamples: 1, samples: 2 }));
  assert.equal(result.passed, true);
  const metadata = result.records.filter((record) => record.type === "metadata");
  const assertions = result.records.filter((record) => record.type === "assertion");
  const samples = result.records.filter((record) => record.type === "sample");

  assert.equal(metadata.length, 1);
  assert.equal(metadata[0]?.scope, "SUPERVISOR_ONLY_SYNTHETIC");
  assert.equal("env" in metadata[0]!, false);
  assert.equal(assertions.length, 16);
  assert.ok(assertions.every((record) => record.passed && record.sampleIndex > 0));
  assert.ok(samples.every((record) => record.sampleIndex > 0 && Number.isFinite(record.value)));
  assert.equal(samples.some((record) => record.metric === "cpu"), true);
  assert.equal(samples.some((record) => record.metric === "rss_peak"), true);
  assert.equal(samples.some((record) => record.metric === "event_loop_delay_p99"), true);
  assert.equal(samples.some((record) => record.metric === "drain_duration"), true);
  assert.deepEqual(samples.filter((record) => record.metric === "event_loss").map((record) => record.value), [0, 0]);
  assert.deepEqual(samples.filter((record) => record.metric === "duplicate_side_effect").map((record) => record.value), [0, 0]);
  assert.deepEqual(samples.filter((record) => record.metric === "peak_concurrency").map((record) => record.value), [2, 2]);
});

test("sample timeout remains a hard failure and still drains the supervisor", async () => {
  const result = await runSupervisorLoadBenchmark(config({
    cases: [{ accounts: 4, concurrency: 1 }],
    runnerLatencyMilliseconds: 30,
    sampleTimeoutMilliseconds: 5,
  }));
  assert.equal(result.passed, false);
  const assertions = result.records.filter((record) => record.type === "assertion");
  const samples = result.records.filter((record) => record.type === "sample");
  assert.equal(assertions.find((record) => record.name === "sample_completed_before_timeout")?.passed, false);
  assert.equal(assertions.find((record) => record.name === "event_loss_zero")?.passed, false);
  assert.equal(assertions.find((record) => record.name === "drain_complete")?.passed, true);
  assert.equal(samples.find((record) => record.metric === "event_loss")?.value, 3);
  assert.equal(samples.find((record) => record.metric === "duplicate_side_effect")?.value, 0);
});

test("warm-up hard failure is visible but never contaminates measured samples", async () => {
  const result = await runSupervisorLoadBenchmark(config({
    cases: [{ accounts: 4, concurrency: 1 }],
    warmupSamples: 1,
    samples: 2,
    runnerLatencyMilliseconds: 30,
    sampleTimeoutMilliseconds: 5,
  }));
  assert.equal(result.passed, false);
  const assertions = result.records.filter((record) => record.type === "assertion");
  assert.ok(assertions.some((record) => record.sampleIndex === -1 && !record.passed));
  assert.equal(result.records.some((record) => record.type === "sample"), false);
});

test("CLI writes JSONL only after a complete run and uses stable failure output", async () => {
  const output: string[] = [];
  const errors: string[] = [];
  const exitCode = await runSupervisorLoadCli({
    argv: argumentsFor(),
    stdout: (value) => { output.push(value); },
    stderr: (value) => { errors.push(value); },
  });
  assert.equal(exitCode, 0);
  assert.equal(errors.length, 0);
  const records = output.join("").trim().split("\n").map((line) => JSON.parse(line) as { type: string });
  assert.equal(records[0]?.type, "metadata");
  assert.equal(records.some((record) => record.type === "assertion"), true);
  assert.equal(records.some((record) => record.type === "sample"), true);

  output.length = 0;
  const invalidExitCode = await runSupervisorLoadCli({
    argv: argumentsFor({ commit: "raw-secret-value" }),
    stdout: (value) => { output.push(value); },
    stderr: (value) => { errors.push(value); },
  });
  assert.equal(invalidExitCode, 2);
  assert.equal(output.length, 0);
  assert.deepEqual(JSON.parse(errors.at(-1)!), { code: "BENCHMARK_CONFIG_INVALID", field: "commit" });
  assert.equal(errors.at(-1)!.includes("raw-secret-value"), false);
});
