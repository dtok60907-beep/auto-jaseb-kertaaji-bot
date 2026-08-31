import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { TelegramStartDeliveryError, type TelegramStartResponder } from "../telegram-bot/start-responder.ts";

const START_COMMAND = /^\/start(?:@[A-Za-z0-9_]{5,32})?(?:\s|$)/;

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
  options: Readonly<{ secret: string; responder: TelegramStartResponder }>,
): void {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(options.secret)) throw new TypeError("INVALID_TELEGRAM_WEBHOOK_SECRET");

  app.post("/v1/telegram/bot/webhook", { bodyLimit: 65_536 }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!authorized(request, options.secret)) {
      return reply.code(401).send({ code: "TELEGRAM_WEBHOOK_UNAUTHORIZED" });
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
