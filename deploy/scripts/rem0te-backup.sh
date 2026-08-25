#!/usr/bin/env bash
#
# Rem0te backup — dumps Postgres + configuration + encryption keys into a
# single tar.gz. Restrictive permissions (0600) because the archive contains
# every RustDesk credential in encrypted form; decrypting them still requires
# the ENCRYPTION_KEY from api.env which is also in the archive, so treat this
# file as a full-system secret.
#
# Usage:
#   sudo rem0te-backup                                 # -> /var/backups/rem0te/rem0te-YYYYMMDD-HHMMSS.tar.gz
#   sudo rem0te-backup /path/to/backup.tar.gz          # explicit output path
#
set -euo pipefail

DEFAULT_DIR=/var/backups/rem0te
OUT="${1:-}"
if [[ -z "$OUT" ]]; then
  mkdir -p "$DEFAULT_DIR"
  chmod 700 "$DEFAULT_DIR"
  OUT="$DEFAULT_DIR/rem0te-$(date +%Y%m%d-%H%M%S).tar.gz"
fi

# Config file — we source it (as root) to get DATABASE_URL for pg_dump.
CONFIG_DIR=/etc/reboot-remote
ENV_FILE="$CONFIG_DIR/api.env"
[[ -f "$ENV_FILE" ]] || { echo "ERROR: $ENV_FILE not found" >&2; exit 1; }

# Load DATABASE_URL without leaking other secrets into the env
DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
[[ -n "$DATABASE_URL" ]] || { echo "ERROR: DATABASE_URL missing in $ENV_FILE" >&2; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "→ Dumping Postgres…"
PGPASSFILE=/dev/null pg_dump "$DATABASE_URL" --format=custom --no-owner --no-privileges \
  --file "$STAGE/postgres.dump"

echo "→ Capturing config…"
cp -a "$CONFIG_DIR" "$STAGE/config"

# RustDesk hbbs keys — recovery of a Rem0te install requires these too.
if [[ -f /var/lib/rustdesk-server/id_ed25519 ]]; then
  mkdir -p "$STAGE/rustdesk-keys"
  cp -a /var/lib/rustdesk-server/id_ed25519     "$STAGE/rustdesk-keys/"
  cp -a /var/lib/rustdesk-server/id_ed25519.pub "$STAGE/rustdesk-keys/"
fi

# Version marker so the restore script can refuse mismatched archives.
if [[ -f /opt/reboot-remote/version.json ]]; then
  cp /opt/reboot-remote/version.json "$STAGE/version.json"
fi

cat > "$STAGE/MANIFEST.txt" <<EOF
Rem0te backup
created:     $(date -Iseconds)
hostname:    $(hostname)
version:     $(cat /opt/reboot-remote/version.json 2>/dev/null | head -1 || echo unknown)
components:
  postgres.dump           full pg_dump (custom format)
  config/                 /etc/reboot-remote — api.env, secrets, TLS
  rustdesk-keys/          hbbs id_ed25519 keypair
  version.json            marker
EOF

echo "→ Packing $OUT"
tar czf "$OUT" -C "$STAGE" .
chmod 600 "$OUT"
echo "✓ Wrote $OUT ($(du -h "$OUT" | cut -f1))"
