import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";

import {
  RailwayTelegramSoakConfigError,
  parseRailwayTelegramSoakEnvironment,
  startRailwayTelegramSoakServer,
  summarizeRailwayTelegramSoak,
} from "../src/benchmark/railway-telegram-soak-server.ts";
import type { TelegramSoakOrchestrationResult } from "../src/benchmark/telegram-soak-orchestrator.ts";
import { productionEnvironment, TEST_API_HASH, TEST_DATABASE_SECRET, TEST_SESSION_KEY } from "../test-support/production-fixtures.ts";

function environment(overrides: Readonly<Record<string, string | undefined>> = {}): Record<string, string | undefined> {
  return {
    ...productionEnvironment(),
    PORT: "0",
    F57C_COMMIT: "b936c57",
    F57C_RUN_ID: "railway-unit",
    F57C_SOAK_MINUTES: "1",
    F57C_BURST_INTERVAL_SECONDS: "60",
    F57C_SEND_INTERVAL_SECONDS: "0",
    F57C_EXPECTED_ACCOUNTS: "1",
    F57C_APPROVED_COMMAND_COUNT: "2",
    F57C_TARGET_REF: "@safe_target",
    F57C_MONITOR_INTERVAL_MS: "60000",
    F57C_HEALTH_TIMEOUT_MS: "1000",
    F57C_DB_MAX_CONNECTIONS: "1",
    F57C_DB_CONNECT_TIMEOUT_SECONDS: "1",
    F57C_INTERRUPT_AT_MINUTES: "",
    F57C_REVOKE_ACCOUNT_INDEX: "",
    F57C_REVOKE_AFTER_MINUTES: "",
    F57C_SESSIONS_JSON: JSON.stringify(["private-telegram-session"]),
    ...overrides,
  };
}

function result(passed = true): TelegramSoakOrchestrationResult {
  return Object.freeze({
    passed,
    provisionedAccounts: 1,
    failureCode: passed ? null : "F57C_HARD_GATE_FAILED",
    cleanup: Object.freeze({
      deletedAccounts: 1, deletedUsers: 1, deletedOperations: 2,
      remainingAccounts: 0, remainingOperations: 0, remainingLeases: 0,
    }),
    run: Object.freeze({
      passed,
      summary: Object.freeze({
        runId: "railway-unit",
        elapsedMilliseconds: 60_000,
        burstsAttempted: 2,
        burstsEnqueued: 2,
        commandsEnqueued: 2,
        interruptsConfigured: 0,
        interruptsFired: 0,
        accountsProvisioned: 1,
        finalCounts: Object.freeze({
          accountsReady: 1, accountsRevoked: 0, accountsDegraded: 0,
          commandsCreated: 2, commandsSucceeded: 2, commandsPending: 0,
          commandsInFlight: 0, commandsFailedRetryable: 0, commandsFailedFinal: 0,
          commandsUncertain: 0, commandsCancelled: 0, activeLeases: 0,
        }),
        perAccount: Object.freeze([]),
        sendLatency: Object.freeze({
          sendsSucceeded: 2, latencyP50Milliseconds: 20,
          latencyP95Milliseconds: 30, latencyMaxMilliseconds: 30,
        }),
        malformedReceipts: 0,
        rssPeakBytes: 100_000,
        heapPeakBytes: 50_000,
        eventLoopP99MaximumMilliseconds: 3,
        cpuPercentOneCoreAverage: 2,
        engineCleanupErrorCodes: Object.freeze([]),
        supervisorRunnerFailures: 0,
        cleanupDeletedOperations: 2,
        cleanupSucceeded: true,
        remainingBurstOperations: 0,
      }),
    }),
  });
}

function call(port: number, path: string): Promise<Readonly<{ status: number; body: string }>> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, path }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve(Object.freeze({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      })));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

test("Railway Telegram soak config validates exact session cardinality and stays redacted", () => {
  const config = parseRailwayTelegramSoakEnvironment(environment());
  assert.equal(config.port, 0);
  assert.equal(config.environment().soakConfig.expectedAccounts, 1);
  const serialized = JSON.stringify(config);
  for (const secret of ["private-telegram-session", TEST_DATABASE_SECRET, TEST_API_HASH, TEST_SESSION_KEY]) {
    assert.equal(serialized.includes(secret), false);
  }

  for (const [field, env] of [
    ["F57C_SESSIONS_JSON", environment({ F57C_SESSIONS_JSON: "[]" })],
    ["F57C_SESSIONS_JSON", environment({ F57C_SESSIONS_JSON: "not-json" })],
    ["F57C_RUN_ID", environment({ F57C_RUN_ID: "bad id" })],
    ["PORT", environment({ PORT: "-1" })],
  ] as const) {
    assert.throws(() => parseRailwayTelegramSoakEnvironment(env), (error: unknown) => {
      assert.ok(error instanceof RailwayTelegramSoakConfigError);
      assert.equal(error.field, field);
      return true;
    });
  }
});

test("Railway report excludes per-account identity and all configuration secrets", () => {
  const report = summarizeRailwayTelegramSoak(result());
  assert.equal(report.passed, true);
  assert.equal(report.run?.commandsEnqueued, 2);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("perAccount"), false);
  assert.equal(serialized.includes("accountId"), false);
  assert.equal(serialized.includes("private"), false);
});

test("Railway server stays live during soak and becomes ready only after a verified pass", async () => {
  let resolveRun!: (value: TelegramSoakOrchestrationResult) => void;
  const pending = new Promise<TelegramSoakOrchestrationResult>((resolve) => { resolveRun = resolve; });
  const logs: Readonly<Record<string, unknown>>[] = [];
  const server = await startRailwayTelegramSoakServer({
    config: parseRailwayTelegramSoakEnvironment(environment()),
    execute: async () => pending,
    log: (record) => { logs.push(record); },
  });
  try {
    assert.equal((await call(server.port, "/health/live")).status, 200);
    assert.equal((await call(server.port, "/health/ready")).status, 503);
    assert.equal((await call(server.port, "/benchmark/summary")).status, 202);
    resolveRun(result(true));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal((await call(server.port, "/health/ready")).status, 200);
    const summary = await call(server.port, "/benchmark/summary");
    assert.equal(summary.status, 200);
    assert.equal(JSON.parse(summary.body).passed, true);
    assert.equal(logs.at(-1)?.type, "F57C_RAILWAY_SOAK_COMPLETED");
  } finally { await server.close(); }
});

test("Railway execution failure exposes one stable code and never the thrown detail", async () => {
  const logs: Readonly<Record<string, unknown>>[] = [];
  const server = await startRailwayTelegramSoakServer({
    config: parseRailwayTelegramSoakEnvironment(environment()),
    execute: async () => { throw new Error("raw database and session detail"); },
    log: (record) => { logs.push(record); },
  });
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const summary = await call(server.port, "/benchmark/summary");
    assert.equal(summary.status, 503);
    const serialized = JSON.stringify({ summary, logs });
    assert.equal(serialized.includes("raw database"), false);
    assert.equal(serialized.includes("F57C_RAILWAY_EXECUTION_FAILED"), true);
  } finally { await server.close(); }
});
