import { pathToFileURL } from "node:url";

import {
  PostgresLoadConfigError,
  runPostgresRuntimeLoad,
  validatePostgresLoadConfig,
  type PostgresLoadCase,
  type PostgresLoadConfig,
} from "./postgres-runtime-load.ts";

const REQUIRED = Object.freeze([
  "cases",
  "samples",
  "warmup",
  "db-max-connections",
  "db-connect-timeout-seconds",
  "provider-latency-ms",
  "monitor-interval-ms",
  "timeout-ms",
  "account-lease-seconds",
  "command-lease-seconds",
  "commit",
]);

const USAGE = `usage: npm run benchmark:postgres -- \\
  --cases 1:1,10:5 --samples N --warmup N \\
  --db-max-connections N --db-connect-timeout-seconds N \\
  --provider-latency-ms N --monitor-interval-ms N --timeout-ms N \\
  --account-lease-seconds N --command-lease-seconds N --commit GIT_SHA`;

function fail(field: string): never { throw new PostgresLoadConfigError(field); }

function integer(values: ReadonlyMap<string, string>, field: string): number {
  const value = values.get(field);
  if (!value || !/^(0|[1-9][0-9]*)$/.test(value)) fail(field);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(field);
  return parsed;
}

function parseCases(value: string | undefined): readonly PostgresLoadCase[] {
  if (!value) fail("cases");
  return Object.freeze(value.split(",").map((item, index) => {
    const match = /^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/.exec(item);
    if (!match) fail(`cases.${index}`);
    return Object.freeze({ accounts: Number(match[1]), concurrency: Number(match[2]) });
  }));
}

export function parsePostgresLoadArguments(argv: readonly string[], databaseUrl: string): PostgresLoadConfig {
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
  return validatePostgresLoadConfig({
    databaseUrl,
    commit: values.get("commit")!,
    cases: parseCases(values.get("cases")),
    samples: integer(values, "samples"),
    warmupSamples: integer(values, "warmup"),
    databaseMaxConnections: integer(values, "db-max-connections"),
    databaseConnectTimeoutSeconds: integer(values, "db-connect-timeout-seconds"),
    providerLatencyMilliseconds: integer(values, "provider-latency-ms"),
    monitorIntervalMilliseconds: integer(values, "monitor-interval-ms"),
    sampleTimeoutMilliseconds: integer(values, "timeout-ms"),
    accountLeaseSeconds: integer(values, "account-lease-seconds"),
    commandLeaseSeconds: integer(values, "command-lease-seconds"),
  });
}

export async function runPostgresLoadCli(input: Readonly<{
  argv: readonly string[];
  databaseUrl: string;
  stdout: (value: string) => void;
  stderr: (value: string) => void;
}>): Promise<0 | 1 | 2> {
  if (input.argv.length === 1 && input.argv[0] === "--help") {
    input.stdout(`${USAGE}\n`);
    return 0;
  }
  try {
    const result = await runPostgresRuntimeLoad(parsePostgresLoadArguments(input.argv, input.databaseUrl));
    input.stdout(`${result.records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    return result.passed ? 0 : 1;
  } catch (error) {
    if (error instanceof PostgresLoadConfigError) input.stderr(`${JSON.stringify(error.publicData())}\n`);
    else input.stderr(`${JSON.stringify({ code: "POSTGRES_LOAD_RUN_FAILED" })}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runPostgresLoadCli({
    argv: process.argv.slice(2),
    databaseUrl: process.env.F5_DATABASE_URL ?? "",
    stdout: (value) => { process.stdout.write(value); },
    stderr: (value) => { process.stderr.write(value); },
  }).then((exitCode) => { process.exitCode = exitCode; });
}
