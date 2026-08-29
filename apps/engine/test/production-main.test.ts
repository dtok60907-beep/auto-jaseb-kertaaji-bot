import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type {
  ProductionEngineApplicationHandle,
  ProductionEngineApplicationObserver,
  ProductionEngineApplicationSummary,
  ProductionEngineStopReason,
} from "../src/production/application.ts";
import { ProductionEngineConfig } from "../src/production/config.ts";
import {
  startProductionEngineProcess,
  type ProductionEngineProcessTarget,
  type ProductionEngineRuntimeLogRecord,
} from "../src/production/main.ts";
import type { ProductionProcessHandlerHandle } from "../src/production/process-handlers.ts";
import { productionEnvironment } from "../test-support/production-fixtures.ts";

class FakeProcess extends EventEmitter implements ProductionEngineProcessTarget {
  exitCode?: number;
  override on(event: string, listener: (...args: unknown[]) => void): this { return super.on(event, listener); }
  override off(event: string, listener: (...args: unknown[]) => void): this { return super.off(event, listener); }
}

function application(stopCalls: ProductionEngineStopReason[]): ProductionEngineApplicationHandle {
  const shard = Object.freeze({ shardCount: 2, shardIndex: 1 });
  return Object.freeze({
    snapshot: () => Object.freeze({
      state: "RUNNING" as const,
      ready: true,
      readinessErrorCode: null,
      consecutiveDatabaseFailures: 0,
      observerFailures: 0,
      instanceId: null,
      shard,
      core: null,
    }),
    readiness: () => Object.freeze({
      ready: true,
      state: "RUNNING" as const,
      errorCode: null,
      instanceId: null,
      shard,
    }),
    stop: async (reason: ProductionEngineStopReason = "MANUAL"): Promise<ProductionEngineApplicationSummary> => {
      stopCalls.push(reason);
      return Object.freeze({
        state: "STOPPED",
        reason,
        instanceId: null,
        shard,
        core: null,
        cleanupErrorCodes: Object.freeze([]),
      });
    },
  });
}

test("entrypoint rejects invalid environment without logging raw values or opening the application", async () => {
  const target = new FakeProcess();
  const records: ProductionEngineRuntimeLogRecord[] = [];
  let applicationStarts = 0;
  const env = { ...productionEnvironment(), DATABASE_URL: "postgresql://engine:raw-secret@localhost" };
  const handle = await startProductionEngineProcess({
    env,
    target,
    log: (record) => { records.push(record); },
    factories: {
      startApplication: async () => {
        applicationStarts += 1;
        return application([]);
      },
    },
  });

  assert.equal(handle, null);
  assert.equal(applicationStarts, 0);
  assert.equal(target.exitCode, 1);
  assert.deepEqual(records, [{
    level: "ERROR",
    type: "ENGINE_PROCESS_START_FAILED",
    failure: { code: "ENGINE_CONFIG_INVALID", field: "DATABASE_URL" },
  }]);
  assert.equal(JSON.stringify(records).includes("raw-secret"), false);
});

test("entrypoint rolls back a started application when process handler installation fails", async () => {
  const target = new FakeProcess();
  const records: ProductionEngineRuntimeLogRecord[] = [];
  const stopCalls: ProductionEngineStopReason[] = [];
  const handle = await startProductionEngineProcess({
    env: productionEnvironment(),
    target,
    log: (record) => { records.push(record); },
    factories: {
      startApplication: async () => application(stopCalls),
      installProcessHandlers: () => { throw new Error("raw handler failure"); },
    },
  });

  assert.equal(handle, null);
  assert.deepEqual(stopCalls, ["MANUAL"]);
  assert.equal(target.exitCode, 1);
  assert.equal(JSON.stringify(records).includes("raw handler failure"), false);
  assert.deepEqual(records.at(-1), {
    level: "ERROR",
    type: "ENGINE_PROCESS_START_FAILED",
    failure: { code: "ENGINE_PROCESS_START_FAILED" },
  });
});

test("entrypoint passes one parsed config to application and installs process handlers", async () => {
  const target = new FakeProcess();
  const fakeApplication = application([]);
  const fakeHandlers: ProductionProcessHandlerHandle = Object.freeze({
    drain: async () => null,
    dispose: () => undefined,
  });
  const parsed: ProductionEngineConfig[] = [];
  const applicationObservers: ProductionEngineApplicationObserver[] = [];
  const records: ProductionEngineRuntimeLogRecord[] = [];
  let installedApplication: ProductionEngineApplicationHandle | null = null;
  const handle = await startProductionEngineProcess({
    env: productionEnvironment(),
    target,
    log: (record) => { records.push(record); },
    factories: {
      startApplication: async (config, input) => {
        parsed.push(config);
        if (!input?.observer) throw new Error("APPLICATION_OBSERVER_MISSING");
        applicationObservers.push(input.observer);
        return fakeApplication;
      },
      installProcessHandlers: (startedApplication) => {
        installedApplication = startedApplication;
        return fakeHandlers;
      },
    },
  });

  assert.equal(parsed.length, 1);
  assert.ok(parsed[0] instanceof ProductionEngineConfig);
  assert.equal(installedApplication, fakeApplication);
  assert.equal(handle?.application, fakeApplication);
  assert.equal(handle?.processHandlers, fakeHandlers);
  assert.equal(target.exitCode, undefined);

  applicationObservers[0]!({
    type: "SUPERVISOR_EVENT",
    event: { type: "WAKEUP_ACCEPTED", accountId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
  });
  applicationObservers[0]!({
    type: "ENGINE_DATABASE_PROBE_FAILED",
    errorCode: "DATABASE_UNAVAILABLE",
    consecutiveDatabaseFailures: 1,
  });
  applicationObservers[0]!({
    type: "ENGINE_DATABASE_PROBE_FAILED",
    errorCode: "DATABASE_UNAVAILABLE",
    consecutiveDatabaseFailures: 2,
  });
  assert.equal(records.length, 1);
  assert.equal(records[0]?.type, "ENGINE_APPLICATION_EVENT");
});
