import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";

import { startProductionApiApplication } from "../src/production/application.ts";
import { ProductionApiConfig } from "../src/production/config.ts";

const databaseUrl = process.env.API_DATABASE_URL?.trim();

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TEST_PORT_UNAVAILABLE");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function config(port: number): ProductionApiConfig {
  const url = new URL(databaseUrl!);
  if (!url.password) url.password = "ephemeral-lifecycle-proof-only";
  return ProductionApiConfig.fromEnvironment({
    DATABASE_URL: url.toString(),
    TELEGRAM_BOT_TOKEN: "123456789:production-lifecycle-proof",
    TELEGRAM_API_ID: "12345",
    TELEGRAM_API_HASH: "ab".repeat(16),
    TELEGRAM_SESSION_ACTIVE_KEY_VERSION: "1",
    TELEGRAM_SESSION_KEYS: JSON.stringify({ 1: "cd".repeat(32) }),
    TELEGRAM_AUTH_FLOW_TTL_SECONDS: "600",
    API_DATABASE_MAX_CONNECTIONS: "2",
    API_DATABASE_CONNECT_TIMEOUT_SECONDS: "5",
    API_DATABASE_IDLE_TIMEOUT_SECONDS: "10",
    API_DATABASE_MAX_LIFETIME_SECONDS: "300",
    API_DATABASE_CLOSE_TIMEOUT_SECONDS: "5",
    API_DATABASE_PREPARE_STATEMENTS: "false",
    API_SESSION_TTL_SECONDS: "3600",
    TELEGRAM_INIT_DATA_MAX_AGE_SECONDS: "300",
    TELEGRAM_INIT_DATA_CLOCK_SKEW_SECONDS: "30",
    API_HOST: "127.0.0.1",
    PORT: String(port),
    API_READINESS_PROBE_INTERVAL_MS: "100",
    API_READINESS_PROBE_TIMEOUT_MS: "50",
    API_READINESS_FAILURE_THRESHOLD: "2",
    API_SHUTDOWN_GRACE_MS: "1000",
  });
}

test("production executable probes PostgreSQL, serves real HTTP, and drains cleanly", { skip: !databaseUrl }, async () => {
  const port = await availablePort();
  const application = await startProductionApiApplication(config(port));
  const base = `http://127.0.0.1:${port}`;
  try {
    const live = await fetch(`${base}/health/live`);
    const ready = await fetch(`${base}/health/ready`);
    const packages = await fetch(`${base}/v1/packages`);
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { status: "alive" });
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { status: "ready", state: "RUNNING", errorCode: null });
    assert.equal(packages.status, 200);
    assert.deepEqual(await packages.json(), { packages: [] });
  } finally {
    const summary = await application.stop("SIGTERM");
    assert.deepEqual(summary, {
      state: "STOPPED",
      reason: "SIGTERM",
      forcedHttpClose: false,
      cleanupErrorCodes: [],
    });
  }
  await assert.rejects(fetch(`${base}/health/live`));
});
