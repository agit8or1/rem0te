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
approve route, the canary gate requires *effective*, and updates cannot be
requested one computer at a time (`ACTION_NOT_DIRECT`). §14's agent-catalog
check now expects exactly the two actions. Its behavioural proof is
`apps/api/scripts/e2e-staged-patching.mjs` (same `RELEASE_BIN` / `ACTION_SIM`;
the sim takes `-wua` / `-registry` fixture files). An `ActionJob` is now one
signed plan with an `ActionTarget` row per computer; `endpointId` on the job is
only the first target, so per-computer state lives on the target.

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
`assertFresh`, after scope and validation and before the write. The step-up is
not configurable. Keys are immutable: there are list, create and revoke routes
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
computers have no key is refused (`RESULT_KEY_MISSING`). The agent signs every
final result in one place (`final()`), with the verifier's prefixes; the
result-status table (`RESULT_STATUS`) is shared by the portal and the signer.
Behavioural proof: `e2e-patch-policies.mjs` (five forged canary successes
refused); unit: `unit-patch-policy.mjs`, `unit-approval-signer.mjs`.

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

With §39 and §40, §14's exact, ordered catalog list is nine actions: the six
through 0.32, then `windows.script.run`, `windows.software.install` and
`windows.software.uninstall`. It is the same on the agent and in the portal,
with `scriptParamsOK` and `softwareParamsOK` among the closed forms and seven
`integration: false` entries.

§41 is AI without a provider key. There is no model-provider SDK, endpoint or
key variable anywhere in `apps/api/src` or `apps/api/package.json`
(`@anthropic-ai/sdk` is gone). The device AI summary goes only `timeline.service
→ timeline.client → signer.signedPost(peer, 'inference')`. The summary is sent
only when ClientSt0r's signed capabilities document lists `device_timeline_v1`,
after both capabilities and containment. It is audited before it leaves,
without text. The snapshot selects no name, hostname, address, business, site,
tag, author or RustDesk field, and every free-text field passes
`redactForPeer`. Behavioural proof: `e2e-ai-timeline.mjs`; unit:
`unit-ai-timeline.mjs`.

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
`run-e2e.sh` and `e2e-ui.mjs`. Behavioural proof: `e2e-agent-auto-update.mjs`
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
