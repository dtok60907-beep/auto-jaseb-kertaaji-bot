import assert from "node:assert/strict";
import test from "node:test";

import {
  PostgresLoadConfigError,
  validatePostgresLoadConfig,
  type PostgresLoadConfig,
} from "../src/benchmark/postgres-runtime-load.ts";
import { parsePostgresLoadArguments, runPostgresLoadCli } from "../src/benchmark/run-postgres-runtime-load.ts";

const valid = (): PostgresLoadConfig => ({
  databaseUrl: "postgresql://redacted",
  commit: "1234567",
  cases: [{ accounts: 10, concurrency: 2 }],
  samples: 3,
  warmupSamples: 1,
  databaseMaxConnections: 4,
  databaseConnectTimeoutSeconds: 10,
  providerLatencyMilliseconds: 0,
  monitorIntervalMilliseconds: 5,
  sampleTimeoutMilliseconds: 30_000,
  accountLeaseSeconds: 60,
  commandLeaseSeconds: 60,
});

function argumentsFor(overrides: Readonly<Record<string, string>> = {}): string[] {
  const values: Record<string, string> = {
    cases: "10:2",
    samples: "3",
    warmup: "1",
    "db-max-connections": "4",
    "db-connect-timeout-seconds": "10",
    "provider-latency-ms": "0",
    "monitor-interval-ms": "5",
    "timeout-ms": "30000",
    "account-lease-seconds": "60",
    "command-lease-seconds": "60",
    commit: "1234567",
    output: "benchmark-results/raw/test.jsonl",
    ...overrides,
  };
  return Object.entries(values).flatMap(([name, value]) => [`--${name}`, value]);
}

test("PostgreSQL load config retains every explicit workload input", () => {
  const config = validatePostgresLoadConfig(valid());
  assert.deepEqual(config.cases, [{ accounts: 10, concurrency: 2 }]);
  assert.equal(config.databaseMaxConnections, 4);
  assert.equal(config.databaseConnectTimeoutSeconds, 10);
  assert.equal(config.providerLatencyMilliseconds, 0);
  assert.equal(config.accountLeaseSeconds, 60);
  assert.equal(config.commandLeaseSeconds, 60);
});

test("PostgreSQL load config rejects unsafe or ambiguous workload values", () => {
  const invalid = [
    ["databaseUrl", { databaseUrl: "" }],
    ["commit", { commit: "dirty" }],
    ["cases.0.concurrency", { cases: [{ accounts: 1, concurrency: 2 }] }],
    ["cases", { cases: [{ accounts: 1, concurrency: 1 }, { accounts: 1, concurrency: 1 }] }],
    ["databaseMaxConnections", { databaseMaxConnections: 0 }],
    ["databaseConnectTimeoutSeconds", { databaseConnectTimeoutSeconds: 0 }],
    ["sampleTimeoutMilliseconds", { sampleTimeoutMilliseconds: 0 }],
  ] as const;
  for (const [field, override] of invalid) {
    assert.throws(
      () => validatePostgresLoadConfig({ ...valid(), ...override } as PostgresLoadConfig),
      (error: unknown) => error instanceof PostgresLoadConfigError && error.field === field,
    );
  }
});

test("PostgreSQL load CLI parser requires explicit known arguments and a database URL", () => {
  const parsed = parsePostgresLoadArguments(argumentsFor({ cases: "1:1,10:2" }), "postgresql://redacted");
  assert.deepEqual(parsed.config.cases, [{ accounts: 1, concurrency: 1 }, { accounts: 10, concurrency: 2 }]);
  assert.equal(parsed.outputPath, "benchmark-results/raw/test.jsonl");
  assert.equal(Object.isFrozen(parsed), true);

  const invalid: Array<readonly [() => unknown, string]> = [
    [() => parsePostgresLoadArguments(argumentsFor().slice(0, -2), "postgresql://redacted"), "output"],
    [() => parsePostgresLoadArguments([...argumentsFor(), "--mystery", "1"], "postgresql://redacted"), "mystery"],
    [() => parsePostgresLoadArguments(argumentsFor(), ""), "databaseUrl"],
    [() => parsePostgresLoadArguments(argumentsFor({ commit: "raw-secret-value" }), "postgresql://redacted"), "commit"],
    [() => parsePostgresLoadArguments(argumentsFor({ output: ".env" }), "postgresql://redacted"), "output"],
  ];
  for (const [operation, field] of invalid) {
    assert.throws(operation, (error: unknown) => {
      assert.ok(error instanceof PostgresLoadConfigError);
      assert.deepEqual(error.publicData(), { code: "POSTGRES_LOAD_CONFIG_INVALID", field });
      return true;
    });
  }
});

test("PostgreSQL load CLI emits only stable configuration failure data", async () => {
  const output: string[] = [];
  const errors: string[] = [];
  const exitCode = await runPostgresLoadCli({
    argv: argumentsFor({ commit: "raw-secret-value" }),
    databaseUrl: "postgresql://credential-that-must-not-print",
    writeArtifact: async () => { throw new Error("must not write"); },
    stdout: (value) => { output.push(value); },
    stderr: (value) => { errors.push(value); },
  });
  assert.equal(exitCode, 2);
  assert.equal(output.length, 0);
  assert.deepEqual(JSON.parse(errors.join("")), { code: "POSTGRES_LOAD_CONFIG_INVALID", field: "commit" });
  assert.equal(errors.join("").includes("raw-secret-value"), false);
  assert.equal(errors.join("").includes("credential-that-must-not-print"), false);
});
