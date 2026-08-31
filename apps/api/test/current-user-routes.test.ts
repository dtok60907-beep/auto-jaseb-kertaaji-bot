import assert from "node:assert/strict";
import test from "node:test";

import { createApi } from "../src/app.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";

function app(role: "ADMIN" | "USER" | null) {
  const empty = {} as never;
  return createApi({
    packages: empty,
    broadcasts: empty,
    autoComments: empty,
    entitlements: empty,
    authorizeUser: async () => role === null ? null : { id: USER_ID },
    authorizeAdmin: async () => role === "ADMIN" ? { id: USER_ID } : null,
  });
}

test("returns the server-side role for the active API session", async (t) => {
  const admin = app("ADMIN");
  const user = app("USER");
  const missing = app(null);
  t.after(async () => { await Promise.all([admin.close(), user.close(), missing.close()]); });

  const adminResponse = await admin.inject({ method: "GET", url: "/v1/me" });
  const userResponse = await user.inject({ method: "GET", url: "/v1/me" });
  const missingResponse = await missing.inject({ method: "GET", url: "/v1/me" });

  assert.deepEqual(adminResponse.json(), { user: { id: USER_ID, role: "ADMIN" } });
  assert.deepEqual(userResponse.json(), { user: { id: USER_ID, role: "USER" } });
  assert.equal(missingResponse.statusCode, 401);
  assert.deepEqual(missingResponse.json(), { code: "USER_REQUIRED" });
  assert.equal(adminResponse.headers["cache-control"], "no-store");
});
