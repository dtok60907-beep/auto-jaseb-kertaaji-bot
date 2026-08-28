import assert from "node:assert/strict";
import test from "node:test";
import {
  AdapterState,
  SessionConfig,
  TelegramAdapterError,
  TeleprotoAdapter,
  mapTelegramError,
} from "../adapter.mjs";

class FakeClient {
  authorized = true;
  connectCalls = 0;
  disconnectCalls = 0;
  sendCalls = [];
  handlers = [];
  connectError = null;
  disconnectError = null;
  sendError = null;
  sendGate = null;
  sendStarted = null;
  activeSends = 0;
  maxActiveSends = 0;

  async connect() {
    this.connectCalls += 1;
    if (this.connectError) throw this.connectError;
  }

  async disconnect() {
    this.disconnectCalls += 1;
    if (this.disconnectError) throw this.disconnectError;
  }

  async checkAuthorization() {
    return this.authorized;
  }

  async sendMessage(target, params) {
    if (this.sendError) throw this.sendError;
    this.activeSends += 1;
    this.maxActiveSends = Math.max(this.maxActiveSends, this.activeSends);
    try {
      this.sendStarted?.resolve();
      if (this.sendGate) await this.sendGate;
      this.sendCalls.push([target, params]);
      return { target, text: params.message };
    } finally {
      this.activeSends -= 1;
    }
  }

  addEventHandler(callback, event) {
    this.handlers.push([callback, event]);
  }
}

class FloodWaitError extends Error {
  constructor(seconds) {
    super("raw flood detail");
    this.seconds = seconds;
  }
}

class SessionRevokedError extends Error {}
class ChatWriteForbiddenError extends Error {}
class RPCError extends Error {}
class TimeoutError extends Error {}

test("connect is idempotent and authorized", async () => {
  const client = new FakeClient();
  const adapter = new TeleprotoAdapter(client);
  await adapter.connect();
  await adapter.connect();

  assert.equal(adapter.state, AdapterState.READY);
  assert.equal(client.connectCalls, 1);
  assert.deepEqual(adapter.describe(), { candidate: "teleproto", state: "READY" });
});

test("connect rejects unauthorized session", async () => {
  const client = new FakeClient();
  client.authorized = false;
  const adapter = new TeleprotoAdapter(client);

  await assert.rejects(adapter.connect(), (error) => error.code === "SESSION_NOT_AUTHORIZED" && error.retryable === false);
  assert.equal(adapter.state, AdapterState.FAILED);
});

test("send requires ready state and normalizes Teleproto message params", async () => {
  const client = new FakeClient();
  const adapter = new TeleprotoAdapter(client);
  await assert.rejects(adapter.sendMessage("target", "halo"), (error) => error.code === "ADAPTER_NOT_READY");

  await adapter.connect();
  const sent = await adapter.sendMessage("target", "halo", { commentTo: 42 });
  assert.deepEqual(sent, { target: "target", text: "halo" });
  assert.deepEqual(client.sendCalls, [["target", { message: "halo", commentTo: 42 }]]);
  await assert.rejects(adapter.sendMessage("target", "halo", { message: "overwrite" }), /reserved/);
});

test("concurrent sends are serialized per session", async () => {
  const client = new FakeClient();
  client.sendGate = Promise.withResolvers();
  client.sendStarted = Promise.withResolvers();
  const adapter = new TeleprotoAdapter(client);
  await adapter.connect();

  const first = adapter.sendMessage("target", "pertama");
  await client.sendStarted.promise;
  const second = adapter.sendMessage("target", "kedua");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.maxActiveSends, 1);
  client.sendGate.resolve();
  await Promise.all([first, second]);

  assert.equal(client.maxActiveSends, 1);
  assert.deepEqual(client.sendCalls.map((item) => item[1].message), ["pertama", "kedua"]);
});

test("disconnect is idempotent", async () => {
  const client = new FakeClient();
  const adapter = new TeleprotoAdapter(client);
  await adapter.disconnect();
  await adapter.connect();
  await adapter.disconnect();
  await adapter.disconnect();

  assert.equal(adapter.state, AdapterState.DISCONNECTED);
  assert.equal(client.disconnectCalls, 1);
});

test("receive handler registration awaits user handler", async () => {
  const client = new FakeClient();
  const seen = [];
  const adapter = new TeleprotoAdapter(client, { newMessageEvent: "NEW_MESSAGE" });
  const bridge = adapter.addNewMessageHandler(async (event) => seen.push(event));
  await bridge({ id: 9 });

  assert.deepEqual(seen, [{ id: 9 }]);
  assert.deepEqual(client.handlers, [[bridge, "NEW_MESSAGE"]]);
});

test("known errors map to stable public codes", () => {
  const cases = [
    [new FloodWaitError(901), "FLOOD_WAIT", true],
    [new SessionRevokedError(), "SESSION_REVOKED", false],
    [new ChatWriteForbiddenError(), "CHAT_WRITE_FORBIDDEN", false],
    [new RPCError(), "TELEGRAM_TRANSIENT", true],
    [new TimeoutError(), "TELEGRAM_TRANSIENT", true],
    [new Error("raw provider detail"), "TELEGRAM_UNKNOWN", false],
  ];
  for (const [raw, code, retryable] of cases) {
    const mapped = mapTelegramError(raw);
    assert.equal(mapped.code, code);
    assert.equal(mapped.retryable, retryable);
    assert.equal(mapped.message.includes("raw provider detail"), false);
  }
});

test("session config is redacted", () => {
  const config = new SessionConfig({ apiId: 1, apiHash: "super-secret-hash", session: "super-secret-session" });
  assert.equal(config.toString(), "SessionConfig(redacted=True)");
  assert.equal(JSON.stringify(config), '{"redacted":true}');
  assert.equal(JSON.stringify(config).includes("super-secret"), false);
  assert.throws(() => new SessionConfig({ apiId: 0, apiHash: "x", session: "x" }), /positive integer/);
});

test("unknown adapter error is returned unchanged", () => {
  const original = new TelegramAdapterError("ADAPTER_NOT_READY", { retryable: true, message: "Koneksi Telegram belum siap." });
  assert.equal(mapTelegramError(original), original);
});
