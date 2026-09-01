import assert from "node:assert/strict";
import test from "node:test";

import { AutoCommentNotificationDeliveryError, TelegramAutoCommentNotifier } from "../src/auto-comment-matcher/notifier.ts";

function candidate(overrides: Partial<Parameters<TelegramAutoCommentNotifier["sendCandidateNotification"]>[0]> = {}) {
  return {
    chatId: 555,
    candidateId: "11111111-1111-1111-1111-111111111111",
    channelLabel: "@menfess",
    matchedKeywords: ["promo"],
    postPreview: "cari admin promo dong",
    templateText: "Komentar promo otomatis",
    ...overrides,
  };
}

test("rejects a malformed bot token", () => {
  assert.throws(() => new TelegramAutoCommentNotifier({ botToken: "not-a-token" }), /INVALID_TELEGRAM_BOT_TOKEN/);
});

test("sends the Tepat/OOT keyboard with a bounded callback_data and returns the delivered message id", async () => {
  const requests: Array<{ input: string; init: RequestInit }> = [];
  const notifier = new TelegramAutoCommentNotifier({
    botToken: "123456:secret",
    fetch: async (input, init) => {
      requests.push({ input, init });
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 4242 } }) };
    },
  });

  const messageId = await notifier.sendCandidateNotification(candidate());

  assert.equal(messageId, 4242);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.input, "https://api.telegram.org/bot123456:secret/sendMessage");
  const body = JSON.parse(String(requests[0]?.init.body));
  assert.equal(body.chat_id, 555);
  assert.ok(body.text.includes("@menfess"));
  assert.ok(body.text.includes("promo"));
  const buttons = body.reply_markup.inline_keyboard[0];
  assert.deepEqual(buttons.map((button: { text: string }) => button.text), ["✅ Tepat", "🚫 OOT"]);
  for (const button of buttons) assert.ok(Buffer.byteLength(button.callback_data, "utf8") <= 64);
  assert.equal(buttons[0].callback_data, "autocomment:11111111-1111-1111-1111-111111111111:TEPAT");
  assert.equal(buttons[1].callback_data, "autocomment:11111111-1111-1111-1111-111111111111:OOT");
});

test("truncates long previews instead of failing", async () => {
  const requests: Array<{ init: RequestInit }> = [];
  const notifier = new TelegramAutoCommentNotifier({
    botToken: "123456:secret",
    fetch: async (_input, init) => {
      requests.push({ init });
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
    },
  });

  await notifier.sendCandidateNotification(candidate({ postPreview: "x".repeat(1000), templateText: "y".repeat(1000) }));

  const body = JSON.parse(String(requests[0]?.init.body));
  assert.ok(body.text.length < 1000);
});

test("a non-ok response or a missing message id raises a delivery error without leaking provider detail", async () => {
  const failing = new TelegramAutoCommentNotifier({ botToken: "123456:secret", fetch: async () => ({ ok: false, json: async () => ({}) }) });
  await assert.rejects(() => failing.sendCandidateNotification(candidate()), AutoCommentNotificationDeliveryError);

  const malformed = new TelegramAutoCommentNotifier({ botToken: "123456:secret", fetch: async () => ({ ok: true, json: async () => ({ ok: true, result: {} }) }) });
  await assert.rejects(() => malformed.sendCandidateNotification(candidate()), AutoCommentNotificationDeliveryError);

  const thrown = new TelegramAutoCommentNotifier({ botToken: "123456:secret", fetch: async () => { throw new Error("raw provider detail"); } });
  await assert.rejects(thrown.sendCandidateNotification(candidate()), (error: unknown) => {
    assert.ok(error instanceof AutoCommentNotificationDeliveryError);
    assert.equal(String(error).includes("raw provider detail"), false);
    return true;
  });
});

test("rejects a non-safe-integer chat id", async () => {
  const notifier = new TelegramAutoCommentNotifier({ botToken: "123456:secret", fetch: async () => ({ ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }) });
  await assert.rejects(() => notifier.sendCandidateNotification(candidate({ chatId: Number.NaN })), /INVALID_TELEGRAM_CHAT_ID/);
});
