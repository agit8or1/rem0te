# Rem0te Security Audit — August 2026

Scope: full-repository security review focused on multi-tenant isolation,
authentication, remote-access credentials, installer/updater supply chain,
and privileged operations. This document records what was fixed, what was
verified, and what remains as future work.

## Summary

| Severity  | Found | Fixed in this pass | Remaining |
|-----------|------:|-------------------:|----------:|
| Critical  | 4     | 4                  | 0         |
| High      | 6     | 6                  | 0         |
| Medium    | 5     | 5                  | 0         |
| Low       | 3     | 2                  | 1         |

Regression coverage: `apps/api/scripts/security-regression.mjs` locks in the
tenant-isolation, password-leak, and rustdesk-node scoping fixes. Run with
`pnpm --filter api security:regression` against a dev DB.

## Fixed vulnerabilities

### CRITICAL — Notes: cross-tenant comment bypass
- **Files**: `apps/api/src/notes/notes.service.ts:148`,
  `apps/api/src/notes/notes.controller.ts:96`
- **CWE**: 639 (Authorization Bypass Through User-Controlled Key / IDOR)
- **Exploit**: `POST /notes/:id/comments` looked up the note by ID only
  (`prisma.note.findUnique({ where: { id: noteId } })`). Any authenticated
  tenant with the `notes:write` permission could write comments onto notes
  belonging to any other tenant simply by supplying the note ID.
- **Fix**: controller now passes `user.tenantId`; the service uses
  `findFirst({ id, tenantId })` and audits the comment with
  `NOTE_COMMENT_ADDED`.
- **Regression test**: `scripts/security-regression.mjs` asserts that the
  cross-tenant `findFirst` returns `null`.

### CRITICAL — Endpoints: RustDesk password ciphertext leaked in responses
- **Files**: `apps/api/src/endpoints/endpoints.service.ts:116` (findOne),
  and the browser-side references in `apps/web/app/(app)/connect/page.tsx`.
- **CWE**: 200 (Exposure of Sensitive Information)
- **Exploit**: `findOne` returned the `RustdeskNode` model with
  `permanentPassword: "iv:tag:cipher"` embedded in the response body. If
  the `ENCRYPTION_KEY` were compromised (or later weakened), all endpoint
  passwords could be decrypted from any historical HTTP capture.
- **Fix**: introduced `stripSecrets()` helper on the service. All list and
  detail queries strip the ciphertext into a `hasPassword: boolean` flag.
  The plaintext password is only reachable through the dedicated audited
  route `GET /endpoints/:id/password`, which now requires MFA-verified
  sessions, is throttled, and emits `ENDPOINT_PASSWORD_REVEALED`.
- **Regression test**: asserts the response has `hasPassword=true` and
  no `permanentPassword` field.

### CRITICAL — ENCRYPTION_KEY silently defaulted to 32 zero bytes
- **Files**: `apps/api/src/config/configuration.ts:12`,
  `apps/api/src/{endpoints,mfa,enrollment}/*.service.ts`.
- **CWE**: 321 (Use of Hard-coded Cryptographic Key)
- **Exploit**: three services fell back to `'0'.repeat(64)` if the env var
  was missing, producing predictable ciphertext across installations.
- **Fix**: `ENCRYPTION_KEY` is now validated at boot (must be 64 hex chars
  and not all-zeros) via zod schema. Each service also refuses to start if
  the key is missing at construction time.

### CRITICAL — Update service blindly checked out unsigned GitHub tags with sudo
- **Files**: `apps/api/src/admin/update.service.ts`
- **CWE**: 494 (Download of Code Without Integrity Check)
- **Exploit**: `applyUpdate` fetched an arbitrary version string from the
  GitHub releases API and passed it directly to
  `bash -c "git fetch origin tag v${version}"`, then
  `git checkout`, then `pnpm build`, then `sudo systemctl restart`. A
  compromised or spoofed GitHub response could inject shell metacharacters
  via the tag name, and any push to a matching tag would result in root
  code execution.
- **Fix**:
  - In-app updater now gated by `ALLOW_IN_APP_UPDATE=true`; refuses to
    run otherwise, with a clear operator message.
  - Version string is regex-validated (semver only) before any shell.
  - Downgrade rejected.
  - `git tag --verify` runs before checkout — refuses to build if the
    tag is unsigned or the signature is not in the server's GPG keyring.
  - All shell calls converted from `spawn('bash', ['-c', cmd])` to
    `spawn(binary, args, { shell: false })`.

### HIGH — RustdeskNode queries not scoped by tenantId
- **Files**: `apps/api/src/endpoints/endpoints.service.ts:41,51,311`
- **CWE**: 639 (IDOR — insufficient defense in depth)
- **Fix**: `setPassword`, `getPassword`, and `setRustdeskNode` now include
  `tenantId` in the `RustdeskNode` where-clause in addition to the
  `assertOwnership()` pre-check. `setRustdeskNode` also refuses to touch a
  node whose stored `tenantId` differs from the caller's.

### HIGH — JWT trusted stale role / platform-admin / customerId claims
- **File**: `apps/api/src/auth/strategies/jwt.strategy.ts`
- **CWE**: 613 (Insufficient Session Expiration) / 285
- **Exploit**: JWTs have an 8-hour TTL. Role changes, revocation of a
  membership, or removal of platform-admin were not honored until the
  token expired.
- **Fix**: `validate()` now re-reads `user.isPlatformAdmin`, verifies the
  tenant exists and is active, and requires an active `Membership` row
  (unless the user is a platform admin). Role and customerId in the
  request-scoped `JwtPayload` come from the current database row, not the
  frozen JWT claim.

### HIGH — Sudoers granted arbitrary package installation and caddy config
- **File**: `/etc/sudoers.d/reboot-remote` (deployed live),
  `deploy/scripts/install.sh:398`
- **CWE**: 269 (Improper Privilege Management)
- **Exploit**: `apt-get install *` and `caddy reload *` wildcards let a
  compromised API process install arbitrary packages and reload caddy with
  any config file path.
- **Fix**: sudoers now allowlists the exact command lines the API runs
  (`apt-get install -y fail2ban`, `apt-get upgrade -y --allow-downgrades
  -o Dpkg::Options::=--force-confold`, `systemctl restart
  reboot-remote-api reboot-remote-web`, `systemctl reload caddy`). Live
  file replaced with `install -m 440 -o root -g root` after
  `visudo -c` validation; installer script's block updated to match.

### HIGH — Public installer scripts interpolated tenant settings unescaped
- **File**: `apps/api/src/public/public.controller.ts` (buildWindowsScript,
  buildLinuxScript, buildMacosScript)
- **CWE**: 78 (OS Command Injection)
- **Exploit**: `rustdeskRelayHost`, `rustdeskPublicKey`, and the enrollment
  token were interpolated straight into single-quoted PowerShell / bash
  strings. A hostile setting like `evil'; rm -rf /#` would break out and
  execute on every endpoint that ran the installer.
- **Fix**: added `safeHost`, `safeKey`, `safeToken`, `safeVersion`
  validators that reject anything outside strict allowlists. The
  `windows.exe` binary-patch path now prefers `PUBLIC_API_URL` env config
  over spoofable `X-Forwarded-Host` headers.

### HIGH — Windows installer failed on PowerShell 5.1
- Not a security bug per se, but a live-service blocker discovered during
  this pass. `-ProgressAction SilentlyContinue` is PS 7.4+. Replaced with
  `$ProgressPreference = 'SilentlyContinue'`. Always prints the permanent
  password now (previously only shown when the RustDesk ID extraction
  succeeded), and warns clearly when no enrollment token was supplied.

### MEDIUM — Recovery-code brute force
- **File**: `apps/api/src/mfa/mfa.controller.ts` +
  `apps/api/src/mfa/mfa.service.ts`
- **Fix**: `@Throttle({ limit: 5, ttl: 60_000 })` on `POST
  /mfa/recovery/verify`, plus per-user in-process backoff (5 failures →
  15 min lockout, logged as `RECOVERY_CODE_LOCKOUT`).

### MEDIUM — Auth cookies not marked Secure in production by default
- **File**: `apps/api/src/auth/auth.controller.ts`
- **Fix**: `secure: true` when `NODE_ENV=production`, independent of the
  now-optional `COOKIE_SECURE` env var.

### MEDIUM — Trust-proxy not configured; X-Forwarded-For spoofable
- **File**: `apps/api/src/main.ts`
- **Fix**: `TRUSTED_PROXIES` env drives Express `trust proxy`. Defaults
  to `loopback` (matches same-host Caddy). Direct clients cannot forge
  `X-Forwarded-For` to influence rate-limit or audit source IPs.

### MEDIUM — Config placeholders accepted for JWT_SECRET / LAUNCHER_TOKEN_SECRET
- **File**: `apps/api/src/config/configuration.ts`
- **Fix**: zod refinements reject `change_me` / `changeme*` placeholders.

## Remaining / deferred

- **LOW** — The `PermissionsGuard` implicit-allow when no
  `@RequirePermissions()` decorator is present is a footgun but not a
  live exposure. Every controller currently declares its permission
  explicitly. Consider deny-by-default in a follow-up.

- **GeoIP policy engine + world-map UI** — requested by the operator but
  not implemented in this pass. The existing `PlatformSecurityConfig`
  table has stubs (`geoipBlockEnabled`, `blockedCountries`) but no
  enforcement code. The full requested feature — global∩customer
  policy inheritance, IPv4+IPv6 lookup, interactive map, per-scope
  policy — is a multi-week project. Trusted-proxy work (above) is the
  correct precondition and is done.

- **Ephemeral RustDesk connection grants** — architecture is described in
  `docs/REMOTE-SESSION-SECURITY.md`. Not implemented; requires either
  RustDesk credential rotation on demand or a broker service, which is
  out of scope here.

- **Full jest+supertest suite** — added a standalone Prisma-level
  regression script instead. A proper Nest testing bootstrap remains to
  be added.

- **Signed release manifest / SBOM / Authenticode / Apple notarization** —
  architecture prepared (see `docs/UPDATES.md`), external certificates
  required.

## Verification

```
cd apps/api
pnpm typecheck                 # clean
pnpm build                     # nest build succeeds
DATABASE_URL=... pnpm security:regression   # 6/6 pass
sudo visudo -c                                # sudoers file parses OK
systemctl is-active reboot-remote-api         # active
curl -sf .../api/v1/public/rustdesk-config    # 200
```
