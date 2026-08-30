import assert from "node:assert/strict";
import test from "node:test";

import { ProductionEngineConfig } from "../src/production/config.ts";
import type {
  ProductionEngineCoreHandle,
  ProductionEngineCoreSnapshot,
  ProductionEngineCoreSummary,
} from "../src/production/core.ts";
import {
  runTelegramSoak,
  type TelegramSoakEnvironment,
} from "../src/benchmark/run-telegram-soak.ts";
import type {
  SoakAccountIdentity,
  SoakPerAccountState,
  TelegramSoakStore,
} from "../src/benchmark/telegram-soak-store.ts";
import {
  validateTelegramSoakConfig,
  type SoakFixtureCounts,
} from "../src/benchmark/telegram-soak.ts";
import { productionEnvironment, supervisorSnapshot, supervisorSummary } from "../test-support/production-fixtures.ts";

const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const INSTANCE_ID = "00000000-0000-4000-8000-000000000003";

class FakeCore implements ProductionEngineCoreHandle {
  stopCalls = 0;

  snapshot(): ProductionEngineCoreSnapshot {
    return Object.freeze({
      state: "RUNNING",
      instanceId: INSTANCE_ID,
      shard: Object.freeze({ shardCount: 2, shardIndex: 1 }),
      supervisor: supervisorSnapshot(),
    });
  }

  async probeDatabase(): Promise<void> {}

  async stop(): Promise<ProductionEngineCoreSummary> {
    this.stopCalls += 1;
    return Object.freeze({
      state: "STOPPED",
      instanceId: INSTANCE_ID,
      shard: Object.freeze({ shardCount: 2, shardIndex: 1 }),
      supervisor: supervisorSummary(),
      cleanupErrorCodes: Object.freeze([]),
    });
  }
}

const emptyCounts = (): SoakFixtureCounts => Object.freeze({
  accountsReady: 1,
  accountsRevoked: 0,
  accountsDegraded: 0,
  commandsCreated: 0,
  commandsSucceeded: 0,
  commandsPending: 0,
  commandsInFlight: 0,
  commandsFailedRetryable: 0,
  commandsFailedFinal: 0,
  commandsUncertain: 0,
  activeLeases: 0,
});

class FakeStore implements TelegramSoakStore {
  readonly accounts: readonly SoakAccountIdentity[] = Object.freeze([
    Object.freeze({ accountId: ACCOUNT_ID, userId: USER_ID }),
  ]);
  commandsCreated = 0;
  commandsSucceeded = 0;
  cleanupCalls = 0;
  remainingOperations = 0;
  cleanupError: Error | null = null;

  async listAccounts(): Promise<readonly SoakAccountIdentity[]> { return this.accounts; }

  async enqueueBurst(input: Parameters<TelegramSoakStore["enqueueBurst"]>[0]): Promise<number> {
    this.commandsCreated += input.accounts.length;
    this.commandsSucceeded += input.accounts.length;
    this.remainingOperations += input.accounts.length;
    return input.accounts.length;
  }

  async readCounts(): Promise<SoakFixtureCounts> {
    return Object.freeze({
      ...emptyCounts(),
      commandsCreated: this.commandsCreated,
      commandsSucceeded: this.commandsSucceeded,
    });
  }

  async readPerAccount(): Promise<readonly SoakPerAccountState[]> {
    return Object.freeze([Object.freeze({
      accountId: ACCOUNT_ID,
      accountStatus: "READY",
      succeeded: this.commandsSucceeded,
      pending: 0,
      inFlight: 0,
      failedRetryable: 0,
      failedFinal: 0,
      uncertain: 0,
    })]);
  }

  async readSucceededPerAccountAfter(): Promise<readonly Readonly<{ accountId: string; succeededAfter: number }>[]> {
    return Object.freeze([Object.freeze({ accountId: ACCOUNT_ID, succeededAfter: 1 })]);
  }

  async readSendLatencies() {
    return Object.freeze({ sendsSucceeded: this.commandsSucceeded, latencyP50Milliseconds: 10, latencyP95Milliseconds: 20, latencyMaxMilliseconds: 20 });
  }

  async readMalformedReceiptCount(): Promise<number> { return 0; }
  async readSucceededAfter(): Promise<number> { return 1; }

  async cleanupBurstOperations(): Promise<number> {
    this.cleanupCalls += 1;
    if (this.cleanupError) throw this.cleanupError;
    const deleted = this.remainingOperations;
    this.remainingOperations = 0;
    return deleted;
  }

  async countBurstOperations(): Promise<number> { return this.remainingOperations; }
}

function environment(): TelegramSoakEnvironment {
  return Object.freeze({
    engineConfig: ProductionEngineConfig.fromEnvironment(productionEnvironment()),
    soakConfig: validateTelegramSoakConfig({
      databaseUrl: "postgresql://engine:credential@example.test/jaseb",
      commit: "5b0f592",
      runId: "runner-unit-test",
      soakDurationMinutes: 1,
      burstIntervalSeconds: 60,
      sendIntervalSeconds: 0,
      expectedAccounts: 1,
      approvedCommandCount: 2,
      interruptAtMinutes: [],
      revokeAccountIndex: null,
      revokeAfterMinute: null,
      monitorIntervalMilliseconds: 60_000,
      healthTimeoutMilliseconds: 1_000,
      databaseMaxConnections: 1,
      databaseConnectTimeoutSeconds: 1,
    }),
    targetRef: "telegram-target",
  });
}

test("soak runner uses the injected store, verifies every phase, and cleans burst fixtures", async () => {
  const store = new FakeStore();
  const core = new FakeCore();
  const records: Readonly<Record<string, unknown>>[] = [];
  let clock = 0;

  const result = await runTelegramSoak({
    environment: environment(),
    store,
    emit: (record) => records.push(record),
    startEngine: async () => core,
    now: () => clock,
    pause: async (milliseconds) => { clock += milliseconds; },
  });

  assert.equal(result.passed, true);
  assert.equal(result.summary.commandsEnqueued, 2);
  assert.equal(result.summary.cleanupDeletedOperations, 2);
  assert.equal(result.summary.cleanupSucceeded, true);
  assert.equal(result.summary.remainingBurstOperations, 0);
  assert.equal(store.cleanupCalls, 1);
  assert.equal(core.stopCalls, 1);
  assert.equal(records.some((record) => record.type === "assertion" && record.name === "benchmark_fixtures_cleaned" && record.passed === true), true);
});

test("soak runner reports failure when cleanup cannot prove zero remaining fixtures", async () => {
  const store = new FakeStore();
  const core = new FakeCore();
  let clock = 0;
  store.cleanupError = new Error("database credential must not be emitted");

  const records: Readonly<Record<string, unknown>>[] = [];
  const result = await runTelegramSoak({
    environment: environment(),
    store,
    emit: (record) => records.push(record),
    startEngine: async () => core,
    now: () => clock,
    pause: async (milliseconds) => { clock += milliseconds; },
  });

  assert.equal(result.passed, false);
  assert.equal(result.summary.cleanupSucceeded, false);
  assert.equal(result.summary.remainingBurstOperations, -1);
  assert.equal(store.cleanupCalls, 1);
  assert.equal(JSON.stringify({ result, records }).includes("database credential"), false);
});

test("soak runner still cleans fixtures when engine startup fails", async () => {
  const store = new FakeStore();
  store.remainingOperations = 3;

  const result = await runTelegramSoak({
    environment: environment(),
    store,
    emit: () => undefined,
    startEngine: async () => { throw new Error("provider detail"); },
  });

  assert.equal(result.passed, false);
  assert.equal(result.summary.cleanupDeletedOperations, 3);
  assert.equal(result.summary.remainingBurstOperations, 0);
  assert.equal(store.cleanupCalls, 1);
});
