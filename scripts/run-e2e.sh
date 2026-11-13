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
# signed-release (0.37) needs Go itself and is skipped the same way without it.
#
# RELEASE_BIN and ACTION_SIM (built from tools/windows-installer) enable the
# suites that drive the Windows agent's decision code; without them those
# suites are reported as SKIPPED and the run fails — set E2E_ALLOW_SKIP=1 to
# accept that (never in CI). script-run also needs pwsh (PWSH, or on PATH).
#
# The browser suite (apps/web/scripts/e2e-ui.mjs, 0.34) is not run from here: it
# needs a web build and Playwright's browser, and CI runs it as its own step
# after this one, against the same database.
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
# The patch-policy sweep proposes plans for every active policy in the
# database. Off for every suite but the one that tests it (which turns it on
# for its own API).
export PATCH_POLICY_SWEEP=off
# Likewise the metric roll-up and retention sweep (0.33); the metric-history
# suite turns it on for its own API.
export METRIC_SWEEP=off
# And the data-retention sweep (0.34), which removes aged rows from the whole
# database: other suites' fixtures included. The retention suite turns it on
# for its own API.
export RETENTION_SWEEP=off
# And the scheduled-report sweep (0.34), which mails every due schedule in the
# database; the email suite turns it on for its own API.
export REPORT_SCHEDULE_SWEEP=off
# Chat (0.34): the retention sweep deletes ended transcripts. e2e-chat turns
# it on for its own API, with its own fixtures.
export CHAT_RETENTION_SWEEP=off
# And the script-output prune (0.34), which deletes every run's output past
# its age. The monitoring and client-update sweeps are deliberately NOT
# exported off here: the monitoring and ticket-workflow suites rely on the
# monitoring sweep's default (on, at MONITOR_SWEEP_SECONDS) for their own API,
# and every other suite that starts an API turns them off itself. Scratch APIs
# below get both off explicitly.
export SCRIPT_OUTPUT_SWEEP=off
# Automatic snapshots (0.35) stage a run on every heartbeat that finds a
# computer's process list, service list or network adapters stale — in every
# suite that heartbeats a current Windows agent, which would hand those
# suites runs they did not ask for. e2e-auto-snapshots turns it on for its
# own API.
export SNAPSHOT_SWEEP=off
# Automatic agent self-update (0.36) hands reinstallAgent to every outdated
# Windows heartbeat — in every suite that heartbeats an old agent version,
# which would hand those suites flags they did not ask for.
# e2e-agent-auto-update turns it on for its own API.
export AGENT_AUTO_UPDATE=off
# The tray sweep (0.36) deletes expired one-time chat codes and /assist
# sessions, prunes old self-help runs and fails runs never reported on.
# e2e-tray runs its own API with it off and drives every expiry itself.
export TRAY_SWEEP=off
# Automatic migration to the signed agent (0.37) asks standard Windows agents
# to migrate as soon as a signed agent is published — in every suite that
# publishes one and heartbeats a standard agent, which would hand those
# suites migration nonces they did not ask for. e2e-auto-migration turns it
# on for its own API.
export AUTO_MIGRATION_SWEEP=off
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
for t in credentials security-features presets monitoring integration dashboard diagnostics-catalog system-inventory device-list endpoint-visibility device-views dynamic-groups add-device auto-updates group-policies reports script-library linux-agent macos-agent enrol-stepup search metric-history retention presence-cache ai-timeline email chat tray polish auto-snapshots agent-health agent-auto-update; do run "$t" node "scripts/e2e-$t.mjs"; done
for t in containment approved-action staged-patching maintenance-actions patch-policies software-deploy signed-updates ticket-workflow agent-upgrade auto-migration; do
  if [[ -n "${RELEASE_BIN:-}" && -n "${ACTION_SIM:-}" ]]; then run "$t" node "scripts/e2e-$t.mjs"
  else printf '%-22s SKIPPED (RELEASE_BIN / ACTION_SIM not set)\n' "$t"; skipped+=("$t"); fi
done
# Script runs (0.34) also need real PowerShell: PowerShell 7 (pwsh) runs the
# script under the agent's decision code. PWSH, or pwsh on PATH (the CI image has it).
if [[ -n "${RELEASE_BIN:-}" && -n "${ACTION_SIM:-}" ]] && { [[ -n "${PWSH:-}" ]] || command -v pwsh >/dev/null; }; then run script-run node scripts/e2e-script-run.mjs
else printf '%-22s SKIPPED (RELEASE_BIN / ACTION_SIM / pwsh not available)\n' script-run; skipped+=(script-run); fi
# Signed revocation (0.36) runs scripts under the agent too, so it needs the same three.
if [[ -n "${RELEASE_BIN:-}" && -n "${ACTION_SIM:-}" ]] && { [[ -n "${PWSH:-}" ]] || command -v pwsh >/dev/null; }; then run revocation node scripts/e2e-revocation.mjs
else printf '%-22s SKIPPED (RELEASE_BIN / ACTION_SIM / pwsh not available)\n' revocation; skipped+=(revocation); fi

# Signed releases on one host (0.37) run deploy/release/ in a temporary prefix
# and build the agent with Go themselves: they need Go (GO, go on PATH, or
# /usr/local/go/bin/go), not RELEASE_BIN.
if [[ -n "${GO:-}" && -x "${GO:-}" ]] || command -v go >/dev/null || [[ -x /usr/local/go/bin/go ]]; then run signed-release node scripts/e2e-signed-release.mjs
else printf '%-22s SKIPPED (Go not available)\n' signed-release; skipped+=(signed-release); fi

echo "── suites against a scratch API (one API per suite: the login throttle is per process)"
PORT="${E2E_API_PORT:-3101}"
export API_BASE="http://127.0.0.1:$PORT/api/v1" FRONTEND_URL="http://scratch.example.com:3100"
for t in smoke full business-access offboarding public-api public-address rollouts security-audit session-mutations support-requests sso-passkeys candidate-password secreg; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then echo "port $PORT is busy" >&2; exit 1; fi
  # Empty the log before the API starts. The `>` below runs in the background
  # job, so the readiness grep can read the file before it is truncated; with
  # an E2E_OUT left over from an earlier run it then finds that run's
  # "listening on" and starts the suite before this API listens (0.36: full and
  # offboarding failed "fetch failed" this way on a re-run).
  : > "$OUT/api-$t.log"
  env PORT=$PORT HBBS_PRESENCE_HOST=127.0.0.2 OIDC_ALLOW_INSECURE_LOOPBACK=true PUBLIC_API_URL="http://scratch.example.com:$PORT" \
    JWT_SECRET="$(openssl rand -hex 32)" LAUNCHER_TOKEN_SECRET="$(openssl rand -hex 32)" MONITOR_SWEEP=off CLIENT_UPDATE_SWEEP=off PATCH_POLICY_SWEEP=off METRIC_SWEEP=off RETENTION_SWEEP=off REPORT_SCHEDULE_SWEEP=off CHAT_RETENTION_SWEEP=off TRAY_SWEEP=off SCRIPT_OUTPUT_SWEEP=off AUTO_MIGRATION_SWEEP=off \
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
