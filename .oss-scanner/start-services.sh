#!/usr/bin/env bash
# Start what the API needs inside the OSS Scanner image, with no network:
# Postgres and Redis on loopback, migrations applied, the seed run, then the
# built API on 127.0.0.1:3001 (log: /tmp/api.log).
#
#   .oss-scanner/start-services.sh               # everything, API in background
#   .oss-scanner/start-services.sh --migrate-only  # used by the Dockerfile
#
# Then, for example:
#   cd /src/apps/api && node scripts/e2e-smoke.mjs
#   cd /src/apps/api && node scripts/e2e-business-access.mjs
#   cd /src/apps/api && node scripts/security-regression.mjs
set -euo pipefail

ENV_FILE=/etc/reboot-remote/api.env
set -a; . "$ENV_FILE"; set +a

PG_VER=$(ls /usr/lib/postgresql | sort -V | tail -1)
PG_BIN=/usr/lib/postgresql/$PG_VER/bin
PG_DATA=/var/lib/postgresql/$PG_VER/main

# Debian's cluster config; listen on loopback only.
pg_ctlcluster "$PG_VER" main start 2>/dev/null || true
for _ in $(seq 1 30); do pg_isready -h 127.0.0.1 -q && break; sleep 1; done

pgrep -x redis-server >/dev/null || redis-server --bind 127.0.0.1 --port 6379 --daemonize yes --save '' --appendonly no
for _ in $(seq 1 30); do redis-cli -h 127.0.0.1 ping >/dev/null 2>&1 && break; sleep 1; done

# Role and database from DATABASE_URL (created once).
DB_PASS=$(sed -E 's#^postgresql://[^:]+:([^@]+)@.*#\1#' <<<"$DATABASE_URL")
su postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='reboot'\"" | grep -q 1 \
  || su postgres -c "psql -c \"CREATE USER reboot WITH PASSWORD '$DB_PASS' CREATEDB;\""
su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='reboot_remote'\"" | grep -q 1 \
  || su postgres -c "psql -c \"CREATE DATABASE reboot_remote OWNER reboot;\""

cd /src/apps/api
pnpm exec prisma migrate deploy
pnpm exec prisma db seed || echo "WARNING: seed failed"

if [[ "${1:-}" == "--migrate-only" ]]; then
  redis-cli -h 127.0.0.1 shutdown nosave >/dev/null 2>&1 || true
  pg_ctlcluster "$PG_VER" main stop
  exit 0
fi

if ! curl -sf http://127.0.0.1:3001/api/v1/public/rustdesk-config >/dev/null 2>&1; then
  nohup node dist/main.js >/tmp/api.log 2>&1 &
  for _ in $(seq 1 60); do
    curl -sf http://127.0.0.1:3001/api/v1/public/rustdesk-config >/dev/null 2>&1 && break
    sleep 1
  done
fi
curl -sf -o /dev/null -w "API up: %{http_code}\n" http://127.0.0.1:3001/api/v1/public/rustdesk-config \
  || { echo "API did not start; see /tmp/api.log"; tail -40 /tmp/api.log; exit 1; }
