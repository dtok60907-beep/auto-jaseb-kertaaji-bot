FROM node:22.23.2-bookworm-slim

ENV NODE_ENV=production
WORKDIR /workspace/apps/api

COPY apps/api/package.json apps/api/package-lock.json ./
RUN npm ci --omit=dev

COPY apps/api/src ./src
COPY packages/telegram-contract /workspace/packages/telegram-contract

# Node must be PID 1 so Railway SIGTERM reaches the graceful-shutdown handler.
CMD ["node", "--experimental-strip-types", "src/production/main.ts"]
