export const ACCOUNT_MODES = ["JASEB_WORKER", "USERBOT"] as const;
export type AccountMode = (typeof ACCOUNT_MODES)[number];

export type BroadcastRequest = {
  operationId: string;
  accountId: string;
  accountMode: AccountMode;
  targetIds: readonly string[];
  text: string;
};

export type SendCommand = {
  kind: "SEND_TEXT";
  commandId: string;
  idempotencyKey: string;
  operationId: string;
  accountId: string;
  accountMode: AccountMode;
  targetId: string;
  text: string;
};

export type BroadcastPlan =
  | { status: "PLANNED"; commands: readonly SendCommand[] }
  | { status: "REJECTED"; code: "INVALID_BROADCAST" | "DUPLICATE_TARGET"; commands: readonly [] };

export type ChannelPost = {
  channelId: string;
  postId: string;
  text: string;
  discussionTargetId?: string;
};

export type CommentRule = {
  ruleId: string;
  accountId: string;
  regexSource: string;
  regexFlags?: string;
  commentText: string;
};

export type CommentPlan =
  | { status: "IGNORED_NO_MATCH" | "DUPLICATE_SUPPRESSED"; commands: readonly [] }
  | { status: "PLANNED"; commands: readonly [CommentCommand] }
  | { status: "REJECTED"; code: "INVALID_RULE" | "INVALID_REGEX" | "DISCUSSION_TARGET_MISSING"; commands: readonly [] };

export type CommentCommand = {
  kind: "COMMENT_TEXT";
  commandId: string;
  idempotencyKey: string;
  ruleId: string;
  accountId: string;
  channelId: string;
  channelPostId: string;
  discussionTargetId: string;
  text: string;
};

const MAX_TEXT_LENGTH = 4096;
const MAX_REGEX_LENGTH = 256;
const SAFE_FLAGS = /^[imsu]*$/;

function required(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function planBroadcast(request: BroadcastRequest): BroadcastPlan {
  if (!required(request?.operationId) || !required(request?.accountId) || !ACCOUNT_MODES.includes(request?.accountMode) || !required(request?.text) || request.text.length > MAX_TEXT_LENGTH || !Array.isArray(request?.targetIds) || request.targetIds.length === 0 || request.targetIds.some((target) => !required(target))) {
    return { status: "REJECTED", code: "INVALID_BROADCAST", commands: [] };
  }
  const targets = request.targetIds.map((target) => target.trim());
  if (new Set(targets).size !== targets.length) return { status: "REJECTED", code: "DUPLICATE_TARGET", commands: [] };
  const commands = targets.map((targetId) => ({
    kind: "SEND_TEXT" as const,
    commandId: `send:${request.operationId}:${targetId}`,
    idempotencyKey: `broadcast:${request.operationId}:${targetId}`,
    operationId: request.operationId,
    accountId: request.accountId.trim(),
    accountMode: request.accountMode,
    targetId,
    text: request.text,
  }));
  return { status: "PLANNED", commands };
}

function validRule(rule: CommentRule): boolean {
  return required(rule?.ruleId) && required(rule?.accountId) && required(rule?.regexSource) && rule.regexSource.length <= MAX_REGEX_LENGTH && SAFE_FLAGS.test(rule.regexFlags ?? "") && required(rule?.commentText) && rule.commentText.length <= MAX_TEXT_LENGTH;
}

export function planAutoComment(rule: CommentRule, post: ChannelPost, seenIdempotencyKeys: ReadonlySet<string> = new Set()): CommentPlan {
  if (!validRule(rule)) return { status: "REJECTED", code: "INVALID_RULE", commands: [] };
  if (!required(post?.channelId) || !required(post?.postId) || typeof post.text !== "string") return { status: "REJECTED", code: "INVALID_RULE", commands: [] };
  let matcher: RegExp;
  try {
    matcher = new RegExp(rule.regexSource, rule.regexFlags ?? "");
  } catch {
    return { status: "REJECTED", code: "INVALID_REGEX", commands: [] };
  }
  if (!matcher.test(post.text)) return { status: "IGNORED_NO_MATCH", commands: [] };
  if (!required(post.discussionTargetId)) return { status: "REJECTED", code: "DISCUSSION_TARGET_MISSING", commands: [] };
  const idempotencyKey = `comment:${rule.ruleId}:${post.channelId}:${post.postId}`;
  if (seenIdempotencyKeys.has(idempotencyKey)) return { status: "DUPLICATE_SUPPRESSED", commands: [] };
  return {
    status: "PLANNED",
    commands: [{
      kind: "COMMENT_TEXT",
      commandId: `comment:${rule.ruleId}:${post.channelId}:${post.postId}`,
      idempotencyKey,
      ruleId: rule.ruleId,
      accountId: rule.accountId,
      channelId: post.channelId,
      channelPostId: post.postId,
      discussionTargetId: post.discussionTargetId,
      text: rule.commentText,
    }],
  };
}
