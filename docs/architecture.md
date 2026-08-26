# Architecture

What runs, where state lives, and which component decides what.

---

## Shape

Rem0te is a **sidecar around upstream RustDesk**. It does not fork RustDesk, does
not carry session traffic, and does not proxy the remote desktop protocol. It
owns identity, authorisation, credentials and audit; RustDesk owns the pixels.

```
        Browser                          Technician's RustDesk
           |                                      |
      443  |  (Caddy)                             |  21116/21117
           v                                      v
   +----------------+                    +--------------------+
   |  Next.js web   |                    |  hbbs  (21116)     |
   |    :3000       |                    |  rendezvous        |
   +----------------+                    |  hbbr  (21117)     |
           |                             |  relay             |
      /api/v1                            +--------------------+
           v                                      ^
   +----------------+                             |
   |  NestJS API    |                             |  21116/21117
   |    :3001       |                             |
   +----------------+                    +--------------------+
      |         |                        |  Endpoint RustDesk |
      v         v                        +--------------------+
  Postgres    Redis                              |
                                            ~3 min HTTP
                                            heartbeat
                                                 |
                                                 v
                                         (back to the API)
```

The two vertical paths never meet. The API never talks to hbbs during a
connection, and hbbs never asks the API whether a connection is allowed —
authorisation happens *before*, when the API decides whether to hand out the
endpoint's credential.

---

## Processes

| Unit | What | Port |
|---|---|---|
| `reboot-remote-api` | NestJS API, global prefix `/api/v1` | 3001 |
| `reboot-remote-web` | Next.js 14 (App Router), standalone build | 3000 |
| `rustdesk-hbbs` | RustDesk rendezvous | 21115, 21116 tcp+udp, 21118 |
| `rustdesk-hbbr` | RustDesk relay | 21117, 21119 |
| `caddy` | TLS termination and reverse proxy | 80, 443 |
| `postgresql` | Everything Rem0te knows | local |
| `redis` | Sessions and rate limiting | local |

No Docker. Deployment is systemd units and a build on disk.

### hbbs and hbbr are locked to the server key

Both run with `-k _`, which reads `/var/lib/rustdesk-server/id_ed25519.pub` and
rejects any client presenting a different key. Without it, any client that
reached the host could register a peer and the relay would carry traffic for any
pair that found port 21117.

This is applied as **systemd drop-ins**, not edits to the unit files, because
the `rustdesk-server` package owns those units and an in-place edit is silently
reverted on package upgrade — reopening registration with no warning.

---

## Data model

```
Tenant  ─┬─ Customer (a BUSINESS — the security boundary)
         │     ├── Membership ── User
         │     ├── Site
         │     └── Endpoint ── RustdeskNode
         └── TenantSettings / TenantBranding / TenantPolicy
```

- **`Customer` is the business**, and the security boundary. Every
  business-scoped query goes through `AccessControlService`.
- **`Tenant`** is an internal platform container, not a boundary.
- **`Endpoint`** is a managed computer; **`RustdeskNode`** holds its RustDesk
  identity — the peer ID, reported version, and the AES-256-GCM encrypted
  permanent password.

Full model in [access-control.md](access-control.md).

---

## Identity and credentials

- JWT in an `access_token` cookie, and accepted as `Authorization: Bearer`.
- Payload: `{ sub, email, tenantId, businessId, roleType, capabilities,
  isPlatformAdmin, mfaVerified, partial? }`.
- **Role, business and capabilities are re-read from the database on every
  request.** The token is never trusted for authorisation — only for identity.
- TOTP secrets: AES-256-GCM, stored as `iv:authTag:ciphertext` hex.
- Launcher tokens: signed with a **separate** `LAUNCHER_TOKEN_SECRET`, 120s TTL,
  single-use, and carried in a URL *fragment* so they never reach a server log
  or a proxy access log.
- Audit log is append-only, and a failure to write it never breaks the request
  path.

---

## The RustDesk configuration chain

One value, delivered five ways. Getting this wrong is the most common cause of
"cannot connect", so it is worth seeing whole.

```
  /var/lib/rustdesk-server/id_ed25519.pub   ← the source of truth
        |
        ├─→ hbbs / hbbr  -k _               (rejects any other key)
        |
        └─→ TenantSettings.rustdeskPublicKey (Rem0te's copy — must match)
                 |
                 ├─→ Managed installer          → rustdesk --config
                 ├─→ Technician setup .cmd      → rustdesk --config
                 ├─→ Preconfigured download     → config in the filename
                 ├─→ Quick Connect download     → config in the filename
                 └─→ Desktop launcher           → rustdesk --config, then --connect
```

Everything derives from one file. Regenerating the keypair invalidates every
client configured before that moment.

Note what is **not** on that list: the `rustdesk://` link behind the Connect
button. That URI scheme has no field for a server address, so it cannot carry
configuration — it relies entirely on the local client already being correct.
See [connecting.md](connecting.md).

---

## Two meanings of "online"

| Signal | Owner | Lifetime |
|---|---|---|
| `Endpoint.isOnline` | Rem0te — HTTP heartbeat every ~3 min | Swept to offline after ~10 min |
| RustDesk peer registration | hbbs — **in memory only** | Empty after any hbbs restart |

A Connect depends on the second. They disagree often enough that
`deploy/scripts/hbbs-probe.py` exists to ask hbbs directly rather than infer
from the dot.

---

## Paths

```
/opt/reboot-remote/
  api/dist/                       API build
  web/standalone/                 Next.js standalone build
  cache/rustdesk-clients/         Cached RustDesk client binaries
  version.json                    Drives the version banner and update check

/etc/reboot-remote/
  api.env                         API secrets (mode 600)
  web.env

/var/lib/rustdesk-server/
  id_ed25519, id_ed25519.pub      Server keypair
  db_v2.sqlite3                   hbbs peer database

/var/lib/reboot-remote/
  rustdesk-server/                .deb staging for in-app server upgrades

/var/log/rustdesk-server/
  hbbs.log, hbbr.log              Note: nothing is logged for a failed connect

/etc/sudoers.d/reboot-remote      Fixed-command grants for the API user
```

---

## Deliberate constraints

- **No wildcards in sudoers.** Every rule is the exact command line the API
  runs. A compromise of the Node process must not become arbitrary package
  installation or arbitrary systemd control.
- **The deploy target is not a git checkout.** Builds happen in `SOURCE_DIR`
  and are rsynced across.
- **Client chunks are added, never deleted, on deploy.** Deleting them breaks
  every browser that already had the app open.
- **Failures in telemetry never block the user.** Audit writes and session
  events are best-effort by design.

---

## See also

- [access-control.md](access-control.md) — the permission model in full
- [connecting.md](connecting.md) — the connect paths
- [setup.md](setup.md) — installation and operations
- [PUBLIC-API.md](PUBLIC-API.md) — the API surface
