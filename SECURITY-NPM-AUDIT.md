# SECURITY-NPM-AUDIT — rem0te (pnpm workspace)

**Date:** 2026-06-08
**Trigger:** npm Shai-Hulud / Mini Shai-Hulud supply-chain incident defensive sweep
**Package manager:** pnpm 11.5.2 via corepack (`--lockfile-only --ignore-scripts` throughout)

## Workspace layout

```
rem0te/
├── package.json              (root, packageManager unset)
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── packages/
│   └── types/package.json    (@reboot-remote/types)
└── apps/
    ├── launcher/package.json (@reboot-remote/launcher — Tauri + Vite + React)
    ├── api/package.json      (api — NestJS 11 + Prisma)
    └── web/package.json      (@reboot-remote/web — Next.js + Tailwind)
```

No `.npmrc` / `.yarnrc.yml`. No `node_modules` committed.

## Lifecycle scripts found

None of `preinstall/install/postinstall/prepack/prepare/prepublish*` in any of the 5 `package.json` files. Standard scripts only (`dev`, `build`, `start`, `lint`, `typecheck`, prisma helpers, tauri helpers).

Lockfile install-script packages were all common native-compile / build-time tooling — none anomalous.

## Supply-chain indicator scan

| Indicator | Result |
|---|---|
| `@tanstack/*` | one hit: **`@tanstack/react-query@5.59.20`** in `apps/web` (resolved 5.90.21). Not in any known compromised version window. No remediation needed; flagged for awareness. |
| `@antv/*`, `@redhat-cloud-services/*`, `@mistralai/*`, `@bitwarden/cli`, `plain-crypto-js` | none |
| `axios@1.14.1` / `axios@0.30.4` | none — was resolved at 1.13.6 (affected by ~12 patched CVEs unrelated to the Shai-Hulud window), now at 1.17.0 |
| Non-default registry / git / tarball resolutions | none — all integrity-pinned from `registry.npmjs.org` |
| `.npmrc` / `.yarnrc.yml` with tokens | none — no rc files present |

**No obvious Shai-Hulud-style compromise indicators found.**

## What was updated

Targeted within-range updates via `pnpm update -r --lockfile-only --ignore-scripts`. No `--latest`, no major bumps, except for one **explicit `next` patch-version bump in `apps/web/package.json`** (see below).

### Direct dep changes in `apps/web/package.json`
| Package | Was | Now | Reason |
|---|---|---|---|
| `next` | `14.2.18` (exact pinned) | `14.2.35` | **CRITICAL**: Next.js middleware authorization bypass (CVE-2025-29927 fixed in 14.2.25+) plus ~8 other Next 14.2.x CVEs. Stays in same major (14.2.x). |
| `eslint-config-next` | `14.2.18` | `14.2.35` | Keep matched with `next`. |
| `axios` | `^1.7.7` | `^1.17.0` | Was resolving to 1.13.6 (vulnerable to ~12 axios CVEs); 1.17.0 is the within-major patched version. |

### Direct dep changes in `apps/api/package.json`
Range-only floor bumps (no major changes). All `@nestjs/*` stay on `^11.x`; Prisma stays on `^5.x`; ioredis stays on `^5.x`; zod stays on `^3.x`; typescript stays on `^5.x`. Examples:
- `@nestjs/common`: `^11.0.0` → `^11.1.24`
- `@prisma/client`: `^5.14.0` → `^5.22.0`
- `zod`: `^3.23.8` → `^3.25.76`
- `typescript`: `^5.4.5` → `^5.9.3`

### Direct dep changes in `apps/launcher/package.json`
Range-only floor bumps (Tauri 2.x stays on 2.x, Vite 5.x stays on 5.x). Examples:
- `@tauri-apps/api`: `^2.1.1` → `^2.11.0`
- `@vitejs/plugin-react`: `^4.3.2` → `^4.7.0`

No packages added or removed in any package.json.

## Advisories

| | Before | After |
|---|---|---|
| critical | **1** (Next.js middleware auth bypass) | **0** |
| high | 26 | 6 |
| moderate | 40 | 11 |
| low | 5 | 2 |
| **total** | **72** | **19** |

### Remaining advisories — why they're not yet fixed

All 19 remaining advisories fall into two deferred buckets:

**(a) Next.js 15.x major migration required — 14 of 19.** All remaining `next` CVEs are patched only in 15.x (15.0.8, 15.5.10, 15.5.13, 15.5.14, 15.5.15, 15.5.16). Bumping to 15 is a real migration (React 19 alignment, new caching semantics, App Router API changes) — explicitly **deferred** per the audit rule that we don't do broad `--latest` updates without justification. Track this as a separate ticket.

**(b) Deep transitive deps — 5 of 19.** Pulled in via `@nestjs/cli`, `eslint-config-next`, `tailwindcss`. Each could be addressed via `pnpm.overrides`:
- `lodash` → `^4.17.24`
- `glob` → `^10.5.0` (high)
- `picomatch` → `^4.0.4` (high)
- `path-to-regexp` → `^8.4.0` (high)
- `brace-expansion` → `^2.0.2`
- `fast-uri` → `^3.1.2` (high)
- `flatted` → `^3.4.2` (high)

These are deferred because the active campaign indicators are clean and the residual exposure is mostly upstream tooling (CI/lint paths), not the runtime HTTP surface.

## Files changed in this audit

- `pnpm-lock.yaml` — full re-resolution (within declared ranges)
- `package.json` (root) — minor changes from `pnpm update -r`
- `apps/api/package.json` — within-range floor bumps
- `apps/launcher/package.json` — within-range floor bumps
- `apps/web/package.json` — `next`, `eslint-config-next`, `axios` bumps (see table above)
- `pnpm-audit.before.json`, `pnpm-audit.after.json` — full advisory snapshots
- `SECURITY-NPM-AUDIT.md` — this file

`packages/types/package.json` unchanged (no deps).

## Builds / tests skipped

Per audit policy, **no** `pnpm install` / `pnpm build` / `pnpm test` / Prisma generation was executed — all lockfile work was `--lockfile-only --ignore-scripts`. A clean install in CI with `--ignore-scripts` is recommended before merging; the existing `apps/launcher` Tauri builds in particular need a real install to validate native compile steps.

## Manual follow-ups

1. **Next.js 14 → 15 migration ticket** — clears the remaining 14 advisories (incl. high-severity SSRF, DoS, middleware bypass in i18n Pages Router).
2. **Decide on `pnpm.overrides`** for transitive `lodash`, `glob`, `picomatch`, `path-to-regexp`, `brace-expansion`, `fast-uri`, `flatted`. Low risk individually, but each adds an override entry to maintain.
3. **Set `packageManager` field** in root `package.json` (currently unset — pnpm 11.5.2 warned). Pinning the manager makes corepack pull the right pnpm version automatically.
4. **Remove the legacy `pnpm.onlyBuiltDependencies` field** from root `package.json` (pnpm 11+ ignores it; warning in audit output).
