import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";

import { ProductionApiConfig, ProductionApiConfigError } from "../src/production/config.ts";

const DATABASE_SECRET = "postgresql://api_user:database-password@pooler.example.com:5432/app";
const BOT_SECRET = "123456789:telegram-bot-secret-token";

function validEnvironment(): Record<string, string> {
  return {
    DATABASE_URL: DATABASE_SECRET,
    TELEGRAM_BOT_TOKEN: BOT_SECRET,
    API_DATABASE_MAX_CONNECTIONS: "5",
    API_DATABASE_CONNECT_TIMEOUT_SECONDS: "10",
    API_DATABASE_IDLE_TIMEOUT_SECONDS: "30",
    API_DATABASE_MAX_LIFETIME_SECONDS: "1800",
    API_DATABASE_CLOSE_TIMEOUT_SECONDS: "10",
    API_DATABASE_PREPARE_STATEMENTS: "false",
    API_SESSION_TTL_SECONDS: "43200",
    TELEGRAM_INIT_DATA_MAX_AGE_SECONDS: "300",
    TELEGRAM_INIT_DATA_CLOCK_SKEW_SECONDS: "30",
    API_HOST: "0.0.0.0",
    PORT: "8080",
    API_READINESS_PROBE_INTERVAL_MS: "5000",
    API_READINESS_PROBE_TIMEOUT_MS: "2000",
    API_READINESS_FAILURE_THRESHOLD: "3",
    API_SHUTDOWN_GRACE_MS: "30000",
  };
}

test("parses a complete explicit production policy and freezes public views", () => {
  const config = ProductionApiConfig.fromEnvironment(validEnvironment());
  assert.deepEqual(config.databasePolicy, {
    maxConnections: 5,
    connectTimeoutSeconds: 10,
    idleTimeoutSeconds: 30,
    maxLifetimeSeconds: 1800,
    closeTimeoutSeconds: 10,
    prepareStatements: false,
  });
  assert.deepEqual(config.authPolicy, {
    sessionTtlSeconds: 43_200,
    initDataMaxAgeSeconds: 300,
    initDataClockSkewSeconds: 30,
  });
  assert.deepEqual(config.serverPolicy, {
    host: "0.0.0.0",
    port: 8080,
    readinessProbeIntervalMilliseconds: 5_000,
    readinessProbeTimeoutMilliseconds: 2_000,
    readinessFailureThreshold: 3,
    shutdownGraceMilliseconds: 30_000,
  });
  assert.equal(config.databaseUrl(), DATABASE_SECRET);
  assert.equal(config.telegramBotToken(), BOT_SECRET);
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.databasePolicy), true);
});

test("redacts both production secrets from JSON, string, and inspect", () => {
  const config = ProductionApiConfig.fromEnvironment(validEnvironment());
  const rendered = [JSON.stringify(config), String(config), inspect(config)].join("\n");
  assert.equal(rendered.includes(DATABASE_SECRET), false);
  assert.equal(rendered.includes("database-password"), false);
  assert.equal(rendered.includes(BOT_SECRET), false);
  assert.equal(rendered.includes("telegram-bot-secret-token"), false);
  assert.deepEqual(JSON.parse(JSON.stringify(config)), {
    redacted: true,
    databasePolicy: config.databasePolicy,
    authPolicy: config.authPolicy,
    serverPolicy: config.serverPolicy,
  });
});

test("rejects missing or malformed secret, host, boolean, and timeout relation by field only", () => {
  const fixtures: ReadonlyArray<readonly [string, string | undefined, string]> = [
    ["DATABASE_URL", undefined, "DATABASE_URL"],
    ["DATABASE_URL", "https://example.com/db", "DATABASE_URL"],
    ["TELEGRAM_BOT_TOKEN", "bad token", "TELEGRAM_BOT_TOKEN"],
    ["API_DATABASE_PREPARE_STATEMENTS", "yes", "API_DATABASE_PREPARE_STATEMENTS"],
    ["API_HOST", "0.0.0.0/path", "API_HOST"],
    ["PORT", "0", "PORT"],
    ["API_READINESS_PROBE_TIMEOUT_MS", "5001", "API_READINESS_PROBE_TIMEOUT_MS"],
  ];
  for (const [field, value, expectedField] of fixtures) {
    const env: Record<string, string | undefined> = validEnvironment();
    env[field] = value;
    let caught: unknown;
    try { ProductionApiConfig.fromEnvironment(env); } catch (error) { caught = error; }
    assert.equal(caught instanceof ProductionApiConfigError, true);
    assert.deepEqual(JSON.parse(JSON.stringify(caught)), { code: "API_CONFIG_INVALID", field: expectedField });
    assert.equal((caught as Error).message, `API_CONFIG_INVALID:${expectedField}`);
    const rendered = inspect(caught);
    assert.equal(rendered.includes(DATABASE_SECRET), false);
    assert.equal(rendered.includes(BOT_SECRET), false);
  }
});

test("enforces both numeric boundaries for every production number", () => {
  const boundaries: ReadonlyArray<readonly [string, string, string]> = [
    ["API_DATABASE_MAX_CONNECTIONS", "0", "51"],
    ["API_DATABASE_CONNECT_TIMEOUT_SECONDS", "0", "61"],
    ["API_DATABASE_IDLE_TIMEOUT_SECONDS", "0", "3601"],
    ["API_DATABASE_MAX_LIFETIME_SECONDS", "59", "86401"],
    ["API_DATABASE_CLOSE_TIMEOUT_SECONDS", "0", "61"],
    ["API_SESSION_TTL_SECONDS", "299", "604801"],
    ["TELEGRAM_INIT_DATA_MAX_AGE_SECONDS", "0", "86401"],
    ["TELEGRAM_INIT_DATA_CLOCK_SKEW_SECONDS", "-1", "301"],
    ["PORT", "0", "65536"],
    ["API_READINESS_PROBE_INTERVAL_MS", "99", "300001"],
    ["API_READINESS_PROBE_TIMEOUT_MS", "0", "120001"],
    ["API_READINESS_FAILURE_THRESHOLD", "0", "101"],
    ["API_SHUTDOWN_GRACE_MS", "99", "300001"],
  ];
  for (const [field, below, above] of boundaries) {
    for (const value of [below, above]) {
      const env = validEnvironment();
      env[field] = value;
      assert.throws(
        () => ProductionApiConfig.fromEnvironment(env),
        (error) => error instanceof ProductionApiConfigError && error.field === field,
      );
    }
  }
});
