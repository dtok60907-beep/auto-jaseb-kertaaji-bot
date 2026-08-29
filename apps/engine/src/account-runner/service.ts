import {
  TelegramSessionCryptoError,
} from "../../../../packages/telegram-session-crypto/src/index.ts";
import {
  TelegramAdapterError,
  type TelegramDeliveryAdapter,
} from "../../../../packages/telegram-contract/src/index.ts";
import { executeNextBroadcast } from "../broadcast-executor/service.ts";
import { prepareNextBroadcastTarget } from "../broadcast-preparation/service.ts";
import type { AccountLease } from "../runtime-leases/repository.ts";
import type {
  AccountRunnerDependencies,
  AccountRunnerPolicy,
  AccountRunnerResult,
  AccountRunnerStatus,
} from "./contracts.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PROVIDER_RETRY_SECONDS = 2_147_483_647;

type CoreResult = Readonly<{
  status: AccountRunnerStatus;
  actions: number;
  errorCode: string | null;
}>;

type RuntimeStateResult =
  | Readonly<{ status: "CONNECTED" | "DISCONNECTED" }>
  | Readonly<{ status: "FAILED_RETRYABLE"; errorCode: string; retryAfterSeconds: number }>
  | Readonly<{ status: "DEGRADED" | "REVOKED"; errorCode: string }>;

function core(status: AccountRunnerStatus, actions = 0, errorCode: string | null = null): CoreResult {
  return Object.freeze({ status, actions, errorCode });
}

function validatePolicy(policy: AccountRunnerPolicy): void {
  if (!Number.isInteger(policy.leaseSeconds) || policy.leaseSeconds < 2 || policy.leaseSeconds > 3600) {
    throw new TypeError("INVALID_ACCOUNT_LEASE_SECONDS");
  }
  if (
    !Number.isInteger(policy.heartbeatIntervalMilliseconds)
    || policy.heartbeatIntervalMilliseconds < 1
    || policy.heartbeatIntervalMilliseconds > policy.leaseSeconds * 500
  ) throw new TypeError("INVALID_HEARTBEAT_INTERVAL");
  if (!Number.isInteger(policy.maxActionsPerRun) || policy.maxActionsPerRun < 1 || policy.maxActionsPerRun > 1000) {
    throw new TypeError("INVALID_MAX_ACTIONS_PER_RUN");
  }
  if (
    !Number.isInteger(policy.commandLeaseSeconds)
    || policy.commandLeaseSeconds < 1
    || policy.commandLeaseSeconds >= policy.leaseSeconds
  ) throw new TypeError("INVALID_COMMAND_LEASE_SECONDS");
  if (!Number.isInteger(policy.runtimeRetrySeconds) || policy.runtimeRetrySeconds < 1 || policy.runtimeRetrySeconds > 86400) {
    throw new TypeError("INVALID_RUNTIME_RETRY_SECONDS");
  }
}

function retrySeconds(value: number | null | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= MAX_PROVIDER_RETRY_SECONDS
    ? Number(value)
    : fallback;
}

function isLeaseContextValid(lease: AccountLease, accountId: string, leaseOwner: string): boolean {
  return lease.accountId === accountId
    && lease.leaseOwner === leaseOwner
    && typeof lease.fencingToken === "bigint"
    && lease.fencingToken > 0n
    && Number.isFinite(Date.parse(lease.leaseUntil));
}

function normalizedAdapterError(error: unknown): TelegramAdapterError {
  return error instanceof TelegramAdapterError
    ? error
    : new TelegramAdapterError({ code: "TELEGRAM_UNKNOWN", retryable: false, cause: error });
}

function isAccountLeaseNotHeld(error: unknown): boolean {
  return error instanceof Error && error.message === "ACCOUNT_LEASE_NOT_HELD";
}

function runtimeFailure(error: TelegramAdapterError, fallbackRetrySeconds: number): Readonly<{
  state: RuntimeStateResult;
  result: CoreResult;
}> {
  if (error.code === "SESSION_REVOKED") {
    return Object.freeze({
      state: Object.freeze({ status: "REVOKED", errorCode: error.code }),
      result: core("ACCOUNT_REVOKED", 0, error.code),
    });
  }
  if (error.code === "SESSION_CONFLICT") {
    return Object.freeze({
      state: Object.freeze({ status: "DEGRADED", errorCode: error.code }),
      result: core("ACCOUNT_DEGRADED", 0, error.code),
    });
  }
  if (error.retryable) {
    const wait = retrySeconds(error.retryAfterSeconds, fallbackRetrySeconds);
    return Object.freeze({
      state: Object.freeze({ status: "FAILED_RETRYABLE", errorCode: error.code, retryAfterSeconds: wait }),
      result: core("RETRY_SCHEDULED", 0, error.code),
    });
  }
  return Object.freeze({
    state: Object.freeze({ status: "DEGRADED", errorCode: error.code }),
    result: core("ACCOUNT_DEGRADED", 0, error.code),
  });
}

function finalResult(
  accountId: string,
  result: CoreResult,
  disconnected: boolean,
  leaseReleased: boolean,
  cleanupErrorCodes: readonly string[],
): AccountRunnerResult {
  return Object.freeze({
    accountId,
    ...result,
    disconnected,
    leaseReleased,
    cleanupErrorCodes: Object.freeze([...cleanupErrorCodes]),
  });
}

export async function runBroadcastAccount(
  dependencies: AccountRunnerDependencies,
  input: Readonly<{
    account: Readonly<{ accountId: string; accountType: "JASEB_WORKER" | "USERBOT" }>;
    leaseOwner: string;
    policy: AccountRunnerPolicy;
  }>,
): Promise<AccountRunnerResult> {
  validatePolicy(input.policy);
  if (!UUID.test(input.account.accountId) || !UUID.test(input.leaseOwner)) throw new TypeError("INVALID_ACCOUNT_RUN_INPUT");
  if (input.account.accountType !== "JASEB_WORKER" && input.account.accountType !== "USERBOT") throw new TypeError("INVALID_ACCOUNT_RUN_INPUT");

  let acquisition;
  try {
    acquisition = await dependencies.accountLeases.acquire({
      accountId: input.account.accountId,
      leaseOwner: input.leaseOwner,
      leaseSeconds: input.policy.leaseSeconds,
    });
  } catch {
    return finalResult(input.account.accountId, core("FAILED", 0, "LEASE_ACQUIRE_FAILED"), false, false, []);
  }
  if (acquisition.status === "HELD_BY_OTHER") {
    return finalResult(input.account.accountId, core("HELD_BY_OTHER"), false, false, []);
  }

  const lease = acquisition.lease;
  if (!isLeaseContextValid(lease, input.account.accountId, input.leaseOwner)) {
    return finalResult(input.account.accountId, core("FAILED", 0, "INVALID_LEASE_CONTEXT"), false, false, []);
  }

  let leaseLost = false;
  let heartbeatError = false;
  let heartbeat: ReturnType<AccountRunnerDependencies["scheduler"]["start"]> | null = null;
  const lifecycle: { adapter: TelegramDeliveryAdapter | null } = { adapter: null };
  let disconnected = false;
  let leaseReleased = false;
  const cleanupErrorCodes: string[] = [];

  const leaseIdentity = Object.freeze({
    accountId: lease.accountId,
    leaseOwner: lease.leaseOwner,
    fencingToken: lease.fencingToken,
  });

  const persistRuntime = async (state: RuntimeStateResult, actions: number): Promise<CoreResult | null> => {
    if (leaseLost) return core("FENCED_OUT", actions, heartbeatError ? "LEASE_HEARTBEAT_FAILED" : "ACCOUNT_LEASE_LOST");
    try {
      const recorded = await dependencies.runtimeAccounts.recordResult({ ...leaseIdentity, result: state });
      return recorded ? null : core("FENCED_OUT", actions, "RUNTIME_STATE_REJECTED");
    } catch (error) {
      if (isAccountLeaseNotHeld(error)) {
        leaseLost = true;
        return core("FENCED_OUT", actions, "ACCOUNT_LEASE_LOST");
      }
      return core("FAILED", actions, "RUNTIME_STATE_PERSIST_FAILED");
    }
  };

  const persistFailure = async (
    error: TelegramAdapterError,
    actions: number,
    retryAfterSeconds?: number | null,
  ): Promise<CoreResult> => {
    const classified = runtimeFailure(error, input.policy.runtimeRetrySeconds);
    const state = classified.state.status === "FAILED_RETRYABLE" && retryAfterSeconds !== undefined
      ? Object.freeze({
          status: "FAILED_RETRYABLE" as const,
          errorCode: classified.state.errorCode,
          retryAfterSeconds: retrySeconds(retryAfterSeconds, input.policy.runtimeRetrySeconds),
        })
      : classified.state;
    const persistenceFailure = await persistRuntime(state, actions);
    return persistenceFailure ?? core(classified.result.status, actions, classified.result.errorCode);
  };

  const drain = async (): Promise<CoreResult> => {
    let loaded;
    try {
      loaded = await dependencies.runtimeAccounts.loadSession(leaseIdentity);
    } catch (error) {
      if (leaseLost || isAccountLeaseNotHeld(error)) {
        leaseLost = true;
        return core("FENCED_OUT", 0, heartbeatError ? "LEASE_HEARTBEAT_FAILED" : "ACCOUNT_LEASE_LOST");
      }
      return core("FAILED", 0, "SESSION_LOAD_FAILED");
    }
    if (!loaded) return core(leaseLost ? "FENCED_OUT" : "NOT_RUNNABLE", 0, leaseLost ? "ACCOUNT_LEASE_LOST" : null);
    if (loaded.accountId !== lease.accountId || loaded.accountType !== input.account.accountType) {
      loaded.encryptedSession.fill(0);
      const persistenceFailure = await persistRuntime({ status: "DEGRADED", errorCode: "INVALID_SESSION_CONTEXT" }, 0);
      return persistenceFailure ?? core("ACCOUNT_DEGRADED", 0, "INVALID_SESSION_CONTEXT");
    }

    let serializedSession: string | null = null;
    try {
      serializedSession = dependencies.sessionKeyRing.decrypt(
        { accountId: loaded.accountId, accountType: loaded.accountType },
        { ciphertext: loaded.encryptedSession, keyVersion: loaded.encryptionKeyVersion },
      );
    } catch (error) {
      const code = error instanceof TelegramSessionCryptoError ? error.code : "SESSION_DECRYPT_FAILED";
      if (code === "SESSION_KEY_NOT_FOUND") {
        const persistenceFailure = await persistRuntime({
          status: "FAILED_RETRYABLE",
          errorCode: code,
          retryAfterSeconds: input.policy.runtimeRetrySeconds,
        }, 0);
        return persistenceFailure ?? core("RETRY_SCHEDULED", 0, code);
      }
      const persistenceFailure = await persistRuntime({ status: "DEGRADED", errorCode: code }, 0);
      return persistenceFailure ?? core("ACCOUNT_DEGRADED", 0, code);
    } finally {
      loaded.encryptedSession.fill(0);
    }

    let activeAdapter: TelegramDeliveryAdapter;
    try {
      activeAdapter = dependencies.adapterFactory.create({
        accountId: loaded.accountId,
        accountType: loaded.accountType,
        session: serializedSession,
      });
      lifecycle.adapter = activeAdapter;
    } catch {
      const persistenceFailure = await persistRuntime({ status: "DEGRADED", errorCode: "INVALID_TELEGRAM_SESSION" }, 0);
      return persistenceFailure ?? core("ACCOUNT_DEGRADED", 0, "INVALID_TELEGRAM_SESSION");
    } finally {
      serializedSession = null;
    }

    try {
      await activeAdapter.connect();
    } catch (error) {
      return await persistFailure(normalizedAdapterError(error), 0);
    }
    if (leaseLost) return core("FENCED_OUT", 0, heartbeatError ? "LEASE_HEARTBEAT_FAILED" : "ACCOUNT_LEASE_LOST");
    const connectedFailure = await persistRuntime({ status: "CONNECTED" }, 0);
    if (connectedFailure) return connectedFailure;

    let actions = 0;
    while (actions < input.policy.maxActionsPerRun) {
      if (leaseLost) return core("FENCED_OUT", actions, heartbeatError ? "LEASE_HEARTBEAT_FAILED" : "ACCOUNT_LEASE_LOST");
      let progressed = false;

      const preparation = await prepareNextBroadcastTarget(activeAdapter, dependencies.preparations, {
        accountId: lease.accountId,
        leaseOwner: lease.leaseOwner,
        accountFencingToken: lease.fencingToken,
      });
      if (preparation.status !== "NO_TARGET") {
        actions += 1;
        progressed = true;
        if (preparation.status === "FENCED_OUT") return core("FENCED_OUT", actions, preparation.errorCode);
        if (preparation.errorCode === "SESSION_REVOKED" || preparation.errorCode === "SESSION_CONFLICT") {
          return await persistFailure(new TelegramAdapterError({ code: preparation.errorCode, retryable: false }), actions);
        }
        if (preparation.status === "RETRYABLE") {
          return await persistFailure(
            new TelegramAdapterError({ code: preparation.errorCode === "FLOOD_WAIT" ? "FLOOD_WAIT" : "TELEGRAM_TRANSIENT", retryable: true }),
            actions,
            preparation.retryAfterSeconds,
          );
        }
      }

      if (leaseLost) return core("FENCED_OUT", actions, heartbeatError ? "LEASE_HEARTBEAT_FAILED" : "ACCOUNT_LEASE_LOST");
      if (actions >= input.policy.maxActionsPerRun) return core("BUDGET_EXHAUSTED", actions);

      const execution = await executeNextBroadcast(activeAdapter, dependencies.executor, leaseIdentity, {
        commandLeaseSeconds: input.policy.commandLeaseSeconds,
      });
      if (execution.status !== "IDLE") {
        actions += 1;
        progressed = true;
        if (execution.status === "FENCED_OUT") return core("FENCED_OUT", actions, "COMMAND_FENCED");
        if (execution.status === "SIDE_EFFECT_UNCERTAIN") return core("SIDE_EFFECT_UNCERTAIN", actions, execution.errorCode ?? "TELEGRAM_UNKNOWN");
        if (execution.errorCode === "SESSION_REVOKED" || execution.errorCode === "SESSION_CONFLICT") {
          return await persistFailure(new TelegramAdapterError({ code: execution.errorCode, retryable: false }), actions);
        }
        if (execution.status === "RETRY_SCHEDULED") {
          return await persistFailure(
            new TelegramAdapterError({ code: execution.errorCode === "FLOOD_WAIT" ? "FLOOD_WAIT" : "TELEGRAM_TRANSIENT", retryable: true }),
            actions,
            execution.retryAfterSeconds,
          );
        }
      }

      if (!progressed) return core("DRAINED", actions);
    }
    return core("BUDGET_EXHAUSTED", actions);
  };

  let result: CoreResult = core("FAILED", 0, "ACCOUNT_RUNNER_FAILED");
  try {
    heartbeat = dependencies.scheduler.start(input.policy.heartbeatIntervalMilliseconds, async () => {
      try {
        const renewed = await dependencies.accountLeases.renew({
          accountId: lease.accountId,
          leaseOwner: lease.leaseOwner,
          fencingToken: lease.fencingToken,
          leaseSeconds: input.policy.leaseSeconds,
        });
        if (!renewed || !isLeaseContextValid(renewed, lease.accountId, lease.leaseOwner) || renewed.fencingToken !== lease.fencingToken) {
          leaseLost = true;
          return "STOP";
        }
        return "CONTINUE";
      } catch {
        heartbeatError = true;
        leaseLost = true;
        return "STOP";
      }
    });
    result = await drain();
  } catch {
    result = core(leaseLost ? "FENCED_OUT" : "FAILED", 0, leaseLost ? "ACCOUNT_LEASE_LOST" : "ACCOUNT_RUNNER_FAILED");
  } finally {
    const cleanupAdapter = lifecycle.adapter;
    if (cleanupAdapter) {
      try {
        await cleanupAdapter.disconnect();
        disconnected = true;
        const disconnectStateFailure = await persistRuntime({ status: "DISCONNECTED" }, result.actions);
        if (disconnectStateFailure) cleanupErrorCodes.push(disconnectStateFailure.errorCode ?? "DISCONNECT_STATE_FAILED");
      } catch {
        cleanupErrorCodes.push("ADAPTER_DISCONNECT_FAILED");
      }
    }
    if (heartbeat) {
      try { await heartbeat.stop(); }
      catch { cleanupErrorCodes.push("HEARTBEAT_STOP_FAILED"); }
    }
    try {
      leaseReleased = await dependencies.accountLeases.release({
        accountId: lease.accountId,
        leaseOwner: lease.leaseOwner,
        fencingToken: lease.fencingToken,
      });
      if (!leaseReleased && !leaseLost) cleanupErrorCodes.push("LEASE_RELEASE_REJECTED");
    } catch {
      cleanupErrorCodes.push("LEASE_RELEASE_FAILED");
    }
  }

  return finalResult(input.account.accountId, result, disconnected, leaseReleased, cleanupErrorCodes);
}
