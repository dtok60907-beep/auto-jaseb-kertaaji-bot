import type { ProcessLifecycleTarget, ProductionProcessHandlerHandle } from "./process-handlers.ts";
import { installProductionProcessHandlers, type ProductionProcessEvent } from "./process-handlers.ts";
import { pathToFileURL } from "node:url";
import {
  ProductionEngineApplicationStartError,
  startProductionEngineApplication,
  type ProductionEngineApplicationEvent,
  type ProductionEngineApplicationHandle,
} from "./application.ts";
import { ProductionEngineConfig, ProductionEngineConfigError } from "./config.ts";
import { ProductionEngineStartError } from "./core.ts";

export type ProductionEngineRuntimeLogRecord = Readonly<
  | { level: "INFO"; type: "ENGINE_APPLICATION_EVENT"; event: ProductionEngineApplicationEvent }
  | { level: "INFO"; type: "ENGINE_PROCESS_EVENT"; event: ProductionProcessEvent }
  | { level: "ERROR"; type: "ENGINE_PROCESS_START_FAILED"; failure: Readonly<Record<string, unknown>> }
>;

export type ProductionEngineRuntimeLogSink = (record: ProductionEngineRuntimeLogRecord) => void;

export interface ProductionEngineProcessHandle {
  readonly application: ProductionEngineApplicationHandle;
  readonly processHandlers: ProductionProcessHandlerHandle;
}

export type ProductionEngineProcessTarget = ProcessLifecycleTarget;

type RuntimeFactories = Readonly<{
  parseConfig(env: Readonly<Record<string, string | undefined>>): ProductionEngineConfig;
  startApplication: typeof startProductionEngineApplication;
  installProcessHandlers: typeof installProductionProcessHandlers;
}>;

const defaultFactories: RuntimeFactories = Object.freeze({
  parseConfig: ProductionEngineConfig.fromEnvironment,
  startApplication: startProductionEngineApplication,
  installProcessHandlers: installProductionProcessHandlers,
});

function publicStartupFailure(error: unknown): Readonly<Record<string, unknown>> {
  if (
    error instanceof ProductionEngineConfigError
    || error instanceof ProductionEngineStartError
    || error instanceof ProductionEngineApplicationStartError
  ) return error.publicData();
  return Object.freeze({ code: "ENGINE_PROCESS_START_FAILED" });
}

function defaultLogSink(record: ProductionEngineRuntimeLogRecord): void {
  try {
    const output = `${JSON.stringify(record)}\n`;
    (record.level === "ERROR" ? process.stderr : process.stdout).write(output);
  } catch { /* logging must not change engine lifecycle */ }
}

function emit(sink: ProductionEngineRuntimeLogSink, record: ProductionEngineRuntimeLogRecord): void {
  try { sink(Object.freeze(record)); }
  catch { /* an observer is not an engine dependency */ }
}

function shouldLogApplicationEvent(event: ProductionEngineApplicationEvent): boolean {
  if (event.type === "ENGINE_DATABASE_PROBE_FAILED") {
    return event.consecutiveDatabaseFailures === 1;
  }
  if (event.type !== "SUPERVISOR_EVENT") return true;
  return event.event.type !== "WAKEUP_ACCEPTED"
    && event.event.type !== "ACCOUNT_RUN_STARTED"
    && event.event.type !== "ACCOUNT_RUN_FINISHED";
}

export async function startProductionEngineProcess(input: Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
  target?: ProductionEngineProcessTarget;
  log?: ProductionEngineRuntimeLogSink;
  factories?: Partial<RuntimeFactories>;
}> = {}): Promise<ProductionEngineProcessHandle | null> {
  const target = input.target ?? process;
  const log = input.log ?? defaultLogSink;
  const factories = Object.freeze({ ...defaultFactories, ...input.factories });
  let application: ProductionEngineApplicationHandle | null = null;

  try {
    const config = factories.parseConfig(input.env ?? process.env);
    application = await factories.startApplication(config, {
      observer: (event) => {
        if (shouldLogApplicationEvent(event)) {
          emit(log, { level: "INFO", type: "ENGINE_APPLICATION_EVENT", event });
        }
      },
    });
    const processHandlers = factories.installProcessHandlers(application, {
      target,
      observer: (event) => emit(log, { level: "INFO", type: "ENGINE_PROCESS_EVENT", event }),
    });
    return Object.freeze({ application, processHandlers });
  } catch (error) {
    const failure: Record<string, unknown> = { ...publicStartupFailure(error) };
    if (application) {
      try {
        const summary = await application.stop("MANUAL");
        if (summary.cleanupErrorCodes.length > 0) failure.cleanupErrorCodes = summary.cleanupErrorCodes;
      } catch {
        failure.cleanupErrorCodes = Object.freeze(["ENGINE_APPLICATION_ROLLBACK_FAILED"]);
      }
    }
    target.exitCode = 1;
    emit(log, {
      level: "ERROR",
      type: "ENGINE_PROCESS_START_FAILED",
      failure: Object.freeze(failure),
    });
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startProductionEngineProcess();
}
