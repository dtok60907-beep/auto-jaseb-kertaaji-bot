import type { FastifyInstance } from "fastify";

import { composeProductionApi } from "./composition.ts";
import type { ProductionApiConfig } from "./config.ts";
import { openProductionApiDatabase, type ProductionApiDatabase } from "./database.ts";
import {
  registerProductionApiHealthRoutes,
  type ProductionApiReadinessErrorCode,
  type ProductionApiReadinessView,
  type ProductionApiState,
} from "./health-routes.ts";

export type ProductionApiStopReason =
  | "MANUAL"
  | "SIGTERM"
  | "SIGINT"
  | "UNCAUGHT_EXCEPTION"
  | "UNHANDLED_REJECTION";

export type ProductionApiApplicationSnapshot = Readonly<{
  state: ProductionApiState;
  ready: boolean;
  readinessErrorCode: ProductionApiReadinessErrorCode | null;
  consecutiveDatabaseFailures: number;
  observerFailures: number;
}>;

export type ProductionApiApplicationSummary = Readonly<{
  state: "STOPPED";
  reason: ProductionApiStopReason;
  forcedHttpClose: boolean;
  cleanupErrorCodes: readonly string[];
}>;

export type ProductionApiApplicationEvent =
  | Readonly<{ type: "API_APPLICATION_STARTED"; host: string; port: number }>
  | Readonly<{ type: "API_DATABASE_PROBE_FAILED"; errorCode: "DATABASE_UNAVAILABLE"; consecutiveDatabaseFailures: number }>
  | Readonly<{ type: "API_DATABASE_PROBE_RECOVERED" }>
  | Readonly<{ type: "API_READINESS_CHANGED"; ready: boolean; errorCode: ProductionApiReadinessErrorCode | null; consecutiveDatabaseFailures: number }>
  | Readonly<{ type: "API_APPLICATION_STOPPING"; reason: ProductionApiStopReason }>
  | Readonly<{ type: "API_APPLICATION_STOPPED"; summary: ProductionApiApplicationSummary }>;

export type ProductionApiApplicationObserver = (event: ProductionApiApplicationEvent) => void | Promise<void>;

export type ProductionApiApplicationStartErrorCode =
  | "DATABASE_OPEN_FAILED"
  | "DATABASE_STARTUP_PROBE_FAILED"
  | "API_COMPOSITION_FAILED"
  | "API_LISTEN_FAILED"
  | "READINESS_MONITOR_START_FAILED";

export class ProductionApiApplicationStartError extends Error {
  readonly code: ProductionApiApplicationStartErrorCode;
  readonly cleanupErrorCodes: readonly string[];

  constructor(code: ProductionApiApplicationStartErrorCode, cleanupErrorCodes: readonly string[] = []) {
    super(code);
    this.name = "ProductionApiApplicationStartError";
    this.code = code;
    this.cleanupErrorCodes = Object.freeze([...cleanupErrorCodes]);
  }

  publicData(): Readonly<{ code: ProductionApiApplicationStartErrorCode; cleanupErrorCodes: readonly string[] }> {
    return Object.freeze({ code: this.code, cleanupErrorCodes: this.cleanupErrorCodes });
  }

  toJSON(): ReturnType<ProductionApiApplicationStartError["publicData"]> { return this.publicData(); }
}

export interface ProductionApiReadinessMonitor {
  stop(): Promise<void>;
}

export type ProductionApiReadinessMonitorStarter = (
  intervalMilliseconds: number,
  task: () => Promise<"CONTINUE" | "STOP">,
) => ProductionApiReadinessMonitor;

export interface ProductionApiApplicationHandle {
  snapshot(): ProductionApiApplicationSnapshot;
  readiness(): ProductionApiReadinessView;
  stop(reason?: ProductionApiStopReason): Promise<ProductionApiApplicationSummary>;
}

export type ProductionApiApplicationFactories = Readonly<{
  openDatabase(config: ProductionApiConfig): Promise<ProductionApiDatabase>;
  composeApi(config: ProductionApiConfig, database: ProductionApiDatabase): FastifyInstance;
  listenApi(app: FastifyInstance, input: Readonly<{ host: string; port: number }>): Promise<void>;
  closeApi(app: FastifyInstance, graceMilliseconds: number): Promise<boolean>;
  startReadinessMonitor: ProductionApiReadinessMonitorStarter;
}>;

function startSerialReadinessMonitor(
  intervalMilliseconds: number,
  task: () => Promise<"CONTINUE" | "STOP">,
): ProductionApiReadinessMonitor {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> = Promise.resolve();
  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      running = (async () => {
        let decision: "CONTINUE" | "STOP" = "STOP";
        try { decision = await task(); }
        catch { decision = "STOP"; }
        if (decision === "STOP") stopped = true;
        else schedule();
      })();
    }, intervalMilliseconds);
    timer.unref?.();
  };
  schedule();
  return Object.freeze({
    async stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      await running;
    },
  });
}

export async function closeFastifyWithGrace(app: FastifyInstance, graceMilliseconds: number): Promise<boolean> {
  let forced = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const closing = app.close();
  timer = setTimeout(() => {
    forced = true;
    app.server.closeAllConnections();
  }, graceMilliseconds);
  timer.unref?.();
  try { await closing; }
  finally { if (timer !== null) clearTimeout(timer); }
  return forced;
}

const defaultFactories: ProductionApiApplicationFactories = Object.freeze({
  openDatabase: openProductionApiDatabase,
  composeApi: (config, database) => composeProductionApi(config, database.client()),
  listenApi: async (app, input) => { await app.listen(input); },
  closeApi: closeFastifyWithGrace,
  startReadinessMonitor: startSerialReadinessMonitor,
});

async function closeDatabase(database: ProductionApiDatabase): Promise<readonly string[]> {
  try { await database.close(); return Object.freeze([]); }
  catch { return Object.freeze(["DATABASE_CLOSE_FAILED"]); }
}

async function closeHttp(app: FastifyInstance): Promise<readonly string[]> {
  try { await app.close(); return Object.freeze([]); }
  catch { return Object.freeze(["HTTP_SERVER_CLOSE_FAILED"]); }
}

export async function startProductionApiApplication(
  config: ProductionApiConfig,
  input: Readonly<{
    observer?: ProductionApiApplicationObserver;
    factories?: Partial<ProductionApiApplicationFactories>;
  }> = {},
): Promise<ProductionApiApplicationHandle> {
  const factories = Object.freeze({ ...defaultFactories, ...input.factories });
  let state: ProductionApiState = "STARTING";
  let ready = false;
  let readinessErrorCode: ProductionApiReadinessErrorCode | null = "API_STARTING";
  let consecutiveDatabaseFailures = 0;
  let observerFailures = 0;
  let database: ProductionApiDatabase;
  let app: FastifyInstance;
  let monitor: ProductionApiReadinessMonitor;
  let stopPromise: Promise<ProductionApiApplicationSummary> | null = null;

  const emit = (event: ProductionApiApplicationEvent): void => {
    if (!input.observer) return;
    try {
      const observed = input.observer(Object.freeze(event));
      if (observed && typeof observed.then === "function") void observed.catch(() => { observerFailures += 1; });
    } catch { observerFailures += 1; }
  };

  const snapshot = (): ProductionApiApplicationSnapshot => Object.freeze({
    state,
    ready,
    readinessErrorCode,
    consecutiveDatabaseFailures,
    observerFailures,
  });
  const readiness = (): ProductionApiReadinessView => Object.freeze({ ready, state, errorCode: readinessErrorCode });
  const changeReadiness = (nextReady: boolean, errorCode: ProductionApiReadinessErrorCode | null): void => {
    if (ready === nextReady && readinessErrorCode === errorCode) return;
    ready = nextReady;
    readinessErrorCode = errorCode;
    emit({ type: "API_READINESS_CHANGED", ready, errorCode, consecutiveDatabaseFailures });
  };

  try { database = await factories.openDatabase(config); }
  catch { throw new ProductionApiApplicationStartError("DATABASE_OPEN_FAILED"); }

  try { await database.probe(); }
  catch {
    throw new ProductionApiApplicationStartError("DATABASE_STARTUP_PROBE_FAILED", await closeDatabase(database));
  }

  try {
    app = factories.composeApi(config, database);
    registerProductionApiHealthRoutes(app, readiness);
  } catch {
    throw new ProductionApiApplicationStartError("API_COMPOSITION_FAILED", await closeDatabase(database));
  }

  try { await factories.listenApi(app, { host: config.serverPolicy.host, port: config.serverPolicy.port }); }
  catch {
    const cleanup = [...await closeHttp(app), ...await closeDatabase(database)];
    throw new ProductionApiApplicationStartError("API_LISTEN_FAILED", cleanup);
  }

  try {
    monitor = factories.startReadinessMonitor(config.serverPolicy.readinessProbeIntervalMilliseconds, async () => {
      if (state !== "RUNNING") return "STOP";
      try {
        await database.probe();
        if (state !== "RUNNING") return "STOP";
        const recovered = consecutiveDatabaseFailures > 0;
        consecutiveDatabaseFailures = 0;
        if (recovered) emit({ type: "API_DATABASE_PROBE_RECOVERED" });
        changeReadiness(true, null);
      } catch {
        if (state !== "RUNNING") return "STOP";
        consecutiveDatabaseFailures += 1;
        emit({ type: "API_DATABASE_PROBE_FAILED", errorCode: "DATABASE_UNAVAILABLE", consecutiveDatabaseFailures });
        if (consecutiveDatabaseFailures >= config.serverPolicy.readinessFailureThreshold) {
          changeReadiness(false, "DATABASE_UNAVAILABLE");
        }
      }
      return "CONTINUE";
    });
  } catch {
    state = "STOPPING";
    changeReadiness(false, "API_STOPPING");
    const cleanup = [...await closeHttp(app), ...await closeDatabase(database)];
    state = "STOPPED";
    ready = false;
    readinessErrorCode = "API_STOPPED";
    throw new ProductionApiApplicationStartError("READINESS_MONITOR_START_FAILED", cleanup);
  }

  state = "RUNNING";
  changeReadiness(true, null);
  emit({ type: "API_APPLICATION_STARTED", host: config.serverPolicy.host, port: config.serverPolicy.port });

  const stop = (reason: ProductionApiStopReason = "MANUAL"): Promise<ProductionApiApplicationSummary> => {
    if (stopPromise) return stopPromise;
    state = "STOPPING";
    changeReadiness(false, "API_STOPPING");
    emit({ type: "API_APPLICATION_STOPPING", reason });
    stopPromise = (async () => {
      const cleanupErrorCodes: string[] = [];
      try { await monitor.stop(); }
      catch { cleanupErrorCodes.push("READINESS_MONITOR_STOP_FAILED"); }
      let forcedHttpClose = false;
      try { forcedHttpClose = await factories.closeApi(app, config.serverPolicy.shutdownGraceMilliseconds); }
      catch { cleanupErrorCodes.push("HTTP_SERVER_CLOSE_FAILED"); }
      try { await database.close(); }
      catch { cleanupErrorCodes.push("DATABASE_CLOSE_FAILED"); }
      state = "STOPPED";
      ready = false;
      readinessErrorCode = "API_STOPPED";
      const summary: ProductionApiApplicationSummary = Object.freeze({
        state: "STOPPED",
        reason,
        forcedHttpClose,
        cleanupErrorCodes: Object.freeze(cleanupErrorCodes),
      });
      emit({ type: "API_APPLICATION_STOPPED", summary });
      return summary;
    })();
    return stopPromise;
  };

  return Object.freeze({ snapshot, readiness, stop });
}
