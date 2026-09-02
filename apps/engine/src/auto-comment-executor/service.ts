import { TelegramAdapterError, type TelegramDeliveryAdapter } from "../../../../packages/telegram-contract/src/index.ts";
import type {
  AutoCommentExecutorRepository,
  AutoCommentFinishOutcome,
  ClaimedAutoCommentCommand,
} from "./repository.ts";

type LeaseContext = Readonly<{
  accountId: string;
  leaseOwner: string;
  fencingToken: bigint;
}>;
type ExecutorPolicy = Readonly<{
  commandLeaseSeconds?: number;
  maxTransientAttempts?: number;
  baseRetrySeconds?: number;
  maxRetrySeconds?: number;
}>;

export type AutoCommentExecutionResult =
  | Readonly<{ status: "IDLE" }>
  | Readonly<{ status: "SUCCEEDED" | "RETRY_SCHEDULED" | "FAILED_FINAL" | "SIDE_EFFECT_UNCERTAIN"; commandId: string; errorCode?: string; retryAfterSeconds?: number }>
  | Readonly<{ status: "FENCED_OUT"; commandId: string }>;

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
}

type CommentPayload = Readonly<{ text: string; sourceChannelRef: string | null; channelPostId: string | null }>;

// sourceChannelRef/channelPostId are only present on commands queued after
// the reply-to-post fix -- older already-queued commands fall back to a
// bare message into the discussion group (command.targetRef), same as before.
function parseCommentPayload(command: ClaimedAutoCommentCommand): CommentPayload {
  const payload = asRecord(command.payload);
  const text = payload?.text;
  if (command.kind !== "COMMENT_TEXT" || typeof text !== "string" || !text.trim() || text.length > 4096) {
    throw new TypeError("INVALID_AUTO_COMMENT_COMMAND_PAYLOAD");
  }
  const sourceChannelRef = typeof payload?.sourceChannelRef === "string" && payload.sourceChannelRef.trim() ? payload.sourceChannelRef.trim() : null;
  const channelPostId = typeof payload?.channelPostId === "string" && /^\d+$/.test(payload.channelPostId) ? payload.channelPostId : null;
  return Object.freeze({ text, sourceChannelRef, channelPostId });
}

function policy(input: ExecutorPolicy) {
  const commandLeaseSeconds = input.commandLeaseSeconds ?? 60;
  const maxTransientAttempts = input.maxTransientAttempts ?? 5;
  const baseRetrySeconds = input.baseRetrySeconds ?? 5;
  const maxRetrySeconds = input.maxRetrySeconds ?? 300;
  if (!Number.isInteger(commandLeaseSeconds) || commandLeaseSeconds < 1 || commandLeaseSeconds > 3600) throw new TypeError("INVALID_COMMAND_LEASE_SECONDS");
  if (!Number.isInteger(maxTransientAttempts) || maxTransientAttempts < 1 || maxTransientAttempts > 100) throw new TypeError("INVALID_MAX_TRANSIENT_ATTEMPTS");
  if (!Number.isInteger(baseRetrySeconds) || baseRetrySeconds < 1 || !Number.isInteger(maxRetrySeconds) || maxRetrySeconds < baseRetrySeconds || maxRetrySeconds > 86400) throw new TypeError("INVALID_RETRY_POLICY");
  return Object.freeze({ commandLeaseSeconds, maxTransientAttempts, baseRetrySeconds, maxRetrySeconds });
}

function retrySeconds(attemptCount: number, base: number, maximum: number): number {
  return Math.min(maximum, base * (2 ** Math.min(Math.max(attemptCount - 1, 0), 20)));
}

async function persist(
  repository: AutoCommentExecutorRepository,
  lease: LeaseContext,
  commandId: string,
  outcome: AutoCommentFinishOutcome,
): Promise<AutoCommentExecutionResult | null> {
  const finished = await repository.finish({
    commandId,
    accountId: lease.accountId,
    leaseOwner: lease.leaseOwner,
    accountFencingToken: lease.fencingToken,
    outcome,
  });
  return finished ? null : Object.freeze({ status: "FENCED_OUT" as const, commandId });
}

/**
 * Sends exactly one due, already-decided auto-comment reply (Tepat or an
 * AUTO_SEND-mode match) as soon as it is claimed -- no interval, no batching.
 * Mirrors executeNextBroadcast's claim/send/finish shape and retry policy.
 */
export async function executeNextAutoComment(
  adapter: TelegramDeliveryAdapter,
  repository: AutoCommentExecutorRepository,
  lease: LeaseContext,
  inputPolicy: ExecutorPolicy = {},
): Promise<AutoCommentExecutionResult> {
  const configured = policy(inputPolicy);
  const command = await repository.claimNext({
    accountId: lease.accountId,
    leaseOwner: lease.leaseOwner,
    accountFencingToken: lease.fencingToken,
    commandLeaseSeconds: configured.commandLeaseSeconds,
  });
  if (!command) return Object.freeze({ status: "IDLE" });
  if (command.accountId !== lease.accountId || command.fencingToken !== lease.fencingToken || command.attemptCount < 1) {
    const outcome = Object.freeze({ status: "FAILED_FINAL" as const, errorCode: "INVALID_CLAIM_CONTEXT" });
    return await persist(repository, lease, command.id, outcome)
      ?? Object.freeze({ status: "FAILED_FINAL", commandId: command.id, errorCode: outcome.errorCode });
  }

  let comment: CommentPayload;
  try { comment = parseCommentPayload(command); }
  catch {
    const outcome = Object.freeze({ status: "FAILED_FINAL" as const, errorCode: "INVALID_AUTO_COMMENT_COMMAND_PAYLOAD" });
    return await persist(repository, lease, command.id, outcome)
      ?? Object.freeze({ status: "FAILED_FINAL", commandId: command.id, errorCode: outcome.errorCode });
  }

  try {
    const receipt = comment.sourceChannelRef && comment.channelPostId
      ? await adapter.sendText({ targetRef: comment.sourceChannelRef, text: comment.text, commentToPostId: comment.channelPostId })
      : await adapter.sendText({ targetRef: command.targetRef, text: comment.text });
    const fenced = await persist(repository, lease, command.id, Object.freeze({ status: "SUCCEEDED", receipt }));
    return fenced ?? Object.freeze({ status: "SUCCEEDED", commandId: command.id });
  } catch (rawError) {
    const error = rawError instanceof TelegramAdapterError
      ? rawError
      : new TelegramAdapterError({ code: "TELEGRAM_UNKNOWN", retryable: false, sideEffectState: "UNKNOWN", cause: rawError });
    if (error.sideEffectState === "UNKNOWN") {
      const outcome = Object.freeze({ status: "SIDE_EFFECT_UNCERTAIN" as const, errorCode: error.code });
      return await persist(repository, lease, command.id, outcome)
        ?? Object.freeze({ status: "SIDE_EFFECT_UNCERTAIN", commandId: command.id, errorCode: outcome.errorCode });
    }
    if (error.retryable && (error.code === "FLOOD_WAIT" || command.attemptCount < configured.maxTransientAttempts)) {
      const providerWait = Number.isSafeInteger(error.retryAfterSeconds) && Number(error.retryAfterSeconds) > 0 && Number(error.retryAfterSeconds) <= 2_147_483_647
        ? Number(error.retryAfterSeconds)
        : null;
      const wait = providerWait ?? retrySeconds(command.attemptCount, configured.baseRetrySeconds, configured.maxRetrySeconds);
      const outcome = Object.freeze({ status: "FAILED_RETRYABLE" as const, errorCode: error.code, retryAfterSeconds: wait });
      return await persist(repository, lease, command.id, outcome)
        ?? Object.freeze({ status: "RETRY_SCHEDULED", commandId: command.id, errorCode: outcome.errorCode, retryAfterSeconds: wait });
    }
    const errorCode = error.retryable ? "RETRY_ATTEMPTS_EXHAUSTED" : error.code;
    const outcome = Object.freeze({ status: "FAILED_FINAL" as const, errorCode });
    return await persist(repository, lease, command.id, outcome)
      ?? Object.freeze({ status: "FAILED_FINAL", commandId: command.id, errorCode });
  }
}
