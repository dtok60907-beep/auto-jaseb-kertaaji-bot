import postgres, { type Sql } from "postgres";

import type {
  AccountRunnerDependencies,
} from "../account-runner/contracts.ts";
import { runBroadcastAccount } from "../account-runner/service.ts";
import { ProductionEngineConfig } from "../production/config.ts";
import {
  startProductionEngineCore,
  type ProductionEngineCoreHandle,
} from "../production/core.ts";
import {
  createSoakChaos,
  createResourceSampler,
  soakAssertion,
  soakMetadata,
  soakSample,
  validateTelegramSoakConfig,
  type SendLatencySummary,
  type SoakFixtureCounts,
  type TelegramSoakConfig,
} from "./telegram-soak.ts";
import {
  createPostgresTelegramSoakStore,
  type SoakAccountIdentity,
  type SoakBurstAccount,
  type SoakPerAccountState,
  type TelegramSoakStore,
} from "./telegram-soak-store.ts";

const SOAK_ENV_FIELDS = Object.freeze([
  "F57C_COMMIT",
  "F57C_RUN_ID",
  "F57C_SOAK_MINUTES",
  "F57C_BURST_INTERVAL_SECONDS",
  "F57C_SEND_INTERVAL_SECONDS",
  "F57C_EXPECTED_ACCOUNTS",
  "F57C_APPROVED_COMMAND_COUNT",
  "F57C_TARGET_REF",
  "F57C_MONITOR_INTERVAL_MS",
  "F57C_HEALTH_TIMEOUT_MS",
  "F57C_DB_MAX_CONNECTIONS",
  "F57C_DB_CONNECT_TIMEOUT_SECONDS",
] as const);

export function burstOperationPrefix(runId: string): string { return `f57c-${runId}-b`; }
export function seedOperationPrefix(runId: string): string { return `f57c-soak-${runId}-seed`; }

export class TelegramSoakEnvironmentError extends Error {
  readonly code = "TELEGRAM_SOAK_ENV_INVALID";
  readonly field: string;

  constructor(field: string) {
    super(`TELEGRAM_SOAK_ENV_INVALID:${field}`);
    this.name = "TelegramSoakEnvironmentError";
    this.field = field;
  }

  publicData(): Readonly<{ code: "TELEGRAM_SOAK_ENV_INVALID"; field: string }> {
    return Object.freeze({ code: this.code, field: this.field });
  }
}

function failEnv(field: string): never { throw new TelegramSoakEnvironmentError(field); }

function envInteger(env: Readonly<Record<string, string | undefined>>, field: string, minimum: number, maximum: number): number {
  const value = env[field];
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) failEnv(field);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) failEnv(field);
  return parsed;
}

function envText(env: Readonly<Record<string, string | undefined>>, field: string, maximumLength = 256): string {
  const value = env[field];
  if (typeof value !== "string" || !value.trim() || value.length > maximumLength || /[\0\r\n]/.test(value)) failEnv(field);
  return value.trim();
}

function envOptionalInteger(env: Readonly<Record<string, string | undefined>>, field: string): number | null {
  const value = env[field];
  if (value === undefined || value === "") return null;
  if (!/^[1-9][0-9]*$/.test(value)) failEnv(field);
  return Number(value);
}

export type TelegramSoakEnvironment = Readonly<{
  engineConfig: ProductionEngineConfig;
  soakConfig: TelegramSoakConfig;
  targetRef: string;
}>;

export function parseSoakEnvironment(env: Readonly<Record<string, string | undefined>>): TelegramSoakEnvironment {
  for (const field of SOAK_ENV_FIELDS) if (env[field] === undefined) failEnv(field);
  const rawInterrupts = env.F57C_INTERRUPT_AT_MINUTES ?? "";
  if (rawInterrupts !== "" && !/^[1-9][0-9]*(,[1-9][0-9]*)*$/.test(rawInterrupts)) failEnv("F57C_INTERRUPT_AT_MINUTES");
  const interruptAtMinutes = rawInterrupts === "" ? [] : rawInterrupts.split(",").map(Number);
  let soakConfig: TelegramSoakConfig;
  try {
    soakConfig = validateTelegramSoakConfig({
      databaseUrl: env.DATABASE_URL ?? "",
      commit: env.F57C_COMMIT ?? "",
      runId: envText(env, "F57C_RUN_ID", 64),
      soakDurationMinutes: envInteger(env, "F57C_SOAK_MINUTES", 1, 1_440),
      burstIntervalSeconds: envInteger(env, "F57C_BURST_INTERVAL_SECONDS", 10, 3_600),
      sendIntervalSeconds: envInteger(env, "F57C_SEND_INTERVAL_SECONDS", 0, 3_600),
      expectedAccounts: envInteger(env, "F57C_EXPECTED_ACCOUNTS", 1, 50),
      approvedCommandCount: envInteger(env, "F57C_APPROVED_COMMAND_COUNT", 1, 1_000_000),
      interruptAtMinutes: Object.freeze(interruptAtMinutes),
      revokeAccountIndex: envOptionalInteger(env, "F57C_REVOKE_ACCOUNT_INDEX"),
      revokeAfterMinute: envOptionalInteger(env, "F57C_REVOKE_AFTER_MINUTES"),
      monitorIntervalMilliseconds: envInteger(env, "F57C_MONITOR_INTERVAL_MS", 1_000, 3_600_000),
      healthTimeoutMilliseconds: envInteger(env, "F57C_HEALTH_TIMEOUT_MS", 1_000, 3_600_000),
      databaseMaxConnections: envInteger(env, "F57C_DB_MAX_CONNECTIONS", 1, 20),
      databaseConnectTimeoutSeconds: envInteger(env, "F57C_DB_CONNECT_TIMEOUT_SECONDS", 1, 120),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TelegramSoakConfigError") {
      failEnv((error as { readonly field?: string }).field ?? "soakConfig");
    }
    throw error;
  }
  return Object.freeze({
    engineConfig: ProductionEngineConfig.fromEnvironment(env),
    soakConfig,
    targetRef: envText(env, "F57C_TARGET_REF"),
  });
}

export type SoakEmitter = (record: Readonly<Record<string, unknown>>) => void;

const EMPTY_COUNTS: SoakFixtureCounts = Object.freeze({
  accountsReady: 0,
  accountsRevoked: 0,
  accountsDegraded: 0,
  commandsCreated: 0,
  commandsSucceeded: 0,
  commandsPending: 0,
  commandsInFlight: 0,
  commandsFailedRetryable: 0,
  commandsFailedFinal: 0,
  commandsUncertain: 0,
  commandsCancelled: 0,
  activeLeases: 0,
});

export type SoakRunSummary = Readonly<{
  runId: string;
  elapsedMilliseconds: number;
  burstsAttempted: number;
  burstsEnqueued: number;
  commandsEnqueued: number;
  interruptsConfigured: number;
  interruptsFired: number;
  accountsProvisioned: number;
  finalCounts: SoakFixtureCounts;
  perAccount: readonly SoakPerAccountState[];
  sendLatency: SendLatencySummary;
  malformedReceipts: number;
  rssPeakBytes: number;
  heapPeakBytes: number;
  eventLoopP99MaximumMilliseconds: number;
  cpuPercentOneCoreAverage: number;
  engineCleanupErrorCodes: readonly string[];
  supervisorRunnerFailures: number | null;
  cleanupDeletedOperations: number;
  cleanupSucceeded: boolean;
  remainingBurstOperations: number;
}>;

export type SoakRunResult = Readonly<{
  passed: boolean;
  summary: SoakRunSummary;
}>;

export async function runTelegramSoak(input: Readonly<{
  environment: TelegramSoakEnvironment;
  emit: SoakEmitter;
  startEngine?: typeof startProductionEngineCore;
  sql?: Sql;
  store?: TelegramSoakStore;
  revokeAccount?: (input: Readonly<{
    account: SoakAccountIdentity;
    accountIndex: number;
    firedAtIso: string;
  }>) => Promise<void>;
  pause?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}>): Promise<SoakRunResult> {
  const { environment, emit } = input;
  const soak = environment.soakConfig;
  const pause = input.pause ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = input.now ?? Date.now;
  const commandPrefix = burstOperationPrefix(soak.runId);
  const accountPrefix = seedOperationPrefix(soak.runId);
  const prefixes = Object.freeze({ commandPrefix, accountPrefix });

  let sql: Sql | null = input.sql ?? null;
  const ownedSql = input.store === undefined && sql === null;
  if (input.store === undefined && sql === null) {
    sql = postgres(environment.engineConfig.databaseUrl(), {
      max: soak.databaseMaxConnections,
      connect_timeout: soak.databaseConnectTimeoutSeconds,
      idle_timeout: 15,
      max_lifetime: 3_600,
      prepare: false,
    });
  }
  const store = input.store ?? createPostgresTelegramSoakStore(sql!);

  let engine: ProductionEngineCoreHandle | null = null;
  let monitor: ReturnType<typeof createResourceSampler> | null = null;
  const interruptsFiredAt: string[] = [];
  const revokedAccountIds = new Set<string>();
  let revocationFiredAt: string | null = null;
  const startedAt = now();
  const durationMilliseconds = soak.soakDurationMinutes * 60_000;
  let passed = true;
  let burstsAttempted = 0;
  let burstsEnqueued = 0;
  let commandsEnqueued = 0;
  let monitorIndex = 0;
  let rssPeakBytes = 0;
  let heapPeakBytes = 0;
  let eventLoopP99MaximumMilliseconds = 0;
  let cpuPercentSum = 0;
  let cpuSamples = 0;
  let finalCounts: SoakFixtureCounts = EMPTY_COUNTS;
  let perAccount: readonly SoakPerAccountState[] = Object.freeze([]);
  let sendLatency: SendLatencySummary = Object.freeze({ sendsSucceeded: 0, latencyP50Milliseconds: 0, latencyP95Milliseconds: 0, latencyMaxMilliseconds: 0 });
  let malformedReceipts = 0;
  let engineCleanupErrorCodes: readonly string[] = Object.freeze([]);
  let supervisorRunnerFailures: number | null = null;
  let cleanupDeletedOperations = 0;
  let cleanupSucceeded = false;
  let remainingBurstOperations = -1;
  let finishPromise: Promise<SoakRunResult> | null = null;

  const gate = (name: string, gatePassed: boolean): boolean => {
    emit(soakAssertion(name, gatePassed));
    if (!gatePassed) passed = false;
    return gatePassed;
  };

  function summarize(): SoakRunSummary {
    return Object.freeze({
      runId: soak.runId,
      elapsedMilliseconds: now() - startedAt,
      burstsAttempted,
      burstsEnqueued,
      commandsEnqueued,
      interruptsConfigured: soak.interruptAtMinutes.length,
      interruptsFired: interruptsFiredAt.length,
      accountsProvisioned: perAccount.length,
      finalCounts,
      perAccount,
      sendLatency,
      malformedReceipts,
      rssPeakBytes,
      heapPeakBytes,
      eventLoopP99MaximumMilliseconds,
      cpuPercentOneCoreAverage: cpuSamples === 0 ? 0 : cpuPercentSum / cpuSamples,
      engineCleanupErrorCodes,
      supervisorRunnerFailures,
      cleanupDeletedOperations,
      cleanupSucceeded,
      remainingBurstOperations,
    });
  }

  async function stopEngine(): Promise<void> {
    if (engine === null) return;
    const runningEngine = engine;
    engine = null;
    try {
      const stopped = await runningEngine.stop();
      engineCleanupErrorCodes = stopped.cleanupErrorCodes;
      supervisorRunnerFailures = stopped.supervisor === null ? null : stopped.supervisor.runnerFailures;
    } catch {
      engineCleanupErrorCodes = Object.freeze(["ENGINE_STOP_FAILED"]);
      supervisorRunnerFailures = null;
      passed = false;
    }
  }

  function finish(): Promise<SoakRunResult> {
    if (finishPromise !== null) return finishPromise;
    finishPromise = (async () => {
      await stopEngine();
      monitor?.close();
      monitor = null;
      try {
        cleanupDeletedOperations = await store.cleanupBurstOperations(commandPrefix);
        remainingBurstOperations = await store.countBurstOperations(commandPrefix);
        cleanupSucceeded = remainingBurstOperations === 0;
      } catch {
        cleanupSucceeded = false;
        remainingBurstOperations = -1;
      }
      gate("benchmark_fixtures_cleaned", cleanupSucceeded);
      return Object.freeze({ passed, summary: summarize() });
    })();
    return finishPromise;
  }

  try {
    emit(soakMetadata(soak));

    const accounts = await store.listAccounts(accountPrefix);
    if (!gate("provisioned_accounts_present", accounts.length === soak.expectedAccounts)) {
      return finish();
    }
    const indexedAccounts: readonly SoakBurstAccount[] = Object.freeze(accounts.map((account, index) => Object.freeze({
      ...account,
      accountIndex: index + 1,
    })));

    const chaos = createSoakChaos();
    const starter = input.startEngine ?? startProductionEngineCore;
    try {
      engine = await starter(environment.engineConfig, {
        factories: {
          runAccount: (dependencies: AccountRunnerDependencies, runInput: Parameters<typeof runBroadcastAccount>[1]) =>
            runBroadcastAccount(
              Object.freeze({ ...dependencies, adapterFactory: chaos.wrapAdapterFactory(dependencies.adapterFactory) }),
              runInput,
            ),
        },
      });
    } catch {
      gate("engine_started", false);
      return finish();
    }
    gate("engine_started", true);

    monitor = createResourceSampler(soak.monitorIntervalMilliseconds);
    let healthBurstEnqueued = true;
    let burstIndex = 1;
    let nextBurstAt = startedAt;
    let nextSampleAt = startedAt;
    let nextInterruptIndex = 0;

    while (now() - startedAt < durationMilliseconds) {
      const current = now();

      while (nextInterruptIndex < soak.interruptAtMinutes.length
        && current - startedAt >= soak.interruptAtMinutes[nextInterruptIndex]! * 60_000) {
        interruptsFiredAt.push(new Date(current).toISOString());
        nextInterruptIndex += 1;
        await chaos.interruptAll();
      }

      if (soak.revokeAfterMinute !== null
        && revocationFiredAt === null
        && current - startedAt >= soak.revokeAfterMinute * 60_000) {
        if (input.revokeAccount === undefined || soak.revokeAccountIndex === null) {
          gate("revocation_controller_configured", false);
          return finish();
        }
        const account = accounts[soak.revokeAccountIndex - 1];
        if (account === undefined) {
          gate("revocation_account_resolved", false);
          return finish();
        }
        const firedAtIso = new Date(current).toISOString();
        try {
          await input.revokeAccount({ account, accountIndex: soak.revokeAccountIndex, firedAtIso });
          revokedAccountIds.add(account.accountId);
          revocationFiredAt = firedAtIso;
          gate("revocation_injected", true);
        } catch {
          gate("revocation_injected", false);
          return finish();
        }
      }

      if (current >= nextBurstAt) {
        burstsAttempted += 1;
        const activeAccounts = indexedAccounts.filter((account) => !revokedAccountIds.has(account.accountId));
        try {
          commandsEnqueued += await store.enqueueBurst({
            runId: soak.runId,
            burstIndex,
            accounts: activeAccounts,
            targetRef: environment.targetRef,
            sendIntervalSeconds: soak.sendIntervalSeconds,
            label: `burst-${burstIndex}`,
          });
          burstsEnqueued += 1;
        } catch {
          // A failed enqueue is accounted by the bursts_enqueued_cleanly gate.
        }
        burstIndex += 1;
        nextBurstAt = startedAt + burstsAttempted * soak.burstIntervalSeconds * 1_000;
      }

      if (current >= nextSampleAt) {
        monitorIndex += 1;
        const reading = monitor.sample();
        rssPeakBytes = Math.max(rssPeakBytes, reading.rssPeakBytes);
        heapPeakBytes = Math.max(heapPeakBytes, reading.heapUsedBytes);
        eventLoopP99MaximumMilliseconds = Math.max(eventLoopP99MaximumMilliseconds, reading.eventLoopDelayP99Milliseconds);
        cpuPercentSum += reading.cpuPercentOneCore;
        cpuSamples += 1;
        emit(soakSample(monitorIndex, accounts.length, "rss_peak_bytes", reading.rssPeakBytes, "bytes"));
        emit(soakSample(monitorIndex, accounts.length, "heap_used_bytes", reading.heapUsedBytes, "bytes"));
        emit(soakSample(monitorIndex, accounts.length, "event_loop_delay_p99_ms", reading.eventLoopDelayP99Milliseconds, "ms"));
        emit(soakSample(monitorIndex, accounts.length, "cpu_percent_one_core", reading.cpuPercentOneCore, "percent"));
        nextSampleAt = startedAt + monitorIndex * soak.monitorIntervalMilliseconds;
      }

      const nextEvent = Math.min(nextBurstAt, nextSampleAt, startedAt + durationMilliseconds);
      await pause(Math.max(1, Math.min(1_000, nextEvent - now())));
    }

    const burstsClean = gate("bursts_enqueued_cleanly", burstsAttempted === 0 || burstsEnqueued === burstsAttempted);
    const interruptionsClean = soak.interruptAtMinutes.length === 0
      || gate("interruptions_injected", interruptsFiredAt.length === soak.interruptAtMinutes.length);
    if (!burstsClean || !interruptionsClean) return finish();

    // §7 health phase: one final burst per account; every survivor must deliver.
    const healthBurstIso = new Date(now()).toISOString();
    burstsAttempted += 1;
    const survivorAccounts = indexedAccounts.filter((account) => !revokedAccountIds.has(account.accountId));
    try {
      commandsEnqueued += await store.enqueueBurst({
        runId: soak.runId,
        burstIndex,
        accounts: survivorAccounts,
        targetRef: environment.targetRef,
        sendIntervalSeconds: soak.sendIntervalSeconds,
        label: "health",
      });
      burstsEnqueued += 1;
    } catch {
      healthBurstEnqueued = false;
    }
    if (!gate("approved_command_count_respected", commandsEnqueued === soak.approvedCommandCount)) return finish();
    perAccount = await store.readPerAccount(prefixes);
    const healthDeadline = now() + soak.healthTimeoutMilliseconds;
    while (now() < healthDeadline && perAccount.some((state) => state.inFlight > 0 || (state.accountStatus !== "REVOKED" && state.pending > 0))) {
      await pause(500);
      perAccount = await store.readPerAccount(prefixes);
    }

    await stopEngine();

    finalCounts = await store.readCounts(prefixes);
    perAccount = await store.readPerAccount(prefixes);
    sendLatency = await store.readSendLatencies(commandPrefix);
    malformedReceipts = await store.readMalformedReceiptCount(commandPrefix);

    if (!gate("all_commands_accounted", finalCounts.commandsCreated
      === finalCounts.commandsSucceeded + finalCounts.commandsPending + finalCounts.commandsInFlight
        + finalCounts.commandsFailedRetryable + finalCounts.commandsFailedFinal + finalCounts.commandsUncertain
        + finalCounts.commandsCancelled)) {
      return finish();
    }
    if (!gate("event_loss_zero", finalCounts.commandsInFlight === 0
      && perAccount.every((state) => state.inFlight === 0 && (state.accountStatus === "REVOKED" || state.pending === 0)))) {
      return finish();
    }
    if (!gate("provider_receipt_shape_valid", malformedReceipts === 0)) return finish();
    if (!gate("failed_retryable_zero", finalCounts.commandsFailedRetryable === 0)) return finish();
    if (!gate("failed_final_zero", finalCounts.commandsFailedFinal === 0)) return finish();
    if (!gate("side_effect_uncertain_zero", finalCounts.commandsUncertain === 0)) return finish();

    const expectedRevokedAccounts = soak.revokeAccountIndex === null ? 0 : 1;
    const revokedAccounts = perAccount.filter((state) => state.accountStatus === "REVOKED").length;
    if (!gate("revocation_expectation_met", revokedAccounts === expectedRevokedAccounts)) return finish();

    if (soak.revokeAfterMinute !== null) {
      if (revocationFiredAt === null) {
        gate("revocation_injected", false);
        return finish();
      }
      const afterRevocation = await store.readSucceededPerAccountAfter(prefixes, revocationFiredAt);
      const revokedStopped = perAccount
        .filter((state) => state.accountStatus === "REVOKED")
        .every((state) => (afterRevocation.find((entry) => entry.accountId === state.accountId)?.succeededAfter ?? 0) === 0);
      const survivorsContinued = perAccount
        .filter((state) => state.accountStatus !== "REVOKED")
        .every((state) => (afterRevocation.find((entry) => entry.accountId === state.accountId)?.succeededAfter ?? 0) >= 1);
      if (!gate("post_revocation_isolation", revokedStopped && survivorsContinued)) return finish();
    }

    if (interruptsFiredAt.length > 0) {
      const lastInterruptIso = interruptsFiredAt[interruptsFiredAt.length - 1]!;
      const afterInterrupt = await store.readSucceededAfter(commandPrefix, lastInterruptIso);
      if (!gate("interruption_recovery", afterInterrupt >= 1)) {
        return finish();
      }
    }

    if (soak.expectedAccounts > revokedAccounts) {
      const afterHealth = await store.readSucceededPerAccountAfter(prefixes, healthBurstIso);
      const survivors = perAccount.filter((state) => state.accountStatus !== "REVOKED");
      const everySurvivorHealthy = survivors.every((state) =>
        (afterHealth.find((entry) => entry.accountId === state.accountId)?.succeededAfter ?? 0) >= 1);
      if (!gate("health_actions_completed", healthBurstEnqueued && everySurvivorHealthy)) return finish();
    }

    if (!gate("leases_released", finalCounts.activeLeases === 0)) return finish();
    if (!gate("engine_cleanup_clean", engineCleanupErrorCodes.length === 0 && supervisorRunnerFailures === 0)) return finish();
    gate("soak_completed_without_error", true);

    emit(soakSample(0, accounts.length, "sends_succeeded_total", sendLatency.sendsSucceeded, "count"));
    emit(soakSample(0, accounts.length, "send_latency_p50_ms", sendLatency.latencyP50Milliseconds, "ms"));
    emit(soakSample(0, accounts.length, "send_latency_p95_ms", sendLatency.latencyP95Milliseconds, "ms"));
    emit(soakSample(0, accounts.length, "send_latency_max_ms", sendLatency.latencyMaxMilliseconds, "ms"));
    emit(soakSample(0, accounts.length, "rss_peak_bytes_total", rssPeakBytes, "bytes"));
    emit(soakSample(0, accounts.length, "event_loop_delay_p99_max_ms", eventLoopP99MaximumMilliseconds, "ms"));
    emit(soakSample(0, accounts.length, "cpu_percent_one_core_average", cpuSamples === 0 ? 0 : cpuPercentSum / cpuSamples, "percent"));
    emit(soakSample(0, accounts.length, "soak_elapsed_ms", now() - startedAt, "ms"));
    return finish();
  } catch {
    passed = false;
    try { emit(soakAssertion("soak_completed_without_error", false)); } catch { /* emission must not mask the failure */ }
    return finish();
  } finally {
    await finish().catch(() => undefined);
    if (ownedSql && sql !== null) { try { await sql.end({ timeout: 5 }); } catch { /* closing must not mask the outcome */ } }
  }
}
