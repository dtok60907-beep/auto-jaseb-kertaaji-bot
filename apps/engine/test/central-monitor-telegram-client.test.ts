import assert from "node:assert/strict";
import test from "node:test";

import { monitorChannelNeedsJoin, resolveProviderPeerId } from "../src/central-monitor/telegram-client.ts";

test("monitor joins only a channel Telegram explicitly reports as left", () => {
  assert.equal(monitorChannelNeedsJoin({ left: true }), true);
  assert.equal(monitorChannelNeedsJoin({ left: false }), false);
  assert.equal(monitorChannelNeedsJoin({}), false);
  assert.equal(monitorChannelNeedsJoin(null), false);
});

test("monitor does not retry joining a channel that has kicked the account", () => {
  assert.equal(monitorChannelNeedsJoin({ left: true, kicked: true }), false);
});

test("monitor awaits Teleproto peer id before building the routing key", async () => {
  const client = {
    async getPeerId() {
      await Promise.resolve();
      return "-1001234567890";
    },
  };

  assert.equal(await resolveProviderPeerId(client as never, {}), "-1001234567890");
});

test("monitor rejects a poisoned Promise routing key", async () => {
  const client = { async getPeerId() { return "[object Promise]"; } };
  await assert.rejects(resolveProviderPeerId(client as never, {}), /INVALID_PROVIDER_PEER_ID/);
});
