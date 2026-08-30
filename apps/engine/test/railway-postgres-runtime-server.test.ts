import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";

import {
  RailwayPostgresLoadConfigError,
  parseRailwayPostgresLoadEnvironment,
  startRailwayPostgresLoadServer,
  summarizeRailwayPostgresLoad,
} from "../src/benchmark/railway-postgres-runtime-server.ts";
import type { PostgresLoadConfig } from "../src/benchmark/postgres-runtime-load.ts";

function environment(overrides: Readonly<Record<string, string | undefined>> = {}): Record<string, string | undefined> {
  return {
    DATABASE_URL: "postgresql://redacted:password@example.test:5432/postgres",
    PORT: "8080",
    F57B_COMMIT: "d36b4e8",
    F57B_CASES: "1:1,10:5",
    F57B_SAMPLES: "3",
    F57B_WARMUP: "1",
    F57B_DATABASE_MAX_CONNECTIONS: "12",
    F57B_DATABASE_CONNECT_TIMEOUT_SECONDS: "15",
    F57B_PROVIDER_LATENCY_MS: "0",
    F57B_MONITOR_INTERVAL_MS: "5",
    F57B_TIMEOUT_MS: "60000",
    F57B_ACCOUNT_LEASE_SECONDS: "60",
    F57B_COMMAND_LEASE_SECONDS: "60",
    ...overrides,
  };
}

function benchmark(): PostgresLoadConfig {
  return parseRailwayPostgresLoadEnvironment(environment()).benchmark;
}

function call(port: number, path: string): Promise<Readonly<{ status: number; body: string }>> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, path }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve(Object.freeze({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") })));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

test("Railway benchmark environment requires every explicit safe workload value", () => {
  const parsed = parseRailwayPostgresLoadEnvironment(environment());
  assert.equal(parsed.port, 8080);
  assert.deepEqual(parsed.benchmark.cases, [{ accounts: 1, concurrency: 1 }, { accounts: 10, concurrency: 5 }]);

  for (const [field, env] of [
    ["F57B_COMMIT", environment({ F57B_COMMIT: undefined })],
    ["F57B_CASES.0", environment({ F57B_CASES: "bad" })],
    ["DATABASE_URL", environment({ DATABASE_URL: "" })],
  ] as const) {
    assert.throws(() => parseRailwayPostgresLoadEnvironment(env), (error: unknown) => {
      assert.ok(error instanceof RailwayPostgresLoadConfigError);
      assert.deepEqual(error.publicData(), { code: "F57B_RAILWAY_CONFIG_INVALID", field });
      return true;
    });
  }
});

test("Railway summary retains metrics but excludes database credentials", () => {
  const report = summarizeRailwayPostgresLoad({
    passed: true,
    records: [
      { type: "metadata", databaseUrl: "postgresql://must-not-be-used" },
      { type: "assertion", passed: true },
      { type: "assertion", passed: true },
      { type: "sample", scenario: "postgres-runtime-c5", sessions: 10, metric: "total_duration", value: 100, unit: "ms" },
      { type: "sample", scenario: "postgres-runtime-c5", sessions: 10, metric: "total_duration", value: 200, unit: "ms" },
      { type: "sample", scenario: "postgres-runtime-c5", sessions: 10, metric: "throughput", value: 10, unit: "commands_per_second" },
      { type: "sample", scenario: "postgres-runtime-c5", sessions: 10, metric: "rss_peak", value: 1_000, unit: "bytes" },
      { type: "sample", scenario: "postgres-runtime-c5", sessions: 10, metric: "event_loop_delay_p99", value: 5, unit: "ms" },
    ],
  });
  assert.deepEqual(report.assertions, { total: 2, passed: 2, failed: 0 });
  assert.deepEqual(report.cases, [{
    accounts: 10, concurrency: 5, durationP50Milliseconds: 150, durationP95Milliseconds: 195,
    throughputP50CommandsPerSecond: 10, rssPeakMaximumBytes: 1_000, eventLoopP99MaximumMilliseconds: 5,
  }]);
  assert.equal(JSON.stringify(report).includes("must-not-be-used"), false);
});

test("Railway benchmark server stays live while running then exposes only a passed summary", async () => {
  const logs: Record<string, unknown>[] = [];
  const server = await startRailwayPostgresLoadServer({
    config: Object.freeze({ port: 0, benchmark: benchmark() }),
    run: async () => ({
      passed: true,
      records: [
        { type: "assertion", passed: true },
        { type: "sample", scenario: "postgres-runtime-c1", sessions: 1, metric: "total_duration", value: 10, unit: "ms" },
      ],
    }),
    log: (record) => { logs.push({ ...record }); },
  });
  try {
    assert.equal((await call(server.port, "/health/live")).status, 200);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal((await call(server.port, "/health/ready")).status, 200);
    const summary = await call(server.port, "/benchmark/summary");
    assert.equal(summary.status, 200);
    assert.equal(JSON.parse(summary.body).passed, true);
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.type, "F57B_RAILWAY_BENCHMARK_COMPLETED");
  } finally { await server.close(); }
});
