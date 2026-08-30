import { TelegramClient } from "teleproto";
import { Logger, LogLevel } from "teleproto/extensions/Logger.js";
import { StringSession } from "teleproto/sessions/index.js";

import type { TelegramSoakSessionVerifier } from "./telegram-soak-provisioning.ts";

export interface TeleprotoVerificationClient {
  connect(): Promise<unknown>;
  checkAuthorization(): Promise<boolean>;
  getMe(): Promise<Readonly<{ id: unknown }>>;
  disconnect(): Promise<void>;
}

export type TeleprotoVerificationClientFactory = (session: string) => TeleprotoVerificationClient;

function timeout<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("TELEGRAM_VERIFY_TIMEOUT")), milliseconds);
    timer.unref();
  });
  return Promise.race([operation, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export class TeleprotoSoakSessionVerifier implements TelegramSoakSessionVerifier {
  readonly #operationTimeoutMilliseconds: number;
  readonly #createClient: TeleprotoVerificationClientFactory;

  constructor(input: Readonly<{
    apiId: number;
    apiHash: string;
    operationTimeoutMilliseconds: number;
    createClient?: TeleprotoVerificationClientFactory;
  }>) {
    if (!Number.isSafeInteger(input.apiId) || input.apiId < 1) throw new TypeError("TELEGRAM_VERIFY_CONFIG_INVALID");
    if (typeof input.apiHash !== "string" || !/^[0-9a-f]{32}$/i.test(input.apiHash)) throw new TypeError("TELEGRAM_VERIFY_CONFIG_INVALID");
    if (!Number.isSafeInteger(input.operationTimeoutMilliseconds)
      || input.operationTimeoutMilliseconds < 1_000
      || input.operationTimeoutMilliseconds > 120_000) throw new TypeError("TELEGRAM_VERIFY_CONFIG_INVALID");
    this.#operationTimeoutMilliseconds = input.operationTimeoutMilliseconds;
    this.#createClient = input.createClient ?? ((session) => new TelegramClient(
      new StringSession(session),
      input.apiId,
      input.apiHash,
      {
        connectionRetries: 3,
        requestRetries: 2,
        reconnectRetries: 3,
        timeout: 10,
        autoReconnect: false,
        sequentialUpdates: true,
        floodSleepThreshold: 0,
        baseLogger: new Logger(LogLevel.NONE),
      },
    ));
    Object.freeze(this);
  }

  async verify(session: string): Promise<Readonly<{ providerUserId: string }>> {
    const client = this.#createClient(session);
    try {
      await timeout(client.connect(), this.#operationTimeoutMilliseconds);
      if (!await timeout(client.checkAuthorization(), this.#operationTimeoutMilliseconds)) {
        throw new Error("TELEGRAM_SESSION_UNAUTHORIZED");
      }
      const me = await timeout(client.getMe(), this.#operationTimeoutMilliseconds);
      const providerUserId = String(me.id);
      if (!/^[1-9][0-9]{0,18}$/.test(providerUserId)) throw new Error("TELEGRAM_ID_INVALID");
      return Object.freeze({ providerUserId });
    } finally {
      try { await timeout(client.disconnect(), this.#operationTimeoutMilliseconds); }
      catch { /* the provisioning service maps verification cleanup failures to a stable code */ }
    }
  }

  toJSON(): Readonly<{ redacted: true }> { return Object.freeze({ redacted: true }); }
  toString(): string { return "TeleprotoSoakSessionVerifier(redacted)"; }
}
