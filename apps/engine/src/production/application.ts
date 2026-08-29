import { SerialRuntimeRepeatingTaskScheduler } from "../account-runner/serial-scheduler.ts";
import type { RuntimeRepeatingTaskHandle, RuntimeRepeatingTaskScheduler } from "../account-runner/contracts.ts";
import type { AccountSupervisorEvent } from "../account-supervisor/contracts.ts";
import type { ShardConfig } from "../runtime-sharding/shard.ts";
import type { ProductionEngineConfig } from "./config.ts";
import {
  startProductionEngineCore,
  type ProductionEngineCoreHandle,
  type ProductionEngineCoreSnapshot,
  type ProductionEngineCoreSummary,
} from "./core.ts";
import {
  startNodeProductionHealthServer,
  type ProductionHealthServer,
  type ProductionHealthServerStarter,
  type ProductionReadinessErrorCode,
  type ProductionReadinessView,
} from "./health-server.ts";

export type ProductionEngineStopReason =
  | "MANUAL"
  | "SIGTERM"
  | "SIGINT"
  | "UNCAUGHT_EXCEPTION"
  | "UNHANDLED_REJECTION";

export type ProductionEngineApplicationState = "STARTING" | "RUNNING" | "FAILED" | "STOPPING" | "STOPPED";

export type ProductionEngineApplicationSnapshot = Readonly<{
  state: ProductionEngineApplicationState;
  ready: boolean;
  readinessErrorCode: ProductionReadinessErrorCode | null;
  consecutiveDatabaseFailures: number;
  observerFailures: number;
  instanceId: string | null;
  shard: ShardConfig;
  core: ProductionEngineCoreSnapshot | null;
}>;

export type ProductionEngineApplicationSummary = Readonly<{
  state: "STOPPED";
  reason: ProductionEngineStopReason;
  instanceId: string | null;
  shard: ShardConfig;
  core: ProductionEngineCoreSummary | null;
  cleanupErrorCodes: readonly string[];
}>;

export type ProductionEngineApplicationEvent =
  | Readonly<{ type: "SUPERVISOR_EVENT"; event: AccountSupervisorEvent }>
  | Readonly<{ type: "ENGINE_APPLICATION_STARTED"; snapshot: ProductionEngineApplicationSnapshot; healthPort: number }>
  | Readonly<{ type: "ENGINE_DATABASE_PROBE_FAILED"; errorCode: "DATABASE_UNAVAILABLE"; consecutiveDatabaseFailures: number }>
  | Readonly<{ type: "ENGINE_DATABASE_PROBE_RECOVERED" }>
  | Readonly<{ type: "ENGINE_READINESS_CHANGED"; ready: boolean; errorCode: ProductionReadinessErrorCode | null; consecutiveDatabaseFailures: number }>
  | Readonly<{ type: "ENGINE_APPLICATION_STOPPING"; reason: ProductionEngineStopReason }>
  | Readonly<{ type: "ENGINE_APPLICATION_STOPPED"; summary: ProductionEngineApplicationSummary }>;

export type ProductionEngineApplicationObserver = (event: ProductionEngineApplicationEvent) => void | Promise<void>;

export type ProductionEngineApplicationStartErrorCode = "HEALTH_SERVER_START_FAILED" | "READINESS_MONITOR_START_FAILED";

export class ProductionEngineApplicationStartError extends Error {
  readonly code: ProductionEngineApplicationStartErrorCode;
  readonly cleanupErrorCodes: readonly string[];

  constructor(code: ProductionEngineApplicationStartErrorCode, cleanupErrorCodes: readonly string[]) {
    super(code);
    this.name = "ProductionEngineApplicationStartError";
    this.code = code;
    this.cleanupErrorCodes = Object.freeze([...cleanupErrorCodes]);
  }

  publicData(): Readonly<{ code: ProductionEngineApplicationStartErrorCode; cleanupErrorCodes: readonly string[] }> {
    return Object.freeze({ code: this.code, cleanupErrorCodes: this.cleanupErrorCodes });
  }

  toJSON(): ReturnType<ProductionEngineApplicationStartError["publicData"]> { return this.publicData(); }
}

export interface ProductionEngineApplicationHandle {
  snapshot(): ProductionEngineApplicationSnapshot;
  readiness(): ProductionReadinessView;
  stop(reason?: ProductionEngineStopReason): Promise<ProductionEngineApplicationSummary>;
}

export type ProductionEngineApplicationFactories = Readonly<{
  startCore(
    config: ProductionEngineConfig,
    input: Readonly<{ observer: (event: AccountSupervisorEvent) => void }>,
  ): Promise<ProductionEngineCoreHandle>;
  startHealthServer: ProductionHealthServerStarter;
  scheduler: RuntimeRepeatingTaskScheduler;
}>;

const defaultFactories: ProductionEngineApplicationFactories = Object.freeze({
  startCore: startProductionEngineCore,
  startHealthServer: startNodeProductionHealthServer,
  scheduler: new SerialRuntimeRepeatingTaskScheduler(),
});

function coreIncomplete(summary: ProductionEngineCoreSummary): boolean {
  return summary.cleanupErrorCodes.length > 0 || Boolean(summary.supervisor?.cleanupErrorCodes.length);
}

async function rollbackCore(core: ProductionEngineCoreHandle): Promise<readonly string[]> {
  try {
    const summary = await core.stop();
    return coreIncomplete(summary) ? Object.freeze(["CORE_STOP_INCOMPLETE"]) : Object.freeze([]);
  } catch {
    return Object.freeze(["CORE_STOP_FAILED"]);
  }
}

export async function startProductionEngineApplication(
  config: ProductionEngineConfig,
  input: Readonly<{
    observer?: ProductionEngineApplicationObserver;
    factories?: Partial<ProductionEngineApplicationFactories>;
  }> = {},
): Promise<ProductionEngineApplicationHandle> {
  const factories = Object.freeze({ ...defaultFactories, ...input.factories });
  let state: ProductionEngineApplicationState = "STARTING";
  let ready = false;
  let readinessErrorCode: ProductionReadinessErrorCode | null = "ENGINE_STARTING";
  let consecutiveDatabaseFailures = 0;
  let observerFailures = 0;
  let core: ProductionEngineCoreHandle | null = null;
  let healthServer: ProductionHealthServer | null = null;
  let monitor: RuntimeRepeatingTaskHandle | null = null;
  let stopPromise: Promise<ProductionEngineApplicationSummary> | null = null;

  const emit = (event: ProductionEngineApplicationEvent): void => {
    if (!input.observer) return;
    try {
      const observed = input.observer(Object.freeze(event));
      if (observed && typeof observed.then === "function") void observed.catch(() => { observerFailures += 1; });
    } catch {
      observerFailures += 1;
    }
  };

  const snapshot = (): ProductionEngineApplicationSnapshot => Object.freeze({
    state,
    ready,
    readinessErrorCode,
    consecutiveDatabaseFailures,
    observerFailures,
    instanceId: core?.snapshot().instanceId ?? null,
    shard: config.shard,
    core: core?.snapshot() ?? null,
  });

  const readiness = (): ProductionReadinessView => Object.freeze({
    ready,
    state,
    errorCode: readinessErrorCode,
    instanceId: core?.snapshot().instanceId ?? null,
    shard: config.shard,
  });

  const changeReadiness = (nextReady: boolean, errorCode: ProductionReadinessErrorCode | null): void => {
    if (ready === nextReady && readinessErrorCode === errorCode) return;
    ready = nextReady;
    readinessErrorCode = errorCode;
    emit({
      type: "ENGINE_READINESS_CHANGED",
      ready,
      errorCode: readinessErrorCode,
      consecutiveDatabaseFailures,
    });
  };

  core = await factories.startCore(config, {
    observer: (event) => emit({ type: "SUPERVISOR_EVENT", event }),
  });

  try { healthServer = await factories.startHealthServer(config.healthPolicy, readiness); }
  catch {
    const cleanup = await rollbackCore(core);
    throw new ProductionEngineApplicationStartError("HEALTH_SERVER_START_FAILED", cleanup);
  }

  try {
    monitor = factories.scheduler.start(config.healthPolicy.readinessProbeIntervalMilliseconds, async () => {
      if (state !== "RUNNING") return "STOP";
      try {
        await core!.probeDatabase();
        if (state !== "RUNNING") return "STOP";
        const recovered = consecutiveDatabaseFailures > 0;
        consecutiveDatabaseFailures = 0;
        if (recovered) emit({ type: "ENGINE_DATABASE_PROBE_RECOVERED" });
        changeReadiness(true, null);
      } catch {
        if (state !== "RUNNING") return "STOP";
        consecutiveDatabaseFailures += 1;
        emit({
          type: "ENGINE_DATABASE_PROBE_FAILED",
          errorCode: "DATABASE_UNAVAILABLE",
          consecutiveDatabaseFailures,
        });
        if (consecutiveDatabaseFailures >= config.healthPolicy.readinessFailureThreshold) {
          changeReadiness(false, "DATABASE_UNAVAILABLE");
        }
      }
      return "CONTINUE";
    });
  } catch {
    state = "FAILED";
    ready = false;
    readinessErrorCode = "ENGINE_FAILED";
    const cleanupErrorCodes = [...await rollbackCore(core)];
    try { await healthServer.close(); }
    catch { cleanupErrorCodes.push("HEALTH_SERVER_CLOSE_FAILED"); }
    throw new ProductionEngineApplicationStartError("READINESS_MONITOR_START_FAILED", cleanupErrorCodes);
  }

  state = "RUNNING";
  changeReadiness(true, null);
  emit({ type: "ENGINE_APPLICATION_STARTED", snapshot: snapshot(), healthPort: healthServer.port });

  const stop = (reason: ProductionEngineStopReason = "MANUAL"): Promise<ProductionEngineApplicationSummary> => {
    if (stopPromise) return stopPromise;
    state = "STOPPING";
    changeReadiness(false, "ENGINE_STOPPING");
    emit({ type: "ENGINE_APPLICATION_STOPPING", reason });
    stopPromise = (async () => {
      const cleanupErrorCodes: string[] = [];
      if (monitor) {
        try { await monitor.stop(); }
        catch { cleanupErrorCodes.push("READINESS_MONITOR_STOP_FAILED"); }
      }
      let coreSummary: ProductionEngineCoreSummary | null = null;
      try {
        coreSummary = await core!.stop();
        if (coreIncomplete(coreSummary)) cleanupErrorCodes.push("CORE_STOP_INCOMPLETE");
      } catch {
        cleanupErrorCodes.push("CORE_STOP_FAILED");
      }
      try { await healthServer!.close(); }
      catch { cleanupErrorCodes.push("HEALTH_SERVER_CLOSE_FAILED"); }
      state = "STOPPED";
      ready = false;
      readinessErrorCode = "ENGINE_STOPPED";
      const summary = Object.freeze({
        state,
        reason,
        instanceId: coreSummary?.instanceId ?? core?.snapshot().instanceId ?? null,
        shard: config.shard,
        core: coreSummary,
        cleanupErrorCodes: Object.freeze(cleanupErrorCodes),
      });
      emit({ type: "ENGINE_APPLICATION_STOPPED", summary });
      return summary;
    })();
    return stopPromise;
  };

  return Object.freeze({ snapshot, readiness, stop });
}
