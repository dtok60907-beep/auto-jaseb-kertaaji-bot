import { cpus, totalmem } from "node:os";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

import type { AccountRunnerResult } from "../account-runner/contracts.ts";
import type { AccountSupervisorHandle, AccountSupervisorSummary } from "../account-supervisor/contracts.ts";
import { startBroadcastShardSupervisor } from "../account-supervisor/service.ts";
import type {
  BroadcastRuntimeAccount,
  BroadcastRuntimeAccountRepository,
  RuntimeWakeupListener,
} from "../runtime-accounts/repository.ts";
import {
  validateSupervisorLoadBenchmarkConfig,
  type BenchmarkAssertionRecord,
  type BenchmarkMetadataRecord,
  type BenchmarkSampleRecord,
  type SupervisorLoadBenchmarkConfig,
  type SupervisorLoadBenchmarkRecord,
  type SupervisorLoadCase,
} from "./contracts.ts";

const CANDIDATE = "production-teleproto-supervisor" as const;
const SHARD = Object.freeze({ shardCount: 1, shardIndex: 0 });

const pause = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! * (upper - position) + sorted[upper]! * (position - lower);
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function account(index: number): BroadcastRuntimeAccount {
  return Object.freeze({
    accountId: `00000000-0000-0000-0000-${(index + 1).toString(16).padStart(12, "0")}`,
    accountType: index % 2 === 0 ? "USERBOT" : "JASEB_WORKER",
    nextDueAt: new Date(0).toISOString(),
    hasPreparationWork: false,
    hasDeliveryWork: true,
    requiresRecovery: false,
  });
}

function runnerResult(accountId: string): AccountRunnerResult {
  return Object.freeze({
    accountId,
    status: "DRAINED",
    actions: 1,
    errorCode: null,
    disconnected: true,
    leaseReleased: true,
    cleanupErrorCodes: Object.freeze([]),
  });
}

class SyntheticDiscoveryRepository implements Pick<
  BroadcastRuntimeAccountRepository,
  "listDue" | "findNext" | "subscribeWakeups"
> {
  readonly #remaining: Map<string, BroadcastRuntimeAccount>;
  #listener: RuntimeWakeupListener | null = null;
  listCalls = 0;
  findCalls = 0;
  closeCalls = 0;

  constructor(accounts: readonly BroadcastRuntimeAccount[]) {
    this.#remaining = new Map(accounts.map((item) => [item.accountId, item]));
  }

  async listDue(input: Parameters<BroadcastRuntimeAccountRepository["listDue"]>[0]) {
    this.listCalls += 1;
    return Object.freeze([...this.#remaining.values()].slice(0, input.limit));
  }

  async findNext() {
    this.findCalls += 1;
    return this.#remaining.values().next().value ?? null;
  }

  async subscribeWakeups(listener: RuntimeWakeupListener) {
    this.#listener = listener;
    return Object.freeze({ close: async () => {
      this.closeCalls += 1;
      this.#listener = null;
    } });
  }

  complete(accountId: string): void { this.#remaining.delete(accountId); }
}

type SampleResult = Readonly<{
  records: readonly (BenchmarkAssertionRecord | BenchmarkSampleRecord)[];
  passed: boolean;
}>;

function assertion(
  scenario: string,
  sampleIndex: number,
  name: string,
  passed: boolean,
): BenchmarkAssertionRecord {
  return Object.freeze({ type: "assertion", candidate: CANDIDATE, scenario, sampleIndex, name, passed, hardGate: true });
}

function sample(
  scenario: string,
  sessions: number,
  sampleIndex: number,
  metric: string,
  value: number,
  unit: string,
): BenchmarkSampleRecord {
  return Object.freeze({ type: "sample", candidate: CANDIDATE, scenario, sessions, sampleIndex, metric, value: finite(value), unit });
}

async function runSample(
  config: SupervisorLoadBenchmarkConfig,
  benchmarkCase: SupervisorLoadCase,
  sampleIndex: number,
): Promise<SampleResult> {
  const scenario = `supervisor-load-c${benchmarkCase.concurrency}`;
  const repository = new SyntheticDiscoveryRepository(
    Array.from({ length: benchmarkCase.accounts }, (_value, index) => account(index)),
  );
  const calls = new Map<string, number>();
  const runnerLatencies: number[] = [];
  let active = 0;
  let observedPeakConcurrency = 0;
  let completed = 0;
  let resolveCompletion!: () => void;
  const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });

  const rssBefore = process.memoryUsage().rss;
  const heapBefore = process.memoryUsage().heapUsed;
  let rssPeak = rssBefore;
  const histogram = monitorEventLoopDelay({ resolution: config.monitorSampleIntervalMilliseconds });
  histogram.enable();
  const memoryTimer = setInterval(() => {
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  }, config.monitorSampleIntervalMilliseconds);
  memoryTimer.unref();
  const cpuBefore = process.cpuUsage();
  const startedAt = performance.now();
  let handle: AccountSupervisorHandle | null = null;
  let summary: AccountSupervisorSummary | null = null;
  let timedOut = false;
  let drainDurationMilliseconds = 0;

  try {
    handle = await startBroadcastShardSupervisor({
      runtimeAccounts: repository,
      async runAccount(selected) {
        const runnerStartedAt = performance.now();
        calls.set(selected.accountId, (calls.get(selected.accountId) ?? 0) + 1);
        active += 1;
        observedPeakConcurrency = Math.max(observedPeakConcurrency, active);
        await pause(config.runnerLatencyMilliseconds);
        repository.complete(selected.accountId);
        active -= 1;
        runnerLatencies.push(performance.now() - runnerStartedAt);
        completed += 1;
        if (completed === benchmarkCase.accounts) resolveCompletion();
        return runnerResult(selected.accountId);
      },
    }, {
      shard: SHARD,
      policy: Object.freeze({
        ...config.supervisorPolicy,
        maxConcurrentAccounts: benchmarkCase.concurrency,
      }),
    });

    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        completion,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("BENCHMARK_SAMPLE_TIMEOUT")), config.sampleTimeoutMilliseconds);
        }),
      ]);
    } catch {
      timedOut = true;
    } finally {
      if (timeout !== null) clearTimeout(timeout);
    }
    const drainStartedAt = performance.now();
    summary = await handle.stop();
    drainDurationMilliseconds = performance.now() - drainStartedAt;
  } finally {
    if (handle && !summary) {
      const drainStartedAt = performance.now();
      try { summary = await handle.stop(); }
      catch { /* assertions below mark an incomplete summary */ }
      drainDurationMilliseconds = performance.now() - drainStartedAt;
    }
    clearInterval(memoryTimer);
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
    histogram.disable();
  }

  const elapsedMilliseconds = performance.now() - startedAt;
  const cpu = process.cpuUsage(cpuBefore);
  const cpuPercentOneCore = elapsedMilliseconds > 0
    ? ((cpu.user + cpu.system) / (elapsedMilliseconds * 1_000)) * 100
    : 0;
  const rssAfter = process.memoryUsage().rss;
  const heapAfter = process.memoryUsage().heapUsed;
  const uniqueExecutions = calls.size;
  const duplicateExecutions = [...calls.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
  const eventLoss = Math.max(0, benchmarkCase.accounts - uniqueExecutions);
  const stoppedCleanly = summary?.state === "STOPPED"
    && summary.inFlightAccounts === 0
    && summary.pendingAccounts === 0;
  const cleanupErrors = summary?.cleanupErrorCodes.length ?? 1;
  const runnerFailures = summary?.runnerFailures ?? 1;
  const runsCompleted = summary?.runsCompleted ?? 0;
  const assertions = Object.freeze([
    assertion(scenario, sampleIndex, "sample_completed_before_timeout", !timedOut),
    assertion(scenario, sampleIndex, "event_loss_zero", eventLoss === 0),
    assertion(scenario, sampleIndex, "duplicate_execution_zero", duplicateExecutions === 0),
    assertion(scenario, sampleIndex, "runner_failures_zero", runnerFailures === 0),
    assertion(scenario, sampleIndex, "concurrency_within_limit", observedPeakConcurrency <= benchmarkCase.concurrency),
    assertion(scenario, sampleIndex, "all_runs_completed", runsCompleted === benchmarkCase.accounts),
    assertion(scenario, sampleIndex, "drain_complete", stoppedCleanly),
    assertion(scenario, sampleIndex, "cleanup_errors_zero", cleanupErrors === 0),
  ]);
  const metrics = Object.freeze([
    sample(scenario, benchmarkCase.accounts, sampleIndex, "total_duration", elapsedMilliseconds, "ms"),
    sample(scenario, benchmarkCase.accounts, sampleIndex, "throughput", runsCompleted / Math.max(elapsedMilliseconds / 1_000, Number.EPSILON), "account_runs_per_second"),
    sample(scenario, benchmarkCase.accounts, sampleIndex, "cpu", cpuPercentOneCore, "percent_one_core"),
    sample(scenario, benchmarkCase.accounts, sampleIndex, "rss_baseline", rssBefore, "bytes"),
    sample(scenario, benchmarkCase.accounts, sampleIndex, "rss_peak", rssPeak, "bytes"),
    sample(scenario, benchmarkCase.accounts, sampleIndex, "rss_delta", rssAfter - rssBefore, "bytes"),
    sample(scenario, benchmarkCase.accounts, sampleIndex, "heap_used_delta", heapAfter - heapBefore, "bytes"),
    sample(scenario, benchmarkCase.accounts, sampleIndex, "event_loop_delay_p50", histogram.percentile(50) / 1_000_000, "ms"),
    sample(scenario, benchmarkCase.accounts, sampleIndex, "event_loop_delay_p95", histogram.percentile(95) / 1_000_000, "ms"),
    sample(scenario, benchmarkCase.accounts, sampleIndex, "event_loop_delay_p99", histogram.percentile(99) / 1_000_000, "ms"),
    sample(scenario, benchmarkCase.accounts, sampleIndex, "runner_latency_p50", percentile(runnerLatencies, 0.5), "ms"),
    sample(scenario, benchmarkCase.accounts, sampleIndex, "runner_latency_p95", percentile(runnerLatencies, 0.95), "ms"),
    sample(scenario, benchmarkCase.accounts, sampleIndex, "runner_latency_p99", percentile(runnerLatencies, 0.99), "ms"),
    sample(scenario, benchmarkCase.accounts, sampleIndex, "peak_concurrency", observedPeakConcurrency, "count"),
    sample(scenario, benchmarkCase.accounts, sampleIndex, "drain_duration", drainDurationMilliseconds, "ms"),
    sample(scenario, benchmarkCase.accounts, sampleIndex, "discovery_list_calls", repository.listCalls, "count"),
    sample(scenario, benchmarkCase.accounts, sampleIndex, "discovery_find_calls", repository.findCalls, "count"),
    sample(scenario, benchmarkCase.accounts, sampleIndex, "event_loss", eventLoss, "count"),
    sample(scenario, benchmarkCase.accounts, sampleIndex, "duplicate_side_effect", duplicateExecutions, "count"),
  ]);
  return Object.freeze({
    records: Object.freeze([...assertions, ...metrics]),
    passed: assertions.every((item) => item.passed),
  });
}

function metadata(config: SupervisorLoadBenchmarkConfig): BenchmarkMetadataRecord {
  const processors = cpus();
  return Object.freeze({
    type: "metadata",
    candidate: CANDIDATE,
    benchmarkVersion: "f5.7a-v1",
    scope: "SUPERVISOR_ONLY_SYNTHETIC",
    runtime: "node",
    runtimeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    cpuModel: processors[0]?.model ?? "unknown",
    logicalCpuCount: processors.length,
    totalMemoryBytes: totalmem(),
    commit: config.commit,
    workload: Object.freeze({
      cases: config.cases,
      samples: config.samples,
      warmupSamples: config.warmupSamples,
      runnerLatencyMilliseconds: config.runnerLatencyMilliseconds,
      monitorSampleIntervalMilliseconds: config.monitorSampleIntervalMilliseconds,
      sampleTimeoutMilliseconds: config.sampleTimeoutMilliseconds,
      supervisorPolicy: config.supervisorPolicy,
    }),
  });
}

export async function runSupervisorLoadBenchmark(
  rawConfig: SupervisorLoadBenchmarkConfig,
): Promise<Readonly<{ records: readonly SupervisorLoadBenchmarkRecord[]; passed: boolean }>> {
  const config = validateSupervisorLoadBenchmarkConfig(rawConfig);
  const records: SupervisorLoadBenchmarkRecord[] = [metadata(config)];
  let passed = true;
  for (const benchmarkCase of config.cases) {
    for (let warmup = 0; warmup < config.warmupSamples; warmup += 1) {
      const result = await runSample(config, benchmarkCase, -(warmup + 1));
      if (!result.passed) {
        records.push(...result.records.filter((record) => record.type === "assertion"));
        return Object.freeze({ records: Object.freeze(records), passed: false });
      }
    }
    for (let sampleIndex = 1; sampleIndex <= config.samples; sampleIndex += 1) {
      const result = await runSample(config, benchmarkCase, sampleIndex);
      records.push(...result.records);
      passed = passed && result.passed;
      if (!result.passed) return Object.freeze({ records: Object.freeze(records), passed: false });
    }
  }
  return Object.freeze({ records: Object.freeze(records), passed });
}
