#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/jaseb-app-users.XXXXXX")"
PG_TEST_DATA="${PG_TEST_ROOT}/data"
PG_TEST_PORT="$((55000 + RANDOM % 1000))"
export LC_ALL=C

stop_postgres() {
  if [[ -f "${PG_TEST_DATA}/postmaster.pid" ]]; then
    pg_ctl -D "${PG_TEST_DATA}" -m fast -w stop >/dev/null
  fi
}
trap stop_postgres EXIT

initdb -D "${PG_TEST_DATA}" -A trust -U postgres >/dev/null
pg_ctl -D "${PG_TEST_DATA}" -o "-F -p ${PG_TEST_PORT} -k ${PG_TEST_ROOT}" -w start >/dev/null

export PGHOST="${PG_TEST_ROOT}"
export PGPORT="${PG_TEST_PORT}"
export PGUSER=postgres
export PGDATABASE=postgres

psql -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
SQL

bootstrap_database() {
  local database_name="$1"
  createdb "${database_name}"
  PGDATABASE="${database_name}" psql -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
SQL
}

apply_migrations() {
  local database_name="$1"
  local stop_before="${2:-}"
  local migration
  for migration in "${PROJECT_ROOT}"/supabase/migrations/*.sql; do
    if [[ -n "${stop_before}" && "$(basename "${migration}")" == "${stop_before}" ]]; then
      break
    fi
    PGDATABASE="${database_name}" psql -v ON_ERROR_STOP=1 -f "${migration}" >/dev/null
  done
}

bootstrap_database app_users_fresh
apply_migrations app_users_fresh
PGDATABASE=app_users_fresh psql -v ON_ERROR_STOP=1 \
  -f "${PROJECT_ROOT}/supabase/tests/20260831010000_app_users.sql" >/dev/null

bootstrap_database app_users_upgrade
apply_migrations app_users_upgrade 20260831010000_app_users.sql
PGDATABASE=app_users_upgrade psql -v ON_ERROR_STOP=1 \
  -f "${PROJECT_ROOT}/supabase/tests/upgrades/20260831010000_seed.sql" >/dev/null
PGDATABASE=app_users_upgrade psql -v ON_ERROR_STOP=1 \
  -f "${PROJECT_ROOT}/supabase/migrations/20260831010000_app_users.sql" >/dev/null
PGDATABASE=app_users_upgrade psql -v ON_ERROR_STOP=1 \
  -f "${PROJECT_ROOT}/supabase/tests/upgrades/20260831010000_assert.sql" >/dev/null

bootstrap_database api_sessions_upgrade
apply_migrations api_sessions_upgrade 20260831020000_api_sessions.sql
PGDATABASE=api_sessions_upgrade psql -v ON_ERROR_STOP=1 \
  -f "${PROJECT_ROOT}/supabase/tests/upgrades/20260831020000_seed.sql" >/dev/null
PGDATABASE=api_sessions_upgrade psql -v ON_ERROR_STOP=1 \
  -f "${PROJECT_ROOT}/supabase/migrations/20260831020000_api_sessions.sql" >/dev/null
PGDATABASE=api_sessions_upgrade psql -v ON_ERROR_STOP=1 \
  -f "${PROJECT_ROOT}/supabase/tests/upgrades/20260831020000_assert.sql" >/dev/null

bootstrap_database app_admins_upgrade
apply_migrations app_admins_upgrade 20260831030000_app_admins.sql
PGDATABASE=app_admins_upgrade psql -v ON_ERROR_STOP=1 \
  -f "${PROJECT_ROOT}/supabase/tests/upgrades/20260831030000_seed.sql" >/dev/null
PGDATABASE=app_admins_upgrade psql -v ON_ERROR_STOP=1 \
  -f "${PROJECT_ROOT}/supabase/migrations/20260831030000_app_admins.sql" >/dev/null
PGDATABASE=app_admins_upgrade psql -v ON_ERROR_STOP=1 \
  -f "${PROJECT_ROOT}/supabase/tests/upgrades/20260831030000_assert.sql" >/dev/null

bootstrap_database canary_admissions_upgrade
apply_migrations canary_admissions_upgrade 20260831040000_canary_admissions.sql
PGDATABASE=canary_admissions_upgrade psql -v ON_ERROR_STOP=1 \
  -f "${PROJECT_ROOT}/supabase/tests/upgrades/20260831040000_seed.sql" >/dev/null
PGDATABASE=canary_admissions_upgrade psql -v ON_ERROR_STOP=1 \
  -f "${PROJECT_ROOT}/supabase/migrations/20260831040000_canary_admissions.sql" >/dev/null
PGDATABASE=canary_admissions_upgrade psql -v ON_ERROR_STOP=1 \
  -f "${PROJECT_ROOT}/supabase/tests/upgrades/20260831040000_assert.sql" >/dev/null

bootstrap_database canary_session_gate_upgrade
apply_migrations canary_session_gate_upgrade 20260831050000_canary_session_gate.sql
PGDATABASE=canary_session_gate_upgrade psql -v ON_ERROR_STOP=1 \
  -f "${PROJECT_ROOT}/supabase/tests/upgrades/20260831050000_seed.sql" >/dev/null
PGDATABASE=canary_session_gate_upgrade psql -v ON_ERROR_STOP=1 \
  -f "${PROJECT_ROOT}/supabase/migrations/20260831050000_canary_session_gate.sql" >/dev/null
PGDATABASE=canary_session_gate_upgrade psql -v ON_ERROR_STOP=1 \
  -f "${PROJECT_ROOT}/supabase/tests/upgrades/20260831050000_assert.sql" >/dev/null

PGDATABASE=app_users_fresh psql -v ON_ERROR_STOP=1 \
  -f "${PROJECT_ROOT}/supabase/tests/20260831020000_api_sessions.sql" >/dev/null
PGDATABASE=app_users_fresh psql -v ON_ERROR_STOP=1 \
  -f "${PROJECT_ROOT}/supabase/tests/20260831030000_app_admins.sql" >/dev/null
PGDATABASE=app_users_fresh psql -v ON_ERROR_STOP=1 \
  -f "${PROJECT_ROOT}/supabase/tests/20260831040000_canary_admissions.sql" >/dev/null
PGDATABASE=app_users_fresh psql -v ON_ERROR_STOP=1 \
  -f "${PROJECT_ROOT}/supabase/tests/20260831050000_canary_session_gate.sql" >/dev/null

(
  cd "${PROJECT_ROOT}/apps/api"
  API_DATABASE_URL="postgresql://postgres@127.0.0.1:${PG_TEST_PORT}/app_users_fresh" \
    node --experimental-strip-types --test \
      test/application-user-postgres.integration.test.ts \
      test/api-session-postgres.integration.test.ts \
      test/admin-access-postgres.integration.test.ts
)

(
  cd "${PROJECT_ROOT}/apps/engine"
  F4_DATABASE_URL="postgresql://postgres@127.0.0.1:${PG_TEST_PORT}/app_users_fresh" \
  F5_DATABASE_URL="postgresql://postgres@127.0.0.1:${PG_TEST_PORT}/app_users_fresh" \
    node --experimental-strip-types --test --test-concurrency=1 \
      test/broadcast-executor-postgres.integration.test.ts \
      test/runtime-accounts-postgres.integration.test.ts
)

printf '%s\n' \
  'APP_USERS_FRESH_MIGRATION_OK' \
  'APP_USERS_UPGRADE_MIGRATION_OK' \
  'APP_USERS_CONCURRENCY_OK' \
  'APP_USERS_ENGINE_FIXTURES_OK' \
  'API_SESSIONS_FRESH_MIGRATION_OK' \
  'API_SESSIONS_UPGRADE_MIGRATION_OK' \
  'API_SESSIONS_REPLAY_OK' \
  'APP_ADMINS_FRESH_MIGRATION_OK' \
  'APP_ADMINS_UPGRADE_MIGRATION_OK' \
  'APP_ADMINS_RLS_OK' \
  'CANARY_ADMISSIONS_FRESH_MIGRATION_OK' \
  'CANARY_ADMISSIONS_UPGRADE_MIGRATION_OK' \
  'CANARY_ADMISSIONS_HARD_CAP_OK' \
  'CANARY_ADMISSIONS_SESSION_REVOKE_OK' \
  'CANARY_SESSION_GATE_FRESH_MIGRATION_OK' \
  'CANARY_SESSION_GATE_UPGRADE_MIGRATION_OK' \
  'CANARY_SESSION_GATE_NO_PARTIAL_ROWS_OK'
