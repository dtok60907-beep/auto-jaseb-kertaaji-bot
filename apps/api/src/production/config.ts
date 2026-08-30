import { inspect } from "node:util";

const INSPECT = inspect.custom;

export type ApiDatabasePolicy = Readonly<{
  maxConnections: number;
  connectTimeoutSeconds: number;
  idleTimeoutSeconds: number;
  maxLifetimeSeconds: number;
  closeTimeoutSeconds: number;
  prepareStatements: boolean;
}>;

export type ApiAuthPolicy = Readonly<{
  sessionTtlSeconds: number;
  initDataMaxAgeSeconds: number;
  initDataClockSkewSeconds: number;
}>;

export type ApiServerPolicy = Readonly<{
  host: string;
  port: number;
  readinessProbeIntervalMilliseconds: number;
  readinessProbeTimeoutMilliseconds: number;
  readinessFailureThreshold: number;
  shutdownGraceMilliseconds: number;
}>;

export class ProductionApiConfigError extends Error {
  readonly code = "API_CONFIG_INVALID";
  readonly field: string;

  constructor(field: string) {
    super(`API_CONFIG_INVALID:${field}`);
    this.name = "ProductionApiConfigError";
    this.field = field;
  }

  publicData(): Readonly<{ code: "API_CONFIG_INVALID"; field: string }> {
    return Object.freeze({ code: this.code, field: this.field });
  }

  toJSON(): ReturnType<ProductionApiConfigError["publicData"]> {
    return this.publicData();
  }
}

function fail(field: string): never {
  throw new ProductionApiConfigError(field);
}

function requiredText(
  env: Readonly<Record<string, string | undefined>>,
  field: string,
  maximumLength: number,
): string {
  const value = env[field];
  if (typeof value !== "string" || !value.trim() || value.length > maximumLength || /[\0\r\n]/.test(value)) {
    fail(field);
  }
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

function explicitBoolean(env: Readonly<Record<string, string | undefined>>, field: string): boolean {
  const value = env[field];
  if (value !== "true" && value !== "false") fail(field);
  return value === "true";
}

function databaseUrl(env: Readonly<Record<string, string | undefined>>): string {
  const value = requiredText(env, "DATABASE_URL", 4_096);
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { fail("DATABASE_URL"); }
  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:")
    || !parsed.hostname
    || !parsed.username
    || !parsed.password
    || parsed.pathname === "/"
  ) fail("DATABASE_URL");
  return value;
}

function host(env: Readonly<Record<string, string | undefined>>): string {
  const value = requiredText(env, "API_HOST", 253);
  if (/[/\\\s]/.test(value)) fail("API_HOST");
  return value;
}

function telegramBotToken(env: Readonly<Record<string, string | undefined>>): string {
  const value = requiredText(env, "TELEGRAM_BOT_TOKEN", 512);
  if (/\s/.test(value)) fail("TELEGRAM_BOT_TOKEN");
  return value;
}

export class ProductionApiConfig {
  readonly databasePolicy: ApiDatabasePolicy;
  readonly authPolicy: ApiAuthPolicy;
  readonly serverPolicy: ApiServerPolicy;
  readonly #databaseUrl: string;
  readonly #telegramBotToken: string;

  private constructor(input: Readonly<{
    databasePolicy: ApiDatabasePolicy;
    authPolicy: ApiAuthPolicy;
    serverPolicy: ApiServerPolicy;
    databaseUrl: string;
    telegramBotToken: string;
  }>) {
    this.databasePolicy = input.databasePolicy;
    this.authPolicy = input.authPolicy;
    this.serverPolicy = input.serverPolicy;
    this.#databaseUrl = input.databaseUrl;
    this.#telegramBotToken = input.telegramBotToken;
    Object.freeze(this);
  }

  static fromEnvironment(env: Readonly<Record<string, string | undefined>>): ProductionApiConfig {
    const readinessProbeIntervalMilliseconds = integer(env, "API_READINESS_PROBE_INTERVAL_MS", 100, 300_000);
    const readinessProbeTimeoutMilliseconds = integer(env, "API_READINESS_PROBE_TIMEOUT_MS", 1, 120_000);
    if (readinessProbeTimeoutMilliseconds > readinessProbeIntervalMilliseconds) {
      fail("API_READINESS_PROBE_TIMEOUT_MS");
    }
    return new ProductionApiConfig({
      databaseUrl: databaseUrl(env),
      telegramBotToken: telegramBotToken(env),
      databasePolicy: Object.freeze({
        maxConnections: integer(env, "API_DATABASE_MAX_CONNECTIONS", 1, 50),
        connectTimeoutSeconds: integer(env, "API_DATABASE_CONNECT_TIMEOUT_SECONDS", 1, 60),
        idleTimeoutSeconds: integer(env, "API_DATABASE_IDLE_TIMEOUT_SECONDS", 1, 3_600),
        maxLifetimeSeconds: integer(env, "API_DATABASE_MAX_LIFETIME_SECONDS", 60, 86_400),
        closeTimeoutSeconds: integer(env, "API_DATABASE_CLOSE_TIMEOUT_SECONDS", 1, 60),
        prepareStatements: explicitBoolean(env, "API_DATABASE_PREPARE_STATEMENTS"),
      }),
      authPolicy: Object.freeze({
        sessionTtlSeconds: integer(env, "API_SESSION_TTL_SECONDS", 300, 604_800),
        initDataMaxAgeSeconds: integer(env, "TELEGRAM_INIT_DATA_MAX_AGE_SECONDS", 1, 86_400),
        initDataClockSkewSeconds: integer(env, "TELEGRAM_INIT_DATA_CLOCK_SKEW_SECONDS", 0, 300),
      }),
      serverPolicy: Object.freeze({
        host: host(env),
        port: integer(env, "PORT", 1, 65_535),
        readinessProbeIntervalMilliseconds,
        readinessProbeTimeoutMilliseconds,
        readinessFailureThreshold: integer(env, "API_READINESS_FAILURE_THRESHOLD", 1, 100),
        shutdownGraceMilliseconds: integer(env, "API_SHUTDOWN_GRACE_MS", 100, 300_000),
      }),
    });
  }

  databaseUrl(): string { return this.#databaseUrl; }
  telegramBotToken(): string { return this.#telegramBotToken; }

  toJSON(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      redacted: true,
      databasePolicy: this.databasePolicy,
      authPolicy: this.authPolicy,
      serverPolicy: this.serverPolicy,
    });
  }

  toString(): string { return "ProductionApiConfig(redacted)"; }
  [INSPECT](): string { return this.toString(); }
}
