import { Api, events, Logger, TelegramClient, sessions } from "teleproto";
import { LogLevel } from "teleproto/extensions/Logger.js";
import {
  TelegramAdapterError,
  telegramDeliveryReceipt,
  type IncomingChannelMessage,
  type NativeForwardRequest,
  type TelegramDeliveryAdapter,
  type TelegramDeliveryReceipt,
  type TelegramLinkedDiscussion,
  type TelegramTarget,
} from "../../../packages/telegram-contract/src/index.ts";
import { isTeleprotoErrorNamed, mapTeleprotoError, type TeleprotoOperation } from "./teleproto-error.ts";

type ProviderRecord = Readonly<Record<string, unknown>>;
type ProviderMessage = Readonly<{ id: number; date: number; groupedId?: unknown }>;
type TeleprotoAdapterOptions = Readonly<{ operationTimeoutMs?: number }>;

class TimeoutError extends Error {
  constructor() { super("TELEGRAM_OPERATION_TIMEOUT"); this.name = "TimeoutError"; }
}

export interface TeleprotoClientPort {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  checkAuthorization(): Promise<boolean>;
  getEntity(ref: string): Promise<unknown>;
  getInputEntity(entity: unknown): Promise<unknown>;
  getPeerId(entity: unknown): Promise<string>;
  invoke(request: unknown): Promise<unknown>;
  joinChannel(entity: unknown): Promise<unknown>;
  sendMessage(entity: string, params: Readonly<{ message: string; linkPreview: false }>): Promise<unknown>;
  getMessages(entity: unknown, params: Readonly<{ ids: readonly number[] }>): Promise<unknown>;
  forwardMessages(entity: string, params: Readonly<{ messages: readonly number[]; fromPeer: unknown; dropAuthor: boolean }>): Promise<unknown>;
  onNewMessage(chatRef: string, handler: (message: unknown) => void): () => void;
}

function asRecord(value: unknown): ProviderRecord | null {
  return typeof value === "object" && value !== null ? value as ProviderRecord : null;
}

function providerClass(value: unknown): string {
  const record = asRecord(value);
  if (typeof record?.className === "string") return record.className;
  return typeof record?.constructor === "function" ? record.constructor.name : "";
}

function stringId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object" && value !== null && "toString" in value && typeof value.toString === "function") {
    const result = value.toString();
    return result && result !== "[object Object]" ? result : null;
  }
  return null;
}

function entityType(
  entity: unknown,
  notFoundCode: "TARGET_NOT_FOUND" | "SOURCE_NOT_FOUND" = "TARGET_NOT_FOUND",
): TelegramTarget["entityType"] {
  const name = providerClass(entity);
  const record = asRecord(entity);
  if (name === "Chat" || name === "ChatForbidden") return "GROUP";
  if (name === "Channel" || name === "ChannelForbidden") return record?.megagroup === true || record?.gigagroup === true ? "SUPERGROUP" : "CHANNEL";
  throw new TelegramAdapterError({ code: notFoundCode, retryable: false });
}

function providerMessage(value: unknown): ProviderMessage | null {
  const record = asRecord(value);
  if (!record || !Number.isInteger(record.id) || Number(record.id) <= 0 || !Number.isInteger(record.date) || Number(record.date) <= 0) return null;
  return { id: Number(record.id), date: Number(record.date), groupedId: record.groupedId };
}

function flatten(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [value];
  return value.flatMap((item) => flatten(item));
}

function groupedKey(value: unknown): string | null {
  return value === undefined || value === null ? null : stringId(value);
}

function receiptFromProvider(value: unknown, expectedCount: number): TelegramDeliveryReceipt {
  const messages = flatten(value).map(providerMessage).filter((message): message is ProviderMessage => message !== null);
  if (messages.length !== expectedCount) {
    throw new TelegramAdapterError({ code: "TELEGRAM_UNKNOWN", retryable: false, sideEffectState: "UNKNOWN" });
  }
  const sentAtSeconds = Math.min(...messages.map((message) => message.date));
  return telegramDeliveryReceipt(messages.map((message) => String(message.id)), new Date(sentAtSeconds * 1000).toISOString());
}

function validateRef(value: string, code: "INVALID_TARGET_REF" | "INVALID_SOURCE_REF"): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256) throw new TypeError(code);
  return value.trim();
}

function createPort(client: TelegramClient): TeleprotoClientPort {
  return {
    connect: async () => { await client.connect(); },
    disconnect: async () => { await client.disconnect(); },
    checkAuthorization: () => client.checkAuthorization(),
    getEntity: async (ref) => client.getEntity(ref),
    getInputEntity: async (entity) => client.getInputEntity(entity as never),
    getPeerId: (entity) => client.getPeerId(entity as never),
    invoke: async (request) => client.invoke(request as never),
    joinChannel: async (entity) => client.joinChannel(entity as never),
    sendMessage: async (entity, params) => client.sendMessage(entity, params),
    getMessages: async (entity, params) => client.getMessages(entity as never, { ids: [...params.ids] }),
    forwardMessages: async (entity, params) => client.forwardMessages(entity, { messages: [...params.messages], fromPeer: params.fromPeer as never, dropAuthor: params.dropAuthor }),
    onNewMessage: (chatRef, handler) => {
      const builder = new events.NewMessage({ chats: [chatRef], incoming: true });
      const callback = (event: { message: unknown }) => handler(event.message);
      client.addEventHandler(callback, builder);
      return () => client.removeEventHandler(callback, builder);
    },
  };
}

export class TeleprotoSessionConfig {
  readonly apiId: number;
  #apiHash: string;
  #session: string;

  constructor(input: Readonly<{ apiId: number; apiHash: string; session: string }>) {
    if (!Number.isInteger(input.apiId) || input.apiId <= 0) throw new TypeError("INVALID_TELEGRAM_API_ID");
    if (typeof input.apiHash !== "string" || !input.apiHash.trim()) throw new TypeError("INVALID_TELEGRAM_API_HASH");
    if (typeof input.session !== "string" || !input.session.trim()) throw new TypeError("INVALID_TELEGRAM_SESSION");
    this.apiId = input.apiId;
    this.#apiHash = input.apiHash.trim();
    this.#session = input.session.trim();
    Object.freeze(this);
  }

  createClientPort(): TeleprotoClientPort {
    const client = new TelegramClient(new sessions.StringSession(this.#session), this.apiId, this.#apiHash, {
      connectionRetries: 5,
      requestRetries: 2,
      reconnectRetries: 5,
      timeout: 10,
      autoReconnect: true,
      sequentialUpdates: true,
      floodSleepThreshold: 0,
      baseLogger: new Logger(LogLevel.ERROR),
    });
    return createPort(client);
  }

  toJSON(): Readonly<{ redacted: true }> { return Object.freeze({ redacted: true }); }
  toString(): string { return "TeleprotoSessionConfig(redacted)"; }
}

export class TeleprotoProductionAdapter implements TelegramDeliveryAdapter {
  #state: TelegramDeliveryAdapter["state"] = "NEW";
  #tail: Promise<void> = Promise.resolve();
  readonly #client: TeleprotoClientPort;
  readonly #operationTimeoutMs: number;

  constructor(client: TeleprotoClientPort, options: TeleprotoAdapterOptions = {}) {
    const operationTimeoutMs = options.operationTimeoutMs ?? 30_000;
    if (!Number.isInteger(operationTimeoutMs) || operationTimeoutMs <= 0 || operationTimeoutMs > 120_000) throw new TypeError("INVALID_OPERATION_TIMEOUT");
    this.#client = client;
    this.#operationTimeoutMs = operationTimeoutMs;
  }
  get state(): TelegramDeliveryAdapter["state"] { return this.#state; }

  async #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  #fatal(error: TelegramAdapterError): void {
    if (error.code === "SESSION_REVOKED" || error.code === "SESSION_CONFLICT") this.#state = "FAILED";
  }

  async #provider<T>(operationName: TeleprotoOperation, operation: () => Promise<T>): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        this.#state = "FAILED";
        void this.#client.disconnect().catch(() => undefined);
        reject(new TimeoutError());
      }, this.#operationTimeoutMs);
    });
    try { return await Promise.race([operation(), deadline]); }
    catch (rawError) {
      const error = mapTeleprotoError(rawError, operationName);
      this.#fatal(error);
      throw error;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  async #ready<T>(operation: () => Promise<T>): Promise<T> {
    return this.#serialized(async () => {
      if (this.#state !== "READY") throw new TelegramAdapterError({ code: "ADAPTER_NOT_READY", retryable: true });
      return operation();
    });
  }

  async connect(): Promise<void> {
    return this.#serialized(async () => {
      if (this.#state === "READY") return;
      this.#state = "CONNECTING";
      try {
        await this.#provider("CONNECT", () => this.#client.connect());
        if (!await this.#provider("CONNECT", () => this.#client.checkAuthorization())) throw new TelegramAdapterError({ code: "SESSION_REVOKED", retryable: false });
        this.#state = "READY";
      } catch (rawError) {
        const error = mapTeleprotoError(rawError, "CONNECT");
        this.#state = "FAILED";
        throw error;
      }
    });
  }

  async disconnect(): Promise<void> {
    return this.#serialized(async () => {
      if (this.#state === "NEW" || this.#state === "DISCONNECTED") { this.#state = "DISCONNECTED"; return; }
      this.#state = "DISCONNECTING";
      try { await this.#provider("DISCONNECT", () => this.#client.disconnect()); this.#state = "DISCONNECTED"; }
      catch (rawError) { this.#state = "FAILED"; throw mapTeleprotoError(rawError, "DISCONNECT"); }
    });
  }

  async #membership(entity: unknown): Promise<TelegramTarget["membership"]> {
    const name = providerClass(entity);
    const record = asRecord(entity);
    if (name === "Chat") return record?.left === true ? "NOT_MEMBER" : "MEMBER";
    if (name === "ChatForbidden" || name === "ChannelForbidden") return "UNKNOWN";
    if (name !== "Channel") return "UNKNOWN";
    try {
      const channel = await this.#client.getInputEntity(entity);
      const self = await this.#client.getInputEntity("me");
      const response = asRecord(await this.#client.invoke(new Api.channels.GetParticipant({ channel: channel as never, participant: self as never })));
      const participantName = providerClass(response?.participant);
      return participantName === "ChannelParticipantLeft" || participantName === "ChannelParticipantBanned" ? "NOT_MEMBER" : "MEMBER";
    } catch (error) {
      if (["UserNotParticipantError", "ParticipantIdInvalidError", "UserBannedInChannelError", "ChannelPrivateError"].some((name) => isTeleprotoErrorNamed(error, name))) return "NOT_MEMBER";
      throw error;
    }
  }

  async #describe(
    entity: unknown,
    notFoundCode: "TARGET_NOT_FOUND" | "SOURCE_NOT_FOUND" = "TARGET_NOT_FOUND",
  ): Promise<TelegramTarget> {
    const type = entityType(entity, notFoundCode);
    const record = asRecord(entity);
    const username = typeof record?.username === "string" && record.username.trim() ? record.username.trim().replace(/^@/, "") : null;
    const canonicalRef = username ? `@${username}` : await this.#client.getPeerId(entity);
    if (!canonicalRef) throw new TelegramAdapterError({ code: notFoundCode, retryable: false });
    const title = typeof record?.title === "string" && record.title.trim() ? record.title.trim() : null;
    return Object.freeze({ canonicalRef, entityType: type, membership: await this.#membership(entity), title });
  }

  async resolveTarget(targetRef: string): Promise<TelegramTarget> {
    const target = validateRef(targetRef, "INVALID_TARGET_REF");
    return this.#ready(() => this.#provider("RESOLVE_TARGET", async () => this.#describe(await this.#client.getEntity(target))));
  }

  async resolveLinkedDiscussion(sourceChannelRef: string): Promise<TelegramLinkedDiscussion> {
    const sourceRef = validateRef(sourceChannelRef, "INVALID_SOURCE_REF");
    return this.#ready(() => this.#provider("RESOLVE_SOURCE", async () => {
      const sourceEntity = await this.#client.getEntity(sourceRef);
      const source = await this.#describe(sourceEntity, "SOURCE_NOT_FOUND");
      if (source.entityType !== "CHANNEL" || providerClass(sourceEntity) !== "Channel") return Object.freeze({ source, discussion: null });
      const input = await this.#client.getInputEntity(sourceEntity);
      const full = asRecord(await this.#client.invoke(new Api.channels.GetFullChannel({ channel: input as never })));
      const linkedId = stringId(asRecord(full?.fullChat)?.linkedChatId);
      if (!linkedId) return Object.freeze({ source, discussion: null });
      const chats = Array.isArray(full?.chats) ? full.chats : [];
      const linkedEntity = chats.find((chat) => stringId(asRecord(chat)?.id) === linkedId)
        ?? await this.#client.getEntity(`-100${linkedId}`);
      return Object.freeze({ source, discussion: await this.#describe(linkedEntity) });
    }));
  }

  async joinPublicTarget(targetRef: string): Promise<Readonly<{ state: "JOINED" | "ALREADY_MEMBER" | "APPROVAL_REQUESTED" }>> {
    const target = validateRef(targetRef, "INVALID_TARGET_REF");
    return this.#ready(async () => {
      const entity = await this.#provider("RESOLVE_TARGET", () => this.#client.getEntity(target));
      if (await this.#provider("RESOLVE_TARGET", () => this.#membership(entity)) === "MEMBER") return Object.freeze({ state: "ALREADY_MEMBER" as const });
      return this.#provider("JOIN", async () => {
        try { await this.#client.joinChannel(entity); return Object.freeze({ state: "JOINED" as const }); }
        catch (error) {
          if (isTeleprotoErrorNamed(error, "UserAlreadyParticipantError")) return Object.freeze({ state: "ALREADY_MEMBER" as const });
          if (isTeleprotoErrorNamed(error, "InviteRequestSentError")) return Object.freeze({ state: "APPROVAL_REQUESTED" as const });
          throw error;
        }
      });
    });
  }

  async sendText(input: Readonly<{ targetRef: string; text: string }>): Promise<TelegramDeliveryReceipt> {
    const target = validateRef(input.targetRef, "INVALID_TARGET_REF");
    if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 4096) throw new TypeError("INVALID_TEXT");
    return this.#ready(async () => receiptFromProvider(
      await this.#provider("SEND_TEXT", () => this.#client.sendMessage(target, { message: input.text, linkPreview: false })),
      1,
    ));
  }

  async forwardNative(input: NativeForwardRequest): Promise<TelegramDeliveryReceipt> {
    const target = validateRef(input.targetRef, "INVALID_TARGET_REF");
    const username = validateRef(input.source.channelUsername, "INVALID_SOURCE_REF").replace(/^@/, "");
    if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(username) || !Number.isSafeInteger(input.source.messageId) || input.source.messageId <= 0) throw new TypeError("INVALID_FORWARD_SOURCE");
    if (input.sourceAttribution !== "SHOW_SOURCE" && input.sourceAttribution !== "HIDE_SOURCE") throw new TypeError("INVALID_SOURCE_ATTRIBUTION");
    return this.#ready(async () => {
      const prepared = await this.#provider("RESOLVE_SOURCE", async () => {
        const sourceEntity = await this.#client.getEntity(`@${username}`);
        if (entityType(sourceEntity, "SOURCE_NOT_FOUND") !== "CHANNEL") throw new TelegramAdapterError({ code: "SOURCE_NOT_FOUND", retryable: false });
        const sourcePeer = await this.#client.getInputEntity(sourceEntity);
        const aroundIds = Array.from({ length: 21 }, (_, index) => input.source.messageId - 10 + index).filter((id) => id > 0);
        const around = flatten(await this.#client.getMessages(sourceEntity, { ids: aroundIds }));
        const targetMessage = around.map(providerMessage).find((message) => message?.id === input.source.messageId) ?? null;
        if (!targetMessage) throw new TelegramAdapterError({ code: "SOURCE_NOT_FOUND", retryable: false });
        const group = groupedKey(targetMessage.groupedId);
        const messageIds = group === null ? [targetMessage.id] : around
          .map(providerMessage)
          .filter((message): message is ProviderMessage => message !== null && groupedKey(message.groupedId) === group)
          .map((message) => message.id)
          .sort((left, right) => left - right);
        return Object.freeze({ sourcePeer, messageIds: Object.freeze(messageIds) });
      });
      const response = await this.#provider("FORWARD", () => this.#client.forwardMessages(target, {
        messages: prepared.messageIds,
        fromPeer: prepared.sourcePeer,
        dropAuthor: input.sourceAttribution === "HIDE_SOURCE",
      }));
      return receiptFromProvider(response, prepared.messageIds.length);
    });
  }

  async onChannelMessage(channelRef: string, handler: (message: IncomingChannelMessage) => void): Promise<() => void> {
    const target = validateRef(channelRef, "INVALID_TARGET_REF");
    if (this.#state !== "READY") throw new TelegramAdapterError({ code: "ADAPTER_NOT_READY", retryable: true });
    return this.#client.onNewMessage(target, (raw) => {
      const record = asRecord(raw);
      if (!record || !Number.isInteger(record.id) || Number(record.id) <= 0) return;
      handler(Object.freeze({
        channelPostId: String(record.id),
        text: typeof record.message === "string" ? record.message : "",
      }));
    });
  }
}

export function createTeleprotoProductionAdapter(config: TeleprotoSessionConfig): TeleprotoProductionAdapter {
  if (!(config instanceof TeleprotoSessionConfig)) throw new TypeError("INVALID_TELEPROTO_CONFIG");
  return new TeleprotoProductionAdapter(config.createClientPort());
}
