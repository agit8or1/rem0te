# Changelog

All notable changes to Rem0te are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [0.3.8] — 2026-08-25 · *Luna*

### Added
- **User contact and address fields.** `User` schema now carries `phone`, `jobTitle`, `address`, `city`, `state`, `country`, `postalCode`, `timeZone` (all nullable). Exposed via `PATCH /api/v1/auth/profile` (self-service) and `PATCH /api/v1/users/:id` (admin). List endpoints (`GET /api/v1/users`, `GET /api/v1/auth/profile`) return the new fields, and the customer membership row now includes its linked customer.
- **My Account page** — Profile tab redesigned with an Identity section (first/last name, email, phone, job title) and a Mailing Address section (street, city, state/region, postal code, country, time zone).
- **Installer auto-registration without an enrollment token.** All three installers (`.ps1`, Linux `.sh`, macOS `.sh`) now retry RustDesk Device ID extraction for up to 45 s and always call `POST /api/v1/enrollment/heartbeat` after installation. Devices installed without a claim token now show up under Admin → Unassigned Devices, and the encrypted permanent password travels with them so the tenant already has it when it's assigned to a customer.
- **Encrypted first-write-only password storage on heartbeat.** The public `enrollment/heartbeat` endpoint accepts an optional `password`. It is encrypted (AES-256-GCM) and written to `RustdeskNode.permanentPassword` only if the node has no password yet — a hostile heartbeat with a guessed RustDesk ID cannot rotate a live credential.

### Changed
- `HeartbeatDto` now validates `rustdeskId` (6–15 digits), bounds hostname/platform/osVersion/agentVersion string lengths, and accepts the optional `password`.
- Windows installer: better fallback UX when RustDesk fails to write its `id` file (always prints the password so the operator can enter it manually).

---

## [0.3.7] — 2026-08-25 · *Luna*

### Security
- **Notes cross-tenant comment bypass (Critical, IDOR)** — `POST /notes/:id/comments` looked notes up by id only; any authenticated user could comment on any tenant's note. Now scoped by `tenantId` and audited via `NOTE_COMMENT_ADDED`.
- **RustDesk password ciphertext leaked in endpoint responses (Critical)** — `GET /endpoints`, `GET /endpoints/:id`, and `GET /endpoints/connected` no longer return the encrypted `permanentPassword` field. Responses expose only `hasPassword: boolean`. Plaintext is available exclusively via `GET /endpoints/:id/password`, which is throttled, MFA-gated, and audited via `ENDPOINT_PASSWORD_REVEALED`.
- **ENCRYPTION_KEY silently defaulted to all-zeros (Critical)** — three services fell back to a hardcoded key if the env var was missing. Now rejected at boot by config schema and by each service.
- **In-app updater accepted unsigned GitHub tags with `sudo` (Critical)** — updater refused unless `ALLOW_IN_APP_UPDATE=true`, requires signed release tags (`git tag --verify`), rejects non-semver / downgrade versions, and runs all subprocesses via `spawn(binary, args, { shell: false })` — no `bash -c` interpolation.
- **RustdeskNode queries not tenant-scoped (High)** — `getPassword`, `setPassword`, and `setRustdeskNode` now include `tenantId` in every query and refuse to overwrite a node bound to a different tenant.
- **JWT trusted stale role and platform-admin claims (High)** — every request re-reads `user.isPlatformAdmin`, the tenant's `isActive` flag, and the caller's active membership. Revocation is honored immediately instead of at token expiry.
- **Sudoers file allowed arbitrary package install and caddy config paths (High)** — `apt-get install *`, `caddy reload *` wildcards replaced by exact command allowlist. `visudo -c` validated on install.
- **Public installer scripts interpolated tenant settings unescaped (High)** — added strict allowlist validators for host, key, token, and version before they reach PowerShell/bash strings.
- **MFA recovery-code brute-force (Medium)** — endpoint throttled to 5/min per IP + per-user in-process backoff (5 failures → 15-minute lockout, logged as `RECOVERY_CODE_LOCKOUT`).
- **Cookies not Secure in production by default (Medium)** — cookies are Secure whenever `NODE_ENV=production`, independent of the previously required `COOKIE_SECURE` env var.
- **X-Forwarded-For was implicitly trustable (Medium)** — added `TRUSTED_PROXIES` env with sane default (`loopback` = same-host Caddy). Direct clients can no longer spoof source IP.
- **Placeholder secrets accepted (Medium)** — config validation rejects `JWT_SECRET`/`LAUNCHER_TOKEN_SECRET` values matching `change_me*`.

### Fixed
- **Windows installer crashed on PowerShell 5.1** — `-ProgressAction` is PS 7.4+; replaced with `$ProgressPreference` preference var (works on 5.1 and 7+).
- **Windows installer output** — permanent password now always shown even if the RustDesk ID could not be extracted; explicit hint when no enrollment token was included in the URL.

### Added
- `pnpm --filter api security:regression` — 6-assertion Prisma-level regression suite covering the tenant-isolation and password-leak fixes (`apps/api/scripts/security-regression.mjs`).
- `GET /admin/update/version` now returns `{version, commit, buildDate, channel, latestVersion, updateAvailable, inAppUpdateEnabled}`.
- Startup log line now prints version and configured trust-proxy setting.
- Migration `0002_activity_action_additions` extends the `ActivityAction` enum with the new audit event types.
- `docs/SECURITY-AUDIT.md` — full remediation record.

### Changed
- All version sources (`version.json`, root/api/web `package.json`) synchronized on `0.3.7`.

---

## [0.3.6] — 2026-03-14 · *Luna*

### Changed
- **Windows installer** — replaced `.bat` launcher with a compiled Go `.exe` (`GET /public/install/windows.exe`); binary patching at serve time embeds the PS1 URL including any enrollment token; self-elevates via UAC, no PowerShell knowledge required; signable with a code signing certificate

### Removed
- `GET /public/install/windows.bat` — superseded by `windows.exe`

---

## [0.3.5] — 2026-03-13 · *Luna*

### Added
- **Windows one-click installer** — `GET /public/install/windows.bat` serves a self-elevating batch file; double-click requests UAC and runs the PowerShell installer automatically — no PowerShell knowledge needed
- **Download page** — Windows section now has a prominent "Download Windows Installer (.bat)" button as the primary option, with the PowerShell command as a fallback
- **Enrollment link modal** — shows the `.bat` URL as the recommended Windows option alongside existing PS1/shell script URLs

---

## [0.3.4] — 2026-03-13 · *Luna*

### Changed
- **Settings → Access Control tab** now navigates directly to the Access Control page instead of showing an intermediary card with a button

### Dependencies
- `argon2` updated 0.40.3 → 0.44.0
- `class-validator` updated 0.14.4 → 0.15.1

---

## [0.3.3] — 2026-03-13 · *Luna*

### Security
- **HIGH**: `rustdeskRelayHost` and `rustdeskPublicKey` in tenant settings now validated with `@Matches` — hostname must match `^[a-zA-Z0-9.\-]+$`, key must match base64 — prevents shell injection via crafted server config embedded in install scripts
- **MED**: `resetPassword` (admin-initiated) now enforces 12-character minimum (was 8) — consistent with `changePassword`
- **MED**: `GET /launcher/validate` now rate-limited at 20 req/min — was missing throttle decorator
- **MED**: Auth cookies (`access_token`, `partial_token`) upgraded from `SameSite: lax` to `SameSite: strict`
- **LOW**: Invite tokens now use `crypto.randomBytes(32)` instead of `nanoid(32)` — consistent with rest of codebase
- **LOW**: Device claim tokens now stored as SHA-256 hash — raw token returned to caller but only hash persisted in DB; token validated by hashing incoming value before lookup

### Fixed
- `ResetPasswordDto` missing class-validator decorators caused `forbidNonWhitelisted` to reject all admin password resets — added `@IsString()` + `@MinLength(12)` (plus decorators on `InviteUserDto`, `ChangeRoleDto`, `UpdateProfileDto`)

---

## [0.3.2] — 2026-03-13 · *Luna*

### Security
- **HIGH**: `GET /admin/status` — replaced all `execSync` calls with async `spawn`-based helpers; disk and service status checks now run concurrently and no longer block the Node.js event loop
- **HIGH**: OS update now fetches and checks out a specific release tag (`git fetch origin tag vX.Y.Z` + `git checkout vX.Y.Z`) instead of blindly pulling `origin/main` — prevents supply-chain risk from a compromised default branch
- **MED**: MFA `POST /auth/mfa/verify` now prefers the httpOnly `partial_token` cookie over any `partialToken` value supplied in the request body — eliminates token fixation via body injection
- **MED**: Launcher deep link changed from `reboot-remote://launch?token=…` (query string) to `reboot-remote://launch#token=…` (URL fragment) — JWT is no longer forwarded to servers or recorded in proxy/server access logs; Tauri launcher updated to parse from fragment

---

## [0.3.1] — 2026-03-13 · *Luna*

### Security
- **CRIT**: Removed encrypted `permanentPassword` field from endpoint list API response — only exposed via the explicit `GET /endpoints/:id/password` endpoint now
- **CRIT**: Restricted `GET /endpoints/:id/password` (plaintext device password) to `endpoints:write` permission — was previously readable by `READ_ONLY` / `TECHNICIAN` roles
- **CRIT**: Fixed command injection in TLS status check — `openssl s_client` domain was interpolated into a `bash -c` string; switched to positional `sh -c` args
- **HIGH**: Fixed IDOR on tenant mutation endpoints — `PATCH /tenants/:id`, `PATCH /tenants/:id/branding`, `PATCH /tenants/:id/settings`, `GET /tenants/:id/members`, `PATCH /tenants/:id/members/:userId/role`, `GET /tenants/:id/roles`, `POST /tenants/:id/invite` now verify the caller's JWT tenantId matches the URL parameter
- **HIGH**: Added rate limiting to public enrollment endpoints — `/enrollment/claim` (10/min), `/enrollment/heartbeat` (60/min) — prevents DB flood / unassigned-device queue poisoning
- **MED**: Replaced `Math.random()` with `crypto.randomBytes(16)` for logo upload filenames
- **MED**: Replaced `Math.random()` with `crypto.randomBytes(32)` for portal user stub password hash
- **LOW**: `changePassword` now enforces 12-character minimum (was 8, ignoring tenant policy)
- **LOW**: Sudoers entry for `apt-get install` restricted to `fail2ban` only — was a wildcard that allowed privilege escalation via arbitrary package install
- **GITIGNORE**: Added explicit `.env`, `*.bak`, `/tmp/` entries

---

## [0.3.0] — 2026-03-13 · *Luna*

### Added
- **Unassigned device pool** — devices that heartbeat/enroll without a tenant token land in an unassigned state; only platform admins can see them at `/admin/unassigned`
- **Platform admin: Unassigned Devices page** — table of unassigned devices with one-click tenant assignment
- **Tenant-generated enrollment links** — "Generate Enrollment Link" button on Enrolled Clients page creates a claim token and shows per-platform script URLs (`?token=<token>`) with copy buttons
- **Auto-claim in install scripts** — when a script URL includes `?token=`, the script automatically calls `POST /enrollment/claim` after installation, assigning the device to the correct tenant
- **Claim flow: handles unassigned → assigned** — if a device heartbeated first (creating an unassigned record), the claim step assigns that record to the tenant rather than creating a duplicate
- **`GET /admin/unassigned-devices`** API endpoint (platform admin only)
- **`POST /admin/unassigned-devices/:id/assign`** API endpoint (platform admin only)

### Changed
- `RustdeskNode.rustdeskId` is now globally unique (was per-tenant) — a device can only be enrolled in one tenant at a time
- `Endpoint.tenantId` and `RustdeskNode.tenantId` are now nullable; `null` means unassigned

---

## [0.2.0] — 2026-03-12 · *Luna*

### Added
- **Enrolled Clients** — permanent device enrollment flow with sidebar nav item, dedicated page, and "Enroll Client" button
- **Connected sessions tab** — Sessions page now has a Connected tab showing active sessions and online enrolled clients in real time (auto-refresh every 30 s)
- **Heartbeat endpoint** (`POST /enrollment/heartbeat`) — enrolled clients report presence; background job marks stale endpoints offline after 10 minutes
- **Permanent password enforcement** — install scripts now generate a 12-character random permanent password, write `verification-method = 'use-permanent-password'` to `RustDesk2.toml`, and set the password via `rustdesk --password` so clients no longer rotate session passwords
- **Unified user edit dialog** — Access page now uses a single `EditUserDialog` replacing three separate dialogs (edit profile, reset password, change role)
- **"Connected / Waiting" status** — sessions with `PENDING` status now display as "Connected / Waiting" with a pulsing green indicator instead of "Pending"
- **`GET /endpoints/connected`** API endpoint returning `isOnline=true` active endpoints with customer, site, and RustDesk node details

### Fixed
- Platform admins can now act on their own account (previously blocked by self-check order)
- Session status badge now correctly maps all uppercase DB enum values (`PENDING`, `SESSION_STARTED`, etc.)
- `@nestjs/schedule` removed — replaced with `setInterval` in `OnModuleInit`/`OnModuleDestroy` to avoid pnpm symlink issues in production deployment

---

## [0.1.0] — 2026-03-12 · *Luna*

### Added
- Multi-tenant remote support platform built on RustDesk hbbs/hbbr
- JWT authentication with TOTP MFA support
- Role-based access control (Platform Admin → Tenant Owner → Admin → Technician → Read-Only → Customer)
- Customer portal with self-service support requests
- Endpoint management with RustDesk ID linking
- Permanent on-demand connections via Connect → My Devices
- One-click Connect button launching `rustdesk://` deep links
- Add Device form for registering permanent connections by RustDesk ID
- Ad-hoc session support for one-time connections
- Session audit log
- Download page with auto-configured install scripts (Windows PowerShell, Linux bash, macOS bash)
- Install scripts configure hbbs server, write config to all user profiles, run RustDesk as system service
- Platform Admin panel with fail2ban management, OS updates, TLS renewal, security audit
- Tenant branding and settings
- Light / dark / system theme support
- MFA enrolment and recovery codes
- Customer portal invite flow

### Infrastructure
- NestJS API + Prisma + PostgreSQL + Redis
- Next.js 14 App Router + shadcn/ui + TanStack Query
- Systemd service deployment (no Docker)
- Runs on Ubuntu alongside RustDesk server components

---

*Rem0te is managed by Luna 🐾 — a very good German Shepherd Dog*
