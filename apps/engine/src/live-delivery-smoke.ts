import { TelegramAdapterError } from "../../../packages/telegram-contract/src/index.ts";
import { createTeleprotoProductionAdapter, TeleprotoSessionConfig } from "./teleproto-adapter.ts";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function parseSource(value: string): Readonly<{ channelUsername: string; messageId: number }> {
  const match = /^https:\/\/t\.me\/([A-Za-z][A-Za-z0-9_]{3,31})\/(\d+)$/.exec(value.trim());
  if (!match) throw new Error("TELEGRAM_TEST_FORWARD_SOURCE_INVALID");
  const messageId = Number(match[2]);
  if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new Error("TELEGRAM_TEST_FORWARD_SOURCE_INVALID");
  return Object.freeze({ channelUsername: match[1]!, messageId });
}

if (process.env.TELEGRAM_F3_LIVE_SEND !== "1") {
  throw new Error("TELEGRAM_F3_LIVE_SEND_MUST_EQUAL_1");
}

const adapter = createTeleprotoProductionAdapter(new TeleprotoSessionConfig({
  apiId: Number(required("TELEGRAM_TEST_API_ID")),
  apiHash: required("TELEGRAM_TEST_API_HASH"),
  session: required("TELEPROTO_TEST_SESSION"),
}));

const evidence: Record<string, unknown> = { scenario: "f3_controlled_delivery", passed: false };
try {
  const targetRef = required("TELEGRAM_TEST_PUBLIC_TARGET");
  const source = parseSource(process.env.TELEGRAM_TEST_FORWARD_SOURCE?.trim() || "https://t.me/VadeMecums/204");
  await adapter.connect();
  let target = await adapter.resolveTarget(targetRef);
  evidence.targetType = target.entityType;
  evidence.membershipBefore = target.membership;
  if (target.membership !== "MEMBER") {
    evidence.join = (await adapter.joinPublicTarget(targetRef)).state;
    target = await adapter.resolveTarget(targetRef);
  }
  if (target.membership !== "MEMBER") throw new TelegramAdapterError({ code: "JOIN_APPROVAL_REQUIRED", retryable: false });

  const discussionChannel = process.env.TELEGRAM_TEST_DISCUSSION_CHANNEL?.trim();
  if (discussionChannel) {
    const linked = await adapter.resolveLinkedDiscussion(discussionChannel);
    evidence.linkedDiscussion = linked.discussion === null ? "NONE" : linked.discussion.entityType;
    evidence.linkedDiscussionMembership = linked.discussion?.membership ?? null;
  }

  const marker = `F3 delivery smoke ${new Date().toISOString()}`;
  const textReceipt = await adapter.sendText({ targetRef, text: marker });
  const forwardReceipt = await adapter.forwardNative({
    targetRef,
    source,
    sourceAttribution: "SHOW_SOURCE",
  });
  evidence.textReceiptCount = textReceipt.providerMessageIds.length;
  evidence.forwardReceiptCount = forwardReceipt.providerMessageIds.length;
  evidence.membershipAfter = target.membership;
  evidence.passed = true;
} catch (error) {
  if (error instanceof TelegramAdapterError) Object.assign(evidence, error.publicData());
  else evidence.code = error instanceof Error ? error.message : "LIVE_SMOKE_UNKNOWN";
  process.exitCode = 1;
} finally {
  try { await adapter.disconnect(); }
  catch { evidence.disconnect = "FAILED"; process.exitCode = 1; }
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}
