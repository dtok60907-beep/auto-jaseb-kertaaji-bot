FROM node:22.23.2-bookworm-slim

ENV NODE_ENV=production
WORKDIR /workspace/apps/engine

COPY apps/engine/package.json apps/engine/package-lock.json ./
RUN npm ci --omit=dev

COPY apps/engine/src ./src
COPY packages/telegram-contract /workspace/packages/telegram-contract
COPY packages/telegram-session-crypto /workspace/packages/telegram-session-crypto
COPY packages/auto-comment-contract /workspace/packages/auto-comment-contract

CMD ["npm", "run", "start:production"]
