import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type {
  ProductionApiApplicationHandle,
  ProductionApiApplicationSummary,
  ProductionApiStopReason,
} from "../src/production/application.ts";
import {
  installProductionApiProcessHandlers,
  type ApiProcessLifecycleTarget,
  type ProductionApiProcessEvent,
} from "../src/production/process-handlers.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function summary(reason: ProductionApiStopReason, cleanupErrorCodes: readonly string[] = []): ProductionApiApplicationSummary {
  return Object.freeze({
    state: "STOPPED",
    reason,
    forcedHttpClose: false,
    cleanupErrorCodes: Object.freeze([...cleanupErrorCodes]),
  });
}

class FakeProcess extends EventEmitter implements ApiProcessLifecycleTarget {
  exitCode?: number;
  override on(event: string, listener: (...args: unknown[]) => void): this { return super.on(event, listener); }
  override off(event: string, listener: (...args: unknown[]) => void): this { return super.off(event, listener); }
}

class FakeApplication implements ProductionApiApplicationHandle {
  stopCalls: ProductionApiStopReason[] = [];
  result = deferred<ProductionApiApplicationSummary>();
  snapshot() { return Object.freeze({ state: "RUNNING" as const, ready: true, readinessErrorCode: null, consecutiveDatabaseFailures: 0, observerFailures: 0 }); }
  readiness() { return Object.freeze({ ready: true, state: "RUNNING" as const, errorCode: null }); }
  stop(reason: ProductionApiStopReason = "MANUAL") {
    this.stopCalls.push(reason);
    return this.result.promise;
  }
}

test("repeated signals drain once and fatal failures set a nonzero exit without raw errors", async () => {
  const target = new FakeProcess();
  const application = new FakeApplication();
  const events: ProductionApiProcessEvent[] = [];
  const handlers = installProductionApiProcessHandlers(application, {
    target,
    observer: (event) => { events.push(event); },
  });
  target.emit("SIGTERM");
  target.emit("SIGINT");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(application.stopCalls, ["SIGTERM"]);
  const existing = handlers.drain("MANUAL");
  application.result.resolve(summary("SIGTERM"));
  assert.equal((await existing)?.reason, "SIGTERM");
  assert.equal(events.filter((event) => event.type === "API_PROCESS_DRAIN_STARTED").length, 1);
  assert.equal(target.listenerCount("SIGTERM"), 0);

  const fatalTarget = new FakeProcess();
  const fatalApplication = new FakeApplication();
  const fatalEvents: ProductionApiProcessEvent[] = [];
  const fatalHandlers = installProductionApiProcessHandlers(fatalApplication, {
    target: fatalTarget,
    observer: (event) => { fatalEvents.push(event); },
  });
  fatalTarget.emit("uncaughtException", new Error("raw fatal secret"));
  await new Promise((resolve) => setImmediate(resolve));
  fatalApplication.result.reject(new Error("raw drain secret"));
  assert.equal(await fatalHandlers.drain("MANUAL"), null);
  assert.equal(fatalTarget.exitCode, 1);
  assert.equal(JSON.stringify(fatalEvents).includes("raw"), false);
  assert.ok(fatalEvents.some((event) => event.type === "API_PROCESS_DRAIN_FAILED"));
});
