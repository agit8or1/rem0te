# Rem0te — Setup Guide

This guide covers everything you need to go from a blank Ubuntu server to a fully running Rem0te instance.

---

## Requirements

| | Minimum | Recommended |
|---|---|---|
| **OS** | Ubuntu 22.04 / Debian 12 | Ubuntu 22.04 LTS |
| **RAM** | 1 GB | 2 GB |
| **CPU** | 1 vCPU | 2 vCPU |
| **Disk** | 10 GB | 20 GB |
| **Network** | Public IP | Domain name with DNS A record |

**Ports that must be open (firewall/security group):**

| Port | Protocol | Purpose |
|------|----------|---------|
| 80 | TCP | HTTP / Let's Encrypt challenge |
| 443 | TCP | HTTPS |
| 21115 | TCP | RustDesk NAT test |
| 21116 | TCP + UDP | RustDesk ID server (hbbs) |
| 21117 | TCP | RustDesk relay (hbbr) |
| 21118–21119 | TCP | RustDesk websocket (optional) |

> **Domain vs IP address:** Using a domain name is strongly recommended — you get automatic HTTPS via Let's Encrypt. Bare IP addresses work but use plain HTTP.

---

## Automated Installation (recommended)

The install script sets up everything in one shot: Node.js, PostgreSQL, Redis, RustDesk server, Caddy reverse proxy, fail2ban, systemd services, and Rem0te itself.

```bash
# 1. Clone the repo
git clone https://github.com/agit8or1/rem0te
cd rem0te

# 2. Run the installer
sudo bash deploy/scripts/install.sh your-domain.example.com admin@example.com
```

Replace `your-domain.example.com` with your actual domain (DNS must already point to this server). The email is for your platform admin account — if omitted it defaults to `admin@your-domain`.

**The installer will:**
- Install Node.js 20, pnpm, PostgreSQL, Redis, Caddy, fail2ban
- Download and install RustDesk server (`hbbs` + `hbbr`) and generate its keypair
- Generate random secrets (JWT, encryption key, DB password)
- Build the app from source
- Configure Caddy with automatic HTTPS
- Run database migrations and seed the initial admin account
- Start and enable all systemd services

At the end it prints your login URL and admin credentials — **save these immediately**.

---

## Post-Install: First Login

1. Open `https://your-domain.example.com` in a browser
2. Log in with the admin credentials printed by the installer
3. You're a **Platform Admin** — you can see the Admin panel in the left sidebar

### Connect Rem0te to RustDesk

The installer pre-configures the RustDesk relay host to your domain and sets the public key. You can verify or change these in **Settings → RustDesk**:

- **Relay Host** — your server's domain name (e.g. `remote.example.com`)
- **Public Key** — found in `/var/lib/rustdesk-server/id_ed25519.pub` on the server

Once set, the **Download** page (`/download`) will generate install scripts pre-configured for your server.

### Create your first tenant

1. Go to **Admin → Tenants** and create a tenant for your organisation
2. Inside that tenant, create technician users via **Access**
3. Enrol your first device from **Enrolled Clients → Generate Enrollment Link**

---

## Enrolling a Device

1. In the Rem0te web UI, go to **Enrolled Clients**
2. Click **Generate Enrollment Link** — fill in an optional description and customer name
3. Copy the **Windows installer (.exe)** URL (or the appropriate platform link)
4. Send that URL to the device — the user downloads and double-clicks it
5. One UAC prompt → installer runs → device appears in Enrolled Clients

The install script on the device:
- Downloads and silently installs RustDesk
- Configures it to connect to your server
- Sets a permanent device password (disables one-time rotating passwords)
- Registers the device with Rem0te automatically

---

## Updating Rem0te

From the web UI: **Admin → About & Updates → Check for Updates → Apply Update**

This fetches the latest release tag, rebuilds, and restarts services in-place with a live progress stream.

---

## Manual Installation

If you want to understand each step or run it on a non-standard setup:

### 1. System dependencies

```bash
apt-get update
apt-get install -y nodejs npm postgresql redis-server caddy fail2ban
npm install -g pnpm
```

Node.js 20+ is required. Install via [NodeSource](https://github.com/nodesource/distributions) if your distro ships an older version.

### 2. RustDesk server

```bash
# Download latest hbbs and hbbr .deb packages from:
# https://github.com/rustdesk/rustdesk-server/releases

dpkg -i rustdesk-server-hbbs_*.deb rustdesk-server-hbbr_*.deb
systemctl enable --now rustdesk-hbbs rustdesk-hbbr

# Get the generated public key (used in your .env)
cat /var/lib/rustdesk-server/id_ed25519.pub
```

### 3. Database

```bash
sudo -u postgres psql -c "CREATE USER reboot WITH PASSWORD 'your-password';"
sudo -u postgres psql -c "CREATE DATABASE reboot_remote OWNER reboot;"
```

### 4. Application

```bash
git clone https://github.com/agit8or1/rem0te
cd rem0te

# Install dependencies
pnpm install

# Configure API
cp apps/api/.env.example apps/api/.env
# Edit apps/api/.env — see the file for descriptions of each variable

# Build
pnpm --filter api build
pnpm --filter web build

# Database migrations
cd apps/api
npx prisma migrate deploy
npx prisma db seed
```

### 5. Systemd services

Copy the unit files from `deploy/systemd/` to `/etc/systemd/system/` and point them at the right paths.

The API reads its config from an env file (typically `/etc/reboot-remote/api.env`). Set `EnvironmentFile=` in the unit to point there.

### 6. Reverse proxy

See `deploy/caddy/` for a working Caddyfile, or adapt it for nginx/Traefik. The API runs on port 3001 and the web app on port 3000. Route `/api/*` to 3001 and everything else to 3000.

---

## Configuration Reference

All configuration is via environment variables. See `apps/api/.env.example` for a fully annotated example.

**Required variables:**

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Random secret for signing JWTs — min 32 chars |
| `LAUNCHER_TOKEN_SECRET` | Random secret for desktop launcher tokens |
| `ENCRYPTION_KEY` | 64 hex chars (32 bytes) for AES-256-GCM — encrypts TOTP secrets |
| `FRONTEND_URL` | Public URL of the web app (e.g. `https://remote.example.com`) |
| `PUBLIC_API_URL` | Public URL of the API — usually same as `FRONTEND_URL` |

Generate secrets with:
```bash
openssl rand -hex 32   # for JWT_SECRET, LAUNCHER_TOKEN_SECRET
openssl rand -hex 32   # for ENCRYPTION_KEY (must be exactly 64 hex chars)
```

---

## Firewall (ufw)

```bash
ufw allow 22/tcp        # SSH
ufw allow 80/tcp        # HTTP
ufw allow 443/tcp       # HTTPS
ufw allow 21115/tcp     # RustDesk
ufw allow 21116/tcp
ufw allow 21116/udp
ufw allow 21117/tcp
ufw enable
```

---

## Troubleshooting

**Services not starting:**
```bash
journalctl -u reboot-remote-api -n 50
journalctl -u reboot-remote-web -n 50
```

**Database connection errors:**
```bash
# Verify DATABASE_URL is correct in /etc/reboot-remote/api.env
sudo -u postgres psql -c "\l"   # list databases
```

**RustDesk clients can't connect:**
- Confirm ports 21115–21117 are open in your firewall and cloud security group
- Confirm the relay host and public key in Rem0te Settings → RustDesk match the server
- Check `systemctl status rustdesk-hbbs rustdesk-hbbr`

**Reset admin password:**
```bash
# Generate a new argon2 hash
node -e "require('argon2').hash('NewPassword123').then(h => console.log(h))"

# Update in database
sudo -u postgres psql reboot_remote -c \
  "UPDATE \"User\" SET password = 'HASH' WHERE email = 'admin@example.com';"
```

---

## Directory Layout (production)

```
/opt/reboot-remote/
  api/         API build (dist/ + node_modules)
  web/         Web app (Next.js standalone)
  dist/        Shared assets (windows-installer.exe)
  version.json Current version info

/etc/reboot-remote/
  api.env      API environment (secrets — mode 600)
  web.env      Web environment

/var/log/reboot-remote/
  api.log
  web.log

/var/lib/rustdesk-server/
  id_ed25519      RustDesk private key
  id_ed25519.pub  RustDesk public key
```
