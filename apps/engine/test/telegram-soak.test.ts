import assert from "node:assert/strict";
import test from "node:test";

import type {
  TelegramDeliveryAdapter,
  TelegramDeliveryReceipt,
  TelegramJoinResult,
  TelegramLinkedDiscussion,
  TelegramTarget,
} from "../../../packages/telegram-contract/src/index.ts";
import type { TelegramRuntimeAdapterFactory } from "../src/account-runner/contracts.ts";
import {
  createSoakChaos,
  expectedTelegramSoakDeliveryMarkers,
  TelegramSoakConfigError,
  soakMetadata,
  validateTelegramSoakConfig,
  type TelegramSoakConfig,
} from "../src/benchmark/telegram-soak.ts";

function config(overrides: Partial<TelegramSoakConfig> = {}): TelegramSoakConfig {
  return {
    databaseUrl: "postgresql://must-not-appear:secret@example.test/postgres",
    commit: "3488869",
    runId: "controlled-run-1",
    soakDurationMinutes: 60,
    burstIntervalSeconds: 600,
    sendIntervalSeconds: 0,
    expectedAccounts: 10,
    approvedCommandCount: 66,
    interruptAtMinutes: [45, 15],
    revokeAccountIndex: 1,
    revokeAfterMinute: 30,
    monitorIntervalMilliseconds: 5_000,
    healthTimeoutMilliseconds: 60_000,
    databaseMaxConnections: 12,
    databaseConnectTimeoutSeconds: 15,
    ...overrides,
  };
}

test("Telegram soak config is explicit, supports the 1/10/50 protocol, and normalizes interruption order", () => {
  const parsed = validateTelegramSoakConfig(config({ expectedAccounts: 50, approvedCommandCount: 346 }));
  assert.equal(parsed.expectedAccounts, 50);
  assert.deepEqual(parsed.interruptAtMinutes, [15, 45]);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.interruptAtMinutes), true);
});

test("Telegram soak config rejects ambiguous revocation and interruption schedules", () => {
  for (const [field, input] of [
    ["revokeAccountIndex", config({ revokeAfterMinute: null })],
    ["interruptAtMinutes", config({ interruptAtMinutes: [15, 15] })],
    ["interruptAtMinutes.0", config({ interruptAtMinutes: [60] })],
    ["expectedAccounts", config({ expectedAccounts: 51 })],
    ["approvedCommandCount", config({ approvedCommandCount: 65 })],
  ] as const) {
    assert.throws(() => validateTelegramSoakConfig(input), (error: unknown) => {
      assert.ok(error instanceof TelegramSoakConfigError);
      assert.equal(error.field, field);
      assert.deepEqual(error.publicData(), { code: "TELEGRAM_SOAK_CONFIG_INVALID", field });
      return true;
    });
  }
});

test("Telegram soak metadata contains the controlled workload but never the database credential", () => {
  const parsed = validateTelegramSoakConfig(config());
  const serialized = JSON.stringify(soakMetadata(parsed));
  assert.equal(serialized.includes("must-not-appear"), false);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("CONTROLLED_TELEGRAM_SOAK"), true);
  assert.equal(serialized.includes("controlled-run-1"), true);
});

test("delivery markers are unique and exactly follow the approved revocation workload", () => {
  const parsed = validateTelegramSoakConfig(config());
  const markers = expectedTelegramSoakDeliveryMarkers(parsed);
  assert.equal(markers.length, parsed.approvedCommandCount);
  assert.equal(new Set(markers).size, markers.length);
  assert.equal(markers.includes("F5.7c controlled-run-1 burst-3 a1"), true);
  assert.equal(markers.includes("F5.7c controlled-run-1 burst-4 a1"), false);
  assert.equal(markers.includes("F5.7c controlled-run-1 health a1"), false);
  assert.equal(markers.includes("F5.7c controlled-run-1 health a2"), true);
});

class FakeAdapter implements TelegramDeliveryAdapter {
  state = "READY" as const;
  disconnectCalls = 0;
  readonly disconnectFails: boolean;
  constructor(disconnectFails = false) { this.disconnectFails = disconnectFails; }
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
    if (this.disconnectFails) throw new Error("raw provider detail");
  }
  async resolveTarget(): Promise<TelegramTarget> { throw new Error("unused"); }
  async resolveLinkedDiscussion(): Promise<TelegramLinkedDiscussion> { throw new Error("unused"); }
  async joinPublicTarget(): Promise<TelegramJoinResult> { throw new Error("unused"); }
  async sendText(): Promise<TelegramDeliveryReceipt> { throw new Error("unused"); }
  async forwardNative(): Promise<TelegramDeliveryReceipt> { throw new Error("unused"); }
}

test("controlled disconnect injection reaches every created adapter and contains raw failures", async () => {
  const adapters = [new FakeAdapter(), new FakeAdapter(true)];
  let index = 0;
  const factory: TelegramRuntimeAdapterFactory = {
    create: () => adapters[index++]!,
  };
  const chaos = createSoakChaos();
  const wrapped = chaos.wrapAdapterFactory(factory);
  wrapped.create({ accountId: "00000000-0000-4000-8000-000000000001", accountType: "JASEB_WORKER", session: "redacted-a" });
  wrapped.create({ accountId: "00000000-0000-4000-8000-000000000002", accountType: "JASEB_WORKER", session: "redacted-b" });

  await chaos.interruptAll();

  assert.equal(chaos.interruptions(), 1);
  assert.deepEqual(adapters.map((adapter) => adapter.disconnectCalls), [1, 1]);
});
