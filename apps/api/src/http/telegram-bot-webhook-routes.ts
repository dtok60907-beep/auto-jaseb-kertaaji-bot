import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AutoCommentSettingsRepository } from "../auto-comment/repository.ts";
import type { TelegramCallbackResponder } from "../telegram-bot/decision-responder.ts";
import { TelegramStartDeliveryError, type TelegramStartResponder } from "../telegram-bot/start-responder.ts";

const START_COMMAND = /^\/start(?:@[A-Za-z0-9_]{5,32})?(?:\s|$)/;
const CALLBACK_DATA = /^autocomment:([0-9a-fA-F-]{36}):(TEPAT|OOT)$/;

const DECISION_OUTCOME_TEXT: Readonly<Record<string, string>> = {
  COMMENT_QUEUED: "✅ Ditandai Tepat. Komentar sudah diantre untuk dikirim.",
  OOT: "🚫 Ditandai OOT (di luar topik). Tidak ada komentar yang dikirim.",
  ALREADY_DECIDED: "Kandidat ini sudah pernah direview sebelumnya.",
  NOT_AWAITING_REVIEW: "Kandidat ini sudah tidak menunggu review.",
  NOT_FOUND: "Kandidat tidak ditemukan atau bukan milikmu.",
};

type CallbackQueryInfo = Readonly<{
  callbackQueryId: string;
  telegramUserId: string;
  candidateId: string;
  decision: "TEPAT" | "OOT";
  chatId: number;
  messageId: number;
}>;

function callbackQueryInfo(body: unknown): CallbackQueryInfo | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const callbackQuery = (body as Record<string, unknown>).callback_query;
  if (callbackQuery === null || typeof callbackQuery !== "object" || Array.isArray(callbackQuery)) return null;
  const record = callbackQuery as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id.trim() || typeof record.data !== "string") return null;
  const match = CALLBACK_DATA.exec(record.data);
  if (!match) return null;

  const from = record.from;
  if (from === null || typeof from !== "object" || Array.isArray(from)) return null;
  const fromId = (from as Record<string, unknown>).id;
  if (typeof fromId !== "number" || !Number.isSafeInteger(fromId) || fromId <= 0) return null;

  const message = record.message;
  if (message === null || typeof message !== "object" || Array.isArray(message)) return null;
  const messageRecord = message as Record<string, unknown>;
  if (typeof messageRecord.message_id !== "number" || !Number.isSafeInteger(messageRecord.message_id)) return null;
  const chat = messageRecord.chat;
  if (chat === null || typeof chat !== "object" || Array.isArray(chat)) return null;
  const chatId = (chat as Record<string, unknown>).id;
  if (typeof chatId !== "number" || !Number.isSafeInteger(chatId)) return null;

  return Object.freeze({
    callbackQueryId: record.id,
    telegramUserId: String(fromId),
    candidateId: match[1]!,
    decision: match[2] as "TEPAT" | "OOT",
    chatId,
    messageId: messageRecord.message_id,
  });
}

function authorized(request: FastifyRequest, secret: string): boolean {
  const received = request.headers["x-telegram-bot-api-secret-token"];
  if (typeof received !== "string") return false;
  const expectedBytes = Buffer.from(secret, "utf8");
  const receivedBytes = Buffer.from(received, "utf8");
  return expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes);
}

function startChatId(body: unknown): number | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const message = (body as Record<string, unknown>).message;
  if (message === null || typeof message !== "object" || Array.isArray(message)) return null;
  const record = message as Record<string, unknown>;
  if (typeof record.text !== "string" || !START_COMMAND.test(record.text)) return null;
  const chat = record.chat;
  if (chat === null || typeof chat !== "object" || Array.isArray(chat)) return null;
  const chatRecord = chat as Record<string, unknown>;
  if (chatRecord.type !== "private" || typeof chatRecord.id !== "number" || !Number.isSafeInteger(chatRecord.id)) return null;
  return chatRecord.id;
}

export function registerTelegramBotWebhookRoutes(
  app: FastifyInstance,
  options: Readonly<{
    secret: string;
    responder: TelegramStartResponder;
    callbackResponder: TelegramCallbackResponder;
    autoComments: AutoCommentSettingsRepository;
  }>,
): void {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(options.secret)) throw new TypeError("INVALID_TELEGRAM_WEBHOOK_SECRET");

  app.post("/v1/telegram/bot/webhook", { bodyLimit: 65_536 }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!authorized(request, options.secret)) {
      return reply.code(401).send({ code: "TELEGRAM_WEBHOOK_UNAUTHORIZED" });
    }

    const callback = callbackQueryInfo(request.body);
    if (callback) {
      const ownerId = await options.autoComments.resolveOwnerId(callback.telegramUserId);
      const decisionStatus = ownerId
        ? (await options.autoComments.decideCandidate({ userId: ownerId, candidateId: callback.candidateId, decision: callback.decision })).status
        : "NOT_FOUND";
      const outcomeText = DECISION_OUTCOME_TEXT[decisionStatus] ?? DECISION_OUTCOME_TEXT.NOT_FOUND!;
      try { await options.callbackResponder.answerCallbackQuery(callback.callbackQueryId); } catch { /* best-effort: the button spinner clears itself eventually */ }
      try { await options.callbackResponder.editMessageText({ chatId: callback.chatId, messageId: callback.messageId, text: outcomeText }); } catch { /* best-effort: the decision is already persisted */ }
      return reply.code(204).send();
    }

    const chatId = startChatId(request.body);
    if (chatId === null) return reply.code(204).send();
    try {
      await options.responder.sendStart(chatId);
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof TelegramStartDeliveryError) {
        return reply.code(503).send({ code: "TELEGRAM_DELIVERY_UNAVAILABLE" });
      }
      throw error;
    }
  });
}
