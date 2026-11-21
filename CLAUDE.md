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

**Once signed releases are set up on the host** (`deploy/release/rem0te-signed-setup.sh`,
0.37), the last step of every deploy is:

```bash
sudo rem0te-signed-publish     # builds HEAD via git archive, signs, verifies, publishes
```

It builds the agent from the checkout's **committed** HEAD, so commit (and
bump the version) before deploying. The same version and commit again is a
no-op; an older version is refused. `sudo rem0te-signed-status` shows what is
published and when the timestamp expires.

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
- **Never commit `tools/windows-installer/trustroot/root.json`.** The tracked
  file is the `{}` placeholder. The owner's root of trust is written only into
  the `git archive` copy `rem0te-signed-publish` builds from. The command
  refuses to run if the checkout's copy, or HEAD's, is anything else, and §56
  fails CI on it. A committed root goes to GitHub with the next push.
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
- **`STALE_SWEEP=off` must never be set in production.** It stops the
  every-minute sweep that marks computers offline, so no machine would ever go
  offline again. It exists for test stacks whose agent-silent fixtures need a
  lasting `isOnline` with no hbbs to keep it (`e2e-polish.mjs`, `e2e-ui.mjs`).
  The same goes for `SNAPSHOT_SWEEP=off`, which silently stops the automatic
  Processes / Services / Network snapshots.
- **`AGENT_AUTO_UPDATE=off` and `SNAPSHOT_QUIET=off` are test or diagnostic
  switches (0.36).** `AGENT_AUTO_UPDATE=off` stops the heartbeat handing
  outdated agents an update flag. `run-e2e.sh` and `e2e-ui.mjs` set it so other
  suites' outdated fixture agents are not asked to reinstall; in production
  the setting belongs in *Settings → Client updates*, which is audited, not in
  a unit file nobody reads. Using it to defer the first round after a deploy
  is fine, but take it out afterwards. `SNAPSHOT_QUIET=off` restores 0.35's
  three snapshot-schedule reads on every heartbeat; it exists to benchmark the
  quiet window (`bench-heartbeat.mjs`) and costs about three transactions per
  heartbeat for nothing.
- **A maintenance window is not containment.** `MonitorSuppression` only
  holds notifications (and ClientSt0r's `alert.raised`); it never touches
  `ContainmentPause`. Keep them apart — §17 checks it.
- **`MSA_GRANTS=on` must not be set in production until build step 4
  ships (0.71).** It turns on Managed Secure Access grants: a Platform Admin
  can then issue a signed session grant (with a one-time RustDesk password)
  and hand it to a computer's signed agent over `POST /msa/agent/poll`. No
  agent in 0.71 polls or enforces one, and the grant key is not yet in the
  signed release metadata, so on a live server it only creates a key and rows
  that mean nothing. It is exact (`'on'`, nothing else) and is not a console
  setting. Test stacks set it per suite (`e2e-msa-grants.mjs`).
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
is no approve route; the agent catalog is closed (originally Spooler-only;
see 0.32 below) and journals before it executes; and no DTO array of objects lacks `@Type(() => Object)` —
class-transformer's implicit conversion silently turns those into `[[]]`, which
is how command-result events went missing in production. The signer is its own
install (`apps/api/scripts/build-approval-signer.mjs`), never run from the
portal's `dist`. Its behavioural proof is `apps/api/scripts/e2e-approved-action.mjs`
(needs `RELEASE_BIN` and `ACTION_SIM` built from `tools/windows-installer`).

0.27.0 added §15 for staged patching: the agent's update params are closed
(`updates` + `reboot`, which from 0.34 is exactly `"never"` or
`"if_required_in_window"`, + an optional narrowing `allow`), its update risk is
always high, `wua.ps1` has no restart, `AcceptEula`, `Invoke-Expression` or download-and-run, the agent
checks other update managers before installing, the patching API has no
approve route, the canary gate requires *effective* (for a canary rollout;
0.62's all-at-once rollouts have no canary, §75), and updates cannot be
requested one computer at a time (`ACTION_NOT_DIRECT`). §14's agent-catalog
check now expects exactly the two actions. Its behavioural proof is
`apps/api/scripts/e2e-staged-patching.mjs` (same `RELEASE_BIN` / `ACTION_SIM`;
the sim takes `-wua` / `-registry` fixture files). An `ActionJob` is now one
signed plan with an `ActionTarget` row per computer; `endpointId` on the job is
only the first target, so per-computer state lives on the target.

0.42 widened §15's classification allowlist to exactly six classes, the same
GUIDs on the agent (`patch.Installable`) and in the portal (`CLASSIFICATIONS`):
Security, Critical, Update Rollups, Updates, Drivers and Definition Updates.
Upgrades, Feature Packs, Service Packs and Tools stay out, and §15 fails if
any of them reaches either list. `UserInput` refuses an update except in the
one tolerated class, Drivers (`UserInputTolerated` / `USER_INPUT_TOLERATED`,
exactly that one on both sides); `BrowseOnly` and an un-accepted EULA still
refuse every class. A patch policy may name the new classes but the UI never
ticks Drivers by default. An agent older than 0.42 refuses them
(`excluded_classification`), and the UI says to update the agent.

0.32 widened §14's catalog checks to an exact, ordered list of six actions —
the Spooler start, update install, and four maintenance actions
(`windows.service.restart`, `windows.reboot.schedule`, `windows.reboot.cancel`,
`windows.logs.collect`) — the same on the agent and in the portal. Every agent
entry's `ParamsOK` must be one of the known closed forms; the service restart's
allowlist (`RestartableServices` / `RESTARTABLE_SERVICES`) must agree on both
sides, pass the charset check first and hold no security or core service; the
restart delay floor is 5 minutes on both sides; every maintenance action is
`high` risk and the restart (and a RustDesk restart) waits for no open session,
"cannot tell" counting as open; an action's `Precheck` runs after the signed
pause and before the *executing* journal entry; the agent's action package runs
no process and the Windows side only `shutdown.exe` / `wevtutil.exe` from
System32; and the maintenance actions are not offered to ClientSt0r
(`integration: false`). Its behavioural proof is
`apps/api/scripts/e2e-maintenance-actions.mjs` (port 3251, same `RELEASE_BIN` /
`ACTION_SIM`; the sim takes `-sessions`, `-stop-fails`, `-events-dir`,
`-rustdesk-logs`). Adding an action, or a service to the allowlist, is a new
agent release and a review: change the invariant's list in the same commit.

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

0.34 added thirteen sections, §33 to §45, one per part of the release.

§33 is data retention. The retention sweep names no audit table (`ActivityLog`,
`AuditCheckpoint`, `AuditChainState`); its one audit entry per pass is an
insert. It deletes or trims only in nine allow-listed tables. Every statement
names the finished states and keeps the newest command and diagnostic, is
bounded, and runs through the batch loop. `RETENTION_SWEEP=off` stops it and is
exported by `scripts/run-e2e.sh`. `GET /admin/retention` is one Platform Admin
read with no way to run or change the sweep. Behavioural proof:
`apps/api/scripts/e2e-retention.mjs` (port 3411); unit: `unit-retention.mjs`.

§34 is API keys and device-group membership. Creating *any* API key needs
`assertFresh`, after scope and validation and before the write, naming its
catalog key `apikey.create` (§62; until 0.49 it was not configurable). Keys are immutable: there are list, create and revoke routes
only, and nothing widens a key's scopes or clears `revokedAt`. Membership is
the `EndpointGroupMember` table (`Endpoint.endpointGroupId` is gone). Two 0049
triggers enforce the business rule: a cross-business insert is refused, and a
computer that changes business or tenant leaves the old business's groups.
Behavioural proof: `e2e-enrol-stepup.mjs` and `e2e-device-views.mjs`.

§35 is rule-based device groups. A rule group's members are computed on every
read as the rule AND the group's business AND `scopedWhere`, through the
device list's own `parseListFilters` / `filterConds`. A rule's values reach SQL
only as bound parameters. Nothing adds a computer to a rule group: not bulk,
an enrolment token, the claim, endpoint creation, or a direct insert (0053
trigger). A group's kind never changes. A rule on alerts is not evaluated for a
reader without `monitoring:alerts`. Bulk on a group (`targetGroupId`) resolves
the members as the caller at request time, refuses more than 200, then takes
the ordinary per-computer path. Behavioural proof: `e2e-dynamic-groups.mjs`
(port 3481); unit: `unit-dynamic-groups.mjs`.

§36 is the hbbs peer snapshot. `rustdeskRegistered` is answered from one shared
read of hbbs's peer table, and its window is the only staleness allowed. The
window is clamped to 30 s and measured from when the read started; a clock
that went backwards is stale. A failed read answers `null` and discards the
older snapshot. Digit IDs only, in the SQL and in the parser. Nothing else on
the heartbeat path spawns `sqlite3`. Behavioural proof:
`e2e-presence-cache.mjs` (port 3403, a counting `sqlite3` wrapper); unit:
`unit-hbbs-peer-snapshot.mjs`.

§37 is the update restart rule. Under `if_required_in_window` the agent
restarts only after something was installed and Windows reports a restart
required. It goes only through `scheduleWarnedRestart`, the one
`Maint.ScheduleRestart` call that `windows.reboot.schedule` also uses, with the
same fixed message. There is a fixed 15-minute warning (the same constant on
both sides). The window check runs first, then `sessionCheck` ("cannot tell"
counts as open). Anything else is `restart_deferred`, never a restart outside
the signed window. Every way to ask for an install defaults to `never`. The
signer refuses a plan asking for more than its policy (`rebootWithin` →
`reboot_not_allowed`). The database CHECKs `PatchDeployment.reboot`. The portal
keeps a `restart` report only from a plan whose rule allowed one. The UI and
`docs/staged-patching.md` say it has not run on real Windows. The portal asks
for a patch scan due just after the restart (`patchScanRequestedAt` may be in
the future; `patchScanDue` waits for it), so the canary gate opens only on a
post-restart scan. Behavioural proof: `e2e-staged-patching.mjs`
(`rem0te-action-sim -fire-restart` is the restart happening, `-clock-offset`
moves the agent's clock, `-sessions` opens a session) and
`e2e-patch-policies.mjs`.

§38 is agent-signed results. A patch policy's later ring opens only on results
and scans the computers signed with their own Ed25519 key. Two approvers
bound that key to the computer in the policy, and the signer pinned it
write-once in `device-keys/`; only the operator CLI's `device-key forget`
removes one. The statement prefixes live in one file (`actions/device-result.ts`),
which signs nothing. The signer verifies every previous-ring statement under
the *policy's* key, never the key a statement names, before `evaluateRingGate`,
and the gate reads only signed facts. A missing signature only counts against a
ring. The portal relays signatures as received, and a policy whose gating
computers have no key is refused (`RESULT_KEY_MISSING`); from 0.50 a
company-wide revision puts keyless computers only in its last ring (§63). The agent signs every
final result in one place (`final()`), with the verifier's prefixes; the
result-status table (`RESULT_STATUS`) is shared by the portal and the signer.
Behavioural proof: `e2e-patch-policies.mjs` (five forged canary successes
refused); unit: `unit-patch-policy.mjs`, `unit-approval-signer.mjs`. From
0.62 all of this holds for a canary policy only: an all-at-once policy (§75)
has no ring that opens another, so it needs no result key and the signer
refuses any evidence offered for it.

§39 is `windows.script.run@1`. There is no run without an APPROVED library
version and an ACTIVE entry on the approval signer's *own* allowlist. Only two
passkey approvals on the signer's origin make an entry ACTIVE. The portal can
propose, read and revoke, never write. Revocation is by content hash and
write-once, and the store's only deletion is the device-pin removal above.
The typed argument schema is checked by the portal, the signer and the agent,
with identical charsets. The agent runs one constant command line with a fixed
wrapper and never builds one from the plan. Output is redacted on the computer
and again by the portal, stored apart and pruned after 90 days
(`SCRIPT_OUTPUT_SWEEP=off` stops that). Behavioural proof:
`apps/api/scripts/e2e-script-run.mjs`. It needs `RELEASE_BIN`, `ACTION_SIM` and
PowerShell 7 (`PWSH`, or `pwsh` on PATH); the sim takes `-script`, `-pwsh`,
`-script-minute`. Unit: `unit-script-run.mjs`.

§40 is software deployment (`windows.software.install@1` / `uninstall@1`). The
five closed parameters use the same charsets on the agent and in the portal; a
package id can never start with `-`. `internal/winget` is the only exec site:
an argument array, no shell, no override or hash-skipping flag, and always
`--exact --source winget --scope machine`. The agent hashes the downloaded
installer and refuses a mismatch before installing, and refuses
`managed_elsewhere` before asking winget anything. The portal makes plans only
through `createPlan`. Catalog writes need `assertFresh`. There is no upload,
approve or sign route. Canary of one, rings of at most 25. The manifest fetch
is bounded, with a loopback-only `WINGET_MANIFEST_BASE`. Behavioural proof:
`e2e-software-deploy.mjs` (ports 3461–3464, same `RELEASE_BIN` / `ACTION_SIM`;
the sim takes `-winget STATE.json` and `-winget-timeout`); unit:
`unit-software.mjs`.

With §39, §40, §59 and §61, §14's exact, ordered catalog list is twelve
actions: the six through 0.32, then `windows.script.run`,
`windows.software.install`, `windows.software.uninstall`, (0.41)
`windows.software.remove`, and (0.45) `windows.service.control` and
`windows.process.stop`. It is the same on the agent and in the portal, with
`scriptParamsOK`, `softwareParamsOK`, `removeParamsOK`, `serviceControlParamsOK`
and `processStopParamsOK` among the closed forms and ten `integration: false`
entries.

§41 (0.48, reversing 0.34's "AI without a provider key" at the owner's
request) is AI providers and PSA tickets. Provider endpoints, key headers and
names appear only in `apps/api/src/ai/`, and no provider SDK is a dependency.
The one call site is `ai/client.ts`, through `common/safe-https.ts`'s
`safePost`: a public DNS name, resolved and judged on every call, connected to
the checked address with SNI, certificates verified, redirects refused, 60 s
and a size cap; plain http only to 127.0.0.1 under `NODE_ENV=test`
(`testLoopbackAllowed`, which is the only way `AI_TEST_BASE_URL` is read). The
key is AES-256-GCM (`common/secret-box.ts`, purpose `rem0te-ai-key-v1`), is in
no response, audit row or log line (nothing in `ai/` logs), and only its last
four characters are kept in the clear; a changed provider, base URL or auth
style drops it. Setting it is Platform Admin (class guard) with `assertFresh`
naming `ai.settings` (§62). Every prompt is the fixed system prompt plus a payload built by
`eventPayload` / `alertPayload` through `redactForAi` (which ends in
`redactForPeer`) from the server's own copy of the entry: the browser names an
entry with a strict source object and cannot supply text. Scope, then the
entry's capability (`computers:event_logs` / `monitoring:alerts`), before
anything is read; `AI_ASKED` is written with `logOrFail` before the request
leaves; audit meta never carries text; a per-user budget sits on top of the
route limit. PSA tickets need the same plus `tickets:create`, the budget and
no `notifications` pause before the send; their audit carries ids, the kind
and the reference, never the subject, note or body. Connector writes need
`assertFresh` naming `psa.connector` (§62). The webhook URL obeys the same typed-destination
rule, its secret is sealed, kept only for the same URL and never shown (only
the host is shown or audited). Email-to-ticket goes only to a confirmed
recipient of the connector's own scope, through `EmailService`. The ClientSt0r
connector is offered only when the peer's signed capabilities list
`ticket_create_request_v1` (proposed, §5C). 0070 CHECKs the provider, kind and
scope. A native PSA connector is one file in `apps/api/src/psa/connectors/`
implementing `PsaDriver`, plus `KINDS` and 0070's CHECK. The ClientSt0r
device-timeline summary keeps its 0.34 checks: it goes only `timeline.service
→ timeline.client → signer.signedPost(peer, 'inference')`, only when the
peer's signed capabilities list `device_timeline_v1`, after capabilities and
containment, audited before it leaves without text, from a snapshot with no
name, hostname, address, business, site, tag, author or RustDesk field, every
free-text field through `redactForPeer`. Behavioural proof: `e2e-ai-psa.mjs`
(ports 3751–3754, loopback stubs for the provider, the webhook and SMTP) and
`e2e-ai-timeline.mjs`; unit: `unit-ai-psa.mjs` and `unit-ai-timeline.mjs`.
**No real provider or PSA has been called from this server.** Never point a
test at one.

§42 is outbound email. The relay is Platform Admin only and saved with
`assertFresh`. Its host is a public DNS name, checked on save and resolved and
checked on every send, and the connection is made to the checked address (SSRF
and DNS rebinding). Plaintext goes only to loopback, certificates are verified,
STARTTLS is required, and nodemailer gets no file or URL access. Mail goes only
to mailbox-confirmed recipients of the policy's or schedule's own scope; the
token is consumed conditionally and there is no GET verify route. The relay
password appears in no audit row, view, log or error code, and moving the relay
drops it. A `notifications` pause stops every send. A scheduled report period
is claimed (unique) before it is sent, and the owner is rebuilt from the
database before the export. `REPORT_SCHEDULE_SWEEP=off` stops the sweep and is
exported by `run-e2e.sh`. Behavioural proof: `e2e-email.mjs` (ports
3491–3493, an SMTP server in the test); unit: `unit-email.mjs`.

§43 is agent upgrade from the console. A per-computer migration to the signed
agent never writes the update-trust mode. In *Signed only* it is refused, held
and served nothing. The served script pins the digest of
`windows/rem0te-agent.exe` in the signed targets, and is served only for an
open nonce handed to that computer's own authenticated heartbeat. A request
needs `computers:edit` and `assertFresh`, single or bulk, and is recorded only
with its audit entry. §29's bulk list is six actions (`agent.update`,
`agent.migrate` added). Behavioural proof: `e2e-agent-upgrade.mjs` (with
`RELEASE_BIN`); unit: `unit-agent-migration.mjs`.

§44 is the browser UI suite, `apps/web/scripts/e2e-ui.mjs`. It refuses ports
3000, 3001, 443, 4000 and 4001 and https before starting anything. It refuses a
database not named `test` or `scratch` before Prisma loads. It writes only to
its temporary copy of the standalone build, and stops if the build's baked-in
API destination (on this host, production's 3001) survives the patch. Its API
runs with every sweep off (eleven switches in 0.35, found from the API source;
`TRAY_SWEEP` and `AGENT_AUTO_UPDATE` joined them in 0.36).
§18 covers it too. CI runs it as the `UI suite (browser)` step of the `e2e`
job.

§45 is chat with the person at a computer. Every portal route names its
capability (`computers:view` to read, `support:chat` to start, write and end)
and reaches the computer through the visibility rule AND-ed with the id;
starting and sending consult the `remote` containment pause, whose label is
now "remote connections and chat". The two device routes need the device
secret (`authenticateDevice` / `secretMatches`), and the heartbeat offers chat
only to an authenticated signed agent. Audit rows carry ids and counts, never
message text, and chat never updates or deletes an `ActivityLog` row. The
2,000-character cap agrees in TS, SQL and Go, and `CHAT_RETENTION_SWEEP=off`
is exported by `run-e2e.sh` — a separate sweep from `RETENTION_SWEEP`, so
both switches are needed. On the agent (0.36: the tray replaced the 0.34 Win32
chat window and its host) the signed tray holds no secret and speaks no HTTP:
it talks only over two first-instance, local-only pipes whose DACL names
SYSTEM and the session user, with the client PID checked. Its chat window is a
WebView2 control that loads only `/assist` on the pinned portal, with dev
tools, host objects and web messages off, and the page draws text with
`textContent`. **The tray has never run on real Windows.** Behavioural proof:
`e2e-chat.mjs` (port 3531); unit: `unit-chat.mjs` and the Go `internal/tray`
tests.

0.44 extended §45 for emoji, files and the console's chat inbox. The 2,000 cap
is UTF-16 code units everywhere: TS `text.length`, Go `utf16Len`, the
textarea's `maxlength`, and 0067's CHECK (`char_length` plus the
astral-plane count; the old code-point CHECK let 1,500 emoji through that
both ends refused). The emoji pickers are built in, one 132-entry list that
must agree between `apps/api/src/chat/emoji.ts` and `apps/web/lib/emoji.ts`,
drawn with `textContent`. An attachment is an image only by its magic bytes
(`sniff`: PNG, JPEG, GIF, WebP; never SVG, never the declared type), and is
served inert: an image as its sniffed type inline, anything else
`application/octet-stream` + `attachment`, always nosniff and
`default-src 'none'; sandbox`, with a sanitised name. Reading a file needs
what reading the transcript needs (`computers:view` + `visibleEndpoint`, and
the id, conversation and endpoint together); sending needs `support:chat`,
the `remote` pause, the 10 MB multer limit in memoryStorage, and the
20-file / 50 MB caps claimed in one conditional update. Files are `bytea`
rows that cascade with their message and chat, so the prune and an
unrecorded chat's end take them; the prune's audit counts them. The audit
meta of `CHAT_ATTACHMENT_SENT` is ids, kind, type and size, never a name or
bytes. `GET /chat/inbox` is `computers:view`, lists only open chats through
`endpointVisibilityWhere`, and reads only the caller's own `ChatReadState`;
a read mark only moves forward. The web middleware's matcher excludes `api/`
and `assist/`, because Next buffers a proxied body and cuts it at 10 MB.
Behavioural proof: `e2e-chat-attachments.mjs` (port 3703); unit:
`unit-chat.mjs`.

0.35 added five sections, §46 to §50, one per part of the release. §44 also
now requires every `*_SWEEP` / `*_SEALER` off switch the API reads to be
`'off'` in `e2e-ui.mjs`, found from the source rather than listed, because two
more arrived in 0.35 from two different branches.

§46 is device groups as a policy scope. Monitors and client-update policies
may be set for a group; membership is computed, never stored — the membership
service writes nothing and holds no Map between calls, and a rule group goes
through the device list's own `evaluateRuleGroups` as the business AND its
rule AND `endpointVisibilityWhere`, with an unreadable or alert-reading rule
matching nothing. The sweeps build membership once per tick, locally.
Precedence is computer > group > site > business > global, groups by priority
and then id, never row order. 0057 refuses priority ties (partial unique
indexes), mixed scopes, another business's group (trigger) and deleting a
group that carries a policy (NO ACTION). Another business's group is a 404;
enabling or removing a group client-update policy needs fresh authentication;
who is notified stays global or business (§17). Behavioural proof:
`e2e-group-policies.mjs` (port 3541); unit: `unit-group-policy.mjs`.

§47 is the browser coverage of the 0.34 screens. The Run panel offers
*Request a run* and *Revoke* only when an approval signer is configured.
Saving Email settings puts the saved relay into the cache before the form is
rebuilt, or it came back blank one Save away from switching mail off.
`e2e-ui.mjs`'s SMTP sink and reference ClientSt0r peer listen on loopback, on
ports inside its refusal loop (`UI_SMTP_PORT` 3503, `UI_PEER_PORT` 3504), and
it puts the global SMTP settings back.

§48 is groups on the device page. `GET /endpoints/:id` checks scope first and
takes its `groups` from `deviceList.groupsOfComputer`, which evaluates only
the computer's own business, as the caller, over that one computer, and drops
a rule the caller may not evaluate (the alert gate). It runs no rule-group
query of its own.

§49 is "reachable is not reporting". There is one heartbeat window,
`HEARTBEAT_STALE_MS` (30 minutes), in `apps/api/src/common/connectivity.ts`
and its web copy, which must agree; the stale sweep's default reads it and it
is called with no literal; the automatic-snapshot scheduler's "agent silent"
is the same constant. The device list's `online` filter needs a heartbeat
inside it and `silent` is the rest of `isOnline`; the dashboard and the map
count online from it, never from `isOnline`. Behavioural proof:
`e2e-polish.mjs` (port 3551); unit: `unit-polish.mjs`.

§50 is automatic snapshots. Only `process_list`, `service_list` and
`network_adapters` can be asked for with no requester (0059's CHECK, and the
scheduler iterating `SNAPSHOT_KEYS`); the scheduler runs only inside
`forHeartbeat`, which only an authenticated heartbeat reaches; a requester-less
run skips the requester re-check only for a snapshot key; a read marks a tab
"watched" only after the visibility and capability checks; automatic runs are
not audited one by one but a schedule change is, Platform Admin only; pruning
deletes only finished automatic runs and never touches `ActivityLog`; and
`SNAPSHOT_SWEEP=off` is exported by `run-e2e.sh` and set by `e2e-ui.mjs`.
Behavioural proof: `e2e-auto-snapshots.mjs` (ports 3571–3573); unit:
`unit-snapshot-schedule.mjs`.

0.36 added §51 to §55, one per branch, numbered in merge order. Each branch
wrote its section as §51; the integrator renumbers, so a branch's own notes
and fragment say §51 whatever its final number.

§51 is agent health. The agent-silent monitor (`AGENT_SILENT`) is opt-in: it
is in `OPTIONAL`, never `RECOMMENDED`, `addRecommended` iterates only the
latter, and no code or migration creates such a rule. Its threshold floor is
`HEARTBEAT_STALE_MS`, so an alert never contradicts a header still saying
Online. It skips an agent that never checked in, clears when the silence is
under the threshold, holds (neither raises nor resolves) while the computer
is unreachable, and only then breaches; it is swept, not heartbeat-driven.
`AlertEventsService.emit` sends ClientSt0r only the kinds the contract's
`Alert.kind` names, so this one stays in Rem0te until a contract revision.
The client-update sweep calls `reconcileQueued` first, unconditionally, every
tick, records `updatePolicyId` when it queues, and a withdraw or re-plan is
a conditional write audited with its reason (`CLIENT_UPDATE_AUTO_WITHDRAWN` /
`_REPLANNED`). The snapshot scheduler's quiet window only skips, is capped at
an hour and 50,000 computers, and is dropped by an open tab, a result, an
expiry or a schedule change. Behavioural proof: `e2e-agent-health.mjs` (ports
3601/3602); unit: `unit-agent-health.mjs`.

§52 is the signed revocation statement. The signer signs it under its own
prefix, `rem0te-revocations-v1\n`, and the agent verifies the same prefix
against `approval/keys.json` only, with `seq` equal to the entry count and at
most 5,000 entries on both sides. The published set is the union of the
ledger and what is on disk, so it never shrinks; software revocations are
write-once (`flag: 'wx'`) and nothing over HTTP or the CLI un-revokes. The
signer refuses `software_revoked` at admission and again at approval, and a
software plan naming no entry. The agent keeps the newest statement and
refuses a lower `seq` or one leaving out an entry it holds. Its check sits
after the signed pause and before Precheck and the *executing* journal: a
stale statement is `revocations_stale`, not final and not journaled; a
revoked plan is final. The Windows agent fetches the statement from the
pinned portal for every job, capped at 1 MB. The portal revokes on the signer
before it archives (`409 APPROVAL_SIGNER_REFUSED` otherwise), its relay is
one public GET passing the four envelope fields, and `dispatchBlock` cancels
an undelivered revoked target first. Behavioural proof: `e2e-revocation.mjs`
(needs `RELEASE_BIN`, `ACTION_SIM` and pwsh); unit: `unit-approval-signer.mjs`
and the Go `internal/action` tests.

§53 is automatic agent self-update. The heartbeat step runs only for an
authenticated heartbeat outside an `updates` pause, adds a flag only when
none is already going out, and comes before the containment override. It
sends only `reinstallAgent` or `updateRustdesk`, with no nonce. Nothing is
dispatched under a pause, a rollout, another queued install, a closed window
or an open session, and the attempt cap is checked first. One attempt hands
the flag out for 20 minutes, under the agent's 30-minute floor, and attempts
back off. The global pace is counted under `pg_advisory_xact_lock`, and the
node moves only from the state that heartbeat read. Linux and macOS agents,
and computers without a device secret, are never asked. Attempts are
`AgentAutoUpdateAttempt` history rows, not audit entries; the settings route
is Platform Admin, `assertFresh` and audited, and a policy agent mode other
than `OFF` needs fresh authentication. The signed heartbeat's daily check
runs only `rem0te-agent.exe update`, only when the portal allows it, and the
legacy channel has none. `AGENT_AUTO_UPDATE=off` is exact and set by
`run-e2e.sh` and `e2e-ui.mjs`. 0.46 added a per-computer setting,
`Endpoint.agentAutoUpdate`, which is null, `'on'` or `'off'` (0068's CHECK).
It sits above every policy: computer > group > site > business > default On.
`modesFor` reads it for every computer in one query and hands it to
`resolveMode`, and every dispatch decision goes through `modeFor`. Off always
wins. `resolveMode` returns OFF for it before looking at any policy. `decide()`
checks the platform and process switches before the mode, so either one, when
off, still beats a computer's On. On never yields OFF. It keeps a WINDOW the
governing policy sets. Changing the setting needs `computers:edit`
(`assertEndpointInScope`). Anything but Off needs `assertFresh` before the
write, and the write is conditional on the value read. It is audited
(`AGENT_AUTO_UPDATE_COMPUTER_SET`, before and after), and only
`setComputer` writes the column. The business page's selector
(`putAgentMode`) writes only the business policy's agent mode. It has the
same `assertEdit` and fresh rule, never sets `enabled`, and creates a missing
row with `enabled: false`. Behavioural proof: `e2e-agent-auto-update.mjs`
(ports 3641/3642); unit: `unit-agent-auto-update.mjs`.

§54 is test stacks and the GeoIP database. `GeoipService` falls back to the
production path when `GEOIP_DB_PATH` is unset, so on this host the browser
suite used to read production's file. `e2e-ui.mjs` now writes its own City
database with `apps/api/scripts/lib/mmdb-fixture.mjs` and hands it to its
API; the fixture's networks are RFC 5737 only; nothing under `apps/api/src`
imports the writer, which is IPv4-only. The login band and Quick Connect take
their ink on the accent from `inkOn()`, never a fixed `text-white`.

§55 is the tray. Three credentials, none of them the device secret in a
user's hands: the signed tray holds nothing and asks the SYSTEM tray host over
the pipes; the standard tray holds a tray key that opens only `/tray/*`,
paired by the SYSTEM heartbeat with the device secret, replaced on every
pairing, never able to run or report an elevated tool, while a standard
computer's device secret is refused there; and the chat page holds an
`HttpOnly; Secure; SameSite=Strict` cookie on `Path=/assist`, the only
credential the page accepts. The link the tray opens carries a one-time code
consumed by one conditional update with nothing read first, and no device
secret, tray key or code reaches the page. `/assist` has its own strict CSP,
the console's is not applied there, and page writes need `x-assist`. The
self-help catalog is the same six tools, elevated flags and containment kinds
in the API, the agent and 0062's CHECK; the tray host runs only `ipconfig` and
`ping` from System32 (and the RustDesk restart), under the containment kinds
each tool names, records refused runs, and starts only the tray whose SHA-256
the signed install recorded. Changing chat recording is owner or Platform
Admin, `assertFresh` and audited; an unrecorded chat keeps no text. Tray audit
rows hold ids, tools and outcomes only; screenshots and usage are served,
inert, only to someone who can see the computer; and `TRAY_SWEEP=off` is exact
and set by `run-e2e.sh` and `e2e-ui.mjs`. Behavioural proof: `e2e-tray.mjs` (port 3632);
unit: `unit-tray.mjs` and the Go `internal/tray` tests.

0.44 extended §55 for files on `/assist`: there are six `assertPageWrite`
calls, and the upload's `AssistUploadGuard` checks `x-assist` and the cookie
before multer reads a byte. A file is read only through the cookie's own
chat (`bound()`). The page loads pictures by same-origin URL, so
`ASSIST_CSP` keeps `img-src 'self'` with no `blob:`, `data:` or `https:`.
The page makes exactly one link, a file's download, built from its id. In an
unrecorded chat a file outlives `ack` and `purgeRead`
(`attachment: { is: null }`), because both sides load it from the server, and
goes when the chat ends. Nothing about files goes through the tray pipes.
WebView2's handling of pictures, the file picker and downloads has never run
on Windows.

0.51 extended §55 for support requests. The tray offers *Open a support
request* only when `/tray/status` says `supportRequests`, which is
`PsaService.trayOffered`: the business's *enabled* connector, or else the
global one. Go's `OffersSupport` needs it and `hasBusiness`, and the item is
hidden, never greyed. Without a connector a request is
`409 SUPPORT_REQUEST_NOT_CONFIGURED`, before anything is stored.
`trayPrecheck` runs in this order:

1. the connector;
2. the `notifications` pause, which now stops a tray request (`remote` and
   `actions` still do not);
3. `ready()`.

Then `agentSubmit` runs; it is called once, in the tray service. Then
`trayTicket` takes the per-computer budget and makes the only send.

- The ticket's audit meta holds ids, the connector, `source: 'tray'` and the
  reference, never text.
- `PsaTicket.createdById` is `'tray'` and `sourceRef` is `support:<id>`.
- No connector is sent the screenshot or usage.
- The request row is always kept, and a failed send is `502 PSA_SEND_FAILED`.
- The Go reply frame carries only `ticket`, cleaned by `CleanTicketRef`; the
  support frame's fields are unchanged.

Also in 0.51:

- The tray host has a second exec. A host that leaves because its binary was
  replaced starts its successor, `exec.Command(paths.AgentExe(), "tray-host")`,
  after releasing its lock.
- A tool reply goes through `FitReply` so it fits one frame.
- The tray and chat offer on the heartbeat need `mayAct` (§64).
- `identify` decides "signed" by `runsSignedAgent` (§64).

Behavioural proof: `e2e-tray.mjs` (webhook stub on `TRAY_PSA_HOOK_PORT`,
3633–3639). Unit: `unit-ai-psa.mjs` and the Go `internal/tray` tests.

0.37 added §56 for signed releases on one host (`deploy/release/`). The
keys live on the portal host under the `rem0te-release` system user, in
`/var/lib/rem0te-release` (0700), and the portal (`reboot`) must never be able
to read them. So: nothing in `apps/api/src` names that directory, a key file or
the `rem0te-signed-*` commands, or spawns `rem0te-release` — the one exception
is the three exported `*_COMMAND` strings in `agent-migration.ts` that the Full
agent page shows (§57), matched exactly;
`UPDATE_REPO_DIR` is read only by `UpdateTrustService`, which writes nothing.
Keys are generated only into `$KEY_DIR`, by the release user under umask 077.
Every other `.pem` path is under `$KEY_DIR`, except export-root's off-host copy,
and export-root deletes only after `yes`. A build is `git archive HEAD`
unpacked by the release user, never the working tree. The owner's root is
written only into `$BUILD/src/…/trustroot/root.json`, and the checkout's (and
HEAD's) copy must be `{}`; the tracked file is checked to be `{}`. The
checkout's JavaScript (the install.ps1 step) runs as the checkout's owner,
never as the key holder. The published repository is 2750/0640, staged,
verified and moved in by renames with `timestamp.json` last. Publish refuses a
downgrade or the same version from another commit. A RustDesk build needs
GitHub's published SHA-256. The refresh unit runs as `rem0te-release` with no
access to `/etc/reboot-remote`. Nothing under `.github` names these scripts.
Behavioural proof: `apps/api/scripts/e2e-signed-release.mjs` (ports 3901–3902,
needs Go; runs setup with `--prefix --no-user --no-systemd` in a temp dir);
unit: `unit-signed-release.mjs`.

§57 (0.37) is automatic migration to the signed agent. Its only effect on a
computer is an `AgentMigration` row written by
`AgentMigrationService.requestAutomatic`. That runs `block()` (the 0.34
`migrationBlock`: Signed only, an `updates` pause, a staged rollout…) before
it writes, records no requester and no audit entry, and the heartbeat hands
the row out and holds it exactly as it does a person's. The service writes no
migration, flag or command itself, never writes the update-trust mode, and
writes `PlatformSettings` once, with only its own two columns. In Signed only,
with or without portal migration, it does nothing (`gate()`, then `tick()`
returns). The rest move only after the canary was confirmed on the published
build's digest and soaked: `nextStep` has one `start_rolling`, after the soak
and a later check-in. There is one conditional write to `rolling`, from
`soaking`, and 0064's CHECK refuses `rolling` without `canaryConfirmedAt`.
Rolling is paced by `budget(perHour, usedLastHour)` over automatic requests,
at most 50 a pass, and takes only computers checking in. A halt stops only
automatic requests. Settings, resume and restart are Platform Admin.
`isWidening` (on, or a shorter soak) and resume/restart need `assertFresh`;
off never does. The Full agent page's `GET /agent-signing/overview` is
`computers:view`, reads computers only through `endpointVisibilityWhere`,
names the canary through the same where, and gives fleet progress only to
Platform Admins. Its commands are the four strings in `agent-migration.ts`, and
neither the page nor the API claims the timestamp timer runs.
`AUTO_MIGRATION_SWEEP=off` is exact and set by `run-e2e.sh` and `e2e-ui.mjs`.
Behavioural proof: `e2e-auto-migration.mjs` (ports 3911–3912, `RELEASE_BIN`);
unit: `unit-auto-migration.mjs`.

§58 (0.40) is direct mode, approved actions for a single operator. The
setting lives only in the approval signer's policy store, per business with a
`default`, and only the signer CLI writes it (`policy set --business <id|default>
--approval direct|signed`; absent means signed), logging each change to
`policy-changes.log`. No HTTP route on the signer or the portal writes it; the
portal mirrors it read-only. Direct and customer sign-off are mutually
exclusive in the CLI and in `policyFor`. Under direct the signer signs a plan at
admission, after every admission check and the signed-pause check, with no
approvers; the plan carries `policy.approval: "direct"` and `approvalsRequired:
0`, and a flag that disagrees with the signer's policy is `policy_mismatch`.
The agent relaxes its approver count and same-person rules only on that signed
field, and refuses any other value (`bad_plan`); older agents refuse direct
plans, so publish the agent before turning it on. Every portal request path
needs `assertFresh` under direct (rings under an already-approved policy
excepted), and ClientSt0r cannot make a direct request
(`DIRECT_MODE_PORTAL_ONLY`). Patch policies go ACTIVE at admission and count
only while their business stays direct; the script allowlist goes ACTIVE at
admission only when `default` is direct (author self-review is
`ScriptVersion.selfReviewed`, migration 0065). Behavioural proof:
`e2e-approved-action.mjs` (its direct section); unit: `unit-approval-signer.mjs`
and the Go `internal/action` direct tests.

§59 (0.41) is the winget catalog and removing installed programs.
`windows.software.remove@1` names an uninstall key, its view (`64`/`32`) and
the expected DisplayName, never a command; the key and name charsets are the
same regular expression on the agent and the portal. It is high risk, one
computer per plan, never direct and `integration: false`. The agent reads the
key itself, refuses one whose DisplayName changed (`program_changed`), decides
the command, journals, and only then runs it: System32 `msiexec /x {GUID} /qn
/norestart` for that key's own product, or the key's `QuietUninstallString` as
an absolute `.exe` with no shell characters and nothing on `NeverRun`, through
one exec site with no shell; an interactive-only key is `no_silent_uninstall`.
It is succeeded only when the key is gone afterwards. The portal plans only a
program its inventory of that computer lists, through `createPlan`, and keeps
inventory keys only in the remove charset. One-click install writes a catalog
entry only for the Business Owner or a Platform Admin, after `assertFresh`,
audited, with hash source winget-pkgs, then requests through the ordinary
install path. The index comes from one fixed URL (a loopback-only test
override), by one bounded GET with no credentials and no redirects, read by
`sqlite3 -readonly` with an argument array and two fixed queries; ids that
could not be a `packageId` are skipped, and nothing outside the software module
imports it. `WINGET_INDEX_SWEEP=off` is exact, exported by `run-e2e.sh` and set
by `e2e-ui.mjs`. The host needs `sqlite3`. **The remove action has never run on
real Windows.** Behavioural proof: `e2e-software-catalog.mjs` (ports 3661–3665,
`RELEASE_BIN` / `ACTION_SIM`, `sqlite3`); unit: `unit-software.mjs` and the Go
`internal/action` remove tests.

0.42 widened §59 to a closed set of recognised silent forms, decided by
`RecognizeUninstall` from the key's own `UninstallString` (which first passes
the same checks as a `QuietUninstallString`): System32 msiexec `/I` or `/X` of
the key's *own* product code (the MSI path), Inno Setup (`_is1` key,
`unins###.exe`, no arguments) with fixed `InnoArgs`, NSIS (an `*unins*` or
Mozilla `uninstall\helper.exe`, at most `/allusers`/`/currentuser`, and the
file's first megabyte holding `NSISMarker`) with fixed `NSISArgs`, and Chromium
`setup.exe --uninstall … --system-level` plus `--force-uninstall`. Nothing else
is recognised: Office Click-to-Run is `office`, driver packages `driver`, both
refused. `FileHead` refuses a reparse point or a non-regular file. RustDesk and
Rem0te are protected first, on the agent (`ProtectedProgram`,
`protected_program`) and in the portal (`PROTECTED_PROGRAM_RE`,
`PROTECTED_PROGRAM`), the same pattern. The heartbeat collector reports a
`kind` by the same rules; it only reads, the portal keeps it only from the
closed `REMOVAL_KINDS`, and it is a hint — the agent decides again. Both sides
are tested against one fixture,
`tools/windows-installer/internal/action/testdata/removal-kinds.json` (Go, and
`unit-software.mjs` under pwsh). **None of the new forms has run on real
Windows.** The mutation harness for §15 and §59 is in the 0.42 changelog.

§60 (0.43) is building catalogs by selection. `GET software/winget/packages`
with `page` or `pageSize` is a browse: still View computers, a page of at most
100 (`BROWSE_MAX_PAGE_SIZE`, capped rather than refused), every parameter
checked by `parseBrowse` before Prisma sees it, each row marked only with
global entries and the one business looked at. `POST
software/winget/catalog/bulk` is Edit computers and `@RateLimit(3)`: the
25-package cap (`TOO_MANY_PACKAGES`), then who may change that catalog, then
`assertFresh` once, then the packages. Each one goes through `resolveWinget`
and `wingetEntry(…, 'bulk')`, so it is audited per entry exactly as one click
is, and the bulk path writes nothing itself. `catalogBusiness` makes another
business's catalog a 404 for both routes. Behavioural proof:
`e2e-software-browse.mjs` (ports 3721–3722, no signer, no Go); unit:
`unit-software.mjs`.

§61 (0.45) is service control and ending a process (`windows.service.control@1`,
`windows.process.stop@1`). (§60 is 0.43's.) Both are high risk on any computer,
one computer per plan, never from the Actions tab, never offered to ClientSt0r,
and requested only from the Services and Processes tabs
(`apps/api/src/device-control`, three `computers:view` routes) after the
portal's own refusal and a match in its latest `service_list` / `process_list`
snapshot, through `createPlan` with the fresh sign-in passed on (§58 lists both
callers). The service-name, display-name, process-name and start-time charsets
are the same regex source on both sides; so are the protected lists
(`ProtectedServices` / `PROTECTED_SERVICES`, the `Rem0te` prefix, RustDesk
keep-running, the Windows Update no-disable list, `ProtectedProcesses`, the
64-process tree cap), compared case-insensitively. The agent reads the service
or process itself in `Precheck`, after the signed pause and before *executing*:
a driver or a boot/system start type is `not_a_service`, another display name
`service_changed`, and a process whose name or start time (to the millisecond,
`SameCreation`) is not the plan's is `process_changed` — PID reuse. Every change
is journaled as a step first. A RustDesk restart waits for no open session.
The Windows side (`svcproc_windows.go`) runs no process — no `sc.exe`,
`taskkill` or PowerShell; its one configuration write is `ChangeServiceConfig`
with `SERVICE_NO_CHANGE` and nil for everything but the start type (never
`UpdateConfig`, which rewrites the binary path and account), plus the delayed
flag; `TerminateProcess` is called once, on a handle whose creation time was
checked first. Nothing anywhere carries a binary path, account, password,
recovery action or dependency. **None of it has run on real Windows.**
Behavioural proof: `e2e-service-process.mjs` (ports 3711–3713; `RELEASE_BIN`,
`ACTION_SIM`, whose `-scm STATE.json` is the simulated service manager and
process table); unit: `unit-service-process.mjs` and the Go
`internal/action/svcproc_test.go`.

§62 (0.49, replacing 0.47's) is *Settings → Confirm it is you*: which functions
ask a signed-in person to confirm it is them again. **This reverses the "the
step-up is not configurable" rule at the owner's request** ("authenticator
challenge should be optional for features once you login"), as §41 was in
0.48. Every invariant that used to say a step-up could not be configured
(§16, §17, §27, §34, §42, §43, §53, §57, §59, §60 and the rest) now says the
site names its catalog key; whether that key asks is the policy's.

There is one catalog, `apps/api/src/security-controls/confirm-catalog.ts`,
plain data with no imports: about thirty functions in nine groups, each with a
stable key, a label, a description, a prompt and a default (`off` from 0.64,
below). The web
holds no copy. It reads `GET /security/confirm-policy` (`lib/confirm-policy.ts`,
`useAsks('key')`), and every key it words a prompt by must be in the catalog.
Every step-up site in the API names exactly one key: `assertFresh`'s required
`action`, `StepUpService.assert`'s action, and client updates' `FreshAuthNeeded`.
§62 holds the exact keys per file (`SITE_KEYS`), so adding a step-up, or moving
one to another key, changes that list in the same commit. Every catalog key
must be named by some site.

The policy is `ConfirmPolicy` rows (0071; CHECK `ask` / `off`, key charset).
`confirmRequired(key)` asks until the rows have been read, and for an
always-ask key or one the catalog does not name. A key's row skips only when
it is exactly `'off'`; a key with no row takes its catalog default
(`DEFAULTS` in `review.ts`, built from the catalog, never a literal). A
phishing-resistant check (a protected-device exception) always asks. The
policy is read at start and every 30 s, and set again after a change. Only
`ConfirmPolicyService` touches the rows. The always-ask set is exactly
`passkey.manage`, `fresh.auth.passkey` and `confirm.relax`. It is not in the
catalog, and `PUT` refuses it (`CONFIRM_ALWAYS_ASKS`) as it refuses an unknown
key (`UNKNOWN_CONFIRM_KEY`). Password and authenticator changes ask for the
current password or a code in their own forms. `PUT /security/confirm-policy`
is a Platform Admin's. Any change from `ask` to `off` needs `assertFresh` with
`confirm.relax` before the write; back to `ask` never does. It is audited
(`CONFIRM_POLICY_CHANGED`, the changed keys before and after, nothing else).

0071 sets 0.47's seven everyday keys to `off` only where `routineConfirm` was
`'off'`. Any of the five configurable `StepUpService` actions missing from
`stepUpActions` becomes an `off` row. Both columns are then dropped.

**0.64 reverses "every key defaults to ask" at the owner's request** ("2fa is
still enabled on all features, turn off by default, just on login"), as §41,
§62 itself, §67, §75 and §76 were. Every catalog key now defaults to `off`, so
a fresh install asks only at sign-in, and an install that never saved a
choice stops asking when it upgrades (saved rows are kept). The always-ask set
is unchanged, and so is everything that fails closed: an unread policy, an
unknown key, a phishing-resistant check and a row saying anything but exactly
`off` all ask. A fresh database therefore no longer proves the step-ups by
itself. Every suite that proves one writes an `ask` row per catalog key before
its API reads the policy, through `apps/api/scripts/lib/confirm-asks.mjs`
(scratch or test databases only), and `run-e2e.sh` runs it after the seed for
the scratch-API suites. Nothing under `apps/api/src`, and not the seed, writes
an `ask` row. `e2e-confirm-policy.mjs` (port 3761) starts from no rows, proves
the defaults, then proves every rule on `ask` rows, and restores the rows it
found. Behavioural proof: `e2e-confirm-policy.mjs`; unit:
`apps/api/scripts/unit-confirm-policy.mjs`.

§63 (0.50) is company-wide patch policies and the per-computer Patch policy
setting. A series (`PatchPolicySeries`, `business` or `assigned`) exists only in
the portal. Each revision is an ordinary `PolicyDoc`, which is still a strict,
closed list of named computers. It is admitted only through
`PatchPolicyService.admit`, the one `submitPolicy` and the one
`patchPolicy.create`. The signer has no series code. `admit` calls
`heldElsewhere` for every computer before `validatePolicyDoc` and the signer
(`COMPUTER_IN_POLICY`). No document is ever rewritten. Member rows
(`PatchPolicyComputer`) are created only at admission. A running revision is
replaced, never widened. 0072 holds the one-live-row partial unique index, a
trigger allowing `live` only for an ACTIVE policy, a release trigger, one
active company-wide series per business, the setting's CHECK, and a trigger
refusing another business's or a non-assignable series. The sweep proposes
only under a series' running revision, and `notReady` requires the computer's
live row and honours Exclude. The setting is written only by
`PatchSeriesService.setOverride`, in this order: scope with `computers:edit`,
the capability, `assertFresh` (`patching.override`), a conditional write, then
`PATCH_POLICY_OVERRIDE_SET` with before and after. Re-proposal is bounded in
`revisionDecision`: `mid_ring`, then `settling`, then `rate_limited`, before
its one propose. `PATCH_POLICY_REVISION_MINUTES` defaults to 60 with a
1-minute floor outside tests. The per-business claim is one conditional upsert,
taken before `proposeRevision`, its only caller. The series runs only inside
`PATCH_POLICY_SWEEP`, with no timer of its own. Take-over waits for ACTIVE and
no open deployment, in one transaction. Revoking a revision retires its series.
§38 still holds for revisions: a keyless computer goes only in the last ring.
0.62 (§75), at the owner's request: a series made from the console installs
all at once (`planAllAtOnce`: no canary, at most five rings of 25 that wait
for nothing, keyless computers anywhere); a series stored without `staging`
keeps its canary (`seriesStaging`).
Behavioural proof: `e2e-patch-assignment.mjs` (ports 3741–3743, `RELEASE_BIN` /
`ACTION_SIM`); unit: `unit-patch-assignment.mjs`.

§64 (0.51) is which agent a computer runs. It is one rule,
`runsSignedAgent` in `apps/api/src/common/agent-identity.ts`: signed while an
authenticated signed heartbeat was seen within `SIGNED_STICKY_MS` (7 days,
`Endpoint.signedSeenAt`, 0073), else while the computer reports signed. The
signed install script's own check-ins (`Register`, `Test-Registered`) carry
the device secret but no channel. Before 0.51 they flipped a signed computer
to legacy, and it was handed standard installs, the old migration and
`standard_pre015` auto-updates, and its tray host was refused.

The heartbeat reads the computer's identity before it writes. `heartbeatKind`
names each report, and only `signed` and `standard` may act
(`heartbeatMayAct`). A report that may not act:

- writes no agent field (version, channel, build, actions, chat, tray,
  update check), clears nothing on the node and pairs no tray;
- returns right after the endpoint update, before any update step, with every
  flag null and `rustdeskRegistered` kept.

`signedSeenAt` is written only by a signed heartbeat, only in the heartbeat.
An installer check-in (`isInstallerCheckIn`) starts no automatic update on any
computer (§53). A leftover standard heartbeat on a signed computer sets
`legacySeenAt`. It is audited as `AGENT_DUAL_REPORT` at most once a day, and
answered `retireStandard`. The standard `heartbeat.ps1` acts on that only by
running the installed signed agent's own `update` (a signed build hash in
`agent-status.json`, at most every 30 minutes). `identify`, `pair` and the
Agent card's `kindOf` use the rule.

The signed agent removes the standard leftovers by exact name
(`internal/agent/retire.go`): `Rem0teEnrollment`, `retry-enroll.ps1`,
`enroll.dat`, `tray\tray.json`, and the HKLM Run value `Rem0teTray`. It never
deletes `Rem0teHeartbeat`, which both agents use. It runs System32
`schtasks.exe` as an argument array, with the allowlist checked in both
calls. It runs only after a successful stage 2, and once per tray-host start.
**None of it has run on real Windows.** Behavioural proof:
`e2e-dual-agent.mjs` (port 3771, in `run-e2e.sh`, with `AGENT_AUTO_UPDATE` on).
Unit: `unit-agent-identity.mjs` (with `PWSH`: four scripts parsed, the
hand-over run against a stub agent) and the Go `internal/agent/retire_test.go`.

§65 (0.52) is task progress and scheduled installs: the task views only read,
through `endpointVisibilityWhere`, and a schedule reaches a plan only as its
signed `notBefore`. §66 (0.53) is monthly patch windows: a closed window union,
one occurrence function shared by the portal and the signer, unknown kinds
refused, and weekly documents unchanged byte for byte.

§67 (0.54) is restart scheduling and restart windows. **It reverses part of §32
and §37 at the owner's request** ("there should be an override exception
checkbox"), as §41 and §62 were. A restart may carry `ignoreRemoteSession:
true`. The field is present only when true and is never ticked by default. The
agent honours it only from the signed plan, and it skips only the RustDesk
session check: the 15-minute warning always shows. The signer refuses it under
a policy that does not allow it, and agents older than 0.54 refuse the plan, so
publish the agent first. A signed-in Windows user never blocks a restart; only
an open RustDesk session (`rustdesk.exe --cm`) does, and the UI must never say
otherwise. Policy restart plans are proposed only inside the restart window,
only for policy computers reporting a required restart (unless the rule is
"always"). The signer checks the restart window with the shared occurrence
function. Older documents keep their bytes. Behavioural proof:
`e2e-restart-windows.mjs` (ports 3801–3803, `RELEASE_BIN` / `ACTION_SIM`,
`PRE054_ACTION_SIM`); unit: `unit-restart-windows.mjs` and the Go
`restart054_test.go`.

§68 (0.55) is alert conditions and automatic PSA tickets. Four monitor kinds,
`DRIVE_FREE`, `UPTIME_LONG`, `UPDATES_MISSING` and `UPDATE_FAILED`, read only
what the server stores. They are `INVENTORY_KINDS`, evaluated by the sweep, and
`AGENT_KINDS` is unchanged, so there is no agent change.

- **Drive alerts** are one per drive, keyed `<rule>:<computer>:<letter>`. The
  letter must pass `DRIVE_LETTER` (`^[A-Z]:$`) first.
- **One ticket per alert.** `MonitorAlertTicket.alertId` is unique, with
  attempts `CHECK 1..4`, a closed status, and a retry time only on `failed`
  (0076).
- **Where it runs.** `AlertTicketsService.pass` is called once, from the
  monitoring sweep after `notifyPass`, and has no timer, so `MONITOR_SWEEP=off`
  stops it.
- **The order:**
  1. `autoTicketDecision`: the rule, the backlog (`enabledAt`), severity, kinds,
     `notifyFrom`, an open site outage, a maintenance window;
  2. the `notifications` pause;
  3. the per-business hourly budget (`PSA_AUTO_TICKETS_PER_HOUR`);
  4. `PsaService.alertTicket`: the claim (a unique insert, or a conditional
     update from `failed`), `PSA_AUTO_TICKET_REQUESTED` with `logOrFail`, then
     its one `drv.send`.
- **What is sent.** The draft is a manual alert ticket's, with detail null, no
  note and AI null. The audit meta carries ids only.
- **Changing the rule.** PUT and DELETE `ticket-policy` need `assertFresh`
  naming `monitoring.autoticket`, and are audited.
- **Recent alerts** on the dashboard is the alerts list's `active` where AND
  `endpointVisibilityWhere`.

Behavioural proof: `e2e-alert-tickets.mjs` (ports 3811–3812, a loopback
webhook stub, in `run-e2e.sh`). Unit: `unit-alert-conditions.mjs`. **No real
PSA has been called, and none of it has run against a real Windows
inventory.**

§69 (0.56) is hardware warranty and support links. (§68 is 0.55's.) The support-link
table is one pure module, `apps/api/src/warranty/vendors.ts`, with a byte-identical
web copy, `apps/web/lib/hardware-support.ts`. Every link in it is https to a host on
`VENDOR_HOSTS`. Only Dell puts the serial in a URL, after `DELL_TAG_RE` and
`encodeURIComponent`, and every vendor anchor in the console has `target="_blank"`
and `rel="noopener noreferrer"`. A virtual machine gets no links and is never
looked up.

The Dell and Lenovo lookups are called only from `warranty/client.ts`, only through
safe-https (`safeGet` / `safePost`, which share one `safeRequest`), with a 20 s
bound and a 256 KB cap. The client reads `WARRANTY_TEST_BASE_URL` only through
`testLoopbackAllowed`, which from 0.56 admits a query in `[A-Za-z0-9._~=&-]`.
`lookup()` takes the serial and nothing else about the computer, and the service
calls it in one place.

The credential is sealed (`rem0te-warranty-key-v1`) and appears in no response or
audit row; only its last four characters are kept. Settings are a Platform Admin's,
with `assertFresh` naming `warranty.settings`.

- **The sweep.** `WARRANTY_SWEEP=off` stops it, and `run-e2e.sh` and `e2e-ui.mjs`
  set it. It is bounded per hour (`WARRANTY_LOOKUPS_PER_HOUR`, at most 500) and asks
  each computer at most every 30 days. It skips an `integration` pause and claims
  each computer with a conditional write.
- **Check now** needs computers:edit, checks the same pause, and is audited.
- **Manual entries.** One needs computers:edit, is a conditional write, and is
  audited (`WARRANTY_SET`, before and after). A vendor answer never overwrites one.
- **Migration 0077** CHECKs the source, the dates, the coverage charset and the
  vendor list.
- **The report** reads through `devicesWhere`.
- **`WARRANTY_EXPIRING`** is opt-in, never in `RECOMMENDED`, and the 0.36
  `SWEEP_KINDS` set is unchanged.

**No real vendor API has been called from this server; never point a test at one.**
Behavioural proof: `e2e-warranty.mjs` (ports 3821–3823, a loopback vendor stub,
in `run-e2e.sh`). Unit: `unit-warranty.mjs`.

§74 (0.61) is the HP and Apple warranty lookups and "why is there no date".
§69 holds for every vendor; the lookup list is one constant,
`LOOKUP_VENDORS` in `vendors.ts` (`dell`, `lenovo`, `hp`, `apple`), which
the client re-exports and migration 0082's two CHECKs name exactly. HPE,
Microsoft, ASUS and Acer have no lookup, each with its reason in
`NO_LOOKUP_REASON`.

- **Hosts.** Every vendor URL in `client.ts` is https to one of its five
  `LOOKUP_HOSTS`. `warranty.api.hp.com`, `account.apple.com` and
  `api-business.apple.com` appear nowhere else in the API.
- **HP** is sent `[{ sn: serial }]` and nothing else: no product number
  (the inventory does not collect one) and no country. Its job id passes
  `JOB_ID_RE` before it is put in a URL. Polling is bounded by
  `HP_MAX_POLLS` (6), and an unfinished job is `VENDOR_PENDING`, transient.
- **Apple's** pasted key must be EC P-256 (`normaliseApplePrivateKey`) before
  it is sealed. Its client assertion is ES256 and lives five minutes. `keyId`
  is Apple's alone (0082 CHECK). A changed client id or key id drops the
  saved secret.
- **Tokens** live only in an unexported in-memory map, keyed by a SHA-256 of
  the credential.
- **Why no date.** One pure function, `warrantyGap`, gives the reason. The
  device card, the report (and its CSV) and the dashboard use it. The report
  and the dashboard read only enabled vendors' names, never a credential.
- **The console and `docs/warranty.md`** say HP and Apple were tested only
  against a stand-in.

**No real HP or Apple API has been called from this server.** Behavioural
proof: `e2e-warranty-vendors.mjs` (ports 3881–3883, a loopback stand-in for
HP's token, job, status and results and Apple's assertion token and
coverage, in `run-e2e.sh`). Unit: `unit-warranty-vendors.mjs`.

§75 (0.62) is patch staging: all at once, or one computer first. **It
reverses §15's and §38's "a canary first, then gated rings" at the owner's
request** ("remove the goofy canary thing in update policy"), as §41, §62 and
§67 were. Deployments, patch policies and company-wide policies all install
all at once by default; *Test on one computer first* is an option, never
ticked by default, and is the old behaviour.

- **One closed list.** `STAGINGS = ['none', 'canary']` in
  `actions/patch-policy.ts`, read only through `stagingOf`: absent is canary,
  anything else is null and refused (`staging_unknown`) by `validatePolicyDoc`
  first and by the evaluator.
- **The signed document.** `PolicyDoc.staging` is an optional enum. The portal
  writes it only for `'none'`, so a canary document is byte-for-byte 0.61's and
  every pre-0.62 policy keeps its digest and gate. It asks for the signer's
  `patchStaging: 1` capability first (`SIGNER_TOO_OLD`); an older signer's
  strict schema refuses the field anyway. The field is inside the digest, so a
  portal that edits it is `policy_digest_mismatch`.
- **What all at once skips.** Only ring order, the gate and the result keys.
  The evaluator reaches the staging branch after the standing, filter,
  display, requester, window, restart-rule and computer checks; under
  `'none'` it refuses any evidence (`bad_evidence`) and keeps
  `ring_already_signed` and `ring_retry_limit`. The signed pause and the
  ledger are unchanged, and the agent is unchanged.
- **Bounds.** Rings of at most 25, at most five: 125 computers
  (`MAX_ALL_AT_ONCE_COMPUTERS`, `planAllAtOnce`).
- **Deployments.** `PatchDeployment.staging` (0083, CHECK `none`/`canary`,
  default `canary`). `evaluateRingGate` skips its canary checks only when
  told `canary: false`, which `PatchingService.gate` says only for a `'none'`
  row. A single-computer install from the Patches tab stays canary.
- **Defaults.** Every API create (`CreatePolicyDto`, `CreateDeploymentDto`,
  `CreateSeriesDto`) defaults to `canary`, so a caller that leaves it out
  keeps the gate; the console always sends it.
- **Direct mode** (the same release): the policy, company-wide policy,
  deployment, automation schedule and restart window forms say *Create
  policy* / *Install* / *Save*, hide the approvers' reason and send
  `DIRECT_DEFAULT_REASON` ("Created in Rem0te (direct mode)"). Signed mode's
  wording and flow are unchanged, and the signer's checks are untouched.

Deploy: reinstall the approval signer from 0.62 before anyone makes an
all-at-once policy. Unit: `unit-patch-policy.mjs` (ungated rings, an old
document still gated, unknown values refused, a forged field caught) and
`unit-patch-assignment.mjs`. Behavioural: `e2e-patch-policies.mjs` and
`e2e-staged-patching.mjs`.

§76 (0.63) is policies that never expire. **It reverses "every approved
policy expires within 90 days" (the 0.32 patch policy, §63's revisions, §71's
automation schedules and §73's restart windows) at the owner's request**
("Does this mean the policy expires? Policies shouldnt expire"), as §41, §62,
§67 and §75 were. The console sends no expiry, and the forms and cards no
longer ask for or warn about one.

- **One signed value.** `EXPIRY_NEVER = 'never'` in `actions/patch-policy.ts`.
  `PolicyDoc` and `AutomationDoc` carry `expiresAt` optional and `expiry:
  z.literal('never')` optional, in strict schemas, so an older signer refuses
  the field. An old document's bytes, digest and expiry are unchanged.
- **One reader.** `expiryMsOf` returns Infinity only for exactly `"never"`
  with no date, the date for a date alone, and null for anything else. Every
  caller treats null as expired, never as "never". Nothing else parses a
  document's `expiresAt` (a missing one is NaN, which compares as never
  expired).
- **One admission rule.** `expiryProblem`, in `validatePolicyDoc` and
  `validateAutomationDoc`: an unknown value (`expiry_unknown`), both fields
  (`expiry_conflict`) or neither (`expiry_missing`) is refused, and a date
  keeps the 90-day cap (`expiry_too_far`).
- **The evaluators.** `policyStanding` and `evaluateAutomationPlan` refuse a
  null expiry (`expiry_unknown`) after revocation and before `policy_expired`,
  and bound the plan's `notAfter` by a date when there is one. The signer's
  effective statuses read null as `EXPIRED`. The field is in the digest, so a
  portal that adds or drops it is `policy_digest_mismatch`.
- **The portal.** `CreatePolicyDto`, `CreateAutomationDto` and `SetWindowDto`
  take an optional `expiresInDays` with no default; without it the document
  says `"never"`, and only after the signer's `neverExpires: 1` capability
  (`SIGNER_TOO_OLD`). `CreateSeriesDto` refuses one, and no revision carries
  one. An expiring revision made before 0.63 is renewed once more, into one
  that never expires.
- **The database.** 0084 makes `PatchPolicy.expiresAt` and
  `AutomationPolicy.expiresAt` nullable, null exactly for a `"never"`
  document (two CHECKs against the stored document). The sweeps read null as
  "never", never as expired.
- **Nothing else is relaxed.** Revocation, pause, window, computers, restart
  rules, the signed pause, the ledger and the retry limits are unchanged.
  Device result keys are pinned at approval and never tied to expiry.

Deploy: reinstall the approval signer from 0.63 before anyone saves a policy,
schedule or restart window. Unit: `unit-patch-policy.mjs` (signed 105 days
on, an old document still stops, unknown values refused, a forged field
caught), `unit-automation-schedule.mjs`, `unit-patch-assignment.mjs`,
`unit-approval-signer.mjs` and `unit-restart-window-settings.mjs`.
Behavioural: `e2e-patch-policies.mjs`, `e2e-patch-assignment.mjs`,
`e2e-automation-schedule.mjs` and `e2e-restart-window-settings.mjs`.

§70 (0.57) is device discovery and adoption. The unassigned pool is
`common/unassigned.ts`: `tenantId` null OR `customerId` null
(`UNASSIGNED_WHERE`, `isUnassigned`). `assertAssigned` refuses a pooled
computer with `403 ENDPOINT_UNASSIGNED`, even for a Platform Admin. It sits at
every remote and action choke point:

- `sessions.create`, `authorizeConnect` (`endpoint_unassigned`, which also
  covers Connect, the `.cmd` and the launcher), and `admitWrite` for WRITE
  (password, rotate, reinstall, agent update and migrate);
- `createPlan` (actions, scripts, patch rings) and diagnostics;
- device-control, software (four paths) and patch install;
- tray pair, self-help and support requests;
- Quick Connect (`refusePooled`, also on the launcher's ad-hoc path).

RustDesk update staging skips pooled computers. The device edit route refuses to
move one (`USE_ADOPTION`). An authenticated heartbeat from a pooled computer
takes the `if (authenticated && pooled)` branch before rotation. It records
live state, hands out only the automatic inventory commands, and returns every
flag null with `pending: true`.

The pool, assignment rules and deployment keys are Platform Admin only
(`assertPlatformAdmin` on every method). Three keys in §62 name their step-up:

- `devices.adopt` (adopt and forget);
- `adoption.mappings` (create a rule);
- `deployment.keys` (create a key).

Revoking a key and deleting a rule never ask. Adoption is a conditional
`updateMany` from `UNASSIGNED_WHERE` with `ENDPOINT_ADOPTED` (approver,
before/after, key, rule, groups) in the same transaction, and anything else
is `not_unassigned`. Forget is a conditional `deleteMany` with
`ENDPOINT_FORGOTTEN`.

Deployment keys are 96 hex characters. Every installer's existing 16–128 hex
token check accepts them, so no installer changed. The claim looks a token up
as a claim token first. Only the SHA-256 is stored, and the key is returned
once. 0078's CHECKs hold the limits: at most 90 days and 10,000 uses, mode
`review` (default) or `active`. A use is one conditional UPDATE
(`useCount < maxUses`), so parallel claims never pass the ceiling. A re-run on
an enrolled computer is a no-op and uses nothing. An existing node must prove
its device secret. A computer in another business is refused, and nothing
moves it. A review key pools the computer, tagged with the key. Only an
`active` key places a computer automatically, and only in its own business.

Assignment rules have four kinds: `deployment_key`, `domain`, `cidr` and
`hostname_prefix`. `PoolFacts` carries exactly the key, domain, source address
and hostname, never a signed-in user or an e-mail address, and the adoption
code names neither. Rules are suggestions only and nothing applies one. 0078
triggers keep keys and rules inside one business. `arrivedVia` is CHECKed, and
a NOT VALID CHECK refuses a business without a tenant.

The old `POST /admin/unassigned-devices/:id/assign` is gone. Behavioural proof:
`e2e-adoption.mjs` (port 3831, in `run-e2e.sh`). Unit: `unit-adoption.mjs`.
**No deployment method (GPO, Intune, RMM, the macOS MDM script) has been run on
a real fleet**; they run the existing installers with the key as the token.

§71 (0.58) is automation schedules. A recurring script run or software install is an automation policy:

- **The document** is one signer document (`actions/automation-policy.ts`, pure, on the signer's ALLOWED list), with
  its own digest and signing prefixes.
- **Its recurrence** is hourly (automation's own closed shape) or the patch policy's weekly or monthly window.
  `PolicyWindow` is not widened, so §66 and every patch document's bytes are unchanged, and `recurrenceKind` fails
  closed.
- **Approval.** Two passkey approvers on the signer's origin approve it, never its author
  (`requester_cannot_approve`) and never a script's contributor (`contributor_cannot_approve`). In direct mode it is
  active at admission, decided only by the signer's `policyFor`, and the portal asks `actions.direct` first.
- **Each run.** The signer signs a run only after the ordinary `admitPlan` (allowlist, software revocation, pauses)
  and `evaluateAutomationPlan`. Revocation is checked first, then:
  - the exact task;
  - the named computers bound to their identity, or the group's business and cap;
  - the window;
  - the offline rule as `notAfter`;
  - no overlap;
  - at most three plans per window.
- **Signer routes.** The internal routes are propose, read, revoke and plans only, and revocations are write-once.
- **Portal routes** are list, create, preview, read, pause, resume and revoke. There is no approve route. Create,
  resume and revoke need `assertFresh` naming `automation.policy`; pause never does, and cancels undelivered plans.
- **The sweep** (`AUTOMATION_SWEEP`; `=off` is exact, exported by `run-e2e.sh` and set by `e2e-ui.mjs`) makes one
  `ActionsService.createPlan` as the author with `underPolicy.kind: 'automation'`. It does so only after checking:
  1. no open plan;
  2. the `actions` containment pause;
  3. the author;
  4. the task still allowlisted or unarchived.
- **Disabled by default.** Only `AutomationService.create` writes an `AutomationPolicy` row, and 0079 keeps REVOKED
  final.
- **The agent is unchanged**: a run is an ordinary script or software plan.
- **This amends 0.34's wording, not §39.** A scheduled run is approved once per schedule, not per run, by two people
  who are still not the script's writers. §39's allowlist and constant-command-line checks hold as before. §65 and
  §66 are unchanged; one-time script and software schedules reuse `common/schedule.ts` as the signed `notBefore`.

Behavioural proof: `e2e-automation-schedule.mjs` (ports 3841–3843, `RELEASE_BIN` / `ACTION_SIM` / pwsh). Unit:
`unit-automation-schedule.mjs`.

§72 (0.59, "Agit8or Identity P0") is SSO identity: the groundwork for trusting
a self-hosted Keycloak. Every decision made from a provider's claims lives in
`apps/api/src/sso/identity-policy.ts`, which imports nothing. A sign-in's
level is its `acr`, lowered until `amr` agrees. A Platform Admin is refused
through SSO unless the provider has `allowPlatformAdmin` (off by default), and
then admitted only at the passkey level. `bindOrgId` is a gate on the
`organization` claim, never a grant.

The SSO step-up asks `max_age=0`, `prompt=login` and the acr. It is judged
against the login-state row's own start, user and session `iat`. It issues
`sso-passkey` only from a provider with `trustIdpPasskey`;
`PHISHING_RESISTANT_METHODS` is exactly `passkey` and `sso-passkey`, and
there is no catalog key for the step-up itself.

Back-channel logout (public, rate-limited) checks the signature against the
provider's JWKS (asymmetric algorithms only) before acting on any claim. It
refuses a `nonce`, then records the `jti` in `SsoLogoutReplay`, and only then
revokes. Revocation is per account. Refresh and ID tokens and the
private_key_jwt key are sealed under their own secret-box purposes; the
private key is in no view.

`SSO_SESSION_SWEEP=off` is exact, exported by `run-e2e.sh` and set by
`e2e-ui.mjs`. **Never set it in production**: no session ended at a provider
without back-channel logout would end here. `invalid_grant` ends a session;
an unreachable provider keeps it (`open`, with an alert) or ends it
(`closed`).

A link suggestion is never acted on automatically. The only ExternalIdentity
insert in `SsoIdentityService` is the admin's confirm (`sso.configure`). No
Platform Admin or break-glass account is ever suggested.

`ssoMode` (`Customer`, and `PlatformSettings.staffSsoMode`) `required`
refuses a *linked* account's password and passkey sign-in, only after the
credential verifies. It needs every active account in scope linked and
`sso.enforce` to tighten; lowering never asks. The recovery CLI's
`--sso-mode` only lowers.

`User.breakGlass` is Platform Admins only (0080 CHECK), at most two (0080
trigger), needs TOTP and a passkey, and changes under `breakglass.manage`.
Each use is a sealed `BREAK_GLASS_LOGIN` written with `logOrFail` before the
session, plus an alert and mail to confirmed Platform Admin recipients.

`JwtStrategy` accepts HS256 only and refuses any payload with integration or
IdP claims. The integration guard refuses any `Authorization` header. The
delegation check refuses an IdP-looking token.

The login lockout is the `LoginLockout` table, not memory. **No real identity
provider has been called**; `docs/sso-keycloak.md` is untried.

Behavioural proof: `e2e-sso-identity.mjs` (ports 3851–3853, a loopback mock
provider, `SSO_SESSION_SWEEP` on and fast); unit: `unit-sso-identity.mjs`.

§73 (0.60) is the simple restart window: "restart if Windows needs it (or
always), nightly 02:00–04:00" on a business, a device group or one computer,
which may instead say "no automatic restarts". Precedence is computer > group
(priority) > business through `restart-windows/resolve.ts` (pure, the 0.35
rule). A window not in force (awaiting approval, rejected, revoked, paused,
expired) governs nothing and the next one down applies. With nothing set,
nothing restarts a computer automatically.

A window is an automation policy (§71) whose task is `restart`. `RestartTask`
is strict: a rule of two and `ignoreRemoteSession` only as `true`, never by
default. Its targets are `business`, `group_members` or one named computer;
those two kinds are refused for a script or software task. It is never
hourly, always `run_when_online`, and at least 30 minutes long.

Each restart is one `windows.reboot.schedule@1` plan for one computer with
exactly `restartParamsFor(task)`. The signer decides it in
`evaluateAutomationRestart`, in order: `restart_rule_unknown`,
`action_not_in_policy`, `override_not_allowed`, `restart_params_not_allowed`,
`script_not_in_policy`, `bad_display`, `requester_mismatch`,
`computer_not_in_policy`, `outside_restart_window` (the shared occurrence
function), `restart_already_signed` and `restart_retry_limit`. The last two
are per computer, from its own ledger, three a window.

The portal asks only in `RestartWindowsService.proposeFor`, through one
`ActionsService.createPlan`. Containment (`actions`) comes before it reads a
computer. It skips a computer that a patch policy's own restart window
governs. Under "if required" it asks only when the last scan says a restart
is pending. A retry is 0.54's rule: 15 minutes apart, after a RustDesk session
or "cannot tell", or a plan that never arrived.

A window, and removing a group's or computer's own setting, need
`assertFresh` naming `restart.window`. "No automatic restarts" and removing a
business's window never do. 0081 holds the setting's CHECKs, the
same-business trigger and `attempt BETWEEN 1 AND 3`. A group carrying a window
cannot be deleted. `RESTART_WINDOW_SWEEP=off` is exact and set by `run-e2e.sh`
and `e2e-ui.mjs`. The signer must be 0.60 (`restartWindows: 1`); the agent is
unchanged. **No restart window has restarted a real Windows computer.**

Behavioural proof: `e2e-restart-window-settings.mjs` (ports 3871–3873,
`RELEASE_BIN` / `ACTION_SIM`); unit: `unit-restart-window-settings.mjs`.

§78 (0.66) is alert classification. The pre-0.66 recommended `disk-errors`
monitor named no level and no provider, so Kernel-General's informational
event 11 for a registry hive inside a read-only shadow copy (0xC00000A2) was
a critical disk alert on DS-HOME1. Every event-monitor match now goes through
`apps/api/src/monitoring/classify.ts`, which is pure (it imports only
`node:crypto`) and versioned (`CLASSIFIER_VERSION`).

- **Known-harmless patterns** (`KNOWN_BENIGN`) each name the log, provider,
  event id, levels 4 or 5 only, an 8-digit status code and a component.
  `benignMatch` compares all six and never message words. The status code
  and component come from the `0x…` code and the NT device path in the
  message, which Windows does not translate.
- **Never above the monitor.** The monitor's severity is the ceiling
  (`minSev(…, ruleSeverity)` everywhere). An unknown event keeps it. The
  Security log and level 0 are never lowered by level. Events counted but not
  sent keep an alert at WARNING at least.
- **Fingerprints** keep 8-digit status codes; only 9+ hex digits are taken
  out.
- **The recommended monitor** (`DISK_ERRORS_PARAMS`) asks for levels 1–3 and
  names no provider, on purpose: every storage controller driver logs its own
  event 11.
- **On start**, `AlertQualityService` corrects a `disk-errors` monitor only by
  a conditional write on the exact `DISK_ERRORS_PRE066_PARAMS`, audited
  (`MONITOR_RULE_CHANGED`, `op: corrected`). It reclassifies open event
  alerts conditionally on the version it read, audited
  (`MONITOR_ALERT_RECLASSIFIED`) and in the alert's history. It deletes
  nothing.
- **`ingestReport`** classifies, then records fingerprints
  (`MonitorEventFingerprint`, 0085), then evaluates the classified count,
  then raises. Similar alerts are read through `alertWhere`.
- **The agent** sends at most five samples of 300 characters. Older agents
  keep working with one.

Behavioural proof: `e2e-alert-quality.mjs` (port 3921, in `run-e2e.sh`);
unit: `unit-alert-classification.mjs` (in CI) and `unit-monitoring.mjs` with
`PWSH`. **The samples block has never run on real Windows.**

§79 (0.67) is false positives and alert quality rules. Reporting a false
positive is a record, never a change: `FalsePositiveService.report` writes the
report, may resolve that one alert and may count towards a recommendation; it
writes no monitor and no rule, and its audit meta carries no comment.
Recommendations rank by reports, reporters and computers and approve nothing.

- **One pure module**, `monitoring/quality-rules.ts` (node:crypto, zod,
  `./engine`, `./classify` only): the schemas, `RULE_TOO_BROAD`, risk,
  precedence (endpoint > group > business > monitor > os > platform, then
  conditions, then what keeps more), `inForce` (active and unexpired), and
  `scopeCovers`, which never crosses a business.
- **Only `QualityRulesService`** creates or changes an `AlertQualityRule`.
  `QualityEngineService` caches rules for 30 s and writes only match
  counters, conditionally. A pending rule is shadow: counted, never applied.
- **Approval**, in order: scope (`assertConfigure`), a simulation of the
  current revision under seven days old, `acceptDangerous` when it found
  dangerous matches, a different second approver for a high-risk rule, then
  `assertFresh` naming `monitoring.qualityrule` (default `off`), then the
  first write. A platform rule and `allowBroad` are a Platform Admin's.
  Reject and rollback never ask. Rollback restores a superseded predecessor.
- **Where rules apply**: in `ingestReport` after fingerprints are recorded
  and before the threshold, and in `raise()` for a threshold alert, so
  notifications and PSA tickets see the result. A rule only lowers.
- **Expiry** is a `MonitoringService.addSweepStep`; nothing in the quality
  services has its own timer, so `MONITOR_SWEEP=off` stops it.
- **Mail** goes only to confirmed recipients, stops under a `notifications`
  pause, and never throws.
- **Tickets**: `linkDuplicate` links one event signature on one computer to
  its ticket for 24 hours instead of sending another.
- **0086** holds one active rule per scope and conditions, the approval and
  distinct-second-approver CHECKs, `simulatedRevision = revision` and the
  same-business trigger.

Behavioural proof: `e2e-alert-quality-rules.mjs` (ports 3931–3933, a loopback
webhook and SMTP, `MONITOR_SWEEP` on, in `run-e2e.sh`); unit:
`unit-alert-quality-rules.mjs` (in CI); `e2e-ui.mjs` drives the dialog and
the page.

§80 (0.69) is Managed Secure Access readiness: build step 2 of
`docs/managed-secure-access.md`, **read-only**. Nothing changes on any
computer and nothing can be Managed.

- **The agent only reads.** `rem0te-agent.exe rustdesk-preflight` builds its
  argv only through `msa.ReadArgs` — exactly `{"--option", key}` for the
  eleven keys of `msa.Keys`, the same list as the portal's `PREFLIGHT_KEYS` —
  and nothing in the preflight names `--password`. From 0.72 `--option` is
  named only by the preflight and `internal/msa/enforce/args.go`, and
  `--password` only by `args.go` (§82).
- **One exec site** (`preflightRunner.Read`): the installed
  `%ProgramFiles%\RustDesk\rustdesk.exe` (`installedRustdeskExe()`) by
  absolute path, an argument array, no shell, no window, output capped. It
  runs only when that file is installed (no reparse point) and is what the
  RustDesk service runs; the service is opened with query rights only. The
  subcommand takes no path (only `--force`, never from the heartbeat).
- **The portal** accepts `rustdeskPreflight` only in the heartbeat's one
  `msa.recordPreflight` call, behind `authenticated && mayAct && kind ===
  'signed'` and after the not-may-act and pooled returns (§64, §70). The DTO
  only `@Allow`s it; a strict zod parse drops anything else and never fails
  the heartbeat. Only `MsaService` writes `RustdeskPreflight` (0087's CHECKs).
- **`msa/readiness.ts`** is pure (two pure imports) and returns only
  `PRODUCIBLE_STATES`; `managed`, `managed_verified` and
  `enforcement_failure` are in the type and unreachable, and every answer is
  `verified: false`. RustDesk below 1.4.1 is "not lab-tested", never "broken".
- **Routes** are two GETs under `computers:view`, reading computers only
  through `endpointVisibilityWhere`.

Behavioural proof: `e2e-msa-readiness.mjs` (port 3941, in `run-e2e.sh`);
unit: `unit-msa-readiness.mjs` (in CI) and the Go `internal/msa` tests; lab:
`TestLabRustdeskPreflight` in the Windows lab's RustDesk jobs (as the
administrator, and as SYSTEM through the real agent). **It has run only on
Windows Server in the lab**, never on a desktop or the fleet.

§81 (0.71) is Managed Secure Access grants and the long-poll: build step 3,
**behind `MSA_GRANTS`, off**. Nothing on a computer acts on a grant, and the
agent binary is unchanged.

- **The switch** is `msaGrantsEnabled()` in `msa/msa-grants-flag.ts`, exactly
  `MSA_GRANTS === 'on'`, read nowhere else. `MsaGrantsGate`, a middleware on
  both grant controllers, answers `404 MSA_NOT_ENABLED` before the throttler,
  the session guard or the handler. Every public `MsaGrantService` method
  asserts it again first. Nothing under `deploy/` and not `run-e2e.sh` sets it.
- **Writers.** Only `MsaGrantService` writes `MsaGrant` and `MsaGrantKey`, and
  only it uses the purposes `rem0te-msa-grant-key-v1`, `-pw-v1` and
  `-envelope-v1`. No audit meta, log line or answer carries the private key,
  the password or the envelope. `MSA_GRANT_KEY_CREATED` is the key id;
  `MSA_GRANT_ISSUED` is ids, mode, consent and key id.
- **Issuing** is `POST /msa/grants/test/:endpointId`, Platform Admin, then
  `assertFresh` naming `msa.grant`. The service then checks, in order:
  scope; `assertAssigned`; Windows and `runsSignedAgent`; the `remote`
  pause; the key. It writes the audit row (`logOrFail`) before the grant
  row. `issueTest` has one caller, and the module exports nothing. From
  0.73 there are exactly three issuers, each with one caller: `issueTest`
  (this route), `issueForConnect` (`MsaSessionService.connect`, after
  `authorizeConnect`, §83) and `issueVerification` (a cutover run, §83).
  The Legacy Connect, sessions and launcher code outside `msa/` reaches
  none of them.
- **The poll** (`POST /msa/agent/poll`, `@Public`, `@RateLimit(120)`) calls
  `authenticateDevice` before reading anything. It then admits only an
  assigned Windows computer whose identity is the signed agent. An ack is
  conditional on the computer's own issued, unexpired grants. A superseded
  poll hands nothing over.
- **The document.** `msa/grant.ts` imports only `node:crypto` and zod. Its
  `GRANT_PREFIX` (`rem0te-msa-grant-v1\n`) and `REASONS` order are the Go
  verifier's (`internal/msa/grant`). That package is pure (no clock, file,
  network or process). It lives outside `internal/msa` because the agent
  imports that package for the preflight; from 0.72 only
  `internal/msa/enforce` and `internal/agent` import it (§82).
- **0088** CHECKs the four states, the five-minute window, the limits and
  the sealed columns, and holds one active key (partial unique index).

Behavioural proof: `e2e-msa-grants.mjs` (port 3951, in `run-e2e.sh`). Unit:
`unit-msa-grants.mjs` (in CI), which rebuilds the shared fixture
`internal/msa/testdata/msa-grants.json` (`gen-msa-grant-fixture.mjs`,
test-only keys) and asserts every case, and the Go `internal/msa/grant`
tests, which assert the same file. **No agent polls, and none of it has run
on Windows.**

§82 (0.72) is Managed Secure Access enforcement, the managed test session,
cutover and rollback: build step 4, **behind `MSA_GRANTS`, off**. This is a
new signed agent build, but a computer changes only when a Platform Admin
moves that **one** computer; a Legacy computer behaves exactly as 0.71.

- **The heartbeat** says `msaPoll: true` only to an authenticated signed
  agent that may act, only with the switch on and a `MsaManagedComputer`
  row. The signed heartbeat starts `rem0te-agent.exe msa-poller` (no
  argument) only on that answer. One poller at a time (`poller.lock`); it
  exits when idle or told the computer is Legacy.
- **Writers.** Only `MsaManagedService` writes `MsaManagedComputer` (0089),
  except that the poll records `lastPollAt` (0.73, one field write in
  `MsaGrantService`, no state). Every public method asserts the switch first. `MsaManagedService`
  moves grants only by conditional `updateMany`; only `MsaGrantService`
  creates them.
- **Who.** Cutover and confirming verified are a Platform Admin's with
  `assertFresh` naming `msa.cutover`; revealing a test session's one-time
  password (once) names `msa.reveal`; rollback never asks. No route on
  `msa/managed` takes a group or a business; group and business cutover is
  the run controller's (§83), one computer at a time through `cutover`.
- **Cutover**, in order: scope, the pool, not already managed, every blocker
  (Compatible readiness, an agent that can enforce, no `remote` pause, a
  grant key in the published release), the audit row, then the row.
- **The ceiling** is, from 0.73, control with clipboard, file transfer and
  audio, never a tunnel or a remote restart (0.72's was view-only). It is
  the same on both sides (`enforce.Ceiling` compiled into the agent, the
  portal's `MANAGED_CEILING`), never taken from the portal, so widening it
  is a signed agent release.
- **What RustDesk enforces is the ceiling, not more (0.78.1, F1).**
  RustDesk's Flutter builds read `access-mode=full` as every permission on
  before any `enable-*` key, so agents 0.73.0–0.78.0, which set `full` for
  control, enforced none of it. Now:
  - no argument list, desired map or allowed value carries `full`
    (`args.go` `refused`, in `SetArgs` and `RestoreArgs`); control is
    `custom`, view is `view`, and a rollback puts a saved `full` back as
    RustDesk's default;
  - every RustDesk permission option is governed (`enforce.Permissions`,
    twelve). The six no grant names (`enforce.Locked` / `LOCKED_KEYS`:
    terminal, camera, remote printer, block-input, privacy mode,
    recording) are `N` on every grant, view and control alike, and read
    back. A disagreeing readback refuses the grant (`readback_mismatch`);
  - `Apply` refuses, before it writes, a grant whose desired values
    RustDesk's own rule (`enforce.Effective`) would widen beyond what the
    grant and the ceiling allow (`Beyond`);
  - `MANAGED_KEYS` is the preflight's eleven then the six. The preflight
    itself still reads eleven. 0098 widens the `failedKeys` CHECKs.

  `enable-privacy-mode` is honoured only from RustDesk 1.4.7. The person at
  the computer can still widen permissions in the accept window, a
  built-in option no `--option` sets.
- **The agent.** One enforcement exec site (`enforceRunner.Run`) runs only
  what `enforce.Valid` accepts, the installed `rustdesk.exe` by absolute
  path, an argument array, no shell, and only when the RustDesk service runs
  that file. Grant keys come only from the signed `msa/grant-keys.json`
  target of the verified update chain. The replay set is written before
  anything changes. Settings are saved (SYSTEM-only DACL) before the first
  apply, every value is read back, and a mismatch ends the session with a
  password nobody is told. No password reaches a log, journal or report.
- **A device report** is parsed strictly, then the device secret is checked,
  before any read.
- **Passwords.** A verified computer's legacy password is never revealed,
  launched, rotated or set, and a staged rotation waits (`rotationHeld`).
  After a pending test session ends, the portal re-establishes a password it
  knows through the existing rotation; rollback stages one too.
- **The release host** publishes grant keys (`rem0te-signed-grant-key
  add|list|retire`, then `rem0te-signed-publish`); the portal only shows the
  two commands, matched exactly in §56's allowlist
  (`msa/grant-key-commands.ts`).
- **Step 5 is §83 (0.73).** Turning the switch off with a verified
  computer still refuses its legacy password: roll back first.

Behavioural proof: `e2e-msa-managed.mjs` (port 3961, in `run-e2e.sh`). Unit:
`unit-msa-managed.mjs` (in CI) and the Go `internal/msa/enforce` tests (a
fake RustDesk runner). Lab: `TestLabRustdeskEnforce` in the Windows lab's
RustDesk jobs (save, apply, read back, password, end session, restore, as the
administrator and as SYSTEM; from 0.78.1 also `access-mode` reading
`custom` and the effective permissions by RustDesk's rule, `labEffective`,
which is derived from what RustDesk reports, never a connection). The F1
Go tests are `internal/msa/enforce/f1_test.go`. **It has run only on
Windows Server in the lab**, never on a desktop, with a real remote
connection, or on the fleet.

§83 (0.73) is Managed Secure Access sessions: build step 5, **behind
`MSA_GRANTS`, off**. Connect through grants, revocation, session evidence
and cutover runs. It is a new signed agent build (0.73.0); a Legacy
computer's Connect is unchanged.

- **Connect** on a verified managed computer is `POST
  /msa/sessions/connect/:endpointId`, whose body carries only `mode`.
  `MsaSessionService.connect` checks, in order:
  1. the computer is verified managed;
  2. its agent is at least `MIN_SESSION_AGENT` (0.73.0) and polling (a held
     poll, or `lastPollAt` within 90 s);
  3. nobody else has a live session there;
  4. `authorizeConnect({ managed: true })`, the ordinary launch policy.

  Then `managedGrantTerms` turns the policy's own facts into the grant,
  `MSA_SESSION_REQUESTED` is written with `logOrFail`, and
  `issueForConnect` signs. Only on this path are view-only and attended
  consent enforceable (`ctx.managed === true` in the access policy) and the
  Legacy credential gate skipped. Legacy Connect keeps refusing a verified
  computer and keeps refusing view-only on a Legacy one.
- **The password** goes once, to the grant's own technician, for an applied
  Connect grant: `MSA_PASSWORD_RELEASED` (`logOrFail`, ids only), a
  conditional claim, then it is opened into the Connect script. A Connect
  grant not applied within `CONNECT_APPLY_TIMEOUT_MS` (60 s) is revoked
  (`timeout`) and nothing is handed over. It never falls back to a Legacy
  password.
- **The ceiling** is control with clipboard, files and audio; never a
  tunnel or a restart (§82). Clipboard and files only when the access
  controls say `request` and, for a preset technician, the preset allows
  them.
- **Revocation** is signed under the grant key with its own prefix,
  `rem0te-msa-revoke-v1\n` (`msa/revocation.ts`, pure, and the Go
  `grant.VerifyRevocation`, the same reasons in order). Only
  `MsaGrantService.revoke` stores one. It moves only live grants to
  `revoked`, creates no key and is audited (`MSA_SESSION_REVOKED`). A
  `remote` pause revokes every delivered or applied grant. Who may revoke:
  - the grant's own technician;
  - a Platform Admin;
  - the business's own non-technician member with `computers:edit`.

  Revoking never asks for a fresh confirmation. The agent verifies before
  acting, and a revocation only ever ends a session.
- **Evidence.** `msa/session-timeline.ts` is pure: Requested → Authorized →
  Received → Applied → Launched → Connected → Disconnected / Expired /
  Revoked / Failed. Launched is never Connected, and every timeline says
  what the agent cannot see.
- **Cutover runs** (`msa/cutover-runs`) are a Platform Admin's. Start,
  advance and confirm name `msa.cutover`; halt and rollback never ask.
  - The canary must be verified before any batch.
  - Every computer goes through `MsaManagedService.cutover`, with its own
    blockers and audit row; a refused one is skipped with its code.
  - Batches are at most 25, the next waits for the last to read back (or an
    hour), and nothing runs on a timer.
  - Only the run service writes `MsaCutoverRun` / `MsaCutoverMember`.
- **0090** CHECKs `revoked`, the sources, the reasons, a revocation's shape
  and nine-hour window, one open run per business and a run in one
  business (trigger).

Behavioural proof: `e2e-msa-sessions.mjs` (port 3971, in `run-e2e.sh`).
Unit: `unit-msa-sessions.mjs` (in CI), which rebuilds and asserts the
shared fixture `internal/msa/testdata/msa-revocations.json`, and the Go
`internal/msa/grant` and `internal/msa/enforce` session tests. Lab:
`TestLabRustdeskEnforce` adds revocation → session end and the control
ceiling's apply and readback. **It has run only on Windows Server in the
lab**, never on a desktop, with a real remote connection, or on the fleet.

§84 (0.74) is Admin → Security (`docs/server-security.md`). The page reads
this host as `reboot` and changes it only through the sudoers lines the
installer already grants.

- **One exec site**, `admin/host-security/host-runner.ts`: `spawn` with
  `shell: false`, argv only from `argvFor`'s closed switch, fail2ban
  arguments through `f2bArgsOk` (the `rem0te-f2b` wrapper's own shapes).
  Nothing else in the module imports `child_process`.
- **Every sudo command** is `sudo -n` and a NOPASSWD line of
  `deploy/scripts/install.sh`, word for word; the runner never names
  `fail2ban-client`.
- **Every mutating route** is `assertPlatformAdmin`, then `assertFresh`
  naming `server.security` before the service call (the lockout:
  `login.lockout`, only when it weakens).
- **Every host change** records `HOST_SECURITY_CHANGED` with its outcome;
  a failed command is `502 HOST_COMMAND_FAILED`, never success. Lockout
  changes record `LOGIN_POLICY_CHANGED`.
- **Tests never touch the host.** `SECURITY_HOST_FIXTURE` is read only
  under `NODE_ENV=test`; a test process without one refuses every change
  (`503 HOST_CHANGES_OFF_IN_TEST`).
- **Removed for good**: `npm audit fix`, ESLint / semgrep on the server, the
  Caddy `/load` "renew". The posture's `OFF_SWITCHES` must name every
  `*_SWEEP` / `*_SEALER` the API reads, so a new switch adds a line there.
- Unknown is never OK: a check whose source cannot be read is `unknown`,
  and the score counts only decided checks. Release root keys are always
  unknown (§56); the web shows `sudo rem0te-signed-status`.

0.75.1 extended §84 for accepted risks and two false positives:

- **Accepting a finding** (`POST findings/:id/accept`) is Platform Admin,
  then `assertFresh` naming `server.security` (it hides a warning), then
  `acceptFinding`. **Re-opening** (`DELETE` on the same path) is Platform
  Admin and never asks. It is the one mutating route without a step-up.
- **One closed list.** Only `ACCEPTABLE_FINDINGS` in
  `admin/host-security/acceptance.ts` can be accepted; 0093's CHECK names the
  same ids in the same order. `NEVER_ACCEPTABLE` is disjoint from it and
  holds a Platform Admin without MFA, break-glass without both factors, the
  audit chain, empty SSH passwords, `NODE_ENV`, every `process.switch.*`
  and every `web.tls*`. `acceptance.ts` is pure (`node:crypto`, posture's
  types).
- **Audited.** An acceptance is written with `logOrFail`
  (`SECURITY_FINDING_ACCEPTED`), and closed again if the audit write fails.
  Every end of one is a conditional write audited as
  `SECURITY_FINDING_UNACCEPTED` with its cause (`unaccepted`, `expired`,
  `resolved`, `evidence_changed`). Only `SecurityService` writes
  `SecurityFindingAcceptance`, and no row is deleted.
- **It holds only on the same fingerprint** (sha256 of id, status and the
  finding's `basis`) and before its expiry (none by default, at most 365
  days). The basis never leaves the API. An accepted finding keeps its
  status, is never shown as OK, and carries no penalty; coverage is
  unchanged.
- **Listeners.** `ss -Htlnup` runs as `reboot`, never through sudo. An
  unconnected UDP socket inside `/proc/sys/net/ipv4/ip_local_port_range`
  is an ephemeral client socket (hbbs's), shown as information. TCP, and
  UDP outside the range, are judged as before; an unreadable range excuses
  nothing.
- **SSH** is first match wins: a value is Unknown only when an unreadable
  file comes before its first readable setting (`unreadableBefore`).

Behavioural proof: `e2e-host-security.mjs` (ports 3991–3994, in
`run-e2e.sh`; 3994 is the host after its evidence changed); unit:
`unit-host-security.mjs` (in CI); `e2e-ui.mjs` opens every tab against the
fixture host and drives the accept dialog.

§85 (0.75) is the device page's **Tools** panel: a menu of what can be done to
a computer that opens the flow that already does it, never a second way in.
`apps/web/lib/device-tools.ts` is pure (no import, no fetch, no clock) and
decides each tool's state (coming later, unsupported, inactive, not
permitted, not configured, checking, needs a newer agent, paused, offline,
needs approval, available). The panel (`tools-panel.tsx`) only reads what the
tabs already read — the action catalog, the diagnostics catalog and the
containment banner — with no mutation and no Managed Secure Access route.
Every action it names is an approved catalog id and every check a listed
diagnostics key; its one link is the existing diagnostics report. No API
route names "tools"; the server stays the authority. Unit:
`unit-device-tools.mjs` (in CI); browser: `e2e-ui.mjs`.

§86 (0.76) is the read-only diagnostics palette: thirteen more catalog keys
(Defender, firewall, BitLocker, Secure Boot / TPM, local administrators, a
DNS lookup, a TCP port test, routes, time sync, activation, unexpected
shutdowns, scheduled tasks, sessions) on §20's path unchanged. No new action,
nothing signed, no new route, nothing that changes the computer.

- **The agent block** (`# ---- Read-only palette (0.76)` in
  `windows-script.ts`) passes `assertPaletteBlockSafe`, which `template()`
  returns through. It allows only `Get-*` and a short read-only list, and no
  `Set-`/`Enable-`/`Disable-`/`Remove-`/`Start-`/`Stop-`/`Restart-`. It has
  no `Invoke-Expression`, no download and no script block, a fixed list of
  .NET calls, and one `New-Object` (the TCP client).
- **One process.** The call operator appears exactly once:
  System32's `w32tm.exe /query /status`.
- **Never read:** a recovery password, a protector id, a product key or a
  task's actions. §86 checks all of this again, independently of the guard.
- **Typed parameters** exist for `dns_lookup { name }` and
  `tcp_port { host, port, timeoutSeconds }` only.
  - They are checked by `parseDiagnosticParams` at request (before anything
    is read) and again at delivery (`bad_params`), by 0092's CHECK
    (`ELSE "params" IS NULL`), and by the agent (`Test-Rem0tePalKeys`).
  - The host-name rule is the same text in `catalog.ts`,
    `windows-script.ts` and both CHECK clauses.
  - Both keys need `computers:connect`.
- **Interpretation.** `interpret.ts` is pure. Unknown or Unsupported is never
  Healthy. OS support comes from a static table and goes Unknown after a
  year.
- **Agent version.** A palette key on an agent older than 0.76.0 is
  `DIAGNOSTIC_NEEDS_NEWER_AGENT`. It is the heartbeat script, not a Go
  build: signed agents get it at the next `rem0te-signed-publish`.

Unit: `unit-diagnostics-palette.mjs` (in CI; with `PWSH`, stub runs).
Behavioural: `e2e-diagnostics-palette.mjs` (port 4011, in `run-e2e.sh`).
Lab: `agent-lab-windows (diagnostics palette)`. **It has run only on GitHub's
Windows Server runner**, never on a desktop or the fleet.

§87 (0.77) is the background terminal (`docs/remote-terminal.md`). **It
reverses three rules for this feature only, at the owner's request**
("background terminal … both directions"), as §41, §62, §67, §75 and §76
were:

- §14's closed catalog: a terminal is not a catalog action and the approval
  signer never sees it;
- "the agent runs no process" (§14, §61): the remote worker starts
  `cmd.exe` or `powershell.exe`;
- §39's constant command line: the command line is still constant, but the
  shell's stdin is what the technician types.

Approved actions, scripts, patching and software are unchanged, and the
signer gains nothing. What contains it:

- **Who.** `computers:terminal` is in `PLATFORM_CAP`, never `CAP`, so no
  Business Owner, grant, preset or SSO mapping holds it (an owner holds every
  business capability, so a business capability would make default deny a
  setting the business could switch off). The opener is the only one who reads
  or types; others with `computers:view` see that it exists.
- **Opening**, in order: scope, the shell (`cmd` / `powershell`), a reason
  (3–500), `assertFresh` naming `terminal.open` — **the one catalog key whose
  default is `ask`** (§62; still relaxable through `confirm.relax`) — then
  `openRefusal`: the pool (§70), Windows + `runsSignedAgent`, a device
  secret, agent ≥ 0.77.0, a `remote` pause, reporting, one per technician,
  three per computer; `TERMINAL_OPENED` with `logOrFail`, then the row.
- **Clocks.** 15 minutes idle, 60 in all (`limits.ts`, Go `limits.go`, 0094's
  CHECK). Only input and Keep alive move the idle clock; reading or
  reconnecting never does; the hard limit is never extended. Every read,
  write and agent call settles first; `TERMINAL_SWEEP` (every 30 s) ends the
  rest; the worker enforces both from its own start and kills everything 90 s
  after losing the portal.
- **Ending.** The technician (`TERMINAL_CLOSED`), a Platform Admin or the
  business's own member with `computers:edit` (`TERMINAL_REVOKED`); never a
  fresh confirmation. A `remote` pause refuses new terminals and ends live
  ones (`paused`).
- **Transport.** Outbound only, independent of `MSA_GRANTS`: the heartbeat
  says `remotePoll` only to an authenticated signed agent that may act, the
  signed heartbeat starts `rem0te-agent.exe remote-worker` (no argument), and
  the worker long-polls `POST /remote/agent/poll` (20 s) and posts to
  `/remote/agent/terminal/output`, each with the device secret checked first.
  Nothing listens on the computer.
- **One exec site** (`internal/remote/spawn_windows.go`): System32's
  `cmd.exe /D` or `powershell.exe -NoLogo -NoProfile -NonInteractive -Command -`
  by absolute path, constant arguments, created suspended, in a Job Object
  with `KILL_ON_JOB_CLOSE` before it runs; ending terminates the job (the
  whole tree). The worker is told only the shell's name.
- **The record.** Audit rows carry ids, the shell, the reason, durations and
  byte counts, never input or output; nothing in `remote-ops/` or the worker
  logs content. Frames are deleted once delivered and with the session.
  Transcripts are opt-in per business (`RemoteOpsSetting`, a Platform Admin's,
  `REMOTE_OPS_SETTINGS_CHANGED`), 30 days by default.
- `TERMINAL_SWEEP=off` is exact, exported by `run-e2e.sh`, set by `e2e-ui.mjs`
  and in §84's `OFF_SWITCHES`. **Never set it in production.**

Publish the 0.77 agent before anyone relies on it; the server refuses older
agents. Behavioural proof: `e2e-terminal.mjs` (port 3975, `REMOTE_SIM`, the
worker's own code against `/bin/sh` — simulation, not Windows). Unit:
`unit-terminal.mjs` (in CI) and the Go `internal/remote` tests. Lab:
`TestLabTerminalAsAdministrator` / `TestLabTerminalAsSystem` (output,
`whoami`, the tree killed on end and on expiry). **It has run only on
Windows Server in the lab**, never on a desktop or the fleet.

§88 (0.78) is background file transfer (`docs/file-transfer.md`). **It
extends §87's reversal to files, at the owner's request**: the agent writes
and reads, as SYSTEM, a path a Platform Admin typed. It is the first time the
agent takes a path from the portal. Nothing else is relaxed, and it travels
over §87's worker and long-poll (no new exec site, no listener).

- **Who.** Two platform-only capabilities, `computers:files_upload` and
  `computers:files_download` (`PLATFORM_CAP`, never `CAP`), for the same
  reason as `computers:terminal`. Only the technician who asked moves bytes
  (`mine()`: their own transfer, in that direction).
- **Asking**, in order:
  1. scope with the direction's capability;
  2. `checkPath`, a reason (3–500), and for a send the size within the
     business's `fileMaxMb` (default 100, CHECK 1–2048) and the SHA-256;
  3. `assertFresh` naming `files.transfer` (default `off`);
  4. `fileRefusal`: the pool, Windows + `runsSignedAgent`, a device secret,
     agent ≥ 0.78.0, a `remote` pause, reporting, two live per computer;
  5. `FILE_TRANSFER_REQUESTED` with `logOrFail`, then the row.
- **The path rule** is one fixture, `internal/remote/testdata/file-paths.json`,
  asserted by Go's `CheckPath` and the portal's `checkPath`. It allows only a
  drive-letter absolute path with backslashes, and refuses UNC, device, `..`,
  streams, reserved names and trailing dots or spaces. 0095 refuses `..` and
  `/` too.
- **On the agent** (`files.go`, `fs_windows.go`):
  - only a fixed or removable drive;
  - a reparse point on any folder or the target is `reparse_point`, and no
    folder is ever created;
  - the target is an `O_EXCL` temporary file beside it, checked by handle
    (`GetFinalPathNameByHandle`);
  - the whole SHA-256 is checked before `MoveFileEx`, which gets
    `REPLACE_EXISTING` only when the transfer says overwrite;
  - a fetch is hashed, declared, re-read and refused if it changed.

  The file code runs no process and opens no socket. The worker logs ids,
  directions and codes only.
- **Bytes are temporary.**
  - Chunks are 512 KiB, each with its own SHA-256, at most eight waiting
    (0095 CHECKs).
  - Chunks are deleted as they are acknowledged and when a transfer ends, and
    a finished fetch's after 15 minutes.
  - Audit rows carry the path, size and SHA-256, never content.
  - Only `FileTransferService` writes the two tables.
- **Clocks.** 60 minutes in all (TS, Go, 0095), 10 minutes without progress,
  ended by every read and by `TERMINAL_SWEEP`. A `remote` pause ends live
  transfers. Cancelling (the technician; a Platform Admin or the business's
  own `computers:edit` revokes) never asks.

Publish the 0.78 agent before anyone relies on it; the server refuses older
agents. Behavioural proof: `e2e-files.mjs` (port 3977, `REMOTE_SIM` with
`-files-root`: a directory and symbolic links standing in for NTFS and
reparse points, not Windows). Unit: `unit-files.mjs` (in CI) and the Go
`internal/remote` file tests. Lab: `TestLabFilesAsAdministrator` and the
SYSTEM run inside `TestLabTerminalAsSystem` (send, exists then overwrite,
fetch with hashes, a junction and a UNC path refused). **It has run only on
Windows Server in the lab**, never on a desktop or the fleet.

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
