import { Api, Logger, TelegramClient, password as telegramPassword, sessions } from "teleproto";
import { LogLevel } from "teleproto/extensions/Logger.js";

import {
  TelegramAuthorizationTransportError,
  type TelegramAuthorizationTransport,
  type TelegramAuthorizationTransportErrorCode,
  type TelegramPendingAuthorization,
  type TelegramVerifiedAuthorization,
} from "./transport.ts";

type TelegramClientPort = Pick<TelegramClient, "connect" | "disconnect" | "invoke" | "getMe" | "sendCode" | "session">;

function providerMessage(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  const record = error as { errorMessage?: unknown; message?: unknown };
  const value = typeof record.errorMessage === "string"
    ? record.errorMessage
    : typeof record.message === "string" ? record.message : "";
  return value.toUpperCase();
}

export function mapTelegramAuthorizationError(error: unknown): TelegramAuthorizationTransportError {
  if (error instanceof TelegramAuthorizationTransportError) return error;
  const message = providerMessage(error);
  const mappings: ReadonlyArray<readonly [string, TelegramAuthorizationTransportErrorCode]> = [
    ["PHONE_NUMBER_INVALID", "PHONE_NUMBER_INVALID"],
    ["PHONE_NUMBER_BANNED", "PHONE_NUMBER_BANNED"],
    ["PHONE_CODE_INVALID", "PHONE_CODE_INVALID"],
    ["PHONE_CODE_EXPIRED", "PHONE_CODE_EXPIRED"],
    ["PHONE_CODE_HASH", "PHONE_CODE_HASH_INVALID"],
    ["PASSWORD_HASH_INVALID", "PASSWORD_INVALID"],
    ["AUTH_KEY_UNREGISTERED", "AUTH_SESSION_EXPIRED"],
    ["SESSION_EXPIRED", "AUTH_SESSION_EXPIRED"],
    ["FLOOD", "TELEGRAM_RATE_LIMITED"],
  ];
  for (const [pattern, code] of mappings) {
    if (message.includes(pattern)) return new TelegramAuthorizationTransportError(code);
  }
  return new TelegramAuthorizationTransportError("TELEGRAM_UNAVAILABLE");
}

function sessionValue(client: TelegramClientPort): string {
  const value = client.session.save();
  if (typeof value !== "string" || !value.trim()) {
    throw new TelegramAuthorizationTransportError("TELEGRAM_RESPONSE_INVALID");
  }
  return value;
}

function providerId(value: unknown): string {
  const id = typeof value === "object" && value !== null && "id" in value
    ? String((value as { id: unknown }).id)
    : "";
  if (!/^[1-9][0-9]*$/.test(id)) {
    throw new TelegramAuthorizationTransportError("TELEGRAM_RESPONSE_INVALID");
  }
  return id;
}

function accountLabel(value: unknown, id: string): string {
  const user = typeof value === "object" && value !== null
    ? value as { username?: unknown; firstName?: unknown; lastName?: unknown }
    : {};
  const username = typeof user.username === "string" ? user.username.trim() : "";
  if (username) return `@${username}`.slice(0, 80);
  const names = [user.firstName, user.lastName]
    .filter((part): part is string => typeof part === "string" && Boolean(part.trim()))
    .map((part) => part.trim())
    .join(" ");
  return (names || `Telegram ${id}`).slice(0, 80);
}

export class TeleprotoAuthorizationTransport implements TelegramAuthorizationTransport {
  readonly apiId: number;
  readonly #apiHash: string;
  readonly #createClient: (session: string) => TelegramClientPort;

  constructor(input: Readonly<{
    apiId: number;
    apiHash: string;
    createClient?: (session: string) => TelegramClientPort;
  }>) {
    if (!Number.isInteger(input.apiId) || input.apiId <= 0) throw new TypeError("INVALID_TELEGRAM_API_ID");
    if (typeof input.apiHash !== "string" || !/^[0-9a-f]{32}$/i.test(input.apiHash)) {
      throw new TypeError("INVALID_TELEGRAM_API_HASH");
    }
    this.apiId = input.apiId;
    this.#apiHash = input.apiHash;
    this.#createClient = input.createClient ?? ((session) => new TelegramClient(
      new sessions.StringSession(session),
      this.apiId,
      this.#apiHash,
      {
        connectionRetries: 3,
        // The first auth.sendCode commonly returns PHONE_MIGRATE_X. Teleproto
        // consumes one attempt while switching DC, so a second attempt is required
        // to send the code on the destination DC.
        requestRetries: 2,
        reconnectRetries: 2,
        timeout: 10,
        autoReconnect: false,
        sequentialUpdates: true,
        floodSleepThreshold: 0,
        baseLogger: new Logger(LogLevel.ERROR),
      },
    ));
  }

  async #withClient<T>(session: string, action: (client: TelegramClientPort) => Promise<T>): Promise<T> {
    const client = this.#createClient(session);
    try {
      await client.connect();
      return await action(client);
    } catch (error) {
      throw mapTelegramAuthorizationError(error);
    } finally {
      await client.disconnect().catch(() => undefined);
    }
  }

  async requestCode(phoneNumber: string): Promise<TelegramPendingAuthorization> {
    return this.#withClient("", async (client) => {
      const sent = await client.sendCode(
        { apiId: this.apiId, apiHash: this.#apiHash },
        phoneNumber,
        false,
      );
      if (sent.emailRequired || sent.emailCodeSent) {
        throw new TelegramAuthorizationTransportError("EMAIL_VERIFICATION_REQUIRED");
      }
      if (typeof sent.phoneCodeHash !== "string" || !sent.phoneCodeHash) {
        throw new TelegramAuthorizationTransportError("TELEGRAM_RESPONSE_INVALID");
      }
      return Object.freeze({
        phoneNumber,
        phoneCodeHash: sent.phoneCodeHash,
        session: sessionValue(client),
        codeDelivery: sent.isCodeViaApp ? "APP" : "SMS",
      });
    });
  }

  async #verified(client: TelegramClientPort): Promise<TelegramVerifiedAuthorization> {
    const me = await client.getMe();
    const id = providerId(me);
    return Object.freeze({
      providerUserId: id,
      label: accountLabel(me, id),
      session: sessionValue(client),
    });
  }

  async submitCode(pending: TelegramPendingAuthorization, code: string) {
    return this.#withClient(pending.session, async (client) => {
      try {
        const authorization = await client.invoke(new Api.auth.SignIn({
          phoneNumber: pending.phoneNumber,
          phoneCodeHash: pending.phoneCodeHash,
          phoneCode: code,
        }));
        if (authorization instanceof Api.auth.AuthorizationSignUpRequired) {
          throw new TelegramAuthorizationTransportError("NEW_ACCOUNT_NOT_SUPPORTED");
        }
        return Object.freeze({ status: "AUTHORIZED" as const, verified: await this.#verified(client) });
      } catch (error) {
        if (providerMessage(error).includes("SESSION_PASSWORD_NEEDED")) {
          return Object.freeze({
            status: "PASSWORD_REQUIRED" as const,
            pending: Object.freeze({ ...pending, session: sessionValue(client) }),
          });
        }
        throw error;
      }
    });
  }

  async submitPassword(pending: TelegramPendingAuthorization, password: string) {
    return this.#withClient(pending.session, async (client) => {
      const passwordState = await client.invoke(new Api.account.GetPassword());
      const passwordCheck = await telegramPassword.computeCheck(passwordState, password);
      await client.invoke(new Api.auth.CheckPassword({ password: passwordCheck }));
      return this.#verified(client);
    });
  }

  toJSON(): Readonly<{ redacted: true; apiId: number }> {
    return Object.freeze({ redacted: true, apiId: this.apiId });
  }
}
