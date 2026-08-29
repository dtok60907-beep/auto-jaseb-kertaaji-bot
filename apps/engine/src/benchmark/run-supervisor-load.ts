import { pathToFileURL } from "node:url";

import {
  SupervisorLoadBenchmarkConfigError,
  type SupervisorLoadBenchmarkConfig,
  type SupervisorLoadCase,
} from "./contracts.ts";
import { runSupervisorLoadBenchmark } from "./supervisor-load.ts";

const REQUIRED = Object.freeze([
  "cases",
  "samples",
  "warmup",
  "runner-latency-ms",
  "monitor-interval-ms",
  "timeout-ms",
  "discovery-batch-size",
  "reconciliation-ms",
  "subscription-retry-ms",
  "contended-retry-ms",
  "failed-retry-ms",
  "commit",
]);

const USAGE = `usage: npm run benchmark:supervisor -- \\
  --cases 1:1,10:2,50:5 --samples N --warmup N \\
  --runner-latency-ms N --monitor-interval-ms N --timeout-ms N \\
  --discovery-batch-size N --reconciliation-ms N \\
  --subscription-retry-ms N --contended-retry-ms N --failed-retry-ms N \\
  --commit GIT_SHA`;

function fail(field: string): never { throw new SupervisorLoadBenchmarkConfigError(field); }

function integer(values: ReadonlyMap<string, string>, field: string, minimum: number, maximum: number): number {
  const value = values.get(field);
  if (!value || !/^(0|[1-9][0-9]*)$/.test(value)) fail(field);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) fail(field);
  return parsed;
}

function cases(value: string | undefined): readonly SupervisorLoadCase[] {
  if (!value) fail("cases");
  return Object.freeze(value.split(",").map((item, index) => {
    const match = /^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/.exec(item);
    if (!match) fail(`cases.${index}`);
    return Object.freeze({ accounts: Number(match[1]), concurrency: Number(match[2]) });
  }));
}

export function parseSupervisorLoadArguments(argv: readonly string[]): SupervisorLoadBenchmarkConfig {
  const values = new Map<string, string>();
  if (argv.length % 2 !== 0) fail("arguments");
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]!;
    const value = argv[index + 1]!;
    if (!flag.startsWith("--") || flag.length < 3) fail("arguments");
    const name = flag.slice(2);
    if (!REQUIRED.includes(name) || values.has(name) || !value || value.startsWith("--")) fail(name);
    values.set(name, value);
  }
  for (const field of REQUIRED) if (!values.has(field)) fail(field);
  return Object.freeze({
    commit: values.get("commit")!,
    cases: cases(values.get("cases")),
    samples: integer(values, "samples", 1, 1_000),
    warmupSamples: integer(values, "warmup", 0, 100),
    runnerLatencyMilliseconds: integer(values, "runner-latency-ms", 0, 120_000),
    monitorSampleIntervalMilliseconds: integer(values, "monitor-interval-ms", 1, 1_000),
    sampleTimeoutMilliseconds: integer(values, "timeout-ms", 1, 3_600_000),
    supervisorPolicy: Object.freeze({
      discoveryBatchSize: integer(values, "discovery-batch-size", 1, 1_000),
      reconciliationIntervalMilliseconds: integer(values, "reconciliation-ms", 10, 3_600_000),
      subscriptionRetryMilliseconds: integer(values, "subscription-retry-ms", 10, 3_600_000),
      contendedAccountRetryMilliseconds: integer(values, "contended-retry-ms", 10, 3_600_000),
      failedAccountRetryMilliseconds: integer(values, "failed-retry-ms", 10, 3_600_000),
    }),
  });
}

export async function runSupervisorLoadCli(input: Readonly<{
  argv: readonly string[];
  stdout: (value: string) => void;
  stderr: (value: string) => void;
}>): Promise<0 | 1 | 2> {
  if (input.argv.length === 1 && input.argv[0] === "--help") {
    input.stdout(`${USAGE}\n`);
    return 0;
  }
  try {
    const result = await runSupervisorLoadBenchmark(parseSupervisorLoadArguments(input.argv));
    input.stdout(`${result.records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    return result.passed ? 0 : 1;
  } catch (error) {
    if (error instanceof SupervisorLoadBenchmarkConfigError) {
      input.stderr(`${JSON.stringify(error.publicData())}\n`);
    } else {
      input.stderr(`${JSON.stringify({ code: "BENCHMARK_RUN_FAILED" })}\n`);
    }
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runSupervisorLoadCli({
    argv: process.argv.slice(2),
    stdout: (value) => { process.stdout.write(value); },
    stderr: (value) => { process.stderr.write(value); },
  }).then((exitCode) => { process.exitCode = exitCode; });
}
