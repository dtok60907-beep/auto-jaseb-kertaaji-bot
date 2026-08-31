import assert from "node:assert/strict";
import test from "node:test";

import Fastify, { type FastifyInstance } from "fastify";
import type { Sql } from "postgres";

import {
  closeFastifyWithGrace,
  ProductionApiApplicationStartError,
  startProductionApiApplication,
  type ProductionApiApplicationEvent,
  type ProductionApiApplicationFactories,
  type ProductionApiReadinessMonitor,
} from "../src/production/application.ts";
import { ProductionApiConfig } from "../src/production/config.ts";
import type { ProductionApiDatabase } from "../src/production/database.ts";

function environment(overrides: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    DATABASE_URL: "postgresql://api:secret@example.test:5432/app",
    TELEGRAM_BOT_TOKEN: "123456:secret",
    TELEGRAM_API_ID: "12345",
    TELEGRAM_API_HASH: "ab".repeat(16),
    TELEGRAM_SESSION_ACTIVE_KEY_VERSION: "1",
    TELEGRAM_SESSION_KEYS: JSON.stringify({ 1: "cd".repeat(32) }),
    TELEGRAM_AUTH_FLOW_TTL_SECONDS: "600",
    API_DATABASE_MAX_CONNECTIONS: "3",
    API_DATABASE_CONNECT_TIMEOUT_SECONDS: "5",
    API_DATABASE_IDLE_TIMEOUT_SECONDS: "30",
    API_DATABASE_MAX_LIFETIME_SECONDS: "300",
    API_DATABASE_CLOSE_TIMEOUT_SECONDS: "5",
    API_DATABASE_PREPARE_STATEMENTS: "false",
    API_SESSION_TTL_SECONDS: "43200",
    TELEGRAM_INIT_DATA_MAX_AGE_SECONDS: "300",
    TELEGRAM_INIT_DATA_CLOCK_SKEW_SECONDS: "30",
    API_HOST: "0.0.0.0",
    PORT: "8080",
    API_READINESS_PROBE_INTERVAL_MS: "100",
    API_READINESS_PROBE_TIMEOUT_MS: "50",
    API_READINESS_FAILURE_THRESHOLD: "2",
    API_SHUTDOWN_GRACE_MS: "30000",
    ...overrides,
  };
}

class FakeDatabase implements ProductionApiDatabase {
  readonly events: string[];
  probeResults: Array<Error | null> = [];
  closeError: unknown = null;
  probeCalls = 0;
  closeCalls = 0;
  constructor(events: string[] = []) { this.events = events; }
  client(): Sql { return {} as Sql; }
  async probe(): Promise<void> {
    this.probeCalls += 1;
    const result = this.probeResults.shift();
    if (result) throw result;
  }
  async close(): Promise<void> {
    this.closeCalls += 1;
    this.events.push("database.close");
    if (this.closeError) throw this.closeError;
  }
}

class ManualMonitor implements ProductionApiReadinessMonitor {
  task: (() => Promise<"CONTINUE" | "STOP">) | null = null;
  readonly events: string[];
  stopError: unknown = null;
  stopCalls = 0;
  constructor(events: string[] = []) { this.events = events; }
  async tick() {
    if (!this.task) throw new Error("MONITOR_NOT_STARTED");
    return this.task();
  }
  async stop() {
    this.stopCalls += 1;
    this.events.push("monitor.stop");
    if (this.stopError) throw this.stopError;
  }
}

function factories(input: Readonly<{
  database: FakeDatabase;
  monitor: ManualMonitor;
  events?: string[];
  listenError?: unknown;
  monitorStartError?: unknown;
  forcedHttpClose?: boolean;
  closeHttpError?: unknown;
}>): Partial<ProductionApiApplicationFactories> {
  const events = input.events ?? [];
  return {
    openDatabase: async () => input.database,
    composeApi: () => Fastify({ logger: false }),
    listenApi: async () => {
      events.push("http.listen");
      if (input.listenError) throw input.listenError;
    },
    startReadinessMonitor: (_interval, task) => {
      if (input.monitorStartError) throw input.monitorStartError;
      input.monitor.task = task;
      return input.monitor;
    },
    closeApi: async (app: FastifyInstance) => {
      events.push("http.close");
      await app.close();
      if (input.closeHttpError) throw input.closeHttpError;
      return input.forcedHttpClose ?? false;
    },
  };
}

test("startup probe gates readiness; runtime threshold and recovery are deterministic", async () => {
  const config = ProductionApiConfig.fromEnvironment(environment());
  const events: string[] = [];
  const database = new FakeDatabase(events);
  const monitor = new ManualMonitor(events);
  const observed: ProductionApiApplicationEvent[] = [];
  let app: FastifyInstance | null = null;
  const application = await startProductionApiApplication(config, {
    observer: (event) => { observed.push(event); },
    factories: {
      ...factories({ database, monitor, events }),
      composeApi: () => { app = Fastify({ logger: false }); return app; },
    },
  });

  assert.equal(database.probeCalls, 1);
  assert.equal(application.readiness().ready, true);
  assert.equal((await app!.inject({ method: "GET", url: "/health/ready" })).statusCode, 200);

  database.probeResults = [new Error("raw DB detail"), new Error("raw DB detail"), null];
  assert.equal(await monitor.tick(), "CONTINUE");
  assert.equal(application.readiness().ready, true);
  assert.equal(await monitor.tick(), "CONTINUE");
  assert.deepEqual(application.readiness(), { ready: false, state: "RUNNING", errorCode: "DATABASE_UNAVAILABLE" });
  assert.equal((await app!.inject({ method: "GET", url: "/health/ready" })).statusCode, 503);
  assert.equal(await monitor.tick(), "CONTINUE");
  assert.equal(application.readiness().ready, true);
  assert.equal(JSON.stringify(observed).includes("raw DB detail"), false);

  const firstStop = application.stop("SIGTERM");
  const secondStop = application.stop("MANUAL");
  assert.equal(firstStop, secondStop);
  assert.deepEqual(application.readiness(), { ready: false, state: "STOPPING", errorCode: "API_STOPPING" });
  const summary = await firstStop;
  assert.deepEqual(events, ["http.listen", "monitor.stop", "http.close", "database.close"]);
  assert.deepEqual(summary, {
    state: "STOPPED",
    reason: "SIGTERM",
    forcedHttpClose: false,
    cleanupErrorCodes: [],
  });
});

test("startup failures roll back opened resources and expose only stable codes", async () => {
  const config = ProductionApiConfig.fromEnvironment(environment());
  const startupDatabase = new FakeDatabase();
  startupDatabase.probeResults = [new Error("raw password")];
  await assert.rejects(
    startProductionApiApplication(config, { factories: factories({ database: startupDatabase, monitor: new ManualMonitor() }) }),
    (error: unknown) => {
      assert.ok(error instanceof ProductionApiApplicationStartError);
      assert.deepEqual(error.publicData(), { code: "DATABASE_STARTUP_PROBE_FAILED", cleanupErrorCodes: [] });
      assert.equal(JSON.stringify(error).includes("raw password"), false);
      return true;
    },
  );
  assert.equal(startupDatabase.closeCalls, 1);

  const listenEvents: string[] = [];
  const listenDatabase = new FakeDatabase(listenEvents);
  await assert.rejects(
    startProductionApiApplication(config, { factories: factories({
      database: listenDatabase,
      monitor: new ManualMonitor(),
      events: listenEvents,
      listenError: new Error("raw bind detail"),
    }) }),
    (error: unknown) => error instanceof ProductionApiApplicationStartError && error.code === "API_LISTEN_FAILED",
  );
  assert.deepEqual(listenEvents, ["http.listen", "database.close"]);
});

test("shutdown continues across monitor, HTTP, and database cleanup failures", async () => {
  const config = ProductionApiConfig.fromEnvironment(environment());
  const events: string[] = [];
  const database = new FakeDatabase(events);
  database.closeError = new Error("raw close DB");
  const monitor = new ManualMonitor(events);
  monitor.stopError = new Error("raw monitor");
  const application = await startProductionApiApplication(config, { factories: factories({
    database,
    monitor,
    events,
    closeHttpError: new Error("raw close HTTP"),
  }) });
  const summary = await application.stop();
  assert.deepEqual(events, ["http.listen", "monitor.stop", "http.close", "database.close"]);
  assert.deepEqual(summary.cleanupErrorCodes, [
    "READINESS_MONITOR_STOP_FAILED",
    "HTTP_SERVER_CLOSE_FAILED",
    "DATABASE_CLOSE_FAILED",
  ]);
  assert.equal(JSON.stringify(summary).includes("raw"), false);
});

test("HTTP drain forces remaining connections only after the configured grace expires", async () => {
  let resolveClose!: () => void;
  const closePromise = new Promise<void>((resolve) => { resolveClose = resolve; });
  let forced = 0;
  const app = {
    close: () => closePromise,
    server: {
      closeAllConnections: () => {
        forced += 1;
        resolveClose();
      },
    },
  } as unknown as FastifyInstance;
  assert.equal(await closeFastifyWithGrace(app, 5), true);
  assert.equal(forced, 1);
});
