import assert from "node:assert/strict";
import test from "node:test";
import { deliverBroadcastMaterial, TelegramAdapterError, telegramDeliveryReceipt, type NativeForwardRequest, type TelegramDeliveryAdapter, type TelegramDeliveryReceipt } from "../src/telegram/adapter.ts";

class RecordingAdapter implements TelegramDeliveryAdapter {
  readonly state = "READY" as const;
  readonly texts: { targetRef: string; text: string }[] = [];
  readonly forwards: NativeForwardRequest[] = [];
  async connect() {}
  async disconnect() {}
  async resolveTarget(targetRef: string) { return { canonicalRef: targetRef, entityType: "SUPERGROUP" as const, membership: "MEMBER" as const, title: null }; }
  async resolveLinkedDiscussion(sourceChannelRef: string) { return { source: { canonicalRef: sourceChannelRef, entityType: "CHANNEL" as const, membership: "MEMBER" as const, title: null }, discussion: { canonicalRef: "@discussion", entityType: "SUPERGROUP" as const, membership: "MEMBER" as const, title: null } }; }
  async joinPublicTarget() { return { state: "ALREADY_MEMBER" as const }; }
  async sendText(input: { targetRef: string; text: string }): Promise<TelegramDeliveryReceipt> { this.texts.push(input); return telegramDeliveryReceipt(["9001"], "2026-08-29T08:00:00.000Z"); }
  async forwardNative(input: NativeForwardRequest): Promise<TelegramDeliveryReceipt> { this.forwards.push(input); return telegramDeliveryReceipt(["9101", "9102", "9103", "9104"], "2026-08-29T08:00:01.000Z"); }
  async listNewChannelPosts() { return []; }
  async latestChannelPostId() { return null; }
}

test("manual wording uses only the Telegram text operation", async () => {
  const adapter = new RecordingAdapter();
  const result = await deliverBroadcastMaterial(adapter, "@lpm", { kind: "TEXT", text: "promo" });
  assert.deepEqual(adapter.texts, [{ targetRef: "@lpm", text: "promo" }]);
  assert.equal(adapter.forwards.length, 0);
  assert.deepEqual(result.providerMessageIds, ["9001"]);
});

test("a source post is one native-forward request even when Telegram returns a multi-media album", async () => {
  const adapter = new RecordingAdapter();
  const result = await deliverBroadcastMaterial(adapter, "@lpm", { kind: "FORWARD", source: { channelUsername: "VadeMecums", messageId: 204, canonicalLink: "https://t.me/VadeMecums/204" }, sourceAttribution: "SHOW_SOURCE" });
  assert.equal(adapter.texts.length, 0);
  assert.deepEqual(adapter.forwards, [{ targetRef: "@lpm", source: { channelUsername: "VadeMecums", messageId: 204 }, sourceAttribution: "SHOW_SOURCE" }]);
  assert.deepEqual(result.providerMessageIds, ["9101", "9102", "9103", "9104"]);
});

test("delivery receipts and public adapter errors reject ambiguous or raw provider data", () => {
  assert.throws(() => telegramDeliveryReceipt([], new Date().toISOString()), /INVALID_PROVIDER_MESSAGE_IDS/);
  assert.throws(() => telegramDeliveryReceipt(["1", "1"], new Date().toISOString()), /INVALID_PROVIDER_MESSAGE_IDS/);
  const raw = new Error("private provider detail");
  const error = new TelegramAdapterError({ code: "FLOOD_WAIT", retryable: true, retryAfterSeconds: 30, cause: raw });
  assert.deepEqual(error.publicData(), { code: "FLOOD_WAIT", retryable: true, retryAfterSeconds: 30, sideEffectState: "NOT_SENT" });
  assert.equal(JSON.stringify(error.publicData()).includes("private provider detail"), false);
});
