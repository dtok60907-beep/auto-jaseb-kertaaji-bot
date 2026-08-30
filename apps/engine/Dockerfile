FROM node:22.23.2-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

CMD ["npm", "run", "benchmark:railway"]
