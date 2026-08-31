import assert from "node:assert/strict";
import test from "node:test";

import { createApi } from "../src/app.ts";

test("API answers Mini App CORS preflight without enabling cookie credentials", async (t) => {
  const empty = {} as never;
  const app = createApi({
    packages: empty,
    broadcasts: empty,
    autoComments: empty,
    entitlements: empty,
    authorizeUser: async () => null,
    authorizeAdmin: async () => null,
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "OPTIONS",
    url: "/v1/userbot/telegram-accounts",
    headers: { origin: "https://mini.example" },
  });

  assert.equal(response.statusCode, 204);
  assert.equal(response.headers["access-control-allow-origin"], "*");
  assert.equal(response.headers["access-control-allow-headers"], "authorization, content-type");
  assert.equal(response.headers["access-control-allow-methods"], "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  assert.equal(response.headers["access-control-allow-credentials"], undefined);
});
