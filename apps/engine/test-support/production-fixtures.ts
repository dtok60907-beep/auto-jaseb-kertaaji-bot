import type {
  AccountSupervisorSnapshot,
  AccountSupervisorSummary,
} from "../src/account-supervisor/contracts.ts";

export const TEST_DATABASE_SECRET = "database-secret";
export const TEST_API_HASH = "a".repeat(32);
export const TEST_SESSION_KEY = "b".repeat(64);

export function productionEnvironment(): Record<string, string> {
  return {
    DATABASE_URL: `postgresql://engine:${TEST_DATABASE_SECRET}@localhost:5432/jaseb`,
    TELEGRAM_API_ID: "12345",
    TELEGRAM_API_HASH: TEST_API_HASH,
    TELEGRAM_OPERATION_TIMEOUT_MS: "30000",
    TELEGRAM_SESSION_ACTIVE_KEY_VERSION: "1",
    TELEGRAM_SESSION_KEYS: JSON.stringify({ 1: TEST_SESSION_KEY }),
    SHARD_COUNT: "2",
    SHARD_INDEX: "1",
    ENGINE_ACCOUNT_LEASE_SECONDS: "120",
    ENGINE_HEARTBEAT_INTERVAL_MS: "30000",
    ENGINE_MAX_ACTIONS_PER_RUN: "100",
    ENGINE_COMMAND_LEASE_SECONDS: "60",
    ENGINE_RUNTIME_RETRY_SECONDS: "15",
    ENGINE_MAX_CONCURRENT_ACCOUNTS: "4",
    ENGINE_DISCOVERY_BATCH_SIZE: "20",
    ENGINE_RECONCILIATION_INTERVAL_MS: "1000",
    ENGINE_SUBSCRIPTION_RETRY_MS: "1000",
    ENGINE_CONTENDED_ACCOUNT_RETRY_MS: "5000",
    ENGINE_FAILED_ACCOUNT_RETRY_MS: "5000",
    ENGINE_DATABASE_MAX_CONNECTIONS: "10",
    ENGINE_DATABASE_CONNECT_TIMEOUT_SECONDS: "10",
    ENGINE_DATABASE_IDLE_TIMEOUT_SECONDS: "30",
    ENGINE_DATABASE_MAX_LIFETIME_SECONDS: "3600",
    ENGINE_DATABASE_CLOSE_TIMEOUT_SECONDS: "5",
    ENGINE_DATABASE_PREPARE_STATEMENTS: "false",
    ENGINE_HEALTH_HOST: "127.0.0.1",
    ENGINE_HEALTH_PORT: "8080",
    ENGINE_READINESS_PROBE_INTERVAL_MS: "1000",
    ENGINE_READINESS_FAILURE_THRESHOLD: "3",
  };
}

export function supervisorSnapshot(state: AccountSupervisorSnapshot["state"] = "RUNNING"): AccountSupervisorSnapshot {
  return Object.freeze({
    state,
    shard: Object.freeze({ shardCount: 2, shardIndex: 1 }),
    inFlightAccounts: 0,
    pendingAccounts: 0,
    peakConcurrency: 0,
    runsStarted: 0,
    runsCompleted: 0,
    runnerFailures: 0,
    discoveryFailures: 0,
    discoveryAccountsRejected: 0,
    subscriptionFailures: 0,
    observerFailures: 0,
    wakeupsAccepted: 0,
    wakeupsIgnored: 0,
  });
}

export function supervisorSummary(): AccountSupervisorSummary {
  return Object.freeze({
    ...supervisorSnapshot("STOPPED"),
    cleanupErrorCodes: Object.freeze([]),
  });
}
