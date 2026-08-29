import assert from "node:assert/strict";
import test from "node:test";

import type {
  RuntimeRepeatingTaskHandle,
  RuntimeRepeatingTaskScheduler,
} from "../src/account-runner/contracts.ts";
import {
  ProductionEngineApplicationStartError,
  startProductionEngineApplication,
  type ProductionEngineApplicationEvent,
} from "../src/production/application.ts";
import { ProductionEngineConfig } from "../src/production/config.ts";
import type {
  ProductionEngineCoreHandle,
  ProductionEngineCoreSnapshot,
  ProductionEngineCoreSummary,
} from "../src/production/core.ts";
import type {
  ProductionHealthServer,
  ProductionReadinessView,
} from "../src/production/health-server.ts";
import { productionEnvironment, supervisorSnapshot, supervisorSummary } from "../test-support/production-fixtures.ts";

const instanceId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

class ManualScheduler implements RuntimeRepeatingTaskScheduler {
  task: (() => Promise<"CONTINUE" | "STOP">) | null = null;
  events: string[];
  startError: unknown = null;
  stopError: unknown = null;
  startCalls = 0;
  stopCalls = 0;

  constructor(events: string[] = []) { this.events = events; }
  start(_interval: number, task: () => Promise<"CONTINUE" | "STOP">): RuntimeRepeatingTaskHandle {
    this.startCalls += 1;
    if (this.startError) throw this.startError;
    this.task = task;
    return Object.freeze({
      stop: async () => {
        this.stopCalls += 1;
        this.events.push("monitor.stop");
        if (this.stopError) throw this.stopError;
      },
    });
  }
  async tick() {
    if (!this.task) throw new Error("MONITOR_NOT_STARTED");
    return this.task();
  }
}

class FakeCore implements ProductionEngineCoreHandle {
  events: string[];
  probeResults: Array<Error | null> = [];
  stopError: unknown = null;
  cleanupErrorCodes: readonly string[] = [];
  probeCalls = 0;
  stopCalls = 0;
  state: ProductionEngineCoreSnapshot["state"] = "RUNNING";

  constructor(events: string[] = []) { this.events = events; }
  snapshot(): ProductionEngineCoreSnapshot {
    return Object.freeze({ state: this.state, instanceId, shard: { shardCount: 2, shardIndex: 1 }, supervisor: supervisorSnapshot() });
  }
  async probeDatabase() {
    this.probeCalls += 1;
    const result = this.probeResults.shift();
    if (result) throw result;
  }
  async stop(): Promise<ProductionEngineCoreSummary> {
    this.stopCalls += 1;
    this.events.push("core.stop");
    if (this.stopError) throw this.stopError;
    this.state = "STOPPED";
    return Object.freeze({
      state: "STOPPED",
      instanceId,
      shard: Object.freeze({ shardCount: 2, shardIndex: 1 }),
      supervisor: supervisorSummary(),
      cleanupErrorCodes: Object.freeze([...this.cleanupErrorCodes]),
    });
  }
}

class FakeHealthServer implements ProductionHealthServer {
  readonly host = "127.0.0.1";
  readonly port = 8080;
  events: string[];
  closeError: unknown = null;
  closeCalls = 0;
  readiness: (() => ProductionReadinessView) | null = null;
  stateAtClose: ProductionReadinessView | null = null;

  constructor(events: string[] = []) { this.events = events; }
  async close() {
    this.closeCalls += 1;
    this.stateAtClose = this.readiness?.() ?? null;
    this.events.push("health.close");
    if (this.closeError) throw this.closeError;
  }
}

test("runtime DB failures cross the configured threshold then recover readiness", async () => {
  const config = ProductionEngineConfig.fromEnvironment({
    ...productionEnvironment(),
    ENGINE_READINESS_FAILURE_THRESHOLD: "2",
  });
  const events: string[] = [];
  const observed: ProductionEngineApplicationEvent[] = [];
  const core = new FakeCore(events);
  const health = new FakeHealthServer(events);
  const scheduler = new ManualScheduler(events);
  const application = await startProductionEngineApplication(config, {
    observer: (event) => { observed.push(event); },
    factories: {
      startCore: async () => core,
      startHealthServer: async (_policy, readiness) => {
        health.readiness = readiness;
        return health;
      },
      scheduler,
    },
  });

  assert.equal(application.readiness().ready, true);
  core.probeResults = [new Error("raw database detail"), new Error("raw database detail"), null];
  assert.equal(await scheduler.tick(), "CONTINUE");
  assert.equal(application.readiness().ready, true);
  assert.equal(application.snapshot().consecutiveDatabaseFailures, 1);
  assert.equal(await scheduler.tick(), "CONTINUE");
  assert.deepEqual(application.readiness(), {
    ready: false,
    state: "RUNNING",
    errorCode: "DATABASE_UNAVAILABLE",
    instanceId,
    shard: config.shard,
  });
  assert.equal(await scheduler.tick(), "CONTINUE");
  assert.equal(application.readiness().ready, true);
  assert.equal(application.snapshot().consecutiveDatabaseFailures, 0);
  assert.equal(observed.filter((event) => event.type === "ENGINE_DATABASE_PROBE_FAILED").length, 2);
  assert.equal(observed.filter((event) => event.type === "ENGINE_DATABASE_PROBE_RECOVERED").length, 1);
  assert.equal(JSON.stringify(observed).includes("raw database detail"), false);

  const firstStop = application.stop("SIGTERM");
  const secondStop = application.stop("MANUAL");
  assert.equal(firstStop, secondStop);
  assert.equal(application.readiness().errorCode, "ENGINE_STOPPING");
  const summary = await firstStop;
  assert.deepEqual(events, ["monitor.stop", "core.stop", "health.close"]);
  assert.equal(summary.reason, "SIGTERM");
  assert.equal(summary.state, "STOPPED");
  assert.deepEqual(summary.cleanupErrorCodes, []);
  assert.equal(health.stateAtClose?.errorCode, "ENGINE_STOPPING");
});

test("health or monitor startup failure rolls back core and reports cleanup only by code", async () => {
  const config = ProductionEngineConfig.fromEnvironment(productionEnvironment());

  const healthFailureCore = new FakeCore();
  await assert.rejects(
    startProductionEngineApplication(config, { factories: {
      startCore: async () => healthFailureCore,
      startHealthServer: async () => { throw new Error("raw bind detail"); },
    } }),
    (error: unknown) => {
      assert.ok(error instanceof ProductionEngineApplicationStartError);
      assert.equal(error.code, "HEALTH_SERVER_START_FAILED");
      assert.equal(JSON.stringify(error).includes("raw"), false);
      return true;
    },
  );
  assert.equal(healthFailureCore.stopCalls, 1);

  const monitorFailureCore = new FakeCore();
  monitorFailureCore.cleanupErrorCodes = ["DATABASE_CLOSE_FAILED"];
  const health = new FakeHealthServer();
  health.closeError = new Error("raw close detail");
  const scheduler = new ManualScheduler();
  scheduler.startError = new Error("raw scheduler detail");
  await assert.rejects(
    startProductionEngineApplication(config, { factories: {
      startCore: async () => monitorFailureCore,
      startHealthServer: async (_policy, readiness) => {
        health.readiness = readiness;
        return health;
      },
      scheduler,
    } }),
    (error: unknown) => {
      assert.ok(error instanceof ProductionEngineApplicationStartError);
      assert.equal(error.code, "READINESS_MONITOR_START_FAILED");
      assert.deepEqual(error.cleanupErrorCodes, ["CORE_STOP_INCOMPLETE", "HEALTH_SERVER_CLOSE_FAILED"]);
      return true;
    },
  );
  assert.equal(health.stateAtClose?.state, "FAILED");
  assert.equal(health.stateAtClose?.errorCode, "ENGINE_FAILED");
});

test("application stop continues across monitor, core, and health cleanup failures", async () => {
  const config = ProductionEngineConfig.fromEnvironment(productionEnvironment());
  const events: string[] = [];
  const core = new FakeCore(events);
  core.stopError = new Error("raw core detail");
  const health = new FakeHealthServer(events);
  health.closeError = new Error("raw health detail");
  const scheduler = new ManualScheduler(events);
  scheduler.stopError = new Error("raw monitor detail");
  const application = await startProductionEngineApplication(config, { factories: {
    startCore: async () => core,
    startHealthServer: async (_policy, readiness) => {
      health.readiness = readiness;
      return health;
    },
    scheduler,
  } });

  const summary = await application.stop();
  assert.deepEqual(events, ["monitor.stop", "core.stop", "health.close"]);
  assert.deepEqual(summary.cleanupErrorCodes, [
    "READINESS_MONITOR_STOP_FAILED",
    "CORE_STOP_FAILED",
    "HEALTH_SERVER_CLOSE_FAILED",
  ]);
  assert.equal(JSON.stringify(summary).includes("raw"), false);
});
