import type { AccountSupervisorPolicy } from "../account-supervisor/contracts.ts";

const COMMIT = /^[0-9a-f]{7,40}$/i;

export type SupervisorLoadCase = Readonly<{
  accounts: number;
  concurrency: number;
}>;

export type SupervisorLoadBasePolicy = Readonly<Omit<AccountSupervisorPolicy, "maxConcurrentAccounts">>;

export type SupervisorLoadBenchmarkConfig = Readonly<{
  commit: string;
  cases: readonly SupervisorLoadCase[];
  samples: number;
  warmupSamples: number;
  runnerLatencyMilliseconds: number;
  monitorSampleIntervalMilliseconds: number;
  sampleTimeoutMilliseconds: number;
  supervisorPolicy: SupervisorLoadBasePolicy;
}>;

export type BenchmarkMetadataRecord = Readonly<{
  type: "metadata";
  candidate: "production-teleproto-supervisor";
  benchmarkVersion: "f5.7a-v1";
  scope: "SUPERVISOR_ONLY_SYNTHETIC";
  runtime: "node";
  runtimeVersion: string;
  platform: string;
  architecture: string;
  cpuModel: string;
  logicalCpuCount: number;
  totalMemoryBytes: number;
  commit: string;
  workload: Readonly<{
    cases: readonly SupervisorLoadCase[];
    samples: number;
    warmupSamples: number;
    runnerLatencyMilliseconds: number;
    monitorSampleIntervalMilliseconds: number;
    sampleTimeoutMilliseconds: number;
    supervisorPolicy: SupervisorLoadBasePolicy;
  }>;
}>;

export type BenchmarkAssertionRecord = Readonly<{
  type: "assertion";
  candidate: "production-teleproto-supervisor";
  scenario: string;
  sampleIndex: number;
  name: string;
  passed: boolean;
  hardGate: true;
}>;

export type BenchmarkSampleRecord = Readonly<{
  type: "sample";
  candidate: "production-teleproto-supervisor";
  scenario: string;
  sessions: number;
  sampleIndex: number;
  metric: string;
  value: number;
  unit: string;
}>;

export type SupervisorLoadBenchmarkRecord =
  | BenchmarkMetadataRecord
  | BenchmarkAssertionRecord
  | BenchmarkSampleRecord;

export class SupervisorLoadBenchmarkConfigError extends Error {
  readonly code = "BENCHMARK_CONFIG_INVALID";
  readonly field: string;

  constructor(field: string) {
    super(`BENCHMARK_CONFIG_INVALID:${field}`);
    this.name = "SupervisorLoadBenchmarkConfigError";
    this.field = field;
  }

  publicData(): Readonly<{ code: "BENCHMARK_CONFIG_INVALID"; field: string }> {
    return Object.freeze({ code: this.code, field: this.field });
  }
}

function integer(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new SupervisorLoadBenchmarkConfigError(field);
  }
  return value;
}

export function validateSupervisorLoadBenchmarkConfig(input: SupervisorLoadBenchmarkConfig): SupervisorLoadBenchmarkConfig {
  if (!COMMIT.test(input.commit)) throw new SupervisorLoadBenchmarkConfigError("commit");
  if (!Array.isArray(input.cases) || input.cases.length < 1 || input.cases.length > 100) {
    throw new SupervisorLoadBenchmarkConfigError("cases");
  }
  const caseKeys = new Set<string>();
  const cases = input.cases.map((item, index) => {
    const accounts = integer(item.accounts, `cases.${index}.accounts`, 1, 10_000);
    const concurrency = integer(item.concurrency, `cases.${index}.concurrency`, 1, 1_000);
    if (concurrency > accounts) throw new SupervisorLoadBenchmarkConfigError(`cases.${index}.concurrency`);
    const key = `${accounts}:${concurrency}`;
    if (caseKeys.has(key)) throw new SupervisorLoadBenchmarkConfigError("cases");
    caseKeys.add(key);
    return Object.freeze({ accounts, concurrency });
  });
  const policy = input.supervisorPolicy;
  const supervisorPolicy = Object.freeze({
    discoveryBatchSize: integer(policy.discoveryBatchSize, "supervisorPolicy.discoveryBatchSize", 1, 1_000),
    reconciliationIntervalMilliseconds: integer(policy.reconciliationIntervalMilliseconds, "supervisorPolicy.reconciliationIntervalMilliseconds", 10, 3_600_000),
    subscriptionRetryMilliseconds: integer(policy.subscriptionRetryMilliseconds, "supervisorPolicy.subscriptionRetryMilliseconds", 10, 3_600_000),
    contendedAccountRetryMilliseconds: integer(policy.contendedAccountRetryMilliseconds, "supervisorPolicy.contendedAccountRetryMilliseconds", 10, 3_600_000),
    failedAccountRetryMilliseconds: integer(policy.failedAccountRetryMilliseconds, "supervisorPolicy.failedAccountRetryMilliseconds", 10, 3_600_000),
  });
  return Object.freeze({
    commit: input.commit.toLowerCase(),
    cases: Object.freeze(cases),
    samples: integer(input.samples, "samples", 1, 1_000),
    warmupSamples: integer(input.warmupSamples, "warmupSamples", 0, 100),
    runnerLatencyMilliseconds: integer(input.runnerLatencyMilliseconds, "runnerLatencyMilliseconds", 0, 120_000),
    monitorSampleIntervalMilliseconds: integer(input.monitorSampleIntervalMilliseconds, "monitorSampleIntervalMilliseconds", 1, 1_000),
    sampleTimeoutMilliseconds: integer(input.sampleTimeoutMilliseconds, "sampleTimeoutMilliseconds", 1, 3_600_000),
    supervisorPolicy,
  });
}
