# Changelog

All notable changes to Rem0te are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [0.18.16] — 2026-09-18 · *Handshake*

No production code changes.

### Changed

- **A devDependency-only merge no longer gets its own release.** These now
  accumulate on `main` and fold into the next release — the next one shipping
  anything, or a batched one at most weekly if nothing else is due.

  0.18.14 and 0.18.15 were both cut within an hour, the first for fifteen dev
  dependency bumps and the second for a single `eslint-config-next` patch. Each
  cost a branch, a pull request, three CI jobs, a tag, a release and an API
  restart in order to record a change that cannot reach production: the API's
  production manifest is generated with no devDependencies at all, so `dist`
  and the target's `node_modules` are identical either side of the release.
  Worse than the cost, `version.json` is what the in-app update check reads and
  what an endpoint consults to decide whether to re-run its installer — moving
  it for a lint plugin makes those consultations mean less.

  The exception is deliberately narrow, and `CLAUDE.md` says so: a **production**
  dependency reaches the target and still gets the full treatment — bump,
  changelog, release, and a deploy with the manifest regenerated and
  `npm install --omit=dev` run at the target. A change touching both is a
  production change. `check-versions.mjs` is unaffected; it asserts that the
  version strings agree and that the changelog documents the current one, which
  a dev bump does not disturb.

  Dependabot already batches the pull requests — the npm entry runs `monthly`
  with devDependencies in one group — so this is about release cadence, not PR
  cadence.

---

## [0.18.15] — 2026-09-18 · *Handshake*

No production code changes.

### Changed

- `eslint-config-next` 15.5.24 → 15.5.25 (#35). A patch, which the
  majors-only ignore added in 0.18.14 correctly let through — the major to 16
  stays blocked. Lint passes on it.

---

## [0.18.14] — 2026-09-18 · *Handshake*

No production code changes. This release exists so `main` carries a version
number that matches what is on it: Dependabot's merge commit cannot bump the
version, and fifteen development dependencies landed in #34 without one.

### Changed

- **Development dependencies:** `@types/node` 20 → 26, `@types/express` 4 → 5,
  `vite` 6 → 8, `@vitejs/plugin-react` 4 → 6, `eslint-plugin-security` 3 → 4,
  `typescript-eslint` 8.68 → 8.70, `@nestjs/cli` 11.0.24, `@nestjs/schematics`
  11.1.0, `@playwright/test` and `playwright` 1.63, `@tauri-apps/cli` 2.11.4,
  `@eslint/eslintrc` 3.3.7, `autoprefixer` 10.6.1, `marked` 18.0.13. None of
  these reach the deploy target — the API's production manifest carries no
  devDependencies.

- **Four majors from that group are ignored, with the evidence recorded.**
  They arrived together and each breaks the repo on its own, so each was tested
  rather than assumed:

  - `typescript` 5 → 7: `typescript-eslint` refuses to load against it, and its
    latest stable still peers `typescript >=4.8.4 <6.1.0` with everything past
    8.70.0 an alpha. Blocked upstream, not sequencing.
  - `eslint` 9 → 10: eslint 10 dropped the legacy eslintrc format that
    `eslint-config-next` 15 publishes — `Cannot read config file`.
  - `eslint-config-next` 15 → 16: reaches flat config through `FlatCompat` in a
    shape eslint's own error formatter cannot serialize (`Converting circular
    structure to JSON`). Fails on eslint 9 and 10 alike, so it blocks
    independently of the eslint major.
  - `tailwindcss` 3 → 4: the PostCSS plugin moved to `@tailwindcss/postcss`, so
    `globals.css` stops building. Tailwind 4 is a rewrite — the theme moves
    into CSS `@theme`, and the dark-mode tokens and gauge thresholds all live
    in that config, so it wants its own release with screenshots recaptured.

  Each ignore in `.github/dependabot.yml` carries the error it was diagnosed
  from and the concrete condition for lifting it, because the failure mode
  otherwise is a weekly PR nobody can evaluate.

### Fixed

- `version.json` carried `releaseDate: 2026-09-17` through the 0.18.13
  release. Nothing reads it, which is why it drifted.

---

## [0.18.13] — 2026-09-18 · *Handshake*

### Fixed

- **The `@nestjs/*` 12 majors are reverted.** Dependabot's production group
  (#30) carried seven of the eight `@nestjs/*` packages to 12 and left
  `@nestjs/throttler` at `^6.5.0`, whose peer range stops at core 11. CI was
  green — pnpm is lenient about peer ranges — and npm at the deploy target
  refused the tree outright with `ERESOLVE`, leaving `node_modules` untouched
  while a NestJS-12-compiled `dist` had already been rsynced over it. Nothing
  was serving from that combination, and production never went down, but only
  because the install failed loudly.

  `@nestjs/*` majors are now ignored in `.github/dependabot.yml`. The exit
  condition is written down there: raise `@nestjs/throttler` to `^6.6.0` or
  newer first (6.6.0 is the release that added `^12.0.0` to its peer range),
  then take the framework major deliberately, with a check that rate limits
  still fire afterwards.

- **The API's production manifest is generated rather than hand-maintained.**
  `/opt/reboot-remote/api/package.json` is a separate file from
  `apps/api/package.json` — the target installs with npm, and `dist` carries no
  dependencies — and it had drifted for months without anything noticing:
  production was running zod 3.25, ioredis 5.10, helmet 7.2 and
  `@anthropic-ai/sdk` 0.52 while `dist` was being compiled against zod 4,
  ioredis 6, helmet 8 and sdk 0.125. It still claimed `version: 0.3.6`.

  `pnpm deploy:manifest` now derives it from `apps/api/package.json`, so a
  dependency change reaches the target by construction. It cannot simply be
  copied: the workspace manifest's devDependencies carry an eslint 9 /
  `@eslint/js` 10 peer conflict that pnpm tolerates and npm refuses, on
  packages the target never installs.

  Two details the generator handles that a copy would get wrong. The security
  overrides live only in `pnpm-workspace.yaml`, in pnpm's `name@range` key
  form that npm does not understand, and npm additionally rejects an override
  for a package that is also a direct dependency — so those pins are folded
  into the dependency range as an intersection (`nanoid` becomes
  `^5.0.7 >=5.1.7`) rather than dropped, since `^5.0.7` alone admits the
  version the advisory is about. And the `prisma` CLI, a devDependency in the
  workspace, is pinned to `@prisma/client`'s own range, because the target runs
  `prisma generate` after every install and `npx prisma` was free to fetch a
  newer major and generate a client the installed runtime cannot load.

---

## [0.18.12] — 2026-09-18 · *Handshake*

### Changed

- **`installer` is now a required status check on `main`**, alongside `check`
  and `audit`, all three pinned to the GitHub Actions app so no other app
  reporting a same-named context can satisfy them.

  It was added three releases after the job itself, deliberately: requiring a
  check in the same change that introduces it blocks every pull request opened
  before the job existed, because their runs have no such check to report. The
  job shipped in 0.18.11, ran green on three pull requests, and is required
  now. `docs/github-about.md` records that sequence, since the temptation next
  time will be to do both at once.

---

## [0.18.11] — 2026-09-18 · *Handshake*

### Added

- **CI cross-compiles the Windows installer.** Nothing verified it before, which
  is how a `golang.org/x/sys` 0.18 → 0.48 bump came to sit open for three days
  with a green check beside it: the check was real, it just never compiled the
  module the PR changed. `main.go` imports `golang.org/x/sys/windows` directly.

  `GOOS=windows` because that is the only target this binary is built for — the
  syscall package it uses does not exist on Linux, so a native build fails for
  reasons unrelated to whatever is under test. The Go toolchain is declared once,
  by the `go` directive in `go.mod`, the same way pnpm's is by `packageManager`.

### Changed

- **Three major action bumps merged, one at a time**, each verified on `main`
  before the next went in: `actions/checkout` 4 → 7, `actions/setup-node`
  4 → 7, `pnpm/action-setup` 4 → 6. They change the machinery that verifies
  everything else, so merging them as a batch would have meant losing the signal
  that says which one broke it.

- **Major updates are now ignored for `otplib` and `reqwest`**, joining
  `esbuild` and the Prisma pair. Both for the same reason: a grouped PR is only
  as mergeable as its worst member, and an unverifiable one is worse than a
  failing one.

  **otplib 13** removes the `authenticator` named export:

  ```
  src/mfa/mfa.service.ts(3,10): error TS2305
  Module '"otplib"' has no exported member 'authenticator'
  ```

  Five call sites — `generateSecret`, `keyuri` and three `verify()` — so this is
  a rewrite of the TOTP path, which is the second factor on every account.
  Subtly wrong either locks people out or weakens 2FA while still appearing to
  work, and nothing in CI would catch the latter. It was also holding 31
  unrelated production updates hostage.

  **reqwest 0.13** is a major bump to the one HTTP client the launcher uses,
  with `default-features` off and `rustls-tls` selected by hand — and **nothing
  in CI compiles the Rust side.** The "Typecheck and build launcher" job builds
  the launcher's TypeScript; `src-tauri` is only ever built when someone
  produces an installer locally. Merging it blind would leave a broken installer
  to be discovered at release time by whoever is trying to ship. Minor and patch
  cargo updates still come through, since the next local build catches those.

  Lift the reqwest ignore when CI builds the Rust side — it needs a Rust
  toolchain and the webkit2gtk system libraries — and do the upgrade with a
  toolchain in hand.

### Notes for operators

- The new `installer` job is not yet a required status check. Add it to the
  `main` ruleset once it has run green a few times; doing it in the same change
  would block every pull request opened before the job existed.

---

## [0.18.10] — 2026-09-18 · *Handshake*

### Fixed

- **The sessions chart had no bars at all — the fifth fault in it, and the one
  0.18.9 missed.** That release fixed the day labels, the missing days, the
  partial-day window and the minimum-height stub, and the chart still drew
  nothing: correct counts, correct weekday names, no bars. The previous
  screenshot had no bars either, which was read as the missing-days bug and not
  looked at again.

  A flex trap. The row was `items-end`, which sizes each column to its own
  content, so the track's `flex-1` had no free space to claim, collapsed to zero
  height, and the bar's `height: N%` resolved to a percentage of nothing. The
  numbers and labels render independently of the track, which is exactly why it
  looked like a data problem. `items-stretch` on the row, `h-full` on the
  column and `flex-1 min-h-0` on the track — all three load-bearing, and
  commented as such.

  Caught by measuring the rendered image rather than looking at it: the chart
  region held **887** blue pixels (0.38%) where bars should be. After the fix,
  **40,246** (17.2%).

- **The demo seed could not populate a seven-day chart.** Sessions were placed
  at `s < 3 ? s * 0.6 : 2 + s * 2.4` days back — 0, 0.6, 1.2, then straight to
  9.2, stepping clean over days 2 to 8. At most three of the seven days could
  ever hold a session, which is why the captured screenshot showed three
  columns labelled `W T F`. So the gallery was photographing two bugs at once:
  a chart that could not draw, fed by data that could not fill it.

  In-week days now come from a weighted bag offset per business. The first
  attempt at this gave a flat `6 6 6 6 6 6 5`, and seven identical bars read as
  invented; it now produces a shape — 4, 5, 7, 6, 8, 9, 5 — while the 30-day
  total still differs from the 7-day one, which is the point of the two tiles.

- **The gallery is recaptured** at this version, all 35 in one run.

---

## [0.18.9] — 2026-09-18 · *Handshake*

### Fixed

- **"Sessions — last 7 days" was wrong in four separate ways at once.** Every
  label named the wrong day, quiet days vanished instead of showing as zero,
  and the oldest bar always read low.

  1. **Every label was one day early.** The API returns a plain calendar date
     (`2026-09-11`) and the chart passed it to `new Date()`, which parses a
     bare date as **UTC midnight** — so any browser at a negative offset
     formatted it as the 10th. In US Eastern, all seven labels were off:

     ```
     2026-09-11  showed 'T'  should be 'Fri'
     2026-09-17  showed 'W'  should be 'Thu'
     ```

     The date is now built from its parts, which keeps it local and keeps the
     label attached to its own bar.

  2. **The labels were single letters.** `weekday: 'narrow'` renders
     `S S M T W T F` — two Ts, two Ss, and nothing to notice an off-by-one day
     by. Now `weekday: 'short'`, with the full date on hover.

  3. **Days with no sessions were missing entirely**, because the query grouped
     the sessions rather than the days: `GROUP BY DATE("createdAt")` returns no
     row for a quiet Saturday, the chart drew one fewer column, and the
     remaining columns closed the gap — so the axis silently claimed a run of
     consecutive days it did not have. A week with two busy days rendered as a
     two-bar chart. The series is now generated in SQL and the sessions LEFT
     JOINed onto it, so it is always exactly seven consecutive days,
     zero-filled.

  4. **The window was a rolling 168 hours, not seven calendar days.** Starting
     at `now - 7 days` makes the oldest bucket a partial day that always reads
     low, and lets the window spill into an eighth. It is anchored on
     `current_date` now.

  A zero is also drawn as *no bar* rather than the old `Math.max(4, …)` floor,
  which made an idle day look like a small amount of work, and each bar carries
  its count. A completely quiet week says so in words instead of showing seven
  stubs.

  Days are the database's calendar days, and both the server and the database
  run UTC — noted in the service, because a deployment whose database sits in
  another zone would shift the day boundaries.

---

## [0.18.8] — 2026-09-18 · *Handshake*

### Changed

- **The security overrides have one home, and the toolchain that reads it is
  pinned.** They were duplicated in `package.json`'s `pnpm.overrides` and in
  `pnpm-workspace.yaml`, and the duplication was not redundancy — it was
  load-bearing in two different places. pnpm <=10 reads the first and ignores
  the second; pnpm >=11 does the reverse. **CI pinned pnpm 11 while this
  checkout ran pnpm 10.32.0**, and nothing pinned the toolchain, so both copies
  were live for different people and could drift without anything failing.

  CI had already started saying so on every run:

  ```
  [WARN] The "pnpm" field in package.json is no longer read by pnpm.
         The following keys were ignored: "pnpm.onlyBuiltDependencies",
         "pnpm.overrides".
  ```

  Deleting the "dead" copy first would have been the wrong order: it is only
  dead in CI. Locally it was the *only* copy being read, and removing it would
  have silently dropped 22 advisory overrides and all 8 build allowances from
  every developer install — including the esbuild window that keeps the Tauri
  launcher compiling.

  So `packageManager: "pnpm@11.27.0"` and `engines.pnpm: ">=11"` came first, and
  then the mirror went. Verified rather than assumed: both copies were compared
  key by key and proven identical before collapsing them, and a clean install on
  the pinned pnpm reproduces every pin from `pnpm-workspace.yaml` alone —
  esbuild 0.27.2 (inside `>=0.25.0 <0.27.3`), lodash 4.18.1, brace-expansion
  5.0.9, picomatch 4.0.7, qs 6.16.0, sharp 0.35.4 — with the argon2 and Prisma
  native builds running and `pnpm-lock.yaml` unchanged.

- **Three new security invariants**, because the two facts hold each other up:

  ```
  packageManager pins pnpm 11 or newer
  security overrides are not mirrored back into package.json
  pnpm-workspace.yaml still carries the overrides and build allowances
  ```

  Removing the pin makes every local install lose the overrides, so the check
  refuses that combination rather than trusting anyone to remember why the pin
  is there. Each one was temporarily broken and confirmed to fail for its own
  reason before being restored — an unproven guard is decoration.

  `.github/dependabot.yml` gains the consequence worth knowing: **Dependabot
  does not read `pnpm-workspace.yaml`**, so it cannot see these pins, and a PR
  bumping a package constrained there changes nothing in the install while
  looking like it did something.

- **The pnpm version is declared once too.** `ci.yml` pinned `version: 11` on
  both `pnpm/action-setup` steps, and adding `packageManager` made that a hard
  failure rather than a duplicate:

  ```
  Error: Multiple versions of pnpm specified
  Remove one of these versions to avoid ERR_PNPM_BAD_PM_VERSION
  ```

  Caught by CI on the pull request, which is the first thing the new branch
  protection was good for. The `version:` lines are gone and action-setup reads
  `packageManager` — so the toolchain version now has a single home, the same
  way the pins it reads do.

### Notes for operators

- The first `pnpm install` in an existing checkout **purges `node_modules`**,
  because pnpm 11 will not reuse a tree pnpm 10 built. Expect one slow install;
  it took 34.5s here. Without a TTY it refuses instead, with
  `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` — set `CI=true` for that case.

---

## [0.18.7] — 2026-09-18 · *Handshake*

### Fixed

- **Dependabot was splitting the Prisma pair across two pull requests, so
  neither could ever pass.** `prisma` is a devDependency and `@prisma/client` a
  production one, and grouping by `dependency-type` alone put them in separate
  PRs — each carrying half of a pair that has to move together:

  | PR | Carried | Failed with |
  |---|---|---|
  | #20 | client 7.10.0, CLI 5.22.0 | `Cannot find module '.../generator-build/index.js'` |
  | #17 | CLI 7.10.0, client 5.22.0 | `P1012` |

  Neither could pass, so neither could merge, so both sat open. A `prisma`
  group listed **first** now keeps them together — a dependency joins the first
  group whose rules it matches, so ordering is the whole fix.

- **Prisma majors are no longer raised automatically**, because v7 is a
  migration rather than a bump. It removes `url` from the schema's datasource
  block:

  ```
  P1012  The datasource property `url` is no longer supported in schema files.
         Move connection URLs for Migrate to `prisma.config.ts`
  ```

  which touches `schema.prisma`, the `PrismaClient` constructor,
  `migrate deploy`, `seed.ts`, both `_docs-demo-*` scripts, the deploy steps in
  `CLAUDE.md`, and the `prisma generate` run on the deploy target. Merging it as
  a dependency update would have broken the API.

  Minor and patch updates still arrive, grouped. The ignore is scoped to majors
  and comes off when someone is actually doing the migration — recorded
  alongside the esbuild entry, which is this file's existing precedent for a
  dependency that must not move on its own.

  #17 and #20 are closed, with the reasoning left on both.

---

## [0.18.6] — 2026-09-18 · *Handshake*

### Changed

- **`main` now requires `check` and `audit` to pass.** Both are pinned to the
  GitHub Actions app (id 15368), so only Actions can satisfy them — an
  unpinned context can be reported by any app that can write a check run with
  a matching name.

  **This blocks direct pushes, by design.** CI runs on push, so a new commit
  has no checks to read at the moment it is offered and the push is refused.
  Work now goes in through a branch and a pull request; `CLAUDE.md` carries the
  four commands, and this release went in that way as its own first test.

  `strict_required_status_checks_policy` is off — requiring a branch to be up
  to date with `main` before merging adds a rebase round-trip that earns nothing
  on a repository with one author. And there are still no bypass actors: adding
  the owner would restore direct pushes for emergencies and quietly make the
  whole ruleset advisory, which is how most branch protection ends up meaning
  nothing.

---

## [0.18.5] — 2026-09-18 · *Handshake*

### Changed

- **`main` is protected.** A repository ruleset now restricts deletions and
  blocks force pushes on the default branch, with **no bypass actors** — it
  binds repository admins too, which is the point, since the account that would
  force-push by accident is the one holding admin. Recorded in
  `docs/github-about.md`, which is the source of truth for repository settings.

  **Requiring status checks is deliberately left off.** CI runs *on push* to
  `main`, so a commit cannot already be green at the moment it is pushed —
  requiring checks would block every direct push and force a pull-request
  workflow. This repository commits straight to `main`, so that is a workflow
  decision rather than a settings one, and the checklist says what to require
  (`check` and `audit`) if it is ever made.

  Worth recording how this was verified, because the obvious test is useless:
  `git push --dry-run` never contacts GitHub for rule evaluation and cheerfully
  reports a force-push it would not be allowed to make. `gh api
  repos/.../rules/branches/main` asks the server which rules apply.

- **The Tactical RMM release notes are shorter and flatter.** 0.18.0 went from
  62 lines to 27 and lost its screenshot and its editorial framing; the section
  in 0.18.2 is down to a short paragraph; 0.18.4 is five lines. It is another
  way to open a remote session, and the notes now read like it.

---

## [0.18.4] — 2026-09-18 · *Handshake*

### Added

- **Tactical RMM setup in the in-app help**, at **/help → Connecting from
  Tactical RMM** — placed immediately after *Connecting to a Computer*, because
  that is what it is: one more way to open a session. The URL Action to paste,
  where it goes in TRMM, the `&action=open` variant, the case-sensitivity trap,
  why there is no API key in the address, and what happens when two customers
  have a machine with the same name.

### Changed

- **The repository description is back to describing a remote-support tool.**
  0.18.3 added "see their specs and pending Windows updates, read an event log
  without connecting" to it, which reads as a claim to do patch management.
  Rem0te *reports* what a machine is waiting to install; it does not install it,
  schedule it or remediate anything, and the Tactical RMM integration is one
  more way to open a session rather than a foothold in that category.

  Somebody who arrives expecting an RMM leaves disappointed, and that is the
  copy's fault rather than the product's. The inventory, the event-log viewer and
  the TRMM launch are documented, in the gallery and in the help — they do not
  belong in the sentence that sets expectations.

  The `asset-inventory` topic is removed for the same reason. `tactical-rmm`
  stays: it is squarely about remote control, and somebody searching it finds a
  way to connect, which is exactly what it is.

---

## [0.18.3] — 2026-09-18 · *Handshake*

### Changed

- **The GitHub About panel now describes what this became.** Its description
  predated 0.14.0 and stopped at "organise computers and keep an audit trail",
  which undersold a tool that reports hardware and pending patches, reads event
  logs, and plugs into an RMM. The first sentence is untouched on purpose — it
  is what shows in search results and social cards, and it was already the
  clearest statement of what this is.

  Topics gain `tactical-rmm` (there is a real integration to find, and people
  running TRMM search for what works with it) and `asset-inventory` (accurate
  since 0.14.0). Deliberately **not** `rmm`: Rem0te integrates with an RMM, it
  does not do patching, monitoring or scripted remediation, and claiming the
  category to catch searches would bring people here expecting a Tactical RMM
  competitor and send them away again.

  `docs/github-about.md` is the source of truth for these, so it was edited
  first and then applied — which is what that file exists to make possible.

### Fixed

- **Five tags had no GitHub release**: 0.16.2, 0.17.0, 0.17.1, 0.18.0 and
  0.18.1. Two of them were the ones that mattered — **0.17.0**, which added the
  resource gauges and host health, and **0.18.0**, the Tactical RMM integration
  itself, which had never been announced under its own release and existed only
  as a paragraph inside 0.18.2's notes. All five are now written up.

- **0.18.1 was showing as the latest release**, because GitHub marks whichever
  release was created most recently as latest and the backfill above created
  them out of order. 0.18.2 is latest again — which also matters to the in-app
  updater, since it compares `version.json` against
  `releases/latest` and would otherwise have offered an upgrade to an older
  version.

---

## [0.18.2] — 2026-09-18 · *Handshake*

### Changed

- **Documentation and the gallery brought up to date with 0.14 – 0.18.** All 35
  images re-captured in one run against the isolated demo stack, plus two new
  ones: the Resources card, and what a Tactical RMM URL Action lands on.

  The README gains a **What's new** section — inventory, event logs, the TRMM
  integration, agent reinstall and the one-screen dashboard were all shipped
  without the front page mentioning any of them — and rows in the feature grid
  and documentation table for the two new pages.

- **The demo seed carries a live resource sample and a deliberate hostname
  collision.** The Resources card would otherwise have photographed as
  "Awaiting first sample" on every machine, which is the same trap the
  inventory itself fell into before 0.16.0. And the TRMM shot needs an
  *ambiguous* match to show anything: two customers each with a machine the
  front desk calls `reception-pc` is most MSPs rather than a contrived example.
  Seeded as an alias, so it changes no counts, no display names and nothing the
  offline set is keyed on.

### Fixed

- **The README's version badge had been stale for five releases** — it still
  read 0.13.9 at 0.18.1. It is the first version a visitor sees, so
  `check-versions.mjs` now checks it alongside the four package files and the
  changelog heading, and CI fails if it drifts again.

- **`docs/SECURITY-AUDIT.md` described v0.13.0 as though it were current.**
  Five releases have since added surface a full pass has not covered — a public
  command-result route, event-log contents crossing into the console, an
  operator action that re-runs an installer as SYSTEM, `/proc` reads, and
  endpoint lookup by attacker-influenceable hostname. Each was designed against
  the invariants in that document and the statically-checkable ones are covered
  by `check-security-invariants.mjs`, but designed-against is not audited, and
  the page now says which is which rather than implying a review that has not
  happened.

- **The walkthrough video is marked as recorded at v0.13.5.** It is still
  accurate about how everything works, but the dashboard has been rebuilt and
  the device page has gained three tabs' worth of new content since, and a tour
  that silently shows neither invites the wrong conclusion.

- **A capture-script trap, caught by looking at the image rather than the tick
  mark.** The first Tactical RMM shot passed a client name, which narrowed two
  candidates to one — so instead of the picker it auto-connected and
  photographed a raw 503 from `/connect.cmd`. The shot now sends the hostname
  alone, which is the ambiguous case it is meant to demonstrate.

---

## [0.18.1] — 2026-09-18 · *Handshake*

### Fixed

- **Signing in threw away the query string, which broke the first Tactical RMM
  launch in any browser without a session — the common case.** The middleware
  set `returnTo` to the pathname only, so a technician who clicked *Connect with
  Rem0te* while signed out signed in and arrived at `/trmm` with no hostname to
  look up, and a page that correctly said it had nothing to do. Harmless for
  every route that came before, because they all carried their state in the
  path; a URL Action is nothing but query string.

- **The `returnTo` guard was one character from being no guard at all.** It
  rejected `//evil.example` but allowed `/\evil.example`, and several browsers
  normalise the second into the first before the application gets a say — an
  open redirect from a real sign-in page, which is the ideal place to ask
  somebody to sign in again. Backslashes are now rejected alongside a second
  slash. The query string is allowed through, which it has to be for the fix
  above, and is safe because the value stays a same-origin path and nothing
  downstream redirects on it.

---

## [0.18.0] — 2026-09-18 · *Handshake*

### Added

- **Tactical RMM integration — connect to a computer, or open its page, by
  right-clicking the agent in TRMM.**

  Worth stating first, because it shaped the whole design: **Tactical RMM has no
  way to consume a REST API.** There is no screen where you paste an API URL and
  have TRMM render someone else's data. Its extension points are URL Actions,
  scripts, Collector Tasks and alert actions — so "add our API into TRMM" means
  giving TRMM the right URLs to open and scripts to run, and that is what this
  is. Nothing here requires a change to Tactical RMM.

  `/trmm` receives what a URL Action sends — `{{agent.hostname}}`,
  `{{client.name}}`, `{{site.name}}`, `{{agent.agent_id}}` — and resolves it to
  one computer, then connects or opens the device page (`&action=open`).

  **No API key travels in the URL, deliberately.** A URL Action opens in the
  technician's own browser, so it authenticates as them against what they can
  already see — and a URL Action is stored in TRMM's global settings, lands in
  browser history and is visible to every operator who can right-click an agent,
  which is the wrong place for a credential.

- **Resolve, then remember.** Matching runs in order of how much it can be
  trusted: a recorded TRMM agent id, then hostname narrowed by client name, then
  hostname alone. Business names are compared loosely — case, punctuation and
  company suffixes ignored — so *Harbor Logistics* matches *Harbor Logistics
  Ltd*.

  **Hostnames collide**, and two customers each with a `SERVER01` is not an edge
  case. When more than one computer matches, Rem0te shows a shortlist and asks;
  it never picks a closest match, because guessing opens a remote session on
  somebody else's machine. Choosing records the TRMM agent id as an endpoint
  alias (`trmm:<id>`), so every later launch is exact — the integration gets
  more reliable the more it is used.

  The id is an alias rather than a new column: aliases already exist, already
  carry a per-endpoint uniqueness constraint, and are already how this system
  says "also known as". The mapping *moves* rather than duplicating, so a stale
  one left after a rebuild cannot resolve confidently to the wrong machine.

### Changed

- **The RustDesk ID reaches TRMM by Collector Task, not by Rem0te calling
  TRMM's API.** The plan was for Rem0te to push the value into a TRMM custom
  field. Two things found while building it changed the approach:

  - **TRMM documents no API endpoint for setting custom field values.**
    Collector Tasks — a scheduled script whose last output line TRMM saves into
    the field — are the documented mechanism. Building on an undocumented
    endpoint produces an integration that breaks on somebody else's upgrade, in
    a way that looks like Rem0te's fault.
  - **It would mean Rem0te holding an API key for your RMM.** A TRMM key
    inherits its user's full permissions and bypasses 2FA. That is a lot of
    custody for the convenience of writing down a value the endpoint can print
    locally for free — the machine already knows its own RustDesk ID.

  `docs/tactical-rmm.md` ships the collector script, the custom-field setup and
  both URL Action templates.

### Notes for operators

- No schema change — the TRMM mapping reuses `EndpointAlias`.
- Recording a mapping needs `computers:edit`. Without it the connection still
  works; it asks again next time.
- New documentation page, in the app at **/docs/tactical-rmm**.

---

## [0.17.1] — 2026-09-18 · *Dial*

### Removed

- **The dashboard's "Launched" tile.** It counted sessions Rem0te had opened and
  not yet closed, which sits in the same row as live figures and reads as one —
  and it is not: a launched session may have ended minutes ago with nothing to
  tell us. *In use now*, which counts sessions actually relaying through this
  server, is the tile that means what this one looked like it meant. Session
  totals for 7 and 30 days remain, and session history is unchanged.

---

## [0.17.0] — 2026-09-17 · *Dial*

### Added

- **Resource gauges on a computer's Overview tab — CPU, memory and system
  disk.** Memory and disk were already on the page but came from the six-hourly
  inventory pass, which is fine as a spec ("16 GB installed") and wrong as a
  gauge: a needle pointing at a six-hour-old reading looks current and is not.
  CPU load was not collected at all, only the processor's model and clock.

  These now arrive on **every heartbeat**, alongside the signed-in user, and
  carry their own `liveSampledAt` timestamp — deliberately separate from
  `collectedAt`, because one moves every three minutes and the other every six
  hours, and a single column for both would let the card claim a freshness it
  does not have. The Resources card sits at the top of the tab and says how old
  its sample is.

  Collection is cheap by design: memory comes off the `Win32_OperatingSystem`
  object the heartbeat already reads for uptime, so it costs nothing extra, and
  CPU load is a property read of `LoadPercentage` rather than a counter the
  script has to time itself. It is averaged across sockets, because a
  two-socket box reports one figure per socket.

- **Host health on the dashboard — CPU, memory, disk and a live bandwidth
  gauge**, Platform Admin only. These describe the platform operator's own
  server, so the query is *disabled* for anyone else rather than merely hidden:
  not requesting it is the difference between hiding a tile and not fetching
  the data.

  Bandwidth is new work. `/proc/net/dev` holds monotonic counters, and one read
  of a counter says nothing about a rate, so `HostMetricsService` samples every
  two seconds and keeps a one-minute history for the sparkline. Loopback is
  excluded — the API talks to Postgres, Redis and the web process over it, and
  on a quiet server Rem0te's own internal chatter would be most of the graph —
  as are bridges and veth pairs, which would count container traffic twice. A
  negative delta is treated as a counter wrap, not as negative traffic.

  CPU is now real utilisation from `/proc/stat`, reported **alongside** load
  average rather than instead of it. They answer different questions and
  neither substitutes for the other: load average counts uninterruptible-sleep
  tasks, so a box blocked on disk shows a load of 8 at 2% CPU, and it is scaled
  by core count, so the same figure means different things on different hosts.

  All of it is read from `/proc` with no subprocess and no privilege. The API
  has fixed-command sudo grants for a couple of operations; this needed none of
  them, so it got none.

- **An "In use now" tile — sessions actually relaying traffic through this
  server.** Counted from paired established connections on the relay port,
  since a relayed session holds one connection from each side. Verified against
  the live host while building it: two connections, one session.

  **It undercounts, and the tile says so.** RustDesk prefers a direct
  peer-to-peer connection and only falls back to the relay when hole-punching
  fails, so a session that went direct never passes through this host and
  cannot be seen from it — Rem0te hands out a credential and never touches the
  session again. The tile is labelled *relayed both ways* and its tooltip
  states the limit, rather than presenting a number that quietly reads low as
  though it were the whole truth.

### Changed

- **The dashboard fits one screen.** It ran eight tall stat cards over two
  rows, then the map, then two full-height panels, then an activity list —
  about two and a half screens, so the map and everything below it were only
  ever seen by someone who scrolled. Nothing was removed: the density changed.
  Tiles are one line of figures instead of a padded header, a 2xl numeral and a
  sub-line; the lower half is a bounded row whose panels scroll internally
  rather than growing the page.

  `lg:h-screen lg:overflow-hidden` is what ends the page at the fold, and it is
  `lg:`-only on purpose — on a phone a fixed-height row of stacked panels is
  unreadable and scrolling is the right answer.

  The **Active Sessions** tile is relabelled **Launched / not yet closed**. It
  counts rows Rem0te opened and has not closed, which is not the same as a live
  connection, and the old label implied otherwise — the new relay tile is the
  one that means "in use".

- `ClientMap` takes an `embedded` prop so it fills its container instead of
  standing at a fixed 300px, which in a flexible row either left a gap or
  overflowed the viewport.

- One gauge component serves both the dashboard and the device page. The
  thresholds at which a number stops being trivia and starts being the reason
  for the ticket — amber at 80%, red at 92%, where a Windows volume starts
  failing updates and pagefile growth — are the same whether the disk belongs
  to this server or a customer's laptop, and two implementations would drift on
  the first change to either.

### Notes for operators

- **Schema change** — four nullable columns on `EndpointInventory`
  (`cpuLoadPercent`, `systemDiskTotalMb`, `systemDiskFreeMb`, `liveSampledAt`).
  Migration `0016_endpoint_live_resources`. Additive.

- **`AGENT_CONTRACT_VERSION` moves to 0.17.0**, because this release genuinely
  changes the agent — the first time it has moved since 0.15.0. Endpoints on an
  older agent will show "Needs a newer agent" in the Resources card and keep
  working in every other respect; *Reinstall agent* on the computer's Overview
  tab is the fix, and it is now a truthful prompt rather than the noise it was
  before 0.16.2.

---

## [0.16.2] — 2026-09-17 · *Caliper*

### Fixed

- **Every managed computer was reported as running an outdated agent, on every
  release.** The device page compared a machine's reported agent version
  against `version.json`, so any release at all — including 0.16.1, which
  changed only the README — put an amber "server is v0.16.1" under a fleet of
  perfectly current agents, next to a button offering to reinstall each one.

  Those are different numbers. The agent only changes when the generated
  heartbeat script changes, which is rarer than a release: 0.14.0 changed it
  (188 lines), 0.15.0 changed it (44), and 0.16.x did not touch it at all — so
  a 0.15.0 agent is functionally identical to what a 0.16.1 installer produces
  and has nothing to gain from reinstalling.

  The comparison is now against `AGENT_CONTRACT_VERSION` in
  `common/agent-contract.ts`, the last version in which the agent actually
  changed, and the UI names that bar — "needs v0.15.0 or later" — instead of
  reciting the server's own version. An agent *newer* than the contract is the
  normal case and is no longer flagged at all.

  This mattered beyond tidiness: crying wolf with a ~40 MB download per machine
  attached is how an operator learns to ignore the one case that matters, which
  is an agent genuinely too old to collect an inventory or run a command. That
  case — no version reported at all — now reads "predates v0.14.0 — cannot
  collect" in amber rather than a grey aside.

- **Version comparison existed twice.** `UpdateService` carried a private copy
  of the numeric-segment compare that the agent check needed. Two copies of
  version logic is how two parts of one page come to disagree about whether a
  machine is behind; there is now one implementation and `UpdateService`
  delegates to it.

### Notes for operators

- No schema change, and **no reason to reinstall any agent for this release.**
  If a machine showed the amber flag before this and reports v0.15.0 or later,
  it was already current.

---

## [0.16.1] — 2026-09-17 · *Caliper*

### Changed

- **The README shows the two new device screens.** Its feature grid stopped at
  onboarding and access, so the largest thing added in 0.14.0 — that a computer
  reports its own hardware, disk space, signed-in user and pending updates, and
  that its Windows event log can be read without starting a session — was
  visible only to someone who opened the full gallery. Added as a row of the
  grid, with a *Why it helps* paragraph, and the gallery counts corrected from
  31 to 33.

---

## [0.16.0] — 2026-09-17 · *Caliper*

### Added

- **The Event Log tab shows the last query run against a computer.** The
  command id lived in React state, so a result was only ever visible to the
  browser that requested it: navigating away and back presented an empty form
  as though nothing had ever been asked, and there was no way to see the query
  a colleague ran an hour ago. `GET /endpoints/:id/event-log/latest` returns
  the most recent `EVENT_LOG_QUERY` for the endpoint, results included, and the
  tab falls back to it until this session makes its own request. A stored
  result is labelled with when it was collected rather than presented as
  though the Fetch button had just produced it.

  Gated on `computers:event_logs`, the same capability as making the request —
  it returns log contents, so putting it behind `computers:view` would have
  meant the capability controlled who could ask but not who could read the
  answer.

### Changed

- **The documentation gallery is regenerated, and the demo data now includes
  inventory.** The device page is mostly collected inventory since v0.14.0, and
  the demo seed had none — so every screenshot of it showed "Specs have not
  been collected yet" over rows of dashes. A gallery advertising the feature as
  empty is worse than no screenshot.

  `prisma/_docs-demo-data.ts` seeds hardware profiles across the demo estate:
  a workstation, business laptops, a Mac, a rack server, a near-full disk and a
  machine waiting on a restart, so the usage bars and the amber states appear
  at all rather than every card reading healthy. Plus pending Windows updates
  with real KB numbers and a completed event-log query per online Windows
  machine, with genuine event IDs and providers — an event log full of invented
  ids looks wrong to anyone who reads these for a living.

  Two details that were wrong on the first pass and are worth recording:
  the logged-on account carried a hardcoded `NORTHWIND\` domain, which put it
  on a Cascade Accounting machine; both the domain and the account are now
  derived from the machine's own name prefix. And the event-log query was
  seeded on a sample of machines while the capture script picks whichever
  online endpoint it finds first — so the screenshot landed on a machine with
  no stored query and photographed an empty form.

- **`device-detail-light` was cropping the device page at 660px**, which cut it
  off at the Assignment card — above everything the page is now for. Raised,
  and joined by `device-specs-dark` (the collected-inventory grid) and
  `device-event-log-dark`.

  The specs shot is taken as an **element** screenshot rather than a clip: a
  clip is bounded by the viewport and that grid is taller than one, so the
  first attempt stopped halfway through the Hardware card, mid-row, which reads
  as a rendering fault rather than a crop.

### Notes for operators

- No schema change.

---

## [0.15.0] — 2026-09-17 · *Ratchet*

### Added

- **Reinstall agent — a button that upgrades the agent on a machine whose
  RustDesk client is already current.** There was no way to do this. The only
  server-staged action that re-runs an installer is
  `requestRustdeskUpdate`, and it filters on a version comparison:

  ```ts
  targets = nodes.filter(n => !n.version || compareVersions(n.version, latest) < 0)
  ```

  An endpoint already on the latest client is skipped outright. That is right
  for its own purpose and wrong as a way to upgrade the *agent*, which only
  changes when the installer re-runs — so the newest agent could not be pushed
  to exactly the machines that were otherwise healthy, and the only route was
  running the installer by hand on every box.

  `POST /endpoints/:id/reinstall-agent` stages it on the same channel as the
  credential rotation and the client upgrade, reusing the endpoint's existing
  installer re-run and its 30-minute floor. The installer is idempotent: it
  keeps the machine's server configuration, its permanent password and its
  enrolment, and replaces the heartbeat script. `COMPUTERS_EDIT` rather than
  `COMPUTERS_VIEW`, because unlike an inventory refresh this installs software
  on somebody's computer, and audited as
  `ENDPOINT_AGENT_REINSTALL_REQUESTED`.

  **It refuses a machine that has never authenticated with a device secret**,
  rather than accepting the request and silently doing nothing. The heartbeat
  only hands work to an authenticated endpoint, so staging for an unbound one
  looks like it worked and never runs — which is exactly the trap the RustDesk
  staging fell into: one endpoint in this deployment had been advertising a
  pending upgrade since 27 August, three weeks, because it could never be
  handed the instruction and nothing ever cleared it either. The refusal names
  the fix instead: re-run the installer locally once, and it can be managed
  from the console afterwards.

  The request self-clears on the same principle as the client staging, keyed on
  the agent version rather than RustDesk's — and it needs both halves:
  `reinstallRequestedAt` clears once the endpoint reports an `agentVersion`
  matching this server **and** the request has been dispatched at least once.
  Without the dispatch half, a repair reinstall of an already-current agent
  would be cancelled by the very heartbeat that collected it and the installer
  would never run.

### Fixed

- **`Endpoint.agentVersion` was dead through four layers.** `HeartbeatDto` and
  `ClaimEndpointDto` accepted it, `EnrollmentService.heartbeat()` named it in
  its signature, and the device page rendered an *Agent* row for it — but there
  was no column, nothing ever wrote it, and the agent never sent it. The row
  showed a dash on every machine ever enrolled, which reads as "not reported
  yet" rather than "not implemented".

  The generated installer now bakes in the platform version that produced it
  and reports it on claim, on every heartbeat, and on the retry-enrolment path.
  The Overview tab shows **Rem0te agent** alongside **RustDesk client** — three
  things can be out of date on a managed machine and confusing them wastes
  time, so each is named rather than merged — and flags an agent that does not
  match the server, with an absent version counted as outdated rather than
  unknown, because "not reported" means an agent older than v0.14.0.

  This is also what makes the reinstall above verifiable: without a reported
  agent version there is nothing to compare a completed reinstall against, and
  the request could only ever be fire-and-forget.

### Notes for operators

- **Schema change** — `Endpoint.agentVersion`, and three columns on
  `RustdeskNode` for the reinstall staging, plus one `ActivityAction` value.
  Migrations `0014_endpoint_agent_version` and `0015_agent_reinstall_request`.
  Additive: every column is nullable with no default. Follow the schema-change
  steps in CLAUDE.md.

- **A machine's agent version stays blank until its installer re-runs**, since
  that is what bakes the value in. For a machine that has never bound a device
  secret the reinstall button cannot help, and the server says so — those need
  one local run of the installer first.

---

## [0.14.0] — 2026-09-17 · *Lantern*

### Added

- **A computer's page showed six fields and knew nothing else about the
  machine.** Status, platform, OS string, RustDesk ID, agent version, last
  seen — because that was everything the heartbeat had ever sent. A technician
  about to connect could not see who was signed in, whether the disk was full,
  how long it had been up, or whether it was sitting on thirty pending Windows
  updates, and the answer to all of those was "connect and look".

  The managed agent now collects and reports:

  - **Every heartbeat (~3 min)** — the signed-in console user, uptime, last
    boot. Two CIM queries; cheap enough not to make anyone wait for a pass.
  - **Every 6 hours, or on request** — manufacturer, model, chassis, serial,
    BIOS version and date, CPU model/cores/threads/clock, installed and free
    memory, per-volume capacity and free space, GPUs with driver versions and
    current resolution, and every IP-enabled adapter with its MAC, address,
    gateway and DHCP state.
  - **Every 12 hours, or on request** — pending Windows updates with KB
    numbers, severities and download sizes, and whether the machine is waiting
    on a restart to finish installing them.

  The Overview tab is rebuilt around this: System, Session, Hardware, Memory,
  Storage, Network and Updates cards, each saying when its contents were
  collected. Assignment moved to the top, because it is the only part of that
  page that is true the moment it loads.

  The update scan is deliberately on its own slow cadence with its own
  timestamp. It starts the Windows Update agent and goes to the network — tens
  of seconds — so folding it into the inventory pass would have made every
  refresh expensive, and sharing one `collectedAt` would have made *Collected
  4m ago* silently claim the update list had been re-checked then.

- **Event Log tab — read a slice of a managed computer's Windows event log
  without connecting to it.** Pick the log, a time range, the levels and how
  many of the most recent events you want; the request is queued and the table
  fills in when the machine answers.

  Five logs are readable and only five — Application, System, Security, Setup,
  Windows PowerShell — allowlisted both in the API and again in the agent,
  because the agent is the process that actually opens the log and it should
  not be talkable into opening one nobody authorised. Hard bounds: 200 events,
  14 days, 2000 characters per message.

  Gated on a **new capability, `computers:event_logs`**, separate from
  `computers:view`. Somebody else's System and Security logs are a different
  kind of access from a name and an online dot, and plenty of people who should
  see the inventory should not see every failed logon on the machine. A
  Business Owner holds it; a Business User is granted it explicitly. Every
  request is audited as `ENDPOINT_EVENT_LOG_REQUESTED` with the log, the
  window, the levels and the requester.

- **The running version is in the sidebar footer**, and on the About page for
  everyone rather than Platform Admins only. `GET /admin/update/version` is
  Platform Admin only — correctly, it also reports update availability and
  updater readiness — but it was the *only* place the version lived, so a
  Business Owner on a page called About saw a permanent `…` where the version
  should be. `GET /admin/update/app-version` returns the version and codename
  to anyone signed in and carries no operator detail. "Which version are you
  on?" is the first question asked about every problem.

### Changed

- **The endpoint command queue is how all of the above is asked for.** There is
  no push channel to a managed computer and inventing one would have meant a
  second protocol to secure, so this reuses the channel the credential rotation
  and the RustDesk client upgrade already ride on: the console stages a row in
  `EndpointCommand`, the endpoint's next heartbeat response carries up to two of
  them, the endpoint collects and POSTs to `/enrollment/command-result`.

  Consequences worth knowing:

  - **Nothing is synchronous.** *Refresh* queues a collection; the machine
    performs it within ~3 minutes. The UI says that rather than spinning.
  - **Explicit requests jump the queue.** A person waiting at a screen is
    ordered ahead of automatic housekeeping, and two commands go out per
    heartbeat, so an event-log request is not stuck behind an inventory pass
    for another three minutes.
  - **An automatic command is never queued twice.** Without that, the
    stale-inventory check stages another row every three minutes for as long as
    the machine is offline, and it comes back to a queue of hundreds of
    identical refreshes.
  - **A command that is collected four times without a result is failed**, with
    a message saying to re-run the installer. That is what an agent too old to
    understand the command looks like from here, and retrying forever would
    mean a queue that never drains.
  - **A command unclaimed for 30 minutes expires.** An offline machine does not
    come back to a week of stale requests.

  `EndpointCommandType` has three values and each maps to one specific
  read-only collection. There is no type that runs arbitrary code, and there
  will not be: the agent runs as SYSTEM on every managed machine, so such a
  type would turn a compromise of the console into arbitrary SYSTEM execution
  across the fleet in one `INSERT`.

- **Nothing an endpoint reports is trusted as it arrives.** `/enrollment/*` is
  public by necessity — a machine speaks there, not a person — so every field
  from a heartbeat or a command result is clamped before it reaches a column:
  strings length-limited, numbers range-checked, arrays truncated, unrecognised
  fields dropped. Reported timestamps are bounded to 1990–2100, because a
  machine with a dead CMOS battery reports 1980 and every "how old is this?"
  calculation downstream then reads as absurd. The pending-update count is
  derived from the list that survived sanitising rather than from a number sent
  alongside it — those two disagreeing is how a badge ends up reading "12
  updates" over a list of three.

  `/enrollment/command-result` requires the device secret outright, unlike the
  heartbeat. A heartbeat without one still has a job — recording liveness for a
  fleet enrolled before secrets existed — but a command result without one has
  none, and accepting it would let anyone who knows a RustDesk ID write a
  customer's event log contents into the console.

- **The API's JSON body limit is now 1 MB**, explicitly, where it was Express's
  default 100 KB. A 200-event page is several times that and would have come
  back as a 413 the agent has no way to report. The cap is chosen to fit what
  the sanitiser already allows, not to be generous.

### Fixed

- **Every session in Recent Sessions read "Connecting…", including ones a
  technician was actively working in and ones from the day before.**
  `CLIENT_OPENED` is the furthest any session ever gets — Rem0te's part ends
  when it hands out the credential, RustDesk carries the connection, and hbbs
  logs nothing for a connect or a disconnect, so nothing reports back
  afterwards. Labelling that terminal state as an intermediate one meant the
  label was guaranteed to be wrong forever. It now reads **Launched**, and the
  type in `session-status-badge.tsx` carries a note about why no label there may
  imply progress.

- **Sessions that opened a client stayed "active" permanently.** `getStats`
  counts active as anything not in (SESSION_COMPLETED, FAILED, CANCELED), and
  nothing ever moved a `CLIENT_OPENED` row out of that set, so every Connect
  ever clicked was counted as an ongoing session — four clicks in one minute
  read as four live sessions, and yesterday's read as live too.

  `closeAbandonedSessions` now completes sessions whose client opened more than
  **12 hours** ago with no end recorded. Deliberately separate from
  `expireStaleSessions`, which fails clicks that never reached a client at all:
  these did start, so they are recorded as completed rather than failed, and
  the threshold is generous because closing one early would mark a technician's
  genuinely long session done underneath them. `duration` is left null — we
  know when it started and are inferring when it stopped, and writing a number
  would put a fabricated figure into the average session length.

- **Two different `useQuery` fetchers shared the key `['app-version']`.** The
  About page's Platform-Admin version query and the new sidebar one would have
  landed on one cache entry, and whichever mounted first would have decided
  what the other read. The admin payload is now keyed `['platform-version']`.

### Notes for operators

- **Schema change** — two new tables (`EndpointInventory`, `EndpointCommand`),
  two new enums, two new `ActivityAction` values. Additive: every column is
  nullable or defaulted and no existing row is touched. Migration
  `0013_endpoint_inventory_and_commands`. Follow the schema-change steps in
  CLAUDE.md, or the API throws `Unknown field ... on model ...` at runtime
  because the deploy target generates its own Prisma client.

- **Existing endpoints report nothing new until their installer is re-run.**
  The heartbeat script is written to disk at install time, so an endpoint runs
  whatever agent its last install left behind. The Overview tab distinguishes
  the two reasons a machine has no specs — never bound a device secret, versus
  an agent older than v0.14.0 — rather than showing empty cards with no
  explanation. Re-running the managed installer fixes both, and a staged
  RustDesk client upgrade re-runs it as a side effect.

- Sizes in `EndpointInventory` are stored in **megabytes**. Prisma maps
  `BigInt` to a JavaScript `BigInt` and `JSON.stringify` throws on those, so a
  byte count in a column would take down whichever response carried it.
  Byte-precise per-disk figures live inside the JSON columns as ordinary JSON
  numbers.

---

## [0.13.9] — 2026-09-15 · *Deadbolt*

### Changed

- **MSPReboot offers hosting and support for Rem0te; the README said it did
  not.** The earlier wording — "this project does not come with a paid support
  offering or any service-level commitment" — came from reading mspreboot.com,
  which advertises consulting, and from a deliberate rule against claiming a
  support relationship that could not be verified. The publisher has confirmed
  the offering, which is the verification that was missing. Corrected in the
  README, `docs/github-about.md` and the published v0.13.5 release notes.

  Both halves are kept true: Rem0te stays MIT-licensed and free to self-host,
  and self-hosting requires no engagement. No uptime, response-time or
  service-level figures are attached, because none are published anywhere
  checkable — `docs/github-about.md` records that constraint for future copy.

### Added

- **`CLAUDE.md` now documents the capture toolchain**, which had grown to four
  scripts while the only mention was a single stale bullet naming the original
  one. It records which script writes where and who consumes it, that `media/`
  is gitignored and root-anchored (a bare `media/` also matches `docs/media/`,
  which is tracked), that themes come from the application's own store rather
  than a CSS filter, and what capture-time masking covers and why it is not
  optional — the demo API reads the real host, so the Security page names the
  live certificate domain and the audit log carries real addresses.

  Three new entries under *Things that will bite you*, each from a defect that
  reached a published screenshot before being caught: the `isOnline` sweep that
  desynchronises a stale demo database from the dashboard, the dead
  `EndpointStatus.OFFLINE` enum value that hides machines from the totals, and
  the standalone build baking its API rewrite in at build time.

---

## [0.13.8] — 2026-09-15 · *Deadbolt*

### Fixed

- **The Stars badge linked to a page that 404s for the people most likely to
  click it.** GitHub now returns 404 on `/stargazers` and `/watchers` to
  signed-out visitors, and a signed-out visitor is most of a public README's
  audience. Checking it while signed in — or with a plain `curl` that follows
  GitHub's redirect for authenticated agents — hides this. The badge now points
  at the repository root.

  Found by resolving all 57 links on the rendered page and then re-checking the
  failures individually: six of the seven were HTTP 429 from checking too fast,
  not real breakage. Only this one was genuine.

---

## [0.13.7] — 2026-09-15 · *Deadbolt*

### Fixed

- **Two inaccuracies in the README, found by reading it as GitHub renders it
  rather than as source.** The gallery link said "See all 30 screenshots"
  against a gallery of 31, and the hero image's alt text described "32 total
  computers with 24 online" — the numbers from an earlier capture, not the ones
  in the image it labels (34 / 26 / 8). Alt text that misdescribes its own
  image is worse than none: it is the only version a screen reader gets. The
  matching alt text on the dark dashboard in the gallery had the same stale
  numbers and is corrected too.

  Everything else rendered correctly on GitHub and was checked rather than
  assumed: 12 images all load, the Mermaid diagram renders natively, five
  tables and the video poster are fine.

---

## [0.13.6] — 2026-09-15 · *Deadbolt*

### Changed

- **The walkthrough is published, so the README links it instead of explaining
  its absence.** 0.13.5 shipped the recording but deliberately did not commit
  it — video binaries do not belong in Git history — which left the README
  carrying a note saying where the video would eventually be. It is now a
  release asset on `v0.13.5`, and the README shows a clickable poster with the
  duration, a highlight cut, the transcript and the caption file. The gallery
  header links it too.

  The poster is a real frame from the recording with a play affordance
  composited on. The dashboard numbers in it (32 computers) differ slightly
  from the gallery's (34) because the two were captured in separate sessions —
  both are genuine states of the demo database, not retouched.

---

## [0.13.5] — 2026-09-15 · *Deadbolt*

### Added

- **A 30-image screenshot gallery at `docs/screenshots.md`**, captured from the
  running UI at 1440×1000 retina across both themes, organised by workflow with
  a table of contents. The README keeps a hero and six selected images and links
  out; the previous five-image README tour is superseded.
- **`apps/web/scripts/capture-media.mjs`** — reproducible gallery capture.
  Themes are driven through the application's own store (`localStorage.theme`,
  which `ThemeProvider` turns into `<html class="dark">`), never a CSS filter,
  so what lands in the gallery is the shipped theme. It refuses an `https://`
  target or port 3000/443 outright, and writes
  `docs/images/github/manifest.json` recording the route, theme and viewport
  behind every image.
- **`apps/web/scripts/capture-video.mjs` and `scripts/build-video.sh`** — a
  caption-led walkthrough of the real application (2m31s), a 52-second highlight
  cut and a poster frame, rendered to H.264/AAC MP4. Output lands in `media/`,
  which is gitignored: video binaries do not belong in Git history, so these are
  published as release assets. Script and captions are tracked, in
  `docs/media/walkthrough-script.md` and `docs/media/walkthrough.vtt`.
  **No narration was recorded** — the transcript carries a narration-ready
  script and says so.
- **`.github/dependabot.yml`**, for the `ignore` rules rather than the schedule.
  The usable esbuild window is narrow enough that no automated bump lands
  inside it, so esbuild is ignored outright with the reasoning inline.

### Fixed

- **The demo dataset marked disconnected machines `EndpointStatus.OFFLINE`.**
  The API never writes that value — it is an unused enum member — and the
  dashboard counts `status: ACTIVE` rows and derives "offline" from `isOnline`.
  Eight machines were therefore excluded from the totals entirely, so the
  dashboard read "24 computers, 0 offline, 100% availability" against a seed
  that deliberately contained offline ones. Enrolment lifecycle and connectivity
  are now modelled separately, as the application does.
- **Endpoint addresses were in `203.0.113.0/24`,** which no GeoIP database
  resolves, so the dashboard map — the product's most useful visual — rendered
  empty. Each demo site now carries an address chosen only because the deployed
  GeoIP database places it in that business's city. They are office-egress
  addresses for businesses that do not exist, and the capture layer replaces
  every public address with `198.51.100.24` before the shutter, so none is
  published.

### Security

- **Capture-time masking, applied in the DOM and never written back.**
  Enrollment tokens, long hex secrets, RustDesk IDs and public IP addresses are
  replaced with obvious sample values immediately before each screenshot and
  each video frame. Two leaks this caught, both from the demo API reading the
  real host: the Security page named the live deployment's certificate domain,
  and the audit log published the routable addresses used for map placement.
  Any FQDN outside a small allowlist is now replaced; `mspreboot.com`,
  `github.com`, `rustdesk.com` and `example.com` are deliberately preserved.

---

## [0.13.4] — 2026-09-15 · *Deadbolt*

### Security

- **`pnpm audit` was failing on four advisories published since main last passed
  (2026-08-31).** All four are transitive and none is reachable from
  request-handling code, but the audit job is what keeps the tree at zero and it
  had been red on every CI run since.
  - `browserslist` <=4.28.6 — unbounded cache growth leading to OOM, via
    `@nestjs/cli > fork-ts-checker-webpack-plugin > webpack`. Overridden to
    `>=4.28.7 <4.29.0`; resolves 4.28.9.
  - `postcss-selector-parser` >=6.1.0 <6.1.3 — ReDoS, via `tailwindcss`.
    Overridden to `>=6.1.3`; resolves 7.1.6, which Tailwind builds clean against.
  - `qs` — the existing `>=6.15.2` override sat inside the new advisory window
    (>=6.14.2 <=6.15.3). Raised to `>=6.16.0`.
  - `js-yaml` — existing `>=4.3.1` raised to `>=4.3.2`.

  Both override lists were updated, as `pnpm-workspace.yaml` documents: pnpm
  <=10 reads `package.json`, pnpm >=11 reads the workspace file, and CI runs
  pnpm 11 while local development is on 10. A fix in only one works in exactly
  one of the two places.

### Fixed

- **CI's pnpm rejects any lockfile entry younger than 24 hours**
  (`minimumReleaseAge`), and local pnpm 10 does not enforce it — so a lockfile
  that resolves fine here can fail the install in CI with
  `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`. The first attempt at the overrides
  above did exactly that: an unconstrained `browserslist: >=4.28.7` resolved to
  4.29.0, published that morning, and dragged `electron-to-chromium` to that
  day's release with it.

  Two constraints keep the resolution off same-day releases: `browserslist` is
  capped below 4.29.0 (4.28.9, 2026-09-04, is patched and eleven days old), and
  `electron-to-chromium` — which publishes most days and is pulled in by
  browserslist — is capped below 1.5.428. The second is **not** a security pin
  and can be raised freely; it is a data table of Chromium versions.

  Worth knowing when touching dependencies here: the policy checks every entry
  in the lockfile, not just changed ones, so a wide re-resolution is far more
  likely to trip it than a narrow one. Regenerating from `main`'s lockfile and
  changing only what the overrides force keeps the diff to 9 entries.

  Verified: `pnpm audit` clean, `--frozen-lockfile` install, lint, both
  typechecks, a full `pnpm build`, and every newly added lockfile entry
  confirmed older than 24 hours.

  The `esbuild` window is deliberately untouched — it is pinned below 0.27.7 for
  the Tauri launcher's safari13 target, and widening it to clear an advisory
  would break that build.

---

## [0.13.3] — 2026-09-15 · *Deadbolt*

### Removed

- **34 screenshots that nothing referenced — 3.6 MB.** `gen-docs-bundle.mjs`
  copies the whole of `docs/screenshots/` into `apps/web/public/docs-img`, so
  every one of them was being committed *and* shipped in the deployed web app
  while no page embedded it. Of 43 tracked images, 9 are actually referenced by
  `docs/*.md`. The dark variants could never have been used at all: there is no
  theme-based image swapping anywhere in the app, and the generated docs bundle
  contains no `-dark.png` reference.
- **`packages/types`.** A workspace package exporting 144 lines that nothing
  imported — the only mention of `@reboot-remote/types` in the repository was
  its own `package.json`. It sat at 0.1.0 while the other three packages moved
  together, which is the giveaway. `pnpm-lock.yaml` regenerated; the change is
  two lines and `pnpm install --frozen-lockfile` still passes.

### Changed

- **`screenshots.mjs` now writes only what the docs embed.** It captured 13
  pages plus a public page in two themes each, and exactly one of those outputs
  (`updates-light.png`) was referenced; the rest were regenerated and
  re-committed every run. `PAGES` is trimmed to that one page, `PUBLIC_PAGES`
  is empty, and themes default to light with `SCREENSHOT_THEMES=light,dark` to
  opt back in. Deleting the files without this would have brought them straight
  back on the next run.
- **`docs/github-about.md` corrected.** It said no website existed; the
  repository has `https://mspreboot.com` set, which resolves. It now records
  that, notes the URL is the maintainer's consulting site rather than a Rem0te
  product page, and lists the thirteen topics that are actually set rather than
  the ten originally proposed.

### Kept, deliberately

- **`dist/windows-installer.exe`** looks like a committed build artifact, and
  is one, but `deploy/scripts/install.sh` copies it out of the checkout and
  never builds it — there is no Go toolchain step in the installer. Removing it
  breaks every fresh install.
- **`semgrep-rules/nodejs-security.yml`** is not referenced by CI, but
  `apps/api/src/admin/security.service.ts` loads it at runtime for the Security
  page.
- **`docs/screenshots/guide/tech-01-signin.png`** is referenced by the
  technician guide and is *not* reproducible by `screenshots.mjs` — it predates
  the callout pipeline and was never migrated into it.

---

## [0.13.2] — 2026-09-15 · *Deadbolt*

### Changed

- **Rewrote the README around what an operator actually does.** It led with a
  claim ("Secure self-hosted remote access for businesses") and then spent most
  of its length on internal mechanics — the `connect` route's response shape, a
  threat-model table, ASCII diagrams of the enrollment flow. None of that tells
  someone landing on the repo whether this solves their problem. It now leads
  with the positioning line, one real screenshot, and three workflow benefits,
  and links out to `docs/` for the mechanics that were inlined.
- **The version badge said 0.8.1.** Five minor releases had shipped since. It is
  now 0.13.2, alongside a CI badge that reflects the checks that actually run.
- **Documented that RustDesk Pro is not required, with the reason.** Every
  generated client config sets `api-server = ''` and the installer pulls `hbbs`
  and `hbbr` from the OSS `rustdesk/rustdesk-server` releases, so the Pro API
  server is deliberately unused. This was true before and written down nowhere,
  which made it a question every evaluator had to answer for themselves.
- **Said plainly that connecting launches a local RustDesk client.** The old
  README described a browser-based product without ever stating that a
  `rustdesk://` handler — and therefore an installed client — is required. That
  is the first thing a new user hits when it does not work.
- **Separated managed devices from Quick Connect in a table**, because the two
  were described in adjacent sections that never contrasted them.

### Added

- **Real screenshots under `docs/images/github/`** — one hero and four
  supporting images, captured from the running UI at 1440×900 against an
  isolated `reboot_remote_docs` database. Fictitious businesses, synthetic
  RustDesk IDs, and endpoint addresses in `203.0.113.0/24` (TEST-NET-3), so
  nothing in them can reach a real machine.
- **`.github/SECURITY.md`** — there was no reporting policy, so the only route
  for a vulnerability was a public issue. It points at private vulnerability
  reporting, and states that `docs/SECURITY-AUDIT.md` is an internal review and
  not an independent audit.
- **`docs/github-about.md`** — the About-panel description, topics, and the
  repository settings that have to be applied by hand.

### Fixed

- **`prisma/_docs-demo-data.ts` could not run.** It wrote `ComputerAccess` with
  `grantedById` and no `tenantId`; the model has `grantedBy` and requires
  `tenantId`, so the seed threw partway through and left the database half
  populated. It now also grants the technician access to the machines it
  creates, which is why **My Computers** was empty in every previous capture,
  and varies device counts, platforms and onboarding dates so a screenshot does
  not read as placeholder data.
- **`gen-docs-bundle.mjs` rejected repo-metadata pages in `docs/`.** Any `.md`
  there that is not in `ORDER` fails the build — deliberately, so a user-facing
  page cannot silently vanish from `/docs`. `github-about.md` is for
  maintainers and does not belong in the app, so there is now a small
  `NOT_IN_APP` set it is listed in, leaving the guard intact for real pages.

---

## [0.13.1] — 2026-08-31 · *Deadbolt*

### Changed

- **CI runs `check-security-invariants.mjs`.** The script shipped in 0.13.0 but
  only ever ran by hand, which is the state the checks it replaces were already
  in. Every defect it looks for produced no signal at all — no exception, no log
  line, no failing test — so a check nobody remembers to run is worth about as
  much as no check.

---

## [0.13.0] — 2026-08-31 · *Deadbolt*

Findings from a full-repository security review, fixed. Nothing here changes
what the product does; several things change what it refuses to do.

### Security

- **MFA could be skipped entirely.** A user with TOTP who entered the correct
  password received a `partial: true` token — signed with the same `JWT_SECRET`
  as a real session token, and returned in the login response body as well as a
  cookie. `JwtStrategy.validate()` accepted it: for a partial token it checked
  only that the account was active and returned the payload. It therefore worked
  as a bearer credential on every route for ten minutes, and since both
  permission guards short-circuit on `isPlatformAdmin` and `effectiveCapabilities`
  grants everything to platform admins and owners, password-only authentication
  was full access for exactly the two levels that matter.

  The strategy now refuses any token carrying `partial`, and the pre-MFA token is
  signed with a key derived from `JWT_SECRET` (HMAC, no new environment
  variable), so a partial token and a session token can never be interchangeable
  again. `/auth/mfa/verify` verifies it against that key, which is the only place
  one is meant to be consumed.

- **Every per-route rate limit was inert.** `ThrottlerModule.forRoot()` declared
  throttlers named `short` and `long`; every route wrote
  `@Throttle({ default: … })`. The guard looks up overrides by each *configured*
  throttler's name, so nothing keyed `default` was ever read, and login, MFA
  verify, recovery codes, enrollment, heartbeat, grant redemption and launcher
  validation all ran at the global 300/minute instead of their stated limits.
  Confirmed by probe: thirteen consecutive bad logins, thirteen 401s, no 429.

  Throttler names now live in `common/throttling.ts` alongside a `RateLimit()`
  decorator that builds the key from the same constant, so the two cannot drift.

- **There was no account lockout.** `maxLoginAttempts` and `lockoutMinutes` have
  been in `PlatformSecurityConfig` and on the Security page since before any code
  read them — an operator could set a policy that did nothing. Failed password
  attempts are now counted per account and the configured lockout is enforced,
  which is the half of brute-force defence that survives an attacker spreading
  attempts across addresses. A `DELETED` account can also no longer complete a
  login it was never going to be able to use.

- **The device heartbeat authenticated nothing.** `POST /enrollment/heartbeat`
  is public — it is called by machines — and identified the caller solely by its
  RustDesk ID, a number printed in the RustDesk window and given to every
  technician who has ever connected. Anyone who knew one could collect that
  machine's staged password rotation **in plaintext**, overwrite the password the
  console hands technicians, rewrite its hostname and its address (which places
  it on the dashboard map), and create endpoint rows at will.

  The installers now generate a per-device secret, store it beside the heartbeat
  state (SYSTEM+Administrators on Windows, 0600 elsewhere), and send it on claim,
  heartbeat and rotation-confirm. The server binds it at claim time or on first
  sight, then requires it. A machine enrolled before this still reports itself
  online — refusing that would take a fleet offline — but nothing it says is
  written and no rotation is handed to it until its installer is re-run.

- **`sudo fail2ban-client` accepted any arguments.** An unrestricted
  fail2ban-client is a root shell: define an action, point its `actionban` at a
  command, trigger a ban. Every other rule in `/etc/sudoers.d/reboot-remote`
  pins its exact argument vector — the file's own header says so — and this one
  did not, so a compromise of the API process was a compromise of the host. Now
  pinned per subcommand, with the third argument a literal keyword in every rule.

- **The launcher trusted the API address in the deep link.** `api=` was taken
  from the `reboot-remote://` fragment with no allowlist, and any web page can
  invoke a custom scheme. A crafted link handed the technician's launcher token
  to an attacker's server as a bearer credential, and that server's reply chose
  the `rustdeskConfig` the launcher applied — repointing their RustDesk at a
  hostile rendezvous and relay. The launcher now talks only to the server it was
  built for (`REM0TE_API_BASE`), and a link naming anything else is refused with
  the host it tried to reach.

- **rustdesk-server packages were installed as root without verification.** Both
  .debs were downloaded from GitHub through up to five unvalidated redirects and
  handed to `sudo dpkg -i` with no checksum. The release API publishes a SHA-256
  per asset; that digest is now required, checked after download, and a mismatch
  deletes the file and installs nothing.

- **Single-use tokens were not atomically single-use.** Launcher tokens and
  connection grants were read, tested for `usedAt`, and then updated, so two
  simultaneous redemptions of one token both passed. Both now claim the row with
  a conditional update and treat "nothing updated" as already used.

- **Open redirect after sign-in.** `returnTo` came from the query string and went
  to `router.push()` unvalidated, so a link could land someone on an attacker's
  page the moment they signed in successfully. Only same-site paths are accepted.

- **`/downloads` skipped the middleware auth gate**, because `/download` was
  matched as a prefix — the exact mistake the comment beside it warns about for
  `/quick`. Both are exact matches now.

- **The logo upload wrote the file before checking authorization.** Guards run
  before interceptors and the platform-admin check was in the handler body, so
  any signed-in user could write 2 MB into the upload directory repeatedly and be
  told "no" each time. The check is now a guard.

- **Launcher tokens were stored in the database in plaintext**, alone among this
  system's bearer credentials. Stored as SHA-256 now, like claim tokens,
  connection grants and API keys.

- **A session token with no tenant kept its frozen claims.** Role, business and
  capabilities are now re-read from the database on that path too, as they
  already were on every other.

- **AES-GCM now uses a 12-byte nonce** rather than 16. The IV travels with each
  record, so everything written before this still decrypts.

- **The Windows installer binary refuses a non-https script URL**, and the API
  refuses to bake one into it in production. What that URL returns is piped into
  an elevated PowerShell.

### Changed

- `RustdeskNode` gains `agentSecretHash` and `agentSecretSetAt`
  (migration `0012_agent_device_secret`), and the audit trail gains
  `ENDPOINT_HEARTBEAT_REJECTED` for a heartbeat that fails the device check.

---

## [0.12.4] — 2026-08-31 · *Ledger*

### Fixed

- **The detailed basemap 307'd to the login page.** The middleware matcher
  exempts the map geometry by exact filename, deliberately rather than by
  prefix, so `world-basemap-detail.json` — added in 0.12.3 — was never exempt
  and every deep zoom silently fell back to the coarse outline. The redirect was
  invisible: the fetch failure path leaves the coarse map in place by design.
  Both filenames are now listed.

---

## [0.12.3] — 2026-08-31 · *Ledger*

### Changed

- **The client map named nothing on it.** The previous pass gave it borders and
  water, but every shape was anonymous: no country had a name, no state had a
  name, and the only text on the map was the city under a marker. A support
  technician looking at where their fleet is should not have to recognise
  countries by outline.

  The basemap now carries names, and the map draws them. Every country has a
  label and the states and provinces of the thirteen countries where they are
  big enough to read — the US, Canada, Mexico, Brazil, Australia, China, India,
  Russia among them — appear as you zoom in, abbreviated (FL, TX, ON) where the
  abbreviation is one people know and spelled out further in. Which names fit is
  decided per frame: candidates are ranked, largest stake first, and anything
  that would collide with a name already placed, sit on top of a marker, or run
  off the edge of the card is nudged or dropped.

  Names are HTML in a layer over the SVG rather than `<text>` inside it. Inside
  the SVG a label's size is in world units scaled by the viewBox, which lands on
  fractional pixel sizes and hands the rasteriser something it cannot hint; in
  the overlay every label is an integer CSS pixel size like the rest of the page.

- **Land is coloured by geography rather than by one flat fill.** Each continent
  gets a hue family — ochre across Africa, olive through Asia, greens in Europe
  and the Americas, terracotta in Oceania — and Natural Earth's nine-colour
  map colouring shifts each country inside its family, which guarantees no two
  neighbours share a shade. Water is a deeper navy underneath it.

### Fixed

- **The coastline showed its corners past about 5× zoom.** Geometry simplified
  hard enough to keep the payload small is geometry with visible facets when you
  zoom into it, and the map allows 60×.

  There are now two basemaps. `world-basemap.json` (235 KB gzipped) paints
  immediately; `world-basemap-detail.json` (830 KB) is fetched once, lazily, the
  first time someone zooms past 5× — the point where the difference becomes
  visible — and swapped in. If that fetch fails the coarse outline stays, which
  is a worse map but still a map. Both are still local assets: the dashboard
  calls no tile server with our customers' whereabouts.

- Both files are generated by `scripts/gen-basemap.mjs`, which was previously
  nowhere in the repo — the old basemap had been produced by hand and could not
  be reproduced or retuned.

---

## [0.12.2] — 2026-08-31 · *Ledger*

### Fixed

- **The client map had no borders and barely any colour.** It drew a single
  landmass silhouette from 110m geometry: no country outlines, no state lines,
  and grey-on-grey, which read as monochrome. It also could not usefully zoom,
  because that geometry turns into abstract polygons a few steps in.

  The basemap is now 50m world countries plus 10m US states, drawn as three
  layers — land, internal (state) borders, then country borders on top so the
  heavier line always wins — over water in a colour that actually contrasts with
  it. Zoom goes considerably further in before the outline gives up, and the map
  is a little taller.

  The geometry is 380 KB (125 KB gzipped, cached immutably) rather than the
  1.4 MB the raw 50m + 10m sets weigh: rings smaller than the eye can resolve at
  this scale are dropped, and the rest are simplified with Douglas–Peucker at a
  tolerance below the rendered pixel size. Still a local asset, so the page
  continues to call no tile server.

---

## [0.12.1] — 2026-08-31 · *Ledger*

### Fixed

- **The client map was unreadable.** It filled a third of the dashboard, drew
  pale grey land on a pale grey background with no water, had no labels, and
  offered no way to zoom or pan — a decoration rather than a map.

  Now 240px tall with land over water in colours that actually separate, place
  labels with a halo so they read over either, zoom and pan (buttons, scroll
  wheel anchored to the cursor, drag), and a fit-to-clients control. Zoom is
  capped because the bundled 110m outline stops looking like a map well before
  the browser stops zooming.

- **One city appeared as two places.** DB-IP qualifies some cities with a
  neighbourhood, so a machine in "Jacksonville" and another in "Jacksonville
  (Lakeshore South)" — the same city, a few miles apart — produced two markers
  whose labels overlapped into unreadable text. The suffix is now dropped, so
  they group into one marker, and labels are placed largest-first with
  overlapping ones skipped rather than drawn on top of each other.

- **Markers vanished at high zoom.** Label halos were stroked in world units, so
  zooming in scaled a 3-unit outline into a white mass that swallowed the
  markers underneath. Strokes are screen-space now.

---

## [0.12.0] — 2026-08-31 · *Ledger*

### Added

- **Client location map on the dashboard.** Plots where the computers you can
  see are checking in from — clustered by place, sized by how many are there,
  pulsing while any are online, with detail on hover and a machine list on
  click. The view fits itself to the fleet, because a handful of machines in one
  city drawn on a whole-world projection is three invisible pixels.

  **Scoped to what each person may actually see, not to their business.** A
  Business User sees only the computers granted to them plus any marked
  COMPANY_WIDE, and that rule previously lived inline in a single list query —
  so a map filtered on business alone would have pinned every ASSIGNED_USERS
  machine in their business for someone with no access to it. The rule now lives
  in `AccessControlService.endpointVisibilityWhere`, shared by the list and the
  map so the two cannot drift, and is verified against the shipped service: a
  Business User holding one grant sees that machine and the COMPANY_WIDE one,
  and neither the unassigned machine in their own business nor anything
  belonging to another business. Without `computers:view` the card is absent
  rather than empty. No raw IP addresses are returned — the map needs a
  location, not an address.

  Geolocation is offline, reading DB-IP City Lite: the addresses belong to
  customers' networks, and posting them to a lookup API on every dashboard load
  is a disclosure we would be making on their behalf. geoip-lite's bundled data
  was tried first and was not good enough — it placed a Jacksonville endpoint on
  the US centroid because it had never heard of the regional ISP, putting two
  machines a few miles apart in different states. The ~124 MB database is not in
  the repository; `scripts/update-geoip.sh` installs it and a missing file
  degrades to "no locations" rather than breaking the page. The world outline is
  a bundled 75 KB asset, so nothing calls a tile server.

  Where only a country is known the marker is dashed and labelled country-level,
  because a solid pin on a country centroid claims a precision we do not have.
  Machines that cannot be placed are counted as "unlocatable" rather than
  dropped, so the map is never quietly narrower than the fleet it shows.

### Fixed

- **Recent Sessions showed nothing but failures.** Connecting to a computer
  created no session record at all: only the desktop launcher promoted a session
  to CLIENT_OPENED, and the browser path — the one people actually use —
  recorded nothing. The only rows in the list were ad-hoc records typed in by
  hand, which then aged into FAILED because the v0.8.2 sweeper correctly
  observed that no client had ever opened for them. Connecting now records a
  session, best-effort so bookkeeping can never block a connection, and the
  sweeper no longer fails ad-hoc rows — nothing ever opens a client for those.

---

## [0.11.1] — 2026-08-31 · *Ledger*

### Added

- **CI is in the repository.** `.github/workflows/ci.yml` runs `pnpm lint`,
  `pnpm typecheck`, `pnpm build` and `node scripts/check-versions.mjs` on every
  push and pull request, plus `pnpm audit` as a second job to hold the tree at
  the zero it reached in 0.11.0.

  It also builds the launcher, which `pnpm typecheck` and `pnpm build` do not
  cover — they run against api and web only. The launcher is the package that
  broke most recently, and it targets `safari13`, which is precisely what makes
  it sensitive to esbuild bumps, so leaving it outside CI would leave the gap
  that caused the last breakage.

  `pnpm db:generate` runs before the typecheck: tsc cannot resolve
  `@prisma/client`'s generated types until it has, and a fresh checkout has not.

  The 0.10.2 note said this could not be pushed because the token lacked
  `workflow` scope. The token has `workflow` scope, and had it then. Nothing was
  blocking it.

### Fixed

- **`pnpm lint` had been broken since 0.11.0, by the fix for an advisory that
  did not apply to what it broke.** The ajv override was written as a blanket
  `>=8.18.0`, but `@eslint/eslintrc` pins `ajv ^6.14.0`, so eslint was handed an
  incompatible major and died on every run with `Cannot set properties of
  undefined (setting 'defaultMeta')`.

  The advisory covers `>=7.0.0 <8.18.0` — ajv 6 was never in scope. The override
  is now scoped to that range, so `@nestjs/cli`'s ajv 8 is still raised and
  eslint keeps the version it asks for. Both the audit and the lint pass.

  This is the failure CI exists to catch, and it went in during a release where
  builds were checked and lint was not.

---

## [0.11.0] — 2026-08-30 · *Ledger*

### Security

- **Middleware could be skipped entirely, and middleware is the only thing
  guarding the app.** Next.js 14.2.18 carries CVE-2025-29927: a request with a
  crafted `x-middleware-subrequest` header bypasses middleware altogether.
  `apps/web/middleware.ts` is the whole authentication gate — no `access_token`
  cookie, redirect to `/login` — so the bypass reached every signed-in page
  without an account. Directly exploitable here, not a theoretical advisory
  about a feature nobody uses. Fixed by 14.2.18 → 14.2.35, a patch release.

- **Every other advisory in the tree is now closed — 103 down to 0.** The
  dependencies had never been audited, because there was no way to: `pnpm audit`
  was never run against this lockfile. axios accounted for 28 of them and moved
  1.7.7 → 1.16.0 inside its major. Next went 14.2.35 → 15.5.24 for the remaining
  21. The rest are transitive and pinned through `overrides` in
  `pnpm-workspace.yaml`, each with its floor written next to it.

### Fixed

- **`tenants.controller.ts` imported a package that was never a dependency.**
  It takes `diskStorage` from `multer`, which was not in `apps/api`'s
  dependencies and resolved only because pnpm happened to hoist it out of
  `@nestjs/platform-express`. Any change to how multer resolved would break the
  API at import time — which is exactly what happened while bumping it. Now
  declared, with `@types/multer`.

- **`@nestjs/core` and `@nestjs/common` had drifted apart.** core floated to
  11.2.3 against common 11.1.16, and the API compiled cleanly and then failed to
  start: `Cannot find module '@nestjs/common/decorators/http/sse-signal.decorator'`,
  a decorator that only exists in common 11.2. The three Nest packages ship in
  lockstep and are pinned together now. A typecheck does not catch this; importing
  the built module does, and that check is worth keeping.

- **The build scripts the project asks for were not running.** pnpm 11 stopped
  reading the `pnpm` field from `package.json`, so `onlyBuiltDependencies` — the
  list that lets argon2 and prisma compile their native binaries — was being
  ignored with a warning nobody was reading. The settings live in
  `pnpm-workspace.yaml` now as `overrides` and `allowBuilds`, and stay mirrored
  in `package.json` for pnpm 10 and earlier.

### Changed

- **Next.js 15.** Cheaper than a framework major usually is, for two reasons
  worth recording: 15 still accepts React 18, so React did not have to move, and
  the app was already written against the async request APIs — the one dynamic
  route already types `params` as `Promise<{ slug: string }>` and awaits it, and
  there are no `cookies()`, `headers()`, server actions or route handlers to
  convert. 15 pulls in `sharp`, whose versions below 0.35 inherit four libvips
  CVEs, so the upgrade brought one advisory of its own; it is pinned to 0.35.

- **The launcher builds on vite 6.4.3, and esbuild is pinned below 0.27.3.**
  The launcher targets `safari13` because Tauri supports macOS 10.15, and
  esbuild 0.27.7 dropped destructuring lowering for that target — the override
  taken for a security advisory broke the build outright. `>=0.25.0 <0.27.3`
  clears both esbuild advisories, because the second one's vulnerable range only
  begins at 0.27.3, and still compiles. Boundaries checked version by version
  rather than guessed; vite 6.4.x asks for esbuild `^0.25.0`, so the two agree.

---

## [0.10.2] — 2026-08-27 · *Ledger*

### Known gaps

- **CI still is not in the repository.** The workflow has existed on one machine
  since v0.8.1 and cannot be pushed: GitHub rejects any push touching
  `.github/workflows/` from a token without `workflow` scope, and the token in
  use has `repo` but not that. So the check that exists to stop things breaking
  quietly is itself only running quietly, in one place, where nobody else can
  see it.

  Until it lands, `pnpm lint`, `pnpm typecheck`, `pnpm build` and
  `node scripts/check-versions.mjs` have to be run by hand before a commit —
  the last of these is what makes "every change bumps the version" a rule
  rather than an intention, and nothing enforces it on anyone else's machine.

  The file is written and ready. It needs `workflow` scope on the token, or one
  paste into GitHub's web editor, which needs no scope at all.

  **Resolved in 0.11.1.** The token did have `workflow` scope — the diagnosis
  above was wrong, and the workflow had been sitting unpushed against a
  restriction that was not there.

---

## [0.10.1] — 2026-08-26 · *Ledger*

### Changed

- **The marked-up screenshots are generated now.** The guide images were made
  by hand once and could not be rebuilt, so they went stale the moment the
  navigation changed — one still pointed at a menu entry that had moved. The
  callouts are drawn in the browser before capture, as real DOM, so the browser
  does the layout and nothing has to guess at coordinates after the fact.

  Fourteen captures across seven pages, light and dark, including the Downloads
  page and the searchable documentation. A selector that stops matching is
  reported at the end of the run with the count it found, rather than silently
  producing a picture with no marks on it — which is how the first attempt
  pointed at a Connect button that does not exist on the computers list.

  `docs/clients.md`, `docs/connecting.md` and `docs/troubleshooting.md` carry
  them, each with its numbered points written out.

---

## [0.10.0] — 2026-08-26 · *Ledger*

The documentation stopped being a folder in a repository.

### Added

- **Documentation inside the product, with search.** A **Documentation** section
  in the sidebar renders every page from `docs/` and searches across all of
  them — 12 pages, 114 sections, about nine thousand indexed words. Results
  point at the section, not the page.

  Answering "where are the docs" with a GitHub URL was never going to work for
  the people actually using the thing. `gen-docs-bundle.mjs` compiles the
  markdown to HTML at build time, so the running app ships no markdown parser
  and no filesystem access — just a data module. It runs as `prebuild`, which
  means the bundle cannot drift from `docs/`, and it **fails the build** if a
  page exists on disk but is missing from the ordered list, because a page that
  silently never appears is the failure this all started from.

  The search is deliberately dependency-free. Nine thousand words, fixed at
  build time and already in memory, cost less to scan than an index would cost
  to build.

- **`docs/API-REFERENCE.md` — the complete API surface**, generated from the
  controllers by `scripts/gen-api-reference.mjs`. 188 routes across 23
  controllers, each with its access level and the capability a Business User
  needs.

  Hand-written endpoint lists rot silently, so this one reads the decorators —
  and then checks itself against the route table Nest prints at startup.
  `--check` compares the two and exits non-zero on any disagreement. It earned
  its keep immediately: the first version parsed 137 of 188 routes, and the
  check is what found the three reasons — `@Controller(['businesses',
  'customers'])` array prefixes, files declaring more than one controller, and
  `@Get(['businesses', 'companies'])` array route paths. It now matches
  exactly.

### Changed

- The sidebar's **Help & Docs** is now two entries: **Documentation** for the
  full reference, **Help** for the short in-app answers.

---

## [0.9.0] — 2026-08-26 · *Ledger*

The Connect button assumed something it never checked, and hbbs had been left
behind by an installer that only ever installed.

### Changed

- **Connect now hands over a file that does the whole job.** It used to open
  `rustdesk://connection/new/<id>?password=…` and let Windows route it to the
  installed RustDesk — which works only if that client already knows this
  server, because **the URI scheme has no field for a server address**. A stock
  client, or one that auto-updated away from a Rem0te-configured build, asks
  rustdesk.com instead, is told the ID is unknown, and reports *"the target
  device is offline or does not exist"* about a computer that is online. There
  is no fixing that from inside the link.

  Connect now returns a script named for the target machine that uses the
  RustDesk already there — or fetches a portable copy once into
  `%LOCALAPPDATA%\Rem0te` and reuses it every time after — points it at this
  server, then opens the session with the password applied. It assumes nothing
  about the machine it runs on, and it deletes itself when it finishes, because
  it carries a live credential.

  It deliberately **installs nothing**. The first version ran the RustDesk
  setup executable with `Start-Process -Wait -ArgumentList '--silent-install'`,
  and installing needs elevation — from a non-elevated shell that blocks on a
  UAC prompt behind the console window, so the script sat at "Installing
  RustDesk..." indefinitely. RustDesk runs fine from a folder, so there was
  never a reason to install one to open a session. Two other things made the
  first run slow: the download was repeated on every connect rather than
  cached, and `Invoke-WebRequest` renders a progress bar per chunk, which for a
  ~24 MB file costs far more than the transfer. Both fixed.

### Added

- **Downloads page for technician clients.** The setup script (configure this
  computer, installing RustDesk first if needed), the preconfigured client, and
  stock unconfigured RustDesk. Quick Connect covered the customer's side; the
  technician's own machine had nothing.

- **RustDesk server updates from the Updates page.** hbbs and hbbr had no update
  path at all — `install.sh` installed them once and every later run reported
  "already installed". Shows installed versus latest for both binaries, flags a
  version split between them, flags anything below 1.1.16 as lacking WebSocket
  support, and upgrades in place. Privileges are two fixed-path sudoers rules,
  no wildcards. The card states plainly that the restart blanks hbbs's in-memory
  peer map and every endpoint reads offline for ~30 seconds.

- **Rewritten documentation.** `docs/` now has an index that routes by task, and
  four new pages covering what nothing documented before: `connecting.md` (the
  connect paths and why they differ), `clients.md` (every client Rem0te hands
  out and how each learns the server address), `updates.md` (the three separate
  things that can be out of date), and `troubleshooting.md` (which now leads
  with `hbbs-probe.py`, because the message RustDesk shows almost never names
  the component that produced it). `architecture.md` documents the RustDesk
  configuration chain end to end.

### Fixed

- **Connect never configured the client it was connecting from.** The launcher
  spawned `rustdesk --connect <id>` and nothing else, which silently assumed the
  technician's RustDesk was already pointed at this server. It frequently is
  not — a fresh install, or an auto-update that replaced a Rem0te-configured
  build with a stock one, talks to rustdesk.com's public rendezvous instead,
  where our IDs do not exist. RustDesk reports that as *"the target device is
  offline or does not exist"*, which reads as a broken endpoint and sends you
  to look at the machine that is working fine. `/launcher/validate` now returns
  the same base64 `host=…,key=…` config the installer writes, and the launcher
  applies it with `--config` before connecting, so a deep link works on a
  RustDesk that has never seen this server.

- **The launcher could only ever find RustDesk on PATH.** Its search list put
  the bare name `rustdesk` first and matched any candidate without a path
  separator unconditionally, so `find` returned on the first entry every time
  and the five absolute paths below it were unreachable. On a normal Windows
  install RustDesk is not on PATH: the spawn failed with "program not found"
  while `C:\Program Files\RustDesk\rustdesk.exe` sat there untried. Absolute
  paths are checked first now, PATH is the fallback it was meant to be, and
  applying the config is bounded by a timeout so a hung RustDesk cannot leave
  the Connect button doing nothing.

- **`install.sh` never upgraded rustdesk-server.** It installed hbbs only when
  none was present, so re-running it reported "already installed" and left
  whatever version first landed, forever. That is how a deployment sat on
  1.1.15 long after 1.1.16 shipped — and it is why the `/ws/id` and `/ws/relay`
  routes added in 0.8.2 were dead: 1.1.15 accepts the WebSocket upgrade and
  immediately drops the connection. The script now resolves the latest release,
  validates the tag before it reaches a download URL, and upgrades an older
  install instead of skipping it. **WebSocket rendezvous over 443 works on
  1.1.16**, verified end to end through Caddy: a `PunchHoleRequest` over
  `wss://<host>/ws/id` resolves a live peer and returns `ID_NOT_EXIST` for one
  that does not exist. The 0.8.2 note saying otherwise is superseded.

- **Three copies of "latest RustDesk version", three behaviours.** The installer
  templates, Quick Connect, and the Updates page each fetched the GitHub release
  tag with their own cache and their own fallback — `1.4.6` in one, `1.4.9` in
  another — and only one of the three validated the tag before caching it. The
  unvalidated copy fed `rustdesk-${version}-x86_64.exe` download URLs, so a
  single odd tag would have been cached for an hour and served to every
  installer and Quick Connect download in that window. One helper, one cache,
  one fallback, in `apps/api/src/common/rustdesk-release.ts`.

- **The same drift in the RustDesk server config and the client cache.** Quick
  Connect, the installer templates and the launcher each read the relay host and
  key out of `TenantSettings` and re-derived the config string, and Quick
  Connect owned the only cache of the client binary — so a new download surface
  had to duplicate a 40-line GitHub fetch or reach into another module's cache
  directory. Both now live in `apps/api/src/common/rustdesk.service.ts`.

### Added

- **`deploy/scripts/hbbs-probe.py`** — asks hbbs directly whether a peer is
  reachable, over the native rendezvous port or the WebSocket path, and prints
  `ONLINE` / `OFFLINE` / `ID_NOT_EXIST` / `LICENSE_MISMATCH`. hbbs logs nothing
  when a punch-hole fails, and Rem0te's own online dot is a different signal
  entirely (a 3-minute HTTP heartbeat), so there was previously no way to ask
  the component that actually decides a Connect. `docs/setup.md` now leads its
  RustDesk troubleshooting with it.

### Security

- **Removed the unauthorised peer from `db_v2.sqlite3`.** 0.8.2 locked hbbs and
  hbbr with `-k` and noted that a stranger's peer had registered itself during
  the window when they ran open; the row itself was never deleted. It is gone,
  and it no longer resolves. Existing backup taken first.

### Added

- **Client downloads for the technician's own machine.** Quick Connect always
  covered the customer's side; the computer doing the supporting had nothing,
  which is the gap that made Connect look broken. New **Downloads** page with a
  setup script, a preconfigured client, and stock unconfigured RustDesk. The
  sidebar entry previously called "Downloads" pointed at the endpoint enrolment
  wizard and is now called **Enroll Computer**.

- **The in-app documentation is reachable.** `/help` existed, and was linked
  from exactly one place: the bottom of the Quick Start wizard. It is a sidebar
  entry now, its Connect section has been rewritten to describe the flow that
  actually exists, and it carries a section for the failure people hit —
  "Connect says the computer is offline" — plus a pointer to the full reference
  in `docs/`.

- **Screenshots for Downloads and Updates**, and the whole set regenerated. The
  pipeline now seeds a RustDesk relay host for the run and restores the real one
  afterwards; without it the Downloads page documents its own unconfigured
  state.

### Fixed

- **The Connect script, four times.** Each fix exposed the next, and all four
  are worth recording because three of them were introduced by the fix before:
  the RustDesk installer blocked on a UAC prompt behind the console window; the
  24 MB download ran on every connect and rendered a per-chunk progress bar that
  cost more than the transfer; joining PowerShell statements with `"; "`
  orphaned an `else`, breaking every generated script; and two attempts to
  configure the client by means other than its filename both failed silently,
  each leaving it talking to rustdesk.com and reporting a healthy endpoint as
  offline. `joinPs()` now refuses to emit a continuation keyword after a
  semicolon at build time, and the client is configured the way Quick Connect
  has always done it — by the name it is saved under.

---

## [0.8.2] — 2026-08-26 · *Ledger*

An endpoint that reported "installed successfully" six times in a row while
being impossible to connect to. Four independent faults were stacked on top of
each other, each one hiding the next, plus the reason none of them were
visible: the installer's definition of success never included "RustDesk
actually reached the server".

### Fixed

- **The installer wrote the service config where RustDesk never reads it.**
  The RustDesk service stores its data under
  `C:\Windows\ServiceProfiles\LocalService`, even though `sc qc` reports it
  runs as `LocalSystem`. The installer wrote `ServiceProfiles\LocalSystem` —
  not a real Windows profile — and `System32\config\systemprofile`, which is
  SYSTEM's genuine APPDATA but not what RustDesk uses. The service therefore
  ran on a **default config pointing at the public rustdesk.com rendezvous
  server** while every check passed, because verification only ever looked at
  the paths the installer itself had written. Affected machines were reachable
  by strangers on public infrastructure under a publicly-issued ID; rotate any
  endpoint credential that predates this release.

- **One-click Connect sent the password base64-encoded.** RustDesk uses the
  `rustdesk://` URI password parameter verbatim — `flutter/lib/common.dart`
  passes it straight to `--password` with no decode step. v0.7.1 switched to
  `btoa()` while fixing a genuine encoding bug and picked the wrong encoding,
  so RustDesk received the base64 text *as* the password. The tell was in the
  tree the whole time: Quick Connect used `encodeURIComponent` and worked while
  the other three paths did not. All four now agree.

- **`verification-method` was never set on Windows.** The Linux and macOS
  templates in the same file both set `use-permanent-password`; Windows fell
  back to RustDesk's default and would not reliably accept the credential
  Rem0te stores — so the endpoint answered and rejected a password both ends
  agreed on.

- **The permanent password was set while the service was stopped.** `--password`
  reaches the running service over IPC and lands the credential in the
  service's own profile; with the service stopped it writes into the *calling
  user's* profile, which the service never reads. Rem0te stored and handed out
  a password the endpoint had never been given.

- **Credential rotations desynced roughly three minutes after they succeeded.**
  `heartbeat.ps1` applied a staged rotation and confirmed it but never updated
  `heartbeat.dat`, and the heartbeat handler takes the endpoint-supplied
  password verbatim — so the next heartbeat clobbered the DB back to the
  install-time value while RustDesk held the rotated one, with both ends
  believing they agreed. Any rotation would have done this.

- **Every failed Connect leaked a permanently "active" session.** Sessions were
  created `PENDING` and only left that state when the launcher reported the
  client had opened, with nothing expiring the gap — and the active count is
  everything not completed/failed/cancelled. Ten failed clicks read as ten live
  sessions against one machine. Sessions that never opened a client are now
  failed after 30 minutes; anything that genuinely opened is left alone.

- **The installer could not tell you any of this.** It now refuses to report
  success when the server is certain hbbs has never seen the endpoint, and
  prints service state, a TCP probe of 443 and 21116, and RustDesk's own log —
  the facts that actually discriminate. `sc.exe start` succeeds silently on a
  stuck service and `--get-id` reads the config file directly, so between them
  a completely dead install looked healthy.

### Security

- **hbbs and hbbr now require the server key.** Both ran without `-k`, so any
  client that reached the host could register a peer and the relay would carry
  traffic for any pair that found port 21117. An unrelated peer had registered
  itself into `db_v2.sqlite3`. Shipped as systemd drop-ins, because the
  `rustdesk-server` package owns those units and an in-place edit is silently
  reverted on upgrade. `install.sh` installs them before enabling the services,
  so a fresh install is locked from the start — it previously never passed `-r`
  either.

### Added

- **RustDesk client updates on the Updates page.** Endpoints report their
  installed RustDesk version on every heartbeat; the page shows current versus
  latest and stages upgrades per-machine or for everything outdated. Reuses the
  credential-rotation protocol rather than inventing a second one: the endpoint
  re-runs the installer, which is already idempotent and pins the version this
  server serves. A staged update clears only when the endpoint reports the
  target version, so a failed install retries instead of being dropped, and an
  endpoint will not reinstall more than once per 30 minutes. Endpoints that
  have never reported a version show as *Unknown* rather than *Outdated*.

- **WebSocket routes for RustDesk over 443.** Caddy proxies `/ws/id` and
  `/ws/relay` to hbbs 21118 and hbbr 21119, matching `hbb_common`'s own
  contract. Not yet usable: hbbs 1.1.15 accepts the upgrade and immediately
  drops the connection, so clients are left on the native rendezvous path. The
  routes cost nothing idle and become useful for port-restricted sites once the
  server is upgraded.

---

## [0.8.1] — 2026-08-26 · *Ledger*

Maintenance release. Four things that were quietly broken, plus the cause of a
login failure that this project's own deploy procedure was creating.

### Fixed

- **Deploying could break every open session.** The deploy step ran
  `rsync -a --delete` over `.next/static`, deleting the previous build's client
  chunks. Next.js requests chunks by content hash, so any browser with the app
  already open kept asking for filenames that had just been removed — 404, hard
  reload, and for anyone mid-login it looked like "sign in, pass 2FA, land back
  on the login page". Deploys now exclude the static directory from the delete
  pass and add chunks rather than replacing them, so a release can no longer
  pull the floor out from under a live client. Applied to the in-app updater and
  documented in `docs/setup.md`. **If you hit this, one hard refresh clears it.**

- **`pnpm build` did not work at all.** The API package was named `api` while
  the rest of the workspace used `@reboot-remote/*`, so every root script
  filtering on `@reboot-remote/api` — `build`, `db:migrate`, `db:generate`,
  `db:seed`, `db:studio` — matched no project. `pnpm build` is the install step
  the README tells people to run. Renamed the package; the in-app updater's
  `--filter` arguments were wrong in the same way and are fixed too.

- **`pnpm db:seed` was broken.** `ts-node`'s `dist/` was missing from the
  install, so the seed could not run at all. Reinstalled and verified against a
  live database (idempotent — existing accounts are untouched).

- **The launcher never recorded that a session started.** It POSTed
  `client_opened` to `/sessions/:id/events` using its launcher token as a bearer
  credential, which cannot work: that route is behind `JwtAuthGuard` and a
  launcher token is signed with `LAUNCHER_TOKEN_SECRET`, not `JWT_SECRET`. The
  result was discarded, so it failed silently on every launch and sessions never
  left `PENDING`. Redeeming the token *is* the client opening, so the server
  records it in `/launcher/validate` instead of asking the client to report
  something already observed. Sessions now move `PENDING → CLIENT_OPENED`.

- **The in-app updater could never have worked.** It ran `git fetch` in
  `PROJECT_ROOT`, which is the deploy target and deliberately not a git
  repository, so it died on its first command with a bare "not a git
  repository". Introduced `SOURCE_DIR` for the checkout to build from, and
  `GET /admin/update/check` now reports whether an update can actually run and
  why not — the About page shows that reason instead of offering a button that
  fails.

- **Release History was capped and mis-parsed.** Nested-quantifier heading regex
  replaced with two simple passes, and `\s` narrowed to horizontal whitespace so
  the optional date can no longer be pulled off the following line.

- Three Windows paths in the generated installer read `C:UsersDefault` instead
  of `C:\Users\Default` — `\U` inside a JS template literal collapses to a bare
  `U`. Comment lines only, so nothing executed wrongly, but the same slip on a
  real path would misdirect the installer. Fixed, and guarded by an assertion in
  `security-regression.mjs` that fetches each generated script and fails if a
  drive letter lost its separator.

- **Hooks were called after an early return** in Unassigned Computers, which
  React can throw "Rendered fewer hooks than expected" on. Gated the queries and
  moved the redirect into an effect.

### Added

- **Working ESLint.** There was no config anywhere in the repo: the API had a
  `lint` script but no ESLint dependency, and `next lint` dropped into its
  interactive setup prompt. The security rules existed only as an untracked file
  on the production server referencing globally-installed plugins by absolute
  path, so nobody could reproduce a run. Both apps now have flat configs with
  their plugins as real dependencies, and both lint clean.

- **CI** (`.github/workflows/ci.yml`) — version consistency, lint, typecheck and
  build on every push and PR. There was none, which is how all of the above
  stayed broken without anyone noticing.

- **`scripts/check-versions.mjs`** — asserts every version string agrees. v0.8.0
  shipped with `apps/api/package.json` still on 0.7.1 because a stray
  `git checkout` reverted the bump and nothing was watching.

- **Quick Connect for macOS and Linux.** RustDesk's config-in-filename trick is
  specific to the Windows setup executable, and repackaging their signed `.app`
  would break its signature — so these get a launcher script that runs RustDesk
  from a **throwaway `HOME`**. Nothing is installed, an existing RustDesk
  configuration on that machine is never touched, and quitting removes every
  trace. The Linux client is verified end to end on real hardware: it downloads,
  isolates, configures, registers with `hbbs` and cleans up after itself. **The
  macOS client has not been run on a Mac** and ships disabled — enable it in
  Settings once you have tested it.

### Notes

- `hbbs` was confirmed healthy while testing the Linux client: a correctly
  configured client registers and confirms its key without trouble. An endpoint
  that is missing from the peer table is a client-side configuration problem, or
  simply switched off — not a server fault.
- `pnpm lint` and `pnpm typecheck` are now root scripts.

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
