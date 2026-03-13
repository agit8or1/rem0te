#!/usr/bin/env bash
# Reboot Remote — fully automated installer
# Usage: sudo bash deploy/scripts/install.sh <domain> [admin@email.com]
# Example: sudo bash deploy/scripts/install.sh remote.example.com admin@example.com
#
# Tested on Ubuntu 22.04 / Debian 12
set -euo pipefail

# ─── Arguments ───────────────────────────────────────────────────────────────
DOMAIN="${1:-}"
ADMIN_EMAIL="${2:-}"

[[ $EUID -eq 0 ]] || { echo "Run as root: sudo $0 <domain> [admin@email]"; exit 1; }
[[ -n "${DOMAIN}" ]] || { echo "Usage: sudo $0 <domain> [admin@email]"; exit 1; }

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
INSTALL_DIR=/opt/reboot-remote
CONFIG_DIR=/etc/reboot-remote
LOG_DIR=/var/log/reboot-remote

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()    { echo -e "${GREEN}[INFO]${NC} $*"; }
step()    { echo -e "${CYAN}[STEP]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# Detect IP address vs domain name — IPs use plain HTTP
if [[ "${DOMAIN}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  SCHEME="http"
  COOKIE_SECURE="false"
  info "IP address detected — using plain HTTP (no TLS)"
else
  SCHEME="https"
  COOKIE_SECURE="true"
fi

echo -e "${CYAN}"
echo "  ██████╗ ███████╗██████╗  ██████╗  ██████╗ ████████╗"
echo "  ██╔══██╗██╔════╝██╔══██╗██╔═══██╗██╔═══██╗╚══██╔══╝"
echo "  ██████╔╝█████╗  ██████╔╝██║   ██║██║   ██║   ██║   "
echo "  ██╔══██╗██╔══╝  ██╔══██╗██║   ██║██║   ██║   ██║   "
echo "  ██║  ██║███████╗██████╔╝╚██████╔╝╚██████╔╝   ██║   "
echo "  ╚═╝  ╚═╝╚══════╝╚═════╝  ╚═════╝  ╚═════╝    ╚═╝   "
echo -e "${NC}"
info "Installing Reboot Remote on domain: ${DOMAIN}"
[[ -n "${ADMIN_EMAIL}" ]] && info "Admin email: ${ADMIN_EMAIL}"
echo ""

# ─── System packages ─────────────────────────────────────────────────────────
step "Installing system packages…"
apt-get update -qq
apt-get install -y -qq \
  curl wget gnupg ca-certificates \
  build-essential git \
  postgresql postgresql-contrib \
  redis-server \
  fail2ban \
  debian-keyring debian-archive-keyring apt-transport-https

# ─── Node.js 20 ──────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d 'v')" -lt 20 ]]; then
  step "Installing Node.js 20…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
else
  info "Node.js $(node -v) already installed."
fi

# ─── pnpm ────────────────────────────────────────────────────────────────────
if ! command -v pnpm &>/dev/null; then
  step "Installing pnpm…"
  npm install -g pnpm
else
  info "pnpm $(pnpm -v) already installed."
fi

# ─── RustDesk Server ─────────────────────────────────────────────────────────
step "Installing RustDesk Server (hbbs + hbbr)…"
RUSTDESK_DATA="/var/lib/rustdesk-server"

if ! command -v hbbs &>/dev/null; then
  RUSTDESK_VERSION=$(curl -s https://api.github.com/repos/rustdesk/rustdesk-server/releases/latest \
    | grep '"tag_name"' | head -1 | cut -d'"' -f4)
  RUSTDESK_VERSION="${RUSTDESK_VERSION:-1.1.15}"

  ARCH="amd64"
  [[ "$(uname -m)" == "aarch64" ]] && ARCH="arm64"

  info "Downloading rustdesk-server v${RUSTDESK_VERSION} (.deb)…"
  wget -q -O /tmp/rustdesk-hbbs.deb \
    "https://github.com/rustdesk/rustdesk-server/releases/download/${RUSTDESK_VERSION}/rustdesk-server-hbbs_${RUSTDESK_VERSION}_${ARCH}.deb"
  wget -q -O /tmp/rustdesk-hbbr.deb \
    "https://github.com/rustdesk/rustdesk-server/releases/download/${RUSTDESK_VERSION}/rustdesk-server-hbbr_${RUSTDESK_VERSION}_${ARCH}.deb"

  DEBIAN_FRONTEND=noninteractive dpkg -i /tmp/rustdesk-hbbs.deb /tmp/rustdesk-hbbr.deb
  rm -f /tmp/rustdesk-hbbs.deb /tmp/rustdesk-hbbr.deb
else
  info "RustDesk server already installed ($(hbbs --version 2>/dev/null || echo 'unknown version'))."
fi

# Start hbbs briefly to generate keypair if not already generated
if [[ ! -f "${RUSTDESK_DATA}/id_ed25519.pub" ]]; then
  info "Generating RustDesk keypair…"
  systemctl start rustdesk-hbbs
  sleep 4
fi

RUSTDESK_PUBLIC_KEY=""
if [[ -f "${RUSTDESK_DATA}/id_ed25519.pub" ]]; then
  RUSTDESK_PUBLIC_KEY=$(cat "${RUSTDESK_DATA}/id_ed25519.pub")
  info "RustDesk public key: ${RUSTDESK_PUBLIC_KEY}"
fi

systemctl enable rustdesk-hbbs rustdesk-hbbr
systemctl start rustdesk-hbbs rustdesk-hbbr || true

# ─── Caddy ───────────────────────────────────────────────────────────────────
if ! command -v caddy &>/dev/null; then
  step "Installing Caddy…"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y caddy
else
  info "Caddy $(caddy version) already installed."
fi

# ─── System user ─────────────────────────────────────────────────────────────
if ! id reboot &>/dev/null; then
  step "Creating system user 'reboot'…"
  useradd --system --no-create-home --shell /bin/false reboot
fi

# ─── Directories ─────────────────────────────────────────────────────────────
step "Creating directories…"
mkdir -p "${INSTALL_DIR}/api" "${INSTALL_DIR}/web"
mkdir -p "${CONFIG_DIR}"
mkdir -p "${LOG_DIR}"
chmod 750 "${CONFIG_DIR}"

# ─── PostgreSQL ───────────────────────────────────────────────────────────────
step "Configuring PostgreSQL…"
systemctl enable --now postgresql

DB_PASSWORD=$(openssl rand -hex 32)
sudo -u postgres psql -c "CREATE USER reboot WITH PASSWORD '${DB_PASSWORD}';" 2>/dev/null || \
  sudo -u postgres psql -c "ALTER USER reboot WITH PASSWORD '${DB_PASSWORD}';"
sudo -u postgres psql -c "CREATE DATABASE reboot_remote OWNER reboot;" 2>/dev/null || \
  warn "Database reboot_remote already exists, skipping creation."

# ─── Redis ───────────────────────────────────────────────────────────────────
step "Configuring Redis…"
systemctl enable --now redis-server

# ─── Generate secrets ────────────────────────────────────────────────────────
step "Generating application secrets…"
JWT_SECRET=$(openssl rand -hex 32)
LAUNCHER_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)
ADMIN_PASSWORD=$(openssl rand -base64 16 | tr -d '/')

# Use provided admin email or derive one from domain
if [[ -z "${ADMIN_EMAIL}" ]]; then
  ADMIN_EMAIL="admin@${DOMAIN}"
fi

# ─── Write environment files ──────────────────────────────────────────────────
step "Writing configuration files…"
cat > "${CONFIG_DIR}/api.env" << EOF
NODE_ENV=production
PORT=3001
FRONTEND_URL=${SCHEME}://${DOMAIN}
PUBLIC_API_URL=${SCHEME}://${DOMAIN}
DATABASE_URL=postgresql://reboot:${DB_PASSWORD}@localhost:5432/reboot_remote
REDIS_URL=redis://localhost:6379
JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=8h
LAUNCHER_TOKEN_SECRET=${LAUNCHER_SECRET}
ENCRYPTION_KEY=${ENCRYPTION_KEY}
COOKIE_SECURE=${COOKIE_SECURE}
SEED_ADMIN_EMAIL=${ADMIN_EMAIL}
SEED_ADMIN_PASSWORD=${ADMIN_PASSWORD}
VERSION_FILE=${INSTALL_DIR}/version.json
PROJECT_ROOT=${INSTALL_DIR}
EOF
chmod 600 "${CONFIG_DIR}/api.env"

cat > "${CONFIG_DIR}/web.env" << EOF
NODE_ENV=production
PORT=3000
NEXT_PUBLIC_API_URL=${SCHEME}://${DOMAIN}
EOF
chmod 600 "${CONFIG_DIR}/web.env"

# ─── Caddyfile ───────────────────────────────────────────────────────────────
step "Configuring Caddy for ${DOMAIN}…"
[[ -f /etc/caddy/Caddyfile ]] && \
  cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak 2>/dev/null || true

if [[ "${SCHEME}" == "http" ]]; then
  # Plain HTTP for IP-based installs (no TLS)
  cat > /etc/caddy/Caddyfile << EOF
http://${DOMAIN} {
    handle /api/* {
        reverse_proxy localhost:3001 {
            transport http {
                response_header_timeout 300s
            }
        }
    }

    handle /* {
        reverse_proxy localhost:3000 {
            header_up Host {http.request.header.host}
        }
    }

    header {
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        -Server
    }

    encode gzip

    log {
        output file /var/log/caddy/reboot-remote.log
        format json
    }
}
EOF
else
  # HTTPS with automatic TLS via Let's Encrypt
  # Also serve plain HTTP on the IP for LAN access
  SERVER_IP=$(hostname -I | awk '{print $1}')
  cat > /etc/caddy/Caddyfile << EOF
# LAN access via IP (plain HTTP)
http://${SERVER_IP} {
    handle /api/* {
        reverse_proxy localhost:3001 {
            transport http {
                response_header_timeout 300s
            }
        }
    }

    handle /* {
        reverse_proxy localhost:3000 {
            header_up Host {http.request.header.host}
        }
    }

    encode gzip

    log {
        output file /var/log/caddy/reboot-remote.log
        format json
    }
}

# External access via domain (HTTPS with auto TLS)
${DOMAIN} {
    handle /api/* {
        reverse_proxy localhost:3001 {
            transport http {
                response_header_timeout 300s
            }
        }
    }

    handle /* {
        reverse_proxy localhost:3000 {
            header_up Host {http.request.header.host}
        }
    }

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        Referrer-Policy strict-origin-when-cross-origin
        -Server
    }

    encode gzip

    log {
        output file /var/log/caddy/reboot-remote.log
        format json
    }
}
EOF
fi

# ─── fail2ban ─────────────────────────────────────────────────────────────────
step "Configuring fail2ban for HTTP login protection…"

# Filter: watch Caddy JSON access log for repeated 401/429 on the login endpoint
mkdir -p /etc/fail2ban/filter.d
cat > /etc/fail2ban/filter.d/reboot-remote.conf << 'EOF'
[Definition]
failregex = "remote_ip":"<HOST>".*"uri":"/api/v[0-9]+/auth/login".*"status":(401|429)
            "remote_ip":"<HOST>".*"status":(401|429).*"uri":"/api/v[0-9]+/auth/login"
ignoreregex =
datepattern = "ts":%%s\.%%f
              "ts":%%s
EOF

# Jail: ban IPs that fail login 5 times in 5 minutes for 1 hour
cat > /etc/fail2ban/jail.d/reboot-remote.conf << 'EOF'
[reboot-remote]
enabled  = true
filter   = reboot-remote
logpath  = /var/log/caddy/reboot-remote.log
maxretry = 5
findtime = 300
bantime  = 3600
action   = iptables-multiport[name=reboot-remote, port="80,443", protocol=tcp]
EOF

systemctl enable fail2ban
systemctl restart fail2ban || true

# ─── Build application from source ───────────────────────────────────────────
step "Installing dependencies…"
cd "${REPO_DIR}"
pnpm install --no-frozen-lockfile

step "Generating Prisma client…"
cd "${REPO_DIR}/apps/api"
npx prisma generate
cd "${REPO_DIR}"

step "Building API…"
pnpm --filter api build

step "Building Web…"
# Inject public env var at build time
INTERNAL_API_URL="http://localhost:3001" pnpm --filter @reboot-remote/web build

# ─── Deploy built artifacts ───────────────────────────────────────────────────
step "Deploying API to ${INSTALL_DIR}/api…"
rsync -a --delete \
  "${REPO_DIR}/apps/api/dist/" \
  "${INSTALL_DIR}/api/dist/"
rsync -a --delete \
  "${REPO_DIR}/apps/api/prisma/" \
  "${INSTALL_DIR}/api/prisma/"
cp "${REPO_DIR}/apps/api/package.json" "${INSTALL_DIR}/api/"
cp "${REPO_DIR}/apps/api/tsconfig.json" "${INSTALL_DIR}/api/" 2>/dev/null || true
cp "${REPO_DIR}/version.json" "${INSTALL_DIR}/version.json"

# Install production-only node_modules for API
cd "${INSTALL_DIR}/api"
npm install --omit=dev --quiet
# Also need prisma cli for migrations
npm install prisma --save-dev --quiet

step "Deploying Web to ${INSTALL_DIR}/web…"
# Next.js monorepo standalone output: preserve full directory structure
# so that pnpm symlinks (relative paths) remain valid
rm -rf "${INSTALL_DIR}/web"
mkdir -p "${INSTALL_DIR}/web"
rsync -a --delete \
  "${REPO_DIR}/apps/web/.next/standalone/" \
  "${INSTALL_DIR}/web/standalone/"
# Copy static assets into the nested app's .next dir
mkdir -p "${INSTALL_DIR}/web/standalone/apps/web/.next/static"
rsync -a --delete \
  "${REPO_DIR}/apps/web/.next/static/" \
  "${INSTALL_DIR}/web/standalone/apps/web/.next/static/"
# Copy public dir if it exists
if [ -d "${REPO_DIR}/apps/web/public" ]; then
  rsync -a --delete \
    "${REPO_DIR}/apps/web/public/" \
    "${INSTALL_DIR}/web/standalone/apps/web/public/"
fi
# No npm install needed — standalone bundles its own node_modules

# ─── Permissions ─────────────────────────────────────────────────────────────
chown -R reboot:reboot "${INSTALL_DIR}" "${LOG_DIR}"

# ─── systemd units ───────────────────────────────────────────────────────────
step "Installing systemd units…"
cp "${REPO_DIR}/deploy/systemd/"*.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable reboot-remote-api reboot-remote-web caddy

# ─── sudoers ─────────────────────────────────────────────────────────────────
step "Configuring sudoers for service management…"
cat > /etc/sudoers.d/reboot-remote << 'EOF'
# Reboot Remote - allow reboot user to run security management commands
reboot ALL=(ALL) NOPASSWD: /usr/bin/fail2ban-client
reboot ALL=(ALL) NOPASSWD: /usr/bin/apt-get update *
reboot ALL=(ALL) NOPASSWD: /usr/bin/apt-get upgrade *
reboot ALL=(ALL) NOPASSWD: /usr/bin/apt-get install -y fail2ban
reboot ALL=(ALL) NOPASSWD: /usr/bin/systemctl enable fail2ban
reboot ALL=(ALL) NOPASSWD: /usr/bin/systemctl start fail2ban
reboot ALL=(ALL) NOPASSWD: /usr/bin/caddy reload *
reboot ALL=(ALL) NOPASSWD: /usr/bin/systemctl reload caddy
EOF
chmod 440 /etc/sudoers.d/reboot-remote

# ─── Database migrations & seed ───────────────────────────────────────────────
step "Running database migrations…"
cd "${INSTALL_DIR}/api"
# Load env for DATABASE_URL
set -a; source "${CONFIG_DIR}/api.env"; set +a
# Use db push for fresh installs (no migration files), migrate deploy when migrations exist
if [ -d "${INSTALL_DIR}/api/prisma/migrations" ] && [ -n "$(ls -A "${INSTALL_DIR}/api/prisma/migrations" 2>/dev/null)" ]; then
  npx prisma migrate deploy
else
  npx prisma db push --skip-generate
fi
npx prisma generate

step "Seeding database…"
# Use ts-node from source repo for seed (seed.ts needs TypeScript)
cd "${REPO_DIR}/apps/api"
set -a; source "${CONFIG_DIR}/api.env"; set +a
# Pass RustDesk relay info so the default tenant gets pre-configured
export RUSTDESK_RELAY_HOST="${DOMAIN}"
export RUSTDESK_PUBLIC_KEY="${RUSTDESK_PUBLIC_KEY:-}"
npx prisma db seed

# ─── Start services ───────────────────────────────────────────────────────────
step "Starting all services…"
systemctl start reboot-remote-api reboot-remote-web caddy

# Give services a moment to come up
sleep 3

# ─── Status ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Reboot Remote is running!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  URL:      ${CYAN}${SCHEME}://${DOMAIN}${NC}"
echo -e "  Email:    ${CYAN}${ADMIN_EMAIL}${NC}"
echo -e "  Password: ${CYAN}${ADMIN_PASSWORD}${NC}"
echo ""
echo -e "  ${YELLOW}Save these credentials — they will not be shown again.${NC}"
echo ""
echo "  Service status:"
systemctl is-active reboot-remote-api  && echo -e "    API       ${GREEN}●${NC} running" || echo -e "    API       ${RED}●${NC} failed"
systemctl is-active reboot-remote-web  && echo -e "    Web       ${GREEN}●${NC} running" || echo -e "    Web       ${RED}●${NC} failed"
systemctl is-active caddy              && echo -e "    Proxy     ${GREEN}●${NC} running" || echo -e "    Proxy     ${RED}●${NC} failed"
systemctl is-active rustdesk-hbbs      && echo -e "    RustDesk  ${GREEN}●${NC} running" || echo -e "    RustDesk  ${YELLOW}●${NC} not started"
echo ""
echo -e "  Credentials saved to: ${CONFIG_DIR}/api.env"
echo ""
