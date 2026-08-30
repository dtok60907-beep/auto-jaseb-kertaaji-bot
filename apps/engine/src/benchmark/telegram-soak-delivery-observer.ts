import { TelegramClient } from "teleproto";
import { Logger, LogLevel } from "teleproto/extensions/Logger.js";
import { StringSession } from "teleproto/sessions/index.js";

import {
  expectedTelegramSoakDeliveryMarkers,
  type TelegramSoakConfig,
} from "./telegram-soak.ts";

export interface TelegramSoakDeliveryObserver {
  observe(input: Readonly<{
    targetRef: string;
    search: string;
    limit: number;
  }>): Promise<readonly string[]>;
}

export type TelegramSoakDeliveryObservation = Readonly<{
  passed: boolean;
  expected: number;
  observed: number;
  missing: number;
  duplicate: number;
  unexpected: number;
}>;

export function evaluateTelegramSoakDelivery(
  config: TelegramSoakConfig,
  observedTexts: readonly string[],
): TelegramSoakDeliveryObservation {
  const expected = expectedTelegramSoakDeliveryMarkers(config);
  const expectedCounts = new Map(expected.map((marker) => [marker, 1] as const));
  const observedCounts = new Map<string, number>();
  for (const text of observedTexts) observedCounts.set(text, (observedCounts.get(text) ?? 0) + 1);
  let missing = 0;
  let duplicate = 0;
  let unexpected = 0;
  for (const marker of expected) if ((observedCounts.get(marker) ?? 0) === 0) missing += 1;
  for (const [marker, count] of observedCounts) {
    if (!expectedCounts.has(marker)) unexpected += count;
    else if (count > 1) duplicate += count - 1;
  }
  return Object.freeze({
    passed: missing === 0 && duplicate === 0 && unexpected === 0 && observedTexts.length === expected.length,
    expected: expected.length,
    observed: observedTexts.length,
    missing,
    duplicate,
    unexpected,
  });
}

export interface TeleprotoHistoryClient {
  connect(): Promise<unknown>;
  checkAuthorization(): Promise<boolean>;
  getMessages(entity: string, input: Readonly<{ search: string; limit: number }>): Promise<readonly unknown[]>;
  disconnect(): Promise<void>;
}

function timeout<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("TELEGRAM_OBSERVER_TIMEOUT")), milliseconds);
    timer.unref();
  });
  return Promise.race([operation, deadline]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

export class TeleprotoSoakDeliveryObserver implements TelegramSoakDeliveryObserver {
  readonly #client: TeleprotoHistoryClient;
  readonly #operationTimeoutMilliseconds: number;

  constructor(input: Readonly<{
    apiId: number;
    apiHash: string;
    session: string;
    operationTimeoutMilliseconds: number;
    createClient?: (session: string) => TeleprotoHistoryClient;
  }>) {
    if (!Number.isSafeInteger(input.apiId) || input.apiId < 1
      || !/^[0-9a-f]{32}$/i.test(input.apiHash)
      || typeof input.session !== "string" || !input.session.trim()
      || !Number.isSafeInteger(input.operationTimeoutMilliseconds)
      || input.operationTimeoutMilliseconds < 1_000 || input.operationTimeoutMilliseconds > 120_000) {
      throw new TypeError("TELEGRAM_OBSERVER_CONFIG_INVALID");
    }
    this.#operationTimeoutMilliseconds = input.operationTimeoutMilliseconds;
    this.#client = input.createClient?.(input.session) ?? new TelegramClient(
      new StringSession(input.session), input.apiId, input.apiHash,
      { connectionRetries: 3, requestRetries: 2, reconnectRetries: 3, timeout: 10,
        autoReconnect: false, sequentialUpdates: true, floodSleepThreshold: 0,
        baseLogger: new Logger(LogLevel.NONE) },
    );
    Object.freeze(this);
  }

  async observe(input: Readonly<{ targetRef: string; search: string; limit: number }>): Promise<readonly string[]> {
    if (!input.targetRef.trim() || !input.search.trim() || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000_001) {
      throw new TypeError("TELEGRAM_OBSERVER_INPUT_INVALID");
    }
    try {
      await timeout(this.#client.connect(), this.#operationTimeoutMilliseconds);
      if (!await timeout(this.#client.checkAuthorization(), this.#operationTimeoutMilliseconds)) throw new Error("TELEGRAM_OBSERVER_UNAUTHORIZED");
      const messages = await timeout(
        this.#client.getMessages(input.targetRef, { search: input.search, limit: input.limit }),
        this.#operationTimeoutMilliseconds,
      );
      return Object.freeze(messages.flatMap((message) => {
        if (typeof message !== "object" || message === null) return [];
        const text = (message as Readonly<Record<string, unknown>>).message;
        return typeof text === "string" && text.startsWith(input.search) ? [text] : [];
      }));
    } finally {
      try { await timeout(this.#client.disconnect(), this.#operationTimeoutMilliseconds); } catch { /* contained */ }
    }
  }

  toJSON(): Readonly<{ redacted: true }> { return Object.freeze({ redacted: true }); }
}
