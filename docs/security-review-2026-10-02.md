# Security review — 2026-10-02

## Changes

- Signed full sessions include an HMAC fingerprint of the current password hash. JwtStrategy checks it against the database, so password resets invalidate old sessions. Partial MFA tokens remain unable to authorize normal API requests.
- Update Next.js from 16.3.5 to 16.3.6, refresh its lockfile, and raise brace-expansion/fast-uri security floors.

## Validation

API build and web TypeScript checks passed. Prisma client generation used no live database. Run the isolated strategy tests after the API build:

```sh
pnpm --filter @reboot-remote/api build
node apps/api/scripts/session-revocation.test.cjs
```

Four tests passed for old/new credentials, legacy tokens, partial MFA and suspended/deleted users. Prisma calls are in-memory doubles; full login/MFA/database integration and a production Next.js build were not exercised.

## Rollout and residual scope

Use pnpm 11.27.0 as pinned by packageManager, install with the updated frozen lockfile, generate the Prisma client, build and deploy through the existing workflow. All existing full sessions will need to sign in again. No schema migration is required. Password-reset revocation is covered; ordinary logout remains cookie clearing without a token denylist.

The Next.js advisory GHSA-vcvr-r3jv-pc5j applies to specific untrusted next/og SVG rendering. No next/og/ImageResponse use was found in this source tree; the version match is patched without claiming this application had a reachable RCE.

braces 3.0.3 remains in transitive tooling and matches GHSA-vfj7-8cjw-p6xm with no patched release listed in OSV. Avoid untrusted build/glob patterns.
