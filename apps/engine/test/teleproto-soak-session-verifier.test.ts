import assert from "node:assert/strict";
import test from "node:test";

import {
  TeleprotoSoakSessionVerifier,
  type TeleprotoVerificationClient,
} from "../src/benchmark/teleproto-soak-session-verifier.ts";

class FakeClient implements TeleprotoVerificationClient {
  authorized = true;
  providerUserId: unknown = 12345n;
  connectError: Error | null = null;
  disconnectCalls = 0;

  async connect(): Promise<void> { if (this.connectError) throw this.connectError; }
  async checkAuthorization(): Promise<boolean> { return this.authorized; }
  async getMe(): Promise<Readonly<{ id: unknown }>> { return { id: this.providerUserId }; }
  async disconnect(): Promise<void> { this.disconnectCalls += 1; }
}

function verifier(client: FakeClient) {
  return new TeleprotoSoakSessionVerifier({
    apiId: 12345,
    apiHash: "a".repeat(32),
    operationTimeoutMilliseconds: 1_000,
    createClient: () => client,
  });
}

test("Teleproto verifier returns only the stable authorized identity and always disconnects", async () => {
  const client = new FakeClient();
  const result = await verifier(client).verify("private-session");
  assert.deepEqual(result, { providerUserId: "12345" });
  assert.equal(client.disconnectCalls, 1);
  assert.equal(JSON.stringify(verifier(client)).includes("private-session"), false);
});

test("unauthorized, malformed identity, and connection failures still disconnect", async () => {
  for (const mutate of [
    (client: FakeClient) => { client.authorized = false; },
    (client: FakeClient) => { client.providerUserId = "not-an-id"; },
    (client: FakeClient) => { client.connectError = new Error("raw provider detail"); },
  ]) {
    const client = new FakeClient();
    mutate(client);
    await assert.rejects(() => verifier(client).verify("private-session"));
    assert.equal(client.disconnectCalls, 1);
  }
});
