import type {
  ProductionEngineApplicationHandle,
  ProductionEngineApplicationSummary,
  ProductionEngineStopReason,
} from "./application.ts";

export type ProductionProcessEvent =
  | Readonly<{ type: "PROCESS_DRAIN_STARTED"; reason: ProductionEngineStopReason; fatal: boolean }>
  | Readonly<{ type: "PROCESS_DRAIN_COMPLETED"; reason: ProductionEngineStopReason; summary: ProductionEngineApplicationSummary }>
  | Readonly<{ type: "PROCESS_DRAIN_FAILED"; reason: ProductionEngineStopReason; errorCode: "ENGINE_DRAIN_FAILED" }>;

export type ProductionProcessObserver = (event: ProductionProcessEvent) => void | Promise<void>;

export interface ProcessLifecycleTarget {
  exitCode?: string | number;
  on(event: "SIGTERM" | "SIGINT" | "uncaughtException" | "unhandledRejection", listener: (...args: unknown[]) => void): unknown;
  off(event: "SIGTERM" | "SIGINT" | "uncaughtException" | "unhandledRejection", listener: (...args: unknown[]) => void): unknown;
}

export interface ProductionProcessHandlerHandle {
  drain(reason: ProductionEngineStopReason, fatal?: boolean): Promise<ProductionEngineApplicationSummary | null>;
  dispose(): void;
}

export function installProductionProcessHandlers(
  application: ProductionEngineApplicationHandle,
  input: Readonly<{
    target?: ProcessLifecycleTarget;
    observer?: ProductionProcessObserver;
  }> = {},
): ProductionProcessHandlerHandle {
  const target = input.target ?? process;
  let disposed = false;
  let drainPromise: Promise<ProductionEngineApplicationSummary | null> | null = null;

  const emit = (event: ProductionProcessEvent): void => {
    if (!input.observer) return;
    try {
      const observed = input.observer(Object.freeze(event));
      if (observed && typeof observed.then === "function") void observed.catch(() => undefined);
    } catch { /* best-effort process observability */ }
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    target.off("SIGTERM", onSigterm);
    target.off("SIGINT", onSigint);
    target.off("uncaughtException", onUncaughtException);
    target.off("unhandledRejection", onUnhandledRejection);
  };

  const drain = (reason: ProductionEngineStopReason, fatal = false): Promise<ProductionEngineApplicationSummary | null> => {
    if (fatal) target.exitCode = 1;
    if (drainPromise) return drainPromise;
    emit({ type: "PROCESS_DRAIN_STARTED", reason, fatal });
    drainPromise = Promise.resolve().then(() => application.stop(reason)).then((summary) => {
      if (summary.cleanupErrorCodes.length > 0) target.exitCode = 1;
      emit({ type: "PROCESS_DRAIN_COMPLETED", reason, summary });
      dispose();
      return summary;
    }, () => {
      target.exitCode = 1;
      emit({ type: "PROCESS_DRAIN_FAILED", reason, errorCode: "ENGINE_DRAIN_FAILED" });
      dispose();
      return null;
    });
    return drainPromise;
  };

  const onSigterm = () => { void drain("SIGTERM"); };
  const onSigint = () => { void drain("SIGINT"); };
  const onUncaughtException = () => { void drain("UNCAUGHT_EXCEPTION", true); };
  const onUnhandledRejection = () => { void drain("UNHANDLED_REJECTION", true); };

  const registrations = Object.freeze([
    ["SIGTERM", onSigterm],
    ["SIGINT", onSigint],
    ["uncaughtException", onUncaughtException],
    ["unhandledRejection", onUnhandledRejection],
  ] as const);
  const installed: Array<(typeof registrations)[number]> = [];
  try {
    for (const registration of registrations) {
      target.on(registration[0], registration[1]);
      installed.push(registration);
    }
  } catch {
    for (const registration of installed.reverse()) {
      try { target.off(registration[0], registration[1]); }
      catch { /* best-effort rollback for a partially installed target */ }
    }
    disposed = true;
    throw new Error("PROCESS_HANDLER_INSTALL_FAILED");
  }

  return Object.freeze({ drain, dispose });
}
