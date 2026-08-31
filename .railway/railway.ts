import {
  defineRailway,
  github,
  preserve,
  project,
  service,
} from "railway/iac";

export default defineRailway(() => {
  const api = service("kertaaji-api", {
    source: github("dtok60907-beep/auto-jaseb-kertaaji-bot", { branch: "main" }),
    build: {
      builder: "DOCKERFILE",
      buildEnvironment: "V3",
      dockerfilePath: "/apps/api/Dockerfile",
      watchPatterns: [
        "/.dockerignore",
        "/apps/api/Dockerfile",
        "/apps/api/package.json",
        "/apps/api/package-lock.json",
        "/apps/api/src/**",
        "/packages/telegram-contract/**",
      ],
    },
    deploy: {
      numReplicas: 1,
      healthcheckPath: "/health/ready",
      healthcheckTimeout: 300,
      overlapSeconds: 5,
      drainingSeconds: 35,
      runtime: "V2",
    },
    env: {
      DATABASE_URL: preserve(),
      TELEGRAM_BOT_TOKEN: preserve(),
      API_DATABASE_MAX_CONNECTIONS: "5",
      API_DATABASE_CONNECT_TIMEOUT_SECONDS: "10",
      API_DATABASE_IDLE_TIMEOUT_SECONDS: "30",
      API_DATABASE_MAX_LIFETIME_SECONDS: "1800",
      API_DATABASE_CLOSE_TIMEOUT_SECONDS: "10",
      API_DATABASE_PREPARE_STATEMENTS: "false",
      API_SESSION_TTL_SECONDS: "43200",
      TELEGRAM_INIT_DATA_MAX_AGE_SECONDS: "300",
      TELEGRAM_INIT_DATA_CLOCK_SKEW_SECONDS: "30",
      API_HOST: "0.0.0.0",
      API_READINESS_PROBE_INTERVAL_MS: "5000",
      API_READINESS_PROBE_TIMEOUT_MS: "2000",
      API_READINESS_FAILURE_THRESHOLD: "3",
      API_SHUTDOWN_GRACE_MS: "30000",
    },
  });

  return project("Auto Jaseb Kertaaji Production", {
    resources: [api],
  });
});
