#!/usr/bin/env bash
#
# Rem0te restore. Refuses to run unless you pass --i-mean-it because it will
# overwrite the current Postgres database and /etc/reboot-remote configuration.
#
# Usage:
#   sudo rem0te-restore /var/backups/rem0te/rem0te-YYYYMMDD-HHMMSS.tar.gz --i-mean-it
#
set -euo pipefail

ARCHIVE="${1:-}"
CONFIRM="${2:-}"
[[ -f "$ARCHIVE" ]] || { echo "usage: $0 <backup.tar.gz> --i-mean-it" >&2; exit 1; }
[[ "$CONFIRM" == "--i-mean-it" ]] || { echo "refusing without --i-mean-it (this OVERWRITES the current install)" >&2; exit 2; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "→ Extracting…"
tar xzf "$ARCHIVE" -C "$STAGE"
[[ -f "$STAGE/postgres.dump" ]] || { echo "not a Rem0te backup (postgres.dump missing)" >&2; exit 3; }
[[ -d "$STAGE/config" ]]        || { echo "not a Rem0te backup (config/ missing)" >&2; exit 3; }

if [[ -f "$STAGE/version.json" && -f /opt/reboot-remote/version.json ]]; then
  A="$(grep -oE '"version"\s*:\s*"[^"]+"' "$STAGE/version.json" | head -1)"
  B="$(grep -oE '"version"\s*:\s*"[^"]+"' /opt/reboot-remote/version.json | head -1)"
  echo "  archive version: $A"
  echo "  installed:       $B"
  if [[ "$A" != "$B" ]]; then
    echo "  ⚠ version mismatch — restoring anyway (migrations may or may not apply)"
  fi
fi

echo "→ Stopping services…"
systemctl stop reboot-remote-api reboot-remote-web || true

echo "→ Restoring config to /etc/reboot-remote…"
cp -a --backup=numbered /etc/reboot-remote /etc/reboot-remote.bak.$(date +%s) 2>/dev/null || true
rm -rf /etc/reboot-remote
cp -a "$STAGE/config" /etc/reboot-remote
chmod 700 /etc/reboot-remote
chmod 600 /etc/reboot-remote/*.env 2>/dev/null || true

# Extract DATABASE_URL for pg_restore.
DATABASE_URL="$(grep -E '^DATABASE_URL=' /etc/reboot-remote/api.env | head -1 | cut -d= -f2-)"
[[ -n "$DATABASE_URL" ]] || { echo "restored api.env has no DATABASE_URL" >&2; exit 4; }

echo "→ Restoring Postgres…"
# Drop existing objects and load. --clean --if-exists to survive partial restore
pg_restore --clean --if-exists --no-owner --no-privileges --dbname "$DATABASE_URL" "$STAGE/postgres.dump"

if [[ -d "$STAGE/rustdesk-keys" ]]; then
  echo "→ Restoring hbbs keypair…"
  install -m 600 "$STAGE/rustdesk-keys/id_ed25519"     /var/lib/rustdesk-server/
  install -m 644 "$STAGE/rustdesk-keys/id_ed25519.pub" /var/lib/rustdesk-server/
  chown -R root:root /var/lib/rustdesk-server/id_ed25519*
  systemctl restart rustdesk-hbbs rustdesk-hbbr || true
fi

echo "→ Starting services…"
systemctl start reboot-remote-api reboot-remote-web
sleep 3
curl -sf http://127.0.0.1:3001/api/v1/public/rustdesk-config -o /dev/null && \
  echo "✓ API healthy" || echo "⚠ API did not respond — check journalctl -u reboot-remote-api"
