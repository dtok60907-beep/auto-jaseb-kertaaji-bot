/**
 * Thin, testable lifecycle adapter around Teleproto.
 *
 * Benchmark infrastructure only: no database, durable queue, OTP flow, or
 * production session storage lives here.
 */

import { Logger, TelegramClient, events, sessions } from "teleproto";

export const AdapterState = Object.freeze({
  NEW: "NEW",
  CONNECTING: "CONNECTING",
  READY: "READY",
  DISCONNECTING: "DISCONNECTING",
  DISCONNECTED: "DISCONNECTED",
  FAILED: "FAILED",
});

export class SessionConfig {
  #apiHash;
  #session;

  constructor({ apiId, apiHash, session }) {
    if (!Number.isInteger(apiId) || apiId <= 0) throw new TypeError("apiId must be a positive integer");
    if (typeof apiHash !== "string" || apiHash.trim() === "") throw new TypeError("apiHash is required");
    if (typeof session !== "string" || session.trim() === "") throw new TypeError("session is required");
    this.apiId = apiId;
    this.#apiHash = apiHash;
    this.#session = session;
    Object.freeze(this);
  }

  toJSON() {
    return { redacted: true };
  }

  toString() {
    return "SessionConfig(redacted=True)";
  }

  static createAdapter(config) {
    if (!(config instanceof SessionConfig)) throw new TypeError("config must be a SessionConfig");
    const client = new TelegramClient(
      new sessions.StringSession(config.#session),
      config.apiId,
      config.#apiHash,
      {
        connectionRetries: 5,
        requestRetries: 2,
        reconnectRetries: 5,
        autoReconnect: true,
        sequentialUpdates: true,
        floodSleepThreshold: 0,
        baseLogger: new Logger("error"),
      },
    );
    return new TeleprotoAdapter(client, { newMessageEvent: new events.NewMessage({}) });
  }
}

export class TelegramAdapterError extends Error {
  constructor(code, { retryable, message, retryAfterSeconds = null, cause = undefined }) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "TelegramAdapterError";
    this.code = code;
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  publicData() {
    return {
      code: this.code,
      retryable: this.retryable,
      retryAfterSeconds: this.retryAfterSeconds,
    };
  }
}

function errorNames(error) {
  const names = new Set();
  let current = error?.constructor;
  while (current && current.name) {
    names.add(current.name);
    current = Object.getPrototypeOf(current);
  }
  return names;
}

function positiveSeconds(value) {
  const seconds = Number(value);
  return Number.isInteger(seconds) && seconds > 0 ? seconds : null;
}

export function mapTelegramError(error) {
  if (error instanceof TelegramAdapterError) return error;
  const names = errorNames(error);

  if (names.has("FloodWaitError")) {
    return new TelegramAdapterError("FLOOD_WAIT", {
      retryable: true,
      retryAfterSeconds: positiveSeconds(error?.seconds),
      message: "Telegram meminta jeda sebelum aksi berikutnya.",
      cause: error,
    });
  }
  if (["AuthKeyUnregisteredError", "AuthKeyInvalidError", "SessionRevokedError", "SessionExpiredError", "UserDeactivatedError", "UserDeactivatedBanError"].some((name) => names.has(name))) {
    return new TelegramAdapterError("SESSION_REVOKED", {
      retryable: false,
      message: "Sesi Telegram tidak lagi valid dan perlu dihubungkan ulang.",
      cause: error,
    });
  }
  if (names.has("AuthKeyDuplicatedError")) {
    return new TelegramAdapterError("SESSION_CONFLICT", {
      retryable: false,
      message: "Sesi Telegram terdeteksi dipakai di runtime lain.",
      cause: error,
    });
  }
  if (["ChatWriteForbiddenError", "UserBannedInChannelError", "ChannelPrivateError", "ChatForbiddenError"].some((name) => names.has(name))) {
    return new TelegramAdapterError("CHAT_WRITE_FORBIDDEN", {
      retryable: false,
      message: "Akun tidak diizinkan menulis di target ini.",
      cause: error,
    });
  }
  if (["UsernameNotOccupiedError", "ChannelInvalidError", "PeerIdInvalidError", "PublicChannelMissingError"].some((name) => names.has(name))) {
    return new TelegramAdapterError("TARGET_NOT_FOUND", {
      retryable: false,
      message: "Target Telegram tidak ditemukan atau tidak valid.",
      cause: error,
    });
  }
  if (names.has("InviteRequestSentError")) {
    return new TelegramAdapterError("JOIN_APPROVAL_REQUIRED", {
      retryable: false,
      message: "Permintaan join sudah dikirim dan menunggu persetujuan admin grup.",
      cause: error,
    });
  }
  const transientNetworkCodes = new Set(["ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "EAI_AGAIN"]);
  if (names.has("RPCError") || names.has("TimeoutError") || names.has("AbortError") || transientNetworkCodes.has(error?.code)) {
    return new TelegramAdapterError("TELEGRAM_TRANSIENT", {
      retryable: true,
      message: "Koneksi Telegram sementara bermasalah. Sistem dapat mencoba lagi.",
      cause: error,
    });
  }
  return new TelegramAdapterError("TELEGRAM_UNKNOWN", {
    retryable: false,
    message: "Aksi Telegram gagal dengan alasan yang belum diklasifikasikan.",
    cause: error,
  });
}

export class TeleprotoAdapter {
  #client;
  #newMessageEvent;
  #state = AdapterState.NEW;
  #tail = Promise.resolve();

  constructor(client, { newMessageEvent = undefined } = {}) {
    this.#client = client;
    this.#newMessageEvent = newMessageEvent;
  }

  get state() {
    return this.#state;
  }

  describe() {
    return { candidate: "teleproto", state: this.#state };
  }

  async #serialized(operation) {
    const previous = this.#tail;
    let release;
    this.#tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async connect() {
    return this.#serialized(async () => {
      if (this.#state === AdapterState.READY) return;
      this.#state = AdapterState.CONNECTING;
      try {
        await this.#client.connect();
        if (!(await this.#client.checkAuthorization())) {
          throw new TelegramAdapterError("SESSION_NOT_AUTHORIZED", {
            retryable: false,
            message: "Session benchmark belum terautentikasi.",
          });
        }
      } catch (error) {
        this.#state = AdapterState.FAILED;
        throw mapTelegramError(error);
      }
      this.#state = AdapterState.READY;
    });
  }

  async disconnect() {
    return this.#serialized(async () => {
      if (this.#state === AdapterState.NEW || this.#state === AdapterState.DISCONNECTED) {
        this.#state = AdapterState.DISCONNECTED;
        return;
      }
      this.#state = AdapterState.DISCONNECTING;
      try {
        await this.#client.disconnect();
      } catch (error) {
        this.#state = AdapterState.FAILED;
        throw mapTelegramError(error);
      }
      this.#state = AdapterState.DISCONNECTED;
    });
  }

  async sendMessage(target, text, options = {}) {
    if (typeof text !== "string" || text.trim() === "") throw new TypeError("text is required");
    if (Object.hasOwn(options, "message")) throw new TypeError("options.message is reserved");

    return this.#serialized(async () => {
      if (this.#state !== AdapterState.READY) {
        throw new TelegramAdapterError("ADAPTER_NOT_READY", {
          retryable: true,
          message: "Koneksi Telegram belum siap.",
        });
      }
      try {
        return await this.#client.sendMessage(target, { message: text, ...options });
      } catch (error) {
        throw mapTelegramError(error);
      }
    });
  }

  async resolveTarget(target) {
    if (typeof target !== "string" || target.trim() === "") throw new TypeError("target is required");

    return this.#serialized(async () => {
      if (this.#state !== AdapterState.READY) {
        throw new TelegramAdapterError("ADAPTER_NOT_READY", {
          retryable: true,
          message: "Koneksi Telegram belum siap.",
        });
      }
      try {
        const entity = await this.#client.getEntity(target);
        return { entityType: entity?.constructor?.name ?? "Unknown" };
      } catch (error) {
        throw mapTelegramError(error);
      }
    });
  }

  addNewMessageHandler(handler) {
    if (typeof handler !== "function") throw new TypeError("handler must be callable");
    const bridge = async (event) => handler(event);
    if (this.#newMessageEvent === undefined) this.#client.addEventHandler(bridge);
    else this.#client.addEventHandler(bridge, this.#newMessageEvent);
    return bridge;
  }
}

export function createTeleprotoAdapter(config) {
  return SessionConfig.createAdapter(config);
}
