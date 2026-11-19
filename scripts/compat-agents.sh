#!/usr/bin/env bash
# Older released signed agents against the server under test (0.68.2).
#
#   DATABASE_URL=postgresql://…/<name containing scratch|test> scripts/compat-agents.sh v0.64.0
#
# Builds the agent's decision code (rem0te-action-sim) from the release tag,
# exactly as released, and runs the action suites of THIS checkout against
# THIS checkout's API and release tool. A supported version that fails is a
# broken release. The evidence is the simulator: the agent's real Go decision
# code against fake Windows services. It says nothing about real Windows
# (docs/lab-testing.md, docs/readiness.md).
set -uo pipefail
TAG="${1:?usage: compat-agents.sh <release tag>}"
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "not a release tag: $TAG" >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="${DATABASE_URL:-}"; name="${DB##*/}"; name="${name%%\?*}"
if [[ -z "$DB" || ! "$name" =~ (scratch|test) ]]; then
  echo "Refusing: DATABASE_URL must name a database containing 'scratch' or 'test' (got '${name:-unset}')." >&2; exit 2
fi
git -C "$ROOT" rev-parse -q --verify "refs/tags/$TAG" >/dev/null || { echo "tag $TAG not found (fetch tags first)" >&2; exit 2; }
OUT="${COMPAT_OUT:-$ROOT/.compat-logs}/$TAG"; mkdir -p "$OUT"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

echo "── build: rem0te-action-sim from $TAG, rem0te-release from HEAD"
git -C "$ROOT" archive "$TAG" tools/windows-installer | tar -x -C "$WORK" || exit 1
( cd "$WORK/tools/windows-installer" && go build -o "$WORK/sim" ./cmd/rem0te-action-sim ) || { echo "$TAG: the agent does not build" >&2; exit 1; }
( cd "$ROOT/tools/windows-installer" && go build -o "$WORK/release" ./cmd/rem0te-release ) || exit 1

export DATABASE_URL="$DB" I_KNOW_THIS_IS_NOT_PRODUCTION=1 NODE_ENV=test
for v in PATCH_POLICY_SWEEP METRIC_SWEEP RETENTION_SWEEP REPORT_SCHEDULE_SWEEP CHAT_RETENTION_SWEEP SCRIPT_OUTPUT_SWEEP \
         SNAPSHOT_SWEEP TRAY_SWEEP AUTO_MIGRATION_SWEEP WINGET_INDEX_SWEEP WARRANTY_SWEEP AUTOMATION_SWEEP RESTART_WINDOW_SWEEP SSO_SESSION_SWEEP; do
  export "$v=off"
done
export AGENT_AUTO_UPDATE=off
export ENCRYPTION_KEY="${ENCRYPTION_KEY:-$(openssl rand -hex 32)}"
export SEED_ADMIN_EMAIL="${SEED_ADMIN_EMAIL:-e2e-admin@example.com}" SEED_ADMIN_PASSWORD="${SEED_ADMIN_PASSWORD:-$(openssl rand -base64 18)}"
export RELEASE_BIN="$WORK/release" ACTION_SIM="$WORK/sim"
cd "$ROOT/apps/api"
npx prisma migrate deploy > "$OUT/migrate.log" 2>&1 || { cat "$OUT/migrate.log"; exit 1; }
RUSTDESK_RELAY_HOST=relay.scratch.example.com RUSTDESK_PUBLIC_KEY="$(openssl rand -base64 32)" \
  npx prisma db seed > "$OUT/seed.log" 2>&1 || { cat "$OUT/seed.log"; exit 1; }
node scripts/lib/confirm-asks.mjs > "$OUT/confirm-asks.log" 2>&1 || exit 1

mapfile -t SUITES < <(node -e 'for (const s of require(process.argv[1]).suites) console.log(s)' "$ROOT/scripts/compat/supported-agents.json")
mapfile -t KNOWN < <(node -e 'for (const k of require(process.argv[1]).knownIncompatible.filter((k) => k.tag === process.argv[2])) console.log(k.suite)' "$ROOT/scripts/compat/supported-agents.json" "$TAG")
failed=(); results=()
for s in "${SUITES[@]}"; do
  timeout 900 node "scripts/e2e-$s.mjs" > "$OUT/$s.log" 2>&1; rc=$?
  line="$(grep -aE '[0-9]+ passed' "$OUT/$s.log" | sed 's/\x1b\[[0-9;]*m//g' | tail -1 | sed 's/✓//; s/^ *//')"
  known=0; for k in "${KNOWN[@]:-}"; do [[ "$k" == "$s" ]] && known=1; done
  printf '%-22s exit %-3s %s%s\n' "$s" "$rc" "$line" "$([[ $known == 1 ]] && echo ' (known incompatible, documented)')"
  results+=("{\"suite\":\"$s\",\"exit\":$rc,\"summary\":\"$line\",\"knownIncompatible\":$([[ $known == 1 ]] && echo true || echo false)}")
  if [[ $rc -ne 0 && $known == 0 ]]; then failed+=("$s"); grep -a -A2 '✗' "$OUT/$s.log" | head -30 | sed 's/^/    /'; fi
done
server="$(node -p 'require(process.argv[1]).version' "$ROOT/version.json")"
printf '{"agentTag":"%s","server":"%s","serverCommit":"%s","evidence":"sim","suites":[%s]}\n' \
  "$TAG" "$server" "$(git -C "$ROOT" rev-parse HEAD)" "$(IFS=,; echo "${results[*]}")" > "$OUT/evidence.json"
if [[ ${#failed[@]} -gt 0 ]]; then echo "FAILED: agent $TAG against server $server: ${failed[*]}"; exit 1; fi
echo "Agent $TAG works with server $server (simulator evidence)."
