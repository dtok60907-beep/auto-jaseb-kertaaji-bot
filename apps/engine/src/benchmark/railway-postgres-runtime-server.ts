import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";

import {
  PostgresLoadConfigError,
  runPostgresRuntimeLoad,
  validatePostgresLoadConfig,
  type PostgresLoadConfig,
} from "./postgres-runtime-load.ts";

const F57B_FIELDS = Object.freeze([
  "F57B_COMMIT",
  "F57B_CASES",
  "F57B_SAMPLES",
  "F57B_WARMUP",
  "F57B_DATABASE_MAX_CONNECTIONS",
  "F57B_DATABASE_CONNECT_TIMEOUT_SECONDS",
  "F57B_PROVIDER_LATENCY_MS",
  "F57B_MONITOR_INTERVAL_MS",
  "F57B_TIMEOUT_MS",
  "F57B_ACCOUNT_LEASE_SECONDS",
  "F57B_COMMAND_LEASE_SECONDS",
] as const);

export class RailwayPostgresLoadConfigError extends Error {
  readonly code = "F57B_RAILWAY_CONFIG_INVALID";
  readonly field: string;

  constructor(field: string) {
    super(`F57B_RAILWAY_CONFIG_INVALID:${field}`);
    this.field = field;
  }

  publicData(): Readonly<{ code: "F57B_RAILWAY_CONFIG_INVALID"; field: string }> {
    return Object.freeze({ code: this.code, field: this.field });
  }
}

export type RailwayPostgresLoadServerConfig = Readonly<{
  port: number;
  benchmark: PostgresLoadConfig;
}>;

export type RailwayPostgresLoadReport = Readonly<{
  passed: boolean;
  records: number;
  assertions: Readonly<{ total: number; passed: number; failed: number }>;
  cases: readonly Readonly<{
    accounts: number;
    concurrency: number;
    durationP50Milliseconds: number;
    durationP95Milliseconds: number;
    throughputP50CommandsPerSecond: number;
    rssPeakMaximumBytes: number;
    eventLoopP99MaximumMilliseconds: number;
  }>[];
}>;

export type RailwayPostgresLoadServerState =
  | Readonly<{ status: "RUNNING" }>
  | Readonly<{ status: "PASSED"; report: RailwayPostgresLoadReport }>
  | Readonly<{ status: "FAILED"; failure: Readonly<Record<string, unknown>> }>;

export interface RailwayPostgresLoadServer {
  readonly port: number;
  state(): RailwayPostgresLoadServerState;
  close(): Promise<void>;
}

type BenchmarkRun = typeof runPostgresRuntimeLoad;
type Log = (record: Readonly<Record<string, unknown>>) => void;

function fail(field: string): never { throw new RailwayPostgresLoadConfigError(field); }

function integer(env: Readonly<Record<string, string | undefined>>, field: string, minimum: number, maximum: number): number {
  const value = env[field];
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) fail(field);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) fail(field);
  return parsed;
}

function text(env: Readonly<Record<string, string | undefined>>, field: string): string {
  const value = env[field];
  if (typeof value !== "string" || !value.trim() || value.length > 4_096 || /[\0\r\n]/.test(value)) fail(field);
  return value.trim();
}

function cases(value: string): readonly Readonly<{ accounts: number; concurrency: number }>[] {
  return Object.freeze(value.split(",").map((item, index) => {
    const match = /^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/.exec(item);
    if (!match) fail(`F57B_CASES.${index}`);
    return Object.freeze({ accounts: Number(match[1]), concurrency: Number(match[2]) });
  }));
}

export function parseRailwayPostgresLoadEnvironment(env: Readonly<Record<string, string | undefined>>): RailwayPostgresLoadServerConfig {
  for (const field of F57B_FIELDS) if (env[field] === undefined) fail(field);
  let benchmark: PostgresLoadConfig;
  try {
    benchmark = validatePostgresLoadConfig({
      databaseUrl: text(env, "DATABASE_URL"),
      commit: text(env, "F57B_COMMIT"),
      cases: cases(text(env, "F57B_CASES")),
      samples: integer(env, "F57B_SAMPLES", 1, 100),
      warmupSamples: integer(env, "F57B_WARMUP", 0, 20),
      databaseMaxConnections: integer(env, "F57B_DATABASE_MAX_CONNECTIONS", 1, 100),
      databaseConnectTimeoutSeconds: integer(env, "F57B_DATABASE_CONNECT_TIMEOUT_SECONDS", 1, 120),
      providerLatencyMilliseconds: integer(env, "F57B_PROVIDER_LATENCY_MS", 0, 120_000),
      monitorIntervalMilliseconds: integer(env, "F57B_MONITOR_INTERVAL_MS", 1, 1_000),
      sampleTimeoutMilliseconds: integer(env, "F57B_TIMEOUT_MS", 1, 3_600_000),
      accountLeaseSeconds: integer(env, "F57B_ACCOUNT_LEASE_SECONDS", 5, 3_600),
      commandLeaseSeconds: integer(env, "F57B_COMMAND_LEASE_SECONDS", 5, 3_600),
    });
  } catch (error) {
    if (error instanceof PostgresLoadConfigError) fail(error.field);
    throw error;
  }
  return Object.freeze({ port: integer(env, "PORT", 1, 65_535), benchmark });
}

function percentile(values: readonly number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, (sorted.length - 1) * ratio));
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}

function numberField(record: Record<string, unknown>, field: string): number | null {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function summarizeRailwayPostgresLoad(result: Awaited<ReturnType<BenchmarkRun>>): RailwayPostgresLoadReport {
  const assertions = result.records.filter((record) => record.type === "assertion");
  const grouped = new Map<string, { accounts: number; concurrency: number; duration: number[]; throughput: number[]; rss: number[]; lag: number[] }>();
  for (const record of result.records) {
    if (record.type !== "sample" || typeof record.scenario !== "string" || typeof record.sessions !== "number") continue;
    const concurrency = /^postgres-runtime-c([0-9]+)$/.exec(record.scenario)?.[1];
    if (!concurrency) continue;
    const key = `${record.sessions}:${concurrency}`;
    const group = grouped.get(key) ?? { accounts: record.sessions, concurrency: Number(concurrency), duration: [], throughput: [], rss: [], lag: [] };
    const value = numberField(record, "value");
    if (value !== null) {
      if (record.metric === "total_duration") group.duration.push(value);
      if (record.metric === "throughput") group.throughput.push(value);
      if (record.metric === "rss_peak") group.rss.push(value);
      if (record.metric === "event_loop_delay_p99") group.lag.push(value);
    }
    grouped.set(key, group);
  }
  const caseReports = [...grouped.values()]
    .map((group) => Object.freeze({
      accounts: group.accounts,
      concurrency: group.concurrency,
      durationP50Milliseconds: percentile(group.duration, 0.5),
      durationP95Milliseconds: percentile(group.duration, 0.95),
      throughputP50CommandsPerSecond: percentile(group.throughput, 0.5),
      rssPeakMaximumBytes: Math.max(0, ...group.rss),
      eventLoopP99MaximumMilliseconds: Math.max(0, ...group.lag),
    }))
    .sort((left, right) => left.accounts - right.accounts || left.concurrency - right.concurrency);
  const passed = assertions.filter((record) => record.passed === true).length;
  return Object.freeze({
    passed: result.passed,
    records: result.records.length,
    assertions: Object.freeze({ total: assertions.length, passed, failed: assertions.length - passed }),
    cases: Object.freeze(caseReports),
  });
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
  try { process.stdout.write(`${JSON.stringify(record)}\n`); }
  catch { /* logging cannot affect a benchmark run */ }
}

export async function startRailwayPostgresLoadServer(input: Readonly<{
  config: RailwayPostgresLoadServerConfig;
  run?: BenchmarkRun;
  log?: Log;
}>): Promise<RailwayPostgresLoadServer> {
  const run = input.run ?? runPostgresRuntimeLoad;
  const log = input.log ?? defaultLog;
  let state: RailwayPostgresLoadServerState = Object.freeze({ status: "RUNNING" });
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://railway-benchmark").pathname;
    if (request.method !== "GET") { json(response, 405, { errorCode: "METHOD_NOT_ALLOWED" }); return; }
    if (path === "/health/live") { json(response, 200, { status: "alive" }); return; }
    if (path === "/health/ready") {
      json(response, state.status === "PASSED" ? 200 : 503, { status: state.status.toLowerCase() });
      return;
    }
    if (path === "/benchmark/summary") {
      if (state.status === "PASSED") json(response, 200, state.report);
      else if (state.status === "FAILED") json(response, 503, state.failure);
      else json(response, 202, { status: "running" });
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
  if (!address) { server.close(); throw new Error("F57B_RAILWAY_LISTEN_FAILED"); }
  void run(input.config.benchmark).then((result) => {
    const report = summarizeRailwayPostgresLoad(result);
    state = result.passed
      ? Object.freeze({ status: "PASSED", report })
      : Object.freeze({ status: "FAILED", failure: Object.freeze({ code: "F57B_RAILWAY_HARD_GATE_FAILED", assertions: report.assertions }) });
    log(Object.freeze({ type: "F57B_RAILWAY_BENCHMARK_COMPLETED", report }));
  }).catch((error: unknown) => {
    const failure = error instanceof RailwayPostgresLoadConfigError || error instanceof PostgresLoadConfigError
      ? error.publicData()
      : Object.freeze({ code: "F57B_RAILWAY_BENCHMARK_FAILED" });
    state = Object.freeze({ status: "FAILED", failure });
    log(Object.freeze({ type: "F57B_RAILWAY_BENCHMARK_FAILED", failure }));
  });
  let closePromise: Promise<void> | null = null;
  return Object.freeze({
    port: address.port,
    state: () => state,
    close: () => {
      if (!closePromise) closePromise = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      return closePromise;
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = parseRailwayPostgresLoadEnvironment(process.env);
    void startRailwayPostgresLoadServer({ config }).catch(() => { process.exitCode = 1; });
  } catch (error) {
    const failure = error instanceof RailwayPostgresLoadConfigError ? error.publicData() : { code: "F57B_RAILWAY_START_FAILED" };
    process.stderr.write(`${JSON.stringify({ type: "F57B_RAILWAY_BENCHMARK_FAILED", failure })}\n`);
    process.exitCode = 1;
  }
}
