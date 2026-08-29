import type { AccountRunnerResult } from "../account-runner/contracts.ts";
import type { BroadcastRuntimeAccount, BroadcastRuntimeAccountRepository } from "../runtime-accounts/repository.ts";
import type { ShardConfig } from "../runtime-sharding/shard.ts";

export type AccountSupervisorPolicy = Readonly<{
  maxConcurrentAccounts: number;
  discoveryBatchSize: number;
  reconciliationIntervalMilliseconds: number;
  subscriptionRetryMilliseconds: number;
  contendedAccountRetryMilliseconds: number;
  failedAccountRetryMilliseconds: number;
}>;

export type AccountSupervisorState = "RUNNING" | "STOPPING" | "STOPPED";

export type AccountSupervisorSnapshot = Readonly<{
  state: AccountSupervisorState;
  shard: ShardConfig;
  inFlightAccounts: number;
  pendingAccounts: number;
  peakConcurrency: number;
  runsStarted: number;
  runsCompleted: number;
  runnerFailures: number;
  discoveryFailures: number;
  discoveryAccountsRejected: number;
  subscriptionFailures: number;
  observerFailures: number;
  wakeupsAccepted: number;
  wakeupsIgnored: number;
}>;

export type AccountSupervisorSummary = AccountSupervisorSnapshot & Readonly<{
  cleanupErrorCodes: readonly string[];
}>;

export type AccountSupervisorEvent =
  | Readonly<{ type: "SUPERVISOR_STARTED"; shard: ShardConfig }>
  | Readonly<{ type: "WAKEUP_ACCEPTED"; accountId: string }>
  | Readonly<{ type: "WAKEUP_IGNORED"; accountId: string; errorCode: "INVALID_ACCOUNT_ID" | "WRONG_SHARD" }>
  | Readonly<{ type: "DISCOVERY_QUERY_FAILED"; phase: "LIST_DUE" | "FIND_NEXT"; errorCode: "DISCOVERY_QUERY_FAILED" }>
  | Readonly<{ type: "DISCOVERY_ACCOUNT_REJECTED"; accountId: string; errorCode: "INVALID_DISCOVERY_ACCOUNT" | "WRONG_SHARD" }>
  | Readonly<{ type: "WAKEUP_SUBSCRIPTION_FAILED"; errorCode: "WAKEUP_SUBSCRIPTION_FAILED" }>
  | Readonly<{ type: "ACCOUNT_RUN_STARTED"; accountId: string; accountType: BroadcastRuntimeAccount["accountType"] }>
  | Readonly<{ type: "ACCOUNT_RUN_FINISHED"; accountId: string; result: AccountRunnerResult }>
  | Readonly<{ type: "ACCOUNT_RUNNER_FAILED"; accountId: string; errorCode: "ACCOUNT_RUNNER_REJECTED" | "INVALID_RUNNER_RESULT" }>
  | Readonly<{ type: "SUPERVISOR_STOPPED"; summary: AccountSupervisorSummary }>;

export type AccountSupervisorObserver = (event: AccountSupervisorEvent) => void | Promise<void>;

export type AccountSupervisorDependencies = Readonly<{
  runtimeAccounts: Pick<BroadcastRuntimeAccountRepository, "listDue" | "findNext" | "subscribeWakeups">;
  runAccount(account: Readonly<Pick<BroadcastRuntimeAccount, "accountId" | "accountType">>): Promise<AccountRunnerResult>;
  observer?: AccountSupervisorObserver;
  now?: () => number;
}>;

export interface AccountSupervisorHandle {
  snapshot(): AccountSupervisorSnapshot;
  stop(): Promise<AccountSupervisorSummary>;
}
