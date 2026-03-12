#!/usr/bin/env bash
# Reboot Remote — run pending migrations after an app update
# Usage: sudo bash deploy/scripts/setup-db.sh
set -euo pipefail

CONFIG_DIR=/etc/reboot-remote
INSTALL_DIR=/opt/reboot-remote/api

[[ $EUID -eq 0 ]] || { echo "Run as root: sudo $0"; exit 1; }
[[ -f "${CONFIG_DIR}/api.env" ]] || { echo "Not installed yet. Run install.sh first."; exit 1; }

set -a; source "${CONFIG_DIR}/api.env"; set +a

echo "[1/2] Running database migrations..."
cd "${INSTALL_DIR}"
npx prisma migrate deploy
npx prisma generate

echo "[2/2] Restarting API service..."
systemctl restart reboot-remote-api

echo "Done. Migration complete."
