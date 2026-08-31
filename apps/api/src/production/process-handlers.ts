import type {
  ProductionApiApplicationHandle,
  ProductionApiApplicationSummary,
  ProductionApiStopReason,
} from "./application.ts";

export type ProductionApiProcessEvent =
  | Readonly<{ type: "API_PROCESS_DRAIN_STARTED"; reason: ProductionApiStopReason; fatal: boolean }>
  | Readonly<{ type: "API_PROCESS_DRAIN_COMPLETED"; reason: ProductionApiStopReason; summary: ProductionApiApplicationSummary }>
  | Readonly<{ type: "API_PROCESS_DRAIN_FAILED"; reason: ProductionApiStopReason; errorCode: "API_DRAIN_FAILED" }>;

export type ProductionApiProcessObserver = (event: ProductionApiProcessEvent) => void | Promise<void>;

export interface ApiProcessLifecycleTarget {
  exitCode?: string | number;
  on(event: "SIGTERM" | "SIGINT" | "uncaughtException" | "unhandledRejection", listener: (...args: unknown[]) => void): unknown;
  off(event: "SIGTERM" | "SIGINT" | "uncaughtException" | "unhandledRejection", listener: (...args: unknown[]) => void): unknown;
}

export interface ProductionApiProcessHandlerHandle {
  drain(reason: ProductionApiStopReason, fatal?: boolean): Promise<ProductionApiApplicationSummary | null>;
  dispose(): void;
}

export function installProductionApiProcessHandlers(
  application: ProductionApiApplicationHandle,
  input: Readonly<{
    target?: ApiProcessLifecycleTarget;
    observer?: ProductionApiProcessObserver;
  }> = {},
): ProductionApiProcessHandlerHandle {
  const target = input.target ?? process;
  let disposed = false;
  let drainPromise: Promise<ProductionApiApplicationSummary | null> | null = null;

  const emit = (event: ProductionApiProcessEvent): void => {
    if (!input.observer) return;
    try {
      const observed = input.observer(Object.freeze(event));
      if (observed && typeof observed.then === "function") void observed.catch(() => undefined);
    } catch { /* process observability is best effort */ }
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    target.off("SIGTERM", onSigterm);
    target.off("SIGINT", onSigint);
    target.off("uncaughtException", onUncaughtException);
    target.off("unhandledRejection", onUnhandledRejection);
  };

  const drain = (reason: ProductionApiStopReason, fatal = false): Promise<ProductionApiApplicationSummary | null> => {
    if (fatal) target.exitCode = 1;
    if (drainPromise) return drainPromise;
    emit({ type: "API_PROCESS_DRAIN_STARTED", reason, fatal });
    drainPromise = Promise.resolve().then(() => application.stop(reason)).then((summary) => {
      if (summary.cleanupErrorCodes.length > 0) target.exitCode = 1;
      emit({ type: "API_PROCESS_DRAIN_COMPLETED", reason, summary });
      dispose();
      return summary;
    }, () => {
      target.exitCode = 1;
      emit({ type: "API_PROCESS_DRAIN_FAILED", reason, errorCode: "API_DRAIN_FAILED" });
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
      catch { /* partial installation rollback is best effort */ }
    }
    disposed = true;
    throw new Error("API_PROCESS_HANDLER_INSTALL_FAILED");
  }

  return Object.freeze({ drain, dispose });
}
