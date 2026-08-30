import assert from "node:assert/strict";
import test from "node:test";

import { TelegramSessionKeyRing } from "../../../packages/telegram-session-crypto/src/index.ts";
import { ProductionEngineConfig } from "../src/production/config.ts";
import type { SoakRunResult, TelegramSoakEnvironment } from "../src/benchmark/run-telegram-soak.ts";
import { orchestrateTelegramSoak } from "../src/benchmark/telegram-soak-orchestrator.ts";
import type {
  TelegramSoakCleanupResult,
  TelegramSoakProvisionedAccount,
  TelegramSoakProvisioningStore,
} from "../src/benchmark/telegram-soak-provisioning.ts";
import type { TelegramSoakStore } from "../src/benchmark/telegram-soak-store.ts";
import { validateTelegramSoakConfig } from "../src/benchmark/telegram-soak.ts";
import { productionEnvironment } from "../test-support/production-fixtures.ts";

const cleanup: TelegramSoakCleanupResult = Object.freeze({
  deletedAccounts: 1,
  deletedUsers: 1,
  deletedOperations: 2,
  remainingAccounts: 0,
  remainingOperations: 0,
  remainingLeases: 0,
});

class FakeProvisioningStore implements TelegramSoakProvisioningStore {
  provisionCalls = 0;
  cleanupCalls = 0;
  cleanupError: Error | null = null;

  async provisionBatch(_input: Readonly<{ runId: string; intervalSeconds: number; accounts: readonly TelegramSoakProvisionedAccount[] }>) {
    this.provisionCalls += 1;
  }
  async revokeAccount() { return true; }
  async cleanupRun() {
    this.cleanupCalls += 1;
    if (this.cleanupError) throw this.cleanupError;
    return cleanup;
  }
}

function environment(): TelegramSoakEnvironment {
  return Object.freeze({
    engineConfig: ProductionEngineConfig.fromEnvironment(productionEnvironment()),
    soakConfig: validateTelegramSoakConfig({
      databaseUrl: "postgresql://engine:credential@example.test/jaseb",
      commit: "b936c57",
      runId: "orchestrator-unit",
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

function runResult(passed: boolean): SoakRunResult {
  return Object.freeze({ passed, summary: Object.freeze({ runId: "orchestrator-unit" }) }) as unknown as SoakRunResult;
}

const unusedRunStore = Object.freeze({}) as TelegramSoakStore;
const keyRing = TelegramSessionKeyRing.fromHexKeys({ activeKeyVersion: 1, keys: { 1: "ef".repeat(32) } });

test("orchestrator provisions, runs, and proves teardown without exposing credentials", async () => {
  const store = new FakeProvisioningStore();
  const result = await orchestrateTelegramSoak({
    environment: environment(),
    sessions: ["private-session"],
    verifier: { verify: async () => ({ providerUserId: "91001" }) },
    keyRing,
    provisioningStore: store,
    runStore: unusedRunStore,
    emit: () => undefined,
    run: async () => runResult(true),
  });

  assert.equal(result.passed, true);
  assert.equal(result.provisionedAccounts, 1);
  assert.equal(result.failureCode, null);
  assert.equal(store.provisionCalls, 1);
  assert.equal(store.cleanupCalls, 1);
  assert.equal(JSON.stringify(result).includes("private-session"), false);
});

test("hard-gate and thrown run failures still teardown provisioned accounts", async () => {
  for (const [expectedCode, run] of [
    ["F57C_HARD_GATE_FAILED", async () => runResult(false)],
    ["F57C_RUN_FAILED", async () => { throw new Error("raw runtime failure"); }],
  ] as const) {
    const store = new FakeProvisioningStore();
    const result = await orchestrateTelegramSoak({
      environment: environment(), sessions: ["private-session"],
      verifier: { verify: async () => ({ providerUserId: "92001" }) },
      keyRing, provisioningStore: store, runStore: unusedRunStore,
      emit: () => undefined, run,
    });
    assert.equal(result.passed, false);
    assert.equal(result.failureCode, expectedCode);
    assert.equal(store.cleanupCalls, 1);
    assert.equal(JSON.stringify(result).includes("raw runtime"), false);
  }
});

test("provisioning failure writes no teardown claim while teardown failure overrides success", async () => {
  const provisionFailureStore = new FakeProvisioningStore();
  const provisionFailure = await orchestrateTelegramSoak({
    environment: environment(), sessions: ["private-session"],
    verifier: { verify: async () => { throw new Error("raw Telegram failure"); } },
    keyRing, provisioningStore: provisionFailureStore, runStore: unusedRunStore,
    emit: () => undefined, run: async () => runResult(true),
  });
  assert.equal(provisionFailure.failureCode, "F57C_PROVISION_FAILED");
  assert.equal(provisionFailureStore.cleanupCalls, 0);

  const cleanupFailureStore = new FakeProvisioningStore();
  cleanupFailureStore.cleanupError = new Error("raw database failure");
  const cleanupFailure = await orchestrateTelegramSoak({
    environment: environment(), sessions: ["private-session"],
    verifier: { verify: async () => ({ providerUserId: "93001" }) },
    keyRing, provisioningStore: cleanupFailureStore, runStore: unusedRunStore,
    emit: () => undefined, run: async () => runResult(true),
  });
  assert.equal(cleanupFailure.passed, false);
  assert.equal(cleanupFailure.failureCode, "F57C_TEARDOWN_FAILED");
  assert.equal(JSON.stringify(cleanupFailure).includes("raw database"), false);
});
