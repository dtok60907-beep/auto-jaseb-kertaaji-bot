import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateTelegramSoakDelivery,
  TeleprotoSoakDeliveryObserver,
  type TeleprotoHistoryClient,
} from "../src/benchmark/telegram-soak-delivery-observer.ts";
import {
  expectedTelegramSoakDeliveryMarkers,
  validateTelegramSoakConfig,
  type TelegramSoakConfig,
} from "../src/benchmark/telegram-soak.ts";

function config(): TelegramSoakConfig {
  return validateTelegramSoakConfig({
    databaseUrl: "postgresql://safe:test@example.test/db",
    commit: "779d0a6",
    runId: "observer-unit",
    soakDurationMinutes: 1,
    burstIntervalSeconds: 60,
    sendIntervalSeconds: 0,
    expectedAccounts: 2,
    approvedCommandCount: 4,
    interruptAtMinutes: [],
    revokeAccountIndex: null,
    revokeAfterMinute: null,
    monitorIntervalMilliseconds: 1_000,
    healthTimeoutMilliseconds: 1_000,
    databaseMaxConnections: 1,
    databaseConnectTimeoutSeconds: 1,
  });
}

test("delivery evaluator requires the exact marker multiset, not only the same total", () => {
  const markers = expectedTelegramSoakDeliveryMarkers(config());
  assert.deepEqual(evaluateTelegramSoakDelivery(config(), markers), {
    passed: true, expected: 4, observed: 4, missing: 0, duplicate: 0, unexpected: 0,
  });
  const missingAndDuplicate = [markers[0]!, markers[0]!, markers[2]!, markers[3]!];
  assert.deepEqual(evaluateTelegramSoakDelivery(config(), missingAndDuplicate), {
    passed: false, expected: 4, observed: 4, missing: 1, duplicate: 1, unexpected: 0,
  });
  assert.equal(evaluateTelegramSoakDelivery(config(), [...markers, "F5.7c observer-unit unknown a1"]).unexpected, 1);
});

class FakeHistoryClient implements TeleprotoHistoryClient {
  authorized = true;
  disconnectCalls = 0;
  messages: readonly unknown[] = [];
  async connect(): Promise<unknown> { return true; }
  async checkAuthorization(): Promise<boolean> { return this.authorized; }
  async getMessages(): Promise<readonly unknown[]> { return this.messages; }
  async disconnect(): Promise<void> { this.disconnectCalls += 1; }
}

test("Teleproto observer returns only matching message text and always disconnects", async () => {
  const client = new FakeHistoryClient();
  client.messages = [
    { message: "F5.7c observer-unit burst-1 a1" },
    { message: "unrelated" },
    { action: "service-message" },
  ];
  const observer = new TeleprotoSoakDeliveryObserver({
    apiId: 12345,
    apiHash: "a".repeat(32),
    session: "private-session",
    operationTimeoutMilliseconds: 1_000,
    createClient: () => client,
  });
  assert.deepEqual(await observer.observe({
    targetRef: "@target",
    search: "F5.7c observer-unit",
    limit: 5,
  }), ["F5.7c observer-unit burst-1 a1"]);
  assert.equal(client.disconnectCalls, 1);
  assert.equal(JSON.stringify(observer).includes("private-session"), false);
});

test("unauthorized observer fails and disconnects without returning provider detail", async () => {
  const client = new FakeHistoryClient();
  client.authorized = false;
  const observer = new TeleprotoSoakDeliveryObserver({
    apiId: 12345, apiHash: "a".repeat(32), session: "private-session",
    operationTimeoutMilliseconds: 1_000, createClient: () => client,
  });
  await assert.rejects(() => observer.observe({ targetRef: "@target", search: "F5.7c observer-unit", limit: 5 }));
  assert.equal(client.disconnectCalls, 1);
});
