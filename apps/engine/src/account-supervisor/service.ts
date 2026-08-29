import type { AccountRunnerResult } from "../account-runner/contracts.ts";
import type { BroadcastRuntimeAccount, RuntimeWakeupSubscription } from "../runtime-accounts/repository.ts";
import { shardOwnsAccount } from "../runtime-sharding/shard.ts";
import type {
  AccountSupervisorDependencies,
  AccountSupervisorEvent,
  AccountSupervisorHandle,
  AccountSupervisorPolicy,
  AccountSupervisorSnapshot,
  AccountSupervisorState,
  AccountSupervisorSummary,
} from "./contracts.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLIC_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const RUNNER_STATUSES = new Set<AccountRunnerResult["status"]>([
  "HELD_BY_OTHER",
  "NOT_RUNNABLE",
  "DRAINED",
  "BUDGET_EXHAUSTED",
  "RETRY_SCHEDULED",
  "ACCOUNT_DEGRADED",
  "ACCOUNT_REVOKED",
  "SIDE_EFFECT_UNCERTAIN",
  "FENCED_OUT",
  "FAILED",
]);

class CoalescingSignal {
  #pending = false;
  #waiter: (() => void) | null = null;

  notify(): void {
    if (this.#waiter) {
      const waiter = this.#waiter;
      this.#waiter = null;
      waiter();
      return;
    }
    this.#pending = true;
  }

  async wait(milliseconds: number): Promise<void> {
    if (this.#pending) {
      this.#pending = false;
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => finish(), milliseconds);
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.#waiter === finish) this.#waiter = null;
        resolve();
      };
      this.#waiter = finish;
      if (this.#pending) {
        this.#pending = false;
        finish();
      }
    });
  }
}

function validatePolicy(policy: AccountSupervisorPolicy): void {
  if (!Number.isInteger(policy.maxConcurrentAccounts) || policy.maxConcurrentAccounts < 1 || policy.maxConcurrentAccounts > 1000) {
    throw new TypeError("INVALID_MAX_CONCURRENT_ACCOUNTS");
  }
  if (!Number.isInteger(policy.discoveryBatchSize) || policy.discoveryBatchSize < 1 || policy.discoveryBatchSize > 1000) {
    throw new TypeError("INVALID_DISCOVERY_BATCH_SIZE");
  }
  for (const [value, code] of [
    [policy.reconciliationIntervalMilliseconds, "INVALID_RECONCILIATION_INTERVAL"],
    [policy.subscriptionRetryMilliseconds, "INVALID_SUBSCRIPTION_RETRY"],
    [policy.contendedAccountRetryMilliseconds, "INVALID_CONTENDED_ACCOUNT_RETRY"],
    [policy.failedAccountRetryMilliseconds, "INVALID_FAILED_ACCOUNT_RETRY"],
  ] as const) {
    if (!Number.isInteger(value) || value < 10 || value > 3_600_000) throw new TypeError(code);
  }
}

function validShard(shard: Readonly<{ shardCount: number; shardIndex: number }>): boolean {
  return Number.isInteger(shard.shardCount)
    && shard.shardCount >= 1
    && shard.shardCount <= 65_536
    && Number.isInteger(shard.shardIndex)
    && shard.shardIndex >= 0
    && shard.shardIndex < shard.shardCount;
}

function validDiscoveryAccount(account: unknown): account is BroadcastRuntimeAccount {
  if (typeof account !== "object" || account === null || Array.isArray(account)) return false;
  const candidate = account as Readonly<Record<string, unknown>>;
  return typeof candidate.accountId === "string"
    && UUID.test(candidate.accountId)
    && (candidate.accountType === "JASEB_WORKER" || candidate.accountType === "USERBOT")
    && typeof candidate.nextDueAt === "string"
    && Number.isFinite(Date.parse(candidate.nextDueAt))
    && typeof candidate.hasPreparationWork === "boolean"
    && typeof candidate.hasDeliveryWork === "boolean"
    && typeof candidate.requiresRecovery === "boolean";
}

function validRunnerResult(result: AccountRunnerResult, accountId: string): boolean {
  return result !== null
    && typeof result === "object"
    && result.accountId === accountId
    && RUNNER_STATUSES.has(result.status)
    && Number.isInteger(result.actions)
    && result.actions >= 0
    && (result.errorCode === null || (typeof result.errorCode === "string" && PUBLIC_CODE.test(result.errorCode)))
    && typeof result.disconnected === "boolean"
    && typeof result.leaseReleased === "boolean"
    && Array.isArray(result.cleanupErrorCodes)
    && result.cleanupErrorCodes.every((code) => typeof code === "string" && PUBLIC_CODE.test(code));
}

function copyRunnerResult(result: AccountRunnerResult): AccountRunnerResult {
  return Object.freeze({
    accountId: result.accountId,
    status: result.status,
    actions: result.actions,
    errorCode: result.errorCode,
    disconnected: result.disconnected,
    leaseReleased: result.leaseReleased,
    cleanupErrorCodes: Object.freeze([...result.cleanupErrorCodes]),
  });
}

export async function startBroadcastShardSupervisor(
  dependencies: AccountSupervisorDependencies,
  input: Readonly<{
    shard: Readonly<{ shardCount: number; shardIndex: number }>;
    policy: AccountSupervisorPolicy;
  }>,
): Promise<AccountSupervisorHandle> {
  validatePolicy(input.policy);
  if (!validShard(input.shard)) throw new TypeError("INVALID_SUPERVISOR_SHARD");

  const shard = Object.freeze({ ...input.shard });
  const signal = new CoalescingSignal();
  const pending = new Map<string, BroadcastRuntimeAccount>();
  const inFlight = new Map<string, Promise<void>>();
  const executions = new Set<Promise<void>>();
  const deferredUntil = new Map<string, number>();
  const cleanupErrorCodes: string[] = [];
  const now = dependencies.now ?? Date.now;
  let state: AccountSupervisorState = "RUNNING";
  let subscription: RuntimeWakeupSubscription | null = null;
  let nextSubscriptionAttemptAt = 0;
  let stopPromise: Promise<AccountSupervisorSummary> | null = null;
  let peakConcurrency = 0;
  let runsStarted = 0;
  let runsCompleted = 0;
  let runnerFailures = 0;
  let discoveryFailures = 0;
  let discoveryAccountsRejected = 0;
  let subscriptionFailures = 0;
  let observerFailures = 0;
  let wakeupsAccepted = 0;
  let wakeupsIgnored = 0;

  const snapshot = (): AccountSupervisorSnapshot => Object.freeze({
    state,
    shard,
    inFlightAccounts: inFlight.size,
    pendingAccounts: pending.size,
    peakConcurrency,
    runsStarted,
    runsCompleted,
    runnerFailures,
    discoveryFailures,
    discoveryAccountsRejected,
    subscriptionFailures,
    observerFailures,
    wakeupsAccepted,
    wakeupsIgnored,
  });

  const summary = (): AccountSupervisorSummary => Object.freeze({
    ...snapshot(),
    cleanupErrorCodes: Object.freeze([...cleanupErrorCodes]),
  });

  const emit = (event: AccountSupervisorEvent): void => {
    if (!dependencies.observer) return;
    try {
      const observed = dependencies.observer(Object.freeze(event));
      if (observed && typeof observed.then === "function") {
        void observed.catch(() => { observerFailures += 1; });
      }
    } catch {
      observerFailures += 1;
    }
  };

  const rejectDiscovery = (account: unknown): boolean => {
    if (!validDiscoveryAccount(account)) {
      discoveryAccountsRejected += 1;
      const accountId = typeof account === "object" && account !== null && "accountId" in account && typeof account.accountId === "string"
        ? account.accountId
        : "";
      emit({ type: "DISCOVERY_ACCOUNT_REJECTED", accountId, errorCode: "INVALID_DISCOVERY_ACCOUNT" });
      return true;
    }
    if (!shardOwnsAccount(account.accountId, shard)) {
      discoveryAccountsRejected += 1;
      emit({ type: "DISCOVERY_ACCOUNT_REJECTED", accountId: account.accountId, errorCode: "WRONG_SHARD" });
      return true;
    }
    return false;
  };

  const applyDeferral = (result: AccountRunnerResult): void => {
    const current = now();
    if (result.status === "HELD_BY_OTHER" || result.status === "FENCED_OUT") {
      deferredUntil.set(result.accountId, current + input.policy.contendedAccountRetryMilliseconds);
    } else if (result.status === "FAILED") {
      deferredUntil.set(result.accountId, current + input.policy.failedAccountRetryMilliseconds);
    } else if (result.status === "NOT_RUNNABLE") {
      deferredUntil.set(result.accountId, current + input.policy.reconciliationIntervalMilliseconds);
    } else {
      deferredUntil.delete(result.accountId);
    }
  };

  const startAccount = (account: BroadcastRuntimeAccount): void => {
    runsStarted += 1;
    emit({ type: "ACCOUNT_RUN_STARTED", accountId: account.accountId, accountType: account.accountType });
    let execution!: Promise<void>;
    execution = Promise.resolve()
      .then(() => dependencies.runAccount(Object.freeze({ accountId: account.accountId, accountType: account.accountType })))
      .then((rawResult) => {
        runsCompleted += 1;
        if (!validRunnerResult(rawResult, account.accountId)) {
          runnerFailures += 1;
          deferredUntil.set(account.accountId, now() + input.policy.failedAccountRetryMilliseconds);
          emit({ type: "ACCOUNT_RUNNER_FAILED", accountId: account.accountId, errorCode: "INVALID_RUNNER_RESULT" });
          return;
        }
        const result = copyRunnerResult(rawResult);
        applyDeferral(result);
        emit({ type: "ACCOUNT_RUN_FINISHED", accountId: account.accountId, result });
      }, () => {
        runsCompleted += 1;
        runnerFailures += 1;
        deferredUntil.set(account.accountId, now() + input.policy.failedAccountRetryMilliseconds);
        emit({ type: "ACCOUNT_RUNNER_FAILED", accountId: account.accountId, errorCode: "ACCOUNT_RUNNER_REJECTED" });
      })
      .finally(() => {
        inFlight.delete(account.accountId);
        executions.delete(execution);
        signal.notify();
      });
    inFlight.set(account.accountId, execution);
    executions.add(execution);
    peakConcurrency = Math.max(peakConcurrency, inFlight.size);
  };

  const pump = (): void => {
    if (state !== "RUNNING") return;
    for (const [accountId, account] of pending) {
      if (state !== "RUNNING" || inFlight.size >= input.policy.maxConcurrentAccounts) break;
      pending.delete(accountId);
      if (inFlight.has(accountId)) continue;
      const until = deferredUntil.get(accountId) ?? 0;
      if (until > now()) continue;
      deferredUntil.delete(accountId);
      startAccount(account);
    }
  };

  const reconcile = async (): Promise<void> => {
    if (state !== "RUNNING") return;
    const current = now();
    for (const [accountId, until] of deferredUntil) {
      if (until <= current) deferredUntil.delete(accountId);
    }
    pump();
    if (inFlight.size >= input.policy.maxConcurrentAccounts) return;
    const limit = Math.min(1000, input.policy.discoveryBatchSize + inFlight.size + deferredUntil.size);
    let due: readonly BroadcastRuntimeAccount[];
    try {
      due = await dependencies.runtimeAccounts.listDue({ shard, limit });
    } catch {
      discoveryFailures += 1;
      emit({ type: "DISCOVERY_QUERY_FAILED", phase: "LIST_DUE", errorCode: "DISCOVERY_QUERY_FAILED" });
      return;
    }
    if (!Array.isArray(due)) {
      discoveryFailures += 1;
      emit({ type: "DISCOVERY_QUERY_FAILED", phase: "LIST_DUE", errorCode: "DISCOVERY_QUERY_FAILED" });
      return;
    }
    for (const account of due) {
      if (rejectDiscovery(account) || inFlight.has(account.accountId) || pending.has(account.accountId)) continue;
      const until = deferredUntil.get(account.accountId) ?? 0;
      if (until > now()) continue;
      pending.set(account.accountId, account);
    }
    pump();
  };

  const nextDelay = async (): Promise<number> => {
    const fallback = input.policy.reconciliationIntervalMilliseconds;
    if (state !== "RUNNING" || inFlight.size >= input.policy.maxConcurrentAccounts || pending.size > 0) return fallback;
    let next: BroadcastRuntimeAccount | null;
    try {
      next = await dependencies.runtimeAccounts.findNext({ shard });
    } catch {
      discoveryFailures += 1;
      emit({ type: "DISCOVERY_QUERY_FAILED", phase: "FIND_NEXT", errorCode: "DISCOVERY_QUERY_FAILED" });
      return fallback;
    }
    if (!next || rejectDiscovery(next) || inFlight.has(next.accountId)) return fallback;
    const current = now();
    const deferred = deferredUntil.get(next.accountId) ?? 0;
    if (deferred > current) return Math.max(1, Math.min(fallback, deferred - current));
    return Math.max(1, Math.min(fallback, Date.parse(next.nextDueAt) - current));
  };

  const onWakeup = (accountId: string): void => {
    if (state !== "RUNNING") return;
    if (!UUID.test(accountId)) {
      wakeupsIgnored += 1;
      emit({ type: "WAKEUP_IGNORED", accountId, errorCode: "INVALID_ACCOUNT_ID" });
      return;
    }
    if (!shardOwnsAccount(accountId, shard)) {
      wakeupsIgnored += 1;
      emit({ type: "WAKEUP_IGNORED", accountId, errorCode: "WRONG_SHARD" });
      return;
    }
    wakeupsAccepted += 1;
    deferredUntil.delete(accountId);
    emit({ type: "WAKEUP_ACCEPTED", accountId });
    signal.notify();
  };

  const ensureSubscription = async (): Promise<void> => {
    if (state !== "RUNNING" || subscription || now() < nextSubscriptionAttemptAt) return;
    try {
      const connected = await dependencies.runtimeAccounts.subscribeWakeups(onWakeup);
      if (state !== "RUNNING") {
        try { await connected.close(); }
        catch { cleanupErrorCodes.push("WAKEUP_SUBSCRIPTION_CLOSE_FAILED"); }
        return;
      }
      subscription = connected;
      nextSubscriptionAttemptAt = Number.POSITIVE_INFINITY;
    } catch {
      subscriptionFailures += 1;
      nextSubscriptionAttemptAt = now() + input.policy.subscriptionRetryMilliseconds;
      emit({ type: "WAKEUP_SUBSCRIPTION_FAILED", errorCode: "WAKEUP_SUBSCRIPTION_FAILED" });
    }
  };

  await ensureSubscription();
  emit({ type: "SUPERVISOR_STARTED", shard });

  const loop = async (): Promise<void> => {
    while (state === "RUNNING") {
      let delay = input.policy.reconciliationIntervalMilliseconds;
      try {
        await ensureSubscription();
        await reconcile();
        if (state !== "RUNNING") break;
        delay = await nextDelay();
        if (!subscription) {
          delay = Math.max(1, Math.min(delay, nextSubscriptionAttemptAt - now()));
        }
      } catch {
        discoveryFailures += 1;
        emit({ type: "DISCOVERY_QUERY_FAILED", phase: "LIST_DUE", errorCode: "DISCOVERY_QUERY_FAILED" });
      }
      if (state !== "RUNNING") break;
      await signal.wait(delay);
    }
  };
  const loopPromise = loop();

  const stop = (): Promise<AccountSupervisorSummary> => {
    if (stopPromise) return stopPromise;
    state = "STOPPING";
    signal.notify();
    stopPromise = (async () => {
      if (subscription) {
        try { await subscription.close(); }
        catch { cleanupErrorCodes.push("WAKEUP_SUBSCRIPTION_CLOSE_FAILED"); }
      }
      await loopPromise;
      await Promise.all([...executions]);
      state = "STOPPED";
      pending.clear();
      const eventSummary = summary();
      emit({ type: "SUPERVISOR_STOPPED", summary: eventSummary });
      return summary();
    })();
    return stopPromise;
  };

  return Object.freeze({ snapshot, stop });
}
