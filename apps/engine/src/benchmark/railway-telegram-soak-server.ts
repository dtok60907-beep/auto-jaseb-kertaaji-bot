import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";

import postgres from "postgres";

import { ProductionEngineConfigError } from "../production/config.ts";
import {
  parseSoakEnvironment,
  TelegramSoakEnvironmentError,
  type TelegramSoakEnvironment,
} from "./run-telegram-soak.ts";
import {
  orchestrateTelegramSoak,
  type TelegramSoakOrchestrationResult,
} from "./telegram-soak-orchestrator.ts";
import { createPostgresTelegramSoakProvisioningStore } from "./telegram-soak-provisioning-store.ts";
import { createPostgresTelegramSoakStore } from "./telegram-soak-store.ts";
import { TeleprotoSoakSessionVerifier } from "./teleproto-soak-session-verifier.ts";
import { TeleprotoSoakDeliveryObserver } from "./telegram-soak-delivery-observer.ts";
import type { SendLatencySummary, SoakFixtureCounts } from "./telegram-soak.ts";

export class RailwayTelegramSoakConfigError extends Error {
  readonly code = "F57C_RAILWAY_CONFIG_INVALID";
  readonly field: string;

  constructor(field: string) {
    super(`F57C_RAILWAY_CONFIG_INVALID:${field}`);
    this.name = "RailwayTelegramSoakConfigError";
    this.field = field;
  }

  publicData(): Readonly<{ code: "F57C_RAILWAY_CONFIG_INVALID"; field: string }> {
    return Object.freeze({ code: this.code, field: this.field });
  }
}

function fail(field: string): never { throw new RailwayTelegramSoakConfigError(field); }

const SOAK_FIELD_TO_ENV: Readonly<Record<string, string>> = Object.freeze({
  databaseUrl: "DATABASE_URL",
  commit: "F57C_COMMIT",
  runId: "F57C_RUN_ID",
  soakDurationMinutes: "F57C_SOAK_MINUTES",
  burstIntervalSeconds: "F57C_BURST_INTERVAL_SECONDS",
  sendIntervalSeconds: "F57C_SEND_INTERVAL_SECONDS",
  expectedAccounts: "F57C_EXPECTED_ACCOUNTS",
  approvedCommandCount: "F57C_APPROVED_COMMAND_COUNT",
  interruptAtMinutes: "F57C_INTERRUPT_AT_MINUTES",
  revokeAccountIndex: "F57C_REVOKE_ACCOUNT_INDEX",
  revokeAfterMinute: "F57C_REVOKE_AFTER_MINUTES",
  monitorIntervalMilliseconds: "F57C_MONITOR_INTERVAL_MS",
  healthTimeoutMilliseconds: "F57C_HEALTH_TIMEOUT_MS",
  databaseMaxConnections: "F57C_DB_MAX_CONNECTIONS",
  databaseConnectTimeoutSeconds: "F57C_DB_CONNECT_TIMEOUT_SECONDS",
});

export class RailwayTelegramSoakConfig {
  readonly port: number;
  readonly #environment: TelegramSoakEnvironment;
  readonly #sessions: readonly string[];

  constructor(input: Readonly<{ port: number; environment: TelegramSoakEnvironment; sessions: readonly string[] }>) {
    if (!Number.isSafeInteger(input.port) || input.port < 0 || input.port > 65_535) fail("PORT");
    if (input.sessions.length !== input.environment.soakConfig.expectedAccounts) fail("F57C_SESSIONS_JSON");
    this.port = input.port;
    this.#environment = input.environment;
    this.#sessions = Object.freeze([...input.sessions]);
    Object.freeze(this);
  }

  environment(): TelegramSoakEnvironment { return this.#environment; }
  sessions(): readonly string[] { return Object.freeze([...this.#sessions]); }
  toJSON(): Readonly<{ redacted: true; port: number; runId: string; expectedAccounts: number }> {
    return Object.freeze({
      redacted: true,
      port: this.port,
      runId: this.#environment.soakConfig.runId,
      expectedAccounts: this.#environment.soakConfig.expectedAccounts,
    });
  }
}

export function parseRailwayTelegramSoakEnvironment(env: Readonly<Record<string, string | undefined>>): RailwayTelegramSoakConfig {
  let environment: TelegramSoakEnvironment;
  try { environment = parseSoakEnvironment(env); }
  catch (error) {
    if (error instanceof TelegramSoakEnvironmentError) fail(SOAK_FIELD_TO_ENV[error.field] ?? error.field);
    if (error instanceof ProductionEngineConfigError) fail(error.field);
    throw error;
  }
  const portValue = env.PORT;
  if (typeof portValue !== "string" || !/^(0|[1-9][0-9]*)$/.test(portValue)) fail("PORT");
  const port = Number(portValue);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) fail("PORT");
  const serialized = env.F57C_SESSIONS_JSON;
  if (typeof serialized !== "string" || !serialized.trim() || Buffer.byteLength(serialized, "utf8") > 3_300_000) fail("F57C_SESSIONS_JSON");
  let parsed: unknown;
  try { parsed = JSON.parse(serialized); }
  catch { fail("F57C_SESSIONS_JSON"); }
  if (!Array.isArray(parsed) || parsed.some((session) => typeof session !== "string" || !session.trim() || session.length > 65_536)) {
    fail("F57C_SESSIONS_JSON");
  }
  return new RailwayTelegramSoakConfig({ port, environment, sessions: parsed as string[] });
}

export type RailwayTelegramSoakReport = Readonly<{
  passed: boolean;
  failureCode: string | null;
  provisionedAccounts: number;
  run: null | Readonly<{
    elapsedMilliseconds: number;
    commandsEnqueued: number;
    interruptsConfigured: number;
    interruptsFired: number;
    finalCounts: SoakFixtureCounts;
    sendLatency: SendLatencySummary;
    rssPeakBytes: number;
    eventLoopP99MaximumMilliseconds: number;
    cleanupSucceeded: boolean;
  }>;
  teardown: TelegramSoakOrchestrationResult["cleanup"];
  deliveryObservation: TelegramSoakOrchestrationResult["deliveryObservation"];
}>;

export function summarizeRailwayTelegramSoak(result: TelegramSoakOrchestrationResult): RailwayTelegramSoakReport {
  const summary = result.run?.summary;
  return Object.freeze({
    passed: result.passed,
    failureCode: result.failureCode,
    provisionedAccounts: result.provisionedAccounts,
    run: summary === undefined ? null : Object.freeze({
      elapsedMilliseconds: summary.elapsedMilliseconds,
      commandsEnqueued: summary.commandsEnqueued,
      interruptsConfigured: summary.interruptsConfigured,
      interruptsFired: summary.interruptsFired,
      finalCounts: summary.finalCounts,
      sendLatency: summary.sendLatency,
      rssPeakBytes: summary.rssPeakBytes,
      eventLoopP99MaximumMilliseconds: summary.eventLoopP99MaximumMilliseconds,
      cleanupSucceeded: summary.cleanupSucceeded,
    }),
    teardown: result.cleanup,
    deliveryObservation: result.deliveryObservation,
  });
}

type Execute = (config: RailwayTelegramSoakConfig, emit: (record: Readonly<Record<string, unknown>>) => void) => Promise<TelegramSoakOrchestrationResult>;
type Log = (record: Readonly<Record<string, unknown>>) => void;

export async function executeRailwayTelegramSoak(
  config: RailwayTelegramSoakConfig,
  emit: (record: Readonly<Record<string, unknown>>) => void,
): Promise<TelegramSoakOrchestrationResult> {
  const environment = config.environment();
  const sql = postgres(environment.engineConfig.databaseUrl(), {
    max: environment.soakConfig.databaseMaxConnections,
    connect_timeout: environment.soakConfig.databaseConnectTimeoutSeconds,
    idle_timeout: 15,
    max_lifetime: 3_600,
    prepare: false,
  });
  try {
    const sessions = config.sessions();
    const revokedIndex = environment.soakConfig.revokeAccountIndex;
    const observerIndex = revokedIndex === 1 ? 1 : 0;
    const observerSession = sessions[observerIndex];
    if (observerSession === undefined) throw new Error("F57C_OBSERVER_SESSION_UNAVAILABLE");
    return await orchestrateTelegramSoak({
      environment,
      sessions,
      verifier: new TeleprotoSoakSessionVerifier({
        apiId: environment.engineConfig.telegramApiId,
        apiHash: environment.engineConfig.telegramApiHash(),
        operationTimeoutMilliseconds: environment.engineConfig.telegramOperationTimeoutMilliseconds,
      }),
      keyRing: environment.engineConfig.sessionKeyRing(),
      provisioningStore: createPostgresTelegramSoakProvisioningStore(sql),
      runStore: createPostgresTelegramSoakStore(sql),
      deliveryObserver: new TeleprotoSoakDeliveryObserver({
        apiId: environment.engineConfig.telegramApiId,
        apiHash: environment.engineConfig.telegramApiHash(),
        session: observerSession,
        operationTimeoutMilliseconds: environment.engineConfig.telegramOperationTimeoutMilliseconds,
      }),
      emit,
    });
  } finally {
    await sql.end({ timeout: environment.engineConfig.databasePolicy.closeTimeoutSeconds });
  }
}

type ServerState =
  | Readonly<{ status: "RUNNING" }>
  | Readonly<{ status: "PASSED"; report: RailwayTelegramSoakReport }>
  | Readonly<{ status: "FAILED"; report: RailwayTelegramSoakReport | null; failureCode: string }>;

export interface RailwayTelegramSoakServer {
  readonly port: number;
  state(): ServerState;
  close(): Promise<void>;
}

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  const serialized = JSON.stringify(body);
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(serialized),
  });
  response.end(serialized);
}

function defaultLog(record: Readonly<Record<string, unknown>>): void {
  try { process.stdout.write(`${JSON.stringify(record)}\n`); } catch { /* logging cannot affect the soak */ }
}

export async function startRailwayTelegramSoakServer(input: Readonly<{
  config: RailwayTelegramSoakConfig;
  execute?: Execute;
  log?: Log;
}>): Promise<RailwayTelegramSoakServer> {
  const execute = input.execute ?? executeRailwayTelegramSoak;
  const log = input.log ?? defaultLog;
  let state: ServerState = Object.freeze({ status: "RUNNING" });
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://railway-telegram-soak").pathname;
    if (request.method !== "GET") { json(response, 405, { errorCode: "METHOD_NOT_ALLOWED" }); return; }
    if (path === "/health/live") { json(response, 200, { status: "alive" }); return; }
    if (path === "/health/ready") {
      json(response, state.status === "PASSED" ? 200 : 503, { status: state.status.toLowerCase() });
      return;
    }
    if (path === "/benchmark/summary") {
      if (state.status === "RUNNING") json(response, 202, { status: "running" });
      else if (state.status === "PASSED") json(response, 200, state.report);
      else json(response, 503, state.report ?? { failureCode: state.failureCode });
      return;
    }
    json(response, 404, { errorCode: "NOT_FOUND" });
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.config.port, "0.0.0.0", () => resolve());
  });
  const address = server.address() as AddressInfo | null;
  if (!address) { server.close(); throw new Error("F57C_RAILWAY_LISTEN_FAILED"); }

  void execute(input.config, (record) => log(record)).then((result) => {
    const report = summarizeRailwayTelegramSoak(result);
    state = result.passed
      ? Object.freeze({ status: "PASSED", report })
      : Object.freeze({ status: "FAILED", report, failureCode: result.failureCode ?? "F57C_HARD_GATE_FAILED" });
    log(Object.freeze({ type: "F57C_RAILWAY_SOAK_COMPLETED", report }));
  }).catch(() => {
    state = Object.freeze({ status: "FAILED", report: null, failureCode: "F57C_RAILWAY_EXECUTION_FAILED" });
    log(Object.freeze({ type: "F57C_RAILWAY_SOAK_FAILED", failureCode: "F57C_RAILWAY_EXECUTION_FAILED" }));
  });

  let closePromise: Promise<void> | null = null;
  return Object.freeze({
    port: address.port,
    state: () => state,
    close: () => {
      if (closePromise === null) closePromise = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      return closePromise;
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = parseRailwayTelegramSoakEnvironment(process.env);
    void startRailwayTelegramSoakServer({ config }).catch(() => { process.exitCode = 1; });
  } catch (error) {
    const failure = error instanceof RailwayTelegramSoakConfigError ? error.publicData() : { code: "F57C_RAILWAY_START_FAILED" };
    process.stderr.write(`${JSON.stringify({ type: "F57C_RAILWAY_SOAK_FAILED", failure })}\n`);
    process.exitCode = 1;
  }
}
