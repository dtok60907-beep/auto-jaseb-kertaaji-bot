import { TelegramSessionKeyRing } from "../../../../packages/telegram-session-crypto/src/index.ts";
import type { AccountRunnerPolicy } from "../account-runner/contracts.ts";
import type { AccountSupervisorPolicy } from "../account-supervisor/contracts.ts";
import { parseShardConfig, type ShardConfig } from "../runtime-sharding/shard.ts";

const INSPECT = Symbol.for("nodejs.util.inspect.custom");
const API_HASH = /^[0-9a-f]{32}$/i;

export type ProductionDatabasePolicy = Readonly<{
  maxConnections: number;
  connectTimeoutSeconds: number;
  idleTimeoutSeconds: number;
  maxLifetimeSeconds: number;
  closeTimeoutSeconds: number;
  prepareStatements: boolean;
}>;

export type ProductionHealthPolicy = Readonly<{
  host: string;
  port: number;
  readinessProbeIntervalMilliseconds: number;
  readinessProbeTimeoutMilliseconds: number;
  readinessFailureThreshold: number;
}>;

export class ProductionEngineConfigError extends Error {
  readonly code = "ENGINE_CONFIG_INVALID";
  readonly field: string;

  constructor(field: string) {
    super(`ENGINE_CONFIG_INVALID:${field}`);
    this.name = "ProductionEngineConfigError";
    this.field = field;
  }

  publicData(): Readonly<{ code: "ENGINE_CONFIG_INVALID"; field: string }> {
    return Object.freeze({ code: this.code, field: this.field });
  }

  toJSON(): ReturnType<ProductionEngineConfigError["publicData"]> {
    return this.publicData();
  }
}

function fail(field: string): never {
  throw new ProductionEngineConfigError(field);
}

function text(env: Readonly<Record<string, string | undefined>>, field: string, maximumLength = 4_096): string {
  const value = env[field];
  if (typeof value !== "string" || !value.trim() || value.length > maximumLength || /[\0\r\n]/.test(value)) fail(field);
  return value.trim();
}

function integer(
  env: Readonly<Record<string, string | undefined>>,
  field: string,
  minimum: number,
  maximum: number,
): number {
  const value = env[field];
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) fail(field);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) fail(field);
  return parsed;
}

function booleanValue(env: Readonly<Record<string, string | undefined>>, field: string): boolean {
  const value = env[field];
  if (value !== "true" && value !== "false") fail(field);
  return value === "true";
}

function databaseUrl(env: Readonly<Record<string, string | undefined>>): string {
  const value = text(env, "DATABASE_URL");
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { fail("DATABASE_URL"); }
  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:")
    || !parsed.hostname
    || !parsed.username
    || !parsed.password
    || !parsed.pathname
    || parsed.pathname === "/"
  ) fail("DATABASE_URL");
  return value;
}

function shardConfig(env: Readonly<Record<string, string | undefined>>): ShardConfig {
  if (env.SHARD_COUNT === undefined || env.SHARD_INDEX === undefined) fail("SHARD_CONFIG");
  try { return parseShardConfig(env); }
  catch { fail("SHARD_CONFIG"); }
}

function host(env: Readonly<Record<string, string | undefined>>): string {
  const value = text(env, "ENGINE_HEALTH_HOST", 253);
  if (/[/\\\s]/.test(value)) fail("ENGINE_HEALTH_HOST");
  return value;
}

function telegramBotToken(env: Readonly<Record<string, string | undefined>>): string {
  const value = text(env, "TELEGRAM_BOT_TOKEN", 512);
  if (!/^\d+:\S+$/.test(value)) fail("TELEGRAM_BOT_TOKEN");
  return value;
}

export class ProductionEngineConfig {
  readonly shard: ShardConfig;
  readonly runnerPolicy: AccountRunnerPolicy;
  readonly supervisorPolicy: AccountSupervisorPolicy;
  readonly databasePolicy: ProductionDatabasePolicy;
  readonly healthPolicy: ProductionHealthPolicy;
  readonly telegramApiId: number;
  readonly telegramOperationTimeoutMilliseconds: number;
  readonly #databaseUrl: string;
  readonly #telegramApiHash: string;
  readonly #telegramBotToken: string;
  readonly #sessionKeyRing: TelegramSessionKeyRing;

  private constructor(input: Readonly<{
    shard: ShardConfig;
    runnerPolicy: AccountRunnerPolicy;
    supervisorPolicy: AccountSupervisorPolicy;
    databasePolicy: ProductionDatabasePolicy;
    healthPolicy: ProductionHealthPolicy;
    telegramApiId: number;
    telegramApiHash: string;
    telegramBotToken: string;
    telegramOperationTimeoutMilliseconds: number;
    databaseUrl: string;
    sessionKeyRing: TelegramSessionKeyRing;
  }>) {
    this.shard = input.shard;
    this.runnerPolicy = input.runnerPolicy;
    this.supervisorPolicy = input.supervisorPolicy;
    this.databasePolicy = input.databasePolicy;
    this.healthPolicy = input.healthPolicy;
    this.telegramApiId = input.telegramApiId;
    this.telegramOperationTimeoutMilliseconds = input.telegramOperationTimeoutMilliseconds;
    this.#databaseUrl = input.databaseUrl;
    this.#telegramApiHash = input.telegramApiHash;
    this.#telegramBotToken = input.telegramBotToken;
    this.#sessionKeyRing = input.sessionKeyRing;
    Object.freeze(this);
  }

  static fromEnvironment(env: Readonly<Record<string, string | undefined>>): ProductionEngineConfig {
    const shard = shardConfig(env);
    const leaseSeconds = integer(env, "ENGINE_ACCOUNT_LEASE_SECONDS", 2, 3_600);
    const heartbeatIntervalMilliseconds = integer(env, "ENGINE_HEARTBEAT_INTERVAL_MS", 1, leaseSeconds * 500);
    const commandLeaseSeconds = integer(env, "ENGINE_COMMAND_LEASE_SECONDS", 1, leaseSeconds - 1);
    const runnerPolicy: AccountRunnerPolicy = Object.freeze({
      leaseSeconds,
      heartbeatIntervalMilliseconds,
      maxActionsPerRun: integer(env, "ENGINE_MAX_ACTIONS_PER_RUN", 1, 1_000),
      commandLeaseSeconds,
      runtimeRetrySeconds: integer(env, "ENGINE_RUNTIME_RETRY_SECONDS", 1, 86_400),
    });
    const supervisorPolicy: AccountSupervisorPolicy = Object.freeze({
      maxConcurrentAccounts: integer(env, "ENGINE_MAX_CONCURRENT_ACCOUNTS", 1, 1_000),
      discoveryBatchSize: integer(env, "ENGINE_DISCOVERY_BATCH_SIZE", 1, 1_000),
      reconciliationIntervalMilliseconds: integer(env, "ENGINE_RECONCILIATION_INTERVAL_MS", 10, 3_600_000),
      subscriptionRetryMilliseconds: integer(env, "ENGINE_SUBSCRIPTION_RETRY_MS", 10, 3_600_000),
      contendedAccountRetryMilliseconds: integer(env, "ENGINE_CONTENDED_ACCOUNT_RETRY_MS", 10, 3_600_000),
      failedAccountRetryMilliseconds: integer(env, "ENGINE_FAILED_ACCOUNT_RETRY_MS", 10, 3_600_000),
    });
    const configuredApiHash = text(env, "TELEGRAM_API_HASH", 64);
    if (!API_HASH.test(configuredApiHash)) fail("TELEGRAM_API_HASH");
    let sessionKeyRing: TelegramSessionKeyRing;
    try { sessionKeyRing = TelegramSessionKeyRing.fromEnvironment(env); }
    catch { fail("TELEGRAM_SESSION_KEYS"); }

    const readinessProbeIntervalMilliseconds = integer(env, "ENGINE_READINESS_PROBE_INTERVAL_MS", 100, 300_000);
    const readinessProbeTimeoutMilliseconds = integer(env, "ENGINE_READINESS_PROBE_TIMEOUT_MS", 1, 120_000);
    if (readinessProbeTimeoutMilliseconds > readinessProbeIntervalMilliseconds) {
      fail("ENGINE_READINESS_PROBE_TIMEOUT_MS");
    }

    return new ProductionEngineConfig({
      shard,
      runnerPolicy,
      supervisorPolicy,
      databasePolicy: Object.freeze({
        maxConnections: integer(env, "ENGINE_DATABASE_MAX_CONNECTIONS", 1, 100),
        connectTimeoutSeconds: integer(env, "ENGINE_DATABASE_CONNECT_TIMEOUT_SECONDS", 1, 60),
        idleTimeoutSeconds: integer(env, "ENGINE_DATABASE_IDLE_TIMEOUT_SECONDS", 1, 3_600),
        maxLifetimeSeconds: integer(env, "ENGINE_DATABASE_MAX_LIFETIME_SECONDS", 60, 86_400),
        closeTimeoutSeconds: integer(env, "ENGINE_DATABASE_CLOSE_TIMEOUT_SECONDS", 1, 60),
        prepareStatements: booleanValue(env, "ENGINE_DATABASE_PREPARE_STATEMENTS"),
      }),
      healthPolicy: Object.freeze({
        host: host(env),
        port: integer(env, "ENGINE_HEALTH_PORT", 1, 65_535),
        readinessProbeIntervalMilliseconds,
        readinessProbeTimeoutMilliseconds,
        readinessFailureThreshold: integer(env, "ENGINE_READINESS_FAILURE_THRESHOLD", 1, 100),
      }),
      telegramApiId: integer(env, "TELEGRAM_API_ID", 1, 2_147_483_647),
      telegramApiHash: configuredApiHash.toLowerCase(),
      telegramBotToken: telegramBotToken(env),
      telegramOperationTimeoutMilliseconds: integer(env, "TELEGRAM_OPERATION_TIMEOUT_MS", 1, 120_000),
      databaseUrl: databaseUrl(env),
      sessionKeyRing,
    });
  }

  databaseUrl(): string { return this.#databaseUrl; }
  telegramApiHash(): string { return this.#telegramApiHash; }
  telegramBotToken(): string { return this.#telegramBotToken; }
  sessionKeyRing(): TelegramSessionKeyRing { return this.#sessionKeyRing; }

  toJSON(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      redacted: true,
      shard: this.shard,
      runnerPolicy: this.runnerPolicy,
      supervisorPolicy: this.supervisorPolicy,
      databasePolicy: this.databasePolicy,
      healthPolicy: this.healthPolicy,
      telegramApiId: this.telegramApiId,
      telegramOperationTimeoutMilliseconds: this.telegramOperationTimeoutMilliseconds,
      sessionKeyVersion: this.#sessionKeyRing.activeKeyVersion,
    });
  }

  toString(): string {
    return `ProductionEngineConfig(redacted, shard=${this.shard.shardIndex}/${this.shard.shardCount})`;
  }

  [INSPECT](): string { return this.toString(); }
}
