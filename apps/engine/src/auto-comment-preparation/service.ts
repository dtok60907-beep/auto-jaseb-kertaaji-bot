import {
  TelegramAdapterError,
  type TelegramDeliveryAdapter,
  type TelegramTarget,
} from "../../../../packages/telegram-contract/src/index.ts";
import type { AutoCommentPreparationRepository, AutoCommentResolutionStatus, ClaimedAutoCommentPreparation } from "./repository.ts";

type LeaseContext = Readonly<{ accountId: string; leaseOwner: string; accountFencingToken: bigint }>;
const APPROVAL_RECHECK_SECONDS = 30;
export type AutoCommentPreparationResult =
  | Readonly<{ status: "NO_TARGET" }>
  | Readonly<{ status: "READY" | "WAITING_APPROVAL" | "RETRYABLE" | "FAILED_FINAL" | "FENCED_OUT"; channelTargetId: string; discussionTargetRef: string | null; errorCode: string | null; retryAfterSeconds: number | null }>;

function normalizedError(error: unknown): TelegramAdapterError {
  return error instanceof TelegramAdapterError ? error : new TelegramAdapterError({ code: "TELEGRAM_UNKNOWN", retryable: false, cause: error });
}
async function move(repository: AutoCommentPreparationRepository, target: ClaimedAutoCommentPreparation, lease: LeaseContext, expectedStatus: "CHECKING" | "JOINING", status: AutoCommentResolutionStatus, discussionTargetRef: string | null, errorCode: string | null = null, retryAfterSeconds: number | null = null) {
  return repository.transition({ channelTargetId: target.channelTargetId, ...lease, expectedStatus, status, discussionTargetRef, errorCode, retryAfterSeconds });
}
function result(status: Exclude<AutoCommentPreparationResult["status"], "NO_TARGET">, target: ClaimedAutoCommentPreparation, discussionTargetRef: string | null, errorCode: string | null, retryAfterSeconds: number | null): AutoCommentPreparationResult {
  return Object.freeze({ status, channelTargetId: target.channelTargetId, discussionTargetRef, errorCode, retryAfterSeconds });
}

export async function prepareNextAutoCommentDiscussion(adapter: TelegramDeliveryAdapter, repository: AutoCommentPreparationRepository, lease: LeaseContext): Promise<AutoCommentPreparationResult> {
  const target = await repository.claimNext(lease);
  if (!target) return Object.freeze({ status: "NO_TARGET" });
  let current: "CHECKING" | "JOINING" = "CHECKING";
  let discussion: TelegramTarget | null = null;
  try {
    if (target.previousStatus === "WAITING_APPROVAL" && target.discussionTargetRef) {
      discussion = await adapter.resolveTarget(target.discussionTargetRef);
    } else {
      const linked = await adapter.resolveLinkedDiscussion(target.sourceChannelRef);
      if (linked.source.entityType !== "CHANNEL") {
        if (!await move(repository, target, lease, current, "FAILED_FINAL", null, "AUTO_COMMENT_SOURCE_NOT_CHANNEL")) return result("FENCED_OUT", target, null, "PREPARATION_FENCED", null);
        return result("FAILED_FINAL", target, null, "AUTO_COMMENT_SOURCE_NOT_CHANNEL", null);
      }
      discussion = linked.discussion;
      if (!discussion) {
        if (!await move(repository, target, lease, current, "FAILED_FINAL", null, "DISCUSSION_NOT_LINKED")) return result("FENCED_OUT", target, null, "PREPARATION_FENCED", null);
        return result("FAILED_FINAL", target, null, "DISCUSSION_NOT_LINKED", null);
      }
    }
    if (discussion.entityType === "CHANNEL") {
      if (!await move(repository, target, lease, current, "FAILED_FINAL", discussion.canonicalRef, "DISCUSSION_TARGET_NOT_GROUP")) return result("FENCED_OUT", target, discussion.canonicalRef, "PREPARATION_FENCED", null);
      return result("FAILED_FINAL", target, discussion.canonicalRef, "DISCUSSION_TARGET_NOT_GROUP", null);
    }
    if (discussion.membership === "MEMBER") {
      if (!await move(repository, target, lease, current, "READY", discussion.canonicalRef)) return result("FENCED_OUT", target, discussion.canonicalRef, "PREPARATION_FENCED", null);
      return result("READY", target, discussion.canonicalRef, null, null);
    }
    if (target.previousStatus === "WAITING_APPROVAL") {
      if (!await move(repository, target, lease, current, "WAITING_APPROVAL", discussion.canonicalRef, "JOIN_APPROVAL_PENDING", APPROVAL_RECHECK_SECONDS)) return result("FENCED_OUT", target, discussion.canonicalRef, "PREPARATION_FENCED", null);
      return result("WAITING_APPROVAL", target, discussion.canonicalRef, "JOIN_APPROVAL_PENDING", APPROVAL_RECHECK_SECONDS);
    }
    if (!await move(repository, target, lease, current, "JOINING", discussion.canonicalRef)) return result("FENCED_OUT", target, discussion.canonicalRef, "PREPARATION_FENCED", null);
    current = "JOINING";
    const joined = await adapter.joinPublicTarget(discussion.canonicalRef);
    if (joined.state === "APPROVAL_REQUESTED") {
      if (!await move(repository, target, lease, current, "WAITING_APPROVAL", discussion.canonicalRef, "JOIN_APPROVAL_PENDING", APPROVAL_RECHECK_SECONDS)) return result("FENCED_OUT", target, discussion.canonicalRef, "PREPARATION_FENCED", null);
      return result("WAITING_APPROVAL", target, discussion.canonicalRef, "JOIN_APPROVAL_PENDING", APPROVAL_RECHECK_SECONDS);
    }
    if (!await move(repository, target, lease, current, "READY", discussion.canonicalRef)) return result("FENCED_OUT", target, discussion.canonicalRef, "PREPARATION_FENCED", null);
    return result("READY", target, discussion.canonicalRef, null, null);
  } catch (rawError) {
    const error = normalizedError(rawError);
    const discussionRef = discussion?.canonicalRef ?? target.discussionTargetRef;
    if (error.code === "JOIN_APPROVAL_REQUIRED") {
      if (!discussionRef || !await move(repository, target, lease, current, "WAITING_APPROVAL", discussionRef, "JOIN_APPROVAL_PENDING", APPROVAL_RECHECK_SECONDS)) return result("FENCED_OUT", target, discussionRef, "PREPARATION_FENCED", null);
      return result("WAITING_APPROVAL", target, discussionRef, "JOIN_APPROVAL_PENDING", APPROVAL_RECHECK_SECONDS);
    }
    if (error.retryable) {
      const retryAfterSeconds = error.retryAfterSeconds ?? 1;
      const retryStatus = target.previousStatus === "WAITING_APPROVAL" && current === "CHECKING" && discussionRef ? "WAITING_APPROVAL" : "QUEUED";
      if (!await move(repository, target, lease, current, retryStatus, discussionRef, error.code, retryAfterSeconds)) return result("FENCED_OUT", target, discussionRef, "PREPARATION_FENCED", null);
      return result(retryStatus === "WAITING_APPROVAL" ? "WAITING_APPROVAL" : "RETRYABLE", target, discussionRef, error.code, retryAfterSeconds);
    }
    if (!await move(repository, target, lease, current, "FAILED_FINAL", discussionRef, error.code)) return result("FENCED_OUT", target, discussionRef, "PREPARATION_FENCED", null);
    return result("FAILED_FINAL", target, discussionRef, error.code, null);
  }
}
