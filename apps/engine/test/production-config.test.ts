import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";

import {
  ProductionEngineConfig,
  ProductionEngineConfigError,
} from "../src/production/config.ts";
import {
  productionEnvironment,
  TEST_API_HASH,
  TEST_DATABASE_SECRET,
  TEST_SESSION_KEY,
} from "../test-support/production-fixtures.ts";

test("production config requires explicit capacity and exposes only redacted safe data", () => {
  const env = productionEnvironment();
  const config = ProductionEngineConfig.fromEnvironment(env);
  assert.deepEqual(config.shard, { shardCount: 2, shardIndex: 1 });
  assert.deepEqual(config.runnerPolicy, {
    leaseSeconds: 120,
    heartbeatIntervalMilliseconds: 30_000,
    maxActionsPerRun: 100,
    commandLeaseSeconds: 60,
    runtimeRetrySeconds: 15,
  });
  assert.deepEqual(config.supervisorPolicy, {
    maxConcurrentAccounts: 4,
    discoveryBatchSize: 20,
    reconciliationIntervalMilliseconds: 1_000,
    subscriptionRetryMilliseconds: 1_000,
    contendedAccountRetryMilliseconds: 5_000,
    failedAccountRetryMilliseconds: 5_000,
  });
  assert.equal(config.databasePolicy.prepareStatements, false);
  assert.equal(config.healthPolicy.port, 8080);
  assert.equal(config.sessionKeyRing().activeKeyVersion, 1);

  const publicViews = [JSON.stringify(config), inspect(config), String(config)];
  for (const view of publicViews) {
    assert.equal(view.includes(TEST_DATABASE_SECRET), false);
    assert.equal(view.includes(TEST_API_HASH), false);
    assert.equal(view.includes(TEST_SESSION_KEY), false);
  }
  assert.equal(JSON.parse(JSON.stringify(config)).redacted, true);
  assert.deepEqual(Object.keys(config).sort(), [
    "databasePolicy",
    "healthPolicy",
    "runnerPolicy",
    "shard",
    "supervisorPolicy",
    "telegramApiId",
    "telegramOperationTimeoutMilliseconds",
  ]);
});

test("invalid production environment reports only the stable field name", () => {
  const cases: Array<readonly [string, (env: Record<string, string>) => void, string]> = [
    ["missing capacity", (env) => { delete env.ENGINE_MAX_CONCURRENT_ACCOUNTS; }, "ENGINE_MAX_CONCURRENT_ACCOUNTS"],
    ["heartbeat exceeds half lease", (env) => { env.ENGINE_HEARTBEAT_INTERVAL_MS = "60001"; }, "ENGINE_HEARTBEAT_INTERVAL_MS"],
    ["command lease reaches account lease", (env) => { env.ENGINE_COMMAND_LEASE_SECONDS = "120"; }, "ENGINE_COMMAND_LEASE_SECONDS"],
    ["bad shard", (env) => { env.SHARD_INDEX = "2"; }, "SHARD_CONFIG"],
    ["database password absent", (env) => { env.DATABASE_URL = "postgresql://engine@localhost:5432/jaseb"; }, "DATABASE_URL"],
    ["database scheme rejected", (env) => { env.DATABASE_URL = "https://engine:secret@localhost/jaseb"; }, "DATABASE_URL"],
    ["API hash shape", (env) => { env.TELEGRAM_API_HASH = "raw-api-hash-value"; }, "TELEGRAM_API_HASH"],
    ["key ring rejected", (env) => { env.TELEGRAM_SESSION_KEYS = JSON.stringify({ 1: "secret-key-value" }); }, "TELEGRAM_SESSION_KEYS"],
    ["boolean exact", (env) => { env.ENGINE_DATABASE_PREPARE_STATEMENTS = "FALSE"; }, "ENGINE_DATABASE_PREPARE_STATEMENTS"],
    ["health host", (env) => { env.ENGINE_HEALTH_HOST = "127.0.0.1/path"; }, "ENGINE_HEALTH_HOST"],
  ];

  for (const [label, mutate, expectedField] of cases) {
    const env = productionEnvironment();
    mutate(env);
    let error: unknown;
    try { ProductionEngineConfig.fromEnvironment(env); }
    catch (caught) { error = caught; }
    assert.ok(error instanceof ProductionEngineConfigError, label);
    assert.deepEqual(error.publicData(), { code: "ENGINE_CONFIG_INVALID", field: expectedField }, label);
    const serialized = JSON.stringify(error);
    assert.equal(serialized.includes("secret"), false, label);
    assert.equal(serialized.includes(TEST_API_HASH), false, label);
    assert.equal(serialized.includes(TEST_SESSION_KEY), false, label);
  }
});
