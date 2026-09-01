import type { TelegramSessionKeyRing } from "../../../../packages/telegram-session-crypto/src/index.ts";
import type { TelegramDeliveryAdapter } from "../../../../packages/telegram-contract/src/index.ts";
import type { AutoCommentPreparationRepository } from "../auto-comment-preparation/repository.ts";
import type { BroadcastExecutorRepository } from "../broadcast-executor/repository.ts";
import type { BroadcastPreparationRepository } from "../broadcast-preparation/repository.ts";
import type { BroadcastRuntimeAccount, BroadcastRuntimeAccountRepository } from "../runtime-accounts/repository.ts";
import type { RuntimeAccountLeaseRepository } from "../runtime-leases/repository.ts";

export type RuntimeRepeatDecision = "CONTINUE" | "STOP";

export interface RuntimeRepeatingTaskHandle {
  stop(): Promise<void>;
}

export interface RuntimeRepeatingTaskScheduler {
  start(intervalMilliseconds: number, task: () => Promise<RuntimeRepeatDecision>): RuntimeRepeatingTaskHandle;
}

export interface TelegramRuntimeAdapterFactory {
  create(input: Readonly<{
    accountId: string;
    accountType: BroadcastRuntimeAccount["accountType"];
    session: string;
  }>): TelegramDeliveryAdapter;
}

export type AccountRunnerPolicy = Readonly<{
  leaseSeconds: number;
  heartbeatIntervalMilliseconds: number;
  maxActionsPerRun: number;
  commandLeaseSeconds: number;
  runtimeRetrySeconds: number;
}>;

export type AccountRunnerStatus =
  | "HELD_BY_OTHER"
  | "NOT_RUNNABLE"
  | "DRAINED"
  | "BUDGET_EXHAUSTED"
  | "RETRY_SCHEDULED"
  | "ACCOUNT_DEGRADED"
  | "ACCOUNT_REVOKED"
  | "SIDE_EFFECT_UNCERTAIN"
  | "FENCED_OUT"
  | "FAILED";

export type AccountRunnerResult = Readonly<{
  accountId: string;
  status: AccountRunnerStatus;
  actions: number;
  errorCode: string | null;
  disconnected: boolean;
  leaseReleased: boolean;
  cleanupErrorCodes: readonly string[];
}>;

export type AccountRunnerDependencies = Readonly<{
  runtimeAccounts: BroadcastRuntimeAccountRepository;
  accountLeases: RuntimeAccountLeaseRepository;
  preparations: BroadcastPreparationRepository;
  executor: BroadcastExecutorRepository;
  autoCommentPreparations?: AutoCommentPreparationRepository;
  sessionKeyRing: Pick<TelegramSessionKeyRing, "decrypt">;
  adapterFactory: TelegramRuntimeAdapterFactory;
  scheduler: RuntimeRepeatingTaskScheduler;
}>;
