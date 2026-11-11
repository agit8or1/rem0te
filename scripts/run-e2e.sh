#!/usr/bin/env bash
# Every end-to-end suite, against one scratch database. CI runs this in the
# `e2e` job; it runs the same way locally:
#
#   DATABASE_URL=postgresql://…/<name containing scratch or test> scripts/run-e2e.sh
#
# Before it: `pnpm install`, `pnpm db:generate`, and a built API
# (`pnpm --filter @reboot-remote/api build`). It migrates and seeds the
# database itself, so a fresh empty database is the intended input.
#
# RELEASE_BIN and ACTION_SIM (built from tools/windows-installer) enable the
# suites that drive the Windows agent's decision code; without them those
# suites are reported as SKIPPED and the run fails — set E2E_ALLOW_SKIP=1 to
# accept that (never in CI).
#
# The suites write fixtures. Never point this at a database you care about.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_DIR="$ROOT/apps/api"
DB="${DATABASE_URL:-}"
name="${DB##*/}"; name="${name%%\?*}"
if [[ -z "$DB" || ! "$name" =~ (scratch|test) ]]; then
  echo "Refusing: DATABASE_URL must name a database containing 'scratch' or 'test' (got '${name:-unset}')." >&2
  exit 2
fi
OUT="${E2E_OUT:-$ROOT/.e2e-logs}"
mkdir -p "$OUT"
export DATABASE_URL="$DB" I_KNOW_THIS_IS_NOT_PRODUCTION=1 NODE_ENV=test
export ENCRYPTION_KEY="${ENCRYPTION_KEY:-$(openssl rand -hex 32)}"
export SEED_ADMIN_EMAIL="${SEED_ADMIN_EMAIL:-e2e-admin@example.com}"
export SEED_ADMIN_PASSWORD="${SEED_ADMIN_PASSWORD:-$(openssl rand -base64 18)}"
cd "$API_DIR"

echo "── migrate and seed"
npx prisma migrate deploy > "$OUT/migrate.log" 2>&1 || { cat "$OUT/migrate.log"; exit 1; }
# A relay host and key (placeholders: nothing dials them) — the Connect script,
# the installer and the signed-agent parameters all refuse to build without one.
RUSTDESK_RELAY_HOST="${RUSTDESK_RELAY_HOST:-relay.scratch.example.com}" \
RUSTDESK_PUBLIC_KEY="${RUSTDESK_PUBLIC_KEY:-$(openssl rand -base64 32)}" \
  npx prisma db seed > "$OUT/seed.log" 2>&1 || { cat "$OUT/seed.log"; exit 1; }

failed=(); skipped=()
summary() { grep -aE '[0-9]+ passed|ALL PASSED|PROOF PASSED|All security regression checks passed|[0-9]+ FAILED' "$1" | tail -1 | sed 's/\x1b\[[0-9;]*m//g' | cut -c1-120; }
run() { # name, command...
  local t="$1"; shift
  timeout 900 "$@" > "$OUT/$t.log" 2>&1; local rc=$?
  printf '%-22s exit %-3s %s\n' "$t" "$rc" "$(summary "$OUT/$t.log")"
  # The failed checks first: a long suite's tail alone can miss them.
  if [[ $rc -ne 0 ]]; then failed+=("$t"); grep -a -A2 '✗' "$OUT/$t.log" | head -40 | sed 's/^/    /'; tail -40 "$OUT/$t.log" | sed 's/^/    /'; fi
}

echo "── self-starting suites"
for t in credentials security-features presets monitoring integration dashboard diagnostics-catalog device-list add-device; do run "$t" node "scripts/e2e-$t.mjs"; done
for t in containment approved-action staged-patching signed-updates ticket-workflow; do
  if [[ -n "${RELEASE_BIN:-}" && -n "${ACTION_SIM:-}" ]]; then run "$t" node "scripts/e2e-$t.mjs"
  else printf '%-22s SKIPPED (RELEASE_BIN / ACTION_SIM not set)\n' "$t"; skipped+=("$t"); fi
done

echo "── suites against a scratch API (one API per suite: the login throttle is per process)"
PORT=3101
export API_BASE="http://127.0.0.1:$PORT/api/v1" FRONTEND_URL="http://scratch.example.com:3100"
for t in smoke full business-access offboarding public-api public-address rollouts security-audit session-mutations support-requests sso-passkeys candidate-password secreg; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then echo "port $PORT is busy" >&2; exit 1; fi
  env PORT=$PORT HBBS_PRESENCE_HOST=127.0.0.2 OIDC_ALLOW_INSECURE_LOOPBACK=true PUBLIC_API_URL="http://scratch.example.com:$PORT" \
    JWT_SECRET="$(openssl rand -hex 32)" LAUNCHER_TOKEN_SECRET="$(openssl rand -hex 32)" MONITOR_SWEEP=off \
    VERSION_FILE="$ROOT/version.json" node dist/main.js > "$OUT/api-$t.log" 2>&1 &
  pid=$!
  for _ in $(seq 1 180); do grep -q "listening on" "$OUT/api-$t.log" 2>/dev/null && break; sleep 1; done
  if [[ "$t" == secreg ]]; then run "$t" node scripts/security-regression.mjs; else run "$t" node "scripts/e2e-$t.mjs"; fi
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
done

echo
if [[ ${#failed[@]} -gt 0 ]]; then echo "FAILED: ${failed[*]}"; exit 1; fi
if [[ ${#skipped[@]} -gt 0 && "${E2E_ALLOW_SKIP:-}" != 1 ]]; then echo "SKIPPED (not allowed): ${skipped[*]}"; exit 1; fi
echo "All e2e suites passed${skipped:+ (skipped: ${skipped[*]})}"
