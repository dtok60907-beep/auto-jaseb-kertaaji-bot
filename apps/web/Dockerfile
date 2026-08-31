FROM node:22-alpine AS build

WORKDIR /app
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci --ignore-scripts
COPY apps/web/tsconfig.json apps/web/vite.config.ts apps/web/index.html ./
COPY apps/web/src ./src
COPY apps/web/public ./public
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/web/docker-entrypoint.sh /usr/local/bin/kertaaji-web-entrypoint
RUN chmod +x /usr/local/bin/kertaaji-web-entrypoint
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/kertaaji-web-entrypoint"]
