import { randomUUID } from "node:crypto";
import { cpus, totalmem } from "node:os";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

import postgres, { type Sql } from "postgres";

import { telegramDeliveryReceipt, type TelegramDeliveryAdapter } from "../../../../packages/telegram-contract/src/index.ts";
import { PostgresBroadcastExecutorRepository } from "../broadcast-executor/postgres-repository.ts";
import { executeNextBroadcast } from "../broadcast-executor/service.ts";
import { PostgresRuntimeAccountLeaseRepository } from "../runtime-leases/postgres-repository.ts";

const CANDIDATE = "production-postgres-runtime";
const COMMIT = /^[0-9a-f]{7,40}$/i;

export type PostgresLoadCase = Readonly<{ accounts: number; concurrency: number }>;
export type PostgresLoadConfig = Readonly<{
  databaseUrl: string;
  commit: string;
  cases: readonly PostgresLoadCase[];
  samples: number;
  warmupSamples: number;
  databaseMaxConnections: number;
  databaseConnectTimeoutSeconds: number;
  providerLatencyMilliseconds: number;
  monitorIntervalMilliseconds: number;
  sampleTimeoutMilliseconds: number;
  accountLeaseSeconds: number;
  commandLeaseSeconds: number;
}>;

export class PostgresLoadConfigError extends Error {
  readonly code = "POSTGRES_LOAD_CONFIG_INVALID";
  readonly field: string;
  constructor(field: string) {
    super(`POSTGRES_LOAD_CONFIG_INVALID:${field}`);
    this.field = field;
  }

  publicData(): Readonly<{ code: "POSTGRES_LOAD_CONFIG_INVALID"; field: string }> {
    return Object.freeze({ code: this.code, field: this.field });
  }
}

function integer(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new PostgresLoadConfigError(field);
  return value;
}

export function validatePostgresLoadConfig(input: PostgresLoadConfig): PostgresLoadConfig {
  if (!input.databaseUrl.trim()) throw new PostgresLoadConfigError("databaseUrl");
  if (!COMMIT.test(input.commit)) throw new PostgresLoadConfigError("commit");
  if (!Array.isArray(input.cases) || input.cases.length < 1 || input.cases.length > 50) throw new PostgresLoadConfigError("cases");
  const seen = new Set<string>();
  const cases = input.cases.map((item, index) => {
    const accounts = integer(item.accounts, `cases.${index}.accounts`, 1, 1_000);
    const concurrency = integer(item.concurrency, `cases.${index}.concurrency`, 1, 200);
    if (concurrency > accounts) throw new PostgresLoadConfigError(`cases.${index}.concurrency`);
    const key = `${accounts}:${concurrency}`;
    if (seen.has(key)) throw new PostgresLoadConfigError("cases");
    seen.add(key);
    return Object.freeze({ accounts, concurrency });
  });
  return Object.freeze({
    ...input,
    databaseUrl: input.databaseUrl.trim(),
    commit: input.commit.toLowerCase(),
    cases: Object.freeze(cases),
    samples: integer(input.samples, "samples", 1, 100),
    warmupSamples: integer(input.warmupSamples, "warmupSamples", 0, 20),
    databaseMaxConnections: integer(input.databaseMaxConnections, "databaseMaxConnections", 1, 100),
    databaseConnectTimeoutSeconds: integer(input.databaseConnectTimeoutSeconds, "databaseConnectTimeoutSeconds", 1, 120),
    providerLatencyMilliseconds: integer(input.providerLatencyMilliseconds, "providerLatencyMilliseconds", 0, 120_000),
    monitorIntervalMilliseconds: integer(input.monitorIntervalMilliseconds, "monitorIntervalMilliseconds", 1, 1_000),
    sampleTimeoutMilliseconds: integer(input.sampleTimeoutMilliseconds, "sampleTimeoutMilliseconds", 1, 3_600_000),
    accountLeaseSeconds: integer(input.accountLeaseSeconds, "accountLeaseSeconds", 5, 3_600),
    commandLeaseSeconds: integer(input.commandLeaseSeconds, "commandLeaseSeconds", 5, 3_600),
  });
}

type Fixture = Readonly<{ userIds: readonly string[]; accountIds: readonly string[] }>;

async function seedFixture(sql: Sql, accounts: number): Promise<Fixture> {
  const userIds = Array.from({ length: accounts }, () => randomUUID());
  const accountIds = Array.from({ length: accounts }, () => randomUUID());
  const operationIds = Array.from({ length: accounts }, () => randomUUID());
  const targetIds = Array.from({ length: accounts }, () => randomUUID());
  const commandIds = Array.from({ length: accounts }, () => randomUUID());
  const targetRefs = accountIds.map((_id, index) => `@f57b_load_${index}`);
  const operationKeys = operationIds.map((id) => `f57b-load-operation-${id}`);
  const commandKeys = commandIds.map((id) => `f57b-load-command-${id}`);

  await sql.begin(async (transaction) => {
    await transaction`
      insert into auth.users (id)
      select user_id from unnest(${transaction.array(userIds)}::uuid[]) fixture(user_id)
    `;
    await transaction`
      insert into public.entitlements (
        user_id, package_snapshot, status, starts_at, expires_at,
        max_lpm_groups, max_channel_targets
      )
      select user_id,
             ${transaction.json({ packageId: "f57b-load", packageType: "JASEB_WORKER", features: ["JASEB"], maxTargetsPerMinute: 1, maxAccounts: 1, intervalMinSeconds: 0, intervalMaxSeconds: 3600 })},
             'ACTIVE', now() - interval '1 minute', now() + interval '1 day', 1, 0
        from unnest(${transaction.array(userIds)}::uuid[]) fixture(user_id)
    `;
    await transaction`
      insert into public.telegram_accounts (
        id, owner_user_id, account_type, label, encrypted_session,
        encryption_key_version, status
      )
      select account_id, null, 'JASEB_WORKER', 'F5.7b load ' || ordinality,
             decode('00', 'hex'), 1, 'READY'
        from unnest(${transaction.array(accountIds)}::uuid[]) with ordinality fixture(account_id, ordinality)
    `;
    await transaction`
      insert into public.workflow_operations (
        id, user_id, account_id, operation_type, status, idempotency_key, payload
      )
      select operation_id, user_id, account_id, 'BROADCAST', 'READY', operation_key,
             ${transaction.json({ accountMode: "JASEB_WORKER", material: { kind: "TEXT", text: "fixture" } })}
        from unnest(
          ${transaction.array(operationIds)}::uuid[],
          ${transaction.array(userIds)}::uuid[],
          ${transaction.array(accountIds)}::uuid[],
          ${transaction.array(operationKeys)}::text[]
        ) fixture(operation_id, user_id, account_id, operation_key)
    `;
    await transaction`
      insert into public.worker_assignments (operation_id, worker_account_id, user_id, status)
      select operation_id, account_id, user_id, 'ACTIVE'
        from unnest(
          ${transaction.array(operationIds)}::uuid[],
          ${transaction.array(accountIds)}::uuid[],
          ${transaction.array(userIds)}::uuid[]
        ) fixture(operation_id, account_id, user_id)
    `;
    await transaction`
      insert into public.broadcast_targets (
        id, operation_id, telegram_target_ref, interval_seconds,
        sequence_number, preparation_status
      )
      select target_id, operation_id, target_ref, 0, 1, 'READY'
        from unnest(
          ${transaction.array(targetIds)}::uuid[],
          ${transaction.array(operationIds)}::uuid[],
          ${transaction.array(targetRefs)}::text[]
        ) fixture(target_id, operation_id, target_ref)
    `;
    await transaction`
      insert into public.workflow_commands (
        id, operation_id, account_id, kind, target_id, idempotency_key,
        payload, broadcast_target_id
      )
      select command_id, operation_id, account_id, 'SEND_TEXT', target_ref, command_key,
             ${transaction.json({ material: { kind: "TEXT", text: "fixture" } })}, target_id
        from unnest(
          ${transaction.array(commandIds)}::uuid[],
          ${transaction.array(operationIds)}::uuid[],
          ${transaction.array(accountIds)}::uuid[],
          ${transaction.array(targetRefs)}::text[],
          ${transaction.array(commandKeys)}::text[],
          ${transaction.array(targetIds)}::uuid[]
        ) fixture(command_id, operation_id, account_id, target_ref, command_key, target_id)
    `;
  });
  return Object.freeze({ userIds: Object.freeze(userIds), accountIds: Object.freeze(accountIds) });
}

async function cleanupFixture(sql: Sql, fixture: Fixture): Promise<void> {
  await sql.begin(async (transaction) => {
    await transaction`delete from public.workflow_operations where user_id = any(${transaction.array([...fixture.userIds])}::uuid[])`;
    await transaction`delete from public.telegram_accounts where id = any(${transaction.array([...fixture.accountIds])}::uuid[])`;
    await transaction`delete from auth.users where id = any(${transaction.array([...fixture.userIds])}::uuid[])`;
  });
}

const pause = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function assertion(scenario: string, sampleIndex: number, name: string, passed: boolean) {
  return Object.freeze({ type: "assertion", candidate: CANDIDATE, scenario, sampleIndex, name, passed, hardGate: true });
}

function sample(scenario: string, sessions: number, sampleIndex: number, metric: string, value: number, unit: string) {
  return Object.freeze({ type: "sample", candidate: CANDIDATE, scenario, sessions, sampleIndex, metric, value: Number.isFinite(value) ? value : 0, unit });
}

async function executeFixture(
  sql: Sql,
  config: PostgresLoadConfig,
  loadCase: PostgresLoadCase,
  sampleIndex: number,
  scenario: string,
  fixture: Fixture,
  setupMilliseconds: number,
) {
  const executor = new PostgresBroadcastExecutorRepository(sql);
  const leases = new PostgresRuntimeAccountLeaseRepository(sql);
  const leaseOwner = randomUUID();
  const sends = new Map<string, number>();
  const adapter: TelegramDeliveryAdapter = {
    state: "READY",
    async connect() {}, async disconnect() {},
    async resolveTarget(): Promise<never> { throw new Error("unused"); },
    async resolveLinkedDiscussion(): Promise<never> { throw new Error("unused"); },
    async joinPublicTarget(): Promise<never> { throw new Error("unused"); },
    async forwardNative(): Promise<never> { throw new Error("unused"); },
    async sendText(input) {
      sends.set(input.targetRef, (sends.get(input.targetRef) ?? 0) + 1);
      if (config.providerLatencyMilliseconds > 0) await pause(config.providerLatencyMilliseconds);
      return telegramDeliveryReceipt([`fake-${sends.size}`], new Date().toISOString());
    },
  };
  const results: string[] = [];
  let nextIndex = 0;
  let timedOut = false;
  let executionError = false;
  let releaseFailures = 0;
  const rssBefore = process.memoryUsage().rss;
  const heapBefore = process.memoryUsage().heapUsed;
  let rssPeak = rssBefore;
  const histogram = monitorEventLoopDelay({ resolution: config.monitorIntervalMilliseconds });
  histogram.enable();
  const memoryTimer = setInterval(() => { rssPeak = Math.max(rssPeak, process.memoryUsage().rss); }, config.monitorIntervalMilliseconds);
  memoryTimer.unref();
  const cpuBefore = process.cpuUsage();
  const startedAt = performance.now();
  const work = Promise.all(Array.from({ length: loadCase.concurrency }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= fixture.accountIds.length) return;
      const accountId = fixture.accountIds[index]!;
      const acquired = await leases.acquire({ accountId, leaseOwner, leaseSeconds: config.accountLeaseSeconds });
      if (acquired.status === "HELD_BY_OTHER") { results[index] = "LEASE_CONTENDED"; continue; }
      try {
        const result = await executeNextBroadcast(adapter, executor, {
          accountId,
          leaseOwner,
          fencingToken: acquired.lease.fencingToken,
        }, { commandLeaseSeconds: config.commandLeaseSeconds });
        results[index] = result.status;
      } finally {
        if (!await leases.release({ accountId, leaseOwner, fencingToken: acquired.lease.fencingToken })) releaseFailures += 1;
      }
    }
  }));
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("POSTGRES_LOAD_TIMEOUT")), config.sampleTimeoutMilliseconds);
      }),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message === "POSTGRES_LOAD_TIMEOUT") timedOut = true;
    else executionError = true;
  }
  finally { if (timeout !== null) clearTimeout(timeout); }
  try { await work; } catch { executionError = true; }
  const elapsedMilliseconds = performance.now() - startedAt;
  const cpu = process.cpuUsage(cpuBefore);
  clearInterval(memoryTimer);
  rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  histogram.disable();

  const [persisted] = await sql<{
    commands_succeeded: number;
    operations_succeeded: number;
    targets_succeeded: number;
    active_leases: number;
  }[]>`
    select
      count(*) filter (where command.status = 'SUCCEEDED')::int commands_succeeded,
      count(distinct operation.id) filter (where operation.status = 'SUCCEEDED')::int operations_succeeded,
      count(distinct target.id) filter (where target.delivery_status = 'SUCCEEDED')::int targets_succeeded,
      (select count(*)::int from public.account_leases lease
        where lease.account_id = any(${sql.array([...fixture.accountIds])}::uuid[])
          and lease.lease_until > now()) active_leases
      from public.workflow_operations operation
      join public.workflow_commands command on command.operation_id = operation.id
      join public.broadcast_targets target on target.operation_id = operation.id
     where operation.user_id = any(${sql.array([...fixture.userIds])}::uuid[])
  `;
  const duplicateSends = [...sends.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
  const assertions = Object.freeze([
    assertion(scenario, sampleIndex, "sample_completed_before_timeout", !timedOut),
    assertion(scenario, sampleIndex, "execution_errors_zero", !executionError),
    assertion(scenario, sampleIndex, "all_runner_results_succeeded", results.length === loadCase.accounts && results.every((value) => value === "SUCCEEDED")),
    assertion(scenario, sampleIndex, "fake_provider_calls_exact", sends.size === loadCase.accounts),
    assertion(scenario, sampleIndex, "duplicate_side_effect_zero", duplicateSends === 0),
    assertion(scenario, sampleIndex, "commands_succeeded", persisted?.commands_succeeded === loadCase.accounts),
    assertion(scenario, sampleIndex, "operations_succeeded", persisted?.operations_succeeded === loadCase.accounts),
    assertion(scenario, sampleIndex, "targets_succeeded", persisted?.targets_succeeded === loadCase.accounts),
    assertion(scenario, sampleIndex, "lease_release_calls_succeeded", releaseFailures === 0),
    assertion(scenario, sampleIndex, "leases_released", persisted?.active_leases === 0),
  ]);
  const records = [
    ...assertions,
    sample(scenario, loadCase.accounts, sampleIndex, "fixture_setup_duration", setupMilliseconds, "ms"),
    sample(scenario, loadCase.accounts, sampleIndex, "total_duration", elapsedMilliseconds, "ms"),
    sample(scenario, loadCase.accounts, sampleIndex, "throughput", loadCase.accounts / Math.max(elapsedMilliseconds / 1_000, Number.EPSILON), "commands_per_second"),
    sample(scenario, loadCase.accounts, sampleIndex, "cpu", ((cpu.user + cpu.system) / Math.max(elapsedMilliseconds * 1_000, 1)) * 100, "percent_one_core"),
    sample(scenario, loadCase.accounts, sampleIndex, "rss_baseline", rssBefore, "bytes"),
    sample(scenario, loadCase.accounts, sampleIndex, "rss_peak", rssPeak, "bytes"),
    sample(scenario, loadCase.accounts, sampleIndex, "heap_used_delta", process.memoryUsage().heapUsed - heapBefore, "bytes"),
    sample(scenario, loadCase.accounts, sampleIndex, "event_loop_delay_p95", histogram.percentile(95) / 1_000_000, "ms"),
    sample(scenario, loadCase.accounts, sampleIndex, "event_loop_delay_p99", histogram.percentile(99) / 1_000_000, "ms"),
    sample(scenario, loadCase.accounts, sampleIndex, "duplicate_side_effect", duplicateSends, "count"),
  ];
  return Object.freeze({ records, passed: assertions.every((item) => item.passed) });
}

async function runSample(sql: Sql, config: PostgresLoadConfig, loadCase: PostgresLoadCase, sampleIndex: number) {
  const scenario = `postgres-runtime-c${loadCase.concurrency}`;
  const setupStartedAt = performance.now();
  const fixture = await seedFixture(sql, loadCase.accounts);
  const setupMilliseconds = performance.now() - setupStartedAt;
  let execution: Awaited<ReturnType<typeof executeFixture>>;
  let cleanupSucceeded = true;
  let cleanupMilliseconds = 0;
  try {
    execution = await executeFixture(sql, config, loadCase, sampleIndex, scenario, fixture, setupMilliseconds);
  } finally {
    const cleanupStartedAt = performance.now();
    try { await cleanupFixture(sql, fixture); } catch { cleanupSucceeded = false; }
    cleanupMilliseconds = performance.now() - cleanupStartedAt;
  }
  const records = [
    ...execution.records,
    assertion(scenario, sampleIndex, "fixture_cleanup_succeeded", cleanupSucceeded),
    sample(scenario, loadCase.accounts, sampleIndex, "cleanup_duration", cleanupMilliseconds, "ms"),
  ];
  return Object.freeze({ records: Object.freeze(records), passed: execution.passed && cleanupSucceeded });
}

export async function runPostgresRuntimeLoad(rawConfig: PostgresLoadConfig) {
  const config = validatePostgresLoadConfig(rawConfig);
  const processors = cpus();
  const records: Record<string, unknown>[] = [Object.freeze({
    type: "metadata", candidate: CANDIDATE, benchmarkVersion: "f5.7b-v1",
    scope: "POSTGRES_LEASE_OUTBOX_FAKE_PROVIDER", runtime: "node",
    runtimeVersion: process.version, platform: process.platform, architecture: process.arch,
    cpuModel: processors[0]?.model ?? "unknown", logicalCpuCount: processors.length,
    totalMemoryBytes: totalmem(), commit: config.commit,
    workload: Object.freeze({
      cases: config.cases, samples: config.samples, warmupSamples: config.warmupSamples,
      databaseMaxConnections: config.databaseMaxConnections,
      databaseConnectTimeoutSeconds: config.databaseConnectTimeoutSeconds,
      providerLatencyMilliseconds: config.providerLatencyMilliseconds,
      monitorIntervalMilliseconds: config.monitorIntervalMilliseconds,
      sampleTimeoutMilliseconds: config.sampleTimeoutMilliseconds,
      accountLeaseSeconds: config.accountLeaseSeconds,
      commandLeaseSeconds: config.commandLeaseSeconds,
    }),
  })];
  const sql = postgres(config.databaseUrl, {
    max: config.databaseMaxConnections,
    connect_timeout: config.databaseConnectTimeoutSeconds,
    idle_timeout: 10,
    max_lifetime: 60,
    prepare: false,
  });
  let passed = true;
  try {
    for (const loadCase of config.cases) {
      for (let warmup = 1; warmup <= config.warmupSamples; warmup += 1) {
        const result = await runSample(sql, config, loadCase, -warmup);
        if (!result.passed) { records.push(...result.records.filter((record) => record.type === "assertion")); return Object.freeze({ records: Object.freeze(records), passed: false }); }
      }
      for (let index = 1; index <= config.samples; index += 1) {
        const result = await runSample(sql, config, loadCase, index);
        records.push(...result.records);
        passed = passed && result.passed;
        if (!result.passed) return Object.freeze({ records: Object.freeze(records), passed: false });
      }
    }
  } finally { await sql.end({ timeout: 5 }); }
  return Object.freeze({ records: Object.freeze(records), passed });
}
