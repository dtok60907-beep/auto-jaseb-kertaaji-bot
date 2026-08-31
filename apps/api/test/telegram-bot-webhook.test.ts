import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import { registerTelegramBotWebhookRoutes } from "../src/http/telegram-bot-webhook-routes.ts";
import { TelegramBotStartResponder } from "../src/telegram-bot/start-responder.ts";

const SECRET = "webhook_secret_1234567890_abcdef";

test("accepts a verified private /start update and rejects an invalid secret", async (t) => {
  const delivered: number[] = [];
  const app = Fastify({ logger: false });
  registerTelegramBotWebhookRoutes(app, {
    secret: SECRET,
    responder: { async sendStart(chatId) { delivered.push(chatId); } },
  });
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
