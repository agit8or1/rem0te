# Working in this repo

## Every change bumps the version

**Do not commit a change without bumping the version and writing the changelog
entry in the same commit.** Not "at release time" — every change.

This is not bookkeeping. `version.json` drives the version banner, the in-app
update check, and what the Updates page reports; an endpoint decides whether to
re-run its installer by comparing versions. A version that does not move makes
all of that lie. It happened: a long run of work shipped under `0.8.2` while it
piled up under an `## [Unreleased]` heading nobody converted.

Five files, and they must agree:

| File | What it is |
|---|---|
| `version.json` | Source of truth — also carries `codename` and `releaseDate` |
| `package.json` | Workspace root |
| `apps/api/package.json` | |
| `apps/web/package.json` | |
| `CHANGELOG.md` | A `## [x.y.z] — YYYY-MM-DD · *Codename*` section for that exact version |

Then:

```bash
node scripts/check-versions.mjs
```

It fails if the four version strings disagree, or if `CHANGELOG.md` has no
section for the current version. CI runs it on every push and pull request.

**Which number to move:**

- **Patch** (`0.9.0` → `0.9.1`) — a fix, no new surface.
- **Minor** (`0.9.0` → `0.10.0`) — a new page, route, capability, or anything a
  user would notice as new.
- **Codename** changes with the minor version, not every patch.

Write the changelog entry for someone debugging this six months from now: what
broke, what the symptom looked like, and why the fix is what it is. The existing
entries set the bar.

## Getting a change onto `main`

`main` is protected by a repository ruleset: deletions and force pushes are
blocked, and `check`, `audit` and `installer` must pass. **Direct pushes are
refused** — CI runs on push, so a new commit has no checks to read and the push
is rejected.

```bash
git switch -c some-change
# … work, and bump the version as above …
git push -u origin some-change
gh pr create --fill
gh pr checks --watch
gh pr merge --squash --delete-branch
```

There are no bypass actors, deliberately: an owner exemption restores direct
pushes for emergencies and makes the rule advisory, which is how most branch
protection ends up meaning nothing. `docs/github-about.md` holds the settings
and the reasoning.

## Deploying

Build in the checkout, rsync to `/opt/reboot-remote`, restart the units:

```bash
cd apps/api && npx nest build
cd ../web && npx next build
sudo rsync -a --delete apps/api/dist/ /opt/reboot-remote/api/dist/
sudo rsync -a --delete --exclude 'apps/web/.next/static/' \
  apps/web/.next/standalone/ /opt/reboot-remote/web/standalone/
sudo rsync -a apps/web/.next/static/ \
  /opt/reboot-remote/web/standalone/apps/web/.next/static/
# `public/` is NOT part of the standalone output and must be copied too —
# without it every documentation screenshot 404s.
sudo rsync -a --delete apps/web/public/ \
  /opt/reboot-remote/web/standalone/apps/web/public/
sudo cp version.json CHANGELOG.md /opt/reboot-remote/
sudo chown -R reboot:reboot /opt/reboot-remote/api/dist /opt/reboot-remote/web/standalone \
  /opt/reboot-remote/version.json /opt/reboot-remote/CHANGELOG.md
sudo systemctl restart reboot-remote-api reboot-remote-web
```

**A schema change needs two more steps**, or the API throws
`Unknown field ... on model ...` at runtime: the deploy target has its own
`node_modules`, so the Prisma client there is generated from the schema that was
present at install time, and `dist/` does not carry it.

```bash
cd apps/api && DATABASE_URL=... npx prisma migrate deploy   # apply the migration
sudo rsync -a apps/api/prisma/ /opt/reboot-remote/api/prisma/
cd /opt/reboot-remote/api && sudo npx prisma generate       # regenerate the client there
sudo chown -R reboot:reboot /opt/reboot-remote/api/prisma /opt/reboot-remote/api/node_modules/.prisma
```

Client chunks are **added, never deleted** — that is what the `--exclude` and the
second rsync are for. Next.js requests chunks by content hash, and deleting the
previous build's files 404s every browser that already had the app open.

## Things that will bite you

- **The deploy target is not a git checkout.** `/opt/reboot-remote` has no
  `.git`. Build in the source tree.
- **The API's runtime dependencies live at the target, installed by npm**, in
  `/opt/reboot-remote/api/node_modules` with its own `package.json` and
  `package-lock.json`. `dist/` carries none of them. So when a production
  dependency moves, rsyncing `dist` alone ships new code onto old libraries —
  and it only breaks on the *next restart*, which may be an unattended reboot
  hours later.

  This is the same trap as the Prisma client below, one level up. That target
  manifest is **generated, not copied** — `apps/api/package.json` cannot be
  used as-is, because its devDependencies carry an eslint 9 / `@eslint/js` 10
  peer conflict that pnpm tolerates and npm refuses, so `npm install
  --omit=dev` dies on dependencies the target will never install. When
  `apps/api/package.json` dependencies change:

  ```bash
  pnpm deploy:manifest -o /tmp/prod-package.json          # generate
  cd /tmp && npm install --omit=dev --package-lock-only   # must exit 0
  sudo cp /tmp/prod-package.json /opt/reboot-remote/api/package.json
  cd /opt/reboot-remote/api && sudo npm install --omit=dev
  ```

  **Check that npm can resolve the tree before rsyncing anything**, because
  pnpm and npm disagree: pnpm is lenient about peer ranges and npm is not. A
  NestJS 12 bump passed all of CI under pnpm and was refused outright by npm at
  the target. And check the exit code, not the output — `npm install | tail`
  exits 0 whatever npm thought of it.

  The manifest was hand-maintained until v0.18.13 and had drifted a long way:
  the target was running zod 3.25, ioredis 5.10, helmet 7.2 and
  `@anthropic-ai/sdk` 0.52 while `dist` was compiled against zod 4, ioredis 6,
  helmet 8 and sdk 0.125. It also claimed `version: 0.3.6`. Nothing failed,
  because nothing compares the two. Generating it is what stops that.
- **Never `pkill -f 'node dist/main.js'`** — it matches the production API.
  Use PIDs.
- **Every capture script seeds demo businesses and computers.** Point them at a
  scratch database, never a live one — see *Capturing media* below. `output:
  'standalone'` bakes the Next rewrite destination in at build time, so
  `INTERNAL_API_URL` at runtime is ignored; patch `server.js` and
  `routes-manifest.json` in a **copy** of the build, not the build itself.
- **The API sweeps `isOnline` from staleness.** A demo database seeded twenty
  minutes before a capture has already drifted: machines seeded online start
  reporting Offline and the dashboard stops agreeing with the inventory. Run
  `prisma/_docs-demo-refresh.ts` immediately before capturing.
- **`EndpointStatus.OFFLINE` is a dead enum value.** Nothing in the API writes
  it. Enrolment lifecycle is `status`, connectivity is `isOnline`, and the
  dashboard counts `ACTIVE` rows and derives offline from the flag — so marking
  a disconnected machine OFFLINE hides it from the totals entirely.
- **Generated PowerShell cannot be syntax-checked here.** There is no PowerShell
  on the host. `RustdeskService.joinPs()` refuses the mistakes that are not
  visible to a brace count; add to it rather than eyeballing.
- **hbbs logs nothing when a connection fails.** Use
  `deploy/scripts/hbbs-probe.py <id>`. Note it sends a real punch-hole, so the
  endpoint will dial the relay as a side effect.

## Security invariants

```bash
node scripts/check-security-invariants.mjs
```

Static checks for protections that have failed silently before: a rate-limit
decorator naming a throttler that is not configured, a pre-MFA token being
accepted as a session, the device heartbeat trusting a RustDesk ID, an
unrestricted `fail2ban-client` sudo grant, the launcher trusting a link's API
address, and read-test-write on single-use tokens. Each one was a real finding
in the 0.13.0 review; none of them threw, logged, or failed a test.

CI runs it on every push and pull request, alongside `check-versions.mjs`.

## Docs

`docs/README.md` is the index, and the same pages are compiled into the app at
`/docs` by `apps/web/scripts/gen-docs-bundle.mjs`, which runs as `prebuild`.
**A new page must be added to that script's `ORDER` list or the build fails** —
deliberately, because a page that silently never appears is how the
documentation came to be invisible in the first place.

`docs/API-REFERENCE.md` is generated: `node scripts/gen-api-reference.mjs`.
Verify it with `--check <file of RouterExplorer lines>`; it must match the
runtime route table exactly. When behaviour changes, the page that describes
it changes in the same commit — `docs/connecting.md`, `docs/clients.md`,
`docs/updates.md`, `docs/troubleshooting.md`, `docs/architecture.md`. The in-app
copy at `/help` is separate and also needs updating.

## Capturing media

Two audiences, two toolchains, and they do not share files:

| Script | Writes | Consumed by |
|---|---|---|
| `apps/web/scripts/screenshots.mjs` | `docs/screenshots/` | The in-app docs at `/docs` — numbered-callout guide images |
| `apps/web/scripts/capture-media.mjs` | `docs/images/github/` | The GitHub gallery, `docs/screenshots.md` |
| `apps/web/scripts/capture-video.mjs` | `media/raw/*.webm` | `scripts/build-video.sh` |
| `scripts/build-video.sh` | `media/*.mp4`, `media/poster*.png` | GitHub **release assets** |

**`media/` is gitignored and must stay that way.** Video binaries do not belong
in Git history; publish the finished files as release assets and link to them.
The rule is root-anchored (`/media/`) on purpose — a bare `media/` also matches
`docs/media/`, which holds the walkthrough transcript and captions and *is*
tracked.

**Never capture against production.** Both capture scripts refuse an `https://`
target or port 3000/443 outright, and `prisma/_docs-demo-data.ts` refuses any
database whose name is not `reboot_remote_docs`. Those guards are the safety
net, not the plan — stand up the isolated stack described in
`docs/screenshots.md` ("Regenerating these").

**Themes come from the application's own store**, `localStorage.theme`, which
`ThemeProvider` turns into `<html class="dark">`. Never simulate a theme with a
CSS filter: the point of a theme screenshot is that it is the shipped theme.

**Masking happens in the DOM immediately before the shutter** and never writes
back to the database. It covers enrollment tokens, long hex secrets, RustDesk
IDs, public IP addresses, and any FQDN outside a small allowlist
(`mspreboot.com`, `github.com`, `rustdesk.com`, `example.com` are kept
deliberately). This is not belt-and-braces: the demo API reads the *real* host,
so the Security page names the live deployment's certificate domain and the
audit log shows whatever addresses the demo data carries. Both were caught by
masking, not by review.

Credentials are passed as environment variables — never written into a script,
a manifest, or the repository. `docs/images/github/manifest.json` records the
route, theme and viewport behind every image and is safe to commit.

`docs/screenshots.md` is excluded from the in-app docs bundle (`NOT_IN_APP` in
`gen-docs-bundle.mjs`) because its images live in `docs/images/github/`, which
that script does not mirror — bundling it would put 31 broken images inside
`/docs`.
