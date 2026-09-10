import { Logger, TelegramClient, sessions } from "teleproto";
import { NewMessage, type NewMessageEvent } from "teleproto/events/index.js";
import { LogLevel } from "teleproto/extensions/Logger.js";

import { TelegramAdapterError } from "../../../../packages/telegram-contract/src/index.ts";
import { isTeleprotoErrorNamed, mapTeleprotoError } from "../teleproto-error.ts";

export type CentralMonitorPost = Readonly<{
  providerPeerId: string;
  providerPostId: number;
  content: string;
  providerPostedAt: string | null;
}>;

export type PreparedMonitorSource = Readonly<{
  providerPeerId: string;
  latestPostId: number | null;
}>;

export interface CentralMonitorTelegramClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  catchUp(): Promise<void>;
  onPost(listener: (post: CentralMonitorPost) => void): void;
  prepareSource(sourceChannelRef: string): Promise<PreparedMonitorSource>;
  listNewPosts(sourceChannelRef: string, afterPostId: number, limit: number): Promise<readonly CentralMonitorPost[]>;
  listRecentPosts(sourceChannelRef: string, limit: number): Promise<readonly CentralMonitorPost[]>;
}

export interface CentralMonitorTelegramClientFactory {
  create(session: string): CentralMonitorTelegramClient;
}

type ProviderRecord = Readonly<Record<string, unknown>>;

function record(value: unknown): ProviderRecord | null {
  return typeof value === "object" && value !== null ? value as ProviderRecord : null;
}

export function monitorChannelNeedsJoin(value: unknown): boolean {
  const valueRecord = record(value);
  return valueRecord?.left === true && valueRecord?.kicked !== true;
}

function providerClass(value: unknown): string {
  const valueRecord = record(value);
  if (typeof valueRecord?.className === "string") return valueRecord.className;
  return typeof valueRecord?.constructor === "function" ? valueRecord.constructor.name : "";
}

function timestamp(value: unknown): string | null {
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1_000).toISOString();
}

function post(value: unknown, providerPeerId: string): CentralMonitorPost | null {
  const valueRecord = record(value);
  const providerPostId = Number(valueRecord?.id);
  if (!Number.isSafeInteger(providerPostId) || providerPostId <= 0) return null;
  return Object.freeze({
    providerPeerId,
    providerPostId,
    content: typeof valueRecord?.message === "string" ? valueRecord.message : "",
    providerPostedAt: timestamp(valueRecord?.date),
  });
}

function sourceRef(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256) throw new TypeError("INVALID_SOURCE_REF");
  return value.trim();
}

function flatten(value: unknown): unknown[] {
  return Array.isArray(value) ? value.flatMap(flatten) : [value];
}

/**
 * Teleproto resolves peer ids asynchronously. Keeping this boundary explicit
 * prevents a Promise from being stringified into "[object Promise]" and then
 * poisoning the source routing table.
 */
export async function resolveProviderPeerId(
  client: Pick<TelegramClient, "getPeerId">,
  entity: unknown,
): Promise<string> {
  const value = await client.getPeerId(entity as never);
  const normalized = String(value).trim();
  if (!normalized || normalized === "[object Promise]") throw new Error("INVALID_PROVIDER_PEER_ID");
  return normalized;
}

export class TeleprotoCentralMonitorClient implements CentralMonitorTelegramClient {
  readonly #client: TelegramClient;
  readonly #event = new NewMessage({ incoming: true });
  #disconnected = false;

  constructor(input: Readonly<{ apiId: number; apiHash: string; session: string }>) {
    this.#client = new TelegramClient(new sessions.StringSession(input.session), input.apiId, input.apiHash, {
      connectionRetries: 5,
      requestRetries: 2,
      reconnectRetries: 5,
      timeout: 10,
      autoReconnect: true,
      sequentialUpdates: true,
      floodSleepThreshold: 0,
      baseLogger: new Logger(LogLevel.ERROR),
    });
  }

  onPost(listener: (post: CentralMonitorPost) => void): void {
    this.#client.addEventHandler((event: NewMessageEvent) => {
      // Telegram marks broadcast-channel posts with `post`. Messages from
      // supergroups also report isChannel=true and must not enter this stream.
      if (event.message.post !== true || !event.chatId) return;
      const incoming = post(event.message, event.chatId.toString());
      if (incoming) listener(incoming);
    }, this.#event);
  }

  async connect(): Promise<void> {
    try {
      await this.#client.connect();
      this.#disconnected = false;
      if (!await this.#client.checkAuthorization()) throw new TelegramAdapterError({ code: "SESSION_REVOKED", retryable: false });
    } catch (error) {
      throw mapTeleprotoError(error, "CONNECT");
    }
  }

  async disconnect(): Promise<void> {
    if (this.#disconnected) return;
    this.#disconnected = true;
    try { await this.#client.disconnect(); }
    catch (error) { throw mapTeleprotoError(error, "DISCONNECT"); }
  }

  async catchUp(): Promise<void> {
    try { await this.#client.catchUp(); }
    catch (error) { throw mapTeleprotoError(error, "LIST_CHANNEL_POSTS"); }
  }

  async prepareSource(rawSourceChannelRef: string): Promise<PreparedMonitorSource> {
    const channelRef = sourceRef(rawSourceChannelRef);
    try {
      const entity = await this.#client.getEntity(channelRef);
      const entityRecord = record(entity);
      if (providerClass(entity) !== "Channel" || entityRecord?.megagroup === true || entityRecord?.gigagroup === true) {
        throw new TelegramAdapterError({ code: "SOURCE_NOT_FOUND", retryable: false });
      }
      if (monitorChannelNeedsJoin(entity)) {
        try { await this.#client.joinChannel(entity as never); }
        catch (error) {
          if (!isTeleprotoErrorNamed(error, "UserAlreadyParticipantError")) throw error;
        }
      }
      const providerPeerId = await resolveProviderPeerId(this.#client, entity);
      const latest = flatten(await this.#client.getMessages(entity as never, { limit: 1 }))
        .map((value) => post(value, providerPeerId))
        .find((value): value is CentralMonitorPost => value !== null);
      return Object.freeze({ providerPeerId, latestPostId: latest?.providerPostId ?? null });
    } catch (error) {
      throw mapTeleprotoError(error, "RESOLVE_SOURCE");
    }
  }

  async listNewPosts(rawSourceChannelRef: string, afterPostId: number, limit: number): Promise<readonly CentralMonitorPost[]> {
    const channelRef = sourceRef(rawSourceChannelRef);
    if (!Number.isSafeInteger(afterPostId) || afterPostId < 0) throw new TypeError("INVALID_AFTER_POST_ID");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("INVALID_POST_LIMIT");
    try {
      const entity = await this.#client.getEntity(channelRef);
      const providerPeerId = await resolveProviderPeerId(this.#client, entity);
      const values = flatten(await this.#client.getMessages(entity as never, {
        minId: afterPostId,
        limit,
        reverse: true,
      }));
      return Object.freeze(values
        .map((value) => post(value, providerPeerId))
        .filter((value): value is CentralMonitorPost => value !== null)
        .sort((left, right) => left.providerPostId - right.providerPostId));
    } catch (error) {
      throw mapTeleprotoError(error, "LIST_CHANNEL_POSTS");
    }
  }

  async listRecentPosts(rawSourceChannelRef: string, limit: number): Promise<readonly CentralMonitorPost[]> {
    const channelRef = sourceRef(rawSourceChannelRef);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("INVALID_POST_LIMIT");
    try {
      const entity = await this.#client.getEntity(channelRef);
      const providerPeerId = await resolveProviderPeerId(this.#client, entity);
      return Object.freeze(flatten(await this.#client.getMessages(entity as never, { limit }))
        .map((value) => post(value, providerPeerId))
        .filter((value): value is CentralMonitorPost => value !== null)
        .sort((left, right) => left.providerPostId - right.providerPostId));
    } catch (error) {
      throw mapTeleprotoError(error, "LIST_CHANNEL_POSTS");
    }
  }
}

export class TeleprotoCentralMonitorClientFactory implements CentralMonitorTelegramClientFactory {
  readonly #apiId: number;
  readonly #apiHash: string;

  constructor(input: Readonly<{ apiId: number; apiHash: string }>) {
    if (!Number.isSafeInteger(input.apiId) || input.apiId <= 0) throw new TypeError("INVALID_TELEGRAM_API_ID");
    if (typeof input.apiHash !== "string" || !input.apiHash.trim()) throw new TypeError("INVALID_TELEGRAM_API_HASH");
    this.#apiId = input.apiId;
    this.#apiHash = input.apiHash.trim();
  }

  create(session: string): CentralMonitorTelegramClient {
    return new TeleprotoCentralMonitorClient({ apiId: this.#apiId, apiHash: this.#apiHash, session });
  }
}
