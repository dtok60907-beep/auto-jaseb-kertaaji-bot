import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type {
  ProductionEngineApplicationHandle,
  ProductionEngineApplicationSummary,
  ProductionEngineStopReason,
} from "../src/production/application.ts";
import {
  installProductionProcessHandlers,
  type ProcessLifecycleTarget,
  type ProductionProcessEvent,
} from "../src/production/process-handlers.ts";
import { supervisorSnapshot } from "../test-support/production-fixtures.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function summary(reason: ProductionEngineStopReason, cleanupErrorCodes: readonly string[] = []): ProductionEngineApplicationSummary {
  return Object.freeze({
    state: "STOPPED",
    reason,
    instanceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    shard: Object.freeze({ shardCount: 1, shardIndex: 0 }),
    core: null,
    cleanupErrorCodes: Object.freeze([...cleanupErrorCodes]),
  });
}

class FakeProcess extends EventEmitter implements ProcessLifecycleTarget {
  exitCode?: number;
  override on(event: string, listener: (...args: unknown[]) => void): this { return super.on(event, listener); }
  override off(event: string, listener: (...args: unknown[]) => void): this { return super.off(event, listener); }
}

class FailingInstallProcess extends FakeProcess {
  installCalls = 0;
  override on(event: string, listener: (...args: unknown[]) => void): this {
    this.installCalls += 1;
    if (this.installCalls === 2) throw new Error("raw install failure");
    return super.on(event, listener);
  }
}

class FakeApplication implements ProductionEngineApplicationHandle {
  stopCalls: ProductionEngineStopReason[] = [];
  stopResult = deferred<ProductionEngineApplicationSummary>();
  snapshot() {
    return Object.freeze({
      state: "RUNNING" as const,
      ready: true,
      readinessErrorCode: null,
      consecutiveDatabaseFailures: 0,
      observerFailures: 0,
      instanceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      shard: Object.freeze({ shardCount: 1, shardIndex: 0 }),
      core: Object.freeze({
        state: "RUNNING" as const,
        instanceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        shard: Object.freeze({ shardCount: 1, shardIndex: 0 }),
        supervisor: supervisorSnapshot(),
      }),
    });
  }
  readiness() {
    return Object.freeze({
      ready: true,
      state: "RUNNING" as const,
      errorCode: null,
      instanceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      shard: Object.freeze({ shardCount: 1, shardIndex: 0 }),
    });
  }
  stop(reason: ProductionEngineStopReason = "MANUAL") {
    this.stopCalls.push(reason);
    return this.stopResult.promise;
  }
}

test("repeated process signals start one drain and dispose every handler after completion", async () => {
  const target = new FakeProcess();
  const application = new FakeApplication();
  const events: ProductionProcessEvent[] = [];
  const handlers = installProductionProcessHandlers(application, {
    target,
    observer: (event) => { events.push(event); },
  });

  target.emit("SIGTERM");
  target.emit("SIGINT");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(application.stopCalls, ["SIGTERM"]);
  const existingDrain = handlers.drain("MANUAL");
  application.stopResult.resolve(summary("SIGTERM"));
  assert.equal((await existingDrain)?.reason, "SIGTERM");
  assert.equal(target.exitCode, undefined);
  assert.equal(events.filter((event) => event.type === "PROCESS_DRAIN_STARTED").length, 1);
  assert.equal(events.filter((event) => event.type === "PROCESS_DRAIN_COMPLETED").length, 1);
  assert.equal(target.listenerCount("SIGTERM"), 0);
  assert.equal(target.listenerCount("SIGINT"), 0);
  assert.equal(target.listenerCount("uncaughtException"), 0);
  assert.equal(target.listenerCount("unhandledRejection"), 0);
});

test("fatal process event sets nonzero exit and never exposes its raw error", async () => {
  const target = new FakeProcess();
  const application = new FakeApplication();
  const events: ProductionProcessEvent[] = [];
  const handlers = installProductionProcessHandlers(application, {
    target,
    observer: (event) => { events.push(event); },
  });

  target.emit("uncaughtException", new Error("raw fatal secret detail"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(target.exitCode, 1);
  assert.deepEqual(application.stopCalls, ["UNCAUGHT_EXCEPTION"]);
  application.stopResult.reject(new Error("raw stop detail"));
  assert.equal(await handlers.drain("MANUAL"), null);
  assert.equal(target.exitCode, 1);
  assert.ok(events.some((event) => event.type === "PROCESS_DRAIN_FAILED" && event.errorCode === "ENGINE_DRAIN_FAILED"));
  assert.equal(JSON.stringify(events).includes("raw"), false);
});

test("partial process handler installation is rolled back", () => {
  const target = new FailingInstallProcess();
  const application = new FakeApplication();

  assert.throws(
    () => installProductionProcessHandlers(application, { target }),
    (error: unknown) => error instanceof Error && error.message === "PROCESS_HANDLER_INSTALL_FAILED",
  );
  assert.equal(target.listenerCount("SIGTERM"), 0);
  assert.equal(target.listenerCount("SIGINT"), 0);
  assert.equal(target.listenerCount("uncaughtException"), 0);
  assert.equal(target.listenerCount("unhandledRejection"), 0);
  assert.equal(application.stopCalls.length, 0);
});
