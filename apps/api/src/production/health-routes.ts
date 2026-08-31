import type { FastifyInstance } from "fastify";

export type ProductionApiState = "STARTING" | "RUNNING" | "STOPPING" | "STOPPED";
export type ProductionApiReadinessErrorCode =
  | "API_STARTING"
  | "DATABASE_UNAVAILABLE"
  | "API_STOPPING"
  | "API_STOPPED";

export type ProductionApiReadinessView = Readonly<{
  ready: boolean;
  state: ProductionApiState;
  errorCode: ProductionApiReadinessErrorCode | null;
}>;

export function registerProductionApiHealthRoutes(
  app: FastifyInstance,
  readiness: () => ProductionApiReadinessView,
): void {
  app.get("/health/live", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return { status: "alive" };
  });

  app.get("/health/ready", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    let current: ProductionApiReadinessView;
    try { current = readiness(); }
    catch {
      return reply.code(503).send({ status: "not_ready", errorCode: "READINESS_STATE_UNAVAILABLE" });
    }
    return reply.code(current.ready ? 200 : 503).send({
      status: current.ready ? "ready" : "not_ready",
      state: current.state,
      errorCode: current.errorCode,
    });
  });
}
