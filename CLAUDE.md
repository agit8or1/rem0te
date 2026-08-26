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
sudo chown -R reboot:reboot /opt/reboot-remote/api/dist /opt/reboot-remote/web/standalone
sudo systemctl restart reboot-remote-api reboot-remote-web
```

Client chunks are **added, never deleted** — that is what the `--exclude` and the
second rsync are for. Next.js requests chunks by content hash, and deleting the
previous build's files 404s every browser that already had the app open.

## Things that will bite you

- **The deploy target is not a git checkout.** `/opt/reboot-remote` has no
  `.git`. Build in the source tree.
- **Never `pkill -f 'node dist/main.js'`** — it matches the production API.
  Use PIDs.
- **The screenshot pipeline seeds demo businesses and computers.** Point it at a
  scratch database, never a live one. `output: 'standalone'` bakes the Next
  rewrite destination in at build time, so `INTERNAL_API_URL` at runtime is
  ignored — patch `routes-manifest.json` in a copy of the build.
- **Generated PowerShell cannot be syntax-checked here.** There is no PowerShell
  on the host. `RustdeskService.joinPs()` refuses the mistakes that are not
  visible to a brace count; add to it rather than eyeballing.
- **hbbs logs nothing when a connection fails.** Use
  `deploy/scripts/hbbs-probe.py <id>`. Note it sends a real punch-hole, so the
  endpoint will dial the relay as a side effect.

## Docs

`docs/README.md` is the index. When behaviour changes, the page that describes
it changes in the same commit — `docs/connecting.md`, `docs/clients.md`,
`docs/updates.md`, `docs/troubleshooting.md`, `docs/architecture.md`. The in-app
copy at `/help` is separate and also needs updating.
