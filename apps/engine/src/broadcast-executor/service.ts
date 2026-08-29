import {
  TelegramAdapterError,
  type NativeForwardRequest,
  type TelegramDeliveryAdapter,
} from "../../../../packages/telegram-contract/src/index.ts";
import type {
  BroadcastExecutorRepository,
  BroadcastFinishOutcome,
  ClaimedBroadcastCommand,
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
type Material =
  | Readonly<{ kind: "TEXT"; text: string }>
  | Readonly<{ kind: "FORWARD"; source: NativeForwardRequest["source"]; sourceAttribution: NativeForwardRequest["sourceAttribution"] }>;

export type BroadcastExecutionResult =
  | Readonly<{ status: "IDLE" }>
  | Readonly<{ status: "SUCCEEDED" | "RETRY_SCHEDULED" | "FAILED_FINAL" | "SIDE_EFFECT_UNCERTAIN"; commandId: string; errorCode?: string; retryAfterSeconds?: number }>
  | Readonly<{ status: "FENCED_OUT"; commandId: string }>;

const USERNAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
}

function parseMaterial(command: ClaimedBroadcastCommand): Material {
  const envelope = asRecord(command.payload);
  const material = asRecord(envelope?.material);
  if (!material) throw new TypeError("INVALID_BROADCAST_COMMAND_PAYLOAD");
  if (material.kind === "TEXT") {
    if (command.kind !== "SEND_TEXT" || typeof material.text !== "string" || !material.text.trim() || material.text.length > 4096) throw new TypeError("INVALID_BROADCAST_COMMAND_PAYLOAD");
    return Object.freeze({ kind: "TEXT", text: material.text });
  }
  const source = asRecord(material.source);
  const username = typeof source?.channelUsername === "string" ? source.channelUsername.replace(/^@/, "") : "";
  const messageId = source?.messageId;
  if (
    material.kind !== "FORWARD" || command.kind !== "FORWARD_MESSAGE" || !USERNAME.test(username)
    || !Number.isSafeInteger(messageId) || Number(messageId) <= 0
    || (material.sourceAttribution !== "SHOW_SOURCE" && material.sourceAttribution !== "HIDE_SOURCE")
  ) throw new TypeError("INVALID_BROADCAST_COMMAND_PAYLOAD");
  return Object.freeze({
    kind: "FORWARD",
    source: Object.freeze({ channelUsername: username, messageId: Number(messageId) }),
    sourceAttribution: material.sourceAttribution,
  });
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
  repository: BroadcastExecutorRepository,
  lease: LeaseContext,
  commandId: string,
  outcome: BroadcastFinishOutcome,
): Promise<BroadcastExecutionResult | null> {
  const finished = await repository.finish({
    commandId,
    accountId: lease.accountId,
    leaseOwner: lease.leaseOwner,
    accountFencingToken: lease.fencingToken,
    outcome,
  });
  return finished ? null : Object.freeze({ status: "FENCED_OUT" as const, commandId });
}

export async function executeNextBroadcast(
  adapter: TelegramDeliveryAdapter,
  repository: BroadcastExecutorRepository,
  lease: LeaseContext,
  inputPolicy: ExecutorPolicy = {},
): Promise<BroadcastExecutionResult> {
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

  let material: Material;
  try { material = parseMaterial(command); }
  catch {
    const outcome = Object.freeze({ status: "FAILED_FINAL" as const, errorCode: "INVALID_BROADCAST_COMMAND_PAYLOAD" });
    return await persist(repository, lease, command.id, outcome)
      ?? Object.freeze({ status: "FAILED_FINAL", commandId: command.id, errorCode: outcome.errorCode });
  }

  try {
    const receipt = material.kind === "TEXT"
      ? await adapter.sendText({ targetRef: command.targetRef, text: material.text })
      : await adapter.forwardNative({ targetRef: command.targetRef, source: material.source, sourceAttribution: material.sourceAttribution });
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
