import type { AutoCommentMode } from "../../../../packages/auto-comment-contract/src/index.ts";

export type ClaimedAutoCommentMonitoringTarget = Readonly<{
  channelTargetId: string;
  sourceChannelRef: string;
  discussionTargetRef: string;
  monitoringLastPostId: number | null;
}>;

export type DivisionMatchConfig = Readonly<{
  divisionId: string;
  accountId: string;
  name: string;
  mode: AutoCommentMode;
  keywords: readonly string[];
  /** Active templates only, ordered by displayOrder; empty means the division cannot queue a comment yet. */
  templates: readonly Readonly<{ templateId: string; text: string }>[];
  /** The division owner's Telegram chat id, or null if they have never authenticated through the bot. */
  telegramUserId: number | null;
}>;

export type CreateCandidateStatus = "COMMENT_QUEUED" | "PENDING_REVIEW" | "ALREADY_EXISTS";
export type CreateCandidateResult = Readonly<{ status: CreateCandidateStatus; candidateId: string }>;

export interface AutoCommentMatcherRepository {
  claimNext(input: Readonly<{
    accountId: string;
    leaseOwner: string;
    accountFencingToken: bigint;
    pollIntervalSeconds: number;
  }>): Promise<ClaimedAutoCommentMonitoringTarget | null>;

  divisionsFor(channelTargetId: string): Promise<readonly DivisionMatchConfig[]>;

  createCandidate(input: Readonly<{
    channelTargetId: string;
    divisionId: string;
    accountId: string;
    sourceChannelRef: string;
    providerPostId: string;
    postContent: string;
    matchedKeywords: readonly string[];
    selectedTemplateId: string;
    templateText: string;
    mode: AutoCommentMode;
    discussionTargetRef: string;
  }>): Promise<CreateCandidateResult>;

  advanceCheckpoint(input: Readonly<{
    channelTargetId: string;
    accountId: string;
    leaseOwner: string;
    accountFencingToken: bigint;
    lastPostId: number;
  }>): Promise<boolean>;

  recordNotification(input: Readonly<{ candidateId: string; messageId: number }>): Promise<void>;
}
