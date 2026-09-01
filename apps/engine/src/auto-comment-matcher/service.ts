import { createAutoCommentCandidate } from "../../../../packages/auto-comment-contract/src/index.ts";
import {
  TelegramAdapterError,
  type IncomingChannelMessage,
  type TelegramDeliveryAdapter,
} from "../../../../packages/telegram-contract/src/index.ts";
import type { AutoCommentNotificationResponder } from "./notifier.ts";
import type { AutoCommentMatcherRepository, ClaimedAutoCommentMonitoringTarget, DivisionMatchConfig } from "./repository.ts";

type LeaseContext = Readonly<{ accountId: string; leaseOwner: string; accountFencingToken: bigint }>;

const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const DEFAULT_POSTS_PER_POLL = 50;
/**
 * A burst larger than one batch is drained fully within the same check
 * (up to this many batches) instead of waiting another poll interval per
 * batch, bounded so a channel that never stops posting cannot hold one
 * account's turn forever.
 */
const MAX_BATCHES_PER_CHECK = 5;

export type AutoCommentMatcherResult =
  | Readonly<{ status: "NO_TARGET" }>
  | Readonly<{
      status: "CHECKED" | "RETRYABLE" | "FENCED_OUT" | "FAILED";
      channelTargetId: string;
      errorCode: string | null;
      retryAfterSeconds: number | null;
      postsScanned: number;
      candidatesCreated: number;
    }>;

function normalizedError(error: unknown): TelegramAdapterError {
  return error instanceof TelegramAdapterError ? error : new TelegramAdapterError({ code: "TELEGRAM_UNKNOWN", retryable: false, cause: error });
}

function result(
  status: Exclude<AutoCommentMatcherResult["status"], "NO_TARGET">,
  target: ClaimedAutoCommentMonitoringTarget,
  errorCode: string | null,
  retryAfterSeconds: number | null,
  postsScanned = 0,
  candidatesCreated = 0,
): AutoCommentMatcherResult {
  return Object.freeze({ status, channelTargetId: target.channelTargetId, errorCode, retryAfterSeconds, postsScanned, candidatesCreated });
}

function matchedKeywords(post: IncomingChannelMessage, division: DivisionMatchConfig): readonly string[] {
  const haystack = post.text.toLocaleLowerCase("id-ID");
  return division.keywords.filter((keyword) => haystack.includes(keyword.toLocaleLowerCase("id-ID")));
}

function postLink(sourceChannelRef: string, channelPostId: string): string {
  return `https://t.me/${sourceChannelRef.replace(/^@/, "")}/${channelPostId}`;
}

async function recordMatch(
  repository: AutoCommentMatcherRepository,
  notifier: AutoCommentNotificationResponder | undefined,
  target: ClaimedAutoCommentMonitoringTarget,
  post: IncomingChannelMessage,
  division: DivisionMatchConfig,
): Promise<boolean> {
  const keywords = matchedKeywords(post, division);
  if (keywords.length === 0) return false;
  const template = division.templates[0];
  if (!template) return false;

  let candidate;
  try {
    candidate = createAutoCommentCandidate({
      candidateId: `${target.channelTargetId}:${post.channelPostId}:${division.divisionId}`,
      division: {
        divisionId: division.divisionId,
        accountId: division.accountId,
        name: division.name,
        mode: division.mode,
        keywords: division.keywords,
        templates: division.templates.map((item) => item.text),
      },
      channelId: target.sourceChannelRef,
      channelPostId: post.channelPostId,
      discussionTargetId: target.discussionTargetRef,
      matchedKeywords: keywords,
      template: { templateId: template.templateId, text: template.text },
    });
  } catch {
    return false;
  }

  const created = await repository.createCandidate({
    channelTargetId: target.channelTargetId,
    divisionId: division.divisionId,
    accountId: division.accountId,
    sourceChannelRef: target.sourceChannelRef,
    providerPostId: post.channelPostId,
    postContent: post.text,
    matchedKeywords: candidate.candidate.matchedKeywords,
    selectedTemplateId: candidate.candidate.template.templateId,
    templateText: candidate.candidate.template.text,
    mode: division.mode,
    discussionTargetRef: target.discussionTargetRef,
  });
  if (created.status === "ALREADY_EXISTS") return false;

  if (created.status === "PENDING_REVIEW" && notifier && division.telegramUserId !== null) {
    try {
      const messageId = await notifier.sendCandidateNotification({
        chatId: division.telegramUserId,
        candidateId: created.candidateId,
        channelLabel: target.sourceChannelRef,
        matchedKeywords: keywords,
        postLink: postLink(target.sourceChannelRef, post.channelPostId),
        postPreview: post.text,
        templateText: candidate.candidate.template.text,
      });
      await repository.recordNotification({ candidateId: created.candidateId, messageId });
    } catch {
      // Best-effort for slice 1: an undelivered notification just leaves the
      // candidate waiting silently; it is still visible to a future UI/poll.
    }
  }
  return true;
}

/**
 * Seeds a fresh channel target's checkpoint at its current latest post,
 * instead of scanning its whole history the first time it is polled.
 */
async function seedCheckpoint(
  adapter: TelegramDeliveryAdapter,
  repository: AutoCommentMatcherRepository,
  lease: LeaseContext,
  target: ClaimedAutoCommentMonitoringTarget,
): Promise<AutoCommentMatcherResult> {
  const latest = await adapter.latestChannelPostId(target.sourceChannelRef);
  const latestId = latest === null ? null : Number(latest);
  if (latestId === null || !Number.isSafeInteger(latestId) || latestId <= 0) return result("CHECKED", target, null, null);
  const advanced = await repository.advanceCheckpoint({ ...lease, channelTargetId: target.channelTargetId, lastPostId: latestId });
  return advanced ? result("CHECKED", target, null, null) : result("FENCED_OUT", target, "MONITORING_FENCED", null);
}

export async function checkNextAutoCommentChannel(
  adapter: TelegramDeliveryAdapter,
  repository: AutoCommentMatcherRepository,
  lease: LeaseContext,
  options: Readonly<{ notifier?: AutoCommentNotificationResponder; pollIntervalSeconds?: number; postsPerPoll?: number }> = {},
): Promise<AutoCommentMatcherResult> {
  const pollIntervalSeconds = options.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS;
  const postsPerPoll = options.postsPerPoll ?? DEFAULT_POSTS_PER_POLL;
  const target = await repository.claimNext({ ...lease, pollIntervalSeconds });
  if (!target) return Object.freeze({ status: "NO_TARGET" });

  try {
    if (target.monitoringLastPostId === null) return await seedCheckpoint(adapter, repository, lease, target);

    let divisions: readonly DivisionMatchConfig[] | null = null;
    let candidatesCreated = 0;
    let postsScanned = 0;
    let highestPostId = target.monitoringLastPostId;

    for (let batch = 0; batch < MAX_BATCHES_PER_CHECK; batch += 1) {
      const posts = await adapter.listNewChannelPosts(target.sourceChannelRef, { afterMessageId: highestPostId, limit: postsPerPoll });
      if (posts.length === 0) break;
      if (divisions === null) divisions = await repository.divisionsFor(target.channelTargetId);

      for (const post of posts) {
        const postId = Number(post.channelPostId);
        if (Number.isSafeInteger(postId) && postId > highestPostId) highestPostId = postId;
        if (!post.text.trim()) continue;
        for (const division of divisions) {
          if (await recordMatch(repository, options.notifier, target, post, division)) candidatesCreated += 1;
        }
      }
      postsScanned += posts.length;
      // A partial batch means the channel is caught up; a full batch means
      // there is likely more waiting right now, so drain it immediately.
      if (posts.length < postsPerPoll) break;
    }

    if (highestPostId > target.monitoringLastPostId) {
      const advanced = await repository.advanceCheckpoint({ ...lease, channelTargetId: target.channelTargetId, lastPostId: highestPostId });
      if (!advanced) return result("FENCED_OUT", target, "MONITORING_FENCED", null, postsScanned, candidatesCreated);
    }
    return result("CHECKED", target, null, null, postsScanned, candidatesCreated);
  } catch (rawError) {
    const error = normalizedError(rawError);
    if (error.retryable) return result("RETRYABLE", target, error.code, error.retryAfterSeconds ?? 1);
    return result("FAILED", target, error.code, null);
  }
}
