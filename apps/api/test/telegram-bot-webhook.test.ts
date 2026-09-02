import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import type { AutoCommentSettingsRepository } from "../src/auto-comment/repository.ts";
import { registerTelegramBotWebhookRoutes } from "../src/http/telegram-bot-webhook-routes.ts";
import { TelegramBotCallbackResponder, type TelegramCallbackResponder } from "../src/telegram-bot/decision-responder.ts";
import { TelegramBotStartResponder } from "../src/telegram-bot/start-responder.ts";

const SECRET = "webhook_secret_1234567890_abcdef";
const CANDIDATE_ID = "11111111-1111-1111-1111-111111111111";

class FakeAutoComments implements AutoCommentSettingsRepository {
  owners = new Map<string, string>();
  candidates = new Map<string, { userId: string; status: "PENDING_REVIEW" | "OOT" | "COMMENT_QUEUED" }>();
  decideCalls: Array<Parameters<AutoCommentSettingsRepository["decideCandidate"]>[0]> = [];

  async listSettings(): Promise<never> { throw new Error("unused"); }
  async createDivision(): Promise<never> { throw new Error("unused"); }
  async updateDivision(): Promise<null> { return null; }
  async deleteDivision(): Promise<boolean> { return false; }
  async createKeyword(): Promise<null> { return null; }
  async deleteKeyword(): Promise<boolean> { return false; }
  async createTemplate(): Promise<null> { return null; }
  async updateTemplate(): Promise<null> { return null; }
  async deleteTemplate(): Promise<boolean> { return false; }
  async createChannelTarget(): Promise<never> { throw new Error("unused"); }
  async updateChannelTarget(): Promise<null> { return null; }
  async deleteChannelTarget(): Promise<boolean> { return false; }
  async attachChannel(): Promise<"NOT_FOUND"> { return "NOT_FOUND"; }
  async detachChannel(): Promise<boolean> { return false; }

  async resolveOwnerId(telegramUserId: string): Promise<string | null> {
    return this.owners.get(telegramUserId) ?? null;
  }

  async decideCandidate(input: Parameters<AutoCommentSettingsRepository["decideCandidate"]>[0]) {
    this.decideCalls.push(input);
    const candidate = this.candidates.get(input.candidateId);
    if (!candidate || candidate.userId !== input.userId) return { status: "NOT_FOUND" as const, candidateId: input.candidateId, operationId: null, commandId: null };
    if (candidate.status !== "PENDING_REVIEW") return { status: "ALREADY_DECIDED" as const, candidateId: input.candidateId, operationId: null, commandId: null };
    if (input.decision === "OOT") {
      candidate.status = "OOT";
      return { status: "OOT" as const, candidateId: input.candidateId, operationId: null, commandId: null };
    }
    candidate.status = "COMMENT_QUEUED";
    return { status: "COMMENT_QUEUED" as const, candidateId: input.candidateId, operationId: "op-1", commandId: "cmd-1" };
  }
}

class FakeCallbackResponder implements TelegramCallbackResponder {
  answered: Array<{ callbackQueryId: string; text?: string }> = [];
  edited: Array<{ chatId: number; messageId: number; text: string }> = [];
  async answerCallbackQuery(callbackQueryId: string, text?: string) { this.answered.push({ callbackQueryId, text }); }
  async editMessageText(input: { chatId: number; messageId: number; text: string }) { this.edited.push(input); }
}

function harness() {
  const autoComments = new FakeAutoComments();
  const callbackResponder = new FakeCallbackResponder();
  const delivered: number[] = [];
  const app = Fastify({ logger: false });
  registerTelegramBotWebhookRoutes(app, {
    secret: SECRET,
    responder: { async sendStart(chatId) { delivered.push(chatId); } },
    callbackResponder,
    autoComments,
  });
  return { app, autoComments, callbackResponder, delivered };
}

const ORIGINAL_NOTIFICATION_TEXT = "Auto Komen Menfess: kandidat baru\n\nLink MF : https://t.me/basewtb/204";

function callbackPayload(input: Readonly<{ data: string; telegramUserId?: number; callbackQueryId?: string; messageText?: string }>) {
  return {
    update_id: 3,
    callback_query: {
      id: input.callbackQueryId ?? "cbq-1",
      from: { id: input.telegramUserId ?? 555, is_bot: false, first_name: "Test" },
      message: { message_id: 999, chat: { id: 555, type: "private" }, text: input.messageText ?? ORIGINAL_NOTIFICATION_TEXT },
      data: input.data,
    },
  };
}

test("accepts a verified private /start update and rejects an invalid secret", async (t) => {
  const { app, delivered } = harness();
  t.after(() => app.close());

  const accepted = await app.inject({
    method: "POST",
    url: "/v1/telegram/bot/webhook",
    headers: { "x-telegram-bot-api-secret-token": SECRET },
    payload: { update_id: 1, message: { text: "/start", chat: { id: 8046200601, type: "private" } } },
  });
  const denied = await app.inject({
    method: "POST",
    url: "/v1/telegram/bot/webhook",
    headers: { "x-telegram-bot-api-secret-token": "wrong_secret_1234567890_abcdef" },
    payload: { update_id: 2, message: { text: "/start", chat: { id: 9, type: "private" } } },
  });

  assert.equal(accepted.statusCode, 204);
  assert.deepEqual(delivered, [8046200601]);
  assert.equal(denied.statusCode, 401);
  assert.deepEqual(denied.json(), { code: "TELEGRAM_WEBHOOK_UNAUTHORIZED" });
});

test("sends direct product copy with a Mini App button", async () => {
  const requests: Array<{ input: string; init: RequestInit }> = [];
  const responder = new TelegramBotStartResponder({
    botToken: "123456789:test-token",
    miniAppUrl: "https://mini.example.com",
    fetch: async (input, init) => { requests.push({ input, init }); return { ok: true }; },
  });

  await responder.sendStart(12345);

  assert.equal(requests.length, 1);
  const request = requests[0];
  const body = JSON.parse(String(request.init.body));
  assert.equal(body.chat_id, 12345);
  assert.match(body.text, /Jaseb/);
  assert.match(body.text, /Auto Comment/);
  assert.match(body.text, /Userbot/);
  assert.deepEqual(body.reply_markup.inline_keyboard, [[{
    text: "Buka Mini App",
    web_app: { url: "https://mini.example.com/" },
  }]]);
  assert.equal(request.input.includes("test-token"), true);
});

test("a Tepat callback resolves the pressing user, decides the candidate, and edits the notification in place", async (t) => {
  const { app, autoComments, callbackResponder } = harness();
  t.after(() => app.close());
  autoComments.owners.set("555", "owner-1");
  autoComments.candidates.set(CANDIDATE_ID, { userId: "owner-1", status: "PENDING_REVIEW" });

  const response = await app.inject({
    method: "POST",
    url: "/v1/telegram/bot/webhook",
    headers: { "x-telegram-bot-api-secret-token": SECRET },
    payload: callbackPayload({ data: `autocomment:${CANDIDATE_ID}:TEPAT` }),
  });

  assert.equal(response.statusCode, 204);
  assert.deepEqual(autoComments.decideCalls, [{ userId: "owner-1", candidateId: CANDIDATE_ID, decision: "TEPAT" }]);
  assert.equal(callbackResponder.answered.length, 1);
  assert.equal(callbackResponder.answered[0]?.callbackQueryId, "cbq-1");
  assert.deepEqual(callbackResponder.edited, [{
    chatId: 555, messageId: 999,
    text: `${ORIGINAL_NOTIFICATION_TEXT}\n\n✅ Ditandai Tepat. Balasan lagi dikirim otomatis, ga pakai jeda.`,
  }]);
});

test("an OOT callback records the decision and shows the OOT outcome", async (t) => {
  const { app, autoComments, callbackResponder } = harness();
  t.after(() => app.close());
  autoComments.owners.set("555", "owner-1");
  autoComments.candidates.set(CANDIDATE_ID, { userId: "owner-1", status: "PENDING_REVIEW" });

  await app.inject({
    method: "POST",
    url: "/v1/telegram/bot/webhook",
    headers: { "x-telegram-bot-api-secret-token": SECRET },
    payload: callbackPayload({ data: `autocomment:${CANDIDATE_ID}:OOT` }),
  });

  assert.deepEqual(callbackResponder.edited, [{
    chatId: 555, messageId: 999,
    text: `${ORIGINAL_NOTIFICATION_TEXT}\n\n🚫 Ditandai OOT (di luar topik). Tidak ada komentar yang dikirim.`,
  }]);
});

test("a callback whose message carries no text falls back to just the outcome", async (t) => {
  const { app, autoComments, callbackResponder } = harness();
  t.after(() => app.close());
  autoComments.owners.set("555", "owner-1");
  autoComments.candidates.set(CANDIDATE_ID, { userId: "owner-1", status: "PENDING_REVIEW" });

  await app.inject({
    method: "POST",
    url: "/v1/telegram/bot/webhook",
    headers: { "x-telegram-bot-api-secret-token": SECRET },
    payload: callbackPayload({ data: `autocomment:${CANDIDATE_ID}:OOT`, messageText: "" }),
  });

  assert.deepEqual(callbackResponder.edited, [{ chatId: 555, messageId: 999, text: "🚫 Ditandai OOT (di luar topik). Tidak ada komentar yang dikirim." }]);
});

test("a callback from someone who never authenticated through the bot never calls decideCandidate", async (t) => {
  const { app, autoComments, callbackResponder } = harness();
  t.after(() => app.close());
  autoComments.candidates.set(CANDIDATE_ID, { userId: "owner-1", status: "PENDING_REVIEW" });

  const response = await app.inject({
    method: "POST",
    url: "/v1/telegram/bot/webhook",
    headers: { "x-telegram-bot-api-secret-token": SECRET },
    payload: callbackPayload({ data: `autocomment:${CANDIDATE_ID}:TEPAT`, telegramUserId: 999 }),
  });

  assert.equal(response.statusCode, 204);
  assert.equal(autoComments.decideCalls.length, 0);
  assert.deepEqual(callbackResponder.edited, [{
    chatId: 555, messageId: 999,
    text: `${ORIGINAL_NOTIFICATION_TEXT}\n\nKandidat tidak ditemukan atau bukan milikmu.`,
  }]);
});

test("a re-pressed button after the decision already exists reports it was already decided", async (t) => {
  const { app, autoComments, callbackResponder } = harness();
  t.after(() => app.close());
  autoComments.owners.set("555", "owner-1");
  autoComments.candidates.set(CANDIDATE_ID, { userId: "owner-1", status: "COMMENT_QUEUED" });

  await app.inject({
    method: "POST",
    url: "/v1/telegram/bot/webhook",
    headers: { "x-telegram-bot-api-secret-token": SECRET },
    payload: callbackPayload({ data: `autocomment:${CANDIDATE_ID}:TEPAT` }),
  });

  assert.deepEqual(callbackResponder.edited, [{
    chatId: 555, messageId: 999,
    text: `${ORIGINAL_NOTIFICATION_TEXT}\n\nKandidat ini sudah pernah direview sebelumnya.`,
  }]);
});

test("a malformed callback_data is ignored rather than treated as a decision", async (t) => {
  const { app, autoComments, callbackResponder } = harness();
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/telegram/bot/webhook",
    headers: { "x-telegram-bot-api-secret-token": SECRET },
    payload: callbackPayload({ data: "not-an-auto-comment-callback" }),
  });

  assert.equal(response.statusCode, 204);
  assert.equal(autoComments.decideCalls.length, 0);
  assert.equal(callbackResponder.answered.length, 0);
  assert.equal(callbackResponder.edited.length, 0);
});

test("TelegramBotCallbackResponder answers and edits through the Bot API without leaking the token in a thrown error", async () => {
  const requests: Array<{ input: string; init: RequestInit }> = [];
  const responder = new TelegramBotCallbackResponder({
    botToken: "123456789:test-token",
    fetch: async (input, init) => { requests.push({ input, init }); return { ok: true }; },
  });

  await responder.answerCallbackQuery("cbq-1");
  await responder.editMessageText({ chatId: 555, messageId: 999, text: "✅ Ditandai Tepat." });

  assert.equal(requests.length, 2);
  assert.match(requests[0]?.input ?? "", /answerCallbackQuery$/);
  assert.match(requests[1]?.input ?? "", /editMessageText$/);
  const editBody = JSON.parse(String(requests[1]?.init.body));
  assert.deepEqual(editBody, { chat_id: 555, message_id: 999, text: "✅ Ditandai Tepat." });

  const failing = new TelegramBotCallbackResponder({ botToken: "123456789:test-token", fetch: async () => { throw new Error("raw provider detail"); } });
  await assert.rejects(failing.answerCallbackQuery("cbq-1"), (error: unknown) => {
    assert.equal(String(error).includes("raw provider detail"), false);
    return true;
  });
});
