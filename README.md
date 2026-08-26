# Rem0te 🐾

> Secure self-hosted remote access for businesses.
> Users sign in and connect to the business computers they've been granted access to. That's it.
> Managed by **Luna** — a very good German Shepherd Dog.

⭐ If Rem0te is useful to you, a star helps others find it!

[![Stars](https://img.shields.io/github/stars/agit8or1/rem0te?style=flat)](https://github.com/agit8or1/rem0te/stargazers)
[![Version](https://img.shields.io/badge/version-0.8.1-blue)](https://github.com/agit8or1/rem0te/releases)
[![Issues](https://img.shields.io/github/issues/agit8or1/rem0te)](https://github.com/agit8or1/rem0te/issues)
[![License](https://img.shields.io/github/license/agit8or1/rem0te)](LICENSE)

---

## What Rem0te is (and isn't)

**Rem0te is:** a business remote-access product. One Rem0te operator hosts the platform and creates customer **businesses**; each business has its own owners, users and computers, and nothing is shared between them.

**Rem0te is not:** an RMM, and not a reseller hierarchy. No patch management, no software inventory, no ticketing, no monitoring dashboards. RustDesk is the underlying remote-desktop transport — an implementation detail hidden from the customer experience.

```
                 REM0TE PLATFORM
                       |
        +--------------+---------------+
        |                              |
   ACME Manufacturing            Smith Accounting
     (a Business)                  (a Business)
        |                              |
      Users                          Users
        ↕                              ↕
    Computers                      Computers
```

---

## Access control — the whole model

```
              PLATFORM ADMIN
              Full platform access
                     |
                     v
            BUSINESS OWNER / ADMIN
            Full business control
                     |
                     v
               BUSINESS USER
          Permissions assigned by owner
```

Three levels. That's all of it.

| Level | Scope |
|---|---|
| **Platform Admin** | The Rem0te operator. Creates and manages every business, sees every computer, owns all platform settings and infrastructure. |
| **Business Owner** | Full administrative control of **one** business — its computers, its people, its sessions, its audit history. Cannot see any other business. |
| **Business User** | Exactly the capabilities the Business Owner granted. Nothing else. |

**A Business is the security boundary**, and it is enforced server-side on every request. Hiding a
button in the UI is a courtesy; changing a URL or calling the API directly still gets refused.

### Business User permissions

| Group | Permissions |
|---|---|
| Computers | View computers · Remote connect · Add computers · Remove/revoke computers · Rename/edit computers |
| Support | Use Quick Connect · View active sessions · View session history |
| Users | View business users · Manage business users |
| Audit | View business audit log |

New Business Users start with **View computers** and **Remote connect** on; everything more
administrative is off until granted. A Business Owner implicitly holds all of them; a Platform Admin
holds everything.

Quick Connect is a **permission, not a role**.

---

## Who does what

### Business User
1. Log in.
2. Land on **My Computers** — the PCs they've been authorized for.
3. Click **Connect**. Rem0te fetches the credentials and launches RustDesk with the password pre-filled.

No RustDesk ID typing, no password copy-paste, no server configuration.

### Business Owner
- **Users** — add, disable, remove business users, and set exactly what each one can do.
- **Computers** — every computer in the business, its assigned users, its status.
- **Downloads** — Managed Device Installer bound to this business; Quick Connect client for one-off support.
- **Sessions / Audit** — what happened in this business, and when.
- **Business Settings** — the business profile.

### Platform Admin
- **Businesses** — create, edit, disable and (when empty) delete every customer business.
- **Computers** — search and manage computers across every business, including unassigned ones.
- **Access Control** — the three-level model, business users, and platform admins.
- **Settings** — RustDesk infrastructure, branding, MFA policy, and the Quick Connect master switch.
- **Security / System Status / Updates** — the platform itself.

---

## Quick Connect

Temporary support access to a machine that is **not** an enrolled managed computer.

```
Person needing help → https://your-rem0te/quick → downloads the Quick Connect client
                                                            ↓
                                    Runs it. No install, no account, no service.
                                                            ↓
                              Client shows:  Remote ID  123 456 789
                                             Password   A7k9X2
                                             Status     Waiting for connection
                                                            ↓
                                  They read both out to the person helping them
                                                            ↓
              Authorized Rem0te user → Quick Connect → enters ID + password → Connect
                                                            ↓
                                     RustDesk session. Closing the client ends it.
```

- **No permanent enrollment.** No `Endpoint` row is created; nothing becomes a managed device.
- **The client is preconfigured** for your RustDesk server, so nobody types a relay host, ID server or key.
- **The password is never stored, never logged, never put in a URL.** The remote person choosing to
  read it out is what authorises the session.
- **Three switches must all be on**: platform master switch → per-business switch → the user's
  `Use Quick Connect` permission.

Every session start and end is audited with the user, their business, the remote RustDesk ID and the
source IP. Passwords, clipboard contents, keystrokes and screen contents never are.

---

## How managed enrollment works

```
Admin → Add Computer → pick company + users → Generate Installer
                                                     ↓
                        one-time PowerShell / bash command
                                                     ↓
                                            Run once on target PC
                                                     ↓
             Downloads + installs RustDesk (config baked in via MSP renamed-installer)
                                                     ↓
                    Registers with Rem0te using a customer-bound token
                                                     ↓
              Server stamps company + user access from the token — endpoint has no say
                                                     ↓
                Computer appears in the correct company; assigned users see it
                                                     ↓
                                        Employee clicks CONNECT
```

The endpoint that redeems the enrollment token **cannot** influence which company it lands in or who gets access — those are stamped from the token at mint time and validated server-side.

## How Connect works

`POST /api/v1/endpoints/:id/connect` authorizes the caller via `ComputerAccess` (or `COMPANY_WIDE` + membership) and returns `{rustdeskId, password}`. The browser copies the password to the clipboard and launches `rustdesk://connection/new/<id>?password=<url-encoded>`. Modern RustDesk builds honor the URI password (truly one click); older builds fall back to the clipboard paste. Every reveal is audited.

---

## Security posture

| Threat | Control |
|---|---|
| Cross-business data access | Every business-scoped read and write resolves through `AccessControlService`; object lookups by id go through `assertEndpointInScope` / `assertBusinessInScope` / `assertUserInScope` before anything is read. Proven by `apps/api/scripts/e2e-business-access.mjs` (82 checks). |
| Privilege escalation | Nobody can edit their own permissions or level. Only a Platform Admin can create a Business Owner. Capability strings are allowlisted before they reach the database. |
| Quick Connect abuse | Platform master switch → per-business switch → per-user capability, all re-checked server-side on every call. Denials are audited. |
| API key over-reach | Every key is bound to exactly one business and acts as a Business Owner **within it only** — never a Platform Admin. Keys predating business scoping were revoked by migration 0009. |
| Endpoint password exposure | Ciphertext never leaves the server. Plaintext only via authorized `getPassword` / `connect` — throttled, MFA-gated, audited (`ENDPOINT_PASSWORD_REVEALED`) |
| Enrollment token abuse | 256-bit random, SHA-256 hashed at rest, one-time, TTL-bound, atomic redemption |
| Stale JWT after role change | JWT re-checks `user.isPlatformAdmin`, `tenant.isActive`, `membership.isActive` on every request |
| Recovery-code brute force | 5/min throttle + per-user 5-fail → 15-min lockout, audited |
| Auth cookies | HttpOnly, SameSite=strict, Secure=true whenever `NODE_ENV=production` |
| Trusted-proxy spoofing | `TRUSTED_PROXIES` env drives Express `trust proxy` (default `loopback`) |
| Installer supply chain | Windows installer uses RustDesk MSP renamed-installer + `--config` — verifies effective config against public `rustdesk.com` and hard-fails (exit 20) if a public rendezvous survives |
| In-app updater | Off by default. Requires `ALLOW_IN_APP_UPDATE=true` and signed GPG tag (`git tag --verify`) |
| Sudoers | No wildcards. Only the exact commands the API executes are allowed, `visudo -c` validated |

Full audit trail: [`docs/SECURITY-AUDIT.md`](docs/SECURITY-AUDIT.md).

---

## Stack

| Layer | Tech |
|-------|------|
| API | NestJS + Prisma + PostgreSQL + Redis |
| Web | Next.js 14 App Router + shadcn/ui + TanStack Query |
| Desktop launcher | Tauri 2.0 (optional) |
| Remote transport | RustDesk hbbs / hbbr, self-hosted |
| Deploy | systemd on Ubuntu (no Docker required) |

---

## Screenshots

Regenerated automatically from the running v0.8.x UI via Playwright (`node apps/web/scripts/screenshots.mjs`). Both light and dark themes captured.

| Page | Light | Dark |
|------|-------|------|
| My Computers | ![](docs/screenshots/my-computers-light.png) | ![](docs/screenshots/my-computers-dark.png) |
| Dashboard | ![](docs/screenshots/dashboard-light.png) | ![](docs/screenshots/dashboard-dark.png) |
| Businesses | ![](docs/screenshots/businesses-light.png) | ![](docs/screenshots/businesses-dark.png) |
| Access Control | ![](docs/screenshots/access-control-light.png) | ![](docs/screenshots/access-control-dark.png) |
| Users | ![](docs/screenshots/users-light.png) | ![](docs/screenshots/users-dark.png) |
| Computers | ![](docs/screenshots/computers-light.png) | ![](docs/screenshots/computers-dark.png) |
| Add Computer | ![](docs/screenshots/add-computer-light.png) | ![](docs/screenshots/add-computer-dark.png) |
| Sessions | ![](docs/screenshots/sessions-light.png) | ![](docs/screenshots/sessions-dark.png) |
| Quick Connect | ![](docs/screenshots/quick-connect-light.png) | ![](docs/screenshots/quick-connect-dark.png) |
| Quick Connect (public `/quick`) | ![](docs/screenshots/quick-public-light.png) | ![](docs/screenshots/quick-public-dark.png) |
| Audit Log | ![](docs/screenshots/audit-light.png) | ![](docs/screenshots/audit-dark.png) |
| My Account | ![](docs/screenshots/account-light.png) | ![](docs/screenshots/account-dark.png) |

---

## Quick start (self-hosting)

See [docs/setup.md](docs/setup.md) for full installation instructions.

```bash
git clone https://github.com/agit8or1/rem0te
cd rem0te
pnpm install

cp apps/api/.env.example apps/api/.env
# Edit .env — DATABASE_URL, JWT_SECRET, ENCRYPTION_KEY (openssl rand -hex 32), etc.

pnpm build
sudo systemctl start reboot-remote-api reboot-remote-web
```

Prerequisites: PostgreSQL 14+, Redis, RustDesk `hbbs` + `hbbr` on the same host, Caddy for TLS.

---

## Contributing

Issues, ideas, and pull requests are welcome.

- 🐛 [Report a bug](https://github.com/agit8or1/rem0te/issues/new?template=bug_report.md)
- 💡 [Request a feature](https://github.com/agit8or1/rem0te/issues/new?template=feature_request.md)
- 💬 [Join the discussion](https://github.com/agit8or1/rem0te/discussions)

---

## Project Manager

This project is overseen by **Luna**, a German Shepherd Dog of exceptional intelligence and discerning taste in remote support software. All major decisions are reviewed by Luna before merging.

🐾

---

## Documentation

| Guide | For |
| --- | --- |
| [Technician Guide](docs/technician-guide.md) | Day-to-day use — connecting, Quick Connect, enrolling, keeping RustDesk current. Annotated screenshots. |
| [Public API](docs/PUBLIC-API.md) | RMM/PSA integration. Scopes, response shapes, errors, worked examples. |
| [Access Control](docs/access-control.md) | The three-level model and capability vocabulary. |
| [Setup](docs/setup.md) | Installing and operating a server. |
| [Security Audit](docs/SECURITY-AUDIT.md) | Threat model and audit trail. |

---

## Support this project

- ⭐ [Star on GitHub](https://github.com/agit8or1/rem0te)
- 💖 [GitHub Sponsors](https://github.com/sponsors/agit8or1)

---

## License

MIT — see [LICENSE](LICENSE)
