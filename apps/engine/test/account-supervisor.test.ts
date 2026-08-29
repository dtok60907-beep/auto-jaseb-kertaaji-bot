import assert from "node:assert/strict";
import test from "node:test";

import type { AccountRunnerResult } from "../src/account-runner/contracts.ts";
import type {
  AccountSupervisorEvent,
  AccountSupervisorPolicy,
} from "../src/account-supervisor/contracts.ts";
import { startBroadcastShardSupervisor } from "../src/account-supervisor/service.ts";
import type {
  BroadcastRuntimeAccount,
  BroadcastRuntimeAccountRepository,
  RuntimeWakeupListener,
} from "../src/runtime-accounts/repository.ts";

const shard = Object.freeze({ shardCount: 2, shardIndex: 0 });
const policy: AccountSupervisorPolicy = Object.freeze({
  maxConcurrentAccounts: 2,
  discoveryBatchSize: 10,
  reconciliationIntervalMilliseconds: 20,
  subscriptionRetryMilliseconds: 20,
  contendedAccountRetryMilliseconds: 100,
  failedAccountRetryMilliseconds: 100,
});

const pause = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function waitUntil(predicate: () => boolean, timeoutMilliseconds = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate() && Date.now() < deadline) await pause(2);
  if (!predicate()) throw new Error("TEST_WAIT_TIMEOUT");
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function account(suffix: "0" | "1" | "2" | "4" | "6"): BroadcastRuntimeAccount {
  return Object.freeze({
    accountId: `00000000-0000-0000-0000-00000000000${suffix}`,
    accountType: suffix === "2" ? "JASEB_WORKER" : "USERBOT",
    nextDueAt: new Date(Date.now() - 1_000).toISOString(),
    hasPreparationWork: false,
    hasDeliveryWork: true,
    requiresRecovery: false,
  });
}

function runnerResult(accountId: string, status: AccountRunnerResult["status"] = "DRAINED"): AccountRunnerResult {
  return Object.freeze({
    accountId,
    status,
    actions: status === "DRAINED" ? 1 : 0,
    errorCode: status === "HELD_BY_OTHER" ? null : null,
    disconnected: status !== "HELD_BY_OTHER",
    leaseReleased: status !== "HELD_BY_OTHER",
    cleanupErrorCodes: Object.freeze([]),
  });
}

class FakeDiscoveryRepository implements Pick<BroadcastRuntimeAccountRepository, "listDue" | "findNext" | "subscribeWakeups"> {
  accounts: BroadcastRuntimeAccount[] = [];
  listener: RuntimeWakeupListener | null = null;
  subscribeError: unknown = null;
  subscribeErrors = 0;
  closeError: unknown = null;
  listErrors = 0;
  findErrors = 0;
  hideNext = false;
  listCalls = 0;
  findCalls = 0;
  closeCalls = 0;
  subscribeCalls = 0;

  async listDue(input: Parameters<BroadcastRuntimeAccountRepository["listDue"]>[0]) {
    this.listCalls += 1;
    if (this.listErrors > 0) {
      this.listErrors -= 1;
      throw new Error("raw list detail");
    }
    return this.accounts
      .filter((item) => Date.parse(item.nextDueAt) <= Date.now())
      .slice(0, input.limit);
  }

  async findNext() {
    this.findCalls += 1;
    if (this.findErrors > 0) {
      this.findErrors -= 1;
      throw new Error("raw find detail");
    }
    if (this.hideNext) return null;
    return this.accounts.slice().sort((left, right) => Date.parse(left.nextDueAt) - Date.parse(right.nextDueAt))[0] ?? null;
  }

  async subscribeWakeups(listener: RuntimeWakeupListener) {
    this.subscribeCalls += 1;
    if (this.subscribeErrors > 0) {
      this.subscribeErrors -= 1;
      throw new Error("raw listen detail");
    }
    if (this.subscribeError) throw this.subscribeError;
    this.listener = listener;
    return Object.freeze({
      close: async () => {
        this.closeCalls += 1;
        if (this.closeError) throw this.closeError;
        this.listener = null;
      },
    });
  }

  remove(accountId: string) {
    this.accounts = this.accounts.filter((item) => item.accountId !== accountId);
  }

  emit(accountId: string) {
    this.listener?.(accountId);
  }
}

test("invalid policy or shard fails before opening a subscription", async () => {
  const repository = new FakeDiscoveryRepository();
  const dependencies = {
    runtimeAccounts: repository,
    runAccount: async (selected: Pick<BroadcastRuntimeAccount, "accountId">) => runnerResult(selected.accountId),
  };
  await assert.rejects(
    startBroadcastShardSupervisor(dependencies, { shard, policy: { ...policy, maxConcurrentAccounts: 0 } }),
    /INVALID_MAX_CONCURRENT_ACCOUNTS/,
  );
  await assert.rejects(
    startBroadcastShardSupervisor(dependencies, { shard: { shardCount: 2, shardIndex: 2 }, policy }),
    /INVALID_SUPERVISOR_SHARD/,
  );
  assert.equal(repository.subscribeCalls, 0);
});

test("initial reconciliation enforces concurrency and runs each discovered account once", async () => {
  const repository = new FakeDiscoveryRepository();
  repository.accounts = [account("0"), account("2"), account("4"), account("6")];
  const release = deferred<void>();
  const calls: string[] = [];
  let active = 0;
  let peak = 0;
  const handle = await startBroadcastShardSupervisor({
    runtimeAccounts: repository,
    async runAccount(selected) {
      calls.push(selected.accountId);
      repository.remove(selected.accountId);
      active += 1;
      peak = Math.max(peak, active);
      await release.promise;
      active -= 1;
      return runnerResult(selected.accountId);
    },
  }, { shard, policy });

  await waitUntil(() => calls.length === 2);
  await pause(20);
  assert.equal(calls.length, 2);
  assert.equal(active, 2);
  release.resolve();
  await waitUntil(() => handle.snapshot().runsCompleted === 4);
  const summary = await handle.stop();

  assert.equal(peak, 2);
  assert.equal(summary.peakConcurrency, 2);
  assert.equal(summary.runsStarted, 4);
  assert.equal(summary.runsCompleted, 4);
  assert.equal(new Set(calls).size, 4);
  assert.equal(summary.state, "STOPPED");
});

test("duplicate wakeups are coalesced and an in-flight account never overlaps", async () => {
  const repository = new FakeDiscoveryRepository();
  const selected = account("0");
  repository.accounts = [selected];
  const release = deferred<void>();
  let calls = 0;
  const events: AccountSupervisorEvent[] = [];
  const handle = await startBroadcastShardSupervisor({
    runtimeAccounts: repository,
    observer: (event) => { events.push(event); },
    async runAccount(runtimeAccount) {
      calls += 1;
      repository.remove(runtimeAccount.accountId);
      await release.promise;
      return runnerResult(runtimeAccount.accountId);
    },
  }, { shard, policy: { ...policy, maxConcurrentAccounts: 1 } });

  await waitUntil(() => calls === 1);
  repository.emit(selected.accountId);
  repository.emit(selected.accountId);
  repository.emit(selected.accountId);
  repository.emit("invalid");
  repository.emit(account("1").accountId);
  await pause(30);
  assert.equal(calls, 1);
  release.resolve();
  await waitUntil(() => handle.snapshot().runsCompleted === 1);
  const summary = await handle.stop();

  assert.equal(summary.wakeupsAccepted, 3);
  assert.equal(summary.wakeupsIgnored, 2);
  assert.equal(events.filter((event) => event.type === "ACCOUNT_RUN_STARTED").length, 1);
  assert.deepEqual(
    events.filter((event) => event.type === "WAKEUP_IGNORED").map((event) => event.errorCode).sort(),
    ["INVALID_ACCOUNT_ID", "WRONG_SHARD"],
  );
});

test("periodic reconciliation finds committed work even when no wakeup arrives", async () => {
  const repository = new FakeDiscoveryRepository();
  repository.hideNext = true;
  let calls = 0;
  const handle = await startBroadcastShardSupervisor({
    runtimeAccounts: repository,
    async runAccount(selected) {
      calls += 1;
      repository.remove(selected.accountId);
      return runnerResult(selected.accountId);
    },
  }, { shard, policy: { ...policy, reconciliationIntervalMilliseconds: 15 } });

  await waitUntil(() => repository.listCalls >= 1);
  repository.accounts = [account("2")];
  await waitUntil(() => calls === 1);
  const summary = await handle.stop();
  assert.equal(summary.runsCompleted, 1);
  assert.ok(repository.listCalls >= 2);
  assert.equal(summary.wakeupsAccepted, 0);
});

test("invalid and wrong-shard discovery rows never reach the runner", async () => {
  const repository = new FakeDiscoveryRepository();
  const invalid = { ...account("0"), accountId: "not-a-uuid" } as unknown as BroadcastRuntimeAccount;
  repository.accounts = [invalid, account("1")];
  const events: AccountSupervisorEvent[] = [];
  let calls = 0;
  const handle = await startBroadcastShardSupervisor({
    runtimeAccounts: repository,
    observer: (event) => { events.push(event); },
    async runAccount(selected) {
      calls += 1;
      return runnerResult(selected.accountId);
    },
  }, { shard, policy });

  await waitUntil(() => events.filter((event) => event.type === "DISCOVERY_ACCOUNT_REJECTED").length >= 2);
  const summary = await handle.stop();
  assert.equal(calls, 0);
  assert.equal(summary.runsStarted, 0);
  assert.ok(summary.discoveryAccountsRejected >= 2);
  assert.ok(events.some((event) => event.type === "DISCOVERY_ACCOUNT_REJECTED" && event.errorCode === "INVALID_DISCOVERY_ACCOUNT"));
  assert.ok(events.some((event) => event.type === "DISCOVERY_ACCOUNT_REJECTED" && event.errorCode === "WRONG_SHARD"));
});

test("invalid runner result is rejected before raw detail can reach observers", async () => {
  const repository = new FakeDiscoveryRepository();
  repository.accounts = [account("2")];
  const events: AccountSupervisorEvent[] = [];
  const handle = await startBroadcastShardSupervisor({
    runtimeAccounts: repository,
    observer: (event) => { events.push(event); },
    async runAccount(selected) {
      repository.remove(selected.accountId);
      return {
        ...runnerResult(selected.accountId, "FAILED"),
        errorCode: "raw provider phone detail",
      } as AccountRunnerResult;
    },
  }, { shard, policy });

  await waitUntil(() => handle.snapshot().runsCompleted === 1);
  const summary = await handle.stop();
  assert.equal(summary.runnerFailures, 1);
  assert.ok(events.some((event) => event.type === "ACCOUNT_RUNNER_FAILED" && event.errorCode === "INVALID_RUNNER_RESULT"));
  assert.equal(events.some((event) => event.type === "ACCOUNT_RUN_FINISHED"), false);
  assert.equal(JSON.stringify(events).includes("raw provider phone detail"), false);
});

test("subscription, scan, runner, and observer failures remain isolated and redacted", async () => {
  const repository = new FakeDiscoveryRepository();
  repository.accounts = [account("4")];
  repository.subscribeErrors = 1;
  repository.listErrors = 1;
  const handle = await startBroadcastShardSupervisor({
    runtimeAccounts: repository,
    observer: () => { throw new Error("raw observer detail"); },
    async runAccount(selected) {
      repository.remove(selected.accountId);
      throw new Error("raw runner detail");
    },
  }, { shard, policy: { ...policy, reconciliationIntervalMilliseconds: 10, subscriptionRetryMilliseconds: 10 } });

  await waitUntil(() => handle.snapshot().runsCompleted === 1 && repository.subscribeCalls >= 2);
  const summary = await handle.stop();
  assert.equal(summary.subscriptionFailures, 1);
  assert.ok(repository.subscribeCalls >= 2);
  assert.ok(summary.discoveryFailures >= 1);
  assert.equal(summary.runnerFailures, 1);
  assert.ok(summary.observerFailures >= 1);
  assert.equal(JSON.stringify(summary).includes("raw"), false);
});

test("contended account is locally deferred instead of creating a hot loop", async () => {
  const repository = new FakeDiscoveryRepository();
  repository.accounts = [account("6")];
  let calls = 0;
  const handle = await startBroadcastShardSupervisor({
    runtimeAccounts: repository,
    async runAccount(selected) {
      calls += 1;
      return runnerResult(selected.accountId, "HELD_BY_OTHER");
    },
  }, { shard, policy: { ...policy, maxConcurrentAccounts: 1, reconciliationIntervalMilliseconds: 10, contendedAccountRetryMilliseconds: 120 } });

  await waitUntil(() => handle.snapshot().runsCompleted === 1);
  await pause(40);
  assert.equal(calls, 1);
  const summary = await handle.stop();
  assert.equal(summary.runsStarted, 1);
});

test("budget exhaustion is eligible for another bounded run instead of being deferred", async () => {
  const repository = new FakeDiscoveryRepository();
  repository.accounts = [account("4")];
  let calls = 0;
  const handle = await startBroadcastShardSupervisor({
    runtimeAccounts: repository,
    async runAccount(selected) {
      calls += 1;
      if (calls === 1) return runnerResult(selected.accountId, "BUDGET_EXHAUSTED");
      repository.remove(selected.accountId);
      return runnerResult(selected.accountId);
    },
  }, { shard, policy: { ...policy, maxConcurrentAccounts: 1 } });

  await waitUntil(() => handle.snapshot().runsCompleted === 2);
  const summary = await handle.stop();
  assert.equal(calls, 2);
  assert.equal(summary.runnerFailures, 0);
});

test("stop is idempotent, starts no pending work, and waits for the active runner", async () => {
  const repository = new FakeDiscoveryRepository();
  repository.accounts = [account("0"), account("2")];
  repository.closeError = new Error("raw close detail");
  const release = deferred<void>();
  let calls = 0;
  const handle = await startBroadcastShardSupervisor({
    runtimeAccounts: repository,
    async runAccount(selected) {
      calls += 1;
      repository.remove(selected.accountId);
      await release.promise;
      return runnerResult(selected.accountId);
    },
  }, { shard, policy: { ...policy, maxConcurrentAccounts: 1 } });

  await waitUntil(() => calls === 1);
  const firstStop = handle.stop();
  const secondStop = handle.stop();
  assert.equal(firstStop, secondStop);
  assert.equal(handle.snapshot().state, "STOPPING");
  repository.emit(account("2").accountId);
  await pause(20);
  assert.equal(calls, 1);
  let stopped = false;
  void firstStop.then(() => { stopped = true; });
  await pause(10);
  assert.equal(stopped, false);

  release.resolve();
  const summary = await firstStop;
  assert.equal(summary.state, "STOPPED");
  assert.equal(summary.runsStarted, 1);
  assert.equal(summary.inFlightAccounts, 0);
  assert.equal(summary.pendingAccounts, 0);
  assert.deepEqual(summary.cleanupErrorCodes, ["WAKEUP_SUBSCRIPTION_CLOSE_FAILED"]);
  assert.equal(repository.closeCalls, 1);
  assert.throws(() => { (summary as { runsStarted: number }).runsStarted = 99; }, TypeError);
});
