# Threat model — Rem0te

Read by Anthropic's OSS Scanner before each scan. It is also the project's own
statement of what it defends and how it rates findings; `.github/SECURITY.md` and
`docs/SECURITY-AUDIT.md` are the longer versions.

## What this project does

Rem0te is a self-hosted, multi-tenant remote-support platform for managed service
providers (MSPs). It is a **sidecar around upstream RustDesk** (`hbbs`/`hbbr`): it
owns identity, authorisation, the RustDesk credentials of managed computers, the
installers that enrol those computers, and the audit log. It never carries
remote-desktop traffic — RustDesk does. See `docs/architecture.md`.

A compromise matters more than in a typical web app: the API holds the
(encrypted) permanent RustDesk passwords of every managed computer, and it
generates installer scripts that run as **SYSTEM/root** on customer machines. An
attacker who controls what the API releases or generates controls remote access
to every business on the instance.

| Component | Path | Notes |
|---|---|---|
| API | `apps/api` | NestJS 11, Prisma/PostgreSQL, Redis. Global prefix `/api/v1`, port 3001 |
| Web console | `apps/web` | Next.js App Router. Proxies `/api/*` to the API; auth gate in `middleware.ts` |
| Desktop launcher | `apps/launcher` | Tauri 2 (Rust in `src-tauri/`), handles `reboot-remote://` deep links |
| Windows installer | `tools/windows-installer` | Go, runs elevated on customer machines |
| Deploy | `deploy/` | install script, systemd units, Caddy config, **sudoers grants** |
| Scripts | `scripts/`, `apps/api/scripts` | CI invariant checks and e2e suites (not shipped) |

## Trust boundaries and where untrusted input enters

**The business (`Customer` table) is the security boundary.** `Tenant` is only an
internal container — do not report "cross-tenant" issues that stay inside one
business. Roles: Platform Admin → Business Owner → Business User + capabilities
(`apps/api/src/rbac/capabilities.ts`). Every business-scoped query is supposed to
go through `AccessControlService` (`apps/api/src/rbac/access-control.service.ts`):
`resolveScope()` for lists, `assertEndpointInScope` / `assertBusinessInScope` /
`assertUserInScope` for lookups by id. Full model: `docs/access-control.md`.

Untrusted inputs, most exposed first:

1. **Unauthenticated HTTP** (`@Public()` routes). Anyone on the internet:
   - `auth/login`, `auth/mfa/verify` — login, TOTP and recovery codes, pre-MFA
     `partial` tokens (`apps/api/src/auth`, `apps/api/src/mfa`).
   - `enrollment/claim`, `enrollment/heartbeat`, `enrollment/command-result`,
     `enrollment/confirm-rotation` — called by managed computers. Treat the
     caller as hostile: a machine in business A, or something pretending to be
     one, must not affect business B, learn another endpoint's password, or
     overwrite one (`apps/api/src/enrollment`).
   - `public/install/{win,linux,mac}/:token`, `public/install/:platform`,
     `public/rustdesk-config` — **generate shell/PowerShell scripts** with
     tenant settings interpolated (`apps/api/src/public`). Injection here is
     code execution as SYSTEM/root on whoever runs the installer.
   - `public/quick-connect`, `public/quick-connect/download/:os` — ad-hoc support
     downloads, gated by three switches (`apps/api/src/quick-connect`).
   - `launcher/validate` — single-use, 120 s launcher tokens (`apps/api/src/launcher`).
2. **API-key HTTP** at `/api/v1/pub/v1/*` (`apps/api/src/public-api`). A key is
   pinned to one business; it must never reach another.
3. **Authenticated console users** of every role. A Business User may be
   malicious: their capabilities must be enforced server-side, not just hidden in
   the UI. A Business Owner must stay inside their business and must not be able
   to promote themselves or anyone else beyond Business Owner.
4. **Data reported by managed computers** — hostnames, inventory, Windows event
   logs, command results — is attacker-controlled and is later **rendered in the
   console** (stored XSS) and used for lookups (the Tactical RMM resolver matches
   endpoints by hostname, `docs/tactical-rmm.md`).
5. **Deep links** into the launcher: `reboot-remote://launch#token=…&api=…`. The
   link is attacker-supplied; the launcher must only talk to its configured API
   origin (`apps/launcher/src-tauri/src/launch.rs`) and must not pass attacker
   input into `rustdesk` arguments.
6. **Uploads**: tenant logo upload (multer) — type, size, path.
7. **Endpoint-side AI summarisation**: `endpoints.service.ts` sends endpoint data
   to the Claude API when an operator asks. Prompt-injection that only changes
   the summary text shown to that operator is low; anything that leads to an
   action, or to data from another business being included, is not.

Trusted: the platform operator, the host OS, `/etc/reboot-remote/api.env`
(root-owned 0600), PostgreSQL and Redis on loopback, and the RustDesk server key.
Caddy terminates TLS; proxy trust is loopback-only (`TRUSTED_PROXIES`).

## What must hold (the invariants)

- No request reaches data of a business the caller is not scoped to.
- A pre-MFA `partial` token is never accepted as a session.
- JWT claims are used for identity only; role, business, capabilities and
  platform-admin are re-read from the database on every request.
- RustDesk passwords, TOTP secrets and recovery codes never appear in a
  response, log, or audit entry in plaintext, except where an authorised user
  explicitly reveals a credential they are allowed to see.
- Launcher tokens, enrolment tokens and connection grants are single-use,
  atomically, and stored hashed.
- Values interpolated into generated installer scripts are validated against
  anchored allowlists; the scripts cannot be made to run attacker commands.
- Every child process uses a fixed argv with `shell: false`. The sudoers grants in
  `deploy/scripts/install.sh` must not let the API's service account reach root
  (e.g. via `fail2ban-client` actions or `apt-get` arguments).
- The in-app updater (off by default, `ALLOW_IN_APP_UPDATE`) only builds
  GPG-signed tags; downloaded rustdesk-server `.deb`s are integrity-checked
  before a root install.
- Rate limits on login, MFA and the public enrolment routes are actually applied
  (the named-throttler trap in `docs/SECURITY-AUDIT.md`, H2).
- Redirects after sign-in stay on-site.

`scripts/check-security-invariants.mjs` checks several of these statically.
Findings that defeat one of these invariants are what we most want.

## Components that matter most / least

- **Most:** `apps/api/src/{auth,mfa,rbac,enrollment,public,public-api,launcher,quick-connect,endpoints,sessions,users,businesses,admin}`,
  `apps/web/middleware.ts`, `apps/launcher/src-tauri/src`, `tools/windows-installer`,
  `deploy/scripts/install.sh` (sudoers section), `deploy/caddy`.
- **Less:** dashboard and host metrics (`admin/host-metrics.service.ts`), geoip,
  docs rendering, branding.
- **Out of scope:** `apps/api/scripts/*` and `scripts/*` (test and CI tooling, not
  deployed), `apps/api/prisma/_docs-demo-*.ts` (demo seeding, refuses non-demo
  databases), `apps/web/scripts/*` (screenshot/video capture), `semgrep-rules/`,
  `docs/`, and bugs in RustDesk itself — those go to the RustDesk project.
  Vulnerabilities that live entirely in a dependency are out of scope unless
  Rem0te's code makes them reachable.

## How to exercise it

The image is built by `.oss-scanner/Dockerfile`. Everything is built in place
under `/src`; nothing needs the network afterwards.

```bash
/src/.oss-scanner/start-services.sh       # Postgres + Redis + API on 127.0.0.1:3001
cd /src/apps/api
node scripts/e2e-smoke.mjs                # login, MFA, basic flows
node scripts/e2e-business-access.mjs      # 82-check business isolation + Quick Connect proof
node scripts/e2e-public-api.mjs           # API-key scoping
node scripts/security-regression.mjs      # earlier fixed findings
node /src/scripts/check-security-invariants.mjs
```

The e2e scripts create their own users and businesses with random suffixes and
show how to log in as each role (`POST /api/v1/auth/login` with a JSON body,
cookie `access_token` back). They are the fastest way to build a two-business
reproducer. Env for the API is in `/etc/reboot-remote/api.env` (random values made
during the image build). The web app can be started with
`cd /src/apps/web && node .next/standalone/apps/web/server.js` (port 3000), but the
API is where authorisation is decided — test the API directly.

The launcher is compiled in debug mode under `apps/launcher/src-tauri/target`
when the build succeeds; `handle_launch_url` in `launch.rs` is the entry point for
deep links. The Windows installer is cross-compiled to `/src/dist/windows-installer.exe`.

## How we rate severity

- **Critical** — any of these reachable **without authentication**, or by a
  managed computer: code execution on the server; code execution on managed
  computers through generated installers or the launcher; disclosure of
  RustDesk passwords or other credentials of any business; authentication or
  MFA bypass to any account; takeover of a Platform Admin.
- **Critical** — escape from the API's service account to root on the server
  through the sudoers grants or the updater.
- **High** — a **cross-business** read or write by an authenticated user or API
  key of another business (reading another business's computers, users,
  sessions, audit log, or releasing its credentials); privilege escalation to
  Business Owner or Platform Admin; stored XSS in the console from
  endpoint-reported data or from another business's user; reuse of a single-use
  token; launcher deep link that sends a token to another origin or reconfigures
  RustDesk to a hostile server.
- **Medium** — authorisation flaws **inside one business** (a Business User
  doing something their capabilities do not allow); rate-limit or lockout bypass
  on login/MFA; open redirect; CSRF on a state-changing route; information
  disclosure that does not include credentials (e.g. enumerating that an email
  or RustDesk ID exists); SSRF without credential impact.
- **Low** — issues requiring a Platform Admin to act against their own instance;
  self-XSS; missing headers without a demonstrated exploit; DoS that needs
  sustained traffic from an authenticated user; prompt injection that only alters
  AI summary text.

A finding that requires an already-compromised server, root, or physical
access is out of scope. Post-authentication findings are not automatically
lower: a cross-business read by any logged-in user is High, because every
business on an instance is a different customer of the MSP.

## How we would like reports

- Name the invariant above that breaks, the route or function, and the role the
  attacker needs.
- A reproducer as a short Node script in the style of `apps/api/scripts/e2e-*.mjs`
  (create two businesses, act as one, reach the other) is ideal.
- Patches: minimal and merge-ready, against `apps/api/src` (or the relevant
  package). If the fix belongs in `AccessControlService`, put it there rather
  than adding an ad-hoc filter in one service. If an invariant can be checked
  statically, a matching addition to `scripts/check-security-invariants.mjs` is
  welcome.
- Deduplicate by root cause: one missing scope check reached through several
  routes is one report.

## Anything to leave alone

- The `Tenant` table not acting as a boundary — that is by design.
- Platform Admins bypassing business restrictions — by design, and audited.
- `EndpointStatus.OFFLINE` being unused, and `PermissionsGuard` allowing a route
  with no `@RequirePermissions()` decorator (known, recorded as Low in
  `docs/SECURITY-AUDIT.md`; report it only if a route is actually exposed).
- The `rustdesk://` Connect link carrying no server address — a protocol
  limitation of RustDesk, documented in `docs/connecting.md`.
- Default/placeholder secrets in `.env.example` files and the random values in
  this image's `/etc/reboot-remote/api.env`.
- `pnpm audit` findings in devDependencies.
