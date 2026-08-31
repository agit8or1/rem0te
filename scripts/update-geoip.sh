#!/usr/bin/env bash
# Install or refresh the GeoIP database used by the dashboard map.
#
# DB-IP City Lite: free, no licence key, refreshed monthly, CC BY 4.0.
# The file is ~124 MB and deliberately NOT in the repository.
#
# Falls back to the previous month: the current month's build is published a
# little after the 1st, so a run on the 1st would otherwise 404 and leave the
# map blank.
set -euo pipefail

DEST="${GEOIP_DB_PATH:-/opt/reboot-remote/data/geoip/dbip-city-lite.mmdb}"
DIR="$(dirname "$DEST")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

try_month() {
  local m="$1"
  local url="https://download.db-ip.com/free/dbip-city-lite-${m}.mmdb.gz"
  echo "  trying ${m}…"
  curl -fsS -o "$TMP/db.mmdb.gz" "$url" 2>/dev/null
}

echo "Fetching DB-IP City Lite…"
if ! try_month "$(date -u +%Y-%m)"; then
  if ! try_month "$(date -u -d '1 month ago' +%Y-%m)"; then
    echo "ERROR: could not download the database for this month or last." >&2
    exit 1
  fi
fi

gunzip -f "$TMP/db.mmdb.gz"
mkdir -p "$DIR"
# Move into place atomically so a running API never reads a half-written file.
mv "$TMP/db.mmdb" "$DEST.new"
mv "$DEST.new" "$DEST"
chown reboot:reboot "$DEST" 2>/dev/null || true
echo "Installed $(du -h "$DEST" | cut -f1) at $DEST"
echo "Restart the API to load it: systemctl restart reboot-remote-api"
