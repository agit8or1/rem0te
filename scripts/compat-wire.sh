#!/usr/bin/env bash
# Older released standard agents' wire bodies against the server under test (0.73.1).
#
#   cd apps/api && npx nest build
#   DATABASE_URL=postgresql://…/<name containing scratch|test> scripts/compat-wire.sh [windows|linux|macos]
#
# Migrates and seeds the scratch database, then replays every fixture in
# scripts/compat/wire (captured from each release's own scripts by
# scripts/compat/capture-wire.mjs) against a scratch API on 127.0.0.1:3981
# (WIRE_API_PORT, 3981–3988 only). Evidence: the wire, not the computer. It
# says the server still accepts what an old agent sends and answers in a form
# the old agent reads; it says nothing about the agent's own Windows, Linux or
# macOS calls (docs/compatibility.md).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="${DATABASE_URL:-}"; name="${DB##*/}"; name="${name%%\?*}"
if [[ -z "$DB" || ! "$name" =~ (scratch|test) ]]; then
  echo "Refusing: DATABASE_URL must name a database containing 'scratch' or 'test' (got '${name:-unset}')." >&2; exit 2
fi
[[ -f "$ROOT/apps/api/dist/main.js" ]] || { echo "build the API first: cd apps/api && npx nest build" >&2; exit 2; }
OUT="${COMPAT_OUT:-$ROOT/.compat-logs}/wire"; mkdir -p "$OUT"
export DATABASE_URL="$DB" I_KNOW_THIS_IS_NOT_PRODUCTION=1 NODE_ENV=test COMPAT_OUT="${COMPAT_OUT:-$ROOT/.compat-logs}"
export ENCRYPTION_KEY="${ENCRYPTION_KEY:-$(openssl rand -hex 32)}"
export SEED_ADMIN_EMAIL="${SEED_ADMIN_EMAIL:-e2e-admin@example.com}" SEED_ADMIN_PASSWORD="${SEED_ADMIN_PASSWORD:-$(openssl rand -base64 18)}"
cd "$ROOT/apps/api"
npx prisma migrate deploy > "$OUT/migrate.log" 2>&1 || { cat "$OUT/migrate.log"; exit 1; }
RUSTDESK_RELAY_HOST=relay.scratch.example.com RUSTDESK_PUBLIC_KEY="$(openssl rand -base64 32)" \
  npx prisma db seed > "$OUT/seed.log" 2>&1 || { cat "$OUT/seed.log"; exit 1; }
exec node "$ROOT/scripts/compat-wire.mjs" "$@"
