import assert from "node:assert/strict";
import test from "node:test";

import { TelegramSessionKeyRing } from "../../../packages/telegram-session-crypto/src/index.ts";
import {
  provisionTelegramSoakAccounts,
  revokeTelegramSoakAccount,
  cleanupTelegramSoakRun,
  TelegramSoakProvisioningError,
  type TelegramSoakProvisionedAccount,
  type TelegramSoakCleanupResult,
  type TelegramSoakProvisioningStore,
} from "../src/benchmark/telegram-soak-provisioning.ts";

const KEY = "ab".repeat(32);
const IDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
];

class FakeStore implements TelegramSoakProvisioningStore {
  provisionCalls = 0;
  revokeCalls = 0;
  persistedCiphertexts: Buffer[] = [];
  persistError: Error | null = null;
  revokeResult = true;
  cleanupResult: TelegramSoakCleanupResult = Object.freeze({ deletedAccounts: 1, deletedUsers: 1, deletedOperations: 2, remainingAccounts: 0, remainingOperations: 0, remainingLeases: 0 });

  async provisionBatch(input: Readonly<{ runId: string; intervalSeconds: number; accounts: readonly TelegramSoakProvisionedAccount[] }>): Promise<void> {
    this.provisionCalls += 1;
    if (this.persistError) throw this.persistError;
    this.persistedCiphertexts = input.accounts.map((account) => Buffer.from(account.encryptedSession));
  }

  async revokeAccount(): Promise<boolean> {
    this.revokeCalls += 1;
    return this.revokeResult;
  }

  async cleanupRun() { return this.cleanupResult; }
}

function ids() {
  let index = 0;
  return () => IDS[index++]!;
}

function ring() {
  return TelegramSessionKeyRing.fromHexKeys({ activeKeyVersion: 1, keys: { 1: KEY } });
}

test("provisioning verifies every session, encrypts it for its account, and returns no credential", async () => {
  const store = new FakeStore();
  const verifiedSessions: string[] = [];
  const result = await provisionTelegramSoakAccounts({
    runId: "provision-unit",
    sessions: ["session-one", "session-two"],
    intervalSeconds: 0,
    verifier: { verify: async (session) => {
      verifiedSessions.push(session);
      return { providerUserId: session === "session-one" ? "10001" : "10002" };
    } },
    store,
    keyRing: ring(),
    createId: ids(),
  });

  assert.deepEqual(verifiedSessions, ["session-one", "session-two"]);
  assert.equal(store.provisionCalls, 1);
  assert.equal(store.persistedCiphertexts.length, 2);
  assert.notDeepEqual(store.persistedCiphertexts[0], Buffer.from("session-one"));
  assert.deepEqual(result.accounts, [
    { accountIndex: 1, userId: IDS[0], accountId: IDS[1] },
    { accountIndex: 2, userId: IDS[2], accountId: IDS[3] },
  ]);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("session-one"), false);
  assert.equal(serialized.includes("10001"), false);
  assert.equal(serialized.includes(KEY), false);
});

test("duplicate provider identity and verifier failures cause zero database writes with stable errors", async () => {
  for (const scenario of ["duplicate", "verify-error"] as const) {
    const store = new FakeStore();
    let call = 0;
    await assert.rejects(() => provisionTelegramSoakAccounts({
      runId: "provision-unit",
      sessions: ["first-private-session", "second-private-session"],
      intervalSeconds: 10,
      verifier: { verify: async () => {
        call += 1;
        if (scenario === "verify-error" && call === 2) throw new Error("raw Telegram error");
        return { providerUserId: "20001" };
      } },
      store,
      keyRing: ring(),
      createId: ids(),
    }), (error: unknown) => {
      assert.ok(error instanceof TelegramSoakProvisioningError);
      assert.equal(error.code, scenario === "duplicate" ? "PROVISIONING_PROVIDER_ID_DUPLICATE" : "PROVISIONING_SESSION_VERIFY_FAILED");
      assert.equal(JSON.stringify(error).includes("raw Telegram"), false);
      return true;
    });
    assert.equal(store.provisionCalls, 0);
  }
});

test("persistence and revoke failures expose stable codes only", async () => {
  const store = new FakeStore();
  store.persistError = new Error("database connection credential");
  await assert.rejects(() => provisionTelegramSoakAccounts({
    runId: "provision-unit",
    sessions: ["private-session"],
    intervalSeconds: 0,
    verifier: { verify: async () => ({ providerUserId: "30001" }) },
    store,
    keyRing: ring(),
    createId: ids(),
  }), (error: unknown) => {
    assert.ok(error instanceof TelegramSoakProvisioningError);
    assert.equal(error.code, "PROVISIONING_PERSIST_FAILED");
    assert.equal(JSON.stringify(error).includes("credential"), false);
    return true;
  });

  store.revokeResult = false;
  await assert.rejects(() => revokeTelegramSoakAccount({
    runId: "provision-unit",
    accountId: IDS[1]!,
    firedAtIso: "2026-08-30T00:00:00.000Z",
    store,
  }), (error: unknown) => error instanceof TelegramSoakProvisioningError && error.code === "PROVISIONING_REVOKE_FAILED");
  assert.equal(store.revokeCalls, 1);
});

test("cleanup succeeds only when accounts, operations, and leases are proven absent", async () => {
  const store = new FakeStore();
  assert.deepEqual(await cleanupTelegramSoakRun({ runId: "provision-unit", store }), store.cleanupResult);
  store.cleanupResult = Object.freeze({ ...store.cleanupResult, remainingLeases: 1 });
  await assert.rejects(
    () => cleanupTelegramSoakRun({ runId: "provision-unit", store }),
    (error: unknown) => error instanceof TelegramSoakProvisioningError && error.code === "PROVISIONING_CLEANUP_FAILED",
  );
});
