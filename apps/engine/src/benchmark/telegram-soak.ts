import { cpus, totalmem } from "node:os";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

import type { TelegramRuntimeAdapterFactory } from "../account-runner/contracts.ts";
import type { TelegramDeliveryAdapter } from "../../../../packages/telegram-contract/src/index.ts";

const CANDIDATE = "production-teleproto-controlled";
const COMMIT = /^[0-9a-f]{7,40}$/i;
const RUN_ID = /^[a-z0-9-]{4,64}$/;
const MAX_MINUTE = 1_440;

export type TelegramSoakConfig = Readonly<{
  databaseUrl: string;
  commit: string;
  runId: string;
  soakDurationMinutes: number;
  burstIntervalSeconds: number;
  sendIntervalSeconds: number;
  expectedAccounts: number;
  approvedCommandCount: number;
  interruptAtMinutes: readonly number[];
  revokeAccountIndex: number | null;
  revokeAfterMinute: number | null;
  monitorIntervalMilliseconds: number;
  healthTimeoutMilliseconds: number;
  databaseMaxConnections: number;
  databaseConnectTimeoutSeconds: number;
}>;

export class TelegramSoakConfigError extends Error {
  readonly code = "TELEGRAM_SOAK_CONFIG_INVALID";
  readonly field: string;

  constructor(field: string) {
    super(`TELEGRAM_SOAK_CONFIG_INVALID:${field}`);
    this.name = "TelegramSoakConfigError";
    this.field = field;
  }

  publicData(): Readonly<{ code: "TELEGRAM_SOAK_CONFIG_INVALID"; field: string }> {
    return Object.freeze({ code: this.code, field: this.field });
  }
}

function fail(field: string): never { throw new TelegramSoakConfigError(field); }

function integer(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(field);
  return value;
}

export function plannedTelegramSoakCommandCount(input: Readonly<{
  soakDurationMinutes: number;
  burstIntervalSeconds: number;
  expectedAccounts: number;
  revokeAfterMinute: number | null;
}>): number {
  const regularBursts = Math.ceil((input.soakDurationMinutes * 60) / input.burstIntervalSeconds);
  if (input.revokeAfterMinute === null) return (regularBursts + 1) * input.expectedAccounts;
  const burstsBeforeRevocation = Math.min(
    regularBursts,
    Math.ceil((input.revokeAfterMinute * 60) / input.burstIntervalSeconds),
  );
  const survivorCount = input.expectedAccounts - 1;
  return (burstsBeforeRevocation * input.expectedAccounts)
    + ((regularBursts - burstsBeforeRevocation + 1) * survivorCount);
}

export function validateTelegramSoakConfig(input: TelegramSoakConfig): TelegramSoakConfig {
  if (!input.databaseUrl.trim()) fail("databaseUrl");
  if (!COMMIT.test(input.commit)) fail("commit");
  if (typeof input.runId !== "string" || !RUN_ID.test(input.runId)) fail("runId");
  const soakDurationMinutes = integer(input.soakDurationMinutes, "soakDurationMinutes", 1, MAX_MINUTE);
  const expectedAccounts = integer(input.expectedAccounts, "expectedAccounts", 1, 50);
  const burstIntervalSeconds = integer(input.burstIntervalSeconds, "burstIntervalSeconds", 10, 3_600);
  const approvedCommandCount = integer(input.approvedCommandCount, "approvedCommandCount", 1, 1_000_000);
  const interrupts = input.interruptAtMinutes.map((minute, index) => {
    const parsed = integer(minute, `interruptAtMinutes.${index}`, 1, MAX_MINUTE - 1);
    if (parsed >= input.soakDurationMinutes) fail(`interruptAtMinutes.${index}`);
    return parsed;
  });
  if (new Set(interrupts).size !== interrupts.length) fail("interruptAtMinutes");
  const revokeAccountIndex = input.revokeAccountIndex === null ? null : integer(input.revokeAccountIndex, "revokeAccountIndex", 1, expectedAccountsSafe(input));
  const revokeAfterMinute = input.revokeAfterMinute === null ? null : integer(input.revokeAfterMinute, "revokeAfterMinute", 1, MAX_MINUTE - 1);
  if ((revokeAccountIndex === null) !== (revokeAfterMinute === null)) fail("revokeAccountIndex");
  if (revokeAccountIndex !== null && expectedAccounts < 2) fail("revokeAccountIndex");
  if (revokeAfterMinute !== null && revokeAfterMinute >= input.soakDurationMinutes) fail("revokeAfterMinute");
  const plannedCommandCount = plannedTelegramSoakCommandCount({
    soakDurationMinutes,
    burstIntervalSeconds,
    expectedAccounts,
    revokeAfterMinute,
  });
  if (approvedCommandCount !== plannedCommandCount) fail("approvedCommandCount");
  return Object.freeze({
    databaseUrl: input.databaseUrl.trim(),
    commit: input.commit.toLowerCase(),
    runId: input.runId,
    soakDurationMinutes,
    expectedAccounts,
    burstIntervalSeconds,
    sendIntervalSeconds: integer(input.sendIntervalSeconds, "sendIntervalSeconds", 0, 3_600),
    approvedCommandCount,
    interruptAtMinutes: Object.freeze([...interrupts].sort((left, right) => left - right)),
    revokeAccountIndex,
    revokeAfterMinute,
    monitorIntervalMilliseconds: integer(input.monitorIntervalMilliseconds, "monitorIntervalMilliseconds", 1_000, 3_600_000),
    healthTimeoutMilliseconds: integer(input.healthTimeoutMilliseconds, "healthTimeoutMilliseconds", 1_000, 3_600_000),
    databaseMaxConnections: integer(input.databaseMaxConnections, "databaseMaxConnections", 1, 20),
    databaseConnectTimeoutSeconds: integer(input.databaseConnectTimeoutSeconds, "databaseConnectTimeoutSeconds", 1, 120),
  });
}

function expectedAccountsSafe(input: TelegramSoakConfig): number {
  return Number.isSafeInteger(input.expectedAccounts) && input.expectedAccounts >= 1 ? input.expectedAccounts : 0;
}

export type TelegramSoakRecord =
  | Readonly<{
      type: "metadata";
      candidate: typeof CANDIDATE;
      benchmarkVersion: "f5.7c-v1";
      scope: "CONTROLLED_TELEGRAM_SOAK";
      runtime: "node";
      runtimeVersion: string;
      platform: string;
      architecture: string;
      logicalCpuCount: number;
      totalMemoryBytes: number;
      commit: string;
      workload: Readonly<{
        runId: string;
        soakDurationMinutes: number;
        burstIntervalSeconds: number;
        sendIntervalSeconds: number;
        expectedAccounts: number;
        approvedCommandCount: number;
        interruptAtMinutes: readonly number[];
        revokeAccountIndex: number | null;
        revokeAfterMinute: number | null;
        monitorIntervalMilliseconds: number;
        healthTimeoutMilliseconds: number;
      }>;
    }>
  | Readonly<{ type: "assertion"; candidate: typeof CANDIDATE; scenario: string; sampleIndex: number; name: string; passed: boolean; hardGate: true }>
  | Readonly<{ type: "sample"; candidate: typeof CANDIDATE; scenario: string; sessions: number; sampleIndex: number; metric: string; value: number; unit: string }>;

export function soakMetadata(config: TelegramSoakConfig): TelegramSoakRecord {
  const processors = cpus();
  return Object.freeze({
    type: "metadata",
    candidate: CANDIDATE,
    benchmarkVersion: "f5.7c-v1",
    scope: "CONTROLLED_TELEGRAM_SOAK",
    runtime: "node",
    runtimeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    logicalCpuCount: processors.length,
    totalMemoryBytes: totalmem(),
    commit: config.commit,
    workload: Object.freeze({
      runId: config.runId,
      soakDurationMinutes: config.soakDurationMinutes,
      burstIntervalSeconds: config.burstIntervalSeconds,
      sendIntervalSeconds: config.sendIntervalSeconds,
      expectedAccounts: config.expectedAccounts,
      approvedCommandCount: config.approvedCommandCount,
      interruptAtMinutes: config.interruptAtMinutes,
      revokeAccountIndex: config.revokeAccountIndex,
      revokeAfterMinute: config.revokeAfterMinute,
      monitorIntervalMilliseconds: config.monitorIntervalMilliseconds,
      healthTimeoutMilliseconds: config.healthTimeoutMilliseconds,
    }),
  });
}

export function soakAssertion(name: string, passed: boolean): TelegramSoakRecord {
  return Object.freeze({ type: "assertion", candidate: CANDIDATE, scenario: "telegram-soak", sampleIndex: 0, name, passed, hardGate: true });
}

export function soakSample(sampleIndex: number, sessions: number, metric: string, value: number, unit: string): TelegramSoakRecord {
  return Object.freeze({
    type: "sample", candidate: CANDIDATE, scenario: "telegram-soak", sessions,
    sampleIndex, metric, value: Number.isFinite(value) ? value : 0, unit,
  });
}

export interface SoakResourceReading {
  readonly rssPeakBytes: number;
  readonly heapUsedBytes: number;
  readonly eventLoopDelayP99Milliseconds: number;
  readonly cpuPercentOneCore: number;
}

export function createResourceSampler(monitorIntervalMilliseconds: number): {
  sample(): SoakResourceReading;
  close(): void;
} {
  let rssPeak = process.memoryUsage().rss;
  let histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  let cpuBefore = process.cpuUsage();
  let windowStartedAt = performance.now();
  const memoryTimer = setInterval(() => { rssPeak = Math.max(rssPeak, process.memoryUsage().rss); }, Math.min(monitorIntervalMilliseconds, 1_000));
  memoryTimer.unref();
  return {
    sample() {
      const cpu = process.cpuUsage(cpuBefore);
      const elapsedMilliseconds = Math.max(performance.now() - windowStartedAt, 1);
      const reading = Object.freeze({
        rssPeakBytes: rssPeak,
        heapUsedBytes: process.memoryUsage().heapUsed,
        eventLoopDelayP99Milliseconds: histogram.percentile(99) / 1_000_000,
        cpuPercentOneCore: ((cpu.user + cpu.system) / (elapsedMilliseconds * 1_000)) * 100,
      });
      histogram.disable();
      histogram = monitorEventLoopDelay({ resolution: 20 });
      histogram.enable();
      cpuBefore = process.cpuUsage();
      windowStartedAt = performance.now();
      return reading;
    },
    close() {
      clearInterval(memoryTimer);
      histogram.disable();
    },
  };
}

export interface SoakChaos {
  wrapAdapterFactory(factory: TelegramRuntimeAdapterFactory): TelegramRuntimeAdapterFactory;
  interruptAll(): Promise<void>;
  interruptions(): number;
}

/**
 * Drops adapters created through the wrapped factory. This proves application-level
 * recovery from an adapter disconnect; it must not be reported as a physical network
 * partition because no Railway or host network is cut by this helper.
 */
export function createSoakChaos(): SoakChaos {
  const live = new Set<TelegramDeliveryAdapter>();
  let interruptions = 0;
  return Object.freeze({
    wrapAdapterFactory: (factory: TelegramRuntimeAdapterFactory) => Object.freeze({
      create: (input: Parameters<TelegramRuntimeAdapterFactory["create"]>[0]) => {
        const adapter = factory.create(input);
        live.add(adapter);
        return adapter;
      },
    }),
    interruptAll: async () => {
      interruptions += 1;
      for (const adapter of [...live]) {
        try { await adapter.disconnect(); }
        catch { /* a controlled disconnect failure is observed by the runner gates */ }
      }
    },
    interruptions: () => interruptions,
  });
}

export type SoakFixtureCounts = Readonly<{
  accountsReady: number;
  accountsRevoked: number;
  accountsDegraded: number;
  commandsCreated: number;
  commandsSucceeded: number;
  commandsPending: number;
  commandsInFlight: number;
  commandsFailedRetryable: number;
  commandsFailedFinal: number;
  commandsUncertain: number;
  activeLeases: number;
}>;

export type SendLatencySummary = Readonly<{
  sendsSucceeded: number;
  latencyP50Milliseconds: number;
  latencyP95Milliseconds: number;
  latencyMaxMilliseconds: number;
}>;
