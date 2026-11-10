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

### The one exception: development-only dependency bumps

**A merge that touches only devDependencies does not get its own release.**
These accumulate on `main` and are folded into the next release — the next one
that ships anything, or a batched one at most weekly if nothing else is due.

The reason is that a release for a devDependency records a change that cannot
reach production. The API's production manifest is generated with no
devDependencies at all (`pnpm deploy:manifest`), so `dist` and the target's
`node_modules` are byte-identical before and after. Two of these were cut an
hour apart on 2026-09-18 — 0.18.14 for fifteen dev bumps and 0.18.15 for a
single `eslint-config-next` patch — each costing a branch, a pull request,
three CI jobs, a tag, a release and an API restart to record nothing a user or
an endpoint can observe. `version.json` is read by the update check and by
endpoints deciding whether to re-run their installer; moving it for a lint
plugin makes those consultations meaningless.

So for a devDependency-only merge:

- Let Dependabot's commit land as it is. `check-versions.mjs` still passes —
  it asserts the five version strings agree and that the changelog documents
  the current one, and a dev bump changes none of that.
- Note it in the *next* release's entry, in one line, alongside whatever else
  ships.
- If a month of them piles up with no other release due, cut one batched
  entry listing them.

**This exception is narrow.** It is devDependencies only. A production
dependency reaches the target and gets the full treatment — bump, changelog,
release, deploy with the manifest regenerated and `npm install --omit=dev` run
at the target. If a change touches both, it is a production change.

Dependabot already batches the pull requests themselves: the npm entry runs
`monthly` with devDependencies in one `development` group, so this policy is
about the release cadence, not the PR cadence. A second dev group PR appearing
days after the first usually means someone rewrote the first one's branch, as
happened with #34 and #35 — Dependabot re-raises whatever it still wants.

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
- **Generated PowerShell has no PowerShell to check it on the host.**
  `RustdeskService.joinPs()` refuses the mistakes that are not visible to a
  brace count; add to it rather than eyeballing. For a real parse, unpack the
  portable `powershell-<v>-linux-x64.tar.gz` release into a scratch directory
  (nothing is installed) and run
  `[System.Management.Automation.Language.Parser]::ParseFile()` over a script
  generated from `dist`. 0.18.22's installer changes were checked this way.
- **`ActivityLog` rows are sealed (0.28).** A trigger refuses any UPDATE of a
  sealed row except nulling `tenantId` / `customerId` / `actorId`, and
  `seq` is a BigInt — `JSON.stringify` on a raw Prisma row throws unless
  `common/bigint-json` is imported (the API and worker entry points do).
  Test clean-ups that `DELETE` audit rows are detected as deletions: on a
  scratch database the chain reports them for good, which is expected; never
  run them against production.
- **The monitoring sweep acts on every alert in the database** (every 60 s;
  `MONITOR_SWEEP=off` stops it). A scratch API pointed at a database with
  demo or fixture alerts will resolve, group and notify them. Run the docs
  stack's API with `MONITOR_SWEEP=off`, and never give a scratch database a
  notification policy with a real destination.
- **A maintenance window is not containment.** `MonitorSuppression` only
  holds notifications (and ClientSt0r's `alert.raised`); it never touches
  `ContainmentPause`. Keep them apart — §17 checks it.
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

The 0.18.22 review added four more: sudoers naming only the root-owned
wrappers in `deploy/sbin`, never `fail2ban-client` or `dpkg`; no first-sight
binding of a device secret on heartbeat; claim tokens consumed conditionally;
and device-reported names reduced to an inert charset before they reach the
Connect `.cmd`. Its behavioural proof is `apps/api/scripts/e2e-security-audit.mjs`.
It writes fixtures, so run it against a scratch API and database
(`API_BASE=http://127.0.0.1:3101/api/v1`), never port 3001.

0.26.0 added §14 for approved actions: the approval signer loads no Nest,
Prisma or portal module and the portal never imports it or loads its key; there
is no approve route; the agent catalog is Spooler-only and journals before it
executes; and no DTO array of objects lacks `@Type(() => Object)` —
class-transformer's implicit conversion silently turns those into `[[]]`, which
is how command-result events went missing in production. The signer is its own
install (`apps/api/scripts/build-approval-signer.mjs`), never run from the
portal's `dist`. Its behavioural proof is `apps/api/scripts/e2e-approved-action.mjs`
(needs `RELEASE_BIN` and `ACTION_SIM` built from `tools/windows-installer`).

0.27.0 added §15 for staged patching: the agent's update params are closed
(`updates` + `reboot: "never"`), its update risk is always high, `wua.ps1` has
no restart, `AcceptEula`, `Invoke-Expression` or download-and-run, the agent
checks other update managers before installing, the patching API has no
approve route, the canary gate requires *effective*, and updates cannot be
requested one computer at a time (`ACTION_NOT_DIRECT`). §14's agent-catalog
check now expects exactly the two actions. Its behavioural proof is
`apps/api/scripts/e2e-staged-patching.mjs` (same `RELEASE_BIN` / `ACTION_SIM`;
the sim takes `-wua` / `-registry` fixture files). An `ActionJob` is now one
signed plan with an `ActionTarget` row per computer; `endpointId` on the job is
only the first target, so per-computer state lives on the target.

0.28.0 added §16 for containment and evidence: the signer has no HTTP route
that lifts a pause, lifting a portal pause needs `assertFresh`, the
customer-suspension and SAME_PERSON rules hold, every write path consults
containment (evaluateAction, evaluateLaunch, forHeartbeat, heartbeat update
flags and rollout dispatch, Quick Connect admission, integration submit and
worker), the agent checks the signed pause before journaling *executing*, an
unreadable listed pause fails closed, the audit trigger is in migration 0027,
and `/healthz` gives no detail without `HEALTH_TOKEN`. Its behavioural proof is
`apps/api/scripts/e2e-containment.mjs` (same `RELEASE_BIN` / `ACTION_SIM`; the
sim takes `-pause`).

0.29.0 added §17 for monitoring: the agent's monitor block only reads
(`Get-Service`, `Get-WinEvent`) and checks every service name and log against
a charset before using it, the server keeps only the services and event keys
it asked about, event monitors must name ids, levels or a provider, the
monitor report needs the device secret and only an authenticated heartbeat is
handed monitor queries, monitoring never sets or lifts containment, changing
who is notified needs `assertFresh`, business destinations are public HTTPS
hosts, one open alert per problem is a partial unique index, and linking a
ClientSt0r ticket grants nothing. §18 checks that every capture script refuses
https and ports 3000/443, and that `screenshots.mjs` refuses any database but
`reboot_remote_docs`. Unit proof: `apps/api/scripts/unit-monitoring.mjs` (set
`PWSH` to also run the agent's monitor block under pwsh against stubs).
Behavioural proof: `apps/api/scripts/e2e-monitoring.mjs` — it refuses a
database that already has global monitors or a global notification policy,
because the sweep acts on everything in it.

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
| `apps/web/scripts/screenshots.mjs` | `docs/screenshots/` | The in-app docs at `/docs` — numbered-callout guide images (each one followed by a numbered key in the markdown) |
| `apps/web/scripts/capture-media.mjs` | `docs/images/github/` | The GitHub gallery, `docs/screenshots.md` |
| `apps/web/scripts/capture-video.mjs` | `media/raw/*.webm` | `scripts/build-video.sh` |
| `scripts/build-video.sh` | `media/*.mp4`, `media/poster*.png` | GitHub **release assets** |

**`media/` is gitignored and must stay that way.** Video binaries do not belong
in Git history; publish the finished files as release assets and link to them.
The rule is root-anchored (`/media/`) on purpose — a bare `media/` also matches
`docs/media/`, which holds the walkthrough transcript and captions and *is*
tracked.

**Never capture against production.** All three capture scripts refuse an
`https://` target or port 3000/443 outright (§18), `screenshots.mjs` also
refuses any database but `reboot_remote_docs`, and `prisma/_docs-demo-data.ts`
and `_docs-demo-monitoring.ts` refuse any database whose name is not
`reboot_remote_docs`. Masking is shared: `apps/web/scripts/capture-masks.mjs`. Those guards are the safety
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
