#!/bin/sh
set -eu

case "${API_BASE_URL:-}" in
  http://*|https://*) ;;
  *) echo 'API_BASE_URL must be an absolute http(s) URL' >&2; exit 1 ;;
esac

web_port=$(printenv PORT 2>/dev/null || true)
if [ -z "$web_port" ]; then web_port=8080; fi
case "$web_port" in
  ''|*[!0-9]*) echo 'PORT must be a numeric TCP port' >&2; exit 1 ;;
esac
sed 's/listen 80;/listen '"$web_port"';/' /etc/nginx/conf.d/default.conf > /tmp/kertaaji-nginx.conf
mv /tmp/kertaaji-nginx.conf /etc/nginx/conf.d/default.conf

escaped_api_base=$(printf '%s' "$API_BASE_URL" | sed 's/[\\"]/\\&/g')
printf 'window.__JASEB_RUNTIME_CONFIG__={apiBaseUrl:"%s"};\n' "$escaped_api_base" > /usr/share/nginx/html/config.js
exec nginx -g 'daemon off;'
