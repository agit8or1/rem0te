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

### Create your first business

The seed creates a Platform Admin — the Rem0te operator. Everything else hangs off a **Business**.

1. Sign in as the Platform Admin.
2. Go to **Businesses → Add Business** and create one for your first customer.
3. Open **Users → Add person**, choose that business, and create its **Business Owner**. Send them
   the one-time setup link that comes back.
4. That owner can now add **Business Users** and set exactly what each one can do.

See [access-control.md](access-control.md) for the three-level model and the permission list.

### Turn on Quick Connect (optional)

Quick Connect ships **off**. To enable temporary support sessions for machines that are not managed
devices:

1. **Settings → Quick Connect** → turn the master switch on and pick which client builds to offer.
2. Per business: **Businesses → [Business] → Overview → Quick Connect**.
3. Per person: grant **Use Quick Connect** on their permissions. Business Owners get it implicitly.

Then send anyone who needs help to `https://<your-host>/quick`.

---

## Enrolling a Device

1. Go to **Downloads** (or **Businesses → [Business] → Downloads**).
2. Pick the business the computer belongs to and who should be able to reach it, then generate the
   installer link. The binding is fixed at this point — the machine that runs it cannot choose a
   different business.
3. Copy the one-line install command (or the **Windows installer (.exe)** URL).
4. Send it to the device — the user runs it.
5. One UAC prompt → installer runs → the computer appears in that business.

The install script on the device:
- Downloads and silently installs RustDesk
- Configures it to connect to your server
- Sets a permanent device password (disables one-time rotating passwords)
- Registers the device with Rem0te automatically

---

## Updating Rem0te

### Deploying a build by hand

```bash
pnpm build
cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static

sudo rsync -a --delete --exclude 'apps/web/.next/static/' \
  apps/web/.next/standalone/ /opt/reboot-remote/web/standalone/
sudo rsync -a \
  apps/web/.next/static/ /opt/reboot-remote/web/standalone/apps/web/.next/static/

sudo rsync -a --delete apps/api/dist/ /opt/reboot-remote/api/dist/
sudo cp version.json CHANGELOG.md /opt/reboot-remote/
sudo systemctl restart reboot-remote-api reboot-remote-web
```

Note the `--exclude` on the first rsync and the missing `--delete` on the
second. Next.js requests client chunks by content hash, and a browser that
already has the app open is still asking for the **previous** build's
filenames. Deleting them mid-deploy 404s every running client, which shows up
as pages reloading themselves or bouncing back to the login screen. New builds
produce new hashes, so old files just go unreferenced — prune them during a
maintenance window, not on every deploy.

After a schema change, regenerate the deployed Prisma client too:

```bash
sudo -u reboot bash -c 'cd /opt/reboot-remote/api && ./node_modules/.bin/prisma generate'
```

### In-app updates are off by default

Applying an update means the server checks out and builds code fetched from
GitHub — supply-chain-critical, so it is opt-in:

```bash
# /etc/reboot-remote/api.env
ALLOW_IN_APP_UPDATE=true
SOURCE_DIR=/srv/rem0te-src      # a git clone the service account can write
```

`SOURCE_DIR` is **not** `PROJECT_ROOT`. `PROJECT_ROOT` (`/opt/reboot-remote`)
is the deploy target — build output, `version.json`, uploads — and is
deliberately not a git repository. Without `SOURCE_DIR` the About page reports
that in-app updates are unavailable, and why, rather than offering a button
that dies on its first command.

The updater also refuses any release tag that is not GPG-signed with a key in
the service account's keyring. Sign releases with `git tag -s`, or update
manually.


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

All configuration is via environment variables. See `apps/api/.env.example` for a fully commented example.

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

See **[troubleshooting.md](troubleshooting.md)** — the connect failures have
their own page, because the message RustDesk shows almost never names the
component that produced it.

Quickest first move:

```bash
sudo deploy/scripts/hbbs-probe.py <rustdesk-id>
```

`ONLINE` means the server and endpoint are both fine and the problem is the
client you are connecting *from*.

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

## GeoIP database (dashboard map)

The dashboard's client map resolves addresses offline. The database is ~124 MB
and is **not** in the repository:

```bash
sudo scripts/update-geoip.sh
sudo systemctl restart reboot-remote-api
```

Without it the API logs a warning at startup and every computer is reported as
"unlocatable" — the dashboard still works, the map just has nothing to show.

The data is DB-IP City Lite (CC BY 4.0), refreshed monthly and requiring no
licence key. Re-run the script periodically; the attribution DB-IP's licence
requires is rendered on the map itself. `GEOIP_DB_PATH` overrides the location.

