import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import {
  registerProductionApiHealthRoutes,
  type ProductionApiReadinessView,
} from "../src/production/health-routes.ts";

test("health routes distinguish liveness from dependency readiness without leaking callback errors", async () => {
  const app = Fastify({ logger: false });
  let current: ProductionApiReadinessView = Object.freeze({
    ready: false,
    state: "STARTING",
    errorCode: "API_STARTING",
  });
  let throwReadiness = false;
  registerProductionApiHealthRoutes(app, () => {
    if (throwReadiness) throw new Error("raw database credential detail");
    return current;
  });

  assert.deepEqual((await app.inject({ method: "GET", url: "/health/live" })).json(), { status: "alive" });
  const starting = await app.inject({ method: "GET", url: "/health/ready" });
  assert.equal(starting.statusCode, 503);
  assert.equal(starting.headers["cache-control"], "no-store");
  assert.deepEqual(starting.json(), { status: "not_ready", state: "STARTING", errorCode: "API_STARTING" });

  current = Object.freeze({ ready: true, state: "RUNNING", errorCode: null });
  const ready = await app.inject({ method: "GET", url: "/health/ready?source=railway" });
  assert.equal(ready.statusCode, 200);
  assert.deepEqual(ready.json(), { status: "ready", state: "RUNNING", errorCode: null });
  assert.equal((await app.inject({ method: "HEAD", url: "/health/ready" })).body, "");

  throwReadiness = true;
  const unavailable = await app.inject({ method: "GET", url: "/health/ready" });
  assert.equal(unavailable.statusCode, 503);
  assert.deepEqual(unavailable.json(), { status: "not_ready", errorCode: "READINESS_STATE_UNAVAILABLE" });
  assert.equal(unavailable.body.includes("raw database credential detail"), false);
  await app.close();
});
