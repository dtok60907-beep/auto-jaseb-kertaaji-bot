import { TelegramAdapterError, type TelegramDeliveryAdapter } from "../telegram/adapter.ts";
import type { BroadcastPreparationRepository, BroadcastPreparationStatus, ClaimedBroadcastPreparation } from "./repository.ts";

type LeaseContext = Readonly<{ accountId: string; leaseOwner: string; accountFencingToken: bigint }>;
export type BroadcastPreparationResult =
  | Readonly<{ status: "NO_TARGET" }>
  | Readonly<{ status: "READY" | "RETRYABLE" | "FAILED_FINAL" | "FENCED_OUT"; targetId: string; errorCode: string | null; retryAfterSeconds: number | null }>;

function normalizedError(error: unknown): TelegramAdapterError {
  return error instanceof TelegramAdapterError ? error : new TelegramAdapterError({ code: "TELEGRAM_UNKNOWN", retryable: false, cause: error });
}
async function move(repository: BroadcastPreparationRepository, target: ClaimedBroadcastPreparation, lease: LeaseContext, expectedStatus: "CHECKING" | "JOINING", status: BroadcastPreparationStatus, errorCode: string | null = null, retryAfterSeconds: number | null = null) {
  return repository.transition({ targetId: target.targetId, ...lease, expectedStatus, status, errorCode, retryAfterSeconds });
}
export async function prepareNextBroadcastTarget(adapter: TelegramDeliveryAdapter, repository: BroadcastPreparationRepository, lease: LeaseContext): Promise<BroadcastPreparationResult> {
  const target = await repository.claimNext(lease);
  if (!target) return Object.freeze({ status: "NO_TARGET" });
  let current: "CHECKING" | "JOINING" = "CHECKING";
  try {
    const resolved = await adapter.resolveTarget(target.telegramTargetRef);
    if (resolved.entityType === "CHANNEL") {
      if (!await move(repository, target, lease, current, "FAILED_FINAL", "LPM_TARGET_NOT_GROUP")) return Object.freeze({ status: "FENCED_OUT", targetId: target.targetId, errorCode: "PREPARATION_FENCED", retryAfterSeconds: null });
      return Object.freeze({ status: "FAILED_FINAL", targetId: target.targetId, errorCode: "LPM_TARGET_NOT_GROUP", retryAfterSeconds: null });
    }
    if (resolved.membership !== "MEMBER") {
      if (!await move(repository, target, lease, current, "JOINING")) return Object.freeze({ status: "FENCED_OUT", targetId: target.targetId, errorCode: "PREPARATION_FENCED", retryAfterSeconds: null });
      current = "JOINING";
      await adapter.joinPublicTarget(target.telegramTargetRef);
    }
    if (!await move(repository, target, lease, current, "READY")) return Object.freeze({ status: "FENCED_OUT", targetId: target.targetId, errorCode: "PREPARATION_FENCED", retryAfterSeconds: null });
    return Object.freeze({ status: "READY", targetId: target.targetId, errorCode: null, retryAfterSeconds: null });
  } catch (rawError) {
    const error = normalizedError(rawError);
    if (error.retryable) {
      const retryAfterSeconds = error.retryAfterSeconds ?? 1;
      if (!await move(repository, target, lease, current, "QUEUED", error.code, retryAfterSeconds)) return Object.freeze({ status: "FENCED_OUT", targetId: target.targetId, errorCode: "PREPARATION_FENCED", retryAfterSeconds: null });
      return Object.freeze({ status: "RETRYABLE", targetId: target.targetId, errorCode: error.code, retryAfterSeconds });
    }
    if (!await move(repository, target, lease, current, "FAILED_FINAL", error.code)) return Object.freeze({ status: "FENCED_OUT", targetId: target.targetId, errorCode: "PREPARATION_FENCED", retryAfterSeconds: null });
    return Object.freeze({ status: "FAILED_FINAL", targetId: target.targetId, errorCode: error.code, retryAfterSeconds: null });
  }
}
