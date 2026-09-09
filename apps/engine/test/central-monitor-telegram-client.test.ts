import assert from "node:assert/strict";
import test from "node:test";

import { monitorChannelNeedsJoin } from "../src/central-monitor/telegram-client.ts";

test("monitor joins only a channel Telegram explicitly reports as left", () => {
  assert.equal(monitorChannelNeedsJoin({ left: true }), true);
  assert.equal(monitorChannelNeedsJoin({ left: false }), false);
  assert.equal(monitorChannelNeedsJoin({}), false);
  assert.equal(monitorChannelNeedsJoin(null), false);
});

test("monitor does not retry joining a channel that has kicked the account", () => {
  assert.equal(monitorChannelNeedsJoin({ left: true, kicked: true }), false);
});
