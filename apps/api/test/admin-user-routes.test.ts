import assert from "node:assert/strict";
import test from "node:test";

import { createApi } from "../src/app.ts";
import type { AdminUserRepository } from "../src/admin-users/repository.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";

test("lists canonical Telegram users only for an admin", async (t) => {
  const calls: Array<{ query: string; limit: number }> = [];
  const users: AdminUserRepository = {
    async list(input) {
      calls.push(input);
      return [{ id: USER_ID, telegramUserId: "123", firstName: "Adit", username: "adit", lastAuthenticatedAt: null, isAdmin: false }];
    },
  };
  const empty = {} as never;
  const admin = createApi({
    packages: empty, broadcasts: empty, autoComments: empty, entitlements: empty, adminUsers: users,
    authorizeUser: async () => ({ id: USER_ID }), authorizeAdmin: async () => ({ id: USER_ID }),
  });
  const normal = createApi({
    packages: empty, broadcasts: empty, autoComments: empty, entitlements: empty, adminUsers: users,
    authorizeUser: async () => ({ id: USER_ID }), authorizeAdmin: async () => null,
  });
  t.after(async () => { await Promise.all([admin.close(), normal.close()]); });

  const listed = await admin.inject({ method: "GET", url: "/v1/admin/users?q=adit&limit=20" });
  const denied = await normal.inject({ method: "GET", url: "/v1/admin/users" });

  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().users[0].telegramUserId, "123");
  assert.deepEqual(calls, [{ query: "adit", limit: 20 }]);
  assert.equal(denied.statusCode, 403);
  assert.deepEqual(denied.json(), { code: "ADMIN_REQUIRED" });
});
