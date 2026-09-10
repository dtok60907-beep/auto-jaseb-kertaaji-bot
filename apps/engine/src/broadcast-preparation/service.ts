import {
  TelegramAdapterError,
  type TelegramDeliveryAdapter,
} from "../../../../packages/telegram-contract/src/index.ts";
import type {
  BroadcastPreparationRepository,
  BroadcastPreparationStatus,
  ClaimedBroadcastPreparation,
} from "./repository.ts";

type LeaseContext = Readonly<{
  accountId: string;
  leaseOwner: string;
  accountFencingToken: bigint;
}>;

const APPROVAL_RECHECK_BASE_SECONDS = 60;
const APPROVAL_RECHECK_MAX_SECONDS = 3_600;
// One initial join request plus bounded membership checks covers roughly one
// day. After that the target reaches a visible terminal state; a user can
// explicitly start a new run after the join request has been approved.
const APPROVAL_RECHECK_MAX_ATTEMPTS = 30;

function approvalRecheckSeconds(attemptCount: number): number {
  const exponent = Math.min(Math.max(attemptCount - 1, 0), 20);
  return Math.min(APPROVAL_RECHECK_MAX_SECONDS, APPROVAL_RECHECK_BASE_SECONDS * (2 ** exponent));
}

export type BroadcastPreparationResult =
  | Readonly<{ status: "NO_TARGET" }>
  | Readonly<{
      status: "READY" | "WAITING_APPROVAL" | "RETRYABLE" | "FAILED_FINAL" | "FENCED_OUT";
      targetId: string;
      errorCode: string | null;
      retryAfterSeconds: number | null;
    }>;

function normalizedError(error: unknown): TelegramAdapterError {
  return error instanceof TelegramAdapterError
    ? error
    : new TelegramAdapterError({ code: "TELEGRAM_UNKNOWN", retryable: false, cause: error });
}

async function move(
  repository: BroadcastPreparationRepository,
  target: ClaimedBroadcastPreparation,
  lease: LeaseContext,
  expectedStatus: "CHECKING" | "JOINING",
  status: BroadcastPreparationStatus,
  errorCode: string | null = null,
  retryAfterSeconds: number | null = null,
  resolvedTitle: string | null = null,
): Promise<boolean> {
  return repository.transition({
    targetId: target.targetId,
    ...lease,
    expectedStatus,
    status,
    errorCode,
    retryAfterSeconds,
    resolvedTitle,
  });
}

function fenced(targetId: string): BroadcastPreparationResult {
  return Object.freeze({
    status: "FENCED_OUT",
    targetId,
    errorCode: "PREPARATION_FENCED",
    retryAfterSeconds: null,
  });
}

export async function prepareNextBroadcastTarget(
  adapter: TelegramDeliveryAdapter,
  repository: BroadcastPreparationRepository,
  lease: LeaseContext,
): Promise<BroadcastPreparationResult> {
  const target = await repository.claimNext(lease);
  if (!target) return Object.freeze({ status: "NO_TARGET" });
  const approvalRetrySeconds = approvalRecheckSeconds(target.attemptCount);

  const initialAuthorization = await repository.validatePreparation({ targetId: target.targetId, ...lease });
  if (initialAuthorization !== "AUTHORIZED") return fenced(target.targetId);

  if (target.previousStatus === "WAITING_APPROVAL" && target.attemptCount >= APPROVAL_RECHECK_MAX_ATTEMPTS) {
    if (!await move(repository, target, lease, "CHECKING", "FAILED_FINAL", "JOIN_APPROVAL_TIMEOUT")) return fenced(target.targetId);
    return Object.freeze({
      status: "FAILED_FINAL",
      targetId: target.targetId,
      errorCode: "JOIN_APPROVAL_TIMEOUT",
      retryAfterSeconds: null,
    });
  }

  let current: "CHECKING" | "JOINING" = "CHECKING";
  try {
    const resolved = await adapter.resolveTarget(target.telegramTargetRef);
    if (resolved.entityType === "CHANNEL") {
      if (!await move(repository, target, lease, current, "FAILED_FINAL", "LPM_TARGET_NOT_GROUP")) return fenced(target.targetId);
      return Object.freeze({ status: "FAILED_FINAL", targetId: target.targetId, errorCode: "LPM_TARGET_NOT_GROUP", retryAfterSeconds: null });
    }

    if (resolved.membership !== "MEMBER") {
      if (target.previousStatus === "WAITING_APPROVAL") {
        if (!await move(repository, target, lease, current, "WAITING_APPROVAL", "JOIN_APPROVAL_PENDING", approvalRetrySeconds)) return fenced(target.targetId);
        return Object.freeze({ status: "WAITING_APPROVAL", targetId: target.targetId, errorCode: "JOIN_APPROVAL_PENDING", retryAfterSeconds: approvalRetrySeconds });
      }
      if (!await move(repository, target, lease, current, "JOINING")) return fenced(target.targetId);
      current = "JOINING";
      const joinAuthorization = await repository.validatePreparation({ targetId: target.targetId, ...lease });
      if (joinAuthorization !== "AUTHORIZED") return fenced(target.targetId);
      const joined = await adapter.joinPublicTarget(target.telegramTargetRef);
      if (joined.state === "APPROVAL_REQUESTED") {
        if (!await move(repository, target, lease, current, "WAITING_APPROVAL", "JOIN_APPROVAL_PENDING", approvalRetrySeconds)) return fenced(target.targetId);
        return Object.freeze({ status: "WAITING_APPROVAL", targetId: target.targetId, errorCode: "JOIN_APPROVAL_PENDING", retryAfterSeconds: approvalRetrySeconds });
      }
    }

    if (!await move(repository, target, lease, current, "READY", null, null, resolved.title)) return fenced(target.targetId);
    return Object.freeze({ status: "READY", targetId: target.targetId, errorCode: null, retryAfterSeconds: null });
  } catch (rawError) {
    const error = normalizedError(rawError);
    if (error.code === "JOIN_APPROVAL_REQUIRED") {
      if (!await move(repository, target, lease, current, "WAITING_APPROVAL", "JOIN_APPROVAL_PENDING", approvalRetrySeconds)) return fenced(target.targetId);
      return Object.freeze({ status: "WAITING_APPROVAL", targetId: target.targetId, errorCode: "JOIN_APPROVAL_PENDING", retryAfterSeconds: approvalRetrySeconds });
    }
    if (error.retryable) {
      const retryAfterSeconds = target.previousStatus === "WAITING_APPROVAL"
        ? Math.max(error.retryAfterSeconds ?? 1, approvalRetrySeconds)
        : error.retryAfterSeconds ?? 1;
      const retryStatus = target.previousStatus === "WAITING_APPROVAL" && current === "CHECKING"
        ? "WAITING_APPROVAL"
        : "QUEUED";
      if (!await move(repository, target, lease, current, retryStatus, error.code, retryAfterSeconds)) return fenced(target.targetId);
      return Object.freeze({
        status: retryStatus === "WAITING_APPROVAL" ? "WAITING_APPROVAL" : "RETRYABLE",
        targetId: target.targetId,
        errorCode: error.code,
        retryAfterSeconds,
      });
    }
    if (!await move(repository, target, lease, current, "FAILED_FINAL", error.code)) return fenced(target.targetId);
    return Object.freeze({ status: "FAILED_FINAL", targetId: target.targetId, errorCode: error.code, retryAfterSeconds: null });
  }
}
