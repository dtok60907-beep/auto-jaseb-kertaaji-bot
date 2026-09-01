import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";

import {
  TelegramSessionCryptoError,
} from "../../../packages/telegram-session-crypto/src/index.ts";
import {
  TelegramAdapterError,
  telegramDeliveryReceipt,
  type TelegramDeliveryAdapter,
} from "../../../packages/telegram-contract/src/index.ts";
import type {
  AccountRunnerDependencies,
  AccountRunnerPolicy,
  RuntimeRepeatingTaskHandle,
  RuntimeRepeatingTaskScheduler,
  TelegramRuntimeAdapterFactory,
} from "../src/account-runner/contracts.ts";
import { runBroadcastAccount } from "../src/account-runner/service.ts";
import { SerialRuntimeRepeatingTaskScheduler } from "../src/account-runner/serial-scheduler.ts";
import { TeleprotoRuntimeAdapterFactory } from "../src/account-runner/teleproto-factory.ts";
import type {
  AutoCommentMatcherRepository,
  ClaimedAutoCommentMonitoringTarget,
} from "../src/auto-comment-matcher/repository.ts";
import type {
  AutoCommentPreparationRepository,
  ClaimedAutoCommentPreparation,
} from "../src/auto-comment-preparation/repository.ts";
import type {
  BroadcastExecutorRepository,
  ClaimedBroadcastCommand,
} from "../src/broadcast-executor/repository.ts";
import type {
  BroadcastPreparationRepository,
  ClaimedBroadcastPreparation,
} from "../src/broadcast-preparation/repository.ts";
import type {
  BroadcastRuntimeAccountRepository,
  LeasedTelegramSession,
  TelegramRuntimeResult,
} from "../src/runtime-accounts/repository.ts";
import type {
  AccountLease,
  AccountLeaseAcquisition,
  RuntimeAccountLeaseRepository,
} from "../src/runtime-leases/repository.ts";

const account = {
  accountId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  accountType: "USERBOT" as const,
};
const leaseOwner = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const policy: AccountRunnerPolicy = Object.freeze({
  leaseSeconds: 120,
  heartbeatIntervalMilliseconds: 30_000,
  maxActionsPerRun: 10,
  commandLeaseSeconds: 60,
  runtimeRetrySeconds: 15,
});

const lease = Object.freeze({
  accountId: account.accountId,
  leaseOwner,
  fencingToken: 7n,
  leaseUntil: "2030-01-01T00:02:00.000Z",
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class ManualScheduler implements RuntimeRepeatingTaskScheduler {
  task: (() => Promise<"CONTINUE" | "STOP">) | null = null;
  starts = 0;
  stops = 0;
  stopError: unknown = null;
  startError: unknown = null;

  start(_intervalMilliseconds: number, task: () => Promise<"CONTINUE" | "STOP">): RuntimeRepeatingTaskHandle {
    this.starts += 1;
    if (this.startError) throw this.startError;
    this.task = task;
    return {
      stop: async () => {
        this.stops += 1;
        if (this.stopError) throw this.stopError;
      },
    };
  }

  async tick() {
    if (!this.task) throw new Error("SCHEDULER_NOT_STARTED");
    return this.task();
  }
}

class FakeLeaseRepository implements RuntimeAccountLeaseRepository {
  acquisition: AccountLeaseAcquisition = { status: "ACQUIRED", lease };
  renewResult: AccountLease | null = lease;
  renewError: unknown = null;
  releaseResult = true;
  releaseError: unknown = null;
  acquireCalls = 0;
  renewCalls = 0;
  releaseCalls = 0;

  async acquire() {
    this.acquireCalls += 1;
    return this.acquisition;
  }
  async renew() {
    this.renewCalls += 1;
    if (this.renewError) throw this.renewError;
    return this.renewResult;
  }
  async release() {
    this.releaseCalls += 1;
    if (this.releaseError) throw this.releaseError;
    return this.releaseResult;
  }
}

class FakeRuntimeRepository implements BroadcastRuntimeAccountRepository {
  session: LeasedTelegramSession | null = {
    accountId: account.accountId,
    accountType: account.accountType,
    encryptedSession: Uint8Array.from([1, 2, 3, 4]),
    encryptionKeyVersion: 1,
  };
  recordAllowed = true;
  loadError: unknown = null;
  recordError: unknown = null;
  loadCalls = 0;
  records: TelegramRuntimeResult[] = [];

  async listDue() { return []; }
  async findNext() { return null; }
  async loadSession() {
    this.loadCalls += 1;
    if (this.loadError) throw this.loadError;
    return this.session;
  }
  async recordResult(input: Parameters<BroadcastRuntimeAccountRepository["recordResult"]>[0]) {
    if (this.recordError) throw this.recordError;
    this.records.push(input.result);
    return this.recordAllowed;
  }
  async subscribeWakeups() { return { close: async () => undefined }; }
}

class FakePreparationRepository implements BroadcastPreparationRepository {
  claims: Array<ClaimedBroadcastPreparation | null> = [null];
  claimCalls = 0;
  transitions: Array<Parameters<BroadcastPreparationRepository["transition"]>[0]> = [];

  async claimNext() {
    this.claimCalls += 1;
    return this.claims.length ? this.claims.shift() ?? null : null;
  }
  async transition(input: Parameters<BroadcastPreparationRepository["transition"]>[0]) {
    this.transitions.push(input);
    return true;
  }
}

class FakeAutoCommentPreparationRepository implements AutoCommentPreparationRepository {
  claims: Array<ClaimedAutoCommentPreparation | null> = [null];
  claimCalls = 0;
  transitions: Array<Parameters<AutoCommentPreparationRepository["transition"]>[0]> = [];

  async claimNext() {
    this.claimCalls += 1;
    return this.claims.length ? this.claims.shift() ?? null : null;
  }
  async transition(input: Parameters<AutoCommentPreparationRepository["transition"]>[0]) {
    this.transitions.push(input);
    return true;
  }
}

class FakeAutoCommentMatcherRepository implements AutoCommentMatcherRepository {
  claims: Array<ClaimedAutoCommentMonitoringTarget | null> = [null];
  claimCalls = 0;
  advanceCalls: Array<Parameters<AutoCommentMatcherRepository["advanceCheckpoint"]>[0]> = [];

  async claimNext() {
    this.claimCalls += 1;
    return this.claims.length ? this.claims.shift() ?? null : null;
  }
  async divisionsFor() { return []; }
  async createCandidate(): Promise<never> { throw new Error("unused"); }
  async advanceCheckpoint(input: Parameters<AutoCommentMatcherRepository["advanceCheckpoint"]>[0]) {
    this.advanceCalls.push(input);
    return true;
  }
}

function command(id: string): ClaimedBroadcastCommand {
  return Object.freeze({
    id,
    operationId: `operation-${id}`,
    accountId: account.accountId,
    kind: "SEND_TEXT",
    targetRef: "@lpm_target",
    payload: Object.freeze({ material: Object.freeze({ kind: "TEXT", text: "promo" }) }),
    attemptCount: 1,
    fencingToken: 7n,
    leaseUntil: "2030-01-01T00:01:00.000Z",
  });
}

class FakeExecutorRepository implements BroadcastExecutorRepository {
  claims: Array<ClaimedBroadcastCommand | null> = [null];
  endless = false;
  claimCalls = 0;
  finishResult = true;
  finishes: Array<Parameters<BroadcastExecutorRepository["finish"]>[0]> = [];

  async claimNext() {
    this.claimCalls += 1;
    if (this.endless) return command(`command-${this.claimCalls}`);
    return this.claims.length ? this.claims.shift() ?? null : null;
  }
  async finish(input: Parameters<BroadcastExecutorRepository["finish"]>[0]) {
    this.finishes.push(input);
    return this.finishResult;
  }
}

class FakeAdapter implements TelegramDeliveryAdapter {
  state: TelegramDeliveryAdapter["state"] = "NEW";
  connectCalls = 0;
  disconnectCalls = 0;
  resolveCalls = 0;
  sendCalls = 0;
  connectError: unknown = null;
  disconnectError: unknown = null;
  resolveError: unknown = null;
  sendError: unknown = null;
  sendPromise: Promise<void> | null = null;
  connectPromise: Promise<void> | null = null;

  async connect() {
    this.connectCalls += 1;
    if (this.connectPromise) await this.connectPromise;
    if (this.connectError) throw this.connectError;
    this.state = "READY";
  }
  async disconnect() {
    this.disconnectCalls += 1;
    if (this.disconnectError) throw this.disconnectError;
    this.state = "DISCONNECTED";
  }
  async resolveTarget(targetRef: string) {
    this.resolveCalls += 1;
    if (this.resolveError) throw this.resolveError;
    return { canonicalRef: targetRef, entityType: "SUPERGROUP" as const, membership: "MEMBER" as const, title: null };
  }
  async resolveLinkedDiscussion(sourceChannelRef: string) {
    return {
      source: { canonicalRef: sourceChannelRef, entityType: "CHANNEL" as const, membership: "MEMBER" as const, title: null },
      discussion: { canonicalRef: "@discussion", entityType: "SUPERGROUP" as const, membership: "MEMBER" as const, title: null },
    };
  }
  async joinPublicTarget() { return { state: "ALREADY_MEMBER" as const }; }
  async sendText() {
    this.sendCalls += 1;
    if (this.sendPromise) await this.sendPromise;
    if (this.sendError) throw this.sendError;
    return telegramDeliveryReceipt([String(100 + this.sendCalls)], "2030-01-01T00:00:01.000Z");
  }
  async forwardNative() { return telegramDeliveryReceipt(["200"], "2030-01-01T00:00:01.000Z"); }
  async listNewChannelPosts() { return []; }
  async latestChannelPostId() { return null; }
}

class FakeAdapterFactory implements TelegramRuntimeAdapterFactory {
  readonly adapter: FakeAdapter;
  calls = 0;
  receivedSession: string | null = null;
  createError: unknown = null;

  constructor(adapter = new FakeAdapter()) { this.adapter = adapter; }
  create(input: Parameters<TelegramRuntimeAdapterFactory["create"]>[0]) {
    this.calls += 1;
    this.receivedSession = input.session;
    if (this.createError) throw this.createError;
    return this.adapter;
  }
}

function harness(input: Readonly<{
  autoCommentPreparations?: FakeAutoCommentPreparationRepository;
  autoCommentMatcher?: FakeAutoCommentMatcherRepository;
}> = {}) {
  const runtimeAccounts = new FakeRuntimeRepository();
  const accountLeases = new FakeLeaseRepository();
  const preparations = new FakePreparationRepository();
  const executor = new FakeExecutorRepository();
  const adapterFactory = new FakeAdapterFactory();
  const scheduler = new ManualScheduler();
  const autoCommentPreparations = input.autoCommentPreparations;
  const autoCommentMatcher = input.autoCommentMatcher;
  let decryptCalls = 0;
  const sessionKeyRing = {
    decrypt(context: unknown, encrypted: unknown) {
      decryptCalls += 1;
      assert.deepEqual(context, { accountId: account.accountId, accountType: account.accountType });
      assert.ok(encrypted);
      return "session-secret";
    },
  };
  const dependencies: AccountRunnerDependencies = {
    runtimeAccounts,
    accountLeases,
    preparations,
    executor,
    sessionKeyRing,
    adapterFactory,
    scheduler,
    ...(autoCommentPreparations ? { autoCommentPreparations } : {}),
    ...(autoCommentMatcher ? { autoCommentMatcher } : {}),
  };
  return {
    dependencies,
    runtimeAccounts,
    accountLeases,
    preparations,
    executor,
    adapterFactory,
    scheduler,
    autoCommentPreparations,
    autoCommentMatcher,
    decryptCalls: () => decryptCalls,
  };
}

function run(input = harness(), overridePolicy: Partial<AccountRunnerPolicy> = {}) {
  return runBroadcastAccount(input.dependencies, {
    account,
    leaseOwner,
    policy: Object.freeze({ ...policy, ...overridePolicy }),
  });
}

test("held lease never loads or decrypts a session", async () => {
  const context = harness();
  context.accountLeases.acquisition = { status: "HELD_BY_OTHER" };
  const result = await run(context);
  assert.equal(result.status, "HELD_BY_OTHER");
  assert.equal(context.runtimeAccounts.loadCalls, 0);
  assert.equal(context.decryptCalls(), 0);
  assert.equal(context.adapterFactory.calls, 0);
  assert.equal(context.scheduler.starts, 0);
  assert.equal(context.accountLeases.releaseCalls, 0);
});

test("invalid policy has no side effects and scheduler start failure releases the lease", async () => {
  const invalid = harness();
  await assert.rejects(() => run(invalid, { leaseSeconds: 1 }), /INVALID_ACCOUNT_LEASE_SECONDS/);
  assert.equal(invalid.accountLeases.acquireCalls, 0);
  assert.equal(invalid.runtimeAccounts.loadCalls, 0);

  const unavailableScheduler = harness();
  unavailableScheduler.scheduler.startError = new Error("raw scheduler detail");
  const result = await run(unavailableScheduler);
  assert.equal(result.status, "FAILED");
  assert.equal(result.errorCode, "ACCOUNT_RUNNER_FAILED");
  assert.equal(unavailableScheduler.runtimeAccounts.loadCalls, 0);
  assert.equal(unavailableScheduler.accountLeases.releaseCalls, 1);
  assert.equal(result.leaseReleased, true);
  assert.equal(JSON.stringify(result).includes("raw scheduler detail"), false);
});

test("account that stops being runnable after lease acquisition is released without decryption", async () => {
  const context = harness();
  context.runtimeAccounts.session = null;
  const result = await run(context);
  assert.equal(result.status, "NOT_RUNNABLE");
  assert.equal(context.decryptCalls(), 0);
  assert.equal(context.adapterFactory.calls, 0);
  assert.equal(context.scheduler.stops, 1);
  assert.equal(context.accountLeases.releaseCalls, 1);
});

test("happy path drains preparation and delivery then cleans up in order", async () => {
  const context = harness();
  const encrypted = context.runtimeAccounts.session!.encryptedSession;
  context.preparations.claims = [{
    targetId: "target-1",
    operationId: "operation-1",
    telegramTargetRef: "@lpm_target",
    previousStatus: "QUEUED",
  }, null];
  context.executor.claims = [command("command-1"), null];

  const result = await run(context);
  assert.deepEqual(result, {
    accountId: account.accountId,
    status: "DRAINED",
    actions: 2,
    errorCode: null,
    disconnected: true,
    leaseReleased: true,
    cleanupErrorCodes: [],
  });
  assert.equal(context.decryptCalls(), 1);
  assert.equal(context.adapterFactory.receivedSession, "session-secret");
  assert.deepEqual([...encrypted], [0, 0, 0, 0]);
  assert.equal(context.adapterFactory.adapter.connectCalls, 1);
  assert.equal(context.adapterFactory.adapter.resolveCalls, 1);
  assert.equal(context.adapterFactory.adapter.sendCalls, 1);
  assert.equal(context.adapterFactory.adapter.disconnectCalls, 1);
  assert.deepEqual(context.runtimeAccounts.records, [{ status: "CONNECTED" }, { status: "DISCONNECTED" }]);
  assert.deepEqual(context.preparations.transitions.map((item) => item.status), ["READY"]);
  assert.equal(context.executor.finishes[0]?.outcome.status, "SUCCEEDED");
  assert.equal(context.scheduler.stops, 1);
  assert.equal(context.accountLeases.releaseCalls, 1);
});

test("auto-comment discussion preparation only runs once broadcast work is exhausted, and counts toward the budget", async () => {
  const autoCommentPreparations = new FakeAutoCommentPreparationRepository();
  autoCommentPreparations.claims = [{
    channelTargetId: "channel-target-1",
    sourceChannelRef: "@menfess",
    discussionTargetRef: null,
    previousStatus: "QUEUED",
  }, null];
  const context = harness({ autoCommentPreparations });

  const result = await run(context);
  assert.deepEqual(result, {
    accountId: account.accountId,
    status: "DRAINED",
    actions: 1,
    errorCode: null,
    disconnected: true,
    leaseReleased: true,
    cleanupErrorCodes: [],
  });
  assert.equal(context.preparations.claimCalls, 2);
  assert.equal(context.executor.claimCalls, 2);
  assert.equal(autoCommentPreparations.claimCalls, 2);
  assert.deepEqual(autoCommentPreparations.transitions.map((item) => item.status), ["READY"]);
});

test("broadcast dependencies alone (no autoCommentPreparations) behave exactly as before", async () => {
  const context = harness();
  const result = await run(context);
  assert.equal(result.status, "DRAINED");
  assert.equal(result.actions, 0);
});

test("auto-comment channel monitoring only runs once broadcast and discussion-preparation work is exhausted, and counts toward the budget", async () => {
  const autoCommentMatcher = new FakeAutoCommentMatcherRepository();
  autoCommentMatcher.claims = [{
    channelTargetId: "channel-target-1",
    sourceChannelRef: "@menfess",
    discussionTargetRef: "@menfess_discussion",
    monitoringLastPostId: null,
  }, null];
  const context = harness({ autoCommentMatcher });

  const result = await run(context);
  assert.deepEqual(result, {
    accountId: account.accountId,
    status: "DRAINED",
    actions: 1,
    errorCode: null,
    disconnected: true,
    leaseReleased: true,
    cleanupErrorCodes: [],
  });
  assert.equal(context.preparations.claimCalls, 2);
  assert.equal(context.executor.claimCalls, 2);
  assert.equal(autoCommentMatcher.claimCalls, 2);
});

test("broadcast dependencies alone (no autoCommentMatcher) behave exactly as before", async () => {
  const context = harness();
  const result = await run(context);
  assert.equal(result.status, "DRAINED");
  assert.equal(result.actions, 0);
});

test("heartbeat lease loss while connecting prevents state and workflow writes", async () => {
  const context = harness();
  const connecting = deferred<void>();
  context.adapterFactory.adapter.connectPromise = connecting.promise;
  context.accountLeases.renewResult = null;

  const running = run(context);
  while (context.adapterFactory.adapter.connectCalls === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await context.scheduler.tick(), "STOP");
  connecting.resolve();
  const result = await running;

  assert.equal(result.status, "FENCED_OUT");
  assert.equal(result.errorCode, "ACCOUNT_LEASE_LOST");
  assert.equal(context.runtimeAccounts.records.length, 0);
  assert.equal(context.preparations.claimCalls, 0);
  assert.equal(context.executor.claimCalls, 0);
  assert.equal(context.adapterFactory.adapter.disconnectCalls, 1);
});

test("lease loss while sending rejects stale completion through command fencing", async () => {
  const context = harness();
  const sending = deferred<void>();
  context.executor.claims = [command("in-flight")];
  context.executor.finishResult = false;
  context.adapterFactory.adapter.sendPromise = sending.promise;
  context.accountLeases.renewResult = null;

  const running = run(context);
  while (context.adapterFactory.adapter.sendCalls === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await context.scheduler.tick(), "STOP");
  sending.resolve();
  const result = await running;

  assert.equal(result.status, "FENCED_OUT");
  assert.equal(result.errorCode, "COMMAND_FENCED");
  assert.equal(result.actions, 1);
  assert.equal(context.executor.finishes[0]?.outcome.status, "SUCCEEDED");
  assert.equal(context.executor.finishResult, false);
});

test("repository lease rejection maps to fencing instead of a generic load failure", async () => {
  const context = harness();
  context.runtimeAccounts.loadError = new Error("ACCOUNT_LEASE_NOT_HELD");
  const result = await run(context);
  assert.equal(result.status, "FENCED_OUT");
  assert.equal(result.errorCode, "ACCOUNT_LEASE_LOST");
  assert.equal(context.decryptCalls(), 0);
  assert.equal(context.accountLeases.releaseCalls, 1);
});

test("session key absence retries while authenticated-envelope failure degrades", async () => {
  const missingKey = harness();
  missingKey.dependencies.sessionKeyRing.decrypt = () => { throw new TelegramSessionCryptoError("SESSION_KEY_NOT_FOUND"); };
  const retry = await run(missingKey);
  assert.equal(retry.status, "RETRY_SCHEDULED");
  assert.equal(retry.errorCode, "SESSION_KEY_NOT_FOUND");
  assert.deepEqual(missingKey.runtimeAccounts.records, [{
    status: "FAILED_RETRYABLE",
    errorCode: "SESSION_KEY_NOT_FOUND",
    retryAfterSeconds: 15,
  }]);
  assert.equal(missingKey.adapterFactory.calls, 0);

  const tampered = harness();
  tampered.dependencies.sessionKeyRing.decrypt = () => { throw new TelegramSessionCryptoError("SESSION_AUTH_FAILED"); };
  const degraded = await run(tampered);
  assert.equal(degraded.status, "ACCOUNT_DEGRADED");
  assert.equal(degraded.errorCode, "SESSION_AUTH_FAILED");
  assert.deepEqual(tampered.runtimeAccounts.records, [{ status: "DEGRADED", errorCode: "SESSION_AUTH_FAILED" }]);
});

test("invalid session context and invalid Teleproto session degrade without a retry loop", async () => {
  const wrongContext = harness();
  const encrypted = wrongContext.runtimeAccounts.session!.encryptedSession;
  wrongContext.runtimeAccounts.session = {
    ...wrongContext.runtimeAccounts.session!,
    accountId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
  };
  const mismatched = await run(wrongContext);
  assert.equal(mismatched.status, "ACCOUNT_DEGRADED");
  assert.equal(mismatched.errorCode, "INVALID_SESSION_CONTEXT");
  assert.deepEqual([...encrypted], [0, 0, 0, 0]);
  assert.equal(wrongContext.decryptCalls(), 0);

  const invalidSession = harness();
  invalidSession.adapterFactory.createError = new Error("provider parser detail");
  const invalid = await run(invalidSession);
  assert.equal(invalid.status, "ACCOUNT_DEGRADED");
  assert.equal(invalid.errorCode, "INVALID_TELEGRAM_SESSION");
  assert.deepEqual(invalidSession.runtimeAccounts.records, [{
    status: "DEGRADED",
    errorCode: "INVALID_TELEGRAM_SESSION",
  }]);
  assert.equal(JSON.stringify(invalid).includes("provider parser detail"), false);
});

test("connect errors become retry, revoked, or degraded account state", async () => {
  const cases = [
    {
      error: new TelegramAdapterError({ code: "TELEGRAM_TRANSIENT", retryable: true, retryAfterSeconds: 77 }),
      status: "RETRY_SCHEDULED",
      state: { status: "FAILED_RETRYABLE", errorCode: "TELEGRAM_TRANSIENT", retryAfterSeconds: 77 },
    },
    {
      error: new TelegramAdapterError({ code: "SESSION_REVOKED", retryable: false }),
      status: "ACCOUNT_REVOKED",
      state: { status: "REVOKED", errorCode: "SESSION_REVOKED" },
    },
    {
      error: new TelegramAdapterError({ code: "SESSION_CONFLICT", retryable: false }),
      status: "ACCOUNT_DEGRADED",
      state: { status: "DEGRADED", errorCode: "SESSION_CONFLICT" },
    },
  ] as const;

  for (const item of cases) {
    const context = harness();
    context.adapterFactory.adapter.connectError = item.error;
    const result = await run(context);
    assert.equal(result.status, item.status);
    assert.deepEqual(context.runtimeAccounts.records, [item.state, { status: "DISCONNECTED" }]);
    assert.equal(context.preparations.claimCalls, 0);
    assert.equal(context.accountLeases.releaseCalls, 1);
  }
});

test("action budget is explicit and prevents one account from monopolizing a run", async () => {
  const context = harness();
  context.executor.endless = true;
  const result = await run(context, { maxActionsPerRun: 2 });
  assert.equal(result.status, "BUDGET_EXHAUSTED");
  assert.equal(result.actions, 2);
  assert.equal(context.executor.claimCalls, 2);
  assert.equal(context.executor.finishes.length, 2);
  assert.equal(context.adapterFactory.adapter.sendCalls, 2);
});

test("retry and uncertain delivery stop further account work", async () => {
  const retrying = harness();
  retrying.executor.claims = [command("retry-1"), command("must-not-run")];
  retrying.adapterFactory.adapter.sendError = new TelegramAdapterError({ code: "FLOOD_WAIT", retryable: true, retryAfterSeconds: 90 });
  const retry = await run(retrying);
  assert.equal(retry.status, "RETRY_SCHEDULED");
  assert.equal(retry.actions, 1);
  assert.equal(retrying.executor.claimCalls, 1);
  assert.deepEqual(retrying.runtimeAccounts.records, [
    { status: "CONNECTED" },
    { status: "FAILED_RETRYABLE", errorCode: "FLOOD_WAIT", retryAfterSeconds: 90 },
    { status: "DISCONNECTED" },
  ]);

  const uncertain = harness();
  uncertain.executor.claims = [command("uncertain-1"), command("must-not-run")];
  uncertain.adapterFactory.adapter.sendError = new TelegramAdapterError({
    code: "TELEGRAM_TRANSIENT",
    retryable: true,
    sideEffectState: "UNKNOWN",
  });
  const unknown = await run(uncertain);
  assert.equal(unknown.status, "SIDE_EFFECT_UNCERTAIN");
  assert.equal(unknown.actions, 1);
  assert.equal(uncertain.executor.claimCalls, 1);
});

test("cleanup failures remain visible without replacing the drain result", async () => {
  const context = harness();
  context.adapterFactory.adapter.disconnectError = new Error("raw disconnect detail");
  context.scheduler.stopError = new Error("raw scheduler detail");
  context.accountLeases.releaseError = new Error("raw release detail");
  const result = await run(context);
  assert.equal(result.status, "DRAINED");
  assert.equal(result.errorCode, null);
  assert.equal(result.disconnected, false);
  assert.equal(result.leaseReleased, false);
  assert.deepEqual(result.cleanupErrorCodes, [
    "ADAPTER_DISCONNECT_FAILED",
    "HEARTBEAT_STOP_FAILED",
    "LEASE_RELEASE_FAILED",
  ]);
  assert.equal(JSON.stringify(result).includes("raw"), false);
});

test("serial scheduler never overlaps heartbeats and stops idempotently", async () => {
  const scheduler = new SerialRuntimeRepeatingTaskScheduler();
  const firstStarted = deferred<void>();
  const releaseFirst = deferred<void>();
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  const handle = scheduler.start(2, async () => {
    calls += 1;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    if (calls === 1) {
      firstStarted.resolve();
      await releaseFirst.promise;
    }
    active -= 1;
    return calls >= 2 ? "STOP" : "CONTINUE";
  });

  await firstStarted.promise;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 1);
  assert.equal(maximumActive, 1);
  releaseFirst.resolve();
  while (calls < 2) await new Promise((resolve) => setImmediate(resolve));
  await handle.stop();
  await handle.stop();
  assert.equal(maximumActive, 1);
});

test("production Teleproto factory redacts API hash and creates a new adapter", () => {
  const serverAddress = Buffer.from("149.154.167.50");
  const serverAddressLength = Buffer.alloc(2);
  serverAddressLength.writeInt16BE(serverAddress.length);
  const port = Buffer.alloc(2);
  port.writeInt16BE(443);
  const testSession = `1${Buffer.concat([
    Buffer.from([2]),
    serverAddressLength,
    serverAddress,
    port,
    Buffer.alloc(256, 7),
  ]).toString("base64")}`;
  const factory = new TeleprotoRuntimeAdapterFactory({
    apiId: 12345,
    apiHash: "api-hash-secret",
    operationTimeoutMilliseconds: 30_000,
  });
  assert.equal(String(factory), "TeleprotoRuntimeAdapterFactory(redacted, apiId=12345)");
  assert.equal(inspect(factory), "TeleprotoRuntimeAdapterFactory(redacted, apiId=12345)");
  assert.equal(JSON.stringify(factory).includes("api-hash-secret"), false);
  assert.deepEqual(Object.keys(factory), ["apiId", "operationTimeoutMilliseconds"]);
  const adapter = factory.create({ ...account, session: testSession });
  assert.equal(adapter.state, "NEW");
  assert.equal(JSON.stringify(adapter).includes(testSession), false);
  assert.equal(inspect(adapter).includes(testSession), false);
});
