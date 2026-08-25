# Changelog

All notable changes to Rem0te are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [0.8.0] — 2026-08-25 · *Ledger*

Rem0te's authorization model is now three levels and nothing else, and **a Business is the
security boundary** — enforced server-side on every request rather than by hiding things in the UI.

### Access control — the whole model

```
PLATFORM ADMIN  →  BUSINESS OWNER  →  BUSINESS USER + assigned permissions
```

- **Platform Admin** — the Rem0te operator. Every business, every computer, every setting.
- **Business Owner / Admin** — full control of exactly one business, and nothing outside it.
- **Business User** — only the capabilities the Business Owner granted.

Removed as roles: Tenant Owner, Tenant Admin, Technician, Billing Admin, Read Only, Customer
Portal. The customer portal (`/portal`, `PortalModule`) has been deleted outright — Business Users
now use the main application with permissions instead of a parallel interface.

### Added
- **Capability-based permissions for Business Users.** Stored on `Membership.capabilities`, granted
  per person from Users or Access Control:
  - *Computers* — view · remote connect · add · remove/revoke · rename/edit
  - *Support* — use Quick Connect · view active sessions · view session history
  - *Users* — view business users · manage business users
  - *Audit* — view business audit log

  New Business Users default to **View computers + Remote connect** and nothing else. A Business
  Owner implicitly holds every business capability; a Platform Admin holds everything. Nobody can
  edit their own permissions or level.
- **`AccessControlService`** — the one place that answers "which business may this actor touch".
  Every business-scoped read and write goes through `resolveScope()`, and every lookup by id goes
  through `assertEndpointInScope` / `assertBusinessInScope` / `assertUserInScope` before anything is
  read. Cross-business ids return 404, not a filtered-empty 200.
- **Quick Connect.** Temporary support access to a machine that is **not** an enrolled managed
  computer:
  - Public `/quick` landing page — no account, no console exposure, clear security warning.
  - `GET /api/v1/public/quick-connect/download/windows` serves the official RustDesk binary
    **preconfigured for this server** via RustDesk's documented config-in-filename mechanism, so the
    person downloading it never enters a relay host, ID server or key. Cached on disk so a support
    call doesn't depend on GitHub being reachable.
  - Signed-in `/quick-connect` page: Remote ID + Password → Connect.
  - Three switches must all be on: platform master switch → per-business switch → the user's
    `support:quick_connect` capability. Denials are audited with the reason.
  - **No permanent enrollment.** No `Endpoint` row is created; the session record is `isAdHoc`.
  - **The password is never stored, never logged, never placed in a URL.** It is relayed to the
    caller's RustDesk and forgotten. Audit records carry the remote ID, user, business, result and
    source IP — never the password.
- **Redesigned Access Control page** — Overview / Businesses / Business Users / Platform Admins.
  The Overview is three boxes top to bottom instead of seven role cards.
- **Global search** (`GET /api/v1/admin/search`) across businesses, users and computers — by name,
  RustDesk ID, hostname, OS, IP and status. Platform-wide for a Platform Admin, confined to their
  own business for everyone else, using the same scope rule as every other read.
- **Business-scoped API keys.** Every key now belongs to exactly one business and acts as a Business
  Owner **within it only** — never a Platform Admin. Creating a business via the public API is
  refused accordingly.
- **`apps/api/scripts/e2e-business-access.mjs`** — 82 server-side checks covering Platform Admin
  reach, Business Owner confinement, cross-business probing by direct URL and API call, Business
  User permission enforcement, self-escalation attempts, and all eight Quick Connect switch
  combinations.

### Changed
- **`Customer` is the Business.** The table keeps its name (no FK churn), but the domain, API and UI
  all call it a Business. `/api/v1/businesses` is the route; `/api/v1/customers` remains as an alias
  so deployed clients keep working.
- **`Tenant` is now the internal platform container**, not a security boundary. `/api/v1/platform`
  (alias `/api/v1/tenants`) is Platform-Admin-only and holds branding, RustDesk settings and MFA
  policy. Tenant switching (`POST /auth/switch-tenant`) was removed — a person belongs to exactly
  one business.
- **`/auth/me`** now returns `accessLevel`, `businessId`, the business record, and the caller's
  *effective* capabilities, so the UI has one thing to check.
- **JWT re-reads role, business and capabilities from the database on every request.** Revoking a
  capability or moving someone between businesses takes effect on the next request rather than
  whenever their token happens to expire. A disabled or archived business locks its own users out
  immediately.
- **Navigation rebuilt from capabilities** — each nav entry declares what it needs, so a Business
  User only sees what they can actually use. "Updates" now points at `/about` (where the version
  check and changelog live); `/admin/status` is labelled System Status.
- Sessions, notes, sites, audit, dashboard, enrollment tokens and launcher tokens are all business
  scoped. Dashboard counts return zero rather than 403 for capabilities the caller lacks.
- Terminology swept through the UI: Business, Business Owner, Business User, Platform Admin.

### Migrations
- `0008_business_roles_enum` — adds `BUSINESS_OWNER` / `BUSINESS_USER` and the new
  `ActivityAction` values. Split from 0009 because PostgreSQL will not let a newly added enum value
  be used in the transaction that added it.
- `0009_business_access_model` — `Membership.capabilities`, `Customer.quickConnectEnabled`,
  `PlatformSettings` singleton, `customerId` on `ActivityLog` / `SupportSession` / `ApiKey`, plus
  the data migration:
  - Tenant Owner / Tenant Admin → **Business Owner**
  - Technician / Billing Admin / Read Only / Customer Portal → **Business User**, with legacy
    capabilities translated preserving least privilege. An old **Read Only** user becomes a Business
    User **without** `computers:connect`; an old **Billing Admin** — who never had `endpoints:read`
    — gets no computer capabilities at all.
  - Legacy `Role` rows are retained but renamed `(retired) …` and marked non-system so they cannot
    be selected. Pending invitations pointing at them are repointed to Business User.
  - API keys with no business are revoked — resolving them to "everything" would be exactly the
    cross-business hole this release closes. Re-issue per business.

### Security
- Cross-business isolation is enforced in the service layer, not the controller, so a forged path
  parameter, a swapped query string or a direct API call all hit the same check.
- A Business Owner cannot promote anyone (including themselves) to Business Owner, act on a Platform
  Admin, or mint an enrollment token bound to another business.
- Capability strings are allowlisted before they reach the database.
- Deleting a business is refused unless it is genuinely empty; audit history is detached rather than
  deleted.
- `/quick` is matched exactly in the Next.js middleware, not as a prefix — `/quick-connect` and
  `/quickstart` remain authenticated.

---

## [0.7.1] — 2026-08-25 · *Luna*

### Fixed
- **One-click Connect launched RustDesk but the wrong password.** Two root causes:
  1. **`?password=` was URL-encoded plaintext**, but RustDesk 1.4.x expects **base64** in the query string. Fixed in every Connect call site (`/my-computers`, `/connect`, `/endpoints/[id]`, `/sessions`).
  2. **First-write-only guard** on `/enrollment/heartbeat` meant that if a user re-ran the installer on a machine that had already heartbeated, RustDesk got a new local password but the server kept the OLD one. Guard removed — heartbeats always update the stored (encrypted) password. Persistent Windows heartbeat task now includes the current password on every ping so DB stays in sync forever.
- **RustDesk ID missing from Endpoint Detail page.** UI read `ep.rustdeskId` but the API returns `ep.rustdeskNode.rustdeskId`. Fixed.

### Added
- **`rem0te-backup` / `rem0te-restore` scripts** under `deploy/scripts/` — full pg_dump + `/etc/reboot-remote` + hbbs keypair into a single `.tar.gz` (0600). Restore requires `--i-mean-it` to avoid accidental clobber.
- **Maintenance mode** — set `MAINTENANCE_MODE=true` in `api.env` to 503 every non-critical route with a `{code: 'MAINTENANCE'}` body. Auth/login/version/health remain reachable so operators can turn it back off.

---

## [0.7.0] — 2026-08-25 · *Luna*

### Added
- **`ConnectionGrant` model + redemption flow.** `POST /api/v1/endpoints/:id/connect` now mints a short-lived (90 s), single-use, opaque grant token in addition to (for now) returning the direct rustdeskId+password. The token is redeemed via `POST /api/v1/endpoints/grants/redeem` — the launcher path that keeps permanent credentials off the browser. Every grant is audited (`CONNECTION_GRANT_CREATED`, `CONNECTION_GRANT_REDEEMED`, `CONNECTION_GRANT_DENIED`). Redemption re-checks authorization so grants become useless if access is revoked between creation and use.
- **Coordinated credential rotation.** `POST /api/v1/endpoints/:id/rotate-credential` stages a new random password (`pendingPassword` on `RustdeskNode`, encrypted with AES-256-GCM). The endpoint picks it up on its next `/enrollment/heartbeat` response, applies it via `rustdesk.exe --password`, and confirms with a SHA-256 digest via `POST /api/v1/enrollment/confirm-rotation`. The server only swaps `pendingPassword → permanentPassword` on confirmation — **the old password stays valid until the endpoint acknowledges**, eliminating lockout risk. Audited (`ENDPOINT_CREDENTIAL_ROTATION_STAGED`, `ENDPOINT_CREDENTIAL_ROTATED`).
- **Windows installer applies rotations automatically.** The `Rem0teHeartbeat` scheduled task now handles rotation responses, verifies the SHA-256 before applying, calls `rustdesk.exe --password`, and confirms back to the server.

### Fixed
- **"For faster connection, please set up your own server" root cause.** The installer was writing `RustDesk2.toml` into per-user profiles as SYSTEM, so the file was SYSTEM-owned and the interactive user's RustDesk GUI couldn't read it — it fell back to default (public) config and displayed the tip. Installer now `icacls` grants the profile-owning SID read access to both the file and its directory (`icacls $file /grant *<SID>:R`). Effective config on the interactive user's session will now match what we wrote.
- **Endpoints going offline was too aggressive.** Stale-sweeper bumped 8 min → 30 min so older installers that pre-date the persistent heartbeat task aren't flagged offline before the operator can re-run the installer to get the task.
- Manually re-marked existing `DESKTOP-4SADDCN` online in the DB.

### Migrations
- `0006_connection_grants` — new `ConnectionGrant` table; new `RustdeskNode.pendingPassword` + `pendingPasswordAt` fields.
- `0007_rotation_grant_audit` — new `ActivityAction` enum values.

---

## [0.6.0] — 2026-08-25 · *Luna*

### Added
- **Public API for RMM / PSA integration** at `/api/v1/pub/v1/*`. Bearer API-key authentication, per-key scope enforcement, 300 req/min rate limit. Endpoints:
  - `GET /pub/v1/whoami`
  - Companies: `GET/POST /pub/v1/companies`, `GET /pub/v1/companies/:id`
  - Users: `GET /pub/v1/users`, `POST /pub/v1/users/invite`
  - Computers: `GET /pub/v1/computers` (search/filter/paginate), `GET /pub/v1/computers/:id`
  - Managed enrollment: `POST /pub/v1/enrollment/tokens` — returns a ready-to-paste `command` string for Windows/Linux/macOS. `GET /pub/v1/enrollment/tokens` to list.
- **API key management** — `GET/POST/DELETE /api/v1/apikeys`. Key format `rk_<48-hex>`, SHA-256 hashed at rest, raw value returned once at creation only. Configurable expiry (1–3650 days). Audited via `API_KEY_CREATED`, `API_KEY_REVOKED`. Scopes: `companies:{read,write}`, `users:{read,write}`, `computers:{read,write}`, `sessions:read`, `enrollment:write`, `audit:read`.
- **`docs/PUBLIC-API.md`** — reference with curl examples.
- **`apps/api/scripts/e2e-public-api.mjs`** — 8-assertion end-to-end proof: mint → whoami → list → create → mint enrollment → scope enforcement → revoke → verify revocation blocks. All pass against the live dev API.

### Fixed
- **Windows managed endpoints went offline ~10 min after install.** The installer sent a single heartbeat and nothing pinged after. Now installs a persistent `Rem0teHeartbeat` scheduled task (SYSTEM, every 3 min) that reads the RustDesk id via `--get-id` and posts to `/enrollment/heartbeat`. Stale-sweeper tightened from 10 → 8 min.
- **Company list empty in Add Computer.** `customersApi.list()` returns `{success, data:[...]}` but the enroll page read `r.data.data.customers` (undefined). Fixed the wrapping. Same fix applied to the Users → Assign Company dropdown.

### Changed
- **Downloads removed from sidebar.** Product is a managed-computer platform; installers come from the Add Computer flow, not a generic download page.

### Product
- **Link a user to a Company** — `PATCH /users/:userId/customer` + "Assign Company" menu action on the Users page + new "Company" column. Company-wide computers in that customer become visible to any user linked to the same customer.

---

## [0.5.2] — 2026-08-25 · *Luna*

### Fixed
- **Create Company failed with no visible error.** `CreateCustomerDto` (and Site + Note DTOs) had TypeScript property declarations but no `class-validator` decorators. The global `ValidationPipe(whitelist:true, forbidNonWhitelisted:true)` strips every body property without a rule, so `POST /customers {name:'ACME'}` arrived at the service as `{}` and Prisma threw. Added `@IsString`/`@IsEmail`/`@Length`/`@IsBoolean`/`@IsEnum` decorators to Create/Update DTOs across Customers, Sites, and Notes.
- **Platform admin got "No tenant context" on writes** because a fresh platform admin has no `Membership` row, so login left `tenantId=null` in the JWT. Login now falls back to the first active tenant when the user has zero memberships but `isPlatformAdmin=true` — matching the single-tenant-per-install product model.

### Added
- **`apps/api/scripts/e2e-full.mjs`** — walks the entire primary product story against the live API (admin login → create company → invite user → mint token → simulated installer → user login → sees & connects). 9 assertions, all live. Run with `DATABASE_URL=... node apps/api/scripts/e2e-full.mjs`.

---

## [0.5.1] — 2026-08-25 · *Luna*

### Fixed
- **Connect only worked from `/connect`.** The other Connect buttons either raw-launched `rustdesk://` (no password so RustDesk prompted the user) or went through `launcherApi.issueToken` which needs the Tauri launcher installed. Now every Connect call site (`/connect`, `/my-computers`, `/endpoints/[id]`, `/sessions`) uses `POST /endpoints/:id/connect`, copies the stored password to the clipboard, and launches `rustdesk://connection/new/<id>?password=<url-encoded>` — truly one click on modern RustDesk (`?password=` is honored on 1.4.x+), with clipboard as fallback for older builds.
- **Session creation now enforces `ComputerAccess` server-side.** Users without an access row (or COMPANY_WIDE + matching membership) get 403 even with `sessions:create` permission. Platform / tenant owner / tenant admin bypass by design.

### Added
- `POST /api/v1/endpoints/:id/connect` — employee-facing "Connect" API. No admin permission — authorization via `ComputerAccess` or `COMPANY_WIDE + membership`. Returns `{rustdeskId, password}`. Audits every reveal (`ENDPOINT_PASSWORD_REVEALED`, `meta.via='connect'`). Throttled 30/min.
- **Role-aware sidebar.** Employees see only "My Computers". Admins (TENANT_OWNER, TENANT_ADMIN, BILLING_ADMIN, TECHNICIAN, or platform admin) also see the Administration section (Dashboard, Computers, Add Computer, Users, Companies, Sessions, Quick Connect, Audit Log, Settings). Platform admins additionally see a "Platform" section (Security, Unassigned Computers).

### Security
- **GitHub PAT auth reworked.** No more URL-embedded credentials. PAT lives in `~/.git-credentials` (0600) with `credential.helper=store`; `git remote -v` shows only the plain HTTPS URL. Prior PAT rotated.

---

## [0.5.0] — 2026-08-25 · *Luna*

### Product model
Rem0te is a **business remote-access platform** — companies grant their users access to specific company computers. Not an RMM. Internal `tenantId` naming remains for backwards compatibility; the UI now says "Company" and "Computers."

### Added
- **`ComputerAccess` (many-to-many User ↔ Endpoint)** — migration `0004_computer_access`. Primary authorization table for "John can connect to JOHN-OFFICE-PC." Plus per-endpoint `accessMode` (`ASSIGNED_USERS` | `COMPANY_WIDE`).
- **Token-bound managed enrollment**. `DeviceClaimToken` now carries `customerId`, `accessMode`, `assignedUserIds[]`, `endpointGroupId`, `createdById`. The endpoint that redeems the token cannot influence any of these — the values are stamped on the endpoint + `ComputerAccess` atomically inside `claimEndpoint`. All `assignedUserIds` are validated at token-mint time to belong to the same tenant.
- **Path-token installer URLs** — `GET /api/v1/public/install/win/:token`, `linux/:token`, `mac/:token`. Token lives in the URL path, not a query string, so it doesn't spill into proxy logs or `Referer` headers.
- **`GET /api/v1/endpoints/mine`** — employee-facing "My Computers" endpoint. Returns only computers the caller has explicit `ComputerAccess` for (plus company-wide ones in their customer).
- **Access management API** — `GET/POST /endpoints/:id/access`, `DELETE /endpoints/:id/access/:userId`, `PATCH /endpoints/:id/access-mode`. Every action audited (`ENDPOINT_ACCESS_GRANTED`, `ENDPOINT_ACCESS_REVOKED`).
- **Web: `/endpoints/enroll` — Add Computer page.** Company + access-mode (specific users or company-wide) + platform → generates a token-bound install command. Copy-to-clipboard.
- **Web: `/my-computers` — employee view.** Shows only the computers this user has been granted access to, with a Connect button.

### Fixed
- **Windows installer wrote its config only into the service profile, so the interactive user's RustDesk GUI kept showing "For faster connection, please set up your own server."** The installer now:
  - Enumerates real user profiles from `HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList` (not a naive `C:\Users` scan that swept in `Public`).
  - Writes `RustDesk2.toml` into **every** user profile that has AppData, **plus** `C:\Users\Default` so future first-logins inherit the Rem0te config.
  - Kills any user-session RustDesk GUI/tray after writing so it re-reads on next launch.
- **Effective-config verification now covers every profile, not just the SYSTEM one that ran the installer.** Detects service ↔ user divergence and repairs it before returning. Exit 20 (hard fail) if any profile is still pointing at `rustdesk.com` after repair — no more "success" on a public-server client.

### Migrations
- `0004_computer_access` — new `ComputerAccess` table + `EndpointAccessMode` enum; extends `Endpoint` with `accessMode`; extends `DeviceClaimToken` with `customerId`, `accessMode`, `assignedUserIds`, `endpointGroupId`, `createdById`.
- `0005_access_audit_events` — extends `ActivityAction` with `ENDPOINT_ACCESS_GRANTED`, `ENDPOINT_ACCESS_REVOKED`.

---

## [0.4.0] — 2026-08-25 · *Luna*

### Fixed
- **Managed Windows installer never reached our hbbs.** Root cause: RustDesk 1.4.9 did not honor the shotgun `RustDesk2.toml` writes we did across every profile — the service continued to negotiate with `rs-*.rustdesk.com`, so no device ever appeared in the Rem0te dashboard and the "For faster connection, please set up your own server" banner remained.

### Changed
- **Rewrote `GET /public/install/windows.ps1` end-to-end.** Now uses the officially supported RustDesk MSP techniques instead of file-writing:
  - Downloads the setup executable renamed to `rustdesk-host=<HOST>,key=<KEY>.exe` so RustDesk parses the server config from its own filename during install (atomic, no race).
  - After install, runs `rustdesk.exe --config <base64>` where the payload is `host=…,key=…,api=,relay=…` — updates RustDesk2.toml + rendezvous_server via the CLI, the same path an OEM build uses.
  - Deletes any stale RustDesk2.toml from prior installs before applying so an old rendezvous can't linger.
  - Also writes the LocalSystem service's `RustDesk2.toml` as belt-and-braces for older 1.4.x builds where `--config` regressed.
- **Effective-config verification.** Reads back `custom-rendezvous-server` and refuses to report success if it still matches `*.rustdesk.com`. Fails with exit code 20 instead of silently marking a public-server client as "installed."
- **Reliable device-ID retrieval.** Uses `rustdesk.exe --get-id` as the primary source, falls back to scanning the LocalSystem `RustDesk.toml`. Retries for 2 minutes rather than 45 seconds.
- **Background enrollment retry.** If ID acquisition or the API call can't complete during the installer's window, a `Rem0teEnrollment` scheduled task is installed (SYSTEM, `SC MINUTE /MO 5`) with a state file at `C:\ProgramData\Rem0te\enroll.dat` (SYSTEM/Administrators ACL only). It self-deletes as soon as enrollment succeeds, and after 24 hours regardless.
- **Non-interactive-safe.** `Read-Host` is skipped when `[Environment]::UserInteractive` is false, so RMM / Intune / GPO deployment doesn't hang. Meaningful exit codes: 0 ok, 2 not-admin, 10 download failure, 11 install failure, 20 verification failure.
- **Installer log** at `C:\ProgramData\Rem0te\Logs\install.log`. No secrets, no tokens, no passwords.
- **Password no longer displayed.** The internal RustDesk compatibility password is generated as 20 characters of URL-safe RNG on the endpoint and sent server-side over TLS via `enrollment/heartbeat` — never printed to the console, never in the log.

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
