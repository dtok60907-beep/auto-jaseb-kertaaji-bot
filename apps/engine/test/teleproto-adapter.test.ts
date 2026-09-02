import assert from "node:assert/strict";
import test from "node:test";

import { TelegramAdapterError } from "../../../packages/telegram-contract/src/index.ts";
import {
  TeleprotoProductionAdapter,
  TeleprotoSessionConfig,
  type TeleprotoClientPort,
} from "../src/teleproto-adapter.ts";

type ForwardCall = Readonly<{
  entity: string;
  params: Readonly<{ messages: readonly number[]; fromPeer: unknown; dropAuthor: boolean }>;
}>;

function namedError(name: string): Error {
  const ProviderError = class extends Error {};
  Object.defineProperty(ProviderError, "name", { value: name });
  return new ProviderError("provider detail");
}

function requestName(request: unknown): string {
  if (typeof request !== "object" || request === null) return "";
  if ("className" in request && typeof request.className === "string") return request.className;
  return request.constructor.name;
}

function channel(input: Readonly<{ username: string; id?: string; megagroup?: boolean; left?: boolean; title?: string }>) {
  return {
    className: "Channel",
    username: input.username,
    id: input.id ?? "101",
    megagroup: input.megagroup ?? false,
    left: input.left ?? false,
    peerId: `-100${input.id ?? "101"}`,
    title: input.title,
  };
}

class FakeClient implements TeleprotoClientPort {
  authorized = true;
  connectCount = 0;
  disconnectCount = 0;
  getEntityCalls: string[] = [];
  sendCalls: Array<Readonly<{ entity: string; params: Readonly<{ message: string; linkPreview: false }> }>> = [];
  forwardCalls: ForwardCall[] = [];
  getMessagesCalls: Array<Readonly<{ entity: unknown; ids: readonly number[] }>> = [];
  getHistoryCalls: Array<Readonly<{ entity: unknown; minId: number; limit: number }>> = [];
  entities = new Map<string, unknown>();
  invokeImpl: (request: unknown) => Promise<unknown> = async (request) => {
    if (requestName(request) === "channels.GetParticipant") return { participant: { className: "ChannelParticipantSelf" } };
    return {};
  };
  joinImpl: (entity: unknown) => Promise<unknown> = async () => ({});
  sendImpl: (entity: string, params: Readonly<{ message: string; linkPreview: false }>) => Promise<unknown> = async () => ({ id: 501, date: 1_800_000_000 });
  messagesImpl: (entity: unknown, ids: readonly number[]) => Promise<unknown> = async (_entity, ids) => ids.map((id) => ({ id, date: 1_800_000_000 }));
  forwardImpl: (entity: string, params: ForwardCall["params"]) => Promise<unknown> = async (_entity, params) => params.messages.map((id, index) => ({ id: 800 + id + index, date: 1_800_000_001 }));
  historyImpl: (entity: unknown, minId: number, limit: number) => Promise<unknown> = async () => [];

  async connect() { this.connectCount += 1; }
  async disconnect() { this.disconnectCount += 1; }
  async checkAuthorization() { return this.authorized; }
  async getEntity(ref: string) {
    this.getEntityCalls.push(ref);
    if (!this.entities.has(ref)) throw namedError("UsernameNotOccupiedError");
    return this.entities.get(ref);
  }
  async getInputEntity(entity: unknown) { return entity === "me" ? { className: "InputPeerSelf" } : { className: "InputChannel", entity }; }
  async getPeerId(entity: unknown) { return String((entity as { peerId?: unknown }).peerId ?? "-1000"); }
  async invoke(request: unknown) { return this.invokeImpl(request); }
  async joinChannel(entity: unknown) { return this.joinImpl(entity); }
  async sendMessage(entity: string, params: Readonly<{ message: string; linkPreview: false }>) {
    this.sendCalls.push({ entity, params });
    return this.sendImpl(entity, params);
  }
  async getMessages(entity: unknown, params: Readonly<{ ids: readonly number[] }>) {
    this.getMessagesCalls.push({ entity, ids: params.ids });
    return this.messagesImpl(entity, params.ids);
  }
  async forwardMessages(entity: string, params: ForwardCall["params"]) {
    this.forwardCalls.push({ entity, params });
    return this.forwardImpl(entity, params);
  }
  async getHistory(entity: unknown, params: Readonly<{ minId: number; limit: number }>) {
    this.getHistoryCalls.push({ entity, minId: params.minId, limit: params.limit });
    return this.historyImpl(entity, params.minId, params.limit);
  }
}

async function ready(client = new FakeClient()) {
  const adapter = new TeleprotoProductionAdapter(client);
  await adapter.connect();
  return { adapter, client };
}

async function expectAdapterError(
  action: () => Promise<unknown>,
  expected: Readonly<Partial<Pick<TelegramAdapterError, "code" | "retryable" | "sideEffectState">>>,
) {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof TelegramAdapterError);
    for (const [key, value] of Object.entries(expected)) assert.equal((error as unknown as Record<string, unknown>)[key], value);
    return true;
  });
}

test("session configuration validates and redacts secrets", () => {
  const config = new TeleprotoSessionConfig({ apiId: 123, apiHash: "hash-secret", session: "session-secret" });
  assert.equal(String(config), "TeleprotoSessionConfig(redacted)");
  assert.equal(JSON.stringify(config), '{"redacted":true}');
  assert.deepEqual(Object.keys(config), ["apiId"]);
  assert.throws(() => new TeleprotoSessionConfig({ apiId: 0, apiHash: "x", session: "y" }), /INVALID_TELEGRAM_API_ID/);
});

test("lifecycle rejects unauthorized sessions and rejects operations before ready", async () => {
  const client = new FakeClient();
  const adapter = new TeleprotoProductionAdapter(client);
  await expectAdapterError(() => adapter.resolveTarget("@group"), { code: "ADAPTER_NOT_READY" });
  client.authorized = false;
  await expectAdapterError(() => adapter.connect(), { code: "SESSION_REVOKED", retryable: false });
  assert.equal(adapter.state, "FAILED");

  const healthy = new FakeClient();
  const connected = new TeleprotoProductionAdapter(healthy);
  await connected.connect();
  await connected.connect();
  assert.equal(healthy.connectCount, 1);
  assert.equal(connected.state, "READY");
  await connected.disconnect();
  assert.equal(healthy.disconnectCount, 1);
  assert.equal(connected.state, "DISCONNECTED");
});

test("resolves target membership and linked discussion without leaking provider objects", async () => {
  const source = channel({ username: "sourcechannel", id: "101" });
  const discussion = channel({ username: "discussiongroup", id: "202", megagroup: true });
  const { adapter, client } = await ready();
  client.entities.set("@sourcechannel", source);
  client.invokeImpl = async (request) => {
    if (requestName(request) === "channels.GetFullChannel") return { fullChat: { linkedChatId: "202" }, chats: [discussion] };
    return { participant: { className: "ChannelParticipantSelf" } };
  };

  assert.deepEqual(await adapter.resolveTarget("@sourcechannel"), {
    canonicalRef: "@sourcechannel",
    entityType: "CHANNEL",
    membership: "MEMBER",
    title: null,
  });
  assert.deepEqual(await adapter.resolveLinkedDiscussion("@sourcechannel"), {
    source: { canonicalRef: "@sourcechannel", entityType: "CHANNEL", membership: "MEMBER", title: null },
    discussion: { canonicalRef: "@discussiongroup", entityType: "SUPERGROUP", membership: "MEMBER", title: null },
  });
});

test("resolveTarget surfaces the provider's chat title for history/campaign display", async () => {
  const group = channel({ username: "lpmgroup", megagroup: true, title: "Grup LPM Contoh" });
  const { adapter, client } = await ready();
  client.entities.set("@lpmgroup", group);
  client.invokeImpl = async () => ({ participant: { className: "ChannelParticipantSelf" } });

  const resolved = await adapter.resolveTarget("@lpmgroup");
  assert.equal(resolved.title, "Grup LPM Contoh");
});

test("join reports existing membership, successful join, and approval request explicitly", async () => {
  const existing = channel({ username: "existing", megagroup: true });
  const waiting = channel({ username: "waiting", id: "102", megagroup: true, left: true });
  const { adapter, client } = await ready();
  client.entities.set("@existing", existing);
  client.entities.set("@waiting", waiting);
  assert.deepEqual(await adapter.joinPublicTarget("@existing"), { state: "ALREADY_MEMBER" });

  client.invokeImpl = async () => { throw namedError("UserNotParticipantError"); };
  client.joinImpl = async () => { throw namedError("InviteRequestSentError"); };
  assert.deepEqual(await adapter.joinPublicTarget("@waiting"), { state: "APPROVAL_REQUESTED" });

  client.joinImpl = async () => ({});
  assert.deepEqual(await adapter.joinPublicTarget("@waiting"), { state: "JOINED" });
});

test("sends text without link preview and returns a provider receipt", async () => {
  const { adapter, client } = await ready();
  const receipt = await adapter.sendText({ targetRef: "@lpmgroup", text: "promo" });
  assert.deepEqual(client.sendCalls, [{ entity: "@lpmgroup", params: { message: "promo", linkPreview: false } }]);
  assert.deepEqual(receipt, { providerMessageIds: ["501"], sentAt: "2027-01-15T08:00:00.000Z" });
});

test("sends a reply as a genuine comment on a channel post when commentToPostId is set", async () => {
  const { adapter, client } = await ready();
  await adapter.sendText({ targetRef: "@basewtb", text: "gua ready kak", commentToPostId: "204" });
  assert.deepEqual(client.sendCalls, [{ entity: "@basewtb", params: { message: "gua ready kak", linkPreview: false, commentTo: 204 } }]);
});

test("rejects a non-numeric commentToPostId before calling the provider", async () => {
  const { adapter, client } = await ready();
  await assert.rejects(() => adapter.sendText({ targetRef: "@basewtb", text: "gua ready kak", commentToPostId: "not-a-number" }), /INVALID_COMMENT_TO_POST_ID/);
  assert.equal(client.sendCalls.length, 0);
});

test("native-forwards one source post in exactly one provider call", async () => {
  const source = channel({ username: "VadeMecums" });
  const { adapter, client } = await ready();
  client.entities.set("@VadeMecums", source);
  client.messagesImpl = async () => [{ id: 204, date: 1_800_000_000 }];

  await adapter.forwardNative({
    targetRef: "@lpmgroup",
    source: { channelUsername: "VadeMecums", messageId: 204 },
    sourceAttribution: "SHOW_SOURCE",
  });

  assert.equal(client.forwardCalls.length, 1);
  assert.deepEqual(client.forwardCalls[0]?.params.messages, [204]);
  assert.equal(client.forwardCalls[0]?.params.dropAuthor, false);
  assert.equal(client.getMessagesCalls[0]?.ids.length, 21);
});

test("native-forwards a mixed-media album as one ordered Telegram operation", async () => {
  const source = channel({ username: "albumsource" });
  const { adapter, client } = await ready();
  client.entities.set("@albumsource", source);
  client.messagesImpl = async () => [
    { id: 209, date: 1_800_000_000, groupedId: 77n, media: "video" },
    { id: 205, date: 1_800_000_000, groupedId: 77n, media: "photo" },
    { id: 208, date: 1_800_000_000, groupedId: 99n, media: "unrelated" },
    { id: 204, date: 1_800_000_000, groupedId: 77n, media: "photo", caption: "promo" },
  ];
  client.forwardImpl = async () => [
    [{ id: 901, date: 1_800_000_001 }],
    [{ id: 902, date: 1_800_000_001 }, { id: 903, date: 1_800_000_001 }],
  ];

  const receipt = await adapter.forwardNative({
    targetRef: "@lpmgroup",
    source: { channelUsername: "albumsource", messageId: 204 },
    sourceAttribution: "HIDE_SOURCE",
  });

  assert.equal(client.forwardCalls.length, 1);
  assert.deepEqual(client.forwardCalls[0]?.params.messages, [204, 205, 209]);
  assert.equal(client.forwardCalls[0]?.params.dropAuthor, true);
  assert.deepEqual(receipt.providerMessageIds, ["901", "902", "903"]);
});

test("does not claim success when source or provider receipt is incomplete", async () => {
  const source = channel({ username: "sourcepost" });
  const { adapter, client } = await ready();
  client.entities.set("@sourcepost", source);
  client.messagesImpl = async () => [];
  await expectAdapterError(() => adapter.forwardNative({
    targetRef: "@lpmgroup",
    source: { channelUsername: "sourcepost", messageId: 40 },
    sourceAttribution: "SHOW_SOURCE",
  }), { code: "SOURCE_NOT_FOUND", sideEffectState: "NOT_SENT" });

  client.messagesImpl = async () => [
    { id: 40, date: 1_800_000_000, groupedId: 3n },
    { id: 41, date: 1_800_000_000, groupedId: 3n },
  ];
  client.forwardImpl = async () => [{ id: 900, date: 1_800_000_001 }];
  await expectAdapterError(() => adapter.forwardNative({
    targetRef: "@lpmgroup",
    source: { channelUsername: "sourcepost", messageId: 40 },
    sourceAttribution: "SHOW_SOURCE",
  }), { code: "TELEGRAM_UNKNOWN", sideEffectState: "UNKNOWN" });
});

test("distinguishes a failed forward preflight from an uncertain native-forward outcome", async () => {
  const source = channel({ username: "phasecheck" });
  const { adapter, client } = await ready();
  client.entities.set("@phasecheck", source);
  client.messagesImpl = async () => { throw namedError("TimeoutError"); };
  await expectAdapterError(() => adapter.forwardNative({
    targetRef: "@lpmgroup",
    source: { channelUsername: "phasecheck", messageId: 20 },
    sourceAttribution: "SHOW_SOURCE",
  }), { code: "TELEGRAM_TRANSIENT", sideEffectState: "NOT_SENT" });

  client.messagesImpl = async () => [{ id: 20, date: 1_800_000_000 }];
  client.forwardImpl = async () => { throw namedError("TimeoutError"); };
  await expectAdapterError(() => adapter.forwardNative({
    targetRef: "@lpmgroup",
    source: { channelUsername: "phasecheck", messageId: 20 },
    sourceAttribution: "SHOW_SOURCE",
  }), { code: "TELEGRAM_TRANSIENT", sideEffectState: "UNKNOWN" });
});

test("a hung provider call reaches its deadline, disconnects, and blocks later account work", async () => {
  const client = new FakeClient();
  const adapter = new TeleprotoProductionAdapter(client, { operationTimeoutMs: 10 });
  await adapter.connect();
  client.sendImpl = async () => new Promise<never>(() => undefined);
  await expectAdapterError(
    () => adapter.sendText({ targetRef: "@lpm", text: "may-or-may-not-have-sent" }),
    { code: "TELEGRAM_TRANSIENT", retryable: true, sideEffectState: "UNKNOWN" },
  );
  assert.equal(adapter.state, "FAILED");
  assert.equal(client.disconnectCount, 1);
  await expectAdapterError(() => adapter.sendText({ targetRef: "@lpm", text: "must-not-run" }), { code: "ADAPTER_NOT_READY" });
});

test("serializes concurrent operations for one account and isolates fatal state", async () => {
  const { adapter, client } = await ready();
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  client.sendImpl = async (_entity, params) => {
    if (params.message === "first") await firstBlocked;
    return { id: params.message === "first" ? 1 : 2, date: 1_800_000_000 };
  };

  const first = adapter.sendText({ targetRef: "@lpm", text: "first" });
  const second = adapter.sendText({ targetRef: "@lpm", text: "second" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(client.sendCalls.map((call) => call.params.message), ["first"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(client.sendCalls.map((call) => call.params.message), ["first", "second"]);

  client.sendImpl = async () => { throw namedError("SessionRevokedError"); };
  await expectAdapterError(() => adapter.sendText({ targetRef: "@lpm", text: "fatal" }), { code: "SESSION_REVOKED" });
  assert.equal(adapter.state, "FAILED");
  await expectAdapterError(() => adapter.sendText({ targetRef: "@lpm", text: "after-fatal" }), { code: "ADAPTER_NOT_READY" });

  const isolated = await ready();
  assert.deepEqual(await isolated.adapter.sendText({ targetRef: "@lpm", text: "other-account" }), {
    providerMessageIds: ["501"],
    sentAt: "2027-01-15T08:00:00.000Z",
  });
  assert.equal(isolated.adapter.state, "READY");
});

test("listNewChannelPosts polls history since the given id, extracts text, and skips malformed entries", async () => {
  const { adapter, client } = await ready();
  client.historyImpl = async () => [
    { id: 42, date: 1_800_000_000, message: "keyword cari admin" },
    { id: 0, date: 1_800_000_001, message: "malformed, ignored" },
    { id: 43, date: 1_800_000_002 },
  ];

  const posts = await adapter.listNewChannelPosts("@menfess", { afterMessageId: 40, limit: 50 });

  assert.equal(client.getHistoryCalls.length, 1);
  assert.deepEqual(client.getHistoryCalls[0], { entity: "@menfess", minId: 40, limit: 50 });
  assert.deepEqual(posts, [
    { channelPostId: "42", text: "keyword cari admin" },
    { channelPostId: "43", text: "" },
  ]);
});

test("listNewChannelPosts validates its bounds and refuses to run before the adapter is ready", async () => {
  const { adapter } = await ready();
  await assert.rejects(() => adapter.listNewChannelPosts("@menfess", { afterMessageId: -1, limit: 50 }), /INVALID_AFTER_MESSAGE_ID/);
  await assert.rejects(() => adapter.listNewChannelPosts("@menfess", { afterMessageId: 0, limit: 0 }), /INVALID_MESSAGE_LIMIT/);
  await assert.rejects(() => adapter.listNewChannelPosts("@menfess", { afterMessageId: 0, limit: 101 }), /INVALID_MESSAGE_LIMIT/);

  const client = new FakeClient();
  const notReady = new TeleprotoProductionAdapter(client);
  await expectAdapterError(() => notReady.listNewChannelPosts("@menfess", { afterMessageId: 0, limit: 50 }), { code: "ADAPTER_NOT_READY" });
});

test("latestChannelPostId peeks the newest post without paging through history, and is null for an empty channel", async () => {
  const { adapter, client } = await ready();
  client.historyImpl = async () => [{ id: 77, date: 1_800_000_003, message: "post terbaru" }];

  const latest = await adapter.latestChannelPostId("@menfess");

  assert.equal(client.getHistoryCalls.length, 1);
  assert.deepEqual(client.getHistoryCalls[0], { entity: "@menfess", minId: undefined, limit: 1 });
  assert.equal(latest, "77");

  client.historyImpl = async () => [];
  assert.equal(await adapter.latestChannelPostId("@menfess"), null);
});
