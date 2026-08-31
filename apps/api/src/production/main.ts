import { pathToFileURL } from "node:url";

import {
  ProductionApiApplicationStartError,
  startProductionApiApplication,
  type ProductionApiApplicationEvent,
} from "./application.ts";
import { ProductionApiConfig, ProductionApiConfigError } from "./config.ts";
import {
  installProductionApiProcessHandlers,
  type ProductionApiProcessEvent,
} from "./process-handlers.ts";

type SafeStartupFailure = Readonly<{
  code: "API_START_FAILED" | "API_CONFIG_INVALID" | ProductionApiApplicationStartError["code"];
  field?: string;
  cleanupErrorCodes?: readonly string[];
}>;

function write(record: Readonly<Record<string, unknown>>, target: NodeJS.WritableStream = process.stdout): void {
  try { target.write(`${JSON.stringify(record)}\n`); }
  catch { /* logging cannot alter process lifecycle */ }
}

function startupFailure(error: unknown): SafeStartupFailure {
  if (error instanceof ProductionApiConfigError) return error.publicData();
  if (error instanceof ProductionApiApplicationStartError) return error.publicData();
  return Object.freeze({ code: "API_START_FAILED" });
}

export async function runProductionApiProcess(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  let application: Awaited<ReturnType<typeof startProductionApiApplication>> | null = null;
  try {
    const config = ProductionApiConfig.fromEnvironment(env);
    application = await startProductionApiApplication(config, {
      observer: (event: ProductionApiApplicationEvent) => write(event),
    });
    installProductionApiProcessHandlers(application, {
      observer: (event: ProductionApiProcessEvent) => write(event),
    });
  } catch (error) {
    if (application) {
      try { await application.stop("UNCAUGHT_EXCEPTION"); }
      catch { /* startup failure code remains authoritative */ }
    }
    process.exitCode = 1;
    write({ type: "API_APPLICATION_START_FAILED", failure: startupFailure(error) }, process.stderr);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runProductionApiProcess();
}
