# Changelog

All notable changes to Rem0te are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [0.40.0] — 2026-11-13 · *Straightedge*

**Direct mode: approved actions for a single operator.**

The owner runs the portal alone. Every approved action, patch ring, software deployment and script run needed
passkey approvals on the approval signer from people on its roster, and at least one approver who was not the
requester. One person can never satisfy that, so the catalog could not be used at all on a one-person install. The
owner chose **direct mode** over a single-operator passkey step: the signer signs the plan as soon as it is
requested, with no approvers, and everything else stays in place.

### Added
- **The setting lives on the approval signer, per business, with a `default`.** Only the signer's CLI sets it:
  `policy set --business <id|default> --approval direct|signed`. A missing value means `signed`. `policy show` prints
  it. Each change is appended to `policy-changes.log` in the signer's directory (0600) with before, after and who.
  The CLI prints a warning on stderr when direct is turned on. There is no HTTP route on the signer or the portal
  that writes it. The signer's `GET /internal/v1/policy/:id|default` is read-only, and the portal only mirrors it.
- **Direct mode and customer sign-off never hold together.** The CLI refuses `--approval direct` for a business
  that requires customer sign-off, and refuses turning customer sign-off on for a business that is direct. Each
  refusal exits 2 and says why: direct mode signs at the request, so nobody could sign off first. If someone hand-edits
  `policy.json` to hold both, `policyFor` reads it as `signed`.
- **Signing at admission.** When `policyFor(...)` says direct, a submitted plan is signed in the same request. It
  must carry `policy.approval: "direct"` and `approvalsRequired: 0`. Signing happens after every existing admission
  check (risk, window, catalog, allowlist, software revocations) and after the signed-pause check. There is no
  roster, no passkey and no approval page, and the job's approvers list is empty. The plan still names `requestedBy`.
  A plan's direct flag must match the signer's own policy, either way, or it is `policy_mismatch`. Signed-mode plans
  are byte-identical to before, because the field is absent.
- **The agent (new release).** When the signed plan says `"direct"`, the agent needs zero approvers and drops the
  requester and script-contributor same-person rules. With the field absent, nothing changes. Any other value, or
  direct together with customer sign-off, is `bad_plan`. Its risk computation, the signed pause, revocations,
  Precheck, journal order and session rules are untouched. **Agents older than 0.40 refuse a direct plan with
  `bad_plan`**, which fails closed. The UI says to upgrade the agent when that is the reason.
- **Patch policies and the script allowlist.** Under direct, a patch policy proposal becomes ACTIVE at admission,
  signed with no approvals and recorded `direct: true`. It is signed only after the pause and device-key pin checks,
  and its ring plans carry the direct flag. A direct-activated policy counts only while its business is direct
  (`policyQuorum(..., direct)`). Switch the business back to signed and its rings are refused with
  `policy_not_approved` until the policy is approved the strict way. A script allowlist proposal becomes ACTIVE at
  admission only when the signer's **`default`** policy is direct, because the allowlist is not per business. The
  script library then lets a version's author review it, recorded in `ScriptVersion.selfReviewed` (migration 0065).
- **The portal.** A direct request needs the capability **and a fresh sign-in** (`assertFresh`, `actions.direct`)
  on every request path: the computer's Approved actions card, a patch install on one computer, a patch or software
  ring, a single software install, a script run, and a script allowlist proposal. Rings requested under an active
  patch policy are exempt, because creating the policy already needed a fresh sign-in. ClientSt0r cannot make a
  direct request (`403 DIRECT_MODE_PORTAL_ONLY`). The Approved actions card and Patching setup show the mode. In
  direct mode the UI shows no "awaiting approval" and no approval-page link. It says *Approved automatically (direct
  mode) by <you>, <time>*. The no-signer text is unchanged.

### Why
A single person cannot be two people. A passkey step for one operator would add a ceremony without adding a second
check. Direct mode is honest about what it gives up: anyone who fully controls the portal session can run catalog
actions without a second person. What still protects a direct run: a fresh sign-in on every request, capabilities,
the audit log, containment pauses (portal and signed), revocation, maintenance windows and session rules, and the
agent verifying the signer's signature. The signer still runs every admission check, and only the signer's
operator, on the host, can turn it on.

### Decided
- ClientSt0r proposals are refused under direct, not signed on arrival. Direct mode is for the operator at the
  console.
- Plans signed in direct mode stay valid until their window closes after a business is switched back to signed.
  Cancel them in the UI if needed.
- Under direct the agent accepts a plan that does name approvers, such as a ring under a policy approved earlier.
- An approval page opened for a direct job answers `not_awaiting`.

### Upgrade notes
- **New agent release.** Publish the agent (`sudo rem0te-signed-publish`) before turning direct mode on. Older
  agents refuse direct plans with `bad_plan`.
- Migration 0065 (`selfReviewed`, with its CHECK and trigger). Deploy the signer's `dist` as well as the portal.
- To turn it on for every business without its own entry:
  `sudo -u rem0te-approver env APPROVAL_SIGNER_DIR=/var/lib/rem0te-approver node /opt/rem0te-approver/dist/approval-signer/main.js policy set --business default --approval direct`
- CLAUDE.md needs a §58 paragraph.

### Security invariants
§58 has 8 checks:
- the policy is written only by the CLI, and every change is logged;
- no HTTP route writes it;
- policyFor, the CLI, validatePlanAction and the store agree on the exact value and the sign-off exclusion;
- signing at admission comes only after admission and the pause;
- patch-policy activation and quorum;
- allowlist activation under `default`, and the library's one-question probe;
- the agent relaxes only on the signed field;
- every portal request path passes a fresh sign-in, and ClientSt0r is refused.

27 mutations, each removing or weakening one of those, were each caught, and the file was restored. §14, §15, §23,
§38, §39 and §40 were adjusted to the new call shapes.

### Verification
- `unit-approval-signer.mjs`: 252 checks (45 new). Covered: direct signs at admission with no approvers; signed
  mode is unchanged; a plan's flag that disagrees with the policy is refused; the CLI refuses direct with customer
  sign-off, both ways; direct patch policies and allowlist entries go ACTIVE; a direct policy stops counting once the
  business is signed; businesses A and B are isolated; and the signed pause still refuses.
- `e2e-approved-action.mjs`: 92 checks. The direct section covers:
  - no fresh sign-in → `STEP_UP_REQUIRED`, and nothing is written;
  - after a step-up → APPROVED with 0 approvals, and the signed plan names direct and the requester;
  - the 0.38 sim refuses it with `bad_plan`, and the new sim runs it → SUCCEEDED;
  - a forged direct plan → `bad_signature`;
  - ClientSt0r → `DIRECT_MODE_PORTAL_ONLY`;
  - the customer sign-off business is still AWAITING_APPROVAL;
  - the signer pause → `409`;
  - back to signed → two approvals.
- Go `internal/action`: 97 tests pass, 12 new. Covered: direct with no approvals; refused under a signed pause;
  refused when revoked; a non-direct plan with zero approvals is still `too_few_approvals`; an unknown mode and
  direct with sign-off are `bad_plan`; and the field cannot be added after signing.
- Unchanged, re-run: unit-patch-policy 163, unit-script-run 136, unit-software 146; e2e-patch-policies 98,
  e2e-script-run 81, e2e-software-deploy 156, e2e-staged-patching 94, e2e-containment 70 (the AUDIT_CHAIN_ALERT
  check runs only on an intact chain, and the shared scratch database's chain was already broken by earlier suites),
  e2e-maintenance-actions 64, e2e-revocation 44. All passed, 0 failed.
- Checks: security invariants, check-versions, `pnpm -r lint`, tsc in both apps, `nest build` and `next build` all
  pass. The docs bundle has 40 pages. No routes were added; GET `/actions/catalog` gained an `endpointId` query.

### Fixed

- **`rem0te-signed-status` printed the approval key digest twice.** In 0.39.0
  the line read `approval/keys.json c857758077bec857758077be61af…`: the
  short form followed by the full digest, because the `:-none` fallback
  expansion prints the value when it is set. It is now an `if`.

## [0.39.0] — 2026-11-13 · *Threshold*

### Added

- **Add device installs the full agent.** A new Windows computer used to get
  the standard agent and needed *Upgrade to full agent* afterwards. DEWEY-WKS2022
  was added at 05:01 and came up standard, even though a signed agent was
  published. The `.exe` link already served the signed agent (since 0.24), but
  the PowerShell line most people use (`irm …/install/win/<token> | iex`, a
  93 KB download in the log) always served the standard installer script.

  Now, for a valid, unclaimed, unexpired enrolment token and a published
  signed agent, that route serves `buildSignedInstallScript`. The script
  checks it is elevated, downloads `windows/rem0te-agent.exe` by its digest
  into a fresh directory locked to SYSTEM and Administrators, and checks the
  SHA-256. Only then does it run `rem0te-agent.exe install --portal <host>
  --token <token>`, which verifies everything else against signed metadata and
  claims the computer. It never calls `exit`, so the person's window keeps the
  output. Without a token nothing changes, because the heartbeat's reinstall of
  an existing standard agent carries none, and moving those is the
  migration's job, canary first. The Add device page's Windows text says what
  it installs.

- **`rem0te-signed-publish --approval-keys FILE`** signs the approval signer's
  public key list into the release as `approval/keys.json`. That is how agents
  learn to trust approved actions, and the 0.37 single-host commands had no way
  to do it. The list is kept in the release user's state directory only after
  the release carrying it is published, and later publishes sign it again. A
  file that isn't JSON, is over 64 KiB, or holds anything that looks like key
  material is refused before any build. `rem0te-signed-status` shows the
  published approval keys, or *none*.

### Fixed

- **The approval signer's systemd unit could not start under Node 22.** Its
  seccomp filter (`SystemCallFilter=@system-service`) doesn't include
  `pkey_alloc`, which Node 22's V8 calls at start-up for its JIT. Installed on
  this host for the first time, it died with `status=31/SYS` (kernel audit:
  `syscall=330`) and restarted in a loop. The unit now also allows
  `pkey_alloc pkey_free pkey_mprotect`. On an installed signer, copy the unit
  again and run `systemctl daemon-reload`.

### Upgrade notes

- No schema change. Deploy, then `sudo rem0te-signed-publish`.
- Approved actions still need the signer configured. Direct mode, so that a
  single operator needs no approver, is the next release.

### Verification

- `e2e-agent-upgrade.mjs` (107 checks, 7 new). Both the path and the query
  form with a valid token serve the full-agent script, pinned to the published
  digest and hash-checked before `install`, with nothing of the standard
  installer and no `exit`. Without a token it is still the standard installer.
  An unknown token and a claimed token don't get the script.
- `e2e-signed-release.mjs` (70 checks, 6 new). A file holding a private key is
  refused and nothing is published. `approval/keys.json` becomes a signed
  target with the file's digest, and the list is kept. `verify -mirror` accepts
  the release. Status shows it, and a later `--republish` signs it again.
- `check-security-invariants.mjs`: two new checks, the install script and its
  token gate (§43) and `--approval-keys` (§56). Each fails with its guard
  removed. The script parses under pwsh and refuses a bad host, digest or token.

## [0.38.0] — 2026-11-13 · *Doorstep*

### Added

- **Upgrade on the computer itself, from the computer's page.** The Agent
  card on a standard Windows agent has a new block: one line to paste into
  PowerShell run as administrator on that computer, with a copy button. It
  upgrades the computer to the full agent without the console having to reach
  it. Until now the only ways were *Upgrade to full agent* (delivered at the
  next check-in, which needs a working heartbeat), the automatic migration (the
  same), or the `rem0te-agent.exe migrate` command in `docs/update-signing.md`,
  which needs the agent file to hand. 0.37.1–0.37.2 showed why that was not
  enough. Their installer left every migrated computer with no heartbeat
  script, so nothing from the console could reach it, and recovering one meant
  finding a PowerShell line in a chat.

  The command is built by `buildLocalMigrationCommand(host, sha256)` from the
  signed agent the repository publishes now. It creates a fresh,
  randomly named directory locked to SYSTEM and Administrators, downloads the
  agent by its digest, and runs `migrate --portal <host>` only if the SHA-256
  matches. A mismatch is deleted and nothing runs. The agent then verifies the
  installer, RustDesk and the tray against signed metadata, as every migration
  does. It is `buildMigrationScript`'s check in one line, without that script's
  `exit`, which would close the person's PowerShell window and the output with
  it.

  The block opens by itself, with an amber note, when the computer fetched a
  migration and has not checked in since. That is the case the console cannot
  help with. Otherwise it is collapsed under *Upgrade on the computer itself*.
  It is offered in every portal mode, Signed only included, because nothing is
  served to the computer: a person runs it there. That is what Signed only
  already told people to do. It needs a published signed agent and a portal
  address. It is readable by anyone who can see the computer (`GET
  /endpoints/:id/agent`, `computers:view`), because it holds no secret: the
  host and a public digest.

### Fixed

- **The automatic migration's 0.37.3 canary was picked mid-upgrade.**
  DS-HOME1 was being upgraded by hand with `migrate` while still reporting the
  standard agent. The rollout picked it as the canary at 17:33:37, and the card
  briefly said *Waiting for the computer's next check-in*. Its next heartbeat
  (17:35:04, signed 0.37.3, `installer exit 0`) completed the request, and the
  canary was confirmed at 17:35:37, so nothing was wrong. The rollout counts a
  computer that finished the upgrade by any route. Recorded here because the
  card's wording looked like a failure for those two minutes.

### Upgrade notes

- No schema change. Deploy as usual and run `sudo rem0te-signed-publish`.

### Verification

- `unit-agent-migration.mjs` (65 checks, 8 new): the local command is one line
  with no `exit`, downloads by digest and checks it before `migrate`, deletes a
  mismatch, locks its directory before the download, and pins the portal. It
  refuses a host with a quote, an upper-case digest and a short digest, and
  parses under pwsh.
- `e2e-agent-upgrade.mjs` (100 checks, 6 new): no command without a published
  release; one pinned to the newly published digest, with no `exit`; still
  offered in Signed only; `stuck` false after a check-in that follows the
  fetch and true once the last check-in is before it; another business's owner
  gets a 404 and never the command.
- `check-security-invariants.mjs` §43: a new check that the local command
  validates host and digest and checks the hash before `migrate`, and that the
  card builds it from the served target. Removing the mismatch deletion fails it.
  The existing *MIGRATION_UNAVAILABLE runs nothing* check caught the function
  when it was first placed inside the slice it reads, and the function was
  moved.

## [0.37.3] — 2026-11-13 · *Keystone*

### Fixed

- **Every migration to the signed agent failed at step 1 and left the
  computer silent.** On real Windows, DS-HOME1 (the 0.37.1 canary) and
  DEWEY-WKS2022 (a manual *Upgrade to full agent*) both fetched their
  migration, and the signed agent downloaded and verified `install.ps1`,
  RustDesk and the tray. Then neither sent another heartbeat, while RustDesk
  still reached them (*agent silent*). DEWEY's `install.log` ended:

  ```
  [1/6] Preparing installer...
  Using the RustDesk build rem0te-agent verified against signed metadata: C:\ProgramData\Rem0te\setup\signed\rustdesk-1.5.3-x86_64.exe
  ERROR: The verified RustDesk build is missing: Cannot find path '...' because it does not exist.
  ```

  The agent stages its verified files in `C:\ProgramData\Rem0te\setup\signed`.
  The installer's start-up cleanup, which dates from 0.24 when nothing else
  lived there, ran `Remove-Item -Recurse` on `heartbeat.ps1` and on the whole
  of `setup`. It deleted the build it was about to install, and then failed
  before it rewrote `heartbeat.ps1`. The `Rem0teHeartbeat` task went on
  running a file that no longer existed, so the computer never reported again
  and the server had nothing to show why. 0.37.0 never got this far, because
  its script did not parse under PowerShell 5.1 (fixed in 0.37.1). The unit
  tests passed a staging path but never ran the cleanup against one.

  The cleanup now clears `setup`'s children except `signed`, and leaves
  `heartbeat.ps1` alone: it is overwritten later in the run, and until then it
  is what keeps the computer reporting. A link or foreign-owned item anywhere
  in the state directory is still removed first by the `$planted` sweep, so
  keeping `signed` keeps only what SYSTEM or Administrators wrote. This
  applies to both installer variants.

- **The signed agent could wait forever on a RustDesk process.**
  `winPlatform.RunInstaller` tees the installer's output to the agent log
  through `io.MultiWriter`, so `cmd.Run()` returns only once every holder of
  the pipe has exited. `install.ps1` runs `rustdesk.exe` directly, and a
  RustDesk process that stays up inherits the pipe. This was reproduced on
  Linux with a backgrounded grandchild; it was not what stopped these two
  machines. `agent.RunInstallerCmd` now sets `cmd.WaitDelay` (15 s) and keeps
  the script's own exit code on `exec.ErrWaitDelay`. The script runner
  (`action/scriptexec.go`) already had this guard.

### Upgrade notes

- Deploy, then publish so the fixed `install.ps1` and agent are signed:
  `sudo rem0te-signed-publish`.
- A computer that already failed has no heartbeat script, and the portal
  cannot reach it. After publishing, run the migration once on it, in an
  elevated PowerShell. The signed agent it downloaded is still there:
  `& (Get-ChildItem C:\ProgramData\Rem0te-migrate-*\rem0te-agent.exe | Select -First 1).FullName migrate --portal <portal host>`.
  It verifies and runs the newly published agent and installer, which keep the
  computer's identity (`heartbeat.dat` survives) and install the signed
  heartbeat. For the automatic migration's halted canary, **Resume** it on
  Devices → Full agent once it reports the signed agent.
  `docs/troubleshooting.md` has this.

### Verification

- `unit-signed-installer.mjs` (63 checks): both variants' cleanup removes
  neither `heartbeat.ps1` nor `setup` as a whole. The cleanup block, executed
  under pwsh against a state directory laid out as the agent leaves it, keeps
  `setup/signed` with its build and script, removes the other items under
  `setup`, and leaves `heartbeat.ps1`. Against 0.37.2's script, 5 of these fail.
- `go test ./internal/agent -run RunInstaller`: a descendant holding the pipe
  for 120 s no longer holds the agent; exit 7 is kept with and without one;
  a missing binary is exit 1 with an error. `go vet` is clean for linux and
  windows, and `go test ./...` passes.
- `check-security-invariants.mjs` §57: two new checks (the cleanup, and the
  bounded installer wait), each shown to fail with its guard removed.
- Not yet proven on real Windows: that is the next migration after publishing.

## [0.37.2] — 2026-11-13 · *Keystone*

### Fixed

- **Remote Support drew every listed computer as green "Online".** The
  *Online Enrolled Clients* section on `/sessions` lists `GET
  /endpoints/connected`, which is every active computer with `isOnline` set,
  and `isOnline` is also true when the RustDesk server can reach a machine
  whose agent has stopped checking in (0.35's "reachable is not reporting").
  The page hard-coded a green dot, a green border and the title "Online" on
  every card, so a computer whose agent had been silent for two weeks looked
  exactly like a healthy one. Its "Last seen" line made it worse, because it
  preferred the RustDesk node's timestamp to the agent's check-in. The cards now
  take their status from `deviceStatus()`, the same function the device list,
  the device page and the map use: green for *Online*, amber with
  "Reachable (RustDesk) · agent silent …" for a silent agent. The line under
  each card is now "Agent last checked in …", from the agent's own heartbeat.
  The heading is *Reachable Enrolled Clients*, with separate online and
  agent-silent counts. Connect is unchanged: a reachable computer can still be
  remote-controlled, which is why these computers stay on the list.

### Verification

- `e2e-ui.mjs` checks that Remote Support draws the twelve-day-silent fixture
  with an amber dot (`data-status="degraded"`), "agent silent 12 d" and "Agent
  last checked in 12d ago", and counts it apart from online computers.

## [0.37.1] — 2026-11-13 · *Keystone*

This release fixes three bugs that only appeared the first time `rem0te-signed-setup.sh` ran for real as root, on the
production host. Every test had run setup under `--prefix --no-user --no-systemd` as one ordinary user, where
none of them can happen.

### Fixed
- **Setup died at the first key with `env: '/usr/local/lib/rem0te-release/rem0te-release': Permission denied`.**
  - **Cause:** `lib.sh` sets `umask 027`. So the directories root creates for the configuration
    (`/etc/rem0te-release`) and the installed tool (`/usr/local/lib/rem0te-release`) came out `0750 root:root`. The
    release user then could not reach the tool to run `keygen`. Setup stopped before any key was written, so a re-run
    was safe.
  - **Fix:** setup now makes both directories `0755`. Neither holds a secret; the keys stay under `KEY_DIR` (`0700`,
    the release user's).
- **The daily timestamp refresh could never run:** `rem0te-timestamp-refresh.service` failed with `226/NAMESPACE`,
  "Failed to set up mount namespacing: /var/tmp/rem0te-release-build: No such file or directory".
  - **Cause:** `PrivateTmp=true` gives the unit an empty `/var/tmp`, so the `ReadWritePaths=` entry for the build
    root under `/var/tmp` has nothing to mount.
  - **Symptom:** the timer would have failed every day. After 7 days the timestamp expires and every signed agent
    refuses updates.
  - **Fix:** the unit now sets `PrivateTmp=false`. `ProtectSystem=strict` still leaves only the release user's own
    directories writable.
- **The signed installer could never run on Windows.** The first real migration, on DS-HOME1 at 03:24 UTC, reported
  `installer exit 1` about 11 seconds after it downloaded the migration script. Nothing on the computer had changed:
  it stayed on its working standard agent.
  - **Cause:** the agent runs `install.ps1` with `powershell.exe -File`. Windows PowerShell 5.1 reads a script without
    a byte-order mark as the ANSI code page (Windows-1252), not UTF-8. The installer's em dashes are `E2 80 94`, and
    the last byte, 0x94, decodes as `”` (U+201D), which PowerShell treats as a closing quote. Read that way the file
    has five parse errors, so PowerShell exits 1 before running a line.
  - **Why nothing caught it:** every test parsed and ran the script with PowerShell 7, which reads UTF-8 with or
    without a BOM. The legacy path (`irm … | iex`) never had the problem, because it decodes the HTTP response as
    text.
  - **Fix:** `build-signed-installer.mjs` writes a UTF-8 BOM first. The BOM is part of the signed bytes and of the
    digest in the targets metadata. The agent likewise writes an approved library script's `script.ps1` with a BOM,
    after its hash has been checked on the approved bytes. Those scripts may hold non-ASCII text and run through the
    same `-File` path. The wrapper, `wua.ps1` and the heartbeat already reached PowerShell safely: they are ASCII, or
    are written by Windows PowerShell's `Set-Content -Encoding UTF8`, which adds a BOM.
  - **Test:** `unit-signed-installer.mjs` builds `install.ps1` and parses it the way 5.1 reads it: UTF-8 after a BOM,
    Windows-1252 without one. It also checks that the same file with its BOM removed fails, so the test can fail.
- §56 now checks all three fixes: `PrivateTmp=false` and the `ReadWritePaths` line in the unit, the `chmod 0755` in
  setup, and the BOM in the installer build and in `script.go`, plus the 5.1 parse test. Removing any of them makes
  a check fail.

### Upgrade notes
- **Hosts already set up with 0.37.0,** where a hand fix let setup finish: the next
  `sudo ./deploy/release/rem0te-signed-setup.sh` reinstalls the unit and changes no key. On this host the installed
  unit was fixed by hand on 2026-11-13, and `systemctl start rem0te-timestamp-refresh.service` succeeded.
- **After deploying, run `sudo rem0te-signed-publish`.** This publishes 0.37.1, the first signed installer that
  Windows PowerShell 5.1 can parse. The 0.37.0 rollout's canary can't succeed: its installer exits 1. A new published
  build starts a new rollout.
- No migration and no npm dependency change.

### Verification
- On production, setup completed after the directory fix: six keys, the repository, the timer, `UPDATE_REPO_DIR`,
  and the first publish of 0.37.0.
- `rem0te-release verify -mirror http://127.0.0.1:3001/api/v1/public/updates` verified the portal-served
  repository: 4 targets, root v1, targets v2.
- With the unit fixed, the refresh service ran once and exited `success`, publishing timestamp v3.
- Reproduced with PowerShell's own parser on the published 0.37.0 `install.ps1`: 0 errors read as UTF-8, 5 read as
  Windows-1252 (the first at line 1269).
- `unit-signed-installer` passes 56 checks (4 new). `go test ./...` passes, with `script_test` updated for the BOM,
  and `GOOS=windows go vet` passes.
- §56 holds with the new checks. `check-versions.mjs` passes.

## [0.37.0] — 2026-11-13 · *Keystone*

The seventh increment of the RMM overhaul. Its theme is the owner's request: an **easy** way to put agents on the
fully managed (signed) agent, set up on this host, shown in the console, with nothing going to GitHub, and with moving
the computers automated. Until now every signed feature since 0.24 was inert in production, because nobody had done
the four manual stages on an offline machine that `docs/update-signing.md` described. Two parts were built separately
from 0.36.2 and integrated here:

- **Signed releases on one host** (`deploy/release/`). `sudo ./deploy/release/rem0te-signed-setup.sh` once creates a
  `rem0te-release` user that holds the keys where the portal can't read them, the repository and a daily timestamp
  timer, and publishes the first release. `sudo rem0te-signed-publish` after every deploy builds the agent, tray and
  installer from a `git archive` of committed HEAD, signs, verifies and publishes atomically. The owner's root is
  written only into the build copy and never committed. **Trade-off, stated plainly: root on this host can sign**;
  export the root keys with `sudo rem0te-signed-export-root <dir>`.
- **Automatic migration and Devices → Full agent.** Once a signed agent is published, the portal moves standard
  Windows agents to it by itself, one canary first, the rest only after the canary reported the published build
  through a soak, paced and held exactly like a person's per-computer migration. **On by default.** The Full agent
  page shows the four steps live, with the command for each one that isn't done.

One migration (`0064_auto_migration`). No production dependency changed. **Nothing in this release has run on real
Windows**, and the setup script's real root path (`useradd`, `runuser`, ownership, systemd) has not been run: the
tests ran it under `--prefix` as a normal user. See *Upgrade notes (all of 0.37)*.

### Signed releases on one host

The owner asked for an easy way to put agents on the fully managed (signed) agent, set up on this host, with nothing
going to GitHub. Until now the docs described four manual stages on an offline release machine: generate six keys,
initialise a repository, copy `1.root.json` into `trustroot/root.json` and **commit it**, build three files, download
and check a RustDesk build, sign, verify and rsync. They also said to keep the timestamp fresh every three days by
hand. Nobody had done it, so production has no signed repository, and every signed feature since 0.24 is inert there.
The committing step was also a problem in itself: the owner's root would have reached GitHub on the next push.

#### Added
- **`sudo ./deploy/release/rem0te-signed-setup.sh`**, run once from the source checkout. It:
  - creates the system user `rem0te-release` (no login shell), `/var/lib/rem0te-release` (0700: `keys/`, the signing
    repository, a RustDesk cache, `publish.log`) and the published repository `/var/lib/rem0te-updates` (owner
    `rem0te-release`, group `reboot`, 2750/0640, setgid so new files take the portal's group);
  - builds `rem0te-release` from `git archive HEAD` and installs the commands below;
  - as `rem0te-release` under umask 077, generates three root keys (threshold 2) and the targets, snapshot and
    timestamp keys, and runs `init`. It prints key ids only;
  - checks that the `reboot` user can't read a key;
  - installs `rem0te-timestamp-refresh.timer`;
  - prints the `UPDATE_REPO_DIR=/var/lib/rem0te-updates` line, or adds it to `/etc/reboot-remote/api.env` with
    `--apply-env`;
  - runs the first publish.

  Running it again changes no key and doesn't re-initialise. A half-present key set, or a repository with no keys,
  is refused. A configuration that names a different state or published directory is refused. Every path can be
  overridden (`--prefix`, `--no-user`, `--no-systemd`, `--no-publish` and one flag per directory), which is how the
  test runs it as an ordinary user in a temp directory.
- **`sudo rem0te-signed-publish`**, for each release and as the last step of every deploy:
  - unpacks `git archive HEAD` into a new build directory owned by `rem0te-release`. It never uses the working tree;
  - writes the owner's root into **that copy's** `trustroot/root.json`;
  - builds `rem0te-agent.exe` and `rem0te-tray.exe` (windows/amd64, `-trimpath`, `CGO_ENABLED=0`, tray
    `-H=windowsgui`) and the release tool, and checks that the agent embeds the root;
  - builds `install.ps1`;
  - fetches the RustDesk build the portal pins (`PlatformSettings.rustdeskPinnedVersion`, read with one SELECT
    through `psql` from the portal's env file), or the latest release when none is pinned. It checks the build
    against GitHub's published SHA-256 and caches it;
  - signs a copy of the repository with `{"version","commit"}` on the agent and tray targets, which is what the portal
    half of 0.37 reads, and verifies it with the agents' client;
  - publishes.

  Every step is logged to `/var/lib/rem0te-release/publish.log`.
- **Atomic publishing.** The repository goes to a staging directory beside the published one and is verified there
  with `rem0te-release verify`. It is then moved in by renames only: new targets and versioned metadata first, then
  `root.json`, then `timestamp.json`, the commit point. Consistent snapshots mean nothing the current timestamp points
  at is touched, so an agent sees the previous release whole until that last rename, and the new one whole after it.
  - A staging copy that fails verification is deleted, and the published repository is byte-identical afterwards.
  - A versioned file that already exists with different bytes stops the move before anything is moved.
  - Target files that the two newest targets versions no longer list are then removed.
- **Refusals.** `rem0te-signed-publish` refuses:
  - a version older than the published one;
  - the same version from a different commit;
  - a RustDesk build with no published digest, or one that doesn't match it;
  - a checkout whose `trustroot/root.json`, in the working tree or in HEAD, is not `{}`.

  The same version and commit again is a no-op unless `--republish`, which adds a newly pinned RustDesk build without
  a version bump.
- **`sudo rem0te-signed-status`**: one screen showing:
  - which keys are present, and whether the root keys are on the host or exported;
  - the published agent (version and commit), tray, installer and RustDesk builds;
  - every role's expiry;
  - the last publish, the timer, and whether `api.env` has `UPDATE_REPO_DIR`.

  It exits 1 when something needs attention.
- **`sudo rem0te-signed-export-root DIR`** (or `DIR1 DIR2 DIR3`, one key each). It copies the three root keys off the
  host, checks each copy byte for byte, and deletes them from the host only after you type `yes`. It refuses a
  destination inside the checkout, any git work tree, the state directory or the published repository.
- **`rem0te-timestamp-refresh.timer`**, daily, runs `rem0te-signed-refresh` as `rem0te-release` with no outbound
  network and `/etc/reboot-remote` inaccessible. It re-signs the timestamp and publishes it through the same staged
  path, so `timestamp.json` is the only file that changes. It also re-signs the snapshot when it has under 10 days
  left, and unchanged targets when they have under 14 days left.
- **`build-signed-installer.mjs --from-source --typescript DIR --out FILE|-`.** It transpiles
  `src/public/windows-script.ts` on its own, so a `git archive` copy with no `node_modules` and no `dist` can build
  `install.ps1`. It refuses if that file ever imports a module. The output is byte-identical to the `dist` build;
  the e2e suite compares the two.
- **Docs.** `docs/update-signing.md` opens with *The easy way (single host, 0.37)*, covering:
  - the commands and what each does;
  - the trade-off, stated plainly;
  - the export recommendation.

  The offline-machine method is kept as *The stricter way*, and its step 3 now says to put the root in the build copy
  only, never commit it. `docs/patching-setup.md` step 1, the key table, `architecture.md`, `security-model.md`,
  `rmm-gap-analysis.md` and CLAUDE.md (§56, the deploy step, a bite-list line) are updated to match. A `.gitignore`
  block covers in-tree release artefacts.

#### Decided
- **The keys live on the portal host, under a user the portal can't read.** This is the same compromise the docs
  already accept for the approval signer as a separate local user.
  - A compromise of the portal *application* can't sign: its code (as `reboot`), its database or its sessions.
  - **Root on the host can sign.** The docs say so in those words, and recommend `rem0te-signed-export-root` right
    after setup. With the root keys off the host, root can still sign releases but can't rewrite the root, so the
    owner can rotate the targets, snapshot and timestamp keys away afterwards without reinstalling every agent.
- **The checkout's JavaScript runs as the checkout's owner, never as the key holder.** The `install.ps1` step uses
  TypeScript from the checkout's `node_modules`. Running it as `rem0te-release` would hand those packages the keys,
  and the owner of the checkout already controls the source being signed, so running it as them gives nothing away.
  The Go builds run as `rem0te-release`. They execute no repository code: `CGO_ENABLED=0`, `-mod=readonly`, and
  modules checked against `go.sum`.
- **Root of trust in the build: `1.root.json`, as before.** Agents walk forward through any rotation from the root
  they ship with.
- **The RustDesk build follows the portal's own rule**, the pin or else the latest release, so the signed build is
  the one the portal offers. Builds already signed stay listed.
- **No change to the Go release tool.** Its existing flags were enough, and every command stays compatible.
- **The published path stays `/var/lib/rem0te-updates`, swapped file by file**, not through a `current` symlink.
  The interface fixes `UPDATE_REPO_DIR=/var/lib/rem0te-updates`, and TUF's consistent snapshots make the timestamp
  rename the atomic point.

#### Upgrade notes
- Nothing changes until you run `sudo ./deploy/release/rem0te-signed-setup.sh --apply-env` on the host and restart
  the API. Then `sudo rem0te-signed-export-root /media/<stick>`, and from then on `sudo rem0te-signed-publish` after
  every deploy. Publish builds **committed** HEAD, so commit and bump before deploying.
- Setup needs Go: `/usr/local/go/bin/go` is enough. When it is older than `go.mod` asks for, setup uses
  `GOTOOLCHAIN=go1.27.4`, downloaded once into `/var/lib/rem0te-release/go`. It also needs `pnpm install` in the
  checkout (for TypeScript), plus `git`, `curl`, `flock` and, for the pin, `psql`.
- After pulling a new rem0te, run setup again to update the installed commands. It changes no key.
- Don't commit `tools/windows-installer/trustroot/root.json`. §56 fails CI if you do.
- **Not run as root on a real host.** The `useradd`, `runuser`, `chown`, `chgrp reboot` and systemd paths have not
  been exercised; the suite runs everything as the current user (`--no-user --no-systemd`). Run setup on the host
  for the first time with someone watching, and check `sudo rem0te-signed-status` afterwards.

#### Verification
- `apps/api/scripts/e2e-signed-release.mjs`: **64 checks**, passing. It runs setup, publish, refresh, status and
  export-root in a temp prefix as the current user, with a scratch API on 3901 and a loopback stand-in for GitHub's
  RustDesk releases on 3902. It covers:
  - key and directory modes, the env line, and no key material printed;
  - a second setup changing nothing, and a half key set refused;
  - the Agent card refusing NO_SIGNED_RELEASE before the first publish and offering the upgrade after it, with
    another business still a 404;
  - `verify -mirror` accepting what the API serves, `/admin/update-trust` listing `{version, commit}`, and the
    served agent embedding the root while the git tree stays clean;
  - the pinned RustDesk build read from the database, and the latest release when unpinned;
  - `install.ps1` from the archive equal to the one from `dist`;
  - eight refusals, each leaving the published tree byte-identical: no-op, downgrade, same version from another
    commit, dirty working-tree root, committed root, bad digest, no digest and corrupted staging;
  - refresh changing only `timestamp.json`;
  - export-root: refused inside the checkout, "no" keeping the keys, "yes" making byte-identical 0600 copies and
    removing the keys, status reporting the export, setup after export, and publishing without root keys.

  Added to `scripts/run-e2e.sh`, skipped without Go.
- `apps/api/scripts/unit-signed-release.mjs`: **22 checks**, in CI. It covers RustDesk URL and digest rules,
  charset-checked metadata, prune-list, portal-pin and `ver_lt`.
- `scripts/check-security-invariants.mjs` **§56**: 16 checks. **23 mutations** were applied, one guard removed at a
  time, and each was caught by the check it targets.

### Moving computers to the signed agent automatically, and the Full agent page

The owner asked for an easy way to move agents to the fully managed (signed) agent, one that is shown in the UI, and
for step 4 (moving the computers) to be automated. Until now each computer moved only when someone pressed **Upgrade
to signed agent** on it, or selected a batch on All devices: one request each, with a reason and a fresh sign-in. The
steps before that (keys, a repository, a published build, a fresh timestamp) were described only in
`docs/update-signing.md`. Nothing in the console said which of them were done.

#### Added
- **Automatic migration, canary first.** Once a signed agent is published (the signed repository lists
  `windows/rem0te-agent.exe`) and the portal is not in Signed only, a sweep moves standard Windows agents to it.
  There is one rollout per published build (`AgentAutoMigration`, keyed by the build's digest):
  - **One canary.** The sweep picks one eligible computer that is checking in now, the most recently heard from. It
    makes an ordinary 0.34 per-computer request for it (`AgentMigrationService.requestAutomatic`): the same
    `AgentMigration` row, nonce, `windows.ps1?updateNonce=` script and heartbeat hand-out. The row is marked
    `automatic`, has no requester, and names its rollout.
  - **Confirmed only on the published build.** The canary must report the signed channel *and* the published digest
    within **2 hours** of being asked (the same limit as a request's *Not confirmed*). The rollout **halts**, with
    the reason kept, on any of these:
    - a failed update result (`installer exit` other than 0, `installer failed:`, `metadata-refused:`; a signed pause
      doesn't count);
    - a person cancelling the canary's request;
    - the canary being archived or removed;
    - no confirmation within the 2 hours.

    The halt stops the canary's automatic request, so a failing migration isn't re-run every 30 minutes.
  - **A soak.** The canary must keep reporting that build for the soak (default **60 minutes**, 15–1440) with no
    failed update result, and check in once more after the soak ends. Otherwise the rollout halts: it left the build,
    it failed, or it was silent for 2 hours after the soak. Nothing else moves during the soak.
  - **Then the rest, paced.** The pace is 0.36's automatic-update number (`agentAutoUpdatePerHour`, default 120)
    counted over automatic requests in the last hour, the canary included, and at most 50 in one pass. Each computer
    goes through the same precondition function as a person's request (`migrationBlock`), run again at the moment of
    writing. It is skipped:
    - under an `updates` pause;
    - while a staged rollout owns it;
    - while its update policy's agent mode is *Off* (business, site or device group; in *Window* mode, outside the
      window): 0.36's opt-out, reused;
    - while it isn't checking in;
    - if a person ever cancelled a move for it.
  - **A new build** starts a new rollout and canary for the computers still on the standard agent. Signed agents are
    never migrated again: they update themselves (0.36).
  - **Halted stays halted** until a Platform Admin acts, with a fresh sign-in:
    - **Resume** asks the same canary again, with its clocks from now. If it already reports the build, it soaks again.
    - **Restart with another canary** picks another computer and never picks the old one again for that build.

    Neither skips the canary.
- **A platform setting**, `off` / `canary_then_all` (default `canary_then_all`), and the soak. Platform Admin only.
  Turning it on or shortening the soak needs a fresh sign-in; turning it off or lengthening the soak doesn't. Changes
  are audited with before and after (`AGENT_AUTO_MIGRATION_SETTINGS_CHANGED`). The rollout's steps are audited as the
  system:
  - `AGENT_AUTO_MIGRATION_CANARY_CHOSEN`
  - `…_CANARY_CONFIRMED`
  - `…_ROLLING`
  - `…_HALTED`
  - `…_RESUMED` and `…_RESTARTED`, which carry the admin.

  The per-computer requests are history rows, not audit entries, like 0.36's attempts. `AUTO_MIGRATION_SWEEP=off`
  stops the sweep in one API process; `AUTO_MIGRATION_SWEEP_SECONDS` (default 60) sets how often it runs.
- **Devices → Full agent** (`/endpoints/full-agent`, for anyone with View computers). The whole process as a vertical
  step tracker read live from the server, each step with what to do when it isn't done:
  1. **Signing set up on this server.** Done when a repository is configured. Otherwise the page shows
     `sudo ./deploy/release/rem0te-signed-setup.sh`, one line on what it does, and a link to *The easy way*.
  2. **A signed agent is published.** The published agent's version and commit (the signed target's custom fields)
     against this portal's version. When it is behind: `sudo rem0te-signed-publish`.
  3. **Timestamp kept fresh.** The served timestamp's expiry, with a warning under 48 hours, `sudo
     rem0te-signed-status`, and the timer's name, `rem0te-timestamp-refresh.timer`. The page says the portal can't
     see the timer and infers only from the expiry.
  4. **Computers moved.** How many of the computers you can see are:
     - standard, moving or signed (and how many are on the published build);
     - held, with reasons: paused, rollout, opted out, outside window, not checking in, no device secret, archived,
       cancelled by a person;
     - not eligible (Linux, macOS).

     Then the automatic migration's mode and state: which computer is the canary, when the soak ends, the halt reason,
     and fleet progress for Platform Admins. Platform Admins also get *Turn on/off*, the soak, *Resume* and *Restart
     with another canary*. A link leads to the existing bulk **Upgrade to signed…**, and a list links to each computer.

  The page also says plainly that the signed agent and the tray haven't run on real Windows, and that the canary is
  the first time. It is mobile-friendly: lists, not tables. Linked from each computer's Agent card, from Settings →
  Security → Update Signing, and from the Settings page.
- **API.** `GET /agent-signing/overview` needs `computers:view`. Its counts and list come only from
  `acl.endpointVisibilityWhere`; the canary is named only to someone who can see it, and fleet progress goes only to
  Platform Admins. `GET`/`PUT /admin/agent-auto-migration` and `POST …/resume` and `POST …/restart` are Platform
  Admin (`PlatformAdminGuard`, then the service checks again).
- **Migration `0064_auto_migration`:**
  - `PlatformSettings.agentAutoMigrationMode` / `agentAutoMigrationSoakMinutes`, with a CHECK on the mode and 15–1440;
  - `AgentMigration.automatic` / `rolloutId`, with a CHECK: an automatic row has no requester and a rollout, a
    person's has no rollout;
  - the `AgentAutoMigration` table, with CHECKs: a 64-hex digest, five states, `rolling` only with
    `canaryConfirmedAt`, and `halted` only with a reason;
  - seven `ActivityAction` values.

#### Changed
- **"No signed release is published …" now points to the page and the command**, not to the offline-keys text. The
  reason no longer says "needs the offline signing keys only you hold". The fix gives the setup command, or `sudo
  rem0te-signed-publish` when the repository exists but has no agent, and the link is **Devices → Full agent**
  (`FULL_AGENT`), not *Roles and keys*. The Agent card, bulk Upgrade, the Patches tab pre-flight and patch-policy
  pre-flight all show it.
- **The Patches tab's "Upgrade it" now links to Full agent too**, besides *Open the Agent card*. The patch-policy
  pre-flight's fixes name `sudo rem0te-signed-publish` and the automatic migration.
- **The Agent card** links to Full agent in its header. Where *Upgrade to full agent* is offered, it says the
  automatic migration can move the computer instead.
- `AgentAutoUpdateService.modeFor` is now `modesFor` for many computers at once: one policy read and one membership
  snapshot per business. `modeFor` calls it, so the 0.36 behaviour is unchanged.
- `migrationState` says *Stopped by the automatic migration: its rollout halted.* for an automatic request the
  system stopped.

#### Decided (for the owner)
- **Opt-out reuses 0.36's agent mode, with no new column.** A policy with agent mode *Off* opts its computers out of
  automatic updates *and* automatic migration. *Window* holds both to the window. The alternative was a separate
  switch per policy. One switch means "the portal changes nothing on these computers by itself", which is what a
  business that opts out wants. A person can still press *Upgrade*.
- **Resume never skips the canary.** It asks the same computer again with fresh clocks. There is no "move the rest
  without a confirmed canary" button: nothing has run on real Windows, and the canary is the only evidence.
- **The canary must be checking in.** Picking one that isn't would only run out the 2-hour clock and halt.
- **The pace shares 0.36's number but not its count.** Automatic migrations are counted against
  `agentAutoUpdatePerHour` separately from automatic update attempts, so at worst twice that many installer runs
  start in an hour. Combining the two counts would have meant changing 0.36's locked counter (§53).
- **A person's cancel is final for automation.** A computer whose move someone cancelled is never asked
  automatically. Pressing *Upgrade* still works.
- **One rollout per build**, so every new published build gets a new canary for the computers still standard.

#### Upgrade notes
- **On by default.** As soon as the portal sees a published signed agent (not in Signed only), the canary is asked
  within a minute. With the 0.37 setup that is a minute after the API restart that follows setup, because setup
  publishes before the API has `UPDATE_REPO_DIR`. To prevent that, turn it off on Devices → Full agent *before* that
  restart (no fresh sign-in needed), or set `AUTO_MIGRATION_SWEEP=off` in `/etc/reboot-remote/api.env`.
- Migration 0064 (schema change): `prisma migrate deploy`, then rsync `prisma/` and run `prisma generate` at the
  target, as CLAUDE.md says.
- No production dependency changed.

#### Verification
- `unit-auto-migration.mjs` (new, in CI): **80 passed, 0 failed**. It covers:
  - settings, bounds and the exact off switch;
  - what widens;
  - which update results are failures;
  - every gate reason;
  - the state machine: confirm only on the exact build; halts on failure, cancel, missing computer and timeout (strictly
    over 2 h); the soak and the check-in after it; a soak never moves on early; canary and soaking only ever wait,
    confirm, start rolling or halt;
  - canary order, the pace budget and the hold mapping;
  - the new precondition messages and links;
  - the automatic-stopped state text.
- `e2e-auto-migration.mjs` (new; ports 3911/3912; a throwaway repository built with `rem0te-release`, with
  version/commit custom fields; its own API from `dist` sweeping every second): **73 passed, 0 failed**. It covers:
  - steps 1–3 with the commands verbatim, and the timestamp step claiming nothing about the timer;
  - nothing happens before a publish, in Signed only (with and without portal migration) or with the mode off;
  - settings: owner refused; off without step-up; on and a shorter soak need it; a soak under 15 refused; three
    changes audited before/after;
  - the canary: the newest eligible computer, never a contained, business-opted-out, group-opted-out,
    rollout-owned, person-cancelled, unbound or offline one. It gets one automatic request with no requester, one
    `CANARY_CHOSEN` audit row and no `AGENT_MIGRATION_REQUESTED`. Only its heartbeat gets the nonce, which serves the
    script pinned to the published digest, and the trust mode is untouched;
  - the soak gate: another build doesn't confirm; nobody moves during the soak; after it, the canary must check in
    first;
  - pacing at 3 an hour, mode off mid-rollout, and resuming;
  - A/B isolation of the overview (11 vs 2 computers, the canary hidden from B, progress only for the admin);
  - a new build: a new canary, signed agents untouched;
  - halts on a failed result and on a timeout; resume and restart refused without step-up and for an owner; restart
    picks another canary;
  - `AUTO_MIGRATION_SWEEP=off` on a second API does nothing and the page says so.

  The database is refused if any other standard Windows computer is checking in.
- Existing suites run again: `e2e-agent-upgrade.mjs` 94 passed (two assertions now expect the Full agent link),
  `e2e-agent-auto-update.mjs` 96 passed (the `modesFor` refactor), `unit-agent-migration.mjs` 44 passed (two
  assertions updated), `unit-agent-auto-update.mjs` 78 passed.
- `check-security-invariants.mjs` §57 (new, 10 checks). Each was proved to fail when its guard is removed (17
  mutations, all caught), then restored. All invariants hold.
- `gen-api-reference.mjs --check` against the runtime route table: 506 routes, matching. `nest build`, `next build`,
  `tsc --noEmit` in both apps and `pnpm -r lint` are clean, and `check-versions.mjs` passes.
- Browser: `e2e-ui.mjs` (948 passed, 0 failed, palette skipped) gains the Full agent page at 1440 and 375 px in light and dark, reached from the Agent card's
  link. It checks the four steps, the setup command, the timer honesty, *sweep off* with the admin's controls, the
  honest note, the current Devices tab, no sideways scroll, and no console errors. `e2e-navigation.mjs` gains the
  Devices tab for each persona, the page's four steps, and who is offered the controls. It needs the docs stack on
  port 4000 and was not run here (`node --check` only).

### Upgrade to full agent, at the top of the computer's page

The owner, after trying it: "there should be an upgrade client button/feature when you click on the client", and then
"I see update agent, but no UPGRADE agent". Until now the agent's actions lived only on the Overview tab's Agent card,
and with no signed release published that card showed **no button at all** for the upgrade, only a line of text
("Upgrade to signed agent is not available: …"). On this host, where nothing is published yet, nobody would ever see
an upgrade control.

#### Added
- **The agent's buttons in the computer page's header**, beside Connect, for anyone with *computers:edit*. On a
  standard Windows agent, **Upgrade to full agent** is its own button, separate from **Update agent**, and it is
  **always shown**: enabled when the server offers the move, otherwise a real disabled button with the reason beside
  it (and as its tooltip), what to do, and a link to **Devices → Full agent**. While a request is open it reads
  *Upgrade requested — waiting for check-in* and cannot be pressed again. A signed agent shows **Full agent** (and
  *Check for update now*) and no upgrade; Linux and macOS show *Copy update command* and the command itself. A Business
  User with only *computers:view* is offered none of it in the header.
- **The Agent card's upgrade is always a button too**: the same disabled-with-reason state, or for someone without
  *computers:edit* a disabled button that says so. A signed agent's card has a *Full agent* row.
- **"Agent out of date" opens it.** The attention chip opens the Upgrade to full agent dialog when that is offered,
  otherwise Update agent's confirmation, otherwise the Overview tab at the Agent card.

#### Changed
- **One set of mutations and dialogs.** `components/endpoints/workspace/agent-actions.tsx` holds the read
  (`['endpoint-agent', id]`), the three mutations (update, migrate, cancel), the confirmation and reason dialogs and
  the disabled-state logic (`upgradeView`); the card and the header each use it. The step-up (the api-client's
  `STEP_UP_REQUIRED` interceptor), the reason, the audit entry, the toasts and the refusals are therefore identical
  wherever the button is pressed, and because both read and invalidate the same keys, a request made in the header
  shows on the card at once and the other way round.
- **"Upgrade to full agent" everywhere** a person reads it: the header, the card, the dialog (*Upgrade to full
  agent?*, whose body says the full agent is the signed agent), the bulk bar on All devices (*Upgrade to full
  agent…*) and its result dialog, the Full agent page, Update signing, `/help`, and the API's own fix texts (the
  Patches tab's "press Upgrade to full agent", the automatic migration's *mode off* reason). The docs that named the
  button (`update-signing.md` *Moving existing agents*, `technician-guide.md`, `patching-setup.md`, `capabilities.md`,
  `updates.md`, `rmm-gap-analysis.md`) say the same and mention the header. Test ids are unchanged (`agent-migrate`,
  `agent-migration-blocked`); the header's are `header-upgrade-full-agent`, `header-update-agent`,
  `header-upgrade-reason`, `header-full-agent`, `header-agent-command`.

#### Decided
- **Two buttons, not one menu.** The owner asked for an *upgrade* control he can see; folding it into an "Upgrade
  agent" menu with Update agent would hide it again behind a click.
- **Disabled, never hidden, on a standard Windows agent.** A missing button reads as "not a feature"; a disabled one
  with "No signed release is published" and the command to fix it reads as "one step away".
- **No new invariant.** Nothing in `check-security-invariants.mjs` read `agent-card.tsx` or the old label; every
  protection is still server-side (`computers:edit`, `assertFresh`, the precondition function, the audit entry), and
  the header adds no route.

#### Verification
- **Browser (`apps/web/scripts/e2e-ui.mjs`, CI's ports 3501–3504, a fresh scratch database, `RELEASE_BIN` set):
  1050 passed, 0 failed** (88 of them new). At 1440 and 375 px, light and dark: with no signed release the header's
  Upgrade to full agent is a `<button disabled>` with the reason, the fix and the Full agent link beside it and as its
  tooltip, and the card says the same; with a release published (a real repository made by `rem0te-release`, whose
  timestamp the suite moves in and out of place) it is enabled, and it and the "Agent out of date" chip open the same
  dialog; on desktop/light a request through step-up writes one row and its audit entry, the header turns to
  *Upgrade requested — waiting for check-in* and the card follows without a reload, and cancelling on the card offers
  the header's button again; a signed agent shows *Full agent*, Linux the command; every header button stays inside
  375 px; a Business User gets no agent buttons. The first run caught the pending label widening a 375 px screen by
  13 px (the button was `whitespace-nowrap`); it wraps now.
- `e2e-navigation.mjs` asserts the header's buttons for the admin and the disabled state's reason (syntax-checked:
  it needs the docs stack on port 4000).
- `check-security-invariants.mjs` (466 checks) and `check-versions.mjs` pass; `pnpm -r lint`, `tsc --noEmit` in both
  apps, `nest build` and `next build` are clean. The API suites whose assertions named the old label
  were updated to the new text: `e2e-agent-upgrade.mjs` (94 passed, 0 failed) and `e2e-patch-policies.mjs` (98
  passed, 0 failed) were run on fresh scratch databases; `e2e-signed-release.mjs`, where only a check's description
  changed, was syntax-checked.

### Integration notes

The parts were merged into `feat/v0.37.0` in this order: signed releases, then automatic migration. Both started at
3770740 (0.36.2) and were given their section numbers in advance:

| § | Part | Checks |
|---|---|---|
| 56 | Signed releases on one host | 16 |
| 57 | Automatic migration and the Full agent page | 10 |

Check and test counts inside each part's section are that branch's own; the integrated counts are under
*Verification (integrated)*. Where the branches met:

- **Textual conflicts, all kept from both sides:** the end of `check-security-invariants.mjs` (§56, then §57) and
  `CLAUDE.md` (the §56 paragraph, then §57's). `run-e2e.sh` (`AUTO_MIGRATION_SWEEP=off` exported, `auto-migration`
  in the `RELEASE_BIN` group, `signed-release` with its own Go gate), `ci.yml` (`unit-signed-release`,
  `unit-auto-migration`), `docs/update-signing.md` (*The easy way* at the top, *Moving computers automatically* after
  *Moving existing agents*) and `docs/rmm-gap-analysis.md` merged without conflict. `docs/API-REFERENCE.md` and the
  docs bundle were regenerated, not merged.
- **§56 and §57 disagreed, and only the merged tree showed it.** §56 refused any `rem0te-signed-` text in
  `apps/api/src`, so the portal can't be made to name or run the signing commands. §57 requires the Full agent page's
  commands to be constants in `agent-migration.ts`, and the patch-policy pre-flight repeated one of them as a literal.
  Each branch passed its own invariants; the merge failed §56. §56 now exempts exactly the three exported
  `SETUP_COMMAND` / `PUBLISH_COMMAND` / `STATUS_COMMAND = 'sudo …'` lines, matched whole. A fourth constant (the
  export command), a key-store path, a constant with anything appended, or any other mention still fails it (four
  mutations, all caught). The pre-flight's fix text now uses `PUBLISH_COMMAND`, so the string lives in one place.
- **A broken link.** The portal half linked step 1 to `/docs/update-signing#the-easy-way`, guessing the anchor the
  release half would write. The heading is *The easy way (single host, 0.37)*, whose anchor is
  `#the-easy-way-single-host-037`. The overview's `docs` field and `e2e-auto-migration.mjs` now use that.
- **What the owner is told about setup, made to agree.** Setup runs the first publish itself, but the portal sees the
  repository only after the API restarts with `UPDATE_REPO_DIR`. So step 1 of the Full agent page stays *Not yet*
  until that restart, and the automatic migration's canary is asked within a minute of the **restart**, not of the
  publish. Step 1 now says so: `--apply-env` (or the printed line), `sudo systemctl restart reboot-remote-api`, that
  the canary follows within a minute (turn the migration off first to wait), and the export-root command.
  *The easy way* in `docs/update-signing.md` and its *Moving computers automatically* step 1 say the same.
- **The in-app `/help`** had only the portal half's paragraph. It now also has the easy way: setup with
  `--apply-env`, the restart, the timer, `rem0te-signed-export-root`, `rem0te-signed-publish` after every deploy,
  `rem0te-signed-status`, nothing going to GitHub and the trade-off. Its 0.24 paragraph no longer says the files
  are "signed offline".
- **The command strings agree everywhere.** The page and API show `sudo ./deploy/release/rem0te-signed-setup.sh`,
  `sudo rem0te-signed-publish`, `sudo rem0te-signed-status` and `rem0te-timestamp-refresh.timer`. These are the
  files `rem0te-signed-setup.sh` installs (`/usr/local/sbin/rem0te-signed-{publish,status,export-root,refresh}`,
  the `rem0te-timestamp-refresh.{service,timer}` units). `CLAUDE.md`'s deploy section ends with
  `sudo rem0te-signed-publish` once set up.
- **Fixed: setup chose the wrong Go toolchain when the caller had `GOTOOLCHAIN` set.** The integrated `run-e2e.sh`
  failed `signed-release` 4 passed, 5 failed: *go.mod requires go >= 1.27 (running go 1.22.2; GOTOOLCHAIN=local)*.
  Setup decides whether `/usr/local/go/bin/go` is new enough by running `go env GOVERSION`, which inherited the
  caller's `GOTOOLCHAIN=go1.27.4` and so reported 1.27.4. Setup then recorded `GOTOOLCHAIN=local`, and the build,
  which runs under `env -i`, ran the real 1.22 and stopped. The release branch's own run had no `GOTOOLCHAIN` in
  its environment, and CI's `setup-go` installs 1.27.4 directly, so neither saw it. On the owner's host it would
  have struck anyone with `GOTOOLCHAIN` in the environment `sudo` keeps. The probe now runs with
  `GOTOOLCHAIN=local`, so it reports the binary's own version. The suite then passed 64 of 64 in that same
  environment.

### Verification (integrated)

Run on the final tree, with both parts merged and the release bookkeeping in place. The database was
`rem0te_integrate37_test`, created empty; `E2E_OUT` was a new directory.

- **Static:**
  - `scripts/check-security-invariants.mjs`: **465 checks hold**, including §56 (16) and §57 (10). Before 0.37
    there were 439. The narrowed §56 check was mutated four ways (an export-command constant, a key-store path, a
    second publish constant, an altered `PUBLISH_COMMAND`), and each was caught.
  - `check-versions.mjs` passes, and so does `gen-integration-contracts --check`.
  - `pnpm -r lint` exits 0, and `tsc --noEmit` exits 0 in both apps.
  - `prisma generate`, `nest build` and `next build` succeed.
- **Prisma:** all 56 migrations, 0000–0064, apply to the empty database (0048, 0058 and 0061 are unused). `prisma
  migrate diff` from the migrated database to `schema.prisma` reports *No difference detected*.
- **Production manifest:** no npm dependency changed. `pnpm deploy:manifest` gives 0.37.0 with 30 dependencies and
  no devDependencies, and `npm install --omit=dev --package-lock-only` exits 0 with 0 vulnerabilities. No Go module
  changed.
- **Routes:** `docs/API-REFERENCE.md` was regenerated: 506 routes across 75 controllers (501 in 0.36, plus
  `GET /agent-signing/overview` and four `/admin/agent-auto-migration` routes). `--check` against the RouterExplorer
  log of `run-e2e.sh`'s scratch API matches exactly (506 / 506). The docs bundle is 40 pages.
- **Go (`tools/windows-installer`, Go 1.27.4):** `go test -count=1 ./...` with PowerShell 7.4.6 on `PATH`: 163
  top-level tests, 258 with subtests, all pass, none skipped. `go vet ./...` passes for Linux and Windows, and
  `GOOS=windows GOARCH=amd64 go build ./...` succeeds. The `rem0te-release` and `rem0te-action-sim` builds succeed.
- **Unit scripts, every one in `ci.yml` (35, the same set as `apps/api/scripts/unit-*.mjs`), all exit 0, with pwsh
  on `PATH`:**

  | Script | Passed |
  |---|---|
  | `agent-auto-update` | 89 |
  | `agent-health` | 53 |
  | `agent-migration` | 57 |
  | `ai-timeline` | 24 |
  | `approval-signer` | 207 |
  | `audit-chain` | 35 |
  | `auto-migration` (new) | 80 |
  | `chat` | 52 |
  | `device-views` | 77 |
  | `diagnostics-catalog` | 110 |
  | `dynamic-groups` | 68 |
  | `email` | 122 |
  | `group-policy` | 38 |
  | `hbbs-peer-snapshot` | 29 |
  | `integration` | 35 |
  | `macos-agent` | 27 |
  | `metric-history` | 42 |
  | `monitoring` | 100 |
  | `patch-policy` | 163 |
  | `patch-summary` | 27 |
  | `polish` | 25 |
  | `presets` | 26 |
  | `retention` | 47 |
  | `script-library` | 125 |
  | `script-run` | 136 |
  | `search` | 37 |
  | `session-mutations` | 30 |
  | `signed-installer` | 52 |
  | `signed-release` (new) | 22 |
  | `snapshot-schedule` | 85 |
  | `software` | 146 |
  | `system-inventory` | 92 |
  | `tray` | 67 |
  | `update-signing` | 16 |
  | `update-window` | 85 |

  `build-approval-signer --list` also exits 0.
- **`scripts/run-e2e.sh`:** run in full on the fresh database, with `RELEASE_BIN` / `ACTION_SIM` built from this tree,
  `PWSH` (PowerShell 7.4.6) set and Go available. **57 suites; none skipped.** 56 passed on that run.
  `signed-release` failed on the Go toolchain bug above. After the fix it was run again, alone, in the same
  environment and against the same database: 64 passed, 0 failed. The full run was not repeated after that
  one-line fix, which touches only `rem0te-signed-setup.sh`, used only by that suite. Passed counts:

  | Suite | Passed |
  |---|---|
  | `credentials` | 44 |
  | `security-features` | 42 |
  | `presets` | 114 |
  | `monitoring` | 108 |
  | `integration` | 77 |
  | `dashboard` | 53 |
  | `diagnostics-catalog` | 70 |
  | `system-inventory` | 68 |
  | `device-list` | 115 |
  | `endpoint-visibility` | 114 |
  | `device-views` | 142 |
  | `dynamic-groups` | 98 |
  | `add-device` | 62 |
  | `auto-updates` | 73 |
  | `group-policies` | 77 |
  | `reports` | 104 |
  | `script-library` | 138 |
  | `linux-agent` | 86 |
  | `macos-agent` | 106 |
  | `enrol-stepup` | 67 |
  | `search` | 113 |
  | `metric-history` | 59 |
  | `retention` | 43 |
  | `presence-cache` | 18 |
  | `ai-timeline` | 61 |
  | `email` | 92 |
  | `chat` | 89 |
  | `tray` | 142 |
  | `polish` | 49 |
  | `auto-snapshots` | 79 |
  | `agent-health` | 72 |
  | `agent-auto-update` | 96 |
  | `containment` | 70 |
  | `approved-action` | 76 |
  | `staged-patching` | 94 |
  | `maintenance-actions` | 64 |
  | `patch-policies` | 98 |
  | `software-deploy` | 156 |
  | `signed-updates` | 46 |
  | `ticket-workflow` | 53 |
  | `agent-upgrade` | 94 |
  | `auto-migration` (new) | 73 |
  | `script-run` | 81 |
  | `revocation` | 44 |
  | `signed-release` (new) | 64 (re-run after the fix; 4 / 5 failed before it) |
  | `smoke` | end-to-end proof passed |
  | `full` | FULL END-TO-END PROOF PASSED |
  | `business-access` | 83 |
  | `offboarding` | 63 |
  | `public-api` | PUBLIC API END-TO-END PROOF PASSED |
  | `public-address` | 43 |
  | `rollouts` | 46 |
  | `security-audit` | 57 |
  | `session-mutations` | 43 |
  | `support-requests` | 47 |
  | `sso-passkeys` | 70 |
  | `candidate-password` | ALL PASSED |
  | `secreg` | All security regression checks passed |

- **`e2e-ui.mjs`, as CI runs it** (ports 3501–3504, against the database of the `run-e2e.sh` run, after it):
  **949 passed, 0 failed** (search palette 24), including the Full agent page at 1440 and 375 px in both themes.
- **Not run:**
  - `e2e-navigation.mjs`: it needs the docs stack on port 4000, which this integration doesn't start (`node --check`
    only).
  - **Nothing ran on real Windows**: not the signed agent, the tray, the migration script, or the automatic
    migration's canary.
  - **The real root path of setup is untested.** `useradd`, `runuser`, `chown` / `chgrp reboot`, the systemd units and
    `--apply-env` against the real `/etc/reboot-remote/api.env` have never run. Every test ran setup under `--prefix
    --no-user --no-systemd` as a normal user in a temp directory.

### Upgrade notes (all of 0.37)

Deploy in this order. Take a `pg_dump` first.

1. **Deploy the portal**, as `CLAUDE.md` describes, with the schema steps. **Migration 0064**: run `prisma migrate
   deploy`, rsync `apps/api/prisma/` to the target, then run `npx prisma generate` there. Without the last two the
   API throws `Unknown field` (`agentAutoMigrationMode`, `automatic`, `rolloutId`). No production dependency changed,
   so the target manifest needs no regeneration. Nothing changes for computers yet: no repository is configured.
2. **Decide about the automatic migration before step 4.** It is **on by default**. To hold it, turn it off on
   **Devices → Full agent** now (no fresh sign-in needed to turn it off).
3. **Run setup once**, as root, from the source checkout, with someone watching (its root path is untested):
   `sudo ./deploy/release/rem0te-signed-setup.sh --apply-env`. It creates the `rem0te-release` user, the
   `/var/lib/rem0te-release` state with the keys, the published repository `/var/lib/rem0te-updates`, the commands
   and `rem0te-timestamp-refresh.timer`. It adds `UPDATE_REPO_DIR=/var/lib/rem0te-updates` to
   `/etc/reboot-remote/api.env` and runs the first publish. It needs Go (`/usr/local/go/bin/go` will do; it
   downloads 1.27.4 if that one is older), `pnpm install` in the checkout, `git`, `curl`, `flock` and `psql`.
   Publishing builds **committed** HEAD, so deploy from a clean, committed checkout. Then check
   `sudo rem0te-signed-status`.
4. **Restart the API** (`sudo systemctl restart reboot-remote-api`) so it reads `UPDATE_REPO_DIR`. The Full agent
   page's steps 1–3 should now be done. **Within a minute of that restart the automatic migration asks one canary**,
   unless you turned it off in step 2. The rest wait for the canary to report the published build and soak (60
   minutes by default). Watch the canary's Agent card. This is the first time the signed agent runs on real Windows.
5. **Export the root keys**: `sudo rem0te-signed-export-root /media/<usb-stick>` (or three directories), then type
   `yes`.
6. **From then on, end every deploy with `sudo rem0te-signed-publish`.** After pulling a new rem0te, run setup again
   (without anything else changing, it only updates the installed commands; it changes no key).

- Don't commit `tools/windows-installer/trustroot/root.json`. §56 fails CI if you do.
- New environment switches: `AUTO_MIGRATION_SWEEP=off` (stops the automatic migration in one API process; a test
  switch, but also the way to hold it from the env file) and `AUTO_MIGRATION_SWEEP_SECONDS` (default 60).
- API consumers: new routes `GET /agent-signing/overview` and `GET`/`PUT /admin/agent-auto-migration` with `POST
  …/resume` and `…/restart`; `AgentMigration` rows may be `automatic` with no requester. 506 routes in all.

## [0.36.2] — 2026-11-12 · *Beacon*

This release combines three Dependabot updates (#106, #107 and #115). It changes no portal code. Two of the updates
change the Windows agent's source, so the agent built from this release differs from 0.36.1's.

### Changed
- **Windows agent dependencies (`tools/windows-installer`):**
  - `github.com/sigstore/sigstore` goes from 1.10.6 to 1.11.3 (#107). It uses sigstore only to verify signed update
    metadata.
  - `golang.org/x/sys` goes from 0.49.0 to 0.50.0 (#106).
  - The indirect modules move with them: `golang.org/x/crypto` 0.55.0, `x/term` 0.45.0, `go-containerregistry`
    0.22.1, `go-securesystemslib` 0.11.1, `protobuf-specs` 0.5.2, `protobuf` 1.36.12, plus a new indirect module,
    `github.com/youmark/pkcs8`.
- **`go.mod` now names `go 1.27`, up from 1.26.10,** because sigstore 1.11.3 requires it. CI's `setup-go` reads it
  from `go.mod` and installs 1.27.4.
- **CI:** `actions/upload-artifact` goes from v4 to v7 (#115). This affects CI only, not production.

### Fixed (tests only)
- **`e2e-macos-agent` and `e2e-linux-agent` failed intermittently.** This PR's first CI run failed one macOS check,
  "an unreadable check time is unknown too", with the error `null`.
  - **Cause:** one inventory refresh stages two commands back to back, `INVENTORY_REFRESH` then `UPDATE_SCAN`, and
    they often share a `createdAt` millisecond. The tests sorted only by `createdAt` and read the last row as the
    update scan. On a tie, Postgres could return the inventory refresh last, which succeeded with no error.
  - **Fix:** the update-check assertions now read only `UPDATE_SCAN` rows: four on macOS and one on Linux, which had
    the same pattern. No product code changed.
  - Locally, against a fresh database, each suite passed three runs in a row: macOS 106 and Linux 86.

### Upgrade notes
- **The release machine needs Go 1.27 or newer** to build the agent. With an older Go, set `GOTOOLCHAIN=go1.27.4`.
  The bare `go1.27` toolchain name does not exist, so `GOTOOLCHAIN=auto` fails with "toolchain not available".
- **Nothing changes on the portal:** no migration and no npm dependency change. The deploy is `dist` and the web
  build only, because the version string moved.
- Computers keep running their current agent until a signed release built from this source is published.

### Verification
- **Merge:** #106 and #107 conflicted only in `go.sum`. I resolved it with `go mod tidy` under Go 1.27.4, and
  `go mod verify` reports all modules verified.
- **Go:** `go vet` passes, as do `GOOS=windows go vet` and `GOOS=windows go build ./...`. `go test ./...` passes in
  every package.
- **#107's first CI run failed** 6 of the 81 `e2e-script-run` checks: a script that should exit 0 hit its time limit.
  The same commit then passed on a re-run of the failed job, so the failure was a timing flake on the CI host, not
  the update.
- `check-versions.mjs` passes.
- The second CI run failed one `e2e-macos-agent` check. That failure is the test fix above.

## [0.36.1] — 2026-11-12 · *Beacon*

A patch release that records six decisions the owner made on questions 0.36 left open. Two of them change
something: the agent-silent monitor joins *Add recommended*, and contract revision 5 is proposed to ClientSt0r
(nothing is sent). The other four are "no change", recorded here and in the docs so that they stop reading as open
questions. No migration, no production dependency, no route added or removed.

### Changed
- **The agent-silent monitor is one of the recommended monitors.** In 0.36 it was opt-in twice over: never on by
  default, and left out of *Add recommended* (`engine.ts` kept it in a separate `OPTIONAL` list, and §51 enforced
  that), because whether it should come with the starter set had not been decided. The symptom of that choice was the
  case the monitor was built for: an MSP that set up monitoring with *Add recommended* still heard nothing about a
  computer like DESKTOP-4SADDCN, whose agent had been dead for twelve days while RustDesk still reached it, unless
  someone knew to add a seventh monitor by hand.
  - `RECOMMENDED` now ends with `{ key: 'agent-silent', kind: 'AGENT_SILENT', severity: 'WARNING', params: { minutes:
    AGENT_SILENT_BOUNDS.def } }` (60 minutes). Its name, bounds (30 minutes to 7 days), behaviour and alert text are
    unchanged.
  - **It is still never on by default.** *Add recommended* creates it like the other six: only when a person presses
    the button, only at that scope, only if that scope has no `agent-silent` rule yet, through `createRule`, as an
    ordinary audited rule (`MONITOR_RULE_CHANGED`).
  - **`OPTIONAL` is removed**, and with it `optional` in `GET /admin/monitoring/rules` (added in 0.36). Its only
    entry is now in `recommended`. The one thing the Monitoring page used it for, prefilling *New monitor → Agent
    silent* with the key `agent-silent`, Warning and 60 minutes, now reads the same starter from `recommended`, for
    that kind only, so picking another kind under *New monitor* fills in nothing new.
  - The page's empty-state line and the *Agent silent* hint say *Add recommended* includes it; `docs/monitoring.md`,
    `docs/architecture.md`, `docs/troubleshooting.md` and `/help` no longer call it opt-in.
- **§51 now asserts the opposite of what it did, and something stronger.** It used to check that `AGENT_SILENT` was
  kept *out* of `RECOMMENDED`. Putting it in makes *Add recommended* the bulk path that creates it, so the check is
  now that the bulk path stays a click:
  - `RECOMMENDED` holds the agent-silent entry with `severity: 'WARNING'` and `AGENT_SILENT_BOUNDS.def`;
  - `addRecommended` loops `RECOMMENDED` into `this.createRule(a, …)` and touches Prisma only to read which keys
    exist;
  - `createRule`'s `monitorRule.create` is the **only** `monitorRule.create` / `createMany` / `upsert` in
    `apps/api/src`;
  - only `engine.ts` and `monitoring-admin.service.ts` name `RECOMMENDED` (the latter exactly three times: the import,
    the rules view and the loop), so nothing reads it to install monitors at startup;
  - only the controller calls `addRecommended`;
  - no migration inserts a `MonitorRule`, and `prisma/seed.ts` names neither `monitorRule` nor `RECOMMENDED`.

  Proven to fail with each guard removed, then restored: the entry deleted from `RECOMMENDED`; an `onModuleInit` in
  `monitoring.service.ts` doing `monitorRule.createMany` over `RECOMMENDED`; `addRecommended` writing with
  `prisma.monitorRule.create` instead of `createRule`. All three were caught.

### Proposed (not implemented)
- **Contract revision 5 for ClientSt0r: agent-silent alerts and tray support requests** (`INTEGRATION_COORDINATION.md`
  §5B, P13–P15). The owner's decision is *propose, don't send*: rem0te sends neither today, to any peer, and nothing
  of it is built.
  - P13 adds `AGENT_SILENT` to `Alert.kind`, with an `agent_silent` detail block (`last_heartbeat_at`,
    `silent_minutes`, `threshold_minutes`).
  - P14 is a signed `support_request.created` event: ids, the computer, the business, a 120-character redacted subject
    (untrusted user text: never instructions to a model) and two booleans for resource usage and screenshot.
  - P15 is a separate delegated read for the description and the attachments (`support:read`). Attachments are never
    inlined.
  - All three are advertised in `/capabilities.features` and sent **only to a peer that declares revision 5** in its
    signed capabilities document. An older peer's generated schemas reject unknown fields and enum values (ClientSt0r's
    R2), which is what broke pairing and every alert when 0.30.0 shipped.
  - Section 9 records the decision and leaves a row for ClientSt0r's answer; CS-10 and the task list track it;
    `docs/integration-clientst0r.md`, `docs/support-requests.md` and the contract's `CLIENTST0R.md` point to it. §51's
    "agent-silent alerts are never signed or sent to ClientSt0r" check is unchanged and still holds.
- **ClientSt0r's acknowledgement of revision 3** was already in section 9, in the row ClientSt0r suggested
  (recorded with 0.36). No second row was added. The *Revision 3 proposed* row no longer says *Awaiting ClientSt0r*.

### Decided (for the owner)
- **Agent-silent monitor:** one of *Add recommended*'s starters, never on by default (above).
- **Agent-silent alerts and tray support requests reach ClientSt0r only through revision 5**, once ClientSt0r
  acknowledges it (above).
- **The containment `notifications` pause does not stop alert webhooks.** The 0.34 design stands (the comment on
  `KINDS` in `containment/pause.ts` gives the reason): webhook destinations are the MSP's or the business's own
  systems, and an incident is when they matter most. An unwanted webhook destination is removed from its
  notification policy. `docs/containment.md` now states this as a decision.
- **The *Agent migrations* menu entry stays visible to `computers:edit` only**, the people who may request a
  migration. The page's API read stays `computers:view`, so the link from every Agent card still works for a
  viewer. No change.
- **The winget installer-hash residual gap is accepted as documented**, and `LocalManifestFiles` stays off. Turning it
  on would replace a seconds-long window, which needs a change to the winget community repository, with a standing,
  machine-wide way for any local administrator to install from an arbitrary manifest. `docs/software-deployment.md`
  says so.
- **Chat on Linux and macOS is deferred.** Those agents are read-only by design, and there is no test machine here.
  `docs/chat.md` says so.

`docs/rmm-gap-analysis.md` gains a *Decided (0.36.1)* table with all six, and its rows no longer call any of them
undecided.

### Upgrade notes
- **Existing monitor rules are untouched.** The change affects only what a *future* *Add recommended* click adds.
  A business, or the global layer, where someone pressed it before 0.36.1 keeps its six monitors and gets no
  agent-silent monitor until someone presses *Add recommended* again (which adds only the missing one) or adds it
  under *New monitor*. Upgrading raises no alert and sends no notification.
- **`GET /admin/monitoring/rules` no longer returns `optional`.** The agent-silent starter is in `recommended`. Only
  0.36's own Monitoring page read `optional`, and it is rebuilt in the same release. Deploy the API and the web
  together.
- **The docs demo** (`prisma/_docs-demo-monitoring.ts`, which loops `RECOMMENDED` and refuses any database but
  `reboot_remote_docs`) now gets a global agent-silent monitor too. The documentation images were not recaptured for
  this release.
- No schema change, no migration, no dependency change. Rebuild the API and the web, rsync as usual, copy
  `version.json` and `CHANGELOG.md`, and restart both units. `docs/API-REFERENCE.md` is unchanged (501 routes).

### Verification
- `check-security-invariants.mjs` — **440 checks, all holding**. §51's rewritten first check was proven to fail with
  each of three guards removed (above), then restored.
- `unit-agent-health.mjs` — **53 passed, 0 failed** (52 in 0.36). The *opt-in* section is now *recommended, but off
  until someone adds it*: exactly one `AGENT_SILENT` starter (key, Warning, `AGENT_SILENT_BOUNDS.def`), seven
  starters with distinct keys, and no `OPTIONAL` export.
- `e2e-agent-health.mjs` (ports 3801/3802, scratch database) — **72 passed, 0 failed** (69 in 0.36). The rules page
  lists the starter under `recommended` and returns no `optional`, and being recommended created no rule in Acme.
  *Add recommended* is pressed on a third business, Cedar, which has **no computers**: on Acme, the agent-silent rule
  it now adds would raise against the silent fixtures within one 2-second sweep and leave an alert behind for the
  rest of the run. That click adds seven starters, the agent-silent one among them (60 minutes, Warning), with seven
  `MONITOR_RULE_CHANGED` audit rows, and a second click adds nothing. Run with `run-e2e.sh`'s switches exported
  (`AGENT_AUTO_UPDATE=off` and the rest). Without them, three client-update checks fail, because automatic agent
  update hands the fixtures an update. That is the suite's environment, not this change.
- `e2e-monitoring.mjs` (ports 3803–3805) — **108 passed, 0 failed**. `unit-monitoring.mjs` — **91 passed, 0 failed**
  (pwsh not available: the agent's monitor block was not executed; it is unchanged).
- `e2e-ui.mjs` (CI's ports 3501–3504, scratch database) — **915 passed, 0 failed**, including the Monitoring page at
  desktop and phone width in both themes.
- `pnpm -r lint`, `tsc --noEmit` in both apps, `nest build`, `next build`, `check-versions.mjs` (with the README badge moved to 0.36.1) pass. The docs bundle
  was regenerated (40 pages). `gen-api-reference.mjs` reproduces `docs/API-REFERENCE.md` unchanged (501 routes).
- **Not run:** the rest of `run-e2e.sh` (no other suite reads `RECOMMENDED`, `optional` or *Add recommended*); the
  ClientSt0r interop harnesses (nothing in the contract changed); anything on real Windows.

---

## [0.36.0] — 2026-11-12 · *Beacon*

The sixth increment of the RMM overhaul. Its theme is agents that keep themselves alive, up to date and reachable,
and say so when they cannot. Five parts were built separately from 0.35 and integrated here:

- **Agent health.** A computer RustDesk can still reach whose agent has gone silent can now raise an alert (an
  opt-in *Agent silent* monitor). A queued automatic client update that its policy no longer wants is withdrawn or
  re-planned on the next sweep, instead of being delivered anyway. The heartbeat cost of 0.35's automatic snapshots
  was measured, found to be about three transactions per heartbeat, and removed.
- **Signed revocation.** Revoking a script or archiving a software entry used to stop only *new* plans. The approval
  signer now publishes a signed revocation statement, and the 0.36 signed agent refuses an already-signed plan that
  it lists.
- **Agents keep themselves up to date.** An outdated Windows agent is asked at check-in to update itself, using the
  flags agents in the field already act on, paced (120 an hour by default) and bounded (three attempts per release).
  On by default.
- **The tray icon.** A Rem0te icon in the notification area, on both Windows agents: chat with support through the
  portal's own `/assist` page, support requests with optional resource usage and a screenshot, and six self-help
  tools. Chat recording becomes a per-business setting.
- **Docs and polish.** Every documentation image was recaptured on 0.36. Text on the accent on the sign-in page and
  Quick Connect takes its ink by luminance (the default accent now gets black text). The dashboard fits the screen
  with a containment banner showing, and the map's marker colours are tested against a fixture GeoIP database.

Three migrations (`0060_agent_health`, `0062_tray`, `0063_agent_auto_update`; 0061 is unused). No production
dependency changed. Signed revocation, the signed agent's daily update check and the signed tray take effect only
once a signed release built from 0.36 is published with the owner's keys; see *Upgrade notes*.

### Agent health

#### Added
- **An "Agent silent" monitor (`AGENT_SILENT`).** It was reported against a real computer, DESKTOP-4SADDCN, whose
  agent had been dead for twelve days while RustDesk could still reach it. 0.35 showed that computer amber
  (*Reachable (RustDesk) · agent silent 12 d*), but nothing alerted. No inventory, update scan, monitor report or
  action had arrived from it in all that time, and the only way to find out was to look at the computer.
  - **When it raises.** The computer is reachable (`isOnline`, which RustDesk keeps true; `connectivity.ts`) and its
    agent's last heartbeat is older than the threshold. The default threshold is 60 minutes, set per monitor between
    **30 minutes and 7 days**. The floor is the console's own agent-silent window, `HEARTBEAT_STALE_MS`. Below it the
    computer still shows *Online*, and the alert would contradict the page it links to.
  - **When it resolves.** On the first sweep after the agent checks in again.
  - **Unreachable as well.** If the computer stops being reachable too, an open alert is **held, not resolved**, and
    no new one is raised. A computer RustDesk cannot reach is the Offline monitor's case. Resolving and re-raising on
    every hbbs restart would only be noise.
  - **Never checked in.** A computer whose agent has never checked in is skipped: no agent ever started there, so
    none went silent.
  - **What the alert says.** The title reads *"<name>: agent silent for 3 h — remote control should still work"*. The
    duration is coarse on purpose (tens of minutes, then hours, then days), and an open alert's title is rewritten
    only when that wording changes. The detail carries `lastHeartbeatAt`, `silentMinutes`, `thresholdMinutes`, and
    the advice: use **Update agent** on the computer's Agent card, or re-run the installer on the machine.
  - **Built on the existing alert path.** It runs in the existing 60 s monitoring sweep (`SWEEP_KINDS`) and uses the
    same partial unique index (one open alert per computer and monitor), the same outage grouping and notification
    policies, and maintenance-window suppression. No new notification path exists, so §17's rules on who is notified
    apply unchanged.
- **Opt-in at every scope.** Nothing raises unless someone creates the monitor: globally, or for a business, site,
  device group or one computer, under 0.35's precedence (a narrower scope overrides or disables a wider one). It is
  **not** in *Add recommended*. The Monitoring page offers it under *New monitor → Agent silent*, which prefills the
  key `agent-silent`, Warning severity and 60 minutes (`GET /admin/monitoring/rules` now returns `optional`).
- **The Agent card and the device page link to the alert.** While an agent-silent alert is open, the device header
  shows an amber *Agent silent alert* chip, and the Agent card shows the alert with *open alert* (to
  `/alerts?alert=<id>`) and the same remote-control advice.
- **Migration `0060_agent_health`.**
  - Adds `AGENT_SILENT` to `MonitorKind`.
  - Adds `RustdeskNode.updatePolicyId`, which records which automatic policy queued a pending client update. It is
    plain text with no foreign key, because a deleted policy is exactly the case the sweep has to recognise.
  - Adds two audit actions, `CLIENT_UPDATE_AUTO_WITHDRAWN` and `CLIENT_UPDATE_AUTO_REPLANNED`.

#### Fixed
- **A queued automatic client update outlived the policy that queued it.** The client-update sweep queues a computer
  when its effective policy's window opens. Before 0.36, nothing afterwards checked that the queue entry still made
  sense. Suppose a computer was queued by a group's policy and then left that group, or the group's policy was
  disabled or deleted, or the computer moved to a site whose policy pins a different version. The request stayed,
  and the next heartbeat delivered an update no policy wanted any more. A policy *save* withdrew requests for its own
  business, but nothing caught the changes that are not saves: group membership (rule-based groups change as
  computers change), site moves, deletions.
  - **Every sweep tick now re-resolves first** (`ClientUpdatesService.reconcileQueued`). For each computer with a
    POLICY-queued request, it computes the effective policy as it is now, with group membership from the same
    snapshot the heartbeat uses, and compares it with the policy that queued the request:

    | Now | What happens | Recorded reason |
    |---|---|---|
    | the same policy, still enabled | kept | — |
    | no enabled policy applies | **withdrawn**; the request is cleared | `policy_removed` (the policy is gone), `policy_off` (disabled), or `no_longer_applies` (it no longer reaches this computer) |
    | a different enabled policy applies | **re-planned** under that policy; its version, its window | `no_longer_applies`, plus where it now comes from |
    | a request queued before 0.36 (no policy recorded) | adopted by the policy that applies now, or withdrawn if none does | `no_policy_recorded` |

  - **Every withdrawal and re-plan is audited**, per computer: `CLIENT_UPDATE_AUTO_WITHDRAWN` or
    `CLIENT_UPDATE_AUTO_REPLANNED`, with the reason, a sentence saying it, the from/to policy ids, the new scope,
    the target version and when the request was first queued.
  - **Manual requests are never touched.** A request staged by a person is not reconsidered. Each write is
    conditional on the row still holding exactly the request that was read (source, time and policy), so a
    technician's request or a heartbeat that just cleared the row is never overwritten.
  - **Policy saves.** The policy-save path (`clearUnwanted`) now uses the same reconciliation, so a save also
    re-plans rather than only withdrawing. It reports a count in the save's own audit entry, not one entry per
    computer.
- **Monitoring no longer sends ClientSt0r an alert kind its contract does not name.** `AlertEventsService.emit` now
  emits only the kinds in the integration contract's `Alert.kind` (`Alert.shape.kind.options`). Before this, a new
  kind would fail `AlertEvent.parse` before signing. `AGENT_SILENT` is not in that contract, so its alerts stay in
  Rem0te: alerts page, notifications, maintenance windows. Sending it to ClientSt0r needs a contract revision on
  both sides.

#### Performance
- **The heartbeat cost of automatic snapshots, measured, and the regression fixed.** 0.35 estimated 1–2 ms per
  heartbeat for deciding whether a snapshot was due, and did not benchmark it. `bench-heartbeat.mjs` now runs with
  snapshots on (`BENCH_SNAPSHOTS`, default on). During warm-up every synthetic computer answers all three keys with
  desktop-sized results, and the steady-state rounds then measure heartbeats with nothing due.
  - **The 0.35 build.** About 3 more transactions per heartbeat (29.6–31.1 against 25.9–28.7 with snapshots off, at
    1,000 and 5,000 computers), and roughly 3–4 ms more API CPU on the quieter runs. Almost all of that work
    concluded *nothing is due*: a key is due every 6 hours, and a computer heartbeats every 3 minutes.
  - **The fix.** `scheduleAutomatic` now remembers, per computer and in memory only, when its soonest key falls due
    (capped at an hour, `quietUntil` in `snapshot-schedule.ts`), and skips the three reads until then.
  - **What ends the window at once.** A tab being opened (checked from memory on every heartbeat, so a watched key is
    still asked for on the next one), a result arriving, a run expiring, or a change to the intervals.
  - **What it cannot see.** A row changed in the database behind the API's back (by hand, or by the retention sweep).
    That is picked up when the window ends, at most an hour later.
  - **Limits.** The map holds at most 50,000 computers and is emptied when it reaches that. A restart also empties it.
  - **Measured after the fix:** 25.7–28.6 transactions per heartbeat at 1,000 computers and 26.9–28.2 at 5,000 with
    snapshots on, the same as with them off. The same build with `SNAPSHOT_QUIET=off` measured 29.7–30.3.
  - **CPU on the shared host** (load average 4–12) moved more with other work than the difference being measured.
    `docs/server-sizing.md` has the full table and says so.

#### Upgrade notes
- **Migration `0060_agent_health`** adds enum values and one nullable column. Apply it with `prisma migrate deploy`
  and **regenerate the Prisma client at the target**: the new `MonitorKind` value and column are unknown to the old
  client. No production dependency changed.
- **Nothing raises until someone creates an Agent silent monitor.** Upgrading changes no alert, notification or
  ClientSt0r traffic.
- **Requests queued before 0.36 carry no policy id.** On the first sweep after the upgrade, each is adopted by the
  policy that applies now. If no policy applies, it is withdrawn and audited `no_policy_recorded`. A fleet whose
  policies did not change sees only adoptions, which are not audited.
- **`GET /admin/monitoring/rules` adds `optional`** (the starter list behind *New monitor*). `MonitorKind` in API
  responses can now be `AGENT_SILENT`. No route was added or removed (API-REFERENCE unchanged, 476 routes).
- **`SNAPSHOT_QUIET=off`** is a new API environment switch that restores 0.35's check-on-every-heartbeat.

#### Decided (for the owner)
- **Opt-in, not on by default.** Whether an agent-silent monitor should exist out of the box, and at what threshold,
  is a fleet policy question. It is offered, not installed. §51 keeps it out of `RECOMMENDED`.
- **Not sent to ClientSt0r** until the integration contract names the kind.
- **Policy saves record a count, not one audit entry per computer.** The sweep records one entry per computer.

#### Verification
- `unit-agent-health.mjs` — **52 passed, 0 failed**:
  - parameters and bounds (the floor is `HEARTBEAT_STALE_MS`);
  - opt-in, and scope precedence across global, business, site, group and computer;
  - raise, hold and clear, including never-checked-in and the unreachable hold;
  - the title and advice;
  - every `reconcileQueued` decision and reason;
  - `quietUntil` (cap, near due, already due, open run, failed retry, schedule off, never taken, and agreement with
    `dueKeys`).
- `e2e-agent-health.mjs` (ports 3601/3602, its own API from `dist`) — **69 passed, 0 failed**:
  - opt-in (no monitor, no alert; *Add recommended* leaves it out) and the 30-minute / 7-day bounds;
  - raised on a reachable silent computer only — not one that checked in recently, one that is unreachable, or one
    whose agent never checked in; one alert per problem across sweeps;
  - precedence: a site switches it off, a group sets 240 minutes, a computer sets 30, and a computer leaving a group
    falls back to the business monitor on the next sweep;
  - notification goes to a loopback hook; a maintenance window holds it and ending the window releases it;
  - held, not resolved, while unreachable; resolved on check-in and the resolution notified;
  - A/B isolation between two businesses with the same hostnames: Birch's owner gets a 404 for Acme's alert and
    computer, and neither business's lists or audit carry the other's;
  - a queued update is withdrawn within a sweep after the computer leaves its group (audited `no_longer_applies`,
    and the next heartbeat is handed nothing), re-planned under the business policy when one applies (and then
    delivered), adopted without audit when it predates 0.36; a sibling still in the group is kept, and a manual
    request is left alone.
- **Mutation.** With the sweep's reconcile disabled, the same suite failed 6 checks (63/69), so it catches the bug.
- `check-security-invariants.mjs` — §51, seven checks:
  - opt-in;
  - the threshold floor;
  - raises only while reachable;
  - not sent to ClientSt0r;
  - the sweep reconciles before queuing and records the policy;
  - withdraw and re-plan writes are whole, conditional and audited;
  - the quiet window ends when a tab is open, a result arrives, a run expires or the schedule changes.

  Each check was proven to fail with its guard removed (15 mutations, all caught). The suite reports 400 checks, all holding.

- Existing suites run against this build, all 0 failed: `e2e-auto-snapshots` 79 (with the quiet window on, the default), `e2e-diagnostics-catalog` 70, `e2e-monitoring` 108, `e2e-auto-updates` 73, `e2e-group-policies` 77, `e2e-reports` 104, `e2e-dashboard` 53; `unit-snapshot-schedule` 85, `unit-monitoring` 91, `unit-group-policy` 38. `pnpm -r lint`, `tsc --noEmit` (both apps), `nest build`, `next build`, `check-versions.mjs` pass.
- `bench-heartbeat.mjs` at 1,000 and 5,000 computers, before and after (figures above).
- **Not proven here.**
  - No browser test drives the new header chip or the Agent card link. They render from the same alert list the
    Monitoring tab uses, and are type-checked and built.
  - Nothing ran against a real Windows agent: silence was produced by ageing `lastSeenAt`.

### Signed revocation

#### Fixed
- **Revoking a script, or archiving a software catalog entry, did not stop a plan that was already signed.**

  A script's content hash taken off the approval signer's allowlist made the signer refuse every *new* run, and an
  archived catalog entry stopped new deployments. But a `windows.script.run@1` or `windows.software.install@1` plan
  signed before that was still a genuine plan inside its window (up to 24 hours), and the agent checks plans, not the
  allowlist. So it ran. The docs said as much ("a run already signed can still be delivered inside its window; cancel
  it from the Actions tab"), which left the cancel to a person, and a compromised portal could deliver the plan
  regardless.

#### Added
- **The approval signer publishes a signed revocation statement.** `GET /internal/v1/revocations` on the signer's
  loopback listener returns `rem0te-revocations-envelope/1`: a canonical-JSON statement (`rem0te-revocations/1`:
  `seq`, `asOf`, `scripts`, `software`) signed with the job-approval key under its own domain prefix
  `rem0te-revocations-v1\n`, so it can never be mistaken for a plan or anything else that key signs.
  - `seq` is the number of revocations listed. Revocations are permanent, so it only grows. The signer keeps every
    revocation it has ever published in `revocations.json` and publishes the union of that and what is on disk, so a
    revocation file that goes missing from its directory stays revoked. At most 5,000 (`MAX_REVOCATIONS`; the agent
    refuses more).
  - `asOf` is the signer's clock, the same clock that writes a plan's `signedAt`. The statement is signed fresh on
    every request.
  - Software revocations are a new write-once store, `software-revocations/<entryId>.json`, keyed by **catalog entry
    id** (carried in the signed `display.software.entryId`), not by installer hash: two businesses' entries for the
    same package share params, and archiving one must not touch the other. `POST /internal/v1/software/:entryId/revoke`
    (needs a reason; one-way) and the CLI `software list`, `software revoke --entry <id> --reason`, `revocations show`.
    Nothing over HTTP or the CLI un-revokes.
  - The signer now refuses a software plan that names no entry (`software_entry_missing`) and an install from a
    revoked entry (`software_revoked`), at admission and again when an approver approves.
- **The portal relays it**, unauthenticated, at `GET /api/v1/public/approval/revocations.json` (`no-store`,
  `nosniff`; 503 when there is no signer or it does not answer). It passes on the signer's four envelope fields and
  nothing else. It caches for 5 seconds and drops the cache when it revokes a script, archives software, or stores a
  newly signed plan — the last so a fresh plan's first delivery is never handed a statement older than its signature.
  Public because the agent fetching it holds no session, and because what it lists (revoked hashes and entry ids,
  the same for every business) gives nobody anything to act on.
- **The signed agent verifies it, keeps the newest, and refuses revoked plans** (`internal/action/revocation.go`). The
  agent fetches the statement itself before every job, from the pinned portal (`internal/agent.FetchRevocations`,
  capped at 1 MB), so `heartbeat.ps1` is unchanged. It verifies the signature against `approval/keys.json` from the
  offline-rooted update chain only, and requires `seq` to equal the entry count.
  - **Rollback refused:** a lower `seq`, or a statement that leaves out an entry it already holds, is refused and the
    held one is kept (`actions\revocations.json` in the state directory, under a lock).
  - **The check sits after the signed pause and before Precheck and the "executing" journal.** A script run whose
    content hash, or an install whose entry, is listed is refused **`revoked`** — final, journaled done, reported,
    never run later. Uninstalls are not refused: removing a withdrawn package is what an archive is usually for.
- **The portal cancels what it has not delivered yet.** `dispatchBlock` returns `revoked` for a pending target whose
  script entry is REVOKED or whose software entry is archived or gone, so those computers show *Canceled* with the
  reason *revoked* without the agent being asked. A delivered one comes back *Refused by the computer* (`revoked`),
  with the statement's `seq` in the detail; the Actions tab explains it.
- **Archiving a software entry revokes it on the signer first.** If a signer is configured and does not confirm,
  nothing is archived (`409 APPROVAL_SIGNER_REFUSED`): archiving only in the portal would leave delivered plans
  runnable. The audit entry carries `revokedOnSigner`.

#### Decided
- **A stale statement fails closed.** A plan runs only with a statement whose `asOf` is no older than the plan's
  `signedAt`; that statement necessarily lists every revocation made before the plan was signed. Without one the
  agent refuses `revocations_stale` — **not final, not journaled, not reported**, like a window that has not opened —
  and the next delivery tries again. Failing open would let a portal that withholds the statement run anything ever
  signed, which is the attack this closes; failing closed costs availability only when the signer or relay is down,
  and then no new plan can be signed anyway. This rule needs no new plan field: old agents parse plans strictly, so
  adding one would have broken every agent in the field before the new one shipped.

#### Known limits
- **It takes effect only once a new signed agent is published with the owner's release keys.** Agents before 0.36
  never fetch or check the statement. Nothing in this release changes any computer until that build is published.
- A portal that withholds the newest statement can still have a computer run a plan signed **before** the
  revocation, until that plan's window closes (at most 24 hours). Cancel it from the Actions tab as before.
- If the signer revokes an entry but the portal's database update then fails, the entry is revoked on the signer and
  still live in the catalog; archiving it again succeeds (revocation is idempotent).
- Not run on real Windows: the agent path ran in `rem0te-action-sim` with PowerShell 7 on Linux.

#### Upgrade notes
- **Order: signer, then portal, then (when published) the agent.** Rebuild and redeploy the approval signer first
  (`apps/api/scripts/build-approval-signer.mjs`); it creates `software-revocations/` and `revocations.json`. Then the
  portal. A 0.36 agent runs nothing new without a fresh statement, so the relay must work before that agent ships.
- **Entries archived before 0.36 were never revoked on the signer.** After upgrading, run
  `software revoke --entry <id> --reason "archived before 0.36"` on the signer for each, or a plan signed before its
  archive stays runnable inside its window on new agents too.
- No migration; no `heartbeat.ps1` change. §14's action catalog is unchanged (this adds no action).

#### Verification
Go: `go test ./...` in `tools/windows-installer` — 155 top-level tests (250 with subtests), all passed, with 7 new:
`TestRevocationNoStatementFailsClosedAndIsNotConsumed`, `TestRevocationForgedStatementRefused` (6 cases: another key,
an unknown kid, a body edited after signing, a plan's signing prefix, a seq that does not count the entries, an
unknown field), `TestRevokedScriptRefusedBeforeExecuting`,
`TestOlderPlanStillRunsAndNewerPlanWaits`, `TestRevocationRollbackRefused`, `TestRevokedSoftwareEntry`,
`TestFetchRevocations`; `go vet` for linux and windows clean. `unit-approval-signer.mjs` 207 passed (23 new: the
statement verifies and only under its prefix, forged and edited ones refused, `software_entry_missing`, a half-approved
install refused after the revoke, `software_revoked` at admission, uninstall still admitted, `seq` up by one, a deleted
revocation file still published, capabilities, the CLI). `e2e-revocation.mjs` (new; real signer, API from `dist`,
`rem0te-action-sim` with PowerShell 7) 44 passed: the relay, two runs signed before a revocation, A/B isolation, the
revoke, forged and rolled-back statements refused, the undelivered target canceled `revoked`, the delivered one
refused `revoked` before executing, an unrevoked older plan still running, plans signed after the revocation waiting
on a stale statement and running on a fresh one, fail-closed with no statement, a software archive refusing a
pre-signed install, and another business untouched. The seven suites that drive the sim now pass `-portal` and all
passed: `e2e-approved-action` 76, `e2e-staged-patching` 94, `e2e-containment` 71, `e2e-maintenance-actions` 64,
`e2e-patch-policies` 98, `e2e-script-run` 81, `e2e-software-deploy` 156 (re-run after the final build: 156); `unit-software` 146 and `unit-script-run` 136 passed. Invariant **§52** (9 checks, 24 mutations,
each caught); §39's admission check widened for the new argument, and a refusal message reworded that §14's import scan read as
an import. `docs/API-REFERENCE.md` matches the runtime route
table (477 routes).

### Agents keep themselves up to date

#### Added
- **An outdated Windows agent is now asked to update itself, on by default.** Until now an agent moved forward only
  when someone clicked *Update agent* on its Agent card (0.34), so a fleet stayed on whatever version enrolled it.
  Production has 0.30.1 and 0.18.25 agents checking in against a 0.35 server. Now, when a computer's agent is older
  than what this server serves, the heartbeat response carries the flag that agent *already* acts on. Nothing new has
  to be installed first, and the 0.30.x agents in production are covered. Code: `apps/api/src/agent-auto-update/`.
  All decisions are in `schedule.ts`, which is pure and unit-tested on its own.
  - **What "outdated" means.**
    - A standard agent reports the platform version of the installer that wrote it. It is outdated when that version
      is numerically older than `version.json`, read by the same lookup enrolment uses.
    - A signed agent is outdated when its reported `agentSha256` is not the build the signed repository publishes.
  - **Which flag, by agent version.** This was worked out from every tagged `heartbeat.ps1` (`git show <tag>:…`), not
    assumed:
    - 0.15.0 and later get `reinstallAgent`, which runs the current `windows.ps1`, as *Update agent* does.
    - 0.13.x–0.14.x get `updateRustdesk`. Those agents report no version but do hold a device secret, and their
      heartbeats re-run the installer on that flag alone (it is honoured from 0.11.0).
    - Signed agents get `reinstallAgent`, which runs `rem0te-agent.exe update`. That installs only what signed
      metadata lists, and the signed pause still stops it inside the agent.
    - Agents older than 0.13.0 have no device secret, so nothing they say is believed and nothing is handed to them.
      The Agent card says **Manual update required** and gives the exact command: `irm '<base>/api/v1/public/install/windows.ps1?token=<token from Add device>' | iex`.
    - Linux and macOS agents get the same treatment, with their `curl … | sudo bash` command. See *Decided*.
  - **Bounded, so a release can never become a download loop.** Each attempt downloads the RustDesk client again
    (about 40 MB).
    - An attempt hands the flag out for **20 minutes**. That is shorter than the 30-minute floor every agent since
      0.11.0 keeps between installer runs, so one attempt is at most one installer run.
    - The server then waits **an hour** for the new version to be reported, and backs off before trying again:
      attempt 2 comes at least **2 hours** after attempt 1, and attempt 3 at least **8 hours** after attempt 2.
    - After the last attempt (**3** by default, 1–10) it stops. The computer is shown **Auto-update failing (3 of 3
      attempts)** on its Agent card and in the settings card's failing list.
    - It is not asked again until the next release, because a new target starts from zero, or until someone clicks
      *Update agent*, which also resets the count.
  - **A global pace.** At most *N* attempts start per hour across the whole platform (default **120**, 1–2,000).
    - They are counted from the history table under `pg_advisory_xact_lock`, so the cap holds across API processes.
    - Starting an attempt is a conditional update keyed on the state that heartbeat read, so two concurrent
      heartbeats from one computer start one attempt, not two.
    - At the default, 5,000 outdated computers take about 42 hours.
  - **Holds.** Nothing goes out while any of these applies, and the Agent card names the one that does:
    - an `updates` containment pause (business or global);
    - a staged rollout owning the computer;
    - another installer re-run already queued: a RustDesk client update, *Update agent*, or a move to the signed agent
      (each of these updates the agent too);
    - a remote session open (the install restarts RustDesk);
    - outside the policy's window, under *Only inside this policy's window*;
    - someone logged on, when that policy also skips computers with a user;
    - the pace used up.
- **Settings → Client updates → *Keep agents up to date automatically — every business*** (Platform Admin). It has an
  on/off switch, starts per hour and attempts per computer per release. It also shows the pace used this hour, the
  attempts in the last day, and the computers that are failing.
  - Routes: `GET`/`PUT /admin/agent-auto-update`.
  - A change needs fresh authentication and is audited as `AGENT_AUTO_UPDATE_SETTINGS_CHANGED`, with before and after.
  - 478 routes in all.
- **The client-update policy gains *Keep agents up to date automatically***, for a business, a site or a device group.
  It is independent of the RustDesk checkbox.
  - The options are *Any time, paced* (the default), *Only inside this policy's window*, *Off*, and (for a site or
    group) *Inherit*.
  - The 0.35 precedence decides: the most specific policy that sets a mode wins (group, then site, then business), and
    *Inherit* passes the decision to the next one.
  - Changing it to anything but *Off* needs fresh authentication. Opting out never does.
  - Audited as `CLIENT_UPDATE_POLICY_CHANGED`, with `agentMode` in before and after.
- **The Agent card shows the state.** It is one of: *Up to date*, *Queued* (with the reason and the window), *Updating
  (attempt n of m)*, *Auto-update failing*, *Opted out* (and by what), or *Manual update required* (with a copy
  button). An *Automatic update history* list sits below it.
- **The device list gains *Agent: Agent outdated*** (`agent=outdated`). It covers standard Windows agents reporting an
  older version and signed agents not on the published build. An agent that reports no version stays under *No agent
  report*, because it cannot be told apart from a RustDesk-only computer.
- **The signed agent checks for updates by itself.** Before this, a signed agent updated only when the portal set a
  flag. Its heartbeat now runs `rem0te-agent.exe update` about once a day: every 20 hours plus up to 8 hours of jitter,
  stamped in `C:\ProgramData\Rem0te\update-check.next`.
  - It runs only on a heartbeat whose response says it may (`agentSelfCheck`): not opted out, inside a window policy's
    window, no `updates` pause, no rollout and no open session.
  - It never runs on the same heartbeat as a portal-requested update.
  - A missing, past or more-than-two-days-out stamp is rescheduled rather than trusted.
  - **This is part of the signed `windows/install.ps1`, so it takes effect only once a signed release built from 0.36
    is published with the owner's keys.** Until then, signed agents update when the portal asks them to, which works
    today wherever a signed build is published.

#### Decided
- **Every release counts as an agent update.** The standard agent's version *is* the platform version, so a release
  that did not touch the heartbeat script still makes every agent outdated. The alternative was a separate "agent
  script version" that someone has to remember to bump, and the 0.8.2 episode in `CLAUDE.md` shows how that ends. The
  cost is one paced reinstall per computer per release.
- **Linux and macOS agents are never updated from the server.** Those agents are read-only by design. They act on no
  flag from the portal (§24, §32), and giving them one would make a compromised portal able to run a root installer
  on every Unix computer. Their Agent card says *Manual update required* with the command.
- **There is no canary-first.** The client-update machinery has no canary notion to reuse cheaply. A cautious business
  gets the same effect by hand: *Off* on the business policy and *Any time* on a pilot device group's policy.
- **Automatic attempts are history rows, not audit entries.** Each attempt is an `AgentAutoUpdateAttempt` with no
  requester. One audit row per computer per release would bury a sealed log that can never be pruned. The settings
  and policies that cause the attempts are audited.
- **Opting out needs no fresh authentication;** turning it on or widening it does. This follows the containment rule
  that making things safer is never harder than making them riskier.

#### Upgrade notes
- **Schema change: migration `0063_agent_auto_update`.** It adds an enum, `ClientUpdatePolicy.agentMode`
  (nullable, so it inherits), three `RustdeskNode` columns, three `PlatformSettings` columns and the
  `AgentAutoUpdateAttempt` table, with CHECK constraints on every bound. Run `prisma migrate deploy`, rsync
  `prisma/` and run `prisma generate` at the target, as `CLAUDE.md` describes. Otherwise the API throws `Unknown
  field` on the first heartbeat.
- **It is on as soon as it is deployed.** The first round after the deploy reaches every outdated Windows agent,
  paced at 120 an hour. To deploy without it, either switch it off in the settings card first (the setting lives in
  the database, so set it after the migration and before the restart), or run the API with `AGENT_AUTO_UPDATE=off`.
- No production dependency changed. Nothing needs the owner's keys except the signed self-check, as described above.
- `scripts/run-e2e.sh` and `e2e-ui.mjs` set `AGENT_AUTO_UPDATE=off`, so the other suites' outdated fixture agents are
  not handed flags they do not expect.

#### Verification
- `unit-agent-auto-update.mjs`: **89 passed, 0 failed** (new, in CI). It covers the scheduling logic (channel, target,
  mode resolution, every hold, the attempt window, verify grace, back-off and the cap). It also checks that the
  generated legacy and signed installers and heartbeats parse with the pwsh `Parser`, runs the signed self-check
  under pwsh against a stub agent (due, not due, a rescheduled stamp, never on a portal-requested update), and runs
  `sh -n` over the Linux and macOS agents.
- `e2e-agent-auto-update.mjs`, port 3641 (3642 for the switched-off API), added to `run-e2e.sh`: **96 passed, 0
  failed**, through the real heartbeat route. It covers:
  - an outdated agent getting `reinstallAgent`, and a 0.13 agent getting `updateRustdesk`;
  - an up-to-date one getting nothing, and a pre-0.13 one shown as manual;
  - the window;
  - the pacing cap;
  - the attempt cap and back-off up to *failing*, with *Update agent* resetting it;
  - an opted-out business, and a site opted back in with a window (the group scope reuses the 0.35 resolver and is
    covered by `unit-agent-auto-update.mjs`'s mode resolution, not by this suite);
  - an open session and a logged-on user holding it;
  - the containment pause;
  - a rollout owning the computer;
  - the `AGENT_AUTO_UPDATE=off` process;
  - step-up and audit on settings and policy;
  - Business A against B isolation (404s).
- Existing suites touched by the change, all passing:
  - `e2e-device-list.mjs` 115;
  - `e2e-agent-upgrade.mjs` 94;
  - `e2e-auto-updates.mjs` 73;
  - `e2e-group-policies.mjs` 77;
  - `e2e-dynamic-groups.mjs` 98;
  - `e2e-containment.mjs` 71;
  - `e2e-signed-updates.mjs` 46;
  - `unit-signed-installer.mjs` 52 (its legacy/signed line-count tolerance went from ±120 to ±140 for the 14-line
    self-check);
  - `unit-system-inventory.mjs` 92;
  - `unit-diagnostics-catalog.mjs` 110;
  - `unit-update-window.mjs` 85;
  - `unit-group-policy.mjs` 38;
  - `unit-device-views.mjs` 77;
  - `unit-macos-agent.mjs` 27;
  - `unit-agent-migration.mjs` 57.
- `check-security-invariants.mjs`: all hold, including the new **§53** (11 checks). The checks cover:
  - the flag goes out only on an authenticated, unpaused heartbeat, and never over a flag already going out;
  - the attempt is bounded under the 30-minute floor and capped;
  - the pace is counted under an advisory lock;
  - Linux and macOS are never handed a flag;
  - the settings route is platform-admin-only with `assertFresh` and an audit entry;
  - widening a policy's agent mode needs fresh authentication;
  - the card is scoped before anything is read;
  - the self-check exists only in the signed variant and never runs beside a requested update;
  - `AGENT_AUTO_UPDATE=off` is exact and set for the other suites.

  Each guard was removed in turn: **17 mutations, all caught**, then restored. `check-versions.mjs` passes.
  `pnpm -r lint`, `tsc --noEmit` in both apps, `nest build` and `next build` all pass.
- `docs/API-REFERENCE.md` was regenerated and matches the runtime route table (478). The docs bundle was regenerated
  (39 pages).
- **Not run on a real Windows computer.** The signed self-check is unit-tested only and needs a signed release.

### Docs, screenshots and console polish

#### Fixed
- **White text on a light accent, on the sign-in page and Quick Connect.** The sign-in band and the Quick Connect
  step chips and download buttons drew `text-white` on whatever accent the business had set. A pale accent such as
  `#FDE68A` gave about 1.4:1, so the product name and the step numbers were close to unreadable. Both pages now pick
  the ink with `inkOn()` from `lib/contrast.ts` (0.35), which takes the WCAG relative luminance and returns black or
  white, whichever contrasts more. An accent `inkOn` cannot parse falls back to `#3B82F6`. The default `#3B82F6`
  therefore now gets **black** ink (5.71:1 against 3.68:1 for white). That is a visible change on every unbranded
  install, and it is deliberate.
- **The dashboard overflowed the screen while a containment banner was showing.** The 0.35 fitted layout sized itself
  as `100dvh − 3rem`, leaving the banner out of the sum, so with a pause in force the page grew a scroll bar and the
  bottom row of panels was cut off. `ContainmentBanner` now publishes its own height as `--containment-banner-h`,
  measured with a ResizeObserver and removed when the banner goes. The dashboard subtracts it.
- **On a phone, the site-outage strip cut its own sentence.** The strip's `max-h-24` cap is now applied only at `lg`,
  where the layout is fitted. Below that the page scrolls, and the cap had hidden "Open alerts".
- **The map marker colours had no test.** No suite could place a computer on the map, because the test stacks have no
  GeoIP database and must not read production's. `apps/api/scripts/lib/mmdb-fixture.mjs` writes a real MaxMind DB
  2.0 City file (IPv4, 24-bit records, no pointers) holding only the RFC 5737 networks a suite gives it. `e2e-ui`
  writes one to a temporary directory and points its API at it with `GEOIP_DB_PATH`, so the API's own lookup code
  resolves the addresses unchanged.

#### Changed
- **Every documentation image was recaptured on 0.36.** That is 59 gallery images, three of them new
  (`dashboard-narrow-dark`, `device-agent-silent-light`, `device-group-monitor-dark`), and 36 guide images in light
  and dark, including the phone widths. The phone-width captures date from 0.33 and no longer showed the 0.34 drawer.
  - `tech-01-signin` is now generated as a signed-out callout capture. The old one was hand-made and showed white on
    blue.
  - Callout specs were fixed where the pages had moved. The script-library notice is now "How a script runs".
    Monitoring notifications is now 1250 px tall, so callouts 3–4 stay on the page. Client updates is 3400 px with a
    new callout on the device-group policy, so `docs/updates.md` now has 7 keys.
  - The numbered keys in `technician-guide.md`, `updates.md`, `script-library.md`, `diagnostics.md` and
    `containment.md` were rewritten to match.
- **The docs demo now shows the amber state.** `_docs-demo-refresh.ts` keeps NWD-BILLING-RMT *agent silent*: it stays
  `isOnline` with its RustDesk node fresh and a heartbeat 3 d 2 h old. The refresh now logs
  `23 online, 1 agent silent, 10 offline`. Run the docs API with `STALE_SWEEP=off`, or the sweep marks that computer
  offline.
- **Device-group policy in the docs demo.** `_docs-demo-workbench.ts` seeds a client-update policy and an Offline
  monitor on the Remote depots group ("Depot offline", 60 min). It clears group policies and monitor rules before it
  deletes the groups.
- **ClientSt0r's response to revision 3 is recorded.** It was received 2026-11-11 and is filed in
  `INTEGRATION_COORDINATION.md` §5, §6, §8, §9, a new §9A (requests R2–R16), §10 and §11, in
  `docs/integration-clientst0r.md` ("Revision status") and in the contract README and `CLIENTST0R.md`. ClientSt0r
  acknowledges P1–P10 as proposed and answers P7: the intended effect of a handoff is a staff note in the computer's
  History. Their development branch reports CS-1..CS-7 done, and their cross-peer run reports 99 passed and 3 failed.
  Both are recorded as reported, not reproduced by rem0te. **`contract_revision` stays 2.** Revision 3 is agreed but
  not built, and the response does not address revision 4 (P11/P12 and questions a–c). R10 was checked and is right:
  `examples/index.json` says 0.29.1 under revision 2. It is not fixed here, because that file is generated. The repo
  has no `responses/` convention, so the response is quoted, not copied.

#### Upgrade notes
- No migration and no API change. The web app is the only runtime change: the login band, Quick Connect, the
  dashboard and the containment banner.
- A business with a dark accent sees no change. With the default or a light accent, the sign-in band and the Quick
  Connect chips switch to black text.
- The repository grows by about 24.5 MB of new PNG blobs: 92 images replaced and 3 added. PNGs do not compress
  further in a pack. In the working tree the images went from 22.9 MB to 24.5 MB (+1.6 MB, 0.8 MB of it the three
  new ones).

#### Verification
- `e2e-navigation.mjs` against the docs stack (4000/4001, `reboot_remote_docs` migrated to 0059, workbench and
  refresh run): **350 passed, 0 failed**. No navigation bugs were found.
- `e2e-ui.mjs` (ports 3611–3614): **879 passed, 0 failed** (the last run on the final build). New checks:
  - the map draws amber `rgb(245, 158, 11)`, green and grey markers from the fixture, and the tooltip reads
    `1 computer · 0 online · 1 agent silent`;
  - a business owner sees only their own business's marker;
  - with a BUSINESS-scope containment pause at 1440×900, `--containment-banner-h` equals the banner's height, the page
    does not scroll and every panel stays inside the viewport;
  - for the accents `#FDE68A`, `#1E3A8A` and `#3B82F6`, the login band and `/quick` inks are ≥ 4.5:1.
- `check-security-invariants.mjs` §54 adds 4 checks:
  - e2e-ui uses a fixture `GEOIP_DB_PATH` and never a production path;
  - the fixture's CIDRs are RFC 5737 only;
  - nothing under `apps/api/src` imports the mmdb writer, and the writer is IPv4-only;
  - login and `/quick` take their ink from `inkOn()` with no `text-white` on the accent.

  Each was shown to fail with its guard removed (5 mutations), then restored. All invariants hold.
- `check-versions.mjs`, `pnpm -r lint`, `tsc --noEmit` in both apps, `nest build` and `next build` all pass.
- Every new and changed image was opened and checked. Masking held: the only addresses shown are 198.51.100.24,
  `remote.example.com`/`.net` and 127.0.0.1, and no real hostname or the live domain appears. The docs demo reads the
  host's default GeoIP file, as it always has, to place its fictional public addresses. The Updates guide image still
  shows the capture host's kernel version and uptime.

### The tray icon: chat, support requests, self-help

#### Added
- **A Rem0te icon in the notification area of every managed Windows computer, with either agent** ([tray.md](docs/tray.md)).
  The owner asked for a tray icon with chat on both agents, an option to record chats, and, on the advanced agent,
  opening a ticket (with resource usage and a screenshot), a DNS check, `ipconfig /renew` and similar. One Go program,
  `rem0te-tray.exe` (`tools/windows-installer/cmd/rem0te-tray`), serves both agents, in the user's session. Its menu
  is *Chat with support* (with an unread badge), *Open a support request…*, *Self-help tools* and *About*.
  - **Signed agent:** `rem0te-tray.exe` is a new, optional signed target, `windows/rem0te-tray.exe`. Stage 2 installs
    it to `C:\Program Files\Rem0te\tray\` (SYSTEM and Administrators full control; Users read and execute) and
    records its SHA-256 in `agent-status.json` (`traySHA256`). The status then reports `tray: 1` and `chat: 2`, and
    does so only if a tray was installed.

    `rem0te-agent.exe tray-host` (SYSTEM) replaces the 0.34 chat host and the 0.34 Win32 chat window; `chat` stays
    as an alias. Every 5 s it enumerates active sessions and starts the tray in each with `CreateProcessAsUser`, but
    only a file whose SHA-256 matches the recorded one. It talks to the tray over the 0.34 pipe design, and the
    Windows account comes from the session token. It also runs the elevated tools and consults the signed pause.
  - **Standard agent:** the install script downloads the tray from `GET /public/install/rem0te-tray.exe`, pins it by
    the SHA-256 printed into the script, and adds a `Rem0teTray` Run entry with `--standard`. The SYSTEM heartbeat
    pairs it through `POST /tray/pair`, using the device secret, and writes a **tray key**
    (`tk_<id>.<secret>`, hash stored, replaced on every pairing) to `C:\ProgramData\Rem0te\tray\tray.json`. The key
    opens only `/tray/*`. A standard computer's device secret is refused there (`TRAY_KEY_REQUIRED`).
- **Chat in the tray, through the portal's own page.** The chat window is `/assist/chat` in a WebView2 control,
  running as its own process (`--chat-window`). It falls back to the default browser, with a balloon saying so, when
  the WebView2 runtime is missing.
  - **Signing in:** the tray asks for a **one-time code**, which is hashed and lives 60 s. It opens
    `/assist/open?c=…`. One conditional update consumes the code and exchanges it for an `HttpOnly; Secure;
    SameSite=Strict` cookie on `Path=/assist`, which lasts 2 h. The response is a **303** to `chat`, so the code
    leaves the address bar.
  - **The page** has its own CSP (`default-src 'none'`, `script-src 'self'`, no `unsafe-*`); the console's CSP is no
    longer applied to `/assist`. Writes need `x-assist: 1`, and text is drawn with `textContent`.
  - **The WebView2 control** answers 403 to anything outside `https://<portal>/assist/`. Dev tools, host objects,
    web messages, the context menu and script dialogs are off. The URL reaches the window process on stdin, never
    on a command line.
  - **The person can start a chat** from the tray. It opens a chat and an `AGENT` support request with a fixed
    description, and `CHAT_STARTED` records `by: end_user`. Chat protocol 2 means the tray; the
    `/enrollment/chat/*` routes stay for protocol-1 agents.
- **Chat recording, per business, with a platform default** (on). It is set on Settings → General → *Chat
  recording*, and audited as `CHAT_RECORDING_CHANGED` (scope, before, after).
  - **Who can change it:** a Business Owner for their own business, or a Platform Admin for any business and for
    the default. Every change needs a **fresh sign-in**.
  - **Each chat is frozen** as recorded or not when it starts. Both sides are told which.
  - **A chat that is not recorded:**
    - a technician's message is deleted when the person's page reports it read;
    - a reply is deleted when a technician's panel acknowledges it (`POST …/chat/conversations/:cid/ack`,
      `support:chat`);
    - everything left is deleted at the end.

    The conversation row keeps who, when and the counts.
- **Support requests from the tray**, with optional **resource usage** (CPU, memory, system disk, uptime, the top 10
  processes; path-like names dropped) and an optional **screenshot** (JPEG or PNG, ≤ 700 KB, ≤ 4096 px). Both boxes
  are unticked by default, and the person sees the screenshot, and can remove it, before sending.
  - Attachments are stored in the new `SupportRequestAttachment`. They are listed and served (`GET
    /support-requests/:id/attachments/:aid`, nosniff, sandbox CSP, no-store) **only to someone who can see the
    computer** as well as the queue. Anyone else sees "n attachments hidden".
  - Attachments are deleted when the request is anonymised, and at 45 days regardless.
  - Limits: 3 an hour per computer, 2 per Windows account, 3 open per computer. Refused content does not count.
  - Containment never blocks a request.
- **Self-help tools: a closed catalog of six**, identical in the API, the agent and a database `CHECK`:

  | Tool | Agents | Runs as |
  |---|---|---|
  | `dns.check`, `net.test`, `net.details` | both | the user |
  | `dns.flush`, `ip.renew` (with a confirmation) | signed only | SYSTEM |
  | `rustdesk.restart` (refused while a session is open, or when that cannot be told) | signed only | SYSTEM |

  - **Rate limits:** each tool has its own per-computer rate, and there are 30 runs an hour in all.
  - **Containment:** `actions` stops the SYSTEM tools, and `remote` also stops the RustDesk restart. A refused run
    is still recorded.
  - **Offline:** the signed agent may run an elevated tool while offline if its last portal state and signed-pause
    reading are each under an hour old. It reports the run later; at most 20 are queued, and the portal accepts
    reports from the last 7 days, at most 20 a day.
  - **Recording:** every run is in `TraySelfHelpRun`, on the computer's History tab under *Tray*
    (`GET /endpoints/:id/tray`). It is audited as `TRAY_SELF_HELP` (run, tool, outcome, offline), with no username
    and no output.
- Migration `0062_tray`:
  - new tables `AssistCode`, `AssistSession`, `SupportRequestAttachment`, `TraySelfHelpRun`;
  - recording settings on `Customer` and `PlatformSettings`;
  - `recorded` / `startedBy` on `ChatConversation`, and `technicianSeenAt` on `ChatMessage`;
  - the tray key and `trayProtocol` on `Endpoint`.
- `TRAY_SWEEP=off` stops the hourly clean-up: expired codes and sessions, runs older than 400 days, and runs never
  reported on.

#### Changed
- **Chat now reaches standard Windows computers.** The tab says *the standard agent cannot chat until its tray is
  installed* until the installer has been re-run from a 0.36 portal.
- **The 0.34 chat window and its host are removed from the agent** (`chatui_windows.go`, `internal/chat`'s host,
  client, protocol and transcript). The pipe code moved to `internal/tray`.

#### Found while building this
- **The 0.34 chat window was probably never runnable by the user it opened for.** The host started it from
  `rem0te-agent.exe` in the agent's install directory, which `SecureDir` restricts to SYSTEM and Administrators. A
  standard user's token would therefore have been refused execute on the very file it was asked to run. This was
  never seen, because the window never ran on Windows. The tray lives in its own directory, which Users can read and
  execute.
- **No support request reaches ClientSt0r, from any origin.** Tray requests do not either; no new path was invented
  for them. If tickets from the tray are wanted in ClientSt0r, that is a contract change on both sides.

#### Decided
- **The standard tray's Windows account is reported, not proven.** `tray.json` must be readable by the signed-in user,
  so any local user of a standard computer can read the key, and can chat or file a request under another local
  account's name and run the three read-only tools.

  This is not a new way in:
  - the key never runs an elevated tool, in the API or under the `CHECK`;
  - it opens only `/tray/*`, for one computer;
  - it reads nothing about any business;
  - asking for help is already open to anyone with the business's support link.

  The docs and the help page say so. On the signed agent the account comes from the session token.
- **The page is the portal's, not the tray's.** Drawing chat in a web page shared by both agents means one renderer
  of untrusted text, under a strict CSP, tested in a real browser. That is better than two hand-built Win32 views.
  WebView2 runs in its own process because the wrapper library exits its process on internal errors.
- **The local rate check counts only runs that go ahead.** A portal refusal does not use up the person's allowance.

#### Upgrade notes
- **Signed releases:** build `rem0te-tray.exe` with
  `GOOS=windows go build -trimpath -ldflags "-H=windowsgui -s -w" -o rem0te-tray.exe ./cmd/rem0te-tray` and add
  `-add windows/rem0te-tray.exe=…` ([update-signing.md](docs/update-signing.md)). A release without it installs no
  tray, and the agent reports no chat.
- **Standard computers** get the tray when their installer is next run from this portal. The portal serves the
  signed target when an update repository is configured, otherwise `apps/api/dist/rem0te-tray.exe`; with neither,
  the installer logs *no tray build* and continues.
- **Schema:** run `prisma migrate deploy` and regenerate the Prisma client at the target (`0062_tray`).
- **Not run on real Windows.** Nothing here — the icon, the menu, the form, the screenshot, WebView2,
  `CreateProcessAsUser`, the pipe access list, `ipconfig` / `ping`, the Run key — has run on a Windows machine. The
  UI and the docs say so.

#### Verification
- `apps/api/scripts/e2e-tray.mjs` — **142 passed**, against the API from `dist` on `rem0te_tray_test`. It covers:
  - pairing and key replacement;
  - code mint, exchange, replay, guess and expiry;
  - cookie flags and page headers;
  - technician and user-started chats;
  - recording, with step-up, roles and audit, and unrecorded deletion counted in rows;
  - support requests with usage and a PNG, attachment visibility and caps;
  - self-help, with signed-only tools, rates, offline reports and history;
  - containment (`actions`, `remote`);
  - A/B isolation;
  - no text, key, code or secret in the audit log.

  Added to `scripts/run-e2e.sh` (with `TRAY_SWEEP=off`).
- `apps/api/scripts/unit-tray.mjs` — **67 passed**; added to CI.
- `apps/web/scripts/e2e-ui.mjs` `assistWindow` — the `/assist` page in Chromium at 420 × 600 (light) and 320 × 480
  (dark): **36 checks** (18 per size; 41 in the narrowed run, with the stack checks).
- `e2e-chat.mjs` **89 passed** and `unit-chat.mjs` **52 passed**, after the chat changes.
- Go: `go test ./...` passes; `GOOS=windows go build ./...` and `go vet` pass on Windows and Linux.
- PowerShell 7's parser accepts the generated standard (with and without a tray) and signed scripts, and their
  heartbeat bodies.
- `check-security-invariants.mjs`:
  - **§55** (14 checks) is new;
  - **§45** was rewritten for the tray: six chat routes, the WebView2 window, the tray holding no secret, and the
    tray host's pipes.

  Each of 27 guards was removed in turn and shown to fail its check, then restored.

### Integration notes

The parts were merged into `feat/v0.36.0` in this order: agent health, signed revocation, automatic agent update,
docs and polish, the tray. Every branch started at 83bee2a (0.35.0) and wrote its invariant section as §51. Here they
are §51–§55 in merge order, and the sections above use the final numbers:

| § | Part | Checks |
|---|---|---|
| 51 | Agent health | 7 |
| 52 | Signed revocation | 9 |
| 53 | Automatic agent self-update | 11 |
| 54 | Test stacks and the GeoIP database | 4 |
| 55 | The tray | 14 (and §45 rewritten for the tray: 12 checks, from 11) |

Check and test counts inside each part's section are that branch's own; the integrated counts are under
*Verification (integrated)*. Where the branches met:

- **Invariants.** Each merge after the first conflicted only at the end of `check-security-invariants.mjs`, where
  each branch had appended its §51. All sections were kept and renumbered. Cross-references were fixed where they
  named a number: `docs/rmm-gap-analysis.md` (the Console polish row's §51 is §54; the self-update and revocation rows
  now name §53 and §52). `monitoring/engine.ts`'s "§51" is agent health's and stays. The tray's own references (`docs/tray.md`, `internal/tray/catalog.go`, `internal/tray/os_windows.go`) now say §55.
- **`run-e2e.sh`.** Agent health and self-update both appended to the self-starting list; it ends `agent-health
  agent-auto-update`, with `tray` after `chat`. Revocation's suite has its own `RELEASE_BIN` / `ACTION_SIM` / pwsh gate, and
  `AGENT_AUTO_UPDATE=off` is exported beside the other switches.
- **`docs/rmm-gap-analysis.md`.** The Console polish row takes docs-fresh's 0.36 wording, followed by agent health's
  row. The *Not implemented* bullet combines agent health's "the agent-silent alert is done" with docs-fresh's "the
  login ink and the guide's dashboard screenshots are fixed", and keeps self-update's own bullet.
- **Client-update sweep and service.** Agent health (re-resolving queued requests, `updatePolicyId`) and self-update
  (`agentMode` on the policy, its fresh-authentication rule) touched different functions and merged without conflict.
  The two are independent: `reconcileQueued` keys on the RustDesk policy's `enabled`, self-update's mode resolver on
  `agentMode`, so a policy with RustDesk updates off can still govern agent updates, and the reverse.
- **Heartbeat path.** `enrollment.service.ts` and `windows-script.ts` merged without conflict between agent health
  (the snapshot quiet window), self-update (the flag step and the signed daily check) and the tray. The tray adds the tray download and Run entry to the standard installer, the tray-host start to the signed heartbeat, `/tray/pair` from the SYSTEM heartbeat and the `windows/rem0te-tray.exe` signed target; self-update's daily `rem0te-agent.exe update` check and revocation's per-job statement fetch (in `action_windows.go` and `internal/agent`, not the heartbeat) sit beside it unchanged. The merged generated installers and heartbeats parse under PowerShell 7 (`unit-agent-auto-update`, `unit-tray`, `unit-signed-installer`).
  `unit-signed-installer`'s legacy/signed line-count tolerance stays at self-update's 140; the integrated gap is
  84 (1,614 against 1,698) lines.
- **Signer and Go action package.** Only revocation touched them. §14 (the exact action catalog), §39 (script run)
  and §40 (software deployment) still hold on the merged tree.
- **Shared lists are unions:** `ci.yml` (`unit-agent-health`, `unit-agent-auto-update`, `unit-tray` — every
  `unit-*.mjs` in `apps/api/scripts` is in CI), `e2e-ui.mjs` (docs-fresh's map, banner and accent checks and the mmdb
  fixture; self-update's `AGENT_AUTO_UPDATE: 'off'`; the tray's `assistWindow` and `TRAY_SWEEP: 'off'`), `help/page.tsx`, `docs/server-sizing.md` (agent health's
  bench figures, untouched by the others) and the docs bundle (40 pages; `tray.md` was added to ORDER by the tray branch). Generated files
  (`docs/API-REFERENCE.md`, `docs-content.generated.ts`) were regenerated rather than merged.
- **`CLAUDE.md`:** one paragraph per new section (§51–§55); §45's paragraph now describes the tray rather than the removed Win32 window, §44's note that `TRAY_SWEEP` and `AGENT_AUTO_UPDATE`
  joined the sweep switches, and a *Things that will bite you* entry: `AGENT_AUTO_UPDATE=off` and `SNAPSHOT_QUIET=off` are test
  or diagnostic switches.
- **The 0.34 chat host and window are gone; their references are not.** The tray branch deleted
  `internal/chat`'s host, client, protocol and transcript and `chatui_windows.go`. `e2e-chat.mjs` and
  `lib/chat-device.mjs` still named `internal/chat/client.go` as the thing they imitate; they now say it is the chat
  protocol 1 that 0.34 agents in the field still speak (the `/enrollment/chat/*` routes stay for them).
  `docs/chat.md`'s fast-path paragraph says a 0.36 agent starts the tray instead. Nothing in code or the invariants
  imports or reads a removed file: §45's agent checks read `internal/chat/text.go` (kept) and `internal/tray`.
- **`schema.prisma`.** The tray branch had realigned `ClientUpdatePolicy`'s columns; self-update had added
  `agentMode` to the same block. The merge keeps `agentMode` in the tray's alignment. `prisma format` was not run over
  the whole file (it would rewrite 300 unrelated lines).
### Verification (integrated)

Run on the final tree, with all five parts merged and the release bookkeeping in place. The database was
`rem0te_integrate36_test`, created empty for each full run. Steps 1–4 were also verified together before the tray
was merged (all of `run-e2e.sh` passed then too).

- **Static:**
  - `scripts/check-security-invariants.mjs`: **439 checks hold**, including §51–§55. Before 0.36 there were 393.
  - `check-versions.mjs` passes, and so does `gen-integration-contracts --check` (18 schemas, 11 signed examples).
  - `pnpm -r lint` exits 0, and `tsc --noEmit` exits 0 in both apps.
  - `prisma generate`, `nest build` and `next build` succeed.
- **Prisma:** all 55 migrations, 0000–0063, apply to the empty database (0048, 0058 and 0061 are unused). `prisma
  migrate diff` from the migrated database to `schema.prisma` reports *No difference detected*.
- **Production manifest:** no branch changed an npm dependency. `pnpm deploy:manifest` gives 0.36.0 with 30
  dependencies and no devDependencies, and `npm install --omit=dev --package-lock-only` exits 0 with 0
  vulnerabilities. The Go module gains `github.com/wailsapp/go-webview2` v1.0.23 (and its indirect
  `github.com/jchv/go-winloader`) for the tray's chat window; `go mod verify` passes.
- **Routes:** `docs/API-REFERENCE.md` was regenerated and has 501 routes across 73 controllers (476 in 0.35, plus 1
  revocation relay, 2 agent-auto-update settings routes and 22 tray routes). `--check` against the RouterExplorer
  log of `run-e2e.sh`'s scratch API matches exactly (501 / 501). The docs bundle is 40 pages.
- **Go agent (`tools/windows-installer`):**
  - `go test -count=1 ./...`, with PowerShell 7.4.6 on `PATH`: 163 top-level tests, 258 with subtests, all pass,
    none skipped.
  - `GOOS=windows GOARCH=amd64 go build ./...` and `go vet ./...` pass, and `go vet ./...` passes for Linux.
  - The `rem0te-release` and `rem0te-action-sim` builds (as CI builds them) succeed, and so does the tray as a
    release builds it (`GOOS=windows go build -trimpath -ldflags "-H=windowsgui -s -w" ./cmd/rem0te-tray`).
- **Unit scripts, every one in `ci.yml` (33, the same set as `apps/api/scripts/unit-*.mjs`), all exit 0, with pwsh
  on `PATH`:**

  | Script | Passed |
  |---|---|
  | `agent-auto-update` | 89 |
  | `agent-health` | 52 |
  | `agent-migration` | 57 |
  | `ai-timeline` | 24 |
  | `approval-signer` | 207 |
  | `audit-chain` | 35 |
  | `chat` | 52 |
  | `device-views` | 77 |
  | `diagnostics-catalog` | 110 |
  | `dynamic-groups` | 68 |
  | `email` | 122 |
  | `group-policy` | 38 |
  | `hbbs-peer-snapshot` | 29 |
  | `integration` | 35 |
  | `macos-agent` | 27 |
  | `metric-history` | 42 |
  | `monitoring` | 100 |
  | `patch-policy` | 163 |
  | `patch-summary` | 27 |
  | `polish` | 25 |
  | `presets` | 26 |
  | `retention` | 47 |
  | `script-library` | 125 |
  | `script-run` | 136 |
  | `search` | 37 |
  | `session-mutations` | 30 |
  | `signed-installer` | 52 |
  | `snapshot-schedule` | 85 |
  | `software` | 146 |
  | `system-inventory` | 92 |
  | `tray` | 67 |
  | `update-signing` | 16 |
  | `update-window` | 85 |

  `build-approval-signer --list` also exits 0. `unit-signed-installer`'s legacy/signed line-count gap is 84 (1,614
  against 1,698 lines) under its ±140 tolerance; the tray grew the standard script more than the signed one, so the
  tolerance was not raised.
- **`scripts/run-e2e.sh`:** run in full on the fresh database, with `RELEASE_BIN` / `ACTION_SIM` built from this tree
  and `PWSH` (PowerShell 7.4.6) set. **All 56 suites passed and none were skipped.** Passed counts:

  | Suite | Passed |
  |---|---|
  | `credentials` | 44 |
  | `security-features` | 42 |
  | `presets` | 114 |
  | `monitoring` | 108 |
  | `integration` | 77 |
  | `dashboard` | 53 |
  | `diagnostics-catalog` | 70 |
  | `system-inventory` | 68 |
  | `device-list` | 115 |
  | `endpoint-visibility` | 114 |
  | `device-views` | 142 |
  | `dynamic-groups` | 98 |
  | `add-device` | 62 |
  | `auto-updates` | 73 |
  | `group-policies` | 77 |
  | `reports` | 104 |
  | `script-library` | 138 |
  | `linux-agent` | 86 |
  | `macos-agent` | 106 |
  | `enrol-stepup` | 67 |
  | `search` | 113 |
  | `metric-history` | 59 |
  | `retention` | 43 |
  | `presence-cache` | ALL PASSED |
  | `ai-timeline` | 61 |
  | `email` | 92 |
  | `chat` | 89 |
  | `tray` | 142 |
  | `polish` | 49 |
  | `auto-snapshots` | 79 |
  | `agent-health` | 69 |
  | `agent-auto-update` | 96 |
  | `containment` | 70 |
  | `approved-action` | 76 |
  | `staged-patching` | 94 |
  | `maintenance-actions` | 64 |
  | `patch-policies` | 98 |
  | `software-deploy` | 156 |
  | `signed-updates` | 46 |
  | `ticket-workflow` | 53 |
  | `agent-upgrade` | ALL PASSED |
  | `script-run` | 81 |
  | `revocation` | 44 |
  | `smoke` | end-to-end proof passed |
  | `full` | FULL END-TO-END PROOF PASSED |
  | `business-access` | 83 |
  | `offboarding` | 63 |
  | `public-api` | PUBLIC API END-TO-END PROOF PASSED |
  | `public-address` | 43 |
  | `rollouts` | 46 |
  | `security-audit` | 57 |
  | `session-mutations` | 43 |
  | `support-requests` | 47 |
  | `sso-passkeys` | 70 |
  | `candidate-password` | ALL PASSED |
  | `secreg` | All security regression checks passed |

  **Fixed in `run-e2e.sh`: a readiness race on a re-run.** The first full run on the final tree reported `full` and
  `offboarding` failed, each at once with `fetch failed`, with an empty API log. The scratch-API loop starts each API
  in the background with `> "$OUT/api-$t.log"` and then greps that file for *listening on*. The redirect runs in the
  background job, so the grep can read the file before it is truncated. With an `E2E_OUT` left over from an earlier
  run (here the pre-tray run's), it found the old run's *listening on*, and the suite started before its API was
  listening. CI never saw it because its log directory is always new. The loop now empties the log before it starts
  the API. The passing run above reused the same stale log directory on purpose.
- **`e2e-ui.mjs`, as CI runs it** (ports 3501–3504, against the database of the first final `run-e2e.sh` run, after it, as CI orders them;
  the race below does not touch it): **915 passed,
  0 failed**, including the tray's `/assist` window checks and the search-palette suite (24).
- **Not run:**
  - `e2e-navigation.mjs`: it needs the docs stack and is run by hand (docs-fresh ran it: 350 passed).
  - `bench-heartbeat.mjs` was not re-run on the integrated tree; agent health's figures stand.
  - Nothing ran on real Windows: not the tray, the tray host, WebView2, the agent's revocation check or the signed
    daily update check.
### Upgrade notes (all of 0.36)

- **Schema change: three migrations.** Take a `pg_dump` first. Then:
  1. Run `prisma migrate deploy`.
  2. Rsync `apps/api/prisma/` to the target.
  3. Run `npx prisma generate` there, as `CLAUDE.md` describes.

  Without steps 2 and 3 the API throws `Unknown field` on the first heartbeat (`updatePolicyId`, `agentMode`, the
  tray columns).

  | Migration | Adds |
  |---|---|
  | `0060_agent_health` | `AGENT_SILENT` in `MonitorKind`; `RustdeskNode.updatePolicyId` (plain text, no foreign key); audit actions `CLIENT_UPDATE_AUTO_WITHDRAWN` and `CLIENT_UPDATE_AUTO_REPLANNED` |
  | `0062_tray` | `AssistCode`, `AssistSession`, `SupportRequestAttachment`, `TraySelfHelpRun`; chat-recording settings on `Customer` and `PlatformSettings`; `recorded` / `startedBy` on `ChatConversation`, `technicianSeenAt` on `ChatMessage`; the tray key and `trayProtocol` on `Endpoint` |
  | `0063_agent_auto_update` | an agent-mode enum and `ClientUpdatePolicy.agentMode` (nullable: inherit); three `RustdeskNode` and three `PlatformSettings` columns; the `AgentAutoUpdateAttempt` table; CHECKs on every bound |

  0061 is unused.
- **Deploy order: signer, portal, then the agent once it is published.**
  1. Rebuild and redeploy the approval signer (`apps/api/scripts/build-approval-signer.mjs`). It creates
     `software-revocations/` and `revocations.json`, and starts serving `GET /internal/v1/revocations`.
  2. Then the portal (API and web). Its public relay, `GET /api/v1/public/approval/revocations.json`, answers 503
     until the signer answers.
  3. Then, when the owner publishes it, the 0.36 signed agent. It runs no new plan without a fresh statement, so the
     relay must work before that agent ships.
- **Run `software revoke` once for every software entry archived before 0.36.** Those archives happened only in the
  portal and were never revoked on the signer, so a plan signed before the archive stays runnable inside its window,
  on new agents too. The ids come from the portal's database, and the revoke runs on the signer host:

  ```bash
  # portal database: the entries archived before the upgrade
  psql "$DATABASE_URL" -tAc 'SELECT id FROM "SoftwareCatalogEntry" WHERE "archivedAt" IS NOT NULL'
  # signer host, once per id
  node dist/approval-signer/main.js software revoke --entry <id> --reason "archived before 0.36"
  node dist/approval-signer/main.js software list        # what the signer has revoked
  node dist/approval-signer/main.js revocations show     # seq counts every revocation
  ```

  Revocation is one-way and idempotent. Scripts revoked before 0.36 need nothing: the signer already lists their
  hashes.
- **Automatic agent update is on by default.** The first round after the deploy reaches every outdated Windows agent:
  every one, because the standard agent reports the platform version and every release counts as an agent update.
  It is paced at **120 attempts an hour** across the platform (5,000 outdated computers take about 42 hours), each
  attempt re-downloads the RustDesk client (about 40 MB), and a computer gets at most three attempts per release.
  To defer it:
  - switch it off in **Settings → Client updates → *Keep agents up to date automatically*** — the setting lives in
    the database, so set it after `migrate deploy` and before the restart; or lower the pace there; or
  - set a business, site or group policy's agent mode to *Off* (a pilot group set to *Any time* under a business
    *Off* gives a canary by hand); or
  - run the API with `AGENT_AUTO_UPDATE=off`, and take it out afterwards (it is a test switch; see `CLAUDE.md`).

  Agents older than 0.13.0 have no device secret and are never asked; Linux and macOS agents are never updated from
  the server. Their Agent card gives the command.
- **The default accent's text colour changes.** On the sign-in band and the Quick Connect page, text on the accent
  now takes black or white by WCAG luminance. The default `#3B82F6` gets **black** (5.71:1, against 3.68:1 for
  white), so every unbranded install sees black text there. A business with a dark accent sees no change.
- **What needs the owner's signed release.** Nothing in this list does anything until a signed release built from
  0.36 is published with the owner's keys:
  - the agent's revocation check (agents before 0.36 never fetch the statement; the portal-side cancel of undelivered
    revoked targets works today);
  - the signed agent's own daily update check (until then signed agents update when the portal asks, which works
    wherever a signed build is published);
  - the signed tray, `windows/rem0te-tray.exe`, built with `GOOS=windows go build -trimpath -ldflags "-H=windowsgui
    -s -w" -o rem0te-tray.exe ./cmd/rem0te-tray` and added with `-add windows/rem0te-tray.exe=…`
    (`docs/update-signing.md`). A release without it installs no tray, and the agent reports no chat.

  Not needing keys: the agent-silent monitor, queued-update re-resolution, automatic update of standard agents
  (they act on flags they already have), and the standard agent's tray (served by the portal and pinned by hash in
  the install script, on the next installer run from this portal).
- **Behaviour changes for API consumers:**
  - `MonitorKind` can be `AGENT_SILENT`; `GET /admin/monitoring/rules` adds `optional`. `AGENT_SILENT` alerts are not
    sent to ClientSt0r (not a contract kind).
  - Archiving a software entry with a signer configured that does not confirm the revocation now fails
    `409 APPROVAL_SIGNER_REFUSED`, and nothing is archived.
  - The signer refuses a software plan naming no catalog entry (`software_entry_missing`).
  - New routes: the revocation relay, `GET`/`PUT /admin/agent-auto-update`, and the tray's routes. 501 routes in
    all.
  - The device list adds `agent=outdated`.
- **New environment switches, all for tests or diagnostics:** `AGENT_AUTO_UPDATE=off`, `SNAPSHOT_QUIET=off`,
  `TRAY_SWEEP=off`. None should be set in production.
- **No production dependency changed.** The target manifest does not need regenerating; `pnpm deploy:manifest` still
  resolves under npm (see *Verification (integrated)*).
- **Not run on real Windows.** The tray, the agent's revocation check and the signed daily update check ran only in
  unit tests, `rem0te-action-sim` and PowerShell 7 on Linux.

---

## [0.35.0] — 2026-11-12 · *Lantern*

The fifth increment of the RMM overhaul. Its theme is a console that tells the truth about what it can see. Four
parts were built separately from 0.34 and integrated here:

- **An honest online state.** A computer RustDesk can reach whose agent has stopped checking in is now amber
  *Reachable (RustDesk) · agent silent 12 d*, never a green *Online*. This was reported against a real computer whose
  agent had been silent for twelve days. The device list, device page, dashboard, map, search and every other list
  read it the same way.
- **Device groups as a policy scope.** A static or rule-based group can carry a monitor or an automatic
  client-update policy, with a priority to settle overlaps. The device page now lists the groups a computer is in.
- **Snapshots that refresh themselves.** The Processes, Services and Network tabs used to say "Never taken" on almost
  every computer. The server now asks for them on the heartbeat, every 6 hours and every 5 minutes while a tab is
  open.
- **The 0.34 screens, driven in a browser.** Chat, the Run panel, the software catalog, Email settings, scheduled
  reports, the Agent card, the AI summary and the retention card are now covered by `e2e-ui.mjs` in CI. Doing that
  found four bugs, which are fixed.
- **Polish.** The dashboard fits the window, with the map shown. Linux and macOS computers are no longer described as
  Windows. Pages that had no side padding have it. The drawer and sidebar ink is readable on any accent. Reports gain
  *Schedule this report*, and the device-list filters work at phone width.

Two migrations (`0057_group_policy_scope`, `0059_auto_snapshots`); no production dependency changed; nothing needs
the owner's keys. Behaviour changes for API consumers are listed under *Upgrade notes*.

A note on length: 0.34.0's entry was too long for a GitHub release body (about 149,000 characters against GitHub's
125,000 limit). This entry keeps its core well under 100,000 characters. The detail is in the per-part subsections,
and nothing was dropped.

### Device-group policies

#### Added
- **A device group is now a policy scope for monitors and automatic client-update policies.** Until now a monitor
  could be set globally, for a business, a site or one computer, and a client-update policy only for a business or a
  site. So "these twelve tills get a stricter disk monitor" or "kiosks never update on their own" meant either a site
  that did not match reality or a monitor per computer. A static or rule-based group (0.34) can now carry either.
  - **Precedence, most specific first:** computer > device group > site > business > global. The winner replaces
    everything below it, the same way a site override always has. For monitors this is decided per key. A group
    policy that is *off* keeps its computers off even when the business policy is on.
  - **A computer in several groups.** Every group policy carries a **priority** from 1 to 999, and the lowest wins.
    Priorities are unique per business (for monitors, per business and key). A clash is refused with
    `PRIORITY_TAKEN` (409), and the database enforces it with partial unique indexes. If a tie ever reached the
    resolver, it would be broken by policy id, never by the order rows came back.
    We chose a priority over refusing overlapping groups because overlap is not a property of the policies. A rule
    group's members change by themselves: a computer goes offline, or reports a new RustDesk version. A save-time
    overlap check would be true when it ran and false an hour later.
  - **Membership is computed, never stored.** A static group's members are its membership rows. A rule group's
    members are its business AND its rule AND `endpointVisibilityWhere` for the business as a whole, through the
    device list's own `EndpointListService.evaluateRuleGroups`.
    - A computer that stops matching loses the group's policy at the next evaluation. The next heartbeat asks it
      about the inherited monitors instead, and the next sweep closes the group monitor's open alert.
    - A rule that no longer parses matches nothing.
    - A rule that picks computers by their **alerts** cannot carry a policy (`GROUP_READS_ALERTS`), because a
      monitor would then decide its own scope. A group carrying a policy cannot have its rule changed to read alerts.
  - **Seeing the winner.** The computer's Monitoring tab says where each monitor was set and what it beat ("set for
    group Tills (priority 2) — ahead of group Kiosks (priority 5) on priority — replacing business Acme").
    - The Updates card gains a *Client-update policy* row backed by `GET /client-updates/computers/:endpointId/policy`.
    - Settings → Client updates gains a *Device groups* card (live member counts, precedence order) and a *Policy*
      column.
    - Settings → Monitoring takes a group and a priority, and both can be edited.
  - New route `DELETE /client-updates/policy/groups/:groupId` (step-up required). 474 routes in all.
  - New page `docs/group-policies.md`. `docs/monitoring.md`, `docs/updates.md`, `/help` and
    `docs/rmm-gap-analysis.md` were updated.

#### Decided against
- **Group-scoped notification policies.** Editing a group's rule needs no step-up. If that could change who hears
  about an alert, it would be a way round §17's fresh-authentication rule on changing who is notified. Group monitors
  decide what is watched, never who is told.
- **Group-scoped patch-policy rings.** The approval signer signs a ring plan that names computers, and refuses any
  computer the approvers did not see. A ring of "group Tills" would either need re-approval every time membership
  moved, or silently widen what two people approved. Rings stay lists of named computers. Picking a ring's computers
  from a group as a one-time copy would fit the model, but it is not built.
- **A per-computer client-update policy.** The one-off is still the Update button.

#### Security
- Another business's group is a **404** for monitors and for client updates, the same as a made-up id. A trigger
  (`group_policy_same_business`, 0057) also refuses it in the database.
- Turning a group client-update policy on needs fresh authentication, as for a business policy, and so does
  **removing** one. Its computers fall back to a site or business policy that may be on.
  - Deleting a group that carries a policy is refused (`GROUP_HAS_POLICIES`, 409, with NO ACTION foreign keys
    underneath), so deleting the group is no way round the step-up.
  - The client-update controller now passes `isFresh(req)` on three writes, and the existing invariant was updated
    from 2 to 3.
- Invariant **§46** has 9 checks (the branch numbered it §46; it keeps it):
  - membership is never stored and is kept on nothing between ticks;
  - rule groups go through the list's evaluator with visibility AND-ed;
  - precedence is never by row order;
  - the database refuses ties, mixed scopes, cross-business groups and group deletion;
  - cross-business is a 404;
  - step-up is needed on enable and remove;
  - notification stays global or business (§17);
  - the per-computer route is read through `assertEndpointInScope`.

  Each of the 14 mutations of those guards was caught, and each was restored afterwards.

#### Fixed (found while building this)
- **The 0033 index `ClientUpdatePolicy_business_row` (`WHERE "siteId" IS NULL`) would have counted every group policy
  as a second business policy.** The symptom was a 409 on the first group policy. 0057 recreates it with
  `AND "groupId" IS NULL`.

#### Measured
`apps/api/scripts/bench-group-policy.mjs` used one business with 5,000 computers and 50 rule groups covering every
policy-usable condition, with a monitor on each group and a client-update policy on 49. These are medians on the
development server:

| What | Median | Worst |
|---|---|---|
| Membership snapshot | 0.6–0.9 s | — |
| Monitor sweep (baseline 0.4–0.7 s) | 1.5 s | — |
| Client-update sweep membership | 0.7 s | — |
| Heartbeat monitor block, no group monitor of an agent kind | 12 ms | — |
| Heartbeat monitor block, all 50 groups carrying service monitors | 84 ms | 220 ms |
| Client-update hold, only while a POLICY request is queued | 41 ms | — |
| Device page | 92 ms | — |

Both sweeps stay well inside their tick, so membership is computed fresh each tick and not cached.

The heartbeat evaluates only the groups that can change its answer: those carrying a monitor whose key has a
service or event monitor. Its cost grows with that number, not with the number of computers.

#### Known limits
- A computer that leaves a group keeps a POLICY update already queued under the group's policy until the next
  client-update policy save for the business withdraws it. Meanwhile the heartbeat holds it with `policy_off`.
- The device page shows the winning group and the groups it beat. It does not list every rule group the computer is
  in.
- The web pages were type-checked and built, but not driven in a browser.

#### Upgrade notes
- **Schema change**, migration `0057_group_policy_scope`. It adds `groupId` and `priority` to `MonitorRule` and
  `ClientUpdatePolicy`, with CHECK constraints, partial unique indexes and the same-business trigger, and it
  recreates `ClientUpdatePolicy_business_row`.
  - Run `prisma migrate deploy`.
  - Rsync `apps/api/prisma/` and run `npx prisma generate` at the target. Without this, the API throws
    `Unknown field groupId`.
- No production dependency changed, and no setting was added. Existing policies are untouched: no group policy
  exists until someone creates one.

#### Verification
- `unit-group-policy.mjs`, the resolver, precedence, explanation and engine scope keys: **38 passed, 0 failed** (new,
  in CI).
- `e2e-group-policies.mjs`, port 3541, added to `run-e2e.sh`: **77 passed, 0 failed**. It covers:
  - precedence across computer, group, site and business;
  - multi-group priority conflicts and `PRIORITY_TAKEN`;
  - a computer leaving a rule group and losing its monitor and client-update policy on the next evaluation;
  - unreadable and alert-reading groups;
  - step-up on enable and remove;
  - group deletion refused;
  - Business A against B isolation (404s).
- Existing suites touched by the change, all passing:

  | Suite | Result |
  |---|---|
  | `e2e-monitoring` | 108 passed |
  | `e2e-auto-updates` | 73 passed |
  | `e2e-dynamic-groups` | 98 passed |
  | `e2e-device-views` | 142 passed |
  | `e2e-reports` | 104 passed |
  | `unit-monitoring` | 91 passed |
  | `unit-update-window` | 85 passed |

- `check-security-invariants.mjs`: all hold, including §46 (the branch's own count; the integrated count is under *Verification (integrated)*). `check-versions.mjs` passes. `pnpm -r lint`, `tsc
  --noEmit` in both apps, `nest build` and `next build` all pass.
- `docs/API-REFERENCE.md` was regenerated and matches the runtime route table (474). The docs bundle was regenerated
  (39 pages).

### The 0.34 screens, driven in a browser (and what that found)

Several 0.34 screens — the Chat tab, the software catalog and compliance
report, scheduled reports, Email settings, the Agent card, Agent migrations,
the History tab's AI summary and the Data retention card — were typechecked
and built but never opened by a test, and `e2e-navigation.mjs` had been
extended by four branches without ever being run. Both suites now run, pass,
and cover them; the browser found four real bugs and three stale tests.

#### Fixed
- **The Run panel offered Request a run and Revoke on a server with no
  approval signer.** On an approved version whose allowlist entry the portal
  had last mirrored as ACTIVE, the panel said "No approval signer is
  configured on this server, so scripts cannot be run here" and, beside it,
  showed the run form and *Revoke permanently*; both fail at the signer. The
  readiness answer (`script-run.service.ts`) now sets `canRun` and
  `canRevoke` only when a signer is configured, as `canPropose` already did
  through the panel. With a signer nothing changes (`e2e-script-run` 81/81).
- **Saving Email settings brought the form back blank.** The form is rebuilt
  from the cached settings the moment it is cleared, and was cleared before
  the cache held what had just been saved — so a configured, switched-on relay
  reappeared as `smtp.example.com`-placeholder fields with *Send email*
  unticked, one Save away from switching outbound email off. The save now
  puts its answer into the cache first.
- **Email's "Send a test email" widened the page at 375 px.** The *To*
  select's option names the account address in full; with a configured relay
  (the card only shows then) it pushed `<main>` 58 px sideways. It now shrinks
  to the screen.
- **Agent migrations had no menu entry.** `/endpoints/agent-migrations` could
  be reached only from an Agent card's link, while three docs pages already
  said "Devices → Agent migrations". It is now a Devices tab, shown to whoever
  may request a migration (`computers:edit`); the page and its API still need
  only `computers:view`, and the Agent card still links to it.

#### Tests that were wrong, not the app
- `e2e-navigation.mjs` expected Settings without *Client updates* (in the menu
  since 0.32), took the Services tab's sortable *Start mode* column header for
  an action button, and checked the Business User's Agent card on a computer
  that user cannot see (it now grants that persona the one computer, removed
  with the user).

#### Coverage added
- `e2e-navigation.mjs` (docs stack): the Agent migrations tab and page for
  each persona (a Business User reaches it by the Agent card's link, with no
  tab bar); the Agent card on Overview; Software compliance and Scheduled
  reports content; the Email SMTP form; the Data retention card.
- `e2e-ui.mjs` (CI, its own stack), at 1440 and 375 px in light and dark, in
  separate functions (`chatTab`, `scriptRunPanel`, `softwareCatalog`,
  `emailSettings`, `scheduledReports`, `agentCardAndMigrations`,
  `aiHistoryPanel`, `retentionCard`):
  - Chat: start, send, and the receipt moving sent → delivered → shown →
    read only as a simulated computer acknowledges over the real device
    routes; presence (*no user*, *window open for ACME\frontdesk*); the
    person's reply rendered as text; End chat.
  - The Run panel on an unproposed and an allowlisted approved version, with
    no signer: says so, offers nothing to propose, request or revoke.
  - Adding a software catalog entry (pasted hash) through step-up, then the
    software compliance report listing it.
  - Email: a loopback relay saved through step-up, the form showing it, and a
    test email received by a loopback SMTP sink.
  - A scheduled report created through step-up to a confirmed address.
  - The Agent card (with an open migration request) and Agent migrations
    reached from it, counting the request as Pending.
  - The History tab: "Needs ClientSt0r support for device_timeline_v1", with
    Generate off, against a reference ClientSt0r peer whose signed
    capabilities document lists only ticket triage.
  - The Data retention card, strictly.
  Every step-up flow first forgets the ten-minute step-up cookie, so each is
  proven to ask. Any console error or failed request still fails the run.
- The device side of chat and the SMTP sink moved into
  `apps/api/scripts/lib/chat-device.mjs` and `lib/smtp-sink.mjs`, shared by
  `e2e-chat.mjs`, `e2e-email.mjs` and `e2e-ui.mjs`.
- `UI_COMBOS=desktop/light,…` narrows a debugging run of `e2e-ui.mjs`; a
  narrowed run always fails.

**Security invariants**: §47 (§46 on the branch) holds the two app fixes (Run panel needs a
signer to offer a run or revoke; the Email save rebuilds from what was saved)
and the suite's own hygiene (its SMTP sink and reference peer listen on
loopback, on ports the refusal list covers; the global SMTP settings it
changes are restored). Each check was shown to fail with its guard removed.
§44's port check now also accepts the two new ports in its loop.

**Upgrade notes**: none — no migration, no new route, no new environment
variable for the server. CI's `e2e-ui.mjs` step now also uses ports 3503
(SMTP sink) and 3504 (reference peer); `UI_SMTP_PORT` / `UI_PEER_PORT` move
them.

**Verification**: `e2e-ui.mjs` 610 passed, 0 failed (with the search
palette suite); `e2e-navigation.mjs` 350 passed, 0 failed (docs stack);
`e2e-chat` 89/89, `e2e-email` 92/92, `e2e-script-run` 81/81;
`check-security-invariants` 370 checks; lint, both `tsc --noEmit`,
`nest build` and `next build` clean.

### Polish: an honest online state, a dashboard that fits the screen, groups on the device page, and smaller fixes

#### Fixed
- **A computer whose agent had been silent for twelve days showed a green
  "Online".** It was reported against a real Windows computer: agent 0.18.25,
  `lastSeenAt` twelve days old, `isOnline = true`, drawn green on the device
  list, the device page and the dashboard.

  The cause is a design choice, not a bug in the sweep. Since 0.19.3
  `isOnline` is true when the agent heartbeats **or** the RustDesk server
  (hbbs) can reach the peer. `markStaleEndpointsOffline` deliberately keeps
  it true for a silent agent while hbbs reports the peer, because Connect
  still works. The console drew that flag as one green "Online". So a computer
  whose monitoring, patching, inventory and actions had stopped twelve days
  earlier looked as healthy as one checking in now. Its "last seen" was right,
  but nothing told you to read it.

  **The sweep is unchanged.** What changed is how the console reads the flag.
  `connectivity` is derived from `isOnline` and `lastSeenAt` against
  `HEARTBEAT_STALE_MS` (`apps/api/src/common/connectivity.ts`). It has three
  states:

  | State | Colour | When | Wording |
  |---|---|---|---|
  | `online` | green | the agent checked in within the window | Online |
  | `agent_silent` | amber | `isOnline` with no heartbeat inside the window, never reported included | *Reachable (RustDesk) · agent silent 12 d* |
  | `offline` | grey | not reachable | Offline |

  The amber tooltip says remote control should work, that monitoring, patching
  and actions are not reporting, and suggests **Update agent** on the Agent
  card.

  The API now sends `connectivity` on:
  - the device list rows and the device page;
  - `GET /endpoints` and `GET /endpoints/mine`;
  - search results;
  - the dashboard overview (attention and recent items) and the map's points
    and markers;
  - the RustDesk client-update list, from the endpoint's own heartbeat: a
    client update is delivered on that heartbeat, so a silent agent never
    takes one.

  The web derives the same answer, with the same window, for payloads that
  carry only `isOnline` and `lastSeenAt`.

  Every place that drew "Online" from `isOnline` now uses it:
  - the device list's dot, *Last seen* and agent cells;
  - the device page header;
  - the dashboard tiles, attention and recent lists, and the map (amber
    markers, with a legend entry);
  - the Ctrl+K palette;
  - My computers, Business → computers, Unassigned, Tactical RMM matching,
    rollout jobs, Client updates, RustDesk updates;
  - the technician and script-run computer pickers;
  - Add device's health row, the Patches tab's *Connection* row, Agent
    migrations, and both Offboarding pages.

  The technician dashboard's count of remote-controllable computers is now
  labelled *Reachable*, because that is what it counts. The *Sessions* page's
  green dot is left alone: it marks a computer in an open session.

  **The window is 30 minutes, not 10.** The method default and the web
  constant both said 10, but the sweep has always been called with 30
  (`enrollment.controller.ts`, every minute). There is now one constant,
  `HEARTBEAT_STALE_MS = 30 min`, and the sweep's default reads it, so the
  sweep behaves exactly as before. The web copy in `apps/web/lib/connectivity.ts`
  must equal it, which §49 checks. `device-model.ts` re-exports the web copy
  instead of keeping its own.

- **Any device-list link without `platform` in it crashed the list** (0.34).
  This included the palette's site and "see all" links, and the new group
  links. `readUrl`'s `pick` returned `null` for an absent key whose allowed
  values include `''`. `toParams` then threw on `.trim()` with *Cannot read
  properties of null*. It now defaults the same way for absent and empty
  keys.

- **Linux and macOS computers were described as Windows.** The dashboard
  read "Windows is waiting for a restart" for a Linux server. It now reads
  "Linux is waiting for a restart", or "the computer is …" when no platform is
  reported. On the device page:
  - the Overview's *Updates* row is *Package updates* (Linux), *Software
    Update* (macOS) or *Windows Update*;
  - the Patches tab names the package manager (Linux) or Software Update
    (macOS) as what manages patching, hides *Relevant KBs*, and says
    deployments are Windows only;
  - the monitoring *Restart pending* hint and the bulk *Refresh inventory*
    title are reworded the same way.

- **Patching and Script library pages had no side padding.** Each page
  supplies its own `p-4 md:p-6` (the shell does not), and eight pages had
  none:
  - `/patching`, a deployment, a patch policy;
  - the script library and a script;
  - the software catalog, a catalog entry, a software deployment.

  A static scan of every page found no others. The browser suite now checks
  every swept page's heading is at least 12 px from `<main>`'s edge.

- **The drawer close button and the sidebar header were unreadable on a
  pale accent.** They used fixed white or grey text. Both now take black or
  white, whichever contrasts more with the branding accent by WCAG 2.x
  luminance (`apps/web/lib/contrast.ts`). One of the two always reaches at
  least 4.58:1 on any opaque colour, which meets AA for normal text. With no
  accent set, the theme's colours are kept.

#### Changed
- **The dashboard fits the window.** Before, at 1440 × 900 the page was
  1586 px tall; at 1366 × 768 it was 1602 px; at 1920 × 1080 it was 1559 px.
  The map sat at the very bottom, below the fold at every desktop size.
  - **Now:** the page is exactly 900, 768 and 1080 px at those sizes, map
    shown. Measured as `<main>`'s scrollHeight against its clientHeight,
    because `<main>` is the shell's scroller.
  - **How:** from `lg` the page takes the height under the top bar (`h-12`).
    Below a single header row and the figures, a 12-column grid with three
    `minmax(0, …fr)` rows shares what is left. Every card's body scrolls
    inside the card (`min-h-0`), and no fixed pixel height is left: the map's
    old `h-[420px]` wrapper is gone.
  - **Layout:** the figures come first (devices with online / agent silent /
    offline, critical alerts, restart pending, patch compliance, failed
    actions, awaiting approval, active sessions). Then *Work on next*,
    *Devices needing attention* and *Customers affected*. Then the map
    (two rows tall) beside *Being worked on*, *Patch status*, *Recent
    activity* and *Your recent devices*.
  - Hiding the map (still remembered in `dashboard.map`, still shown by
    default) gives its column to *Work on next*.
  - Below `lg` the cards stack in the same order and the page scrolls down,
    never sideways (375 px checked).
  - **Cleaned up:**
    - Every card shares one header (title left, its link or note right) and
      the same padding and empty state.
    - The *Patch compliance* percentage appeared twice, as a tile and again
      as a 2xl figure in the card. The card is now *Patch status* and shows
      only the breakdown, coverage and definition.
    - The map toggle and the long *Server health (CPU, memory, disk, relay)
      is on System status* line moved from a row under the cards into the
      header, as *Hide device locations* and *Server health →*, with the full
      sentence as its tooltip.
    - The map card's header and padding match the others.
    - *Work on next*'s "top N of M" note is shortened, with the rest of the
      sentence as its tooltip.
    - No figure, list, link or feature was removed.
  - `screenshots.mjs` and `capture-media.mjs` find the map by
    `[data-testid="dashboard-map"]` instead of the removed class. The guide's
    dashboard images were not regenerated; that needs the docs stack.
  - A containment banner, when shown, sits above the page and adds its own
    height, so only then does the page scroll.

#### Added
- **Groups on the device page.** The Overview's Assignment card lists every
  group the computer is in: its static groups and the rule groups of its
  business it matches right now. Each links to the device list filtered by
  that group (rule groups are marked *rule*).
  - `GET /endpoints/:id` returns them as `groups`.
  - They are computed by the device list's own `evaluateRuleGroups`, as the
    caller and over that one computer. So they are always the list's *Groups*
    column for the same person: a rule group whose rule reads alerts is left
    out for someone without *monitoring:alerts*, and a Business User sees
    what the list shows them.
  - The scope check still runs first, so another business's computer is a 404
    and its groups are never computed.

- **Online filter: *Reachable, agent silent*** (`online=silent`, server-side).
  - `online=online` now means the agent is checking in.
  - Sorting by Online orders checking in, then agent silent, then offline.
  - The CSV export gains a **Connectivity** column after *Online*.
  - The dashboard's Devices tile reads "X online · Y agent silent · Z offline"
    and turns amber when any are silent, with a tooltip.
  - `GET /dashboard/overview` `devices` and `GET /dashboard` `endpoints` gain
    `agentSilent` and `reachable`.

- **Schedule this report.** Patch compliance, agent coverage, alert frequency
  and offline time each have it beside *Export CSV*. It opens *Reports →
  Scheduled reports* with the form prefilled from the report's current
  filters:
  - the business (a site implies it) and the site;
  - *silent days* for agent coverage;
  - the period for alert frequency and offline time: 30 days picks monthly,
    and any other period gets a note saying a schedule covers 7 or 30 days.

  It is shown only to people who may own a schedule (a Platform Admin, or a
  Business Owner in their own right), which is the API's rule; a Business User
  gets 403 from the API and no link. The prefill is cleared after a save.

- **Device-list filters on a phone.** At 375 px the filters sit behind a
  **Filters (n)** button beside the search, *n* being how many are set. It
  opens a bottom sheet with the same controls, each applying at once, and
  *Show N devices* closes it. The table now starts right under the search.
  Desktop is unchanged.

#### Upgrade notes
- **`online` on the device list now means "agent checking in".** This applies
  to the `online=online` filter, saved views and rule groups that use it. A
  computer reachable only through RustDesk has left them, and
  `online=silent` finds it.
- **The dashboard's `online` counts no longer include agent-silent
  computers.** This covers `GET /dashboard/overview` `devices.online`, the
  map's `points[].online` and `GET /dashboard` `endpoints.online`. Their
  `offline` counts still exclude those computers, and `reachable` is the old
  `online`.
- **The device-list CSV gains a column** after *Online*. A consumer that reads
  columns by position must allow for it.
- No migration. No change to the stale sweep or to `isOnline` in production.
- **`STALE_SWEEP=off`** (new, default on) stops the stale sweep in that
  process, as `MONITOR_SWEEP=off` does for monitoring. `e2e-polish` and
  `e2e-ui` set it, because their agent-silent fixtures need a lasting
  `isOnline` and there is no hbbs to keep it. The first UI run without it
  failed 9 checks once the sweep took the fixture offline a minute in. Never
  set it in production: machines would never go offline.

#### Not done
- The OFFLINE monitor still keys on `isOnline`, so an agent-silent computer
  raises no alert.
- The login and Quick Connect pages still put white text on the accent.
- The padding of the patch, policy and software *detail* pages is checked by
  the static scan only, not in the browser.
- The map's amber marker is covered by §49 and the code, not by an e2e: the
  suites run with no GeoIP database, so every computer is unlocatable.

#### Invariants
- **§48 (§46 on the branch), Groups on the device page.** `findOne` checks scope first and takes
  its groups from `deviceList.groupsOfComputer`, with no rule-group query of
  its own. That function evaluates only the computer's own business, as the
  caller, over that one computer, and drops a rule the caller may not
  evaluate (the alert gate). All 6 mutations were caught.
- **§49 (§47 on the branch), Reachable is not reporting.**
  - The API and web windows are equal, the sweep's default is the constant,
    the sweep is called with no literal, and `device-model` re-exports the web
    constant.
  - The list's `online` filter needs `lastSeenAt >= heartbeatCutoff()`,
    `silent` is the rest of `isOnline`, and rows carry `connectivityOf`.
  - The overview, `GET /dashboard` and the map count online from the heartbeat
    cutoff, never from `isOnline`.

  All 8 mutations were caught.

#### Verification
- `unit-polish.mjs`: 25/25, in CI. It covers:
  - connectivity's boundary exactly at the window, never-reported, clock
    skew, and the API and web copies agreeing on 20 cases;
  - the label and tooltip;
  - restart and update wording for 9 platforms, API and web;
  - ink at 4.5:1 or better on all 4096 colours of a 16-step grid (worst
    4.58:1).
- `e2e-polish.mjs` (new, port 3551, refuses a non-test database, in
  `run-e2e.sh`): 49/49. It covers:
  - groups on the device page for three viewers, matching the list's *Groups*
    column, the alert-rule group hidden from a Business User, archived and
    offline cases, edits recomputed, and B's same-named group never shown;
  - restart wording by OS, and schedule ownership;
  - connectivity on the list (rows, `online=silent|online|offline`, sort,
    CSV), the device page, `GET /endpoints`, My computers, search, the
    overview and `GET /dashboard`, and a rule group on `online=silent`;
  - business A/B isolation for each of these.
- Updated: `e2e-device-list` 115/115 (online now excludes agent-silent bulk
  fixtures; `online=silent` added) and `e2e-dashboard` 53/53 (counts now
  `online: 4, agentSilent: 1, reachable: 5`).
- Re-run unchanged: `e2e-dynamic-groups` 98/98, `e2e-search` 113/113,
  `e2e-endpoint-visibility` 114/114, `e2e-auto-updates` 73/73,
  `e2e-device-views` 142/142.
- `e2e-ui.mjs`: 616/616, including the search-palette suite (24). Added at 1440 and 375 px, light and dark:
  - the device page's group links followed to a five-member list;
  - a Linux computer's Overview and Patches tab with no Windows Update
    wording;
  - the Filters (n) sheet: it fits, applies at once, and its count goes up
    and back;
  - the drawer close button and header at 4.5:1 or better on three accents,
    measured from computed colours;
  - Schedule this report on four reports, absent on the fifth, prefilled for
    a business with 14 silent days;
  - no Schedule link for a Business User;
  - the padding check on every swept page, plus the scripts, software and
    schedules pages;
  - a twelve-day-silent computer drawn amber on the list and device page,
    with its tooltip, and counted apart on the dashboard;
  - the dashboard at 1440 × 900 and 1366 × 768, light and dark, map shown:
    the document's and `<main>`'s scrollHeight are at most the viewport,
    every grid panel (map included) is inside it, and nothing overflows
    sideways. At 375 px nothing scrolls sideways and the page stacks.
- Before and after screenshots (1440 × 900, 1366 × 768, 1920 × 1080, light
  and dark, plus 375 px) were taken on the scratch stack and looked at.
- Security invariants hold, version check passes, lint is clean, `tsc` is
  clean in both apps, and `nest build` and `next build` succeed.

### Automatic snapshots

#### Fixed
- **The Processes, Services and Network tabs said "Never taken on this computer. Refresh asks for one." on almost
  every computer.**

  0.33 added the three snapshots (`process_list`, `service_list`, `network_adapters`) as diagnostics-catalog keys,
  and a snapshot existed only once someone pressed Refresh. Nothing asked for one otherwise, so a computer nobody had
  opened had none, and an open tab never updated unless a Refresh was in flight (it polled only while one was
  pending). The owner's report: "values should be refreshed automatically, periodically as well as a manual refresh
  button." The inventory pass and the CPU/RAM/disk values did not have this problem (see *Checked* below).

#### Added
- **The server asks for each snapshot itself, on the heartbeat.** When a computer checks in and one of its snapshots
  is older than its interval, that heartbeat's response asks for it, as an ordinary `DiagnosticRun` with **no
  requester** (`requestedById` null, the convention `EndpointCommand` already uses for the automatic inventory pass).
  It is delivered, sanitised, capped at 128 KB and stored exactly like a manual run, and the tab shows it as taken
  *automatically*. There is no sweep over the fleet and no row per computer per tick: a computer that is not checking
  in is never asked, so nothing piles up for it. Code: `apps/api/src/diagnostics-catalog/snapshot-schedule.ts`
  (pure) and `DiagnosticsCatalogService.scheduleAutomatic`, called from `forHeartbeat`.
  - **Defaults:** every key every **6 hours** (the inventory pass's cadence), and every **5 minutes** while someone
    has the key's tab open (a snapshot read by someone who can see the computer in the last 90 s; the tab re-reads
    every 30 s). Why, at 5,000 computers (docs/server-sizing.md): a stored snapshot is ≈ 35 KB of processes, ≈ 41 KB
    of services and ≈ 2 KB of adapters (computed from the real sanitiser); every 6 h is 60,000 uploads a day, 0.7 a
    second beside 27.8 heartbeats a second, ≈ 1.6 GB a day, and ≈ 400 MB kept. Processes every hour would be
    ≈ 4 GB a day for a list stale within minutes, which is why processes get the open-tab interval instead.
  - **Settings → Monitoring & API → Automatic snapshots** (Platform Admin): the switch, each key's interval (off, or
    1 hour – 7 days) and the open-tab interval (off, or 3 – 60 minutes). `GET`/`PUT /admin/snapshot-schedule`,
    `PlatformAdminGuard`. Every change is audited as `SNAPSHOT_SCHEDULE_CHANGED` with before and after.
  - **Not audited run by run.** At 5,000 computers that would be tens of thousands of entries a day in a log that can
    never be pruned. The run itself is the record; `auditDone` returns for a requester-less run. Refresh is still
    audited exactly as before.
  - **Who is asked:** active, Windows, bound to a device secret, agent **0.33 or later** (0.31–0.32 refuse the
    snapshot keys, older agents never start them), and checking in (a heartbeat in the last 30 minutes — `HEARTBEAT_STALE_MS`, the header's window; the branch had its own 10 minutes, see *Integration notes*).
  - **Back-off and pacing.** A failed or expired automatic run is not retried for an hour (or the interval, if
    shorter) — the trap the inventory pass fell into in 0.32. At most `SNAPSHOT_MAX_PER_MINUTE` (default 120)
    scheduled runs start per minute in the API process, so the first round after this upgrade (every computer due at
    once) or after an outage spreads over ≈ 2 hours at 5,000 computers. Open-tab runs are not held back.
  - **Kept:** only the newest completed automatic run per key per computer; an older one is deleted when a newer one
    completes, and a failed one when the next is asked for. People's runs are left to the 0.34 retention sweep, which
    covers automatic runs too. The per-device Refresh rate limit (20 per 10 minutes) now counts people's runs only.
  - **Off switch:** `SNAPSHOT_SWEEP=off`. `scripts/run-e2e.sh` exports it and `e2e-ui.mjs` sets it for its API;
    `e2e-auto-snapshots.mjs` turns it on for its own.
  - **Containment does not apply**: no pause kind covers reading, and docs/containment.md already says viewing keeps
    working during a pause — the same as the automatic inventory pass and Refresh.
- **The tab updates itself and says why nothing arrives.** It re-reads every 4 s while a refresh is on its way and
  every 30 s while open (not while the browser tab is hidden), so a new snapshot appears without a reload. Under the
  age it says how often the snapshot is refreshed and roughly when the next automatic one is due. When nothing can
  arrive it says exactly why instead of offering a Refresh that would expire: the agent has not checked in (with
  "it is still reachable through RustDesk" when `isOnline` comes from RustDesk alone, 0.34), the agent is older than
  0.33 or never reported a version, the computer is not Windows, or automatic snapshots are off (in Settings, for this
  key, or by `SNAPSHOT_SWEEP=off`). The snapshot route gains `automatic` (`state`, `reason`, `nextAt`,
  `intervalMinutes`, `basis`), `agentSilent` and `agentVersion`. The Diagnostics history shows automatic runs as
  *Automatic*.

#### Checked
- **CPU, memory and disk on the header and Overview are not affected.** They are the live sample every heartbeat
  carries (`recordLiveState`, every 3 minutes), the inventory pass behind Specs is already automatic every 6 hours
  (`stageAutomaticCollections`), the page re-reads it every 30 s, and Specs has its Refresh. Those values go stale
  only when the agent stops checking in, which the header already says. No change made there.

**Upgrade:** migration **0059_auto_snapshots**: `DiagnosticRun.requestedById` becomes nullable; a CHECK refuses a
requester-less run of any key but the three snapshot keys; a partial unique index allows one open automatic run per
key per computer; five `PlatformSettings` columns with range CHECKs; the `SNAPSHOT_SCHEDULE_CHANGED` audit action.
It is a schema change, so deploy with `prisma migrate deploy` and regenerate the Prisma client at the target
(CLAUDE.md). After the restart, expect the first round of automatic snapshots to arrive over about two hours on a
large fleet (`SNAPSHOT_MAX_PER_MINUTE`). No agent change: it uses the 0.33 keys the agent already has.

**Verify:** open a current Windows computer's Processes tab without pressing Refresh: within a few minutes it says
*Taken just now, automatically* and *Next automatic refresh around …*, without a reload. As a Platform Admin, change
an interval in Settings → Monitoring & API and find `SNAPSHOT_SCHEDULE_CHANGED` in the audit log. Tests:
`e2e-auto-snapshots.mjs` 79 passed (stale keys only, intervals, the open-tab interval, failure back-off, expiry, no
per-run audit, Refresh still audited and sharing an open automatic run, too-old / unknown / Linux / silent computers
never asked and each tab's reason, A/B isolation including that a refused read does not mark a tab watched, the
schedule change Platform-Admin-only and audited, the database backstops, `SNAPSHOT_SWEEP=off` and the pacer on
separate APIs); `unit-snapshot-schedule.mjs` 85 passed (in CI; its two window-boundary checks were moved from 9/11 to 29/31 minutes at integration); `e2e-ui.mjs` gains `snapshotAutoUpdate` — the
Processes tab, at 1440 × 900 and 375 × 812, shows the new list without a reload after a simulated device completes a
Refresh and, separately, a run the page did not ask for (the 30 s re-read). The whole browser suite: 451 passed, 0 failed (new list in ≈ 4 s after a Refresh, ≈ 30 s on the re-read, at both widths). Existing suites touched by the change:
`e2e-diagnostics-catalog.mjs` 70, `e2e-system-inventory.mjs` 68, `e2e-retention.mjs` 43, `unit-diagnostics-catalog`
75, `unit-system-inventory` 66, `unit-retention` 47 — all passed. Invariant **§50** (§46 on the branch; 8 checks, each proven by
mutation, 17 mutations caught); §20's requester re-check updated for requester-less runs. **Nothing here ran on
Windows**: heartbeats and results are posted the way heartbeat.ps1 posts them.

### Integration notes

The parts were merged into `feat/v0.35.0` in this order: group policies, UI coverage, polish, automatic snapshots.
Each branch started its invariant sections at §46. Here they are §46–§50 in merge order:

| § | Part | Checks |
|---|---|---|
| 46 | Device groups as a policy scope | 9 |
| 47 | UI coverage of the 0.34 screens | 3 |
| 48 | Groups on the device page | 2 |
| 49 | Reachable is not reporting | 4 (one added at integration) |
| 50 | Automatic snapshots | 8 |

The sections above keep each branch's own text, with the numbers corrected. Their check and test counts are each
branch's own; the integrated counts are under *Verification (integrated)*. These changes were made where the
branches met:

- **One "agent silent" window, not two.** The snapshot branch wrote its own `AGENT_SILENT_MS = 10 min`. It believed
  that matched the stale sweep, but the polish branch had established that the sweep has always run with 30. Left
  as it was, for twenty minutes a computer's header would say *Online* while its Processes tab said the agent was
  silent.
  - `AGENT_SILENT_MS` is now `HEARTBEAT_STALE_MS`, imported from `common/connectivity.ts`.
  - `unit-snapshot-schedule.mjs`: the boundary checks moved from 9/11 to 29/31 minutes, and it now also asserts
    that the two constants are equal.
  - §49 gained a check for it, which fails when the literal is restored.
  - `docs/diagnostics.md` says 30 minutes.
- **The snapshot tab's wording matches the header's.** When `isOnline`, the "agent silent" reason now starts with
  the header's own label (*Reachable (RustDesk) · agent silent 12 d. Its agent has not checked in since …, so remote
  control should work but nothing can be collected until it does.*). Before, it ended with the snapshot branch's own
  "(it is still reachable through RustDesk)".
- **`UpdatesCard`** takes both `endpointId`, for group policies' *Client-update policy* row, and `platform`, for
  polish's *Windows Update* / *Package updates* / *Software Update* label.
- **`e2e-ui.mjs`** has every function from every branch:
  - `coverage035` (uicover), and the polish checks (`scheduleLinks`, `memberChecks`, `dashboardFit`,
    `agentSilentUi`, padding, groups, Linux wording, the Filters sheet, contrast).
  - `snapshotAutoUpdate` (autosnap). It now honours `UI_COMBOS` and runs for a viewport whenever any combination of
    that viewport is selected.
  - Its API runs with `STALE_SWEEP` and `SNAPSHOT_SWEEP` off, beside the nine 0.34 switches.
  - CI's *UI suite (browser)* step now states all four ports: `UI_WEB_PORT` 3501, `UI_API_PORT` 3502,
    `UI_SMTP_PORT` 3503, `UI_PEER_PORT` 3504.
  - The fixture line counts what the merged seed creates: nine devices, three groups, three scripts.
- **§44 now finds the sweep switches instead of listing them.** Two arrived in 0.35 from two branches. The new check
  collects every `X_SWEEP` / `X_SEALER` `=== 'off'` switch in `apps/api/src` (eleven) and requires each to be `'off'`
  in `e2e-ui.mjs`. It fails with `STALE_SWEEP` removed.
- **Fixed in `e2e-ui.mjs`: `UI_REBUILD=1` could not work.** It built with `INTERNAL_API_URL=''`. `next.config.js`
  reads that with `??`, so the build got a bare `/api/:path*` destination, and the copy patch stopped with "no /api
  rewrite found". The variable is now left out of the build's environment, so the build gets the same default
  destination CI's build has, which the patch then replaces in the copy.
- **`e2e-ui.mjs`'s rule-group check failed once the branches met, and the test was wrong, not the app.** Polish
  expected the *Online* rule group to list five members. UI coverage's `seed035()` adds a sixth online computer in
  the same business (the chat computer, which has a fresh heartbeat). The first integrated run was 833 passed and
  4 failed, the same check in each of the four combinations, with 6 rows each time. The check now names all six
  members and asserts that the offline WS-04 is absent. That is stricter than the count it replaces.
- **Shared lists are unions:** `run-e2e.sh` (group-policies, polish, auto-snapshots), `ci.yml` (`unit-group-policy`,
  `unit-polish`, `unit-snapshot-schedule`), `rmm-gap-analysis.md` and the docs bundle (39 pages,
  `group-policies.md` added to ORDER). `help/page.tsx`, `nav-model.ts` and `e2e-navigation.mjs` merged without
  conflict. Each was checked line by line: every line a branch added is in the final tree, except the ones replaced
  above.
- **Cross-references renumbered:** `common/connectivity.ts`, `lib/connectivity.ts` and `docs/architecture.md`
  (§47 → §49); `snapshot-schedule.ts`, `docs/diagnostics.md` and §20's comment (§46 → §50).
- **`CLAUDE.md`:**
  - One paragraph per new section, and §44's note says eleven switches.
  - *Things that will bite you* now says `STALE_SWEEP=off` (and `SNAPSHOT_SWEEP=off`) must never be set in
    production.
- **Branch bases.** The group-policy, UI-coverage and polish branches started at 52108a7, one commit before
  `feat/v0.34.0`'s tip. That commit (95f7792, the drawer's outside-tap wait in `e2e-ui.mjs`) is kept.

### Verification (integrated)

Run on the final tree, with all four parts merged and the release bookkeeping in place. The database was
`rem0te_integrate35_test`, created empty for this run.

- **Static:**
  - `scripts/check-security-invariants.mjs`: **393 checks hold**, including §46–§50. Before 0.35 there were 366.
  - `check-versions.mjs` passes, and so does `gen-integration-contracts --check` (18 schemas, 11 signed examples).
  - `pnpm -r lint` exits 0 with no warnings, and `tsc --noEmit` exits 0 in both apps.
  - `prisma generate`, `nest build` and `next build` succeed. The launcher was not touched.
- **Prisma:** all migrations, 0000–0059, apply to the empty database (0048 and 0058 are unused). `prisma migrate
  diff` from the migrated database to `schema.prisma` reports *No difference detected*.
- **Production manifest:** no branch changed a dependency. `pnpm deploy:manifest` gives 0.35.0 with 30 dependencies
  and no devDependencies, and `npm install --omit=dev --package-lock-only` exits 0 with 0 vulnerabilities.
- **Routes:** `docs/API-REFERENCE.md` was regenerated and has 476 routes across 67 controllers. `--check` against the
  RouterExplorer log of `run-e2e.sh`'s scratch API matches exactly (476 / 476). The docs bundle is 39 pages.
- **Go agent (`tools/windows-installer`):**
  - `go test -count=1 ./...` runs 232 tests and subtests, and all pass. This host has no `pwsh` on `PATH` for
    those tests.
  - `GOOS=windows GOARCH=amd64 go build ./...` and `go vet ./...` pass.
  - The `rem0te-release` and `rem0te-action-sim` builds (as CI builds them) succeed.
- **Unit scripts, every one in `ci.yml`, all exit 0:**

  | Script | Passed |
  |---|---|
  | `agent-migration` | 44 |
  | `ai-timeline` | 24 |
  | `approval-signer` | 184 |
  | `audit-chain` | 35 |
  | `chat` | 52 |
  | `device-views` | 77 |
  | `diagnostics-catalog` | 75 |
  | `dynamic-groups` | 68 |
  | `email` | 122 |
  | `group-policy` | 38 |
  | `hbbs-peer-snapshot` | 29 |
  | `integration` | 35 |
  | `macos-agent` | 27 |
  | `metric-history` | 42 |
  | `monitoring` | 91 |
  | `patch-policy` | 163 |
  | `patch-summary` | 27 |
  | `polish` | 25 |
  | `presets` | 26 |
  | `retention` | 47 |
  | `script-library` | 125 |
  | `script-run` | 136 |
  | `search` | 37 |
  | `session-mutations` | 30 |
  | `signed-installer` | 34 (no pwsh on this host for its parse checks; CI has pwsh) |
  | `snapshot-schedule` | 85 |
  | `software` | 146 |
  | `system-inventory` | 66 |
  | `update-signing` | 16 |
  | `update-window` | 85 |

  `build-approval-signer --list` also exits 0.
- **`scripts/run-e2e.sh`:** run in full on the fresh database, with `RELEASE_BIN` / `ACTION_SIM` built from this tree
  and `PWSH` (PowerShell 7.4.6) set. **All 52 suites passed and none were skipped.** Passed counts:

  | Suite | Passed |
  |---|---|
  | `credentials` | 44 |
  | `security-features` | 42 |
  | `presets` | 114 |
  | `monitoring` | 108 |
  | `integration` | 77 |
  | `dashboard` | 53 |
  | `diagnostics-catalog` | 70 |
  | `system-inventory` | 68 |
  | `device-list` | 115 |
  | `endpoint-visibility` | 114 |
  | `device-views` | 142 |
  | `dynamic-groups` | 98 |
  | `add-device` | 62 |
  | `auto-updates` | 73 |
  | `group-policies` | 77 |
  | `reports` | 104 |
  | `script-library` | 138 |
  | `linux-agent` | 86 |
  | `macos-agent` | 106 |
  | `enrol-stepup` | 67 |
  | `search` | 113 |
  | `metric-history` | 59 |
  | `retention` | 43 |
  | `presence-cache` | ALL PASSED |
  | `ai-timeline` | 61 |
  | `email` | 92 |
  | `chat` | 89 |
  | `polish` | 49 |
  | `auto-snapshots` | 79 |
  | `containment` | 70 |
  | `approved-action` | 76 |
  | `staged-patching` | 94 |
  | `maintenance-actions` | 64 |
  | `patch-policies` | 98 |
  | `software-deploy` | 156 |
  | `signed-updates` | 46 |
  | `ticket-workflow` | 53 |
  | `agent-upgrade` | ALL PASSED |
  | `script-run` | 81 |
  | `smoke` | end-to-end proof passed |
  | `full` | FULL END-TO-END PROOF PASSED |
  | `business-access` | 83 |
  | `offboarding` | 63 |
  | `public-api` | PUBLIC API END-TO-END PROOF PASSED |
  | `public-address` | 43 |
  | `rollouts` | 46 |
  | `security-audit` | 57 |
  | `session-mutations` | 43 |
  | `support-requests` | 47 |
  | `sso-passkeys` | 70 |
  | `candidate-password` | ALL PASSED |
  | `secreg` | All security regression checks passed |

- **`e2e-ui.mjs`, as CI runs it** (ports 3501–3504, against the same database after `run-e2e.sh`): **837 passed,
  0 failed**, including the search-palette suite (24). The first run was 833 / 4. See *Integration notes* for that
  fix.
- **Not run:**
  - `e2e-navigation.mjs`: it needs the docs stack and is run by hand.
  - Nothing ran on real Windows.
  - The guide's dashboard screenshots were not regenerated.

### Upgrade notes (all of 0.35)

- **Schema change: two migrations.** Take a `pg_dump` first. Then:
  1. Run `prisma migrate deploy`.
  2. Rsync `apps/api/prisma/` to the target.
  3. Run `npx prisma generate` there, as `CLAUDE.md` describes.

  Without steps 2 and 3 the API throws `Unknown field groupId` (or `snapshotAutoEnabled`) at runtime.

  | Migration | Adds |
  |---|---|
  | `0057_group_policy_scope` | `groupId` and `priority` on `MonitorRule` and `ClientUpdatePolicy`, with CHECKs, partial unique indexes and the `group_policy_same_business` trigger. It recreates `ClientUpdatePolicy_business_row` with `AND "groupId" IS NULL` |
  | `0059_auto_snapshots` | `DiagnosticRun.requestedById` becomes nullable. A CHECK limits requester-less runs to the three snapshot keys, and a partial unique index allows one open automatic run per key per computer. Five `PlatformSettings` columns with range CHECKs, and `SNAPSHOT_SCHEDULE_CHANGED` |

  0058 is unused.
- **Behaviour changes for API consumers and saved filters:**
  - **`online=online` on the device list now means "the agent is checking in"** (a heartbeat in the last
    30 minutes). It used to mean `isOnline`. This also applies to saved views and rule groups that use it. A
    computer reachable only through RustDesk has left them. `online=silent` finds it, and sorting by Online orders
    online, then agent silent, then offline.
  - **The dashboard API counts gain `agentSilent` and `reachable`.** This covers `GET /dashboard/overview`
    `devices` and `GET /dashboard` `endpoints`. Their `online` (and the map's `points[].online`) no longer
    includes agent-silent computers. `reachable` is the old `online`. `offline` is unchanged.
  - **The device-list CSV gains a *Connectivity* column** after *Online*. A consumer that reads columns by position
    must allow for it.
  - `GET /endpoints/:id` gains `groups` (static and matching rule groups). The snapshot route gains `automatic`,
    `agentSilent` and `agentVersion`.
  - There are two new routes: `DELETE /client-updates/policy/groups/:groupId` (step-up) and
    `GET`/`PUT /admin/snapshot-schedule` (Platform Admin). `GET /client-updates/computers/:endpointId/policy` is
    new too. There are 476 routes in all.
- **New settings:**
  - **Automatic snapshots** are on by default: every key every 6 hours, and every 5 minutes while its tab is open.
    - Platform Admins change them in Settings → Monitoring & API → *Automatic snapshots*. Each change is audited as
      `SNAPSHOT_SCHEDULE_CHANGED`.
    - `SNAPSHOT_MAX_PER_MINUTE` (default 120) paces scheduled runs. After the restart, expect the first round to
      arrive over about two hours on a 5,000-computer fleet.
    - **Off switch: `SNAPSHOT_SWEEP=off`** stops them in that process.
  - **`STALE_SWEEP=off`** stops the stale sweep in that process. It is for test stacks only. **Never set it in
    production**, or machines will never go offline.
  - No other environment variable was added. The stale sweep and `isOnline` are unchanged in production.
- **No production dependency changed.** The target manifest does not need regenerating. `pnpm deploy:manifest`
  still resolves under npm (see *Verification (integrated)*).
- **Nothing needs the owner's keys.** There is no agent change and no new signed action, and the approval signer is
  not rebuilt. The snapshots use the 0.33 diagnostics keys the agent already has, so only agents 0.33 or later are
  asked.
- **No permissions to grant.** Group policies use the existing monitoring and client-update capabilities.

---

## [0.34.0] — 2026-11-11 · *Switchboard*

The fourth increment of the RMM overhaul. Its theme is acting on computers through the approval chain, and
telling people about it. Thirteen parts were built separately from 0.33 and integrated here:

- **Signed actions.** Script runs (`windows.script.run@1`) and winget software install/uninstall join the signed
  catalog. Staged patching gains a restart rule. A patch policy's later rings now open only on results the computers
  signed themselves.
- **Operations.** Outbound email with scheduled reports. A retention sweep for the tables that grew without bound. A
  shared hbbs peer read that halves heartbeat CPU. Agent upgrade from the console.
- **Groups and keys.** Multi-group and rule-based device groups. A step-up for every API key.
- **ClientSt0r.** The AI summary now goes through ClientSt0r, and rem0te holds no model-provider SDK or key.
- **Chat.** Two-way chat between a technician and the person at a Windows computer, from the signed agent.
- **Console.** A phone-width layout, with a browser suite in CI. Regenerated screenshots.

**Nothing new that acts on Windows has run on a real Windows computer.** That covers the restart rule, signed results,
script runs, software, the migration script and the chat window. Each was proven against the action simulator, stubs and, for
scripts, PowerShell 7 on Linux. The pages and docs that offer them say so.

### Fixed
- **The alert-frequency and offline-time reports were empty for a Platform Admin.**

  `ReportsService.alertsWhere` limited computer alerts with
  `{ OR: [{ endpointId: null }, { endpoint: <visibility> }] }`.

  - For a caller who can see every computer, the visibility filter is `{}`.
  - Prisma 5 reads `{ endpoint: {} }` inside an OR as matching nothing.
  - So a Platform Admin's *Alert frequency* and *Offline time* reports held only
    site-wide outage alerts: "26 episodes" read as 0.
  - Owners, technicians and Business Users were unaffected, because their filter
    is never empty.

  The fix is `endpoint: { is: <visibility> }`.

  - `e2e-reports.mjs` now checks that an unfiltered Platform Admin counts A's and
    B's computer alerts: 104 passed, 0 failed.
  - With the fix reverted, it gives 102 passed, 2 failed.
  - Invariant §22 (reports) now requires the `is:` form.

  **Upgrade:** nothing to do. No migration, and no setting changes.
  **Verify:** as a Platform Admin, open Reports → Offline time with no business
  chosen. It should list computers, not only site outages.

### Data retention

#### Added
- **A retention sweep for the tables that grew without bound.** Before this, nothing that grows was ever pruned
  (docs/server-sizing.md, 0.33). Commands, inventory changes, alerts and diagnostics accumulated at about 1.3 MB per
  computer per year: about 6.5 GB a year at 5,000 computers, with no end. One sweep inside the API
  (`apps/api/src/retention/`), built like the metric sweep, now ages out operational history and transient rows:
  - finished agent commands after **90 days** (`RETENTION_COMMAND_DAYS`, 7–3650), always keeping the newest of each
    type per computer and the newest that succeeded, because the Event Log tab and the diagnostic panels show "the
    last result";
  - finished diagnostic runs after **90 days** (`RETENTION_DIAGNOSTIC_DAYS`, 7–3650), the same way per diagnostic;
  - inventory change history after **400 days** (`RETENTION_CHANGE_DAYS`, 30–3650);
  - alerts resolved more than **400 days** ago, with their events (`RETENTION_ALERT_DAYS`, 30–3650). The alert
    reports offer periods up to 365 days, so the default covers the longest of them with a month to spare;
  - on finished remote sessions, the free-form detail of events older than **400 days**
    (`RETENTION_SESSION_DETAIL_DAYS`). The session and event rows are kept, because they are evidence of who
    connected to what and offboarding reads them;
  - launcher tokens and connection grants that were **never used**, 30 days after they expired
    (`RETENTION_TOKEN_DAYS`, 1–365). A used one is kept, because offboarding lists the computers a person reached
    through it;
  - abuse-guard rows (`PrivilegedActivity`) after **30 days** (`RETENTION_PRIVILEGED_ACTIVITY_DAYS`, 2–365). The
    floor exceeds the guard's longest window (1,440 minutes).

  Out-of-range values are clamped and unparsable ones take the default, so `RETENTION_ALERT_DAYS=0` means 30 days,
  not "delete everything". Each pass removes at most `RETENTION_BATCH` × `RETENTION_BATCHES` (2,000 × 10) rows per
  table, every `RETENTION_SWEEP_SECONDS` (3,600). The first pass starts two minutes after the API does.
  `RETENTION_SWEEP=off` stops the sweep. Statements delete by cutoff and finished state, so a pass is idempotent and
  two API processes are safe (alert batches lock `SKIP LOCKED`).
- **Nothing open or live is touched.** Every statement names the finished states. Pending and dispatched commands,
  unfinished diagnostics, OPEN and ACKNOWLEDGED alerts, a site-outage alert with an open child, sessions that have
  not ended, and unexpired or used tokens all stay at any age.
- **The audit chain is never pruned or modified.** The sweep names no audit table. Each pass that removed anything
  writes one `RETENTION_PRUNED` audit entry (counts per table, windows in force, which tables had more to do). That
  entry is an insert into the chain. A pass with nothing to do writes nothing.
- **Settings → System status → Data retention** (Platform Admin only, `GET /admin/retention`). Every growing table,
  including the evidence ones and those other sweeps handle, with its real row count, oldest row, window and what
  removes it. Counts are cached for a minute; the refresh button recounts. The route only reads: no route runs,
  changes or turns off the sweep. Retention is set in the server's environment, so a stolen session cannot shorten
  it.
- **The alert reports say how far back they can see.** Alert frequency and Offline time return
  `retention: { alertDays, periodDays, complete, coversDays }`. When the period is longer than the alert window,
  the page says it covers only the last N days. Patch compliance and Agent coverage say they read current records,
  which retention never removes.
- `docs/data-retention.md` (in the app at `/docs/data-retention`) gives the classification, the defaults and why,
  what pruning changes, the measured cost and what is not done. It is linked from server-sizing, setup, reports,
  inventory and `/help`. Server sizing now gives the levelled-off size: about 0.45 MB per computer of pruned history
  after the first year, plus sessions and audit entries, which are kept (estimated).

#### Upgrade notes
- **Migration `0046_data_retention`** adds the `RETENTION_PRUNED` audit action and eight indexes for the cutoffs:
  `EndpointCommand(createdAt)`, `EndpointCommand(endpointId, type, createdAt)`, `DiagnosticRun(requestedAt)`,
  `EndpointChange(detectedAt)`, `MonitorAlert(state, resolvedAt)`, `LauncherToken(expiresAt)`,
  `PrivilegedActivity(at)`, and a partial `SupportSessionEvent(timestamp) WHERE metadata IS NOT NULL`, which the
  schema cannot express. The Prisma client at the target must be regenerated (CLAUDE.md, *A schema change*).
- **The first passes after upgrading clear a backlog** at up to 20,000 rows per table per hour. A year of commands
  on 1,000 computers is about 1.6 million rows past 90 days, which takes about three and a half days. Raise
  `RETENTION_BATCHES` for a while to go faster, or set `RETENTION_SWEEP=off` to postpone it.
- PostgreSQL does not give deleted space back to the operating system. The tables stop growing; to shrink them,
  run `VACUUM (FULL, ANALYZE)` in a maintenance window.
- To keep the old behaviour (nothing pruned), set `RETENTION_SWEEP=off`.

#### Verification
- `apps/api/scripts/unit-retention.mjs` (CI): **47** checks. Defaults, floors, ceilings and parsing of every
  variable, the cutoffs, the per-pass cap and batch loop, report coverage, and the table inventory.
- `apps/api/scripts/e2e-retention.mjs` (`scripts/run-e2e.sh`): **43** checks against its own API on port 3411,
  started three times. Seeds aged and current rows in every swept table for Business A and B, then proves:
  - with the sweep off, nothing goes in 7 s;
  - with it on, at two rows per table per pass, every aged row goes and every open, newest, used or in-window row
    stays;
  - no pass removes more than two rows from a table, and five old changes take three or more passes;
  - each removing pass writes one entry, and later passes write none;
  - the audit chain verifies with no new problem, with every previously sealed entry, its hash and every checkpoint
    intact, and audit rows 3,000 days old untouched;
  - the status route returns the database's counts and oldest rows, refuses both businesses' owners and a business
    user (403) and the anonymous caller (401), and reports clamped windows;
  - the reports state their coverage, including a 365-day report under a 30-day window.
- `scripts/check-security-invariants.mjs` **§33**, 7 checks, each proven to fail with its guard removed (12
  mutations):
  - the sweep never names the audit chain and writes only to nine allow-listed tables;
  - the policy lists the audit log and checkpoints as evidence that nothing sweeps;
  - every statement names the finished states;
  - the newest command and diagnostic survive;
  - every statement is bounded and goes through the batch loop;
  - `RETENTION_SWEEP=off` is honoured and set for every other e2e suite;
  - the status route is one Platform Admin GET.
- `RETENTION_SWEEP=off` is exported by `scripts/run-e2e.sh` and passed to its scratch APIs, because the sweep acts on
  the whole database. `e2e-reports.mjs` still passes (102).
- Sweep cost, **measured** on a loaded shared host with 540,000 synthetic commands and 180,000 changes: 180–460 ms
  per 2,000-row command batch, 30–50 ms per change batch, 5 ms with nothing due. Not measured on a real fleet.

### API key step-up and multi-group membership

Two follow-ups from 0.33: the API-key step-up covered only keys that can enrol computers, and a computer could be
in one device group at a time.

#### Security

- **Creating any API key needs a fresh re-authentication.** 0.33 asked only when the key carried
  `enrollment:write` (`apikey.enrollment`). But every key is Business Owner access to its business, within its
  scopes, that keeps working after the session that made it is signed out, revoked or has its password changed.
  A stolen or unattended session that could quietly mint a `computers:read` or `audit:read` key kept reading the
  business long after the session was gone. Now `POST /apikeys` answers `403 STEP_UP_REQUIRED`
  (`action: "apikey.create"`) for every key until the person confirms it is them.
  - **Not configurable.** It uses `assertFresh`, like the enrolment-token mint; emptying
    `PlatformSettings.stepUpActions` does not lift it (the e2e suite checks).
  - **Scope and validation first.** Another business is still a 403, an unknown one a 404, a request with no valid
    scope a 400, and a Business User (no `api_keys:write`) a 403. None of them prompts, and no refusal writes a row.
  - **Audited.** `API_KEY_CREATED` now records `stepUpMethod` and `expiresAt` beside the name and scopes.
  - **Keys are immutable, so creation is the only gate needed.** There is no route that widens a key's scopes or
    restores a revoked key (`PATCH`/`PUT /apikeys/:id`, `/restore`, `/scopes` are all 404), and the only writes to
    an existing key set `revokedAt` or `lastUsedAt`. Revoking, which only takes access away, never needs a step-up.
    To change a key's scopes, create a new key and revoke the old one.
  - **Console.** The api-client interceptor opens the step-up dialog and retries the same request, so the name,
    scopes, expiry and business are all kept. If the person cancels, nothing is created and the page says the
    entries are kept. The page now says up front that creating a key asks, and that keys cannot be edited.
  - Keys created before this release without a step-up keep working; review them under *Settings → API keys* if a
    session may have been stolen.

#### Changed

- **A computer can be in several device groups of its own business.** 0.33 kept membership in
  `Endpoint.endpointGroupId`, so adding a computer to a second group was refused (`IN_OTHER_GROUP`). Membership is
  now a join table, `EndpointGroupMember` (`endpointGroupId`, `endpointId`, `addedById`, `createdAt`; composite
  key). Adding to one group never takes a computer out of another; removing it from one, or deleting a group,
  leaves its other groups. `IN_OTHER_GROUP` is gone.
  - **Device list.** The group filter lists every member (a computer in three groups appears under each); the
    facet and the *Device groups* list count a computer once per group, over what the reader can see; each row has
    `groups: [{ id, name }]` (ordered by name) instead of `group`; the CSV column is *Groups*, names separated by
    `; `. The column id stays `group`, so 0.33 saved views keep it. `GET /endpoints/:id` returns `groups` instead
    of `endpointGroup`.
  - **Every 0.33 rule holds:** same business only (bulk `OTHER_BUSINESS`, endpoint creation and token minting
    still check the group's business), the manage rule for membership changes, `DEVICE_GROUP_MEMBERS_CHANGED`
    audit entries, and a computer that changes business leaving the old business's groups.
  - **The business rule is now in the database.** Migration `0049_device_group_members` adds two triggers:
    `endpoint_group_member_same_business` refuses a membership row whose computer is not in the group's business
    (or, for a pre-0.33 group with no business, its tenant), whatever code writes it (SQLSTATE 23514); and
    `endpoint_leaves_foreign_groups` deletes every membership that is not the new business's own when a computer's
    `customerId` or `tenantId` changes. Before, each path that moved a computer had to remember to clear the
    column; the Platform Admin's *Unassigned → business* assignment did not need to, but nothing guaranteed it.
    A move through `PATCH /endpoints/:id` now records `movedToBusiness` and `leftGroups` in its `ENDPOINT_UPDATED`
    entry.
  - **Enrolment tokens.** `DeviceClaimToken.endpointGroupId` is kept as *the group a new device joins at claim*,
    and `Endpoint.endpointGroupId` is dropped. Keeping both would be two records of one fact: a count or filter that
    read the column would silently disagree with the table, and the column could no longer mean anything once a
    computer has several groups. The claim adds a membership (re-checked against the token's business, as 0.33
    did); re-enrolling a computer in the same business keeps its other groups (0.33 replaced the one group with the
    token's), and re-enrolling it with another business's token leaves the old business's groups first.
    `ENDPOINT_CLAIMED` records `groupId`. `POST /endpoints` still takes `endpointGroupId` as the first group.

#### Upgrade notes

- Migration `0049_device_group_members` copies every 0.33 membership into the join table, then drops
  `Endpoint.endpointGroupId`. A membership is copied only if it satisfies the rule above; a pre-0.33 row whose group
  belongs to another business (0.33 never cleaned those up) is dropped, and the migration's `NOTICE` says how many
  were copied and dropped. To see them beforehand:
  `SELECT e.id, e."customerId", g."customerId" FROM "Endpoint" e JOIN "EndpointGroup" g ON g.id = e."endpointGroupId" WHERE g."customerId" IS NOT NULL AND e."customerId" IS DISTINCT FROM g."customerId";`
- A schema change: `prisma migrate deploy`, then rsync `prisma/` and `prisma generate` at the target, or the API
  throws `Unknown field groupMemberships`.
- API consumers: device-list rows have `groups` (array) in place of `group`; `GET /endpoints/:id` has `groups`
  in place of `endpointGroup`; the CSV header is *Groups*. A script that creates API keys from a session must now
  step up first (`POST /auth/step-up`) — the public API itself is unchanged.

#### Verification

- `e2e-enrol-stepup.mjs` 67 passed (API-key sections rewritten: every scope refused stale, Platform Admin too,
  scope/validation before the prompt, fresh creation audited with the method, no widen/restore route, revoke
  stale, revoked key 401, unconfigurable).
- `e2e-device-views.mjs` 142 passed (new: A1 in two groups, both on its row in name order, facets and group list
  count each, `GET /endpoints/:id` names both, removing from one keeps the other, deleting a group releases 2 and
  keeps the other, CSV `"Reception; Workshop"`, a direct database insert across businesses refused by the trigger,
  a Platform Admin move leaves both groups and is audited with them, a claim adds the token's group, re-enrolling
  in the same business keeps both, re-enrolling with business B's token leaves A's groups and joins B's).
- `unit-device-views.mjs` 73 passed (13 new: `membershipStep`, `groupsCell`).
- Unchanged suites still pass: `e2e-device-list` 113, `e2e-add-device` 62, `e2e-credentials` 44 (the claim check
  now reads the membership), `e2e-public-api` passed and `e2e-security-audit` 57 (both now step up before creating
  a key; the audit suite also checks a read-only key is refused without one).
- Migration checked on a scratch database seeded with a 0.33-shaped row set (a same-business member, a
  cross-business member, a member of a pre-0.33 group): 2 copied, 1 dropped; the triggers refuse a cross-business
  insert, allow a second group, and clear memberships on a business change.
- `check-security-invariants.mjs`: new §34 (9 checks — any key needs `assertFresh` after scope and validation and
  before the write, audited; only list/create/revoke routes, revoke ungated; nothing widens or un-revokes a key;
  the console labels and retries; the join table replaces the column; both triggers, the insert check before the
  copy; only the three known paths write membership; the filter and counts stay inside visibility; the suites run
  in CI). §27's key check and §29's membership checks updated for the new code. Each §34 check, and the two
  updated §29/§27 checks, was proven to fail with its guard removed (14 mutations) and to pass restored. 255 checks
  hold.
- `pnpm -r lint`, `tsc --noEmit` (api, web), `nest build`, `next build`, `check-versions.mjs` pass.

### Rule-based (dynamic) device groups

Built on multi-group membership (`EndpointGroupMember`, migration 0049, from the API-keys / groups branch). The
0.33 gap analysis listed "rule-based groups not implemented": a group could only be a hand-kept list, so "every
offline computer", "everything still on RustDesk 1.2" or "kiosks with updates pending" had to be re-ticked by hand
and went stale the moment a computer changed.

#### Added
- **A device group is now `static` or `rule`.** A rule group's rule is the device list's own filter parameters,
  stored as the same validated JSON a saved view stores (`EndpointGroup.kind` / `EndpointGroup.rule`, migration
  0053). It can use site, online/offline, alerts, *Restart pending*, agent type and the new list filters below.
  Search (free text), business (the group already belongs to one), group (no nesting) and the archived filter (the
  list's own Archived filter governs) are refused by name, as are unknown keys and an empty rule. Validation is
  `parseRule()` in `apps/api/src/device-views/group-rule.ts`, which calls the list's own `parseListFilters()`, so a
  rule can never accept something the list refuses or vice versa.
- **New device-list filters** (also usable in saved views, the URL and rules): `platform` (windows / linux / macos
  / other, by the prefixes `common/platform.ts` recognises), `os` (OS caption or version contains; letters,
  digits, space and `. _ ( ) + -` only, LIKE-escaped), `tag` (exact), `patches` (pending / current / unknown /
  stale), `rustdeskMin` / `rustdeskMax` (dotted numbers, compared as four-part integer arrays so 1.10 > 1.9 and
  1.4 = 1.4.0; a missing or non-numeric version such as a nightly never matches a range), `notSeenDays` (includes
  never seen) and `seenWithinDays` (1–3650). The console has a *More filters* dialog for them.
- **Membership is computed on every read, never stored.** `EndpointListService.evaluateRuleGroups()` is the rule
  AND the group's business AND `scopedWhere()` — the reader's own visibility — through the same `filterConds()` /
  `derivedConds()` the list uses for its filters. So a computer that goes offline has left an "Online" group the
  next time anyone looks, with no sweep to fall behind; a Business User sees only their computers in it; a
  technician only the ones their grant names. A stored rule that no longer parses matches nothing, never the whole
  business, and the groups dialog says so.
- **Where rule groups appear:** the group filter (marked *rule*, with a live count), the facet, the *Groups*
  column (outlined badge), the CSV's *Groups* cell, `GET /device-groups` (`kind`, `rule`, `ruleReadable`, and
  `members` counted as the reader sees them) and the bulk bar.
- **Bulk on a group:** `POST /endpoints/bulk` takes `targetGroupId` instead of `endpointIds` (one or the other).
  The server resolves the members at request time, as the caller (a static group's visible member rows, or the
  rule evaluated), refuses more than 200 with `BULK_TOO_LARGE` naming the number — never a silent cut — and then
  runs exactly the per-computer path a selection takes. `DEVICE_BULK_ACTION` records `targetGroup: { id, kind,
  resolved }`. In the console, filtering by a rule group shows the bulk bar for the group itself; *Copy into*
  puts the computers that match now into a static group.
- **Console:** *Views → Save filters as a rule group…* makes one from the current filters (and says which set
  filters are not part of a rule); *Device groups…* shows each rule in words, *Use current filters* replaces it,
  and *Show* filters the list by any group.

#### Security
- **A rule group cannot be added to by anything.** Bulk `group.add` / `group.remove` naming one is refused for the
  whole request (`RULE_GROUP`); so are `POST /endpoints` and `POST /enrollment/tokens` with a rule group's
  `endpointGroupId`, and the claim only ever looks up a STATIC group. Underneath, the
  `endpoint_group_member_static_only` trigger refuses the row (SQLSTATE 23514), `endpoint_group_kind_fixed`
  refuses any change of `kind`, and a CHECK requires a rule exactly when `kind = 'RULE'`.
- **A rule is never SQL.** Prisma filters, or `Prisma.sql` fragments with each value a bound parameter; the only
  `Prisma.raw` in the list service is still the whitelisted ORDER BY. The e2e suite stores a tag of
  `x'); DELETE FROM "Endpoint"; --`, and the rule finds exactly the one computer carrying that text and deletes
  nothing.
- **A rule on alerts is not evaluated for a reader without `monitoring:alerts`.** Filtering by it is a 403 (its
  membership would disclose alert state), bulk on it is a 403, it is left out of that reader's facet and rows, and
  `GET /device-groups` gives `members: null`.
- **Another business's rule group lists nothing** (the same as a made-up id) and is a 404 to edit, delete or act
  on; its rule cannot name another business's site.
- Editing needs the same `manageRefusal()` as a static group (no step-up), and `DEVICE_GROUP_CREATED` /
  `_UPDATED` / `_DELETED` carry `kind` and the rule — before and after on an update.

#### Limits and what is not done
- At most **50 rule groups per business** (within the existing 500 groups). Each is evaluated on every device-list
  read that shows groups. Measured on the e2e scratch stack: a 260-computer business's list takes a median of
  71–82 ms with no rule groups and 101–105 ms with 20 (facet and column), 90 ms filtered by one. Materialising
  membership was not needed and was not done.
- **Not done (next):** scoping monitoring rules or client-update policies to a group. Both resolve by precedence
  over a single scope (`MonitorRule.scopeKey` global → business → site → computer; `ClientUpdatePolicy` business
  with per-site overrides), and a computer can now be in several groups, so a group scope needs a precedence rule
  of its own — not a clean seam. The device page does not yet list the rule groups a computer is in (the list's
  *Groups* column does).

#### Upgrade notes
- Migration **0053** (`0053_dynamic_device_groups`): adds `EndpointGroupKind`, `EndpointGroup.kind` (default
  `STATIC`, so every existing group is unchanged) and `rule`, the CHECK, an index on `(customerId, kind)` and two
  triggers. Run `prisma migrate deploy` and `prisma generate` at the target.
- No new routes. `POST /endpoints/bulk` accepts `targetGroupId`; `POST/PATCH /device-groups` accept `kind` and
  `rule`; `GET /endpoints/list` accepts the eight new filters. `docs/API-REFERENCE.md` regenerated (424 routes,
  unchanged).

#### Verification
- `unit-dynamic-groups.mjs` **68** (new): round-trip, refusal of unknown and refused keys and of every value the
  list refuses (SQL-looking terms, versions, days), unreadable rule → null, one parser for list / view / rule,
  numeric versions, bulk `endpointIds` XOR `targetGroupId`.
- `e2e-dynamic-groups.mjs` **98** (new, port 3481): membership follows a computer going offline and coming back
  and a computer changing business; each of 14 rules lists exactly what the list shows with the same filters;
  A/B isolation; a restricted Business User sees only their computers (list, facet, group list, bulk, CSV); the
  alerts rule refused without `monitoring:alerts`; no hand membership (bulk, enrolment token, direct insert, kind
  change, CHECK); edits audited before/after; unreadable rule; bulk on a rule group and a static group, re-resolved
  per request, the 200 cap with 210 matches; the SQL tag; CSV; the timing above.
- Re-run: `e2e-device-views` 142, `e2e-device-list` 113, `unit-device-views` 73, `e2e-add-device` 62,
  `e2e-enrol-stepup` 67, `e2e-search` 113.
- Security invariants: new **§ 35** (8 checks; each proved to fail when its guard is removed — 16 mutations, all
  caught); § 28, § 29 and § 34 regexes updated for the refactored filter code (`filterConds`, `parseListFilters`,
  `targetGroupId`). 263 checks pass.

### hbbs peer snapshot cache

#### Changed

- **A heartbeat no longer starts a process.** 0.33's sizing work found that most of a steady-state heartbeat's API
  CPU (≈ 70 ms) went on one thing: `peerRegisteredWithHbbs` spawned `sqlite3` on every heartbeat to ask hbbs's peer
  table whether that one RustDesk ID had ever registered. The query is trivial; the fork was not, and it cost the
  Node process as much again as the child (the "node" CPU fell too once it was gone). At 5,000 computers that was
  the difference between fitting on one API process and not.

  The answer is now read from one shared snapshot of the peer table (`apps/api/src/enrollment/hbbs-peer-snapshot.ts`):
  one `sqlite3` reads every digits-only peer ID at most once per `HBBS_PEER_CACHE_SECONDS` (default 10, clamped to
  1–30 whatever is configured), and every heartbeat in that window answers from a `Set`. Concurrent heartbeats
  share the read in flight.

  What the answer is *for* did not change, and the snapshot is built so it cannot drift from it. `rustdeskRegistered`
  in an authenticated heartbeat response is what the Windows installer polls for up to 90 s, refusing to report
  success (exit 22) when the server is *certain* hbbs has never seen the computer; it is also the "has registered
  before" line in diagnostics. Nothing binds or trusts a RustDesk ID on the strength of it — device trust is the
  device secret — but a wrong `true` would let an installer report success for a machine nobody can connect to,
  which is the 0.8.x bug this lookup exists to catch. So:
  - **The window is the only staleness.** A snapshot is never consulted after it; its age is measured from when its
    read *started*, so a slow read cannot stretch it; a clock that went backwards counts as stale. A peer deleted
    from hbbs (as the unauthorised one was in 0.8.x) stops answering `true` within one window.
  - **An unreadable database behaves exactly as before**: `null` (unknown), never `false`, and never an older
    snapshot — a failed read discards the previous one. The failure is remembered for the window, so a host without
    hbbs (or with the file unreadable) no longer spawns a process per heartbeat to learn the same thing.
  - **Digits only, in the SQL and again in the parser** (`… AND id NOT GLOB '*[^0-9]*'`). The old query interpolated
    one validated ID; reading the whole table instead means a peer ID containing a newline could otherwise have
    added a second "ID" to the parsed output.
  - The live "registered within 30 s" question (the `OnlineRequest` on 21115, `HBBS_PRESENCE_HOST`) is unchanged; it
    was never per heartbeat.

  Measured with `bench-heartbeat.mjs` on the same shared 16-core host, the old and new builds interleaved run for
  run, 1,000 synthetic computers (rounds after warm-up; the host's load average was 3–17 from other work, so the
  ranges are wide):

  | | 0.33 build | 0.34 build |
  |---|---|---|
  | API CPU per heartbeat, 4 in flight | 56–135 ms (of which `sqlite3` 8–19 ms) | **34–39 ms** (`sqlite3` ≈ 0.02 ms) |
  | API CPU per heartbeat, 16 in flight | 64–134 ms | **35–36 ms**; 61–71 ms in one run at load average 10 |
  | Throughput, 4 in flight | 14–37 /s | **61–83 /s** |
  | Throughput, 16 in flight | 22–47 /s | **61–136 /s** |
  | p50 latency, 4 in flight | 97–273 ms | 45–50 ms |

  At 5,000 synthetic computers and 16 in flight the 0.34 build did 49–72 heartbeats a second at 46–51 ms of API CPU
  each, against the 27.8 a second 5,000 computers need: 1.8–2.6× headroom on one process, on a busy host.
  `docs/server-sizing.md` is updated with these numbers; the 5,000 row is no longer "at the measured limit".

- **`bench-heartbeat.mjs` can now build a 5,000-computer peer table.** It passed every `INSERT` as one `sqlite3`
  argument, which is over Linux's 128 KB per-argument limit above ≈ 3,500 computers (`E2BIG`) — why 0.33's largest
  run was 2,000. The SQL now goes on stdin.

#### Upgrade notes

- No migration. New optional setting `HBBS_PEER_CACHE_SECONDS` (default 10; values outside 1–30 are clamped).
- An installer polling for registration may now see `true` up to one window (10 s) later than before; its loop
  polls every 5 s for 90 s, so this only shortens its margin, never its outcome.
- `sqlite3` is still required on the API host for this lookup, exactly as before (Node 20, which production runs,
  has no `node:sqlite`; no new dependency).

#### Verification

- New `apps/api/scripts/unit-hbbs-peer-snapshot.mjs` (in CI): **29 passed** — window clamp (default 10 s, ceiling
  30 s, floor 1 s, nonsense values), digits-only parsing; registered/unregistered/invalid answers; 500 lookups share
  one read; a deleted ID answers `true` until the window ends and `false` from the first instant after; a new one
  the reverse; unreadable → `null` (also for an ID the expired snapshot had), the failure not re-read inside the
  window, retried after it, recovery; a backwards clock forces a re-read; a slow read does not stretch the window;
  50 concurrent callers share one read and all get `null` when it fails; and against a real scratch SQLite file the
  production query returns only digit IDs, refuses a newline-smuggled ID, and errors (→ `null`) on a missing file
  or a database without a `peer` table. Mutating dist (no discard of the expired snapshot plus fallback to it;
  a doubled window without the backwards-clock guard) fails 4+ checks each.
- New `apps/api/scripts/e2e-presence-cache.mjs` (self-starting, port 3403, in `scripts/run-e2e.sh`): **18 passed** —
  real heartbeats with a scratch peer database and a counting `sqlite3` wrapper on the API's PATH: true/false
  answers; 60 heartbeats over ~10–13 s started 5–7 `sqlite3` (bound: one per 2 s window + 1); an added peer turns
  true and a deleted one false within the window, and the deleted one never turns true again; with the file gone
  every heartbeat succeeds and answers `null` for both computers, without a read per heartbeat, and recovers; a
  corrupt file answers `null`; business A/B: B's device secret with A's RustDesk ID (and the reverse), or none, is
  refused 401 with no `rustdeskRegistered`. Run against the 0.33 build as a negative control it fails exactly the
  two boundedness checks (60 of 60 heartbeats spawned `sqlite3`; 10 of 10 while unreadable) and passes the 16
  semantic ones — the answers are the same as before.
- `check-security-invariants.mjs` §36 (5 checks): window clamp ≤ 30 s applied in the constructor; freshness is
  `age >= 0 && age < window` from a start time taken before the read; the expired snapshot is dropped and a failed
  read is `ids: null`, answered as `null`; digits-only SQL, parser and lookup; one read-only `sqlite3` in
  `enrollment.service.ts`, running the snapshot query, with `peerRegisteredWithHbbs` delegating to it. Nine
  mutations (ceiling raised, clamp removed, backwards-clock guard removed, start time taken after the read, expired
  snapshot kept, fallback to it on failure, GLOB filter removed, parser filter removed, a per-call `sqlite3`
  restored) each fail the matching check.
- Re-run against this build: `e2e-security-audit` **56 passed** and `e2e-rollouts` **46 passed** (each against its own
  scratch API, `HBBS_PRESENCE_HOST=127.0.0.2`), `e2e-linux-agent` **86 passed**, `e2e-macos-agent` **106 passed**,
  `e2e-add-device` **62 passed**, `e2e-credentials` **44 passed**. `check-security-invariants.mjs` and
  `check-versions.mjs` pass; `pnpm -r lint`, `tsc --noEmit` in both apps, `nest build` and `next build` clean.

### Restarts after Windows updates

0.32 deferred this ("Reboot: deferred. Policies and manual installs keep reboot: never. A restart rule needs a full
§15 change to the agent's closed parameters, plus window, warning and open-session rules"). This is that change.
**Fixture-tested only: the in-window restart has not run on a real Windows computer**, and the UI, the approval
pages and the docs say so wherever the rule is offered.

#### Added
- **A restart rule for update plans.** `windows.update.install@1`'s closed `reboot` parameter now takes exactly two
  values: `never` (unchanged, and the default everywhere) or `if_required_in_window`. Nothing can be chosen beside
  it: no delay, time, message or command. The portal (`UpdateReboot` in `actions/catalog.ts`), the approval signer
  (the same schema, through `validatePlanAction`) and the agent (`UpdateReboot` in `internal/action/updates.go`)
  each check it independently; any other value, a missing one, or an extra key beside it is refused by all three.
- **What the agent does under `if_required_in_window`** (`restartInWindow`, after the install and after releasing the
  Windows Update lock), in this order:
  1. an uncertain install (the installer died) is `restart_deferred` / `install_uncertain` — never restart under it;
  2. no restart pending is `not_required` / `no_restart_pending`; a restart pending when nothing was installed is
     `not_required` / `nothing_installed` (someone else's pending restart is not this plan's);
  3. a restart 15 minutes from now that would fall after the plan's signed `notAfter` is `restart_deferred` /
     `window_closed`;
  4. `sessionCheck("the restart")` — the maintenance actions' own check, so "cannot tell" counts as open
     (`remote_session_open`, `session_state_unknown`);
  5. otherwise `scheduleWarnedRestart`, factored out of `windows.reboot.schedule`: the one `Maint.ScheduleRestart`
     call (`shutdown.exe /r /t 900 /d p:4:1`), the same fixed `RestartMessage`, and the same `reboot.json` record,
     so *Cancel a scheduled restart* cancels it like any other. Windows already having a restart pending is
     `restart_already_scheduled` and is not replaced.
  The result carries `restart: { state, reason?, scheduledFor?, delayMinutes? }`. A deferral is final for that
  plan: nothing retries later, the update stays *restart required* and the gate waits, as before. `wua.ps1` is
  unchanged and still never restarts.
- **Proof after the restart.** When a result reports a scheduled restart, the portal sets the computer's
  `patchScanRequestedAt` to two minutes after the restart time. `patchScanDue` now treats a request in the future as
  not yet due, so the agent is asked for a scan on its first heartbeat after the restart, not every heartbeat of
  the warning. The canary gate is unchanged: it opens only on a later scan showing the update effective and no
  restart pending, so a restart that never happened (canceled, blocked) keeps it shut.
- **Policies.** `PolicyDoc.reboot` is now the same pair and is part of the signed, digested document. The signer's
  `evaluatePolicyPlan` refuses a plan asking for more than its policy (`rebootWithin`, `reboot_not_allowed`): under a
  `never` policy a restart plan is refused; under an in-window policy a plan may ask for either. The sweep builds each
  window's deployment with the policy's rule.
- **Deployments** store the rule (`PatchDeployment.reboot`, migration `0047_patch_reboot`, with a CHECK constraint
  holding it to the pair); every ring plan carries it. `POST /patching/deployments`, `POST
  /endpoints/:id/patches/install` and `POST /patching/policies` take `reboot` and default to `never`. No new routes.
- **Console.** A shared *Restart* choice (`components/patching/patch-reboot-choice.tsx`) on New deployment, Install
  updates and New policy, defaulting to *Never restart*; choosing the in-window rule explains the warning, the
  session and window rules, and that it has not run on real Windows. The deployment page shows the rule and, per
  computer, *restart scheduled for …* or *restart deferred: why*; the policy page shows the approved rule. The
  approval signer's plan and policy pages state the rule (and the not-on-Windows caveat) instead of "never
  restarting" when it applies. The restart text that said "Rem0te never restarts a computer" now says when it does.
- **Security Features**: Staged Windows patching describes the rule and cites § 37.

#### Security
- **§ 37 in `check-security-invariants.mjs`** (9 checks): the fixed 15-minute warning, the same on both sides and no
  shorter than a scheduled restart's 5-minute floor; one `Maint.ScheduleRestart` call, shared through
  `scheduleWarnedRestart` with the fixed message; `restartInWindow` checking outcome, pending, window and then
  sessions before scheduling, with `window_closed` and `install_uncertain` deferrals; `wua.ps1` with no restart and
  the Windows side's `shutdown.exe /r` call unchanged; the portal's pair, `UPDATE_INSTALL.params.reboot` and every
  DTO defaulting to `never`; the signer's `rebootWithin` comparison; the database CHECK; the portal keeping a
  `restart` report only from an update plan whose signed rule allowed one; and the caveat in the catalog, the
  console component, both signer pages and `docs/staged-patching.md`. § 15's closed-params check and § 25's policy
  check were rewritten for the pair. Each of the 18 guards (§ 15 ×2, § 25, § 37 ×15) was removed in turn and the
  script failed on that check, then restored.

#### Upgrade notes
- **Migration `0047_patch_reboot`** adds `PatchDeployment.reboot` (`TEXT NOT NULL DEFAULT 'never'`, CHECK). Run
  `prisma migrate deploy`, rsync `prisma/` and `prisma generate` at the target, as for any schema change.
- **The signed agent must be rebuilt and published** for the rule to be honoured. An agent from before this change
  refuses a plan with `if_required_in_window` as `params_not_allowed` (its params check admits only `never`), so
  nothing restarts on an old agent — the plan is refused whole and nothing is installed. Plans with `never` are
  unchanged for old and new agents.
- Existing deployments and policies are `never`; policy digests are unchanged.
- `rem0te-action-sim` gains `-fire-restart` (the scheduled restart, if any, happens) and `-clock-offset`.

#### Verification
- Go: `go test ./...` passes; new `internal/action` tests cover the closed rule, scheduling through the shared path
  with the fixed warning and record, a replay not scheduling twice, `never` never asking or scheduling, and each
  deferral (session open, cannot tell, window closing first, a restart already pending, installer crash, no
  restart needed, nothing installed, no maintenance surface), and an interrupted job's note. `go vet` passes for
  linux and windows.
- `unit-patch-policy.mjs`: 126 checks (was 114). `unit-approval-signer.mjs`: 92 checks (was 79): every bad rule and
  anything beside it refused at admission, the in-window plan admitted with its page wording.
- `e2e-staged-patching.mjs`: 94 checks (was 67): bad rules refused; the plan carries exactly the rule; the approval
  page; restart in the window scheduled (900 s, fixed message, job reference), stored, a post-restart scan
  requested and not due early, the simulated restart, the post-restart scan to *effective* and a completed
  deployment; an open session and a window closing first each deferring with nothing scheduled and the gate held;
  a replay not retrying. `e2e-patch-policies.mjs`: 84 checks (was 75): a `never` policy's signer refusing a restart
  plan (`reboot_not_allowed`) and an out-of-pair rule; a portal policy with the in-window rule and its approval
  page; an in-window policy signing restart and `never` plans. `e2e-maintenance-actions.mjs` 64,
  `e2e-approved-action.mjs` 76, `e2e-containment.mjs` 70 and `e2e-security-features.mjs` 42 still pass.
- `check-security-invariants.mjs` (255 checks) and `check-versions.mjs` pass; `pnpm -r lint`, `tsc --noEmit` in both
  apps, `nest build` and `next build` pass. `docs/API-REFERENCE.md` regenerated (424 routes, unchanged) and the docs
  bundle regenerated.

### Agent-signed action results

**The residual risk 0.32 left open is closed.** Under a patch policy the approval signer signs every ring after the
canary itself, on the strength of the previous ring's results. Until now those results reached it only through the
portal. A compromised portal could write a whole canary success (every update `installed`, a later scan showing it
effective) and have ring 1 signed early. Nothing failed or logged when that happened, because the signer had no way
to tell a result the computer reported from one the portal made up.

- **Each signed agent has its own result key.** The 0.34 agent generates an Ed25519 key from the OS random source
  the first time it needs one and keeps it in `C:\ProgramData\Rem0te\result-key.json`. Two processes creating it at
  once agree on one key (it's linked into place only if absent). An unusable file is set aside as `.unusable` and a
  new key is generated, which the signer then refuses as changed. The key never leaves the computer.
  `rem0te-agent.exe status` prints its public half and fingerprint.
- **It signs what the ring gate reads.**
  - Every final action result: the job id, the sha256 of the exact plan bytes the computer verified, its enrolled
    identity, the outcome, each update's final state, and whether a restart is pending.
  - Every `patch-scan`: what was offered, what history records installed, and whether a restart is pending.
  - Each statement kind has its own prefix, so a scan can't be passed off as a result. Statements travel as base64
    of the exact bytes signed, because PowerShell re-serializes the heartbeat files.
  - The journal keeps the signature, so a replayed plan returns the same one. A result journaled by an older agent
    is signed on replay.
- **The policy names each computer's key, and the signer pins it.** The portal learns the key only from that
  computer's own signed scan naming its enrolled identity, and puts it in the policy. The signer's approval page
  shows each fingerprint, marked "first time this signer sees it", "pinned" or "changed". On approval, the signer
  pins each key write-once in `device-keys/`. A later policy naming a different key is refused at proposal and at
  signing (`device_key_changed`). Only the operator CLI removes a pin:
  `device-key list` and `device-key forget --endpoint --reason`.
- **The signer verifies before the gate.** `verifiedGateTargets` opens every previous-ring result, and the canary's
  newest scan, under the policy's key. It never uses the key a statement names. Then `evaluateRingGate` runs on the
  signed facts only. The soak counts from the signed completion time. Refusals are named:

  | Code | Refused when |
  |---|---|
  | `result_signature_missing` | The canary has no signed result or scan, or a target reported succeeded is unsigned |
  | `result_signature_invalid` | The statement is edited, malformed, or signed under another prefix |
  | `result_wrong_device` | It's signed by a forger's key or another computer's genuine key, or names another identity |
  | `result_wrong_plan` | It names another job, or plan bytes other than those in the signer's own ledger (a replay) |
  | `result_stale` | It's dated outside the plan's window plus 4 h, or in the future, or the canary's scan is over 36 h old |
  | `result_key_not_pinned` | The policy predates 0.34 |

  An unsigned target can only count against a ring: pending waits, anything else (canceled included) counts as failed.
- **The portal passes the signatures through unmodified.** `AgentResult.signed` and `Posture.signed` are stored as
  received and relayed in the evidence. The portal holds no device key and verifies only to learn which key to
  propose.

**Trust on first use.** The portal also holds each computer's device secret, so the signer cannot prove a key is
the computer's the first time it sees one. Until a computer's first policy is approved, a portal that was already
compromised could propose its own key for it. After approval the key is pinned. The window is closed by comparing
the fingerprint on the signer's approval page with `rem0te-agent.exe status` on the computer, the same read-back as
the roster ceremony. A substituted key still can't widen a ring or add a computer.

**Upgrade notes.**
- Rebuild and reinstall the approval signer (`build-approval-signer.mjs`; `actions/device-result.js` is in its
  allowlist).
- Every computer in every policy ring except the last must run the 0.34 agent and have scanned once. Otherwise
  creating the policy is refused with `409 RESULT_KEY_MISSING`, and the signer refuses `result_key_missing`. The last
  ring opens nothing, so a pre-0.34 agent may sit there.
- **Policies approved under 0.32/0.33 can still run their canary but no later ring** (`result_key_not_pinned`).
  Approve them again once their computers have upgraded.
- Manual deployments are unaffected: people approve each ring.
- No migration and no new server settings.

**Verification.**
- `node scripts/check-security-invariants.mjs`: 254 checks, including the new §38 (9 checks: only one file holds the
  statement prefixes and it signs nothing; verification uses the policy's key and precedes the gate; a missing
  signature never opens the canary; the portal relays without re-signing; pins are write-once with no HTTP route to
  remove one; `result_key_missing`; one agent signing path whose prefixes match the verifier's). Each check was proved
  to fail with its guard removed (17 mutations, all caught). §14's signer-import allowlist admits `device-result`.
- Go: new `internal/devsig` tests and `internal/action` signing tests; `go test ./...` and `GOOS=windows go vet` pass.
- `unit-patch-policy.mjs`: 151 checks (was 114).
- `unit-approval-signer.mjs`: 99 (was 79).
- `e2e-patch-policies.mjs`: 89 (was 75). Five forged canary successes are refused: unsigned, forger-signed, edited,
  another computer's, and another job's. The genuine one opens ring 1.
- Unchanged and still passing: `e2e-staged-patching` 67, `e2e-approved-action` 76, `e2e-maintenance-actions` 64.

### Running approved scripts (windows.script.run@1)

#### Added
- **An approved script-library version can now run on Windows computers, as the seventh signed catalog action,
  `windows.script.run@1`.** Until now the library could write, version and review PowerShell but said plainly that
  nothing could run; this is the run path it described, built on the existing approved-action chain (separate
  signer, passkey approvals, agent-side verification, journal, containment, audit) with no second path. A run needs
  three separate approvals: the library review (an APPROVED version, approved by someone who did not write it), two
  approvers adding the version's exact SHA-256 to the **approval signer's own allowlist**, and two approvers
  approving each run. None of the five may have written or edited the content (SAME_PERSON: `contributor_cannot_approve`
  at the signer, `contributor_approved` at the agent); the run's requester can't approve it.
- **Signer-side allowlist.** The signer keeps approved script hashes in its own state directory (`scripts/`,
  `script-revocations/`), outside the portal database. The portal can propose an entry (the signer hashes the
  content itself and refuses `hash_mismatch`), read its status and revoke it; there is no route or CLI command that
  adds, activates or edits one — an entry goes ACTIVE only after two passkey approvals on the signer's own page
  (`/approve/script/:id`, showing the content as the signer holds it and the hash it computed). Revocation is keyed by
  content SHA-256 and write-once, so the same bytes can never be allowlisted again, even if the portal forgets.
  Run plans are refused unless their `script` block is exactly an ACTIVE entry (`script_not_allowlisted`,
  `script_revoked`, `script_mismatch`, `arguments_not_allowed`), checked at admission and again before signing. A
  forged ACTIVE row in the portal database does not help: the signer refuses the plan. Operator CLI: `script list`,
  `script revoke --id --reason`.
- **Closed parameters.** `{scriptVersionId, sha256, parameters, timeoutMinutes}`; timeouts 1, 5, 10, 15 or 30
  minutes; always high risk; at most 25 computers of one business per plan; not offered to ClientSt0r; requested from
  the library (`POST /endpoints/:id/actions` with it is `ACTION_NOT_DIRECT`). Arguments are typed against the
  version's declared parameters (string with a closed charset and length, integer in range, boolean, choice), with
  nothing coerced, and checked by the portal, the signer and the agent with the same charsets (TypeScript and Go).
- **The agent** verifies the signature, the signed pause and containment as for every plan, then the declared
  parameters, every argument, that no approver is a contributor, and that the content delivered beside the envelope
  is exactly the signed length and SHA-256 (`content_mismatch` otherwise) — and only then journals *executing*. It
  writes `script.ps1`, `params.json` and a fixed wrapper to a fresh temporary folder and runs
  `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass
  -File run.ps1` as SYSTEM; the command line is constant and the wrapper splats the JSON arguments (`& script.ps1
  @bound`), so an argument is never parsed as PowerShell. On Windows the process runs in a job object (started
  suspended, assigned, resumed; 1 GiB job memory limit; terminated at the timeout with everything it started).
  The first 64 KB of stdout and stderr are kept, invalid UTF-8 replaced, redacted, and reported with the exit code,
  duration and whether the temporary folder was removed. Full PowerShell, not Constrained Language Mode: the limits
  bound accidents, not a hostile script; the approvers reading the bytes are the control.
- **Output** is redacted again by the portal, stored apart from the job (`ScriptRunOutput`; the job keeps only exit
  code, timeout flag, duration and byte counts), shown on each computer's Actions tab, and deleted after 90 days by a
  new sweep (every 6 h; `SCRIPT_OUTPUT_SWEEP=off`). A pruned run keeps its status and exit code.
- **Routes** (`/api/v1/script-runs`): `GET versions/:versionId` (readiness), `POST versions/:versionId/allowlist`
  (propose; `scripts:review`, global scripts a Platform Admin or independent reviewer), `POST
  versions/:versionId/allowlist/revoke` (the same), `POST /` (request a run: library visibility and
  `actions:request` on every computer). Refusals: `NOT_APPROVED`, `NOT_A_REVIEWER`, `SCRIPT_NOT_ALLOWLISTED`,
  `SCRIPT_REVOKED`, `PARAMS_NOT_ALLOWED`, `SCRIPT_WRONG_BUSINESS`. Another business's version or run is a 404.
- **UI.** An approved version's page has a *Run this version* panel: propose to the signer, open the signer's page,
  pick computers, fill typed arguments, timeout, reason and acknowledgement, request, then a link to the approval
  page; revoke with a reason. The library notice now says how a script runs and that it hasn't run on real Windows.
  Device Actions history shows the script's name and version, exit code or timeout, and the redacted output.

#### Changed
- The heartbeat (`heartbeat.ps1`, signed channel) writes a delivered script's base64 content (≤ 100,000 characters,
  base64 charset only) to `<inbox>\<job>.script` and passes `--script <file>` to the agent; result uploads stop adding
  results past 600,000 bytes (always at least one) so script output can't push the body over 1 MB.
- `GET /scripts/:id/versions/:n` now returns the version's `id` (what the run routes take) and `execution.available`
  is true for an approved version; `GET /scripts` says how scripts run and what is proven.
- The library's parameter, content and hash rules moved to `actions/script-run.ts` (pure; also loaded by the signer)
  and are re-exported by `script-library/definition.ts`, so there is one copy.
- Security invariants: §14's exact catalog list now has seven actions, the agent's closed-param forms include
  `scriptParamsOK`, `integration: false` count is 5, the catalog's one `script:` field (the signed block) is allowed
  exactly once, the signer may import `actions/script-run`; §23 allows the script-run controller's four routes. New
  **§39**: no run without an APPROVED version and an ACTIVE signer entry; the portal can't write the allowlist
  (propose/read/revoke only, ACTIVE only from two passkey approvals, revocation write-once); the argument schema in
  all three places with identical charsets and timeouts; the agent never builds a command line (one exec, constant
  args, fixed wrapper, no `Invoke-Expression`/`-Command`); output redacted twice and only the redacted copy stored;
  90-day retention.

#### Upgrade notes
- Migration `0050_script_run` (two enum values, `ScriptAllowlistEntry`, `ScriptRunOutput` with 64 KiB CHECKs). It
  is a schema change: run `prisma migrate deploy`, rsync `prisma/` and run `prisma generate` at the target.
- **Rebuild and redeploy the approval signer** (`apps/api/scripts/build-approval-signer.mjs`; it now bundles
  `actions/script-run.js`, still no Nest or Prisma). It creates `scripts/` and `script-revocations/` itself; the
  roster and policy are unchanged.
- Computers are offered script runs only on a 0.34 signed agent that reports `windows.script.run@1`; publish the new
  agent build through the release chain as usual.
- Nothing runs until a reviewer proposes a version and two signer approvers add it.

#### Verification
- `tools/windows-installer` `go test ./...` passes, `internal/action` 52 tests, 11 of them new for scripts —
  including four under **real PowerShell 7 (pwsh) on Linux**: arguments arrive as data (`"x -Count 99"` stays one
  string), a hostile `$(...)` argument is never evaluated, the timeout kills the child process tree, and the output
  cap holds; plus success with redaction and cleanup, at-most-once, exit code and timeout, the cap, 14 refusals
  (hash mismatch, wrong length, injection, undeclared/mistyped arguments, author as approver, no content…), paused,
  no host, interruption. `GOOS=windows go build ./... && go vet ./...` pass (the job-object code compiles; it has
  not run).
- `apps/api/scripts/e2e-script-run.mjs` (new, in `scripts/run-e2e.sh`; needs `RELEASE_BIN`, `ACTION_SIM` and pwsh):
  **81 passed** — library review, proposal, the author refused on the signer, two passkey approvals, a forged ACTIVE
  portal row refused by the signer, eight injection/type refusals at the portal, business A/B isolation, a run on two
  computers through two approvals, delivery, verification, execution in PowerShell 7, redaction by the agent and
  again by the portal (a broken agent's unredacted output is caught), device history, at-most-once, a swapped
  content refused `content_mismatch`, exit code 7, a timeout, the author refused on the run, revocation (a
  half-approved run is not signed after it; re-proposal refused even after the portal deletes its record) and the
  90-day prune.
- `unit-approval-signer.mjs` **132 passed** (79 before): the signer's own hash, strict proposals, quorum of two,
  proposer/contributor/other-business refused, global needs `*`, every run refusal, contributor can't approve a run,
  revocation by content hash, the CLI.
- `unit-script-run.mjs` (new, in CI): **136 passed** — the argument table shared with the Go test, charsets vs
  PowerShell metacharacters, the shared plan rule, the catalog entry, the portal's second redaction and cap.
- Still passing: `e2e-maintenance-actions` **64** (now expects the seventh action), `e2e-approved-action` **76**,
  `e2e-script-library` **138** (now expects `execution.available`), `unit-signed-installer` **52** (with pwsh parse;
  one new check for the script handoff), `unit-script-library` 125, `unit-diagnostics-catalog` 110,
  `unit-monitoring` 100, `unit-system-inventory` 92; `check-security-invariants` (251 checks; each §39 guard and the
  changed §14/§23 guards removed one at a time — 25 mutations — and every one fails the run); `check-versions`;
  `pnpm -r lint`; `tsc --noEmit` both apps; `nest build`; `next build`; `gen-api-reference --check` against the
  runtime route table (428 = 428).
- **Not proven:** anything on real Windows — Windows PowerShell 5.1, the SYSTEM context, the job object (suspended
  start, memory limit, termination) and System32 paths have not run on a Windows computer. The Run panel and the
  device-history output view were type-checked and built but not driven in a browser; `e2e-navigation.mjs` was
  updated for the new notice but not run (it needs the docs demo stack).

### Software deployment (winget allowlist)

Closes the gap analysis's "Not implemented: Software deployment — catalog, verified packages, install/uninstall
jobs, detection rules, version compliance. Inventory only." The design is the owner's decision. A catalog holds
allowlisted winget package ids, each pinned by version and installer SHA-256. Install and uninstall are signed actions
with two approvers. Detection rules drive version compliance. Nothing is uploaded to the portal. **Fixture-tested
only:** winget, App Installer under SYSTEM, the uninstall registry and file version resources are simulated. None of
this has run on a real Windows computer, and the docs, the UI and the approval page say so.

#### Added
- **Software catalog** (`SoftwareCatalogEntry`, migration `0051_software_catalog`; **Automation → Software catalog**;
  `docs/software-deployment.md`, in the in-app docs). An entry is global (Platform Admin) or per business (its
  Business Owner, in person, not through a technician assignment). Each entry has:
  - a package id, checked against `^[A-Za-z0-9][A-Za-z0-9+_-]{0,63}(\.[A-Za-z0-9+_-]{1,64}){1,7}$` and at most 128
    characters, so it can never start with `-` or carry a space, quote, slash or shell character;
  - one exact version;
  - a lower-case installer SHA-256;
  - scope `machine`;
  - a detection rule in one of three closed forms: a display name with version from Programs and Features, an
    uninstall registry key, or a file version under Program Files / Program Files (x86).

  The hash is either read from the package's winget-pkgs installer manifest or pasted, and the entry records which:
  - **Read from the manifest:** one GET to `raw.githubusercontent.com/microsoft/winget-pkgs`, with no credentials and
    no redirects, a 10 s timeout and a 256 KB cap. The entry stores the manifest URL and its own SHA-256. An ambiguous
    manifest is refused rather than guessed (`AMBIGUOUS_INSTALLER`, `NO_MACHINE_INSTALLER`, `HASH_NOT_IN_MANIFEST`,
    `MANIFEST_MISMATCH`).
  - **Pasted:** recorded as `ADMIN_PASTED`.

  Database CHECKs repeat the charsets and the scope/business pairing, and partial unique indexes allow one live entry
  per package per catalog. Adding, changing and archiving:
  - each needs `assertFresh` (`STEP_UP_REQUIRED`, action `software.catalog`) after the permission check and before
    the write;
  - are audited as `SOFTWARE_CATALOG_CREATED` / `UPDATED` / `ARCHIVED`, with the hash and its source, and the before
    and after on a change;
  - name the revision they were made against; a stale one is `ENTRY_CHANGED`.
- **Two actions**, `windows.software.install@1` and `windows.software.uninstall@1`, appended to the end of both catalogs:
  - closed params of exactly five keys: `packageId`, `version`, `installerSha256`, `scope` and `detection`;
  - always high risk, so two approvers on the signer, on any computer;
  - at most 25 computers per plan;
  - `direct: false`: `POST /endpoints/:id/actions` answers `ACTION_NOT_DIRECT` and points at the catalog;
  - not offered to ClientSt0r.

  The approval page shows:
  - the package, version and pinned hash;
  - where the hash came from: the manifest, with the start of its digest, or *typed in by the catalog's editor*;
  - the detection rule.
- **Deployments** (`SoftwareDeployment`, with `ActionJob.softwareDeploymentId`) work like staged patching:
  - Ring 0 is a single canary, then up to four rings of at most 25 computers, all in one business. Every computer is
    checked as if requested alone.
  - Each ring is one signed plan, requested separately.
  - The canary passes only if the agent's own detection confirms the change (`effective`). A canary that already had
    the package is `canary_proved_nothing`.
  - Too many failures pause the deployment, and the failed ring is retried, never promoted past. Soak, failure
    threshold and window are set per deployment, as in patching.
  - Params are frozen at creation. A changed or archived entry stops further rings (`ENTRY_CHANGED`,
    `ENTRY_ARCHIVED`).
  - **Install** / **Uninstall** on one computer makes a one-computer deployment, which completes as soon as its plan
    has a final answer.
- **Device Software tab: Managed software.** Each entry shows its compliance with its evidence and age, and the last
  plan. **Install** / **Uninstall** appear only when possible; otherwise the tab gives the server's reason and fix:
  - a macOS or Linux computer;
  - an agent older than 0.34;
  - a legacy agent;
  - ConfigMgr in the patch posture;
  - Intune, after the agent refused with `managed_elsewhere`;
  - the computer is offline;
  - no signer is configured;
  - the person has no high-risk access;
  - a plan is already pending, or an earlier one is uncertain.

  It also warns when the last run reported winget unavailable.
- **The agent** (`internal/action/software.go`; `internal/winget` is the only exec site; `software_windows.go`), in
  order:
  1. Refuses `managed_elsewhere` when the ConfigMgr client (`CcmExec`) or the Intune Management Extension is present,
     before winget is asked anything.
  2. Finds winget for SYSTEM: the newest provisioned `Microsoft.DesktopAppInstaller_*_8wekyb3d8bbwe` under
     `%ProgramFiles%\WindowsApps`, refusing reparse points. If none is there, it answers `winget_unavailable`
     honestly; below 1.7 it answers `winget_too_old`.
  3. Detects before: if the package is already installed (or, for an uninstall, already absent), the outcome is
     `no_change` and nothing else runs.
  4. Runs `winget download` (exact id and version, `--source winget`, `--scope machine`, `--skip-dependencies`) into a
     SYSTEM-only directory.
  5. Hashes the installer itself and refuses `hash_mismatch`; refuses `manifest_hash_mismatch` if the downloaded
     manifest doesn't declare the pin.
  6. Runs `winget install --id --version --exact --source winget --silent --scope machine --skip-dependencies --accept-package-agreements --accept-source-agreements --disable-interactivity`.
     The argument array is fixed; nothing is concatenated, and no override, custom, location, force, manifest,
     header or hash-skipping flag is passed.
  7. Detects after: `succeeded` (effective), `not_effective`, or `restart_required` on winget's reboot codes.

  It journals `downloading` / `verifying` / `installing` / `detecting`, honours the signed pause and containment, and
  applies timeouts: 30 s `--version`, 20 min download, 30 min install, 20 min uninstall. An install or uninstall
  timeout is `uncertain` / `timeout`, with what detection sees then, and must be reconciled. Uninstall is
  `winget uninstall --id --exact` without `--version`, and the warning says it removes whatever version is
  installed.
- **Software compliance report** (**Reports → Software compliance**, `GET /reports/software-compliance` and
  `/export.csv`, `docs/reports.md`):
  - Each entry's Windows computers are counted as compliant, outdated, missing or unknown.
  - The newest evidence decides: the inventory's software list (display-name rules only) or the agent's own detection
    from a software plan (same package and rule only). None, or none in 14 days, is unknown, and stale ones are
    counted.
  - Business entries count only that business's computers; global entries count every visible computer, through
    `devicesWhere`.
  - The CSV export is capped and audited like the other reports.

#### Security
- **Who verifies what**, documented in `docs/software-deployment.md`:
  - the catalog editor and the approvers see the pin and its source;
  - the signer and the agent check the closed params;
  - the agent hashes what `winget download` fetched;
  - winget checks what it installs against the source manifest;
  - the detection rule confirms the result.
- **Residual, stated:** `winget install` downloads again. The agent doesn't re-hash those bytes, so an edit to the
  winget-pkgs manifest between the two steps is a window measured in seconds. Installing the verified local copy
  (`--manifest`) would close it, but needs the machine-wide `LocalManifestFiles` admin setting, which would let any
  admin install from any local manifest, so it was rejected. Dependencies are not installed.
- **No upload route, and no approve route.** The portal never holds an installer.
- **`check-security-invariants.mjs` §40 (new, 17 checks):**
  - the charset regexes are identical on agent and portal, and a hostile list (leading `-`, `;`, space, quotes, `|`,
    `$()`, backticks, `%`, slashes, newline) matches neither;
  - the params are exactly five keys with scope `machine`, and `softwareParamsOK` is the real parser;
  - both actions are high, never direct, never offered to ClientSt0r, at most `MaxRingTargets`;
  - `internal/winget` is the only exec site (`exec.CommandContext(ctx, r.Path, args...)`), with no shell and literal
    argument lists;
  - winget gets only `--version` or the three fixed lists;
  - no weakening flag, and always `--exact --source winget --scope machine`;
  - the hash and manifest checks run before install, and Execute re-parses the params;
  - `managed_elsewhere` comes before winget;
  - plans are made only through `createPlan`;
  - every route names its capability; there is no approve, sign or upload route; nothing accepts a file;
  - `assertFresh` comes before each catalog write and the audit after it;
  - the owner-in-person edit rule, and 404 for another business's entry or deployment;
  - canary of one, rings of at most 25;
  - the bounded manifest fetch, with a loopback-only `WINGET_MANIFEST_BASE`.

  §14 now lists the eight actions, adds `softwareParamsOK` to the closed forms, counts six `integration: false`, and
  includes `software.go` in "the action package runs no process". §22 expects ten report routes. Each of 36 guard
  removals (§40, and the §14/§22 changes) was shown to fail the script, then restored.

#### Upgrade notes
- Migration `0051_software_catalog` adds two tables, two enums, six `ActivityAction` values (added with `ALTER TYPE
  … ADD VALUE`, not recreated) and `ActionJob.softwareDeploymentId`. Run `prisma migrate deploy`, rsync
  `apps/api/prisma/` and `prisma generate` at the target, as for every schema change.
- The software actions need a 0.34 signed agent build (the agent must report `windows.software.install@1` /
  `uninstall@1`) and an installed approval signer. Production has neither, so the catalog can be filled but every
  computer shows Install as not possible. That is honest: it is inert, as approved actions and patching are.
- `WINGET_MANIFEST_BASE` exists only for the end-to-end test's fixture server and is ignored unless it is a
  `http://127.0.0.1:<port>` URL. Don't set it in production.

#### Verification
- Go (`tools/windows-installer`): 166 tests pass (`go test ./...`), 40 of them for software against a stub winget
  re-executed through the agent's real exec path: success, already installed, hash mismatch, manifest hash mismatch,
  winget missing and too old, managed elsewhere, download and install failure, timeout, not effective, restart
  required, uninstall, interruption, and argument injection in every field. `GOOS=windows go vet ./...` is clean.
- `unit-software.mjs` (new, in CI): 146 checks. `unit-approval-signer.mjs`: 98 (19 new: software admission refusals
  including injection, 26 targets and understated risk; two distinct approvers; the pinned hash and its source on the
  page; a 25-computer ring admitted).
- `e2e-software-deploy.mjs` (new, in `run-e2e.sh`, with `RELEASE_BIN` / `ACTION_SIM`; ports 3461–3464): 156 checks.
  They cover:
  - the catalog with the manifest fixture: read, mismatch, too large, ambiguous, per-user only;
  - step-up and roles, 22 injection refusals, and A/B isolation (404s);
  - availability states: 0.33 agent, macOS, ConfigMgr, L2, another business;
  - a single install end to end, with the exact winget argv and the journal answering a replay;
  - the already-installed no-op, the changed entry blocking a ring, hash and manifest mismatch;
  - bulk: canary not effective → paused → resumed → retried → soak → ring of two;
  - winget unavailable, a hung winget → uncertain → reconciled, Intune `managed_elsewhere`;
  - uninstall, and Globex's file-version rule;
  - containment at the portal and a signed pause at the agent;
  - the compliance numbers per entry, per business and as admin, the CSV and its audit;
  - archiving, and no upload or approve route.
- Unchanged suites still pass: `e2e-maintenance-actions` 64 (its catalog check now asserts the six through 0.32 as a
  prefix), `e2e-staged-patching` 67, `e2e-reports` 102, `e2e-approved-action` 76, `e2e-patch-policies` 75,
  `e2e-containment` 71.
- Static checks and builds: `check-security-invariants.mjs` and `check-versions.mjs` pass, as do `pnpm -r lint`,
  `tsc --noEmit` (api, web), `nest build` and `next build`. `docs/API-REFERENCE.md` regenerated and `--check`ed
  against the runtime route table (441 = 441).
- `e2e-navigation.mjs` was extended (Automation hub, the catalog page, Reports tab, the Managed software section) but
  not run here: it needs the docs stack and the `reboot_remote_docs` database.

### AI summary through ClientSt0r

#### Security
- **rem0te no longer calls a model provider. "Provider keys stay in ClientSt0r" is now true everywhere.** Until
  this release the device page's *History → AI-written summary* (once the "AI Timeline" tab) called Anthropic
  directly from the API with `ANTHROPIC_API_KEY` from `api.env`, via `@anthropic-ai/sdk`, and sent the computer's
  name, hostname, business, site, tags and up to 30 notes verbatim — passwords, e-mail and IP addresses included if
  a technician had written them in a note. It contradicted the integration's ownership rule (ClientSt0r holds every
  provider key) and was outside every integration control: no mapping, no containment, no audit of what left. It was
  inert in production only because the key was unset. The call, its `InternalServerErrorException("ANTHROPIC_API_KEY
  is not configured")` and the SDK are removed; `EndpointsService.generateTimeline` is gone.
- **The summary is now one signed request to ClientSt0r's inference gateway** (`apps/api/src/integration/
  timeline.service.ts`, `timeline.client.ts`), with the same peer, keys, request signature and response check as
  ticket analysis: the answer must be signed by the peer over rem0te's nonce and echo the request id, organization,
  profile and task, or nothing is saved (`502` with `RESPONSE_SIGNATURE_INVALID` / `RESPONSE_MISMATCH` /
  `MODEL_REFUSED` / `OUTPUT_SCHEMA_INVALID` / `GATEWAY_UNAVAILABLE`). Only `output.summary` is stored (≤ 4,000
  characters, control and bidi characters stripped, other fields dropped and counted). It is sent for the
  organization the computer's business is mapped to (none: `NOT_MAPPED`; more than one peer: `AMBIGUOUS_MAPPING`,
  rem0te will not guess), with the first profile ClientSt0r offers for the task that the peers file also allows.
- **It needs an operation ClientSt0r has not agreed, so it ships switched off against the real ClientSt0r.** The
  contract's only inference task is `ticket_triage_v1`, bound to a ticket job; reusing it would attribute the call
  to a job ClientSt0r never submitted. rem0te proposes **revision 4** in `INTEGRATION_COORDINATION.md` §5A: **P11**,
  task `device_timeline_v1` (no `job_id`); **P12**, a ClientSt0r capabilities document at a new optional peers-file
  field `capabilitiesUrl`, fetched with a signed `GET` and believed only if signed by the peer over the nonce and
  naming that peer. rem0te sends nothing until that document lists `device_timeline_v1`; until then the panel says
  *"Needs ClientSt0r support for device_timeline_v1"* and the button is disabled. No output is invented. The
  schemas are generated to `docs/contracts/ticket-rmm-v1/proposed/` from `PROPOSED_SCHEMAS`, never into
  `schemas/`, and `contract_revision` stays 2. Revision 3 (P1–P10) is still unacknowledged in §9 too.
- **What leaves rem0te is the listed minimum, redacted.** Sent: the computer's rem0te id; platform, OS and agent
  version (plain charset); enrolment state, online flag, last-seen and enrolled dates; the 30 **newest** notes (the
  old code took the 30 oldest) with date, pinned and text cut to 2,000 characters; the 20 newest sessions with date,
  state, minutes, issue and resolution cut to 500; redaction counts. Never: name, hostname, business, site, tags,
  addresses, the logged-on user, the RustDesk ID, note authors, session technicians and contacts, a session's
  separate notes field. Every free-text field passes `redactForPeer()` (`integration/timeline.ts`): `key=value` and
  "password is …" credentials, Bearer/Basic, URL userinfo, prefixed keys (`rk_`, `sk-`, `ghp_`, `xox…`), e-mail
  addresses, **every** IPv4 and IPv6 address including private ranges (stricter than the screenshot masks, because
  the integration's rule is that addresses never reach the gateway), MAC addresses, 9–10-digit RustDesk IDs, hex of
  32+ and opaque strings of 40+, user-profile paths. Pattern-based: a secret in a shape none of these match is sent
  as written. Each text is clipped to four times its cap before redaction; every pattern is bounded, and the unit
  test feeds 100,000-character pathological inputs (the first draft's e-mail and URL patterns took 15–25 s on
  `a.a.a…@`; now < 200 ms).
- **The technician sees exactly what is sent.** `GET /endpoints/{id}/timeline` returns availability and its reason
  code, the field list, what is never sent, and a preview built by the same function from the same rows as the
  request; the panel's *What is sent to ClientSt0r* shows the list and counts, and *Show the exact text* the segments
  word for word. The e2e suite asserts the preview and the sent request are byte-identical.
- **Gated, contained, audited.** Requesting needs `computers:edit` **and** `integration:ticket_analysis` in the
  business (`NO_CAPABILITY` 403, audited; Business Owners hold both; another business's computer is 404 for both
  routes). An `integration` containment pause, business or global, refuses it with `403 CONTAINED` before rem0te
  contacts ClientSt0r for anything, capabilities included. `AI_TIMELINE_REQUESTED` is written with `logOrFail`
  *before* the request leaves (peer, organization, profile, request id, field list, counts, redaction counts);
  `AI_TIMELINE_FINISHED` records outcome, model, latency and usage; `AI_TIMELINE_REFUSED` the code. No audit row
  holds a note, a session's text or the summary. `POST …/timeline/generate` is limited to 10 a minute.
- **New invariant §41** (12 checks): no model-provider SDK, endpoint or key variable anywhere in `apps/api/src` and
  none in `apps/api/package.json`; the stored summary is written from a model only by `timeline.service.ts`; the
  request goes only `timeline.service → timeline.client → signer.signedPost(peer, 'inference')`; the capabilities
  `GET` takes its URL only from `peer.capabilitiesUrl`; containment before any peer contact; nothing sent until the
  task is advertised with an allowed profile; both capabilities checked after scope; audit before send, without
  text; the snapshot selects no name, hostname, address, business, site, tags, author, contact or RustDesk field;
  every free-text field through `redactForPeer`; the proposal kept out of `CONTRACT_SCHEMAS`. Each check was made
  to fail by removing its guard and restored. §10's "one outbound call site" still holds: the capabilities `GET`
  and `signedPost` share one `fetch` in `signer.ts`, with `redirect: 'error'`.

#### Changed
- `integration:ticket_analysis`'s description now says it also covers requesting a computer's AI summary.
- `apps/api/.env.example` no longer documents `ANTHROPIC_API_KEY`; a leftover one is ignored.
- `GET /admin/integration/peers` is unchanged; the peers file accepts `capabilitiesUrl` (https, or http on
  loopback; no credentials, query or fragment — the same rules as the other two URLs).

#### Upgrade notes
- **Production dependency removed: `@anthropic-ai/sdk`.** This is a production dependency change, so per CLAUDE.md
  the deploy must **regenerate the target manifest and run `npm install --omit=dev` at the target**, not rsync
  `dist` alone:
  ```bash
  pnpm deploy:manifest -o /tmp/prod-package.json
  cd /tmp && npm install --omit=dev --package-lock-only     # checked: exits 0
  sudo cp /tmp/prod-package.json /opt/reboot-remote/api/package.json
  cd /opt/reboot-remote/api && sudo npm install --omit=dev
  ```
  The new `dist` requires nothing from the SDK, so a stale `node_modules` would still start; the reinstall keeps the
  target honest and drops the package.
- **Migration `0052_ai_timeline`** adds three `ActivityAction` values (`AI_TIMELINE_REQUESTED`,
  `AI_TIMELINE_FINISHED`, `AI_TIMELINE_REFUSED`). Schema change: run `prisma migrate deploy`, rsync `prisma/` and
  `prisma generate` at the target, or the audit writes fail with an invalid enum value.
- Remove `ANTHROPIC_API_KEY` from `/etc/reboot-remote/api.env` if present (unset in production today).
- Nothing else to configure. The summary stays unavailable until ClientSt0r acknowledges P11/P12 and serves them;
  then add `"capabilitiesUrl"` and a profile ClientSt0r offers for `device_timeline_v1` (e.g. `summary-fast`) to the
  peer in `peers.json` and restart the API. A summary stored earlier is still shown and editable.

#### Verification
- `apps/api/scripts/e2e-ai-timeline.mjs` (new, in `scripts/run-e2e.sh`): **61 passed**, against a reference peer
  modelled on the proposal (not ClientSt0r): capability off (not listed, 404, unlisted profile, forged and
  other-peer capabilities documents — nothing reaches the gateway), READY and the request (schema, task,
  organization, profile, endpoint id, no `job_id`), redaction (none of nine planted secrets nor the name, hostname,
  business, site, tag, author, contact, session notes or address; preview byte-identical to the request; a provider
  key in the environment is never used), audit (order, metadata, no text), capabilities (view-only 403, edit
  without ticket analysis 403 audited, assigned technician allowed), A/B isolation with B as the negative control,
  unmapped business, containment (business, other kinds, global; no peer contact at all), five bad answers saving
  nothing, extra output fields dropped, no `capabilitiesUrl`, no peers file.
- `apps/api/scripts/unit-ai-timeline.mjs` (new, in CI): **24 passed** — redaction per kind and false positives,
  pathological-input timing, payload order/caps/size-drop, closed request schema, field list completeness, output
  parsing, proposed schemas kept out of the contract, `capabilitiesUrl` URL rules.
- Still passing: `e2e-integration` **77**, `e2e-ticket-workflow` **53** (with `RELEASE_BIN` / `ACTION_SIM`),
  `e2e-endpoint-visibility` **114** (now also covers `GET …/timeline`), `unit-integration` **35**;
  `gen-integration-contracts --check` (18 schemas + 4 proposed, 11 signed examples); `check-security-invariants`;
  `check-versions`; `pnpm -r lint`; `tsc --noEmit` both apps; `nest build`; `next build`;
  `gen-api-reference --check` against the runtime route table (425 = 425).
- **Not proven:** anything against the real ClientSt0r (it implements neither P11 nor P12); the History panel was
  type-checked and built but not driven in a browser.

### Outbound email: alert emails and scheduled reports

0.32's reports said: "No scheduled or emailed reports: there is no outbound mail, and alert webhooks aren't a safe way
to send device inventories out." This adds outbound mail through one SMTP relay. It sends alert emails and scheduled
reports, and only to addresses whose mailbox confirmed it wants them. Mail stays off until a Platform Admin
configures it.

#### Added
- **The relay: Settings → Email** (`apps/api/src/email/`, `/settings/email`).
  - **Fields:** host, port, TLS mode, username, password, and the from address and name. There is a **Send test
    email** button.
  - **Who:** Platform Admin only. `PlatformAdminGuard` runs before anything is read.
  - **Saving** needs a fresh re-authentication (`assertFresh`, not the switchable step-up list). It is audited as
    `SMTP_SETTINGS_CHANGED` with the before and after relay. The password itself is never recorded, only
    whether it was `set`, `kept`, `cleared` or `cleared_relay_changed`.
  - **The password** is stored with AES-256-GCM under `ENCRYPTION_KEY`, bound to its purpose by AAD
    `rem0te-smtp-password-v1`. It is decrypted only to hand to the transport. No response carries it, not even
    as ciphertext: the view says only `passwordSet`.
  - **Changing host, port, username or TLS mode drops the saved password** unless a new one is entered in the same
    request. Otherwise a session that could reach the form could point the relay at its own server and receive
    the stored password at the next send.
  - **The test email** goes to the admin's own account address or to a confirmed global recipient, never to a
    typed address.
  - **Send errors** are recorded as a short code (`EAUTH 535`, `ETIMEDOUT`), never the server's text, which can
    echo what was sent, the username included.
- **The host rule (SSRF).** The API connects to a host an admin typed and speaks a line protocol to it. The
  rule is §17's rule for a business's alert destinations (a public DNS name: no IP literal, no `localhost`, no
  single-label or `.local`/`.internal`/`.corp`… name), applied twice:
  - **on save,** the name is checked, so a mistake is a 400 with the reason;
  - **on every send,** the name is resolved and *every* address returned is checked. The connection is made to
    that checked address, and the name is kept only for TLS (`servername`). A name that resolved to a public
    address when it was saved and resolves to `127.0.0.1` or `169.254.169.254` now (DNS rebinding) is refused,
    because what is checked is what is connected to. A mixed answer (one public, one internal) is refused whole.

  **A local relay** is allowed only from the API's environment, not from the portal, where a stolen admin
  session could switch it on:
  - `SMTP_ALLOW_LOCAL_RELAY=loopback` allows `localhost`, 127/8 and ::1;
  - `=private` also allows RFC 1918, 100.64/10, fc00::/7 and internal names (for an on-premises Exchange).

  **Never allowed, at any setting:** link-local (the cloud metadata address, fe80::/10), unspecified, multicast,
  documentation and NAT64. IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is judged as the IPv4 address it carries.

  **TLS:** implicit TLS or STARTTLS with `requireTLS`. A relay that does not offer STARTTLS gets nothing; there is
  no fallback to plaintext. Certificates are verified, TLS 1.2 or later. Plaintext (`none`) is allowed only when
  the address actually connected to is loopback. Nodemailer runs with `disableFileAccess` and `disableUrlAccess`,
  so nothing in a message is read from disk or fetched.
- **Confirmed recipients** (`EmailRecipient`; Settings → Monitoring → *Email recipients* per business, Settings →
  Email for the MSP's global ones).
  - **How an address becomes usable:** it is added, a confirmation link is mailed to it, and it can be used once
    someone opens the link and presses *Confirm* on the public `/verify-email` page. A GET never confirms,
    because mail scanners follow links. The token is single-use and lasts 7 days. It is stored as a SHA-256 hash
    and consumed by a conditional `updateMany`, so two clicks cannot both confirm it.
  - **Who:** adding, re-sending and removing are done by whoever decides who is notified for that scope (a
    Business Owner of the business in their own right, or the MSP). Each needs a fresh re-authentication and is
    audited (`EMAIL_RECIPIENT_ADDED`/`_VERIFIED`/`_REMOVED`).
  - **Limits:** at most 25 addresses per scope; re-send at most every 5 minutes.
  - **Scope:** a business's policies and schedules may name only that business's confirmed addresses, and global
    ones only global addresses. This is checked on save and again on send. Another business's address looks like
    a missing one (404 for lists and changes; `RECIPIENT_NOT_CONFIRMED` when named in a policy or schedule).
  - **Why confirmation links and not "users of the business":** a stolen session that can edit a policy could
    otherwise type any address and mail alert text, or a CSV of the fleet, to it. A user's account email proves
    nothing either, because accounts carry whatever an admin typed. The confirmation proves the mailbox's owner
    asked for the mail. Fresh authentication proves the person adding it has more than a cookie.
- **Email as an alert destination.** A notification level's destination is either `{label, url}` (a webhook, as
  before) or `{label, recipientId}` (a confirmed recipient of the policy's own scope).
  - **Fresh authentication** is still required to change who is notified, as before.
  - **Content:** the mail is plain text with the title, severity, computer (or site, for an outage), business,
    when the alert was raised, and a link to `/alerts?alert=<id>`. It carries none of the alert's `detail`, no
    hostname, no address and no inventory.
  - **Untrusted values** (titles and device-reported names) are reduced to one printable line first:
    control characters, line separators and bidi overrides are removed, and values are capped. So a computer
    name cannot add a header or a fake line.
  - **The result** is recorded in the alert's `notified` event (`email sent`, `email contained`,
    `email recipient_not_confirmed`…).
- **Scheduled reports: Reports → Scheduled reports** (`ReportSchedule`, `ReportDelivery`).
  - **The schedule:** weekly (a day and a time) or monthly (day 1–28, which every month has), with a time and an
    IANA time zone. It goes to up to 10 confirmed recipients, with a link to the report and optionally the CSV.
  - **Who:** a Business Owner of the business, or a Platform Admin (a platform-wide schedule is a Platform Admin's
    alone). They need the report's own capability. Creating or changing a schedule needs a fresh
    re-authentication; deleting one does not. Whoever saves a schedule becomes its owner. All of this is audited
    (`REPORT_SCHEDULE_CHANGED`).
  - **Evaluated as the owner, re-checked at send.** The owner is rebuilt from the database with
    `ActorResolverService.contextFor`, as an approved action or a patch policy is. If they are suspended, no
    longer an owner of that business, or lack the capability, the schedule **fails closed**:
    - nothing of the report is produced or sent;
    - each recipient gets a short "was not sent, and why" note with no data;
    - the schedule switches itself off, saying why;
    - the period is recorded as `failed` and audited as `REPORT_SCHEDULE_FAILED`.
  - **The CSV is the same export a person downloads** (`ReportsService.exportCsv`): the same row cap (refused
    above it, and the recipients are told so, never sent a truncated file), the same formula-cell
    neutralisation, and the same `REPORT_EXPORTED` audit row as the owner. That row now also records
    `via: 'schedule'`, the schedule id and the recipient count.
  - **Period:** a weekly schedule reports on 7 days, a monthly one on 30.
  - **Exactly once per period.** A `ReportDelivery` row unique on (schedule, period) is created *before* anything
    is sent. A second sweep, a restart or a second API process finds the row and sends nothing. The period key is
    the occurrence's local date (`W:2026-11-09`) or month (`M:2026-11`).
  - **A crash between the claim and the send leaves the period `sending` and it is not retried.** A missed report
    can be recovered by a person; a duplicate CSV in someone's mailbox cannot.
  - **Late periods:** a period that the server was not running to send within a day (`CATCH_UP_MS`) is recorded
    as `missed`, not sent days late as if on time.
  - **Time zones and daylight saving** use the 0.32 update-window maths (`utcOffsetMinutes`; wall clocks read
    with Intl, never computed):
    - a time that does not exist that night (spring forward) is due at the jump, when a window starting then
      would open;
    - a time that happens twice (fall back) is due the first time only, because the period key is the date.
  - **The sweep** runs every `REPORT_SCHEDULE_SWEEP_SECONDS` (60), takes at most 20 due schedules a pass, and
    moves each schedule's `nextRunAt` on before sending. `REPORT_SCHEDULE_SWEEP=off` stops it in a process.
- **A `notifications` containment kind** stops every email this server sends: alert emails, scheduled reports,
  confirmation and test messages. It works globally or per business; a blocked report period is recorded as
  `blocked`, not queued.
  - **Not `integration`:** the two answer different incidents. A business suspending ClientSt0r jobs still wants
    to hear about a disk filling, and stopping mail (say, a schedule sending a fleet list somewhere it should not)
    should not stop ticket analysis.
  - **New pauses:** "pause everything" (the default kinds) now includes it.
  - **Webhooks are not covered.** They go to systems the MSP or business configured as its own, and 0.29 keeps
    monitoring telling people during a pause on purpose. Whether a `notifications` pause should also hold
    webhooks is left as a decision.

#### Security
- §42 in `scripts/check-security-invariants.mjs` checks:
  - relay settings are Platform Admin only, with fresh authentication;
  - fresh authentication on recipients (add, re-send, remove) and on creating or changing a schedule;
  - the host rule on save, and on send every address resolved and checked, with the connection to the checked
    address and the name only as `servername`;
  - plaintext only to loopback, certificates verified, STARTTLS required;
  - no file or URL access in messages;
  - the `notifications` pause in `send()` and in schedule delivery;
  - recipients filtered on scope and confirmation, and `assertConfirmed` on policies and schedules;
  - the conditional token consumption, and no GET verify route;
  - no password in the audit row, view, logs or error codes, and the password dropped when the relay moves;
  - the delivery claim made before the send, unique per period;
  - the owner rebuilt and refused before the export;
  - the alert mail built from the listed fields only.

  Each of its 15 checks was shown to fail when its guard is removed: 22 mutations, all caught.

#### Changed
- `MonitoringAdminService`'s rule for who decides who is notified is now `mayManageNotifications` in
  `monitoring/notify-who.ts` (no service imports). Email recipients and scheduled reports use the same rule.
- `ReportsService.exportCsv` takes an optional `via` (schedule id and recipient count) for its audit row.
- The containment page offers *Outbound email*.
- The alerts page opens `/alerts?alert=<id>`, and says so when the alert is not one you can see.

#### Upgrade notes
- **A production dependency:** `nodemailer` 10.2.1 (pinned, no dependencies of its own, ships its own types).
  Regenerate the deploy manifest and install it at the target, checking npm's exit code before rsyncing
  anything (CLAUDE.md):
  ```bash
  pnpm deploy:manifest -o /tmp/prod-package.json
  cd /tmp && npm install --omit=dev --package-lock-only     # must exit 0
  sudo cp /tmp/prod-package.json /opt/reboot-remote/api/package.json
  cd /opt/reboot-remote/api && sudo npm install --omit=dev
  ```
  Rsyncing `dist` without this works until the next restart, then the API fails to start
  (`Cannot find module 'nodemailer'`).
- **A migration:** `0054_outbound_email`. It adds eight `ActivityAction` values and the tables `SmtpSettings`,
  `EmailRecipient`, `ReportSchedule` and `ReportDelivery`, with CHECK constraints (singleton row, TLS modes,
  report keys, the weekly/monthly shape, `HH:MM`, 1–10 recipients, delivery statuses). Run
  `prisma migrate deploy`, rsync `prisma/` and run `prisma generate` at the target, as for any schema change.
- **Mail is off until configured.** Nothing is sent after the upgrade until a Platform Admin saves and enables a
  relay. A relay on the same host needs `SMTP_ALLOW_LOCAL_RELAY=loopback` in `/etc/reboot-remote/api.env`; one on
  the LAN needs `=private`.
- `REPORT_SCHEDULE_SWEEP=off` is now in `scripts/run-e2e.sh`'s global and scratch-API environments. The email
  suite turns it on for its own API.
- An existing pause made with "every kind" does not gain `notifications`, because its kinds are stored. Add a
  new pause to stop mail.

#### Verification
- `apps/api/scripts/unit-email.mjs` (in CI): **122 passed, 0 failed**. It covers:
  - every address class, including IPv4-mapped IPv6, and what each `SMTP_ALLOW_LOCAL_RELAY` value admits;
  - every resolved address checked, and plaintext only to loopback;
  - schedule validation, and weekly and monthly occurrences in +5:30, +13 and New York;
  - both DST transitions, Lord Howe's 30-minute shift and a London monthly on its DST day;
  - **400 random weekly schedules in nine DST-heavy zones, each equal to the update window's own next opening**;
  - previous ≤ now < next across 480 cases;
  - alert mail redaction and header-injection attempts, and address normalisation.
- `apps/api/scripts/e2e-email.mjs` (in `run-e2e.sh`; ports 3491–3493): **92 passed, 0 failed**, against the real
  built API and an SMTP server written into the test (no dependency). It covers:
  - the relay: off until configured; refused without fresh authentication or as a Business Owner; six refused
    hosts; plaintext to a non-loopback host refused; a header in the from address refused;
  - the password: not in the response, stored as AES-GCM, kept on an identical save, and refused-to-reuse when
    the port changes;
  - the test email, which reached the relay authenticated with the saved credentials as the relay saw them;
  - STARTTLS required against a relay that does not offer it: nothing reached it;
  - recipients: the confirmation link works once and a made-up token does nothing; B cannot list, add to or
    remove from A; a Business User cannot add; a policy or schedule naming an unconfirmed address, or another
    business's, is refused;
  - the alert email has title, severity, computer, business and link, and none of the detail, hostname, computer
    id, site or B;
  - a business `notifications` pause stops A's alert mail but not B's or the platform's test email; a global
    pause stops even the test email;
  - a scheduled report is mailed with the audited CSV (`REPORT_EXPORTED` via the schedule);
  - exactly once per period: across repeated sweeps, across an API restart, and with **two API processes sweeping
    one database**;
  - a period more than a day late is recorded `missed`; a paused business's period is `blocked`;
  - a demoted owner's schedule fails closed: a no-data notice, the schedule switched off, `REPORT_SCHEDULE_FAILED`,
    and no export;
  - the relay password in no audit row, response or API output.
- Re-run because their code changed: `e2e-monitoring.mjs` 108 passed, `e2e-reports.mjs` 102 passed,
  `e2e-containment.mjs` 71 passed. Its "every kind" check now expects five kinds.
- `node scripts/check-security-invariants.mjs`: all hold, including §42's 15 checks. `check-versions.mjs` passes.
- `pnpm -r lint`, `npx tsc --noEmit` in both apps, `npx nest build` and `npx next build`: pass.
  `gen-api-reference.mjs --check` against the runtime route table: 437 = 437.
- **Not run:** `apps/web/scripts/e2e-navigation.mjs`, which was extended for the new menu entries, `?alert=` and
  the public `/verify-email`. It needs the isolated docs stack (port 4000 and the `reboot_remote_docs` database).
  Real TLS (implicit or STARTTLS) against a relay with a certificate has not been exercised. Only plaintext to
  loopback, and the refusal when STARTTLS is not offered, were.

### Agent upgrade from the console

**What changed**

- **Agent card** on the device workspace (Overview): the agent type (standard, signed, read-only Linux/macOS), its version and whether it is current, the update channel, the portal's update mode, and for a signed agent the result and time of its last update check. `GET /endpoints/:id/agent` (computers:view).
- **Update agent** (`POST /endpoints/:id/agent/update`, computers:edit). A standard Windows agent re-runs the current installer through the existing reinstall path, with the same permission, containment and audit. A signed agent gets **Check for update now** (the hook runs `rem0te-agent.exe update`, which installs only what the signed repository lists). Linux and macOS are refused with the exact `curl … | sudo bash` command to run on the computer.
- **Upgrade to signed agent** (`POST /endpoints/:id/agent/migrate`, `…/migrate/cancel`). This queues for one computer the same migration script that *Signed only + portal migration* serves. It needs computers:edit (the same as reinstall), a fresh sign-in (`assertFresh`, action `agent.migrate`) and a 3–400 character reason. Audited as `AGENT_MIGRATION_REQUESTED`, `_CANCELLED` and `_COMPLETED`. Each unmet precondition is refused by name: `NO_SIGNED_RELEASE` (with a link to Update signing → Roles and keys), `NO_DEVICE_SECRET`, `NOT_WINDOWS`, `LINUX_AGENT_READ_ONLY`/`MACOS_AGENT_READ_ONLY`, `ALREADY_SIGNED`, `ARCHIVED`, `NO_PORTAL_ADDRESS`, `SIGNED_ONLY`, `CONTAINED` and `IN_ROLLOUT`.
- **Bulk:** `agent.update` and `agent.migrate` join the 0.33 bulk path. It takes at most 200 computers, checks fresh auth once, and gives per-computer results and refusals. The fleet-abuse budget stops the run before a person's thresholds.
- **Migration status** page (`/endpoints/agent-migrations`, `GET /agent-migrations`) lists computers by state: pending, held (with the reason), dispatched, downloaded, not confirmed, completed and cancelled.
- **Patches tab:** "What to do" now points at the Agent card when the computer can be moved. Otherwise it names exactly what is missing, for example "No signed release is published. Publishing one needs the offline signing keys only you hold", with a link.
- **Heartbeat:** the standard heartbeat's script reads `C:\ProgramData\Rem0te\agent-status.json` (the signed agent's last check and result) and reports them. They are stored only if the time is plausible, and only as inert text.

**How it works, and why**

- **Targeting:** only that computer's own authenticated heartbeat is handed the reinstall flag with a one-off nonce (`mig_` + 40 characters).
- **The served script:** `windows.ps1?updateNonce=<nonce>` serves the migration script, pinned to the digest of `windows/rem0te-agent.exe` in the signed targets the portal serves at that moment.
- **Holds:** the request is held, not handed out, while:
  - an `updates` pause applies;
  - a staged rollout owns the computer;
  - no signed agent is published;
  - or the mode is tightened to Signed only after the request. In that case the nonce serves a script that runs nothing.
- **Completion:** the request completes when the computer's heartbeat reports the signed channel. At most one request per computer is open (partial unique index).
- **Mode boundary:** allowed in *Legacy allowed* and in *Signed only + portal migration*; refused in *Signed only*. That mode contains legacy agents by withholding portal-served scripts. Allowing a per-computer migration there would let one person reopen, machine by machine, a path that turning on portal migration puts to review. A per-computer request never writes the mode (§43).
- **Why no second approver:** a standard agent already trusts the portal completely, since anyone who can press Reinstall can run the portal's installer there as SYSTEM. The migration is one more such run of a fixed script, and it leaves the machine trusting only offline-signed code.

**Fixed along the way**

- **The portal-migration script built a broken staging path.** The script served by *Signed only + portal migration* (shared since this release) wrote `'Rem0te\setup\migrate'` inside a JavaScript template literal, so the backslashes were swallowed and the path became `Rem0tesetupmigrate`.
  - It now stages in a fresh, randomly named `Rem0te-migrate-<guid>` directory, created without `-Force` and locked to SYSTEM and Administrators.
  - The script is now parsed under pwsh in `unit-agent-migration.mjs`.
- **The reinstall flag now clears on a signed agent.** It is cleared when a signed agent reports a check after the flag went out, so Check for update now no longer re-runs on every heartbeat.

**Upgrade notes**

- **Migration `0055_agent_migration`:** three ActivityAction values, `Endpoint.agentUpdateCheckedAt` / `agentUpdateResult`, and the `AgentMigration` table. Run `prisma migrate deploy`, rsync `prisma/` and run `prisma generate` at the target.
- **Re-sign install.ps1:** `windows-script.ts` changed (the agent-status block). Standard agents pick it up on their next reinstall. The signed channel's `install.ps1` must be re-signed and published before signed agents report their last update result. Until then the card says the result is not reported.
- **No new production dependency.**
- **Expect "not confirmed":** the standard heartbeat does not report the migration script's exit code. A request dispatched over 2 h ago whose computer still reports standard shows as *not confirmed*, not *failed*.
- **Agents older than 0.20** ignore the nonce: they first reinstall the current standard agent, and migrate on a later attempt.
- **Never run on real Windows:** neither the migration script nor `migrate` has been.

**Verification**

| Check | Result |
|---|---|
| `e2e-agent-upgrade.mjs` | 94 passed. Covers: a real signed repo built with `rem0te-release` from the branch; every precondition and refusal; heartbeat targeting (only the named computer gets the nonce); the digest pin; held states; update-agent per agent type; bulk refusals with per-computer codes; audit (the 200 cap is the existing bulk path's, covered by e2e-device-views and §29); business A/B isolation as 404 |
| `unit-agent-migration.mjs` | 57 passed, including a pwsh parse of the served script and the heartbeat's agent-status block run against fixtures |
| `unit-device-views.mjs` | 64 passed |
| `unit-signed-installer.mjs` (with PWSH) | 51 passed |
| `e2e-signed-updates.mjs` | 46 passed |
| `e2e-device-views.mjs` | 117 passed |
| `e2e-rollouts.mjs` (with `HBBS_PRESENCE_HOST=127.0.0.2`) | 46 passed |
| `check-security-invariants.mjs` | all hold. New §43 has 8 checks: per-computer migration never writes the mode; the served script pins the repository digest; it is served only for an open nonce; the request needs computers:edit and `assertFresh`, single and bulk; Signed only without portal migration refuses, holds and serves nothing; only an authenticated heartbeat is handed a nonce; and the request is recorded only with its audit entry. 10 of 10 mutants were caught. §29 now expects six bulk actions |
| `API-REFERENCE.md` | regenerated (429 routes) and verified against the runtime route table |
| `pnpm -r lint`, `tsc --noEmit` (both apps), `nest build`, `next build` | clean |

### Phone-width layout and a browser suite in CI

#### Fixed
- **The console was unusable at phone width.** The sidebar was a fixed 240 px column on every signed-in page, so a
  375 px phone had 135 px left for the page itself, and nothing collapsed it (found in 0.33). Below Tailwind's `md`
  (768 px) the sidebar is now an off-canvas drawer opened by a **menu button** at the left of the top bar
  (`components/layout/nav-drawer.tsx`). It is the same `Sidebar` component, so it holds everything the sidebar does:
  the business switcher, Settings, Help, the theme toggle, Sign out and the version.
  The drawer is a Radix dialog, which is what makes it accessible rather than only visible. Focus moves into it and
  Tab / Shift+Tab stay there. The page behind is `aria-hidden`, and the dialog carries `aria-modal` and the name
  *Main menu*. Esc, a tap outside and its close button all close it. Focus then returns to the menu button, which
  Radix does not do on its own for a trigger outside its tree, so `onCloseAutoFocus` does it. The menu button reports
  `aria-expanded`. The drawer also closes on navigation: on any route change, and on a click on a link to the page
  already open, which changes no pathname. Widening the window past `md` closes it too.
- **Pages that scrolled sideways at 375 px**, each found by the new suite and fixed where the overflow started,
  never by clipping `<main>`:
  - **`<main>` itself** had no `min-w-0`. A flex child's minimum width is its content's by default, so one wide row
    could widen the whole page instead of scrolling in its own container.
  - **Device list:** the Views / Columns / density / Export CSV group did not wrap, so the page was 132 px too wide
    (241 px with a saved view's name on the Views button).
  - **Settings:** the SSO redirect URI on the public-address card is one unbreakable string. It now breaks anywhere.
  - **Settings → Monitoring:** the *Add recommended* / *New monitor* buttons sat beside the card title on one line.
  - **About / Updates:** release notes are `whitespace-pre-wrap` text with long package names, which do not break.
    They now wrap anywhere (`break-words`). The overflow was 59 px.
  - **`PageHeader`** (every page title) stacks the title above its actions below `sm`, and the actions wrap. Before,
    the description was squeezed to a few words a line beside the buttons.
  - **Register by RustDesk ID** used a fixed two-column grid at every width. It is one column below `sm`.
- **Nothing else broke in the browser.** The suite found no console error, uncaught exception or unexpected failed
  request on any page it opens, at either width or in either theme. Several of those pages had never been opened by
  any test: the device views and bulk UI, the step-up on API keys and Add device, the Performance / Processes /
  Services / Network tabs, the Reports pages and System status.

#### Added
- **`apps/web/scripts/e2e-ui.mjs`: the console in a real browser, with no docs stack.** It starts its own API from
  `apps/api/dist` on 3502 against `DATABASE_URL`, with every sweep off. It copies the web standalone build, building
  it first if there is none, and patches the copy's baked-in API rewrite (`server.js`, `routes-manifest.json`,
  `required-server-files.json`; CLAUDE.md) to that API, then serves the copy on 3501. It migrates the database, runs
  the seed if there is no tenant, and adds its own fixtures: two businesses, a Platform Admin, a Business Owner and
  seven devices. One device has inventory, a day of metric samples, a week of hourly roll-ups and stored
  process, service and adapter snapshots. The fixtures are removed afterwards.
  At **1440 × 900 and 375 × 812, in the light and dark themes** (set through the app's own `localStorage.theme`
  before its scripts run, then checked on `<html class>` and the body colour), it covers:
  - **sign-in;**
  - **the shell:** the desktop sidebar, or at 375 px the drawer: role, name, `aria-modal`, `aria-expanded`, fit,
    a 48-key Tab / Shift+Tab focus-trap walk, Esc with focus return, a tap outside, and navigation to another page
    and to the same page;
  - **Devices:** the list, then one device and **all twelve workspace tabs**. Overview, Performance (a chart),
    Processes, Services and Network must show the fixture data, not just render;
  - **saved views:** saved (checked in the database), cleared, and reopened with its search and rows;
  - **bulk selection:** two rows, *Refresh inventory* with its per-device result, the select-all header and Clear
    selection;
  - **the search palette:** Ctrl+K at desktop, the button at 375 px, Enter to open the device, Esc to close;
  - **Add device:** the step-up dialog is cancelled (no token in the database, the "No link was made" note, the
    choices kept), then confirmed (exactly one token, the install command shown);
  - **API keys** as the Business Owner: a key with `enrollment:write` asks for step-up; closing it creates nothing
    and keeps the form, and confirming creates the key, shows it once and lists it;
  - **Reports:** `/reports` opens the first one, and each of the four renders;
  - **System status:** its cards, and the Data retention card's table rows where the build has that card.
  At 375 px no checked page may scroll sideways (the document or `<main>`), and the device list's table must
  scroll inside its own container. In the light theme it also sweeps every page in the menu (Settings expanded)
  plus the hub tabs and reports, 32 pages, at both widths: no sideways scroll, no error.
  **Any console error, uncaught exception, failed same-origin request or network failure** on a page fails that
  page's check. The only exceptions are the 403 `STEP_UP_REQUIRED` answers the step-up flows provoke on purpose, and
  the 401s from `/auth/*` on the sign-in page before signing in. Each sign-in first injects a `console.error` and a
  thrown exception and checks that both are caught, so a broken detector cannot pass as a clean page.
  Finally it runs `e2e-search-palette.mjs` (24 checks) against the same stack. That suite, like
  `e2e-navigation.mjs`, used to need the docs stack and ran by hand.
- **Hydration marker.** `<html data-hydrated="1">` is set once React has hydrated (`HydrationMarker` in the root
  layout). The suite waits for it before every interaction. A server-rendered button is visible before its handler
  is attached, and a click in that gap does nothing. That is the race that makes browser suites flaky enough to be
  switched off. Every other wait is on a condition, never a fixed sleep: rows equal to a count, a dialog's
  visibility, a database row.
- **CI:** the `e2e` job now builds the web app, installs the browser
  (`npx playwright install --with-deps chromium-headless-shell`, the shell Playwright 1.65 runs headless) and runs
  the suite as the step `UI suite (browser)` (`id: ui`) against the job's database, after `scripts/run-e2e.sh`. It
  is a step in the required `e2e` context, not a new job, so branch protection covers it with no settings change.
  It runs even when an API suite failed (`if: !cancelled()`), so one red suite does not hide the other. Screenshots
  go to the failure artifact with the e2e logs. The job's timeout is 60 → 80 minutes: about 4 minutes locally for
  the suite, plus a web build.
- **Security invariants §44** (and §18 now includes `e2e-ui.mjs`). The suite refuses ports 3000, 3001, 443, 4000
  and 4001 for both servers before starting anything, and https. It refuses a database not named `test` or
  `scratch` before Prisma is loaded. It writes only to files joined from its temporary copy. It stops if the
  build's API destination survives the patch: on this host that destination is the production API on 3001, so a
  missed patch would point a fixture-seeding browser at production. Its API runs with every sweep off. Each check
  was proven to fail with its guard removed (7 mutations, including dropping the https refusal for §18).
- Docs: *On a phone or a narrow window* in the technician guide (and in the app at `/docs`), *Using Rem0te on a
  Phone* in `/help`, a row and a not-implemented bullet in `docs/rmm-gap-analysis.md`, and `.github/SECURITY.md`.

#### Upgrade notes
- No migration, no API change, no new dependency (Playwright was already a devDependency of the web app).
- Running it locally:
  `DATABASE_URL=postgresql://…/<name with test or scratch> node apps/web/scripts/e2e-ui.mjs`, after
  `pnpm --filter @reboot-remote/api build` and `npx playwright install chromium-headless-shell`. An existing
  `apps/web/.next/standalone` is used as it is. **Rebuild the web app after changing it** (or set `UI_REBUILD=1`),
  or the suite tests the old build. `UI_WEB_PORT` / `UI_API_PORT` move it off 3501/3502, `OUT_DIR` keeps the
  screenshots, `UI_SKIP_PALETTE=1` skips the palette suite, and `UI_HOLD=1` leaves the stack up for debugging (and
  reports a failure, so it can never pass as a run).
- `e2e-navigation.mjs` still needs the docs stack (it reads the demo data) and stays a manual run.

#### Not done
- Chromium only. No WebKit/Safari and no real phone, so iOS-specific behaviour (safe areas, the URL bar resizing the
  viewport) is untested.
- Pages are made to fit a phone, not redesigned for one. The device list's eight filters still stack above the
  table at 375 px.
- The screenshots are kept but compared to nothing: there is no visual-regression check.

#### Verification
- `e2e-ui.mjs`: **3 consecutive green runs, 406 passed, 0 failed each** (230–239 s each), against a scratch
  database, with the search-palette suite's 24 checks inside. Before the fixes, the first full run failed 10 checks:
  the drawer's `aria-modal` and focus return, the device-list toolbar, the bulk bar's Views button, `/settings`,
  `/about`, `/settings/monitoring` and an API-key list race in the suite itself.
- `check-security-invariants.mjs` (§44: 5 checks, plus §18 for the new script; all 7 mutations caught),
  `check-versions.mjs`, `pnpm -r lint`, `tsc --noEmit` in both apps, `nest build`, `next build`.

### Screenshots and gallery regenerated from 0.33 (usability finding 7)

The GitHub gallery still showed v0.18.10: the old dashboard tiles, *Enroll Client*
and *Generate Enrollment Link*, and none of the 0.31–0.33 pages. The in-app
guide had no images for any of those pages either.

- **Gallery** (`docs/images/github/`, `docs/screenshots.md`). 56 images from
  0.33, in light and dark, with three at phone width (390×844): the dashboard,
  the device list and a device page. They are honest about the layout: the
  sidebar does not collapse on a phone yet.
  - Added: search, alerts, bulk actions, saved views, a Linux device, every
    device tab, three reports, the script library and review, client-update
    windows, and patching.
  - `enroll-device-*` is replaced by `add-device-*`.
  - `manifest.json` now records the viewport of each shot.
  - README counts and alt text updated.
- **Guide** (`docs/screenshots/guide/`). 20 new numbered-callout images, each
  followed by its key, in these pages:
  - technician-guide: dashboard, device map, device list, views, search, device
    overview, Patches, and Add device steps 1–3
  - metric-history, diagnostics (Processes, Services, Network), reports,
    script-library, updates (client updates), patching-setup
  - `tech-02-computers` was re-pointed at the 0.32 *Add device*, and its
    "predates 0.31" note was removed.
- **Demo data.** New `apps/api/prisma/_docs-demo-workbench.ts`. It is
  idempotent and refuses any database other than `reboot_remote_docs`. It seeds:
  - Linux and macOS computers
  - 30 days of metric history, with one gap
  - process, service and network snapshots, passed through the API's own
    sanitiser and cap
  - groups and shared views
  - resolved alert history
  - scripts with approved and in-review versions
  - client-update policies
  - patch policies
  - a fictional relay host, and Quick Connect turned on
- **Capture scripts.**
  - Callout boxes are clamped to the window. A table taller than the screen
    used to stretch the image to about 2,700 px of empty frame.
  - The finder supports `exact`, `within`, `card` and selector tags.
  - Both scripts resolve `@script:<name>`.
  - capture-media adds `narrow` viewports and `before` hooks.
  - The `@resources` and `@specs` anchors were fixed: the card heading is now
    an `<h3>`. Without the fix, *device-resources* was silently a full-page shot.
  - The specs grid is captured without the sticky search bar printed over it.
  - The §18 refusals are unchanged.

### Chat with the person at a computer

#### Added
- **Two-way chat between a technician and whoever is signed in at a managed Windows computer**
  ([docs/chat.md](docs/chat.md)). Before this, the only way to talk to the person at a computer was outside Rem0te
  (phone, e-mail) or RustDesk's in-session chat, which needs a session to be running. A technician now opens the
  computer's new **Chat** tab and presses **Start chat**. A small window opens on that computer's desktop and the
  person can reply or close it. The tab sits on the device workspace before History, on every computer the viewer can
  see (`?tab=chat`).
- **The window says who is writing, where a message cannot reach.** Its title is `Support chat - <business>` and its
  banner names the technician and the business. The technician is shown by first and last name, never the e-mail; an
  empty name is "Technician". The banner also says the business will never ask for a password and that links are
  never opened. Both names are fixed when the chat starts and come from the portal, so nothing in a message can set
  them. Messages appear in a read-only plain `EDIT` control, so nothing in them becomes a link. The window has no
  rich-text control and does no `ShellExecute`.
- **Signed agent only, and the portal says so for everything else.** Chat needs the signed agent (update channel
  `signed`) reporting chat protocol 1. The agent adds `chat: 1` to its status and the signed heartbeat sends it as
  `agentChat`. Every other computer shows on the Chat tab why it cannot chat, and `POST …/chat/conversations` is
  refused with `409 CHAT_UNSUPPORTED` and the same reason:
  - Linux or macOS: "not available … yet";
  - the standard Windows agent;
  - a signed agent older than 0.34;
  - no device secret bound;
  - archived.

  Why the signed agent: a SYSTEM service has no visible desktop, so showing a window means
  `WTSQueryUserToken` + `CreateProcessAsUser` into the user's session, plus a pipe ACL'd to that user. In the
  standard agent that would be generated PowerShell P/Invoke that nothing on the build host can parse or test. In the
  signed agent it is compiled, unit-tested Go that reaches a computer only through the signed update chain.
  **Production is on the standard channel, so chat does nothing there until the signed agent is rolled out.**
- **A bounded fast path.** The 3-minute heartbeat only says `chat: { open: true }` to an authenticated signed agent
  that can chat. The signed heartbeat hook then starts `rem0te-agent.exe chat`, which is single-instance through a
  lock file. That host long-polls `POST /enrollment/chat/poll` with the device secret, exactly as the heartbeat
  authenticates:
  - the API holds a poll for up to 25 s, re-reads the database every 10 s, and wakes the poll at once when the
    technician sends or ends;
  - there is one held poll per computer, and a newer poll releases the older;
  - at most `CHAT_MAX_WAITERS` (500) polls are held at once; past that the API answers at once with `retryAfterMs`;
  - replies go to `POST /enrollment/chat/reply` with a client id, so a retry stores nothing twice.

  A wrong or missing secret is `401` and is audited as `ENDPOINT_HEARTBEAT_REJECTED`
  (`chat_poll_unauthenticated` / `chat_reply_unauthenticated`).
- **The window process is unprivileged and holds no secret.** It is the same signed binary started as the user with
  `chat-window`, and it talks only to the host:
  - **No secret, no network.** It has no HTTP client and cannot read `heartbeat.dat`.
  - **Locked-down pipes.** Two one-way named pipes are created with `FILE_FLAG_FIRST_PIPE_INSTANCE` and
    `PIPE_REJECT_REMOTE_CLIENTS`. Their protected DACL is `D:P(A;;GA;;;SY)(A;;GRGW;;;<user SID>)`, and the SID must
    be a real user account's.
  - **Checked peer.** The host checks that the pipe client's PID is the process it launched, and that its first frame
    carries a per-launch random nonce.
  - **Strict frames.** Each frame is JSON of at most 16 KB, with a closed field set per type. Anything else closes
    the window.
  - **Session choice.** The console session comes first. Otherwise the window goes to the single active RDP session.
    With none, or several, the host reports "nobody is signed in" instead of choosing.
- **Status the technician can trust.** Each technician message shows *Sent*, *Delivered* (the agent has it), *Shown*
  (the window drew it) or *Read* (drawn while the window was in front). Each is set only when the agent confirms it,
  once, and only for that computer's own messages; a shown receipt also implies delivered. The panel also shows what
  the agent last reported:
  - waiting for the next check-in;
  - opening the window;
  - window open, with the signed-in account;
  - nobody signed in;
  - the window could not be opened, with the reason;
  - the computer silent for over a minute;
  - ended, saying by whom.

  "No user signed in" and "agent version can't chat" are real states, not errors.
- **Endings.** A chat ends when the technician ends it, when the person closes the window (`end_user`), or after two
  hours with no message (`inactive`). The chat host exits after 12 hours, and the next heartbeat restarts it if the
  chat is still open.
- **Transcripts belong to the computer** and can be linked to a support request. Linking needs *Handle support
  requests*, and the request must be in the same business and on the same computer or none. Anyone who can see the
  computer can read its transcripts (`computers:view`). The tab lists the last 25 conversations.
- **400-day retention with its own sweep** (`apps/api/src/chat/`). Ended conversations are deleted with their messages
  400 days after they ended. The sweep runs hourly, deletes in batches and records one `CHAT_PRUNED` audit entry
  (counts only) per pass that deleted anything. The same sweep ends chats that have been quiet for two hours.
  Settings:
  - `CHAT_RETENTION_SWEEP=off` stops it;
  - `CHAT_RETENTION_DAYS` (30–3650);
  - `CHAT_SWEEP_SECONDS`;
  - `CHAT_PRUNE_BATCH` / `CHAT_PRUNE_BATCHES` (500 / 20);
  - `CHAT_MAX_WAITERS` (1–20,000).

  Out-of-range values are clamped, and ones that cannot be parsed take the default.
- New capability **`support:chat`** (*Chat with the person at a computer*) to start, write and end. It is in the
  Support group and in no preset or default; Business Owners and Platform Admins hold it implicitly. For an MSP
  technician the assignment must grant it over that computer.
- New routes:
  - `GET /endpoints/:id/chat`;
  - `GET /endpoints/:id/chat/conversations/:cid`;
  - `POST /endpoints/:id/chat/conversations`;
  - `POST …/:cid/messages`;
  - `POST …/:cid/end`;
  - `POST /enrollment/chat/poll`;
  - `POST /enrollment/chat/reply`.

  Migration `0056_chat` adds:
  - `ChatConversation` and `ChatMessage`, and `Endpoint.chatProtocol`;
  - the audit actions `CHAT_STARTED`, `CHAT_ENDED` and `CHAT_PRUNED`;
  - a partial unique index (one open chat per computer);
  - CHECKs on the device state, on the ended reason and its consistency, on body length (1–2,000), and that receipts
    exist only on technician messages.

#### Security
- **Scoping.** Every technician route goes through `assertEndpointInScope` and then
  `findFirst({ where: { AND: [endpointVisibilityWhere(actor), { id }] } })`. Another business's computer, or one a
  Business User has not been given, is a 404 like the computer itself. A conversation is found only through its
  computer.
- **Containment.** A `remote` pause now covers chat: while one covers the business, starting a chat and sending a
  message are `403 CONTAINED`, and the tab says why. An open chat stays readable and can be ended. The pause label is
  now "remote connections and chat", in the API and in the banner.
- **Untrusted text, both ways.**
  - **Length.** At most 2,000 characters, refused rather than cut. The cap is enforced in the API, the database and
    the agent.
  - **Rate.** 20 messages a minute per side per conversation, 30 a minute per computer, and 1,000 per conversation
    (`CHAT_RATE_LIMITED` 429, `CHAT_FULL` 409).
  - **Control characters.** C0/C1 controls, ESC, DEL, bidi overrides and isolates, and U+2028/2029 are dropped;
    tabs and newlines are kept, with at most 20 newlines in a row.
  - **Device-reported names** are reduced to one line of at most 64 characters.
  - **Rendering.** Text is stored as plain text and rendered as React text, never HTML. No links are made.
- **Audit.** `CHAT_STARTED` carries the conversation id (and the support request id if linked). `CHAT_ENDED` carries
  the id, the reason, message counts each way and the duration. **Message text is never audited**, and neither are
  names or the signed-in account. The prune deletes transcripts, never an `ActivityLog` row, so the sealed chain is
  untouched. The e2e suite runs with sealed rows and checks every audit row written during it for message text.
- New invariant section **§45** (11 checks):
  - route capabilities;
  - visibility AND-ed scoping on every technician method;
  - `assertOpen('remote')` in start and send;
  - device routes through `authenticateDevice` / `secretMatches`, and the heartbeat gate authenticated and signed;
  - audit meta with no text, and no `activityLog` update or delete;
  - the 2,000 cap agreeing in TS, SQL and Go;
  - the 400-day default, with the sweep off in `run-e2e.sh`;
  - the window file with no `net/http`, secret, `os/exec` or rich text, and a read-only transcript;
  - pipe flags, DACL and the PID check, with one `exec` (rustdesk `--get-id`);
  - no `dangerouslySetInnerHTML` or anchors in the chat tab;
  - only the signed script starting the host, and the pause label.

  Each check was shown to fail when its guard was removed (22 mutations, each failing exactly that check) and then
  restored.

#### Upgrade notes
- Apply migration `0056_chat` (`prisma migrate deploy`). Then regenerate the Prisma client at the target, as for any
  schema change.
- **Nothing changes for computers on the standard agent.** Their Chat tab says chat needs the signed agent. Signed
  agents gain chat with the 0.34 agent release. Until a computer's heartbeat reports `agentChat`, it shows "too old".
- Grant `support:chat` to whoever should chat. It is in no preset.
- The chat sweep is separate from any other retention sweep. Set `CHAT_RETENTION_SWEEP=off` on scratch APIs whose
  transcripts must survive. `scripts/run-e2e.sh` now exports it and passes it to its scratch API, and `e2e-chat`
  turns it on for its own API.
- Chat's held polls live in the API process, which is another reason it must stay a single process.
- **The desktop window has not run on real Windows.** `CreateProcessAsUser` into the session, the pipe DACL, session
  selection with Fast User Switching or RDP, and the Win32 window are built, vetted and statically checked but
  unproven. Test it on a lab machine before relying on it.

#### Verification
- `apps/api/scripts/e2e-chat.mjs` (port 3531, its own API from `dist`; refuses a database without `test`/`scratch`)
  **89 passed, 0 failed**. The device is simulated over the real device routes. The suite covers:
  - unsupported computers (Linux, macOS, standard and old agents) refused with their reasons;
  - start, dedupe and audit;
  - the heartbeat flag only for an authenticated, signed agent that can chat;
  - wrong-secret polls 401 and audited;
  - receipts only from the agent, only for that computer's messages, in order;
  - the long-poll woken by a send, and the held-poll cap returning `retryAfterMs`;
  - the opening, nobody-signed-in and window-open states (window-failed is covered by `unit-chat` only);
  - closing the window ending the chat;
  - reply dedupe by client id;
  - A/B isolation, including a Business User without the computer getting 404 and a conversation id from business B
    refused on A's computer;
  - `remote` containment on start and send, with reading and ending still allowed;
  - length, control-character and rate caps per side and per computer;
  - support-request linking and its scope;
  - inactivity ending and retention pruning with a sealed audit chain intact;
  - no message text in any `ActivityLog` row.
- `apps/api/scripts/unit-chat.mjs` **52 passed** (added to CI).
- `go test ./...` passes in `tools/windows-installer`, including 21 tests in `internal/chat`, also under `-race`. The
  host is tested against a fake portal and a fake desktop:
  - frame limits and field sets, and the hello nonce;
  - receipts sent once;
  - history retried without closing the window;
  - a lost window reopened;
  - technician end and user close;
  - reply retries and the per-minute cap.

  `GOOS=windows go vet ./...` and `go build` pass.
- `scripts/check-security-invariants.mjs` passes, with §45's 11 checks proven by mutation. `check-versions.mjs`
  passes.
- `pnpm -r lint` and `tsc --noEmit` pass in both apps, as do `nest build` and `next build`.
- Existing suites touching changed code also pass: `unit-signed-installer` (51, run under pwsh 7.4),
  `e2e-system-inventory` (68), `e2e-endpoint-visibility` (112) and `e2e-linux-agent` (86).
- `docs/API-REFERENCE.md` was regenerated and matches the runtime route table (431 routes).
- `e2e-navigation.mjs` gains a Chat-tab check (present before History; on a computer that cannot chat it says why
  and offers no Start). **It was not run here**, because it needs the docs stack's `reboot_remote_docs` database;
  it was syntax-checked only.

### Integration notes

The parts were merged into one branch in this order: retention, groups and keys (which carries the API-key work),
presence, restart rule, signed results, script run, software, AI summary, email, agent upgrade, phone layout,
screenshots, and chat. Each branch numbered its invariant section §33. Here they are §33–§45 in that order:

| § | Part |
|---|---|
| 33 | Data retention |
| 34 | API keys and device-group membership |
| 35 | Rule-based device groups |
| 36 | hbbs peer snapshot |
| 37 | Restarts after Windows updates |
| 38 | Agent-signed action results |
| 39 | `windows.script.run@1` |
| 40 | Software deployment |
| 41 | AI without a provider key |
| 42 | Outbound email |
| 43 | Agent upgrade from the console |
| 44 | The browser UI suite |
| 45 | Chat |

The sections above keep each branch's own text, renumbered. Their check counts are each branch's own; the integrated
counts are under *Verification*. These changes were made where the branches met:

- **The action catalog is nine actions, in one fixed order on both sides.** The six through 0.32 come first, then
  `windows.script.run@1`, `windows.software.install@1` and `windows.software.uninstall@1`.
  - Updated to match: `catalog.ts`, `catalog.go`, the Go catalog tests, §14's exact list (with both
    `scriptParamsOK` and `softwareParamsOK` closed forms, and seven `integration: false`), `unit-script-run.mjs`,
    `unit-software.mjs` and `e2e-maintenance-actions.mjs`.
  - The software branch had relaxed `e2e-maintenance-actions.mjs` to a six-action prefix. It asserts the exact nine
    again.
- **`ACTION_NOT_DIRECT`:** each indirect action names its own workflow. The software branch's per-entry
  `indirectVia` is used, and `windows.script.run` carries the script library's message in its own `indirectVia`.
- **One result-status table.** Signed results made `RESULT_STATUS` the table that both the portal and the signer use.
  Script runs added the outcome `timed_out`. It is now in that table (→ FAILED) and in the signed `ResultStatement`
  enum, so a timed-out run's signed result still parses.
- **The approval signer carries both device-key pins and the script allowlist.** That means two state directories,
  both sets of store methods, both CLI commands, and a build allowlist admitting `actions/device-result` and
  `actions/script-run`.
  - The script branch's check forbade any deletion in the signer's store. Signed results needs one: the
    operator-only `device-key forget`, which §38 requires.
  - §39 now requires every `unlinkSync` there to target `device-keys/`. Deleting a script entry or revocation still
    fails the check; a mutation proved it.
  - The plan page shows a script block first, then the restart wording for update plans, then the software rows.
- **Bulk actions:**
  - The bulk endpoint takes both `targetGroupId` (rule groups) and the migration `reason` (agent upgrade), and keeps
    every refusal from both.
  - The bulk bar's *Update agent* / *Upgrade to signed* work on a rule-group target as well as a selection.
  - §29's bulk list is the six actions.
- **Scheduled reports cover the four 0.32 reports, not Software compliance.** Merging the software report made the
  schedule service's capability map incomplete, and the build failed.
  - Schedules now accept `SCHEDULABLE_REPORTS` explicitly. That is what migration 0054's CHECK admits.
  - The software report takes no period or site query, so scheduling it is its own change.
- **Every sweep that acts on the whole database is off in the e2e runs.**
  - `scripts/run-e2e.sh` exports `RETENTION_SWEEP`, `REPORT_SCHEDULE_SWEEP`, `CHAT_RETENTION_SWEEP` and
    `SCRIPT_OUTPUT_SWEEP` as `off`, and passes all of them to its scratch APIs.
  - `MONITOR_SWEEP` and `CLIENT_UPDATE_SWEEP` are deliberately **not** exported off. An earlier integration build did
    export them, and `e2e-monitoring` (63 passed, 13 failed) and `e2e-ticket-workflow` (crashed waiting for a
    monitor state row) broke. Both start their own API and rely on the monitoring sweep's default (on, every
    `MONITOR_SWEEP_SECONDS`). Every other suite that starts an API already turns those two off itself, and the
    scratch-API loop passes them off explicitly.
  - `e2e-ui.mjs` (written before email, script runs and chat landed) now also turns off `RETENTION_SWEEP`,
    `REPORT_SCHEDULE_SWEEP`, `SCRIPT_OUTPUT_SWEEP` and `CHAT_RETENTION_SWEEP`, and §44 requires them.
  - The suites that test a sweep still turn it on for their own API.
- **Tests that pinned a sibling's absence:**
  - `e2e-script-run.mjs` asserted the catalog was exactly seven actions, and `e2e-software-deploy.mjs` that it was
    exactly eight with software last. Both now assert the exact nine, in order. Their "older agent" fixtures are
    still the original six.
  - `e2e-patch-policies.mjs` expected a standard-agent computer's Patches tab to say "switch to the signed channel".
    The agent-upgrade part changed that remedy to the Agent card's *Upgrade to signed agent*. Its fixture had no
    platform, so it got `NOT_WINDOWS` instead, which no real standard Windows computer reports. The fixture now
    reports `Windows 11 Pro`. The check now requires `fixAction: 'agent-card'` and the *Upgrade to signed agent*
    wording, which is stricter than the old regex.
  - `e2e-ui.mjs` (the phone-layout part, written against 0.33) expected the API-key step-up to say it was for a key
    that can "enrol computers". From 0.34 (§34) every key needs a fresh sign-in, and the dialog says "To create an
    API key, confirm your identity". The first integrated browser run failed exactly that check in all four
    viewport/theme passes (416 passed, 4 failed). The check now expects the 0.34 wording.
- **The docs demo seeder (`prisma/_docs-demo-workbench.ts`) wrote `Endpoint.endpointGroupId`.** Migration 0049
  drops that column, and `tsc` failed on it. It now clears and creates `EndpointGroupMember` rows. The screenshots
  part was written against 0.33's schema.
- **Chat met email in containment.** The `remote` pause label is "remote connections and chat" (§45), and email's
  new `notifications` kind is kept beside it. Chat's `agentChat` heartbeat field and `chatProtocol` column sit
  beside agent upgrade's `agentUpdateCheckedAt` / `agentUpdateResult`, and both services are injected into
  enrolment.
- **Docs written against a sibling's absence:**
  - Staged patching's limitations no longer say a policy can't restart computers.
  - The signer's policy page and the gap analysis no longer say results are unsigned.
  - The script-library screenshot's callout says it was captured on 0.33, when the "not available yet" notice was
    shown.
  - The phone-width gallery caption says the images predate the phone layout. They show the 0.33 sidebar, which no
    longer appears at that width.
- **Migration numbers.** 0046, 0047 and 0049–0056 are used. 0048 was not taken by any branch and stays unused, as
  0039, 0043 and 0044 did in 0.33.
- `feat/0.34-retention`, `-presence`, `-reboot` and `-signedresults` were based on the pre-squash `feat/v0.33.0`
  history. Their tip is tree-identical to main's 0.33.0, and it was used as the merge base, so the 0.33 history
  produced no conflicts.

### Verification (integrated)

Run on the integrated branch with all thirteen parts merged, against the scratch database
`rem0te_integrate34_test` (recreated empty, all migrations applied by `run-e2e.sh`):

- **Static:**
  - `scripts/check-security-invariants.mjs`: **366 checks hold**, including §33–§45.
  - `check-versions.mjs` passes, and so does `gen-integration-contracts --check`.
  - `pnpm -r lint` and `pnpm typecheck` (api and web) exit 0.
  - `prisma generate`, `nest build` and `next build` succeed.
- **Prisma:** all 50 migrations, 0000–0056, apply to an empty database (0048 is unused). `prisma migrate diff` from the
  migrations to the schema reports *No difference detected*, and so does a diff from the migrated database.
- **Production manifest:**
  - `pnpm deploy:manifest` gives 0.34.0 with 30 dependencies: `nodemailer` 10.2.1, no `@anthropic-ai/sdk`, no
    devDependencies.
  - `npm install --omit=dev --package-lock-only` exits 0 with 0 vulnerabilities.
- **Routes:** `docs/API-REFERENCE.md` has 472 routes, regenerated. `--check` against a scratch API's
  RouterExplorer log matches exactly (472 / 472). The docs bundle is 38 pages.
- **Go agent (`tools/windows-installer`):** `go test -count=1 ./...` with `PWSH` (PowerShell 7.4.6) runs 237 tests
  and subtests: all pass, none skipped. `go vet` passes on Linux and with `GOOS=windows`. The Windows agent build
  and the `rem0te-release` and `rem0te-action-sim` builds succeed.
- **Unit scripts, every one in `ci.yml`, all exit 0:**

  | Script | Passed |
  |---|---|
  | `agent-migration` | 57 |
  | `ai-timeline` | 24 |
  | `approval-signer` | 184 |
  | `audit-chain` | 35 |
  | `chat` | 52 |
  | `device-views` | 77 |
  | `diagnostics-catalog` | 110 |
  | `dynamic-groups` | 68 |
  | `email` | 122 |
  | `hbbs-peer-snapshot` | 29 |
  | `integration` | 35 |
  | `macos-agent` | 27 |
  | `metric-history` | all |
  | `monitoring` | 100 |
  | `patch-policy` | 163 |
  | `patch-summary` | 27 |
  | `presets` | 26 |
  | `retention` | 47 |
  | `script-library` | 125 |
  | `script-run` | 136 |
  | `search` | 37 |
  | `session-mutations` | 30 |
  | `signed-installer` | 52 |
  | `software` | 146 |
  | `system-inventory` | 92 |
  | `update-signing` | 16 |
  | `update-window` | 85 |

  `build-approval-signer --list` also exits 0.
- **`scripts/run-e2e.sh`:** run in full, with `RELEASE_BIN` / `ACTION_SIM` built from this tree and `PWSH` set.
  **All 49 suites passed and none were skipped.** Passed counts:

  | Suite | Passed |
  |---|---|
  | credentials | 44 |
  | security-features | 42 |
  | presets | 114 |
  | monitoring | 108 |
  | integration | 77 |
  | dashboard | 53 |
  | diagnostics-catalog | 70 |
  | system-inventory | 68 |
  | device-list | 113 |
  | endpoint-visibility | 114 |
  | device-views | 142 |
  | dynamic-groups | 98 |
  | add-device | 62 |
  | auto-updates | 73 |
  | reports | 104 |
  | script-library | 138 |
  | linux-agent | 86 |
  | macos-agent | 106 |
  | enrol-stepup | 67 |
  | search | 113 |
  | metric-history | 59 |
  | retention | 43 |
  | ai-timeline | 61 |
  | email | 92 |
  | chat | 89 |
  | containment | 70 |
  | approved-action | 76 |
  | staged-patching | 94 |
  | maintenance-actions | 64 |
  | patch-policies | 98 |
  | software-deploy | 156 |
  | signed-updates | 46 |
  | ticket-workflow | 53 |
  | script-run | 81 |
  | business-access | 83 |
  | offboarding | 63 |
  | public-address | 43 |
  | rollouts | 46 |
  | security-audit | 57 |
  | session-mutations | 43 |
  | support-requests | 47 |
  | sso-passkeys | 70 |

  These report a pass without a count: presence-cache, agent-upgrade, smoke, full, public-api, candidate-password
  and secreg.

  The first integrated run failed five suites, all fixed above:
  - monitoring and ticket-workflow, from the over-broad sweep export;
  - script-run and software-deploy, whose catalog counts predated the nine actions;
  - patch-policies, which expected the pre-0.34 remedy.
- **`apps/web/scripts/e2e-ui.mjs`**, run as CI runs it (after `run-e2e.sh`, with its own API on 3502, a patched copy
  of this tree's `next build` on 3501, and `OUT_DIR` set): **420 passed, 0 failed**. That includes the
  search-palette suite (24).
- **Not run:** anything on real Windows; `e2e-navigation.mjs` and the capture scripts, which need the docs stack's
  `reboot_remote_docs` database.

### Upgrade notes (all of 0.34)

- **Schema change: ten migrations.** Take a `pg_dump` first. Then run `prisma migrate deploy`, rsync
  `apps/api/prisma/` to the target and run `prisma generate` there, as `CLAUDE.md` describes. Without the last two
  steps the API throws `Unknown field groupMemberships` or an invalid enum value at runtime. The migrations:

  | Migration | Adds |
  |---|---|
  | `0046_data_retention` | Retention indexes and `RETENTION_PRUNED` |
  | `0047_patch_reboot` | `PatchDeployment.reboot` |
  | `0049_device_group_members` | Copies memberships into the join table, drops `Endpoint.endpointGroupId`; its `NOTICE` says how many were dropped |
  | `0050_script_run` | Script runs |
  | `0051_software_catalog` | The software catalog |
  | `0052_ai_timeline` | AI summary audit actions |
  | `0053_dynamic_device_groups` | Rule-based groups |
  | `0054_outbound_email` | Outbound email |
  | `0055_agent_migration` | Agent migration |
  | `0056_chat` | Chat conversations and messages, `Endpoint.chatProtocol` |

  0048 is unused.
- **A production dependency changed both ways.** `nodemailer` 10.2.1 is added and `@anthropic-ai/sdk` is removed.
  Rsyncing `dist` alone works until the next restart, then the API fails with `Cannot find module 'nodemailer'`.
  Regenerate the target manifest and reinstall, checking npm's exit code before rsyncing anything:
  ```bash
  pnpm deploy:manifest -o /tmp/prod-package.json
  cd /tmp && npm install --omit=dev --package-lock-only     # must exit 0
  sudo cp /tmp/prod-package.json /opt/reboot-remote/api/package.json
  cd /opt/reboot-remote/api && sudo npm install --omit=dev
  ```
  Remove `ANTHROPIC_API_KEY` from `/etc/reboot-remote/api.env` if it is there. It is ignored.
- **Patch policies need approving again.**
  - Policies approved under 0.32/0.33 can still run their canary but no later ring (`result_key_not_pinned`).
  - Approve them again once every computer in every ring but the last runs the 0.34 agent and has scanned once.
  - Before then, creating a policy is refused with `409 RESULT_KEY_MISSING`.
  - On the signer's approval page, compare each key fingerprint with `rem0te-agent.exe status` on the computer.
- **The signed agent must be rebuilt and published through the release chain** for the restart rule, signed results,
  script runs, software actions and chat:
  - An older agent refuses a restart-rule plan whole (`params_not_allowed`), so nothing is installed or restarted.
  - An older agent signs nothing, so its results can't open a policy ring.
  - An older agent doesn't report `windows.script.run@1` or the software actions, so those are never offered to it.
  - An older agent doesn't report `agentChat`, so its Chat tab says it is too old. Computers on the standard agent
    (production today) cannot chat at all.
  - The signed channel's `install.ps1` must also be re-signed for signed agents to report their last update check.
    `windows-script.ts` changed.
- **The approval signer must be rebuilt and reinstalled** (`apps/api/scripts/build-approval-signer.mjs`). It now
  bundles `actions/device-result.js` and `actions/script-run.js`, still with no Nest or Prisma. It creates
  `device-keys/`, `scripts/` and `script-revocations/` in its state directory itself.
- **Grant `support:chat`** to whoever should chat with the person at a computer. It is in no preset.
- **Creating any API key now needs a fresh sign-in.** Scripts that create keys from a session must call
  `POST /auth/step-up` first.
- **API consumers:**
  - Device-list rows have `groups` (an array) instead of `group`.
  - `GET /endpoints/:id` has `groups` instead of `endpointGroup`.
  - The CSV column is *Groups*.
- **Retention starts two minutes after the API does.**
  - Its first passes clear the backlog at up to 20,000 rows per table per hour.
  - Set `RETENTION_SWEEP=off` to postpone it, or raise `RETENTION_BATCHES` to go faster.
  - `VACUUM (FULL, ANALYZE)` in a maintenance window gives the space back.
- **Mail is off until a Platform Admin configures a relay.**
  - A relay on the same host needs `SMTP_ALLOW_LOCAL_RELAY=loopback`; one on the LAN needs `=private`.
  - An existing "every kind" containment pause does not gain the new `notifications` kind.
- **The AI summary stays unavailable** until ClientSt0r acknowledges and serves P11/P12
  (`INTEGRATION_COORDINATION.md` §5A). It is not available against the real ClientSt0r today.
- **New optional settings:**
  - `HBBS_PEER_CACHE_SECONDS` (10, clamped to 1–30).
  - `RETENTION_*` (see *Data retention*).
  - `REPORT_SCHEDULE_SWEEP` / `_SECONDS`, `SCRIPT_OUTPUT_SWEEP` and `SMTP_ALLOW_LOCAL_RELAY`.
  - `CHAT_RETENTION_SWEEP`, `CHAT_RETENTION_DAYS`, `CHAT_SWEEP_SECONDS`, `CHAT_PRUNE_BATCH(ES)` and
    `CHAT_MAX_WAITERS` (see *Chat*).
  - `WINGET_MANIFEST_BASE` is for the e2e fixture only and is ignored unless it is a loopback http URL.
- **Expect "not confirmed" for an agent migration** dispatched over two hours ago whose computer still reports the
  standard agent. The standard heartbeat does not report the migration script's exit code.

---

## [0.33.0] — 2026-11-11 · *Lookout*

The third increment of the RMM overhaul: finding things and seeing what a computer is doing. Six parts, each built
and tested on its own from the 0.32 integration and then integrated on top of the 0.32.0 release: enrolment
step-up and server sizing, global search, device groups / saved views / bulk actions, metric history, Processes /
Services / Network snapshots, and a read-only macOS agent. Nothing here acts on a computer that could not be acted
on before; the snapshots and the macOS agent have been run against stubs and recorded output, not on real Windows
or a real Mac.

### Fixed
- **A `%`, `_` or `\` in a list search was a LIKE wildcard, not a character.** Prisma's `contains` becomes
  `ILIKE '%' || value || '%'` with the value spliced in as is, so `GET /endpoints?search=%`, the device list's
  `GET /endpoints/list?search=_` and `GET /businesses?search=%` matched every row in the caller's scope, `ACME_PC`
  also found `ACME-PC`, and a `DOMAIN\user` backslash escaped the next character instead of matching it. Not a
  scope leak — the scope is AND-ed on — but wrong results. Global search (below) found and fixed this for itself;
  the three list routes now escape with the same helper, `apps/api/src/common/like.ts` (`likeEscape`, re-exported by
  `search/query.ts`). `BusinessesService.listWhere` takes an escaped term, so global search and `GET /businesses`
  cannot escape twice or not at all. `e2e-search.mjs` gains a section proving `%`, `_`, `TAG_EXACT` and `TAG%EXACT`
  match nothing on all three routes while the literal text does, and that a backslash still finds a `DOMAIN\user`;
  §28 gains a check that each route goes through the helper.

### Enrolment step-up and server sizing

#### Security

- **Making an enrolment token needs a fresh re-authentication** (closes the limitation listed since 0.23: "a stolen
  admin session can still create enrolment tokens"). Before this, `POST /enrollment/tokens` accepted any valid
  session with *Add computers*. A token lets whatever machine runs it join a business, where it gets that business's
  monitoring, update policies and relay configuration, so a stolen or unattended session was enough to plant a
  machine. Now the route answers `403 STEP_UP_REQUIRED` (`action: "enrollment.create"`) until the person confirms it
  is them (password, authenticator code or passkey; 10 minutes, this sign-in only). This includes re-enrol tokens
  for an existing computer.
  - **Every role, not only Platform Admins.** A token always covers exactly one business and does the same thing
    whoever made it, so a stolen Business Owner session is as useful as a Platform Admin one for that business.
  - **Not configurable.** It uses `assertFresh`, like lifting a containment pause, not the switchable
    `PlatformSettings.stepUpActions`. The e2e suite empties that list and the mint is still refused.
  - **Scope comes first.** Naming another business, or one that does not exist, is refused as before (403/404),
    never answered with a prompt to re-authenticate.
  - `EnrollmentService.createClaimToken` now takes a required third argument saying how the mint proved more than a
    session (`{ via: 'session', freshMethod }` or `{ via: 'api-key', apiKeyId }`), so a new route cannot mint on a
    bare session by forgetting. The `CLAIM_TOKEN_CREATED` audit entry records `mintedVia` and the step-up method or
    the API key's id.
- **API keys keep minting tokens; creating such a key needs the re-authentication.** A key cannot step up (there is
  no person at the other end), and provisioning scripts are what `POST /pub/v1/enrollment/tokens` is for. The key is
  itself the second proof: a separate secret bound to one business with an explicit scope. To stop a stolen session
  from minting a key and then minting tokens with it, `POST /apikeys` with `enrollment:write` among its scopes now
  answers `403 STEP_UP_REQUIRED` (`apikey.enrollment`) without a fresh confirmation. Keys without that scope are
  unchanged.
- **Registering a computer by RustDesk ID stays ungated.** It mints nothing (no token, device secret or password;
  Platform Admin only, unchanged), and the e2e suite checks that the node it creates carries no secret.
- **Console.** *Add device* handles the refusal without losing anything: the api-client interceptor opens the
  step-up dialog and retries the same request, so the business, site, access choice and OS are all still in the
  retried body. If the person cancels, nothing is made and the page says so; the button works again. The dialog
  names both new actions, and the API keys page says that the `enrollment:write` scope asks for confirmation.

#### Added

- **Server sizing guide** (`docs/server-sizing.md`, in the in-app docs; linked from Setup and `/help`): CPU, memory,
  disk and PostgreSQL for 50, 250, 1,000 and 5,000 computers, heartbeat rates (every 3 minutes), hbbs/hbbr bandwidth,
  and database growth per table. Every figure is marked **measured** or **estimated**. The measured ones come from a
  new load script, `apps/api/scripts/bench-heartbeat.mjs` (bounded, scratch database only, starts its own API), and
  from synthetic rows inserted and rolled back in a scratch database. On a shared 16-core host a steady-state
  heartbeat cost ≈ 70 ms of API CPU and ≈ 9 ms of PostgreSQL CPU, made ≈ 24 transactions and 4 row updates and
  inserted nothing, and one API process handled 18–41 heartbeats a second.
  - **Finding:** 5,000 computers need 27.8 heartbeats a second, which is at the edge of what one API process
    measured. Most of the cost is that every heartbeat runs a `sqlite3` child process for the hbbs presence lookup
    (`peerRegisteredWithHbbs`). A patched build that skipped it (an experiment only, not shipped) dropped API CPU to
    ≈ 42 ms and roughly doubled throughput. Batching or caching that lookup is the obvious next step before
    promising 5,000. Running two API processes is not supported, because the sweeps and the audit sealer run inside
    the process.
  - **Finding:** nothing that grows is pruned: commands, inventory changes, sessions, alerts and diagnostics
    accumulate, and the sealed audit log cannot be pruned. The guide estimates ≈ 1.3 MB per computer per year.

#### Upgrade notes

- No migration and no configuration change.
- Anyone who makes install links is now asked to confirm it is them once per 10 minutes. Scripts that call
  `POST /enrollment/tokens` with a session cookie must `POST /auth/step-up` first and send the `step_up` cookie (or
  the `x-rem0te-step-up` header). Scripts using an API key are unaffected.
- Existing API keys with `enrollment:write` keep working. If a session may have been stolen, review them under
  *Settings → API keys*: keys created before this release did not need the confirmation.

#### Verification

- New `apps/api/scripts/e2e-enrol-stepup.mjs` (self-starting, port 3332, in `scripts/run-e2e.sh`): **44 passed** —
  stale refused and fresh minted for Platform Admin, Business Owner A, Business Owner B and a Business User with
  *Add computers*, with no row written on refusal; re-enrol tokens; scope before freshness; another user's step-up,
  an earlier sign-in's step-up, a wrongly signed, an expired and a malformed step-up all refused; still refused with
  every configurable step-up action switched off; `enrollment:write` keys refused stale (including among other
  scopes) and created fresh, other keys unchanged; a key mints in its own business only, audited with its id; a
  session cannot use the public route; register by RustDesk ID mints no credential; business A/B isolation of the
  minted tokens.
- `e2e-add-device.mjs`: **62 passed** (was 58; now opens with a stale-session refusal, a scope refusal ahead of the
  prompt and "no row written", then steps every session up).
- Adjusted for the step-up and re-run: `e2e-credentials` 44, `e2e-presets` 114 (its stolen-session drill now asserts
  that enrolment is refused — it used to record a 201), `e2e-linux-agent` 84, `e2e-business-access` 83,
  `e2e-security-audit` 56 (new section: owner and Platform Admin sessions without step-up cannot mint a token or an
  `enrollment:write` key, and nothing is written), `e2e-smoke`, `e2e-full` (now asserts the stale refusal first),
  `e2e-public-api` (asserts the stale key refusal), `e2e-candidate-password`: all pass.
- `scripts/check-security-invariants.mjs` §27 (7 checks): `assertFresh` cannot be skipped; `createClaimToken`
  demands a mint proof and checks it after scope and before the write; only it writes a `DeviceClaimToken` and only
  the two known routes call it; the console route passes the step-up it read and the public route sits behind
  `ApiKeyAuthGuard` and passes the key id; `enrollment:write` keys need fresh auth; register-by-ID mints no
  credential; the suite is in `run-e2e.sh`. Each check was shown to fail with its guard removed (10 mutations,
  10 caught), then restored.
- `check-versions`, `pnpm -r lint`, `tsc --noEmit` (api, web), `nest build`, `next build` pass.
  `docs/API-REFERENCE.md` regenerated (it had not been since 0.32: 392 → 405 routes; no route was added here).

### Global search

#### Added

- **Global search** (`GET /search?q=`, and a command palette in a new top bar: the *Search* button or **Ctrl+K** /
  **⌘K** anywhere). One query, five groups, at most **8** results each with a `more` flag:
  - **devices** by name, hostname, RustDesk ID, serial number, signed-in user, IP address, a network adapter's IPv4
    and alias. Each result says which field matched and its value (*Serial: …*, *Adapter IP: …*), and only that
    field is returned. Every one of those values is already on the device page for anyone who can open it, which
    is the only kind of device search can return. Archived devices are excluded, as in the device list;
  - **businesses** by name, code, email or city; **sites** by name, city or address (a site opens the device list
    filtered to it); **people** by first name, last name or email, word by word ("jane doe"); **open and
    acknowledged alerts** by title.

  Exact matches rank first, then prefix, then anywhere; ties go online-first, then by name. The palette debounces
  typing (200 ms), is keyboard-driven (↑/↓, Enter, Esc; Ctrl/⌘-click opens a new tab), marks the matched text, and
  works in the light and dark themes and full-screen at phone width. Docs: `docs/technician-guide.md` §2 *Search
  everything*, `docs/access-control.md`, and *Searching Everything (Ctrl+K)* on `/help`.
- **No group is scoped by new code.** Each one starts from the where builder its own list route uses, now shared
  rather than copied: the device list's `EndpointListService.scopedWhere` (visibility AND-ed, not archived),
  `BusinessesService.listWhere` (GET /businesses), `SitesService.listWhere` (GET /sites), `UsersService.memberWhere`
  (GET /users) and `MonitoringAdminService.alertWhere` (GET /monitoring/alerts). The match is always AND-ed onto
  that fragment. Each group is gated by its list page's capability (`GROUP_CAPABILITY`: computers and sites
  `computers:view`, people `users:view`, alerts `monitoring:alerts`, businesses none, like GET /businesses), and a
  group the caller may not use is `null` — left out of the palette, never drawn as "no results".

#### Removed

- **`GET /admin/search`** (already removed in production by 0.31.2, found by this work). It scoped computers by business alone (`customerId`), so a Business User found
  ASSIGNED_USERS computers granted only to other people — name, hostname, IP address and RustDesk ID — and a
  technician restricted to named computers found every computer in the business. Measured before removal against
  the new suite's fixtures: the Business User saw the ungranted computer, and a technician assigned to one computer
  got 19. The web app no longer called it (`adminApi.search` was defined and unused); `e2e-business-access.mjs`
  now checks the same two properties through `GET /search`. §28 of the invariants keeps it the only search route.

#### Security

- Searches are **not audited** (a keystroke is not an event) and the API never logs the query text: the 5xx log
  line for `/search` records the path without its query string (`GlobalExceptionFilter`). Results are
  `Cache-Control: no-store`. A reverse proxy's access log still records request addresses, search included — said
  in the guide.
- **Throttled**: 120 requests a minute per client address (`@RateLimit(SEARCH_RATE_LIMIT)`), on top of the 20/s
  burst throttler. The palette says *Too many searches* on a 429.
- `q` is 2–100 characters after control and invisible formatting characters (zero-width, bidi overrides) are
  removed and whitespace collapsed; given twice it is a 400.
- **LIKE metacharacters are literal.** Prisma's `contains` splices the value into `ILIKE '%…%'` unescaped, so `%`
  matched everything and a `DOMAIN\user` backslash broke matching — the suite caught both before release. Search
  escapes every value (`likeEscape`). The device list's search, `GET /endpoints?search=` and
  `GET /businesses?search=` had the same fault; they are fixed in this release (see *Fixed* at the top).
- No result carries a secret, hash, token, password flag or capability list: selects are explicit, and §28 fails
  the build if `SearchService` names any of them.

#### Performance (measured; no index, no migration)

End to end through the API, Platform Admin (every device in scope), median of 5, on the shared scratch Postgres 16:

| Devices | `/search` (typical query) | device list's own search | `/search?q=pc` (matches all) |
|---|---|---|---|
| 2,000 | 52–72 ms | 56 ms | 280 ms |
| 20,000 | 316–450 ms | 319 ms | 990 ms |

Computers run in two phases, like the device list: Prisma finds the scoped ids that match (one query, the scope
AND the match); one SQL statement over exactly those ids (`unnest(ids)`) ranks them with cheap per-field
expressions, keeps nine, and only for those works out which field matched. Adapter IPv4s live in a JSON array
Prisma cannot search, so for an address-shaped query only, the matching inventory rows are found first and their
ids join the match condition (inside the AND, so they can only narrow). The first version ranked every scoped
device with a lateral subquery and took ~1 s at 20,000 for any query; the second phase was the cost.

A `pg_trgm` index was measured and **not** added: seven GIN indexes (Endpoint name, hostname, serial, IP;
RustdeskNode ID; inventory serial and signed-in user) took the phase-one query from 233 ms to 94 ms at 20,000, but
Endpoint itself still seq-scans because Prisma's OR over relations defeats a BitmapOr, the inventory indexes are
rewritten by every three-minute heartbeat, and the migration would need `CREATE EXTENSION` on every install. At
the fleet sizes rem0te runs, the scan is the device list's own cost.

#### Upgrade notes

- No migration, no new setting. The top bar appears on every signed-in page.
- Anything calling `GET /admin/search` gets a 404; use `GET /search?q=` (response shape:
  `{ query, cap, groups: { computers, businesses, sites, users, alerts } }`, each `{ items, more }` or `null`).

#### Known

- The palette's browser test (`apps/web/scripts/e2e-search-palette.mjs`) needs a web build pointed at a scratch API
  and is not in CI; it was run on a scratch stack (24/24). `e2e-navigation.mjs` (docs stack only) was not run.
- Search covers what the five list routes cover; notes, software lists, event logs and session history are not
  searched.

#### Verification

- `apps/api/scripts/e2e-search.mjs` — **98/98** against a scratch database on port 3281: every device field with
  the field reported, exact > prefix > contains, the cap and `more` on every group, LIKE metacharacters literal,
  archived devices and inactive sites excluded; isolation for six personas (owner, Business User, one-computer
  technician, whole-business technician, user with alerts, users-only) across 19 probes each — B's shared words,
  exact hostname, exact RustDesk ID, serial, IP, adapter IP, alias, site, people, alert and business — all empty,
  with the Platform Admin finding every one (negative control); a Business User sees only assigned and
  company-wide devices, also by an ungranted computer's exact hostname; capability gating per group, each matched
  by a 403 from that group's list route; no audit row and no query text in the API output; no secret in any of
  the responses; 120 answered then 429, another address still answered; `/admin/search` 404. Removing the scope
  from the search service (`scopedWhere`, `memberWhere`, `sites.listWhere` replaced with `{}`) fails 15 checks.
- `apps/api/scripts/unit-search.mjs` — **37/37** (parsing, escaping, ranking, address heuristic, gates); in CI.
- `apps/web/scripts/e2e-search-palette.mjs` — **24/24**: Ctrl+K and the button, focus, the hint, grouped results,
  arrow keys and Enter, serial match label, site and person, another business not found, Esc, light and dark
  surfaces, phone width (fits 390 × 844, no sideways scroll, tap opens), a Business User without People/Alerts
  groups.
- `node scripts/check-security-invariants.mjs` — §28 (8 checks), each proven to fail with its guard removed
  (12 mutations); §18 now also covers the palette script. `check-versions.mjs` passes.
- Existing suites re-run: `e2e-device-list.mjs` 113/113, `e2e-business-access.mjs` 83/83, `e2e-smoke.mjs` and
  `e2e-full.mjs` pass. `pnpm -r lint`, `tsc --noEmit` (api, web), `nest build`, `next build` clean.
  `docs/API-REFERENCE.md` regenerated (405 routes) and matched against the runtime route table.

### Device groups, saved views and bulk actions

#### Added

- **Saved device views on the account** (`/device-views`). A view is a name plus the device list's own parameters —
  filters (validated by the list's parser, `parseListQuery`, now in `endpoints/list-query.ts`; unknown keys and bad
  values are a 400, never dropped), sort, columns and density. It never stores devices, and there is no route that
  runs one: the browser opens a view by calling `GET /endpoints/list` with its parameters, as the viewer. A view is
  **personal** (only its author lists, opens, changes or deletes it; another user's is a 404) or **shared** within
  one business. Sharing, changing or deleting a shared view needs a Business Owner, a technician whose assignment
  grants `computers:edit` over the whole business, or the MSP — never a Business User, whatever they hold — and is
  audited (`DEVICE_VIEW_SHARED_CHANGED`, with before and after). A shared view's filters cannot name another
  business, or another business's site or group; another business's shared view is a 404. Opening a shared view
  applies the viewer's own visibility: a Business User opening the owner's unfiltered view gets exactly their own
  devices, and a shared alerts filter is still refused to someone without `monitoring:alerts`. Views saved in a
  browser by 0.31/0.32 (`localStorage`) are offered for a one-time import as personal views.
- **Device groups** (`/device-groups`, Views → Device groups…). The existing `EndpointGroup` — until now
  tenant-wide, settable only through an enrolment token, and with no API or UI — now belongs to one business
  (`customerId`), with names unique per business. It is a list filter (`groupId`), a facet with counts over what
  the viewer can see, an optional *Group* column and a CSV column. A computer is in at most one group (the existing
  `Endpoint.endpointGroupId`, which enrolment tokens already set). Creating, renaming and deleting groups, and
  changing members, need the same rule as sharing a view. Every change is audited (`DEVICE_GROUP_CREATED`,
  `_UPDATED`, `_DELETED` with members released, `_MEMBERS_CHANGED` with the computers). Groups grant nothing.
- **Bulk actions on selected devices** (`POST /endpoints/bulk`, `POST /endpoints/bulk/export.csv`). Tick rows (the
  selection survives paging and filtering) and act on up to **200** at once: add to / remove from a group, refresh
  inventory (which also asks for an update scan), queue a RustDesk client update, and export the selection. Only
  actions that already exist for one computer and are safe to repeat; there is deliberately no bulk connect,
  archive, delete or approved action. Every computer is decided on its own, server side, and the response lists each
  one's result: a computer the caller cannot see (another business's, an ungranted one, a made-up id) is
  `NOT_FOUND` with no name, exactly as the single route says. Refresh is `EndpointsService.requestInventoryRefresh`
  itself (technician grant, capability, fleet-abuse admission, its own audit entry). Client update keeps the
  one-click rules — Platform Admin only, pin over latest, staged through `UpdateService.requestRustdeskUpdate` so its
  rules and per-computer audit apply — and additionally refuses what could never apply (no device secret, no
  reported version, a staged rollout owns it) and anything under an `updates` containment pause (`CONTAINED`, with
  the pause's reason), which the heartbeat would only have withheld. Group membership needs the manage rule over the
  group's business, and a computer of another business is refused `OTHER_BUSINESS` — even for a Platform Admin. A
  computer already in another group is refused `IN_OTHER_GROUP`, naming it; nothing is moved silently. The export is
  the device list's own audited export (`ENDPOINT_LIST_EXPORTED`, `logOrFail`) with the selection AND-ed on and
  recorded. Each request is audited as `DEVICE_BULK_ACTION`, once per business it touched, with what succeeded and
  the refusal codes.

#### Changed

- **A bulk refresh stops short of the fleet-abuse limit instead of tripping it.** The abuse guard pauses a person and
  alerts an administrator the moment a request would exceed their limit on distinct computers (40 per window for a
  member, 60 for a Platform Admin, per preset tier for technicians). That is right for someone fanning out single
  requests and wrong for someone who ticked 200 boxes, so the bulk path reads the guard's own window first and
  refuses the overflow with `FLEET_LIMIT` (naming the limit). It never admits anything itself: every computer it lets
  through is still admitted by the guard, and an approved maintenance exception still lets its computers past.
- **A computer can only be put in its own business's group, everywhere.** `POST /endpoints` stored
  `endpointGroupId` unchecked; it now must be that business's group (or a pre-0.33 group with no business in the same
  tenant). Enrolment tokens apply the same rule (they previously checked only the tenant), the claim re-checks it
  and drops a group deleted since the token was made instead of failing the install, and a computer that moves
  business — re-enrolled into another business, or moved by a Platform Admin — leaves its old business's group.
- The client-update rollout states (`ROLLOUT_OPEN`) are defined once, in `client-updates/policy.ts`; the sweep and
  the policy service had a copy each.

#### Upgrade notes

- **Migration `0040_device_views`.** `EndpointGroup` gains `customerId` and `createdById`; the tenant-wide unique name
  becomes unique per business. A pre-0.33 group whose members are all in one business of its tenant is given that
  business; any other (empty, or spanning businesses) keeps `customerId` NULL — it still filters and still works on
  enrolment tokens, and the console offers no way to edit it. `SavedView` (in the schema since before 0.31, never
  written) gains `customerId`, `shared`, `density` and a foreign key to its author (`SET NULL`: a shared view outlives
  its author), and its `tenantId` becomes nullable. Six `ActivityAction` values are added. **Schema change: run
  `prisma migrate deploy` and regenerate the client at the target** (CLAUDE.md, *A schema change needs two more
  steps*).
- `AdminModule` now exports `UpdateService` and `EndpointsModule` exports `EndpointListService`, for the bulk
  service. No production dependency changes.
- Browser-saved views are not migrated automatically: each user is offered *Import N views saved in this browser*
  in the Views menu, once.

#### Verification

- `apps/api/scripts/e2e-device-views.mjs` (new, self-starting on port 3291): **117 passed, 0 failed** — views round
  trip and store only list parameters; personal views are private; who may share; a shared view cannot name another
  business's business/site/group and cannot widen visibility (Business User, restricted technician, alerts filter);
  Business B gets 404 on A's views and groups; groups' edit rule, per-business names, group filter and counts never
  widening; a group cannot hold another business's computer through bulk, `POST /endpoints` or an enrolment token;
  per-computer bulk refusals (not found, no permission, archived, Linux, no device secret, containment, in another
  group, already current); the fleet limit stopped short of with nobody paused; the 200 cap and no other actions; the
  selection export and its audit; `DEVICE_BULK_ACTION` once per business.
- `apps/api/scripts/unit-device-views.mjs` (new, in CI): **60 passed** — filter normalisation through the list's
  parser, updates applying no defaults, the manage rule, selection cap and de-duplication, the four actions, the
  fleet budget, and per-computer refusal mapping.
- Existing suites rerun against the change: `e2e-device-list` 113 passed, `e2e-credentials` 44, `e2e-auto-updates`
  73, `e2e-add-device` 58, `unit-update-window` 85.
- `scripts/check-security-invariants.mjs` §29 (14 checks): the four actions and nothing that connects,
  archives, deletes or runs an action; the cap; visibility AND-ed; refresh and client update through the single
  paths with the admin and containment checks; the fleet budget only refusing; the manage rule; group writes and
  same-business membership; another business's group is a 404; group integrity at creation, tokens, claims and
  business moves; every route names its capability and no route runs a view; views store list parameters only;
  view privacy; the selection export; the audit entries. Each check was shown to fail with its guard removed (25
  mutations, all caught) and restored.
- `docs/API-REFERENCE.md` regenerated and checked against the runtime route table (416/416).
- Not verified in a browser: the device-list UI (selection, bulk bar, result dialog, views menu, groups dialog)
  type-checks, lints and builds, but was not driven against a running stack.

### Metric history

#### Added

- **Metric history: CPU, memory and disk over time** (`GET /endpoints/:id/metrics?range=24h|7d|30d|90d`, the device
  workspace's new **Performance** tab). Until now the console had the latest reading only — the Overview gauges
  and the device-list columns — so "did this disk fill overnight or over three months?" had no answer. Each
  authenticated heartbeat now also writes one `EndpointMetricSample` (processor %, memory used %, system-disk
  used %), at most one per computer per minute (`METRIC_MIN_INTERVAL_SECONDS`), from the same values
  `recordLiveState` already sanitised; each inventory pass writes one `EndpointDiskSample` per volume. No agent
  changed: the Windows and Linux agents already send these. 24 h is served from raw samples; 7, 30 and 90 days
  from an hourly roll-up (`EndpointMetricHourly`: count, min, mean, max), with hours not rolled yet computed from
  raw at read time so a chart never has a hole because the sweep has not run. **Gaps are returned as gaps** —
  `{from, to}` intervals; 10 minutes with no sample for per-heartbeat series (the offline sweep's threshold), a
  missing hour for hourly ones, 13 h for volumes — and the chart breaks the line and hatches the stretch; nothing
  is interpolated or carried across. The route needs `computers:view` and scopes with `assertEndpointInScope`
  (technician grant) AND `endpointVisibilityWhere` (a Business User sees only granted and company-wide computers);
  anything else is the same 404 as a nonexistent id. The tab shows for any computer whose agent reports (not
  RustDesk-only), in light and dark themes, with crosshair and keyboard readout, and a table view. See
  `docs/metric-history.md`.
- **Downsampling and retention sweep** (every 5 min, `METRIC_SWEEP=off` stops it in a process, mirroring
  `MONITOR_SWEEP`). It rolls up complete hours (two minutes after the hour ends), oldest first, at most
  `METRIC_ROLLUP_HOURS_PER_PASS` (6) per pass, each as an upsert recomputed from raw — idempotent, and safe with two
  API instances. Then it prunes in batches (`METRIC_PRUNE_BATCH` 5,000 × `METRIC_PRUNE_BATCHES` 10 per table per
  pass): raw past `METRIC_RAW_HOURS` (48, allowed 24–168) **only once its hour has been rolled up**, so a sweep
  switched off for a week loses nothing when it comes back; hourly and volume rows past `METRIC_HOURLY_DAYS` (90,
  allowed 7–400). Out-of-range settings are clamped and unparsable ones take the default. The normal pass looks only
  after the newest rolled hour (40 ms at 1,000 computers); the first pass of a process and every
  `METRIC_FULL_SCAN_PASSES` (12) anti-join all of raw against the roll-up, to find a skipped hour after a clock step
  or restore (1.7 s at 1,000 computers).
- **Storage, measured:** ≈ 770 MB per 1,000 computers at default retention with two volumes each (raw 180 MB,
  hourly 450 MB, volumes 137 MB; ~200 B per row including indexes), on PostgreSQL 16 with synthetic data.
- `check-security-invariants.mjs` **§30 Metric history** (5 checks): a sample is written only inside the
  heartbeat's authenticated branch, from `recordLiveState`'s sanitised values; volume samples only from
  `recordInventory`'s `sanitizeDisks` output; nothing else in the API writes the three tables; the route names
  `computers:view` and uses both scope checks; the sweep honours `METRIC_SWEEP=off`, every query is `LIMIT`ed, the
  retention ceilings are finite and applied, and the one-sample-per-interval guard is in place. Each was proved to
  fail with its guard removed.

#### Changed

- Monitoring is unchanged and does not read history: the disk, processor and memory monitors still judge each
  reading as it arrives. `docs/monitoring.md` and the in-app `/help` say how the two relate. `recordLiveState` now
  returns the sanitised resource values it stored (it returned nothing).

#### Upgrade notes

- Migration `0041_metric_history` adds three tables and no columns elsewhere; run `prisma migrate deploy`, then
  regenerate the Prisma client at the target (CLAUDE.md, *A schema change needs two more steps*). History starts
  with each computer's first heartbeat after the upgrade; there is nothing to backfill.
- Budget ≈ 0.8 MB of database per computer at the defaults. A scratch or capture API pointed at a database it
  should not prune can set `METRIC_SWEEP=off` (it only ever touches the three metric tables).
- Non-system volumes are sampled only on the ≈ 6-hourly inventory pass, because the heartbeat carries the system
  volume only; the system volume therefore appears both per heartbeat and per inventory pass.

#### Verification

- `unit-metric-history.mjs`: 42/42 (samples from heartbeat values, volume samples, roll-up, which hours a pass
  rolls, retention defaults/floors/ceilings, ranges, gaps, hourly merge). Added to CI.
- `e2e-metric-history.mjs` (own API on 3301, started twice): 59/59 on a database of its own (proves the normal
  pass after a first full scan), 58/58 in a shared database (proves catch-up by full scan). Unauthenticated,
  wrong-secret and unbound-node heartbeats write nothing; an authenticated one writes exactly one sample with the
  right percentages; a second inside the interval writes nothing; inventory writes one sample per volume and a
  wrong secret none; with `METRIC_SWEEP=off` nothing is rolled or pruned over several intervals; with it on every
  complete hour equals the JS reference roll-up exactly, no pass rolls more than 3 hours, further passes change
  nothing, raw past 48 h is pruned once rolled and raw inside 48 h kept, hourly and volume rows past 90 d pruned;
  24 h/7 d/30 d/90 d read the right store and exclude what is outside them, gaps contain no points, an invalid range
  is a 400; Business B's owner, an ungranted Business User and a technician restricted to another computer all get
  the nonexistent-id 404, `computers:view` is required, the admin is the control. Added to `scripts/run-e2e.sh`.
- `e2e-linux-agent.mjs`: 86/86 (two new checks: the real Linux script's heartbeat and inventory land as one sample
  and one volume sample per mount). `e2e-monitoring.mjs` 108/108 and `e2e-device-list.mjs` 113/113 unchanged.
- `check-security-invariants.mjs` all hold (§30 adds 5); `check-versions.mjs` passes; `pnpm -r lint`, `tsc` in both
  apps, `nest build` and `next build` clean. API reference regenerated and matches the runtime route table
  (406 routes).
- The Performance tab was rendered against a scratch API and screenshotted at desktop and narrow widths in both
  themes, with no sideways overflow. `e2e-navigation.mjs` gained a Performance check (tab after Overview, renders,
  range picker) but was **not run**: it needs the docs stack on port 4000, outside this increment's ports.

### Processes, Services and Network snapshots

#### Added

- **Processes, Services and Network tabs on the device workspace** (standard Windows agent). Three read-only
  snapshots: every running process (name, PID, processor time, working set, the user it runs as where the agent can
  read it, start time), every installed service (name, display name, state, start mode including delayed start, and
  the account it runs as) and every connection Windows lists under Network Connections (status, speed, MAC,
  IPv4/IPv6, gateways, DNS servers and suffix, DHCP server and lease). Each tab says when the snapshot was taken and
  how old it is (flagged past a day), and **Refresh** asks for a new one; while it is on its way the old snapshot
  stays with the refresh beside it, and a failed or expired refresh is shown with its reason beside the last good
  one. Processes and Services sort and filter; Services can show only automatic services that are not running.
  There is nothing on these tabs that acts on the computer — no end task, stop, start or restart. Restarting a
  service stays a signed maintenance action; ending a process is not offered.
- They ride the 0.31 diagnostics catalog rather than a new channel: three more closed keys, `process_list`,
  `service_list` and `network_adapters`, requested with `POST /endpoints/:id/diagnostics/runs` (a key and nothing
  else), handed out on the authenticated heartbeat as id and key, and reported to `/enrollment/diagnostic-result`
  with the device secret. Every request and completion is audited as for any diagnostic
  (`ENDPOINT_DIAGNOSTIC_REQUESTED` / `_COMPLETED`, never result content). A new read,
  `GET /endpoints/:id/diagnostics/snapshots/:key`, returns the newest completed result with `takenAt`, an open
  refresh (`pending`) and a newer failure (`lastFailure`); any other key is a 400 `UNKNOWN_SNAPSHOT`. The Diagnostics
  list leaves the three keys out (their tabs show them), and the run history lists snapshot runs without their
  result (`resultOnTab`), so it stays small.
- **Bounded and redacted.** The agent sends at most the 1,000 largest processes by memory, 1,000 services and 32
  adapters; the server keeps the same, re-shapes every field (unknown fields dropped, control characters stripped,
  profile paths and long tokens redacted, process names cut to the file name, accounts, service names, MACs,
  addresses and DNS suffixes each checked against a charset, numbers range-checked — the "unknown" Int64 speed of a
  disconnected adapter is dropped) and caps the stored result at 128 KB (`MAX_SNAPSHOT_BYTES`), cutting the longest
  list and marking it truncated; the tab says so. Every other key keeps its 32 KB cap. Command lines, executable
  and service binary paths, modules and environment variables are never collected.
- **The agent's snapshot functions** (`Get-Rem0teSnapProcesses`, `…Services`, `…Network` in `heartbeat.ps1`) use
  `Get-Process -IncludeUserName` (falling back to `Get-Process` without elevation, and saying users were not read),
  `Get-CimInstance Win32_Service` and `Get-CimInstance Win32_NetworkAdapter` / `Win32_NetworkAdapterConfiguration`,
  and are reachable only from the catalog switch. Every string put into a result goes through
  `Get-Rem0teSnapText` (control characters out, clamped) or `Get-Rem0teSnapMatch` (also an explicit charset).
- **A build-time guard on the generated heartbeat**, `assertSnapshotBlockSafe()` in `public/windows-script.ts`,
  applied to both installer variants. The heartbeat is one template literal, not `joinPs()` statements, so this is
  its counterpart: it refuses to produce an installer whose snapshot block calls anything but `Get-*` cmdlets (plus
  `Sort-Object` / `Select-Object`), uses `Invoke-*`, `iex`, script blocks, the call or dot-source operator,
  `New-Object`, `Add-Type` or `Start-*`, reads `PathName`, `CommandLine`, `.Path`, modules or `$env:`, or puts a
  result field together without one of the two helpers (tracing each variable back to its assignments).

#### Changed

- **Diagnostics routes apply the device-list visibility rule, not only business scope.** `catalogFor`, `request`,
  `history`, `getRun` and the new `snapshot` now check business scope *and* `acl.endpointVisibilityWhere`, so a
  Business User sees only computers granted to them or company-wide, and any other reads as missing (404). Before
  this, such a user could stage a diagnostic on a computer in their business that they could not see — it then
  failed at delivery as `requester_lost_access` — and could read that computer's run history and results. Found
  while writing the A/B suite for this change: a viewer's refresh of an ungranted computer returned 201.
- `unit-diagnostics-catalog.mjs` and `e2e-diagnostics-catalog.mjs` expect twelve catalog keys; the database key
  list is read from migration 0042. §20's capped-result check follows `capResult(shaped, resultCapFor(run.key))`.

#### Not included

- **Linux.** The standard Linux agent reads only command ids and three fixed command types from the heartbeat
  response, never a diagnostics run, and `systemctl` is deliberately absent from it (§24). Offering these there
  would widen what that agent reads and runs, so the tabs are not shown for Linux and a request is refused
  (`DIAGNOSTIC_OS_UNSUPPORTED`).
- **MAC masking.** No masking policy applies to MAC addresses today (the Specs tab shows them in full), so the
  Network tab shows them in full too.

#### Upgrade notes

- **Migration `0042_system_inventory`.** Redefines `DiagnosticRun_key_catalog` to add the three keys, and
  `DiagnosticRun_result_bounded` to allow 256 KB of jsonb text for them (the service caps them at 128 KB; jsonb's
  text form adds spacing) while every other key keeps 64 KB. Adds the index
  `DiagnosticRun(endpointId, key, completedAt)` for the tabs. No data changes. **Schema change:** run
  `prisma migrate deploy`, rsync `prisma/` and regenerate the client at the target (CLAUDE.md).
- The agent picks the new functions up with its next heartbeat-script refresh (reinstall, or the update path that
  rewrites `heartbeat.ps1`). Until then a refresh is delivered and then expires after ten minutes with "Delivered
  to the computer but never started … the agent probably predates the diagnostics catalog" — the existing message;
  for these keys it means "predates 0.33".
- **Nothing here has run on real Windows.** The PowerShell is parsed with
  `[System.Management.Automation.Language.Parser]::ParseFile()` (PowerShell 7.4) and run under pwsh on Linux against
  stub `Get-Process` / `Get-CimInstance`. Unverified until it does: `Get-Process -IncludeUserName` as SYSTEM in
  Windows PowerShell 5.1, `Win32_Service.DelayedAutoStart` (absent on older builds — the start mode then reads
  *Automatic*), and the `Speed` a real disconnected adapter reports.

#### Verification

- `unit-system-inventory.mjs` — **92 passed**: the three entries, sanitizers against hostile input, row and byte
  bounds, the build-time guard (13 mutations, each refused), and with `PWSH` set: both installers and the heartbeat
  parse (`ParseFile`), and the three keys run against stubs — elevated, not elevated, hostile values, 1,505
  processes (the agent sends 1,000; the post stays under the 600,000-character cap) — and survive the server's
  sanitizer and cap. Added to CI.
- `e2e-system-inventory.mjs` — **68 passed**: empty snapshot; refusals (unknown snapshot key, parameters, Linux,
  unbound agent) write nothing; no `computers:view` → 403; an ungranted computer → 404 for snapshot, refresh, history
  and catalog; business B → 404 and its device cannot touch A's runs; request → heartbeat (id and key only) →
  running → completed; hostile results trimmed and redacted, 1,503 processes stored within 128 KB and marked
  truncated; a 700,000-character post refused; refresh pending, failed and replaced; the history leaves results
  out; database backstops (unknown key, 256 KB snapshot, 64 KB elsewhere); audit with no result content. Added to
  `scripts/run-e2e.sh`.
- `e2e-diagnostics-catalog.mjs` — **70 passed**; `e2e-linux-agent.mjs` — **84 passed**; `unit-diagnostics-catalog.mjs`
  — **110 passed**; `unit-monitoring.mjs` — **100 passed** (with `PWSH`); `unit-signed-installer.mjs` — **51 passed**.
- `scripts/check-security-invariants.mjs` **§31** (10 checks) — each proven to fail with its guard removed (14
  mutations) and restored; §20 updated for migration 0042 and the per-key cap.
- `e2e-navigation.mjs` extended (a Windows device has the three tabs, each with its age, a Refresh and no action
  button) — **not run here**: it needs the docs stack on port 4000, outside this increment's ports. The tabs were
  rendered and screenshotted against a scratch API and `next dev` on ports 3315/3316 (light, dark).
- `pnpm -r lint`, `tsc --noEmit` (both apps), `nest build`, `next build`, `check-versions.mjs`;
  `docs/API-REFERENCE.md` regenerated and checked against the runtime route table (406 routes).

### Standard macOS agent

#### Added

- **A read-only macOS agent: heartbeat, inventory and pending updates.** Before this, a Mac sent one registration
  when its installer ran and nothing after it. There was no heartbeat, no inventory, and no patch or monitoring
  data. Run with `sudo` (as **Devices → Add device** shows it), the macOS installer now installs a POSIX `sh`
  agent at `/Library/Rem0te/rem0te-agent`. A LaunchDaemon (`com.rem0te.agent`) runs it as root every 180
  seconds and at load, at background priority, with `PATH=/usr/bin:/bin:/usr/sbin:/sbin`. It is the 0.32 Linux
  agent's twin. The code that touches the device secret, the server and the server's response is now one shared
  module, `apps/api/src/public/posix-agent.ts`, used by both agents: the sanitisers, the config and secret checks,
  `post()`, the heartbeat body and the command loop. Only the measuring is per platform.
  - It reports `sw_vers`, kernel, boot time (`sysctl kern.boottime`), CPU load (`top -l 2`, second sample),
    memory (`hw.memsize`, `vm_stat`), volumes (`df` + `mount`, APFS system volumes left out) and the console user.
    It also reports the RustDesk version (from `Info.plist`), and model, serial and firmware (`ioreg`, plus
    `system_profiler SPHardwareDataType` bounded to 15 s).
  - It authenticates with the secret bound at claim, with no first-sight binding. It is shown as **Standard
    (macOS)**; a Mac without the agent stays *RustDesk only*.
  - Everything is under `/Library/Rem0te`, not `/usr/local`. On an Intel Mac with Homebrew, `/usr/local` belongs
    to an admin account, so a root daemon running a script from there could be replaced from that account.
  - The secret is `root:wheel 0600`, and the agent refuses it if it is looser or owned by another account.
  - `--uninstall` removes the daemon, script, config, log and secret, and leaves RustDesk.
- **Pending updates on a Mac come from macOS's own last check.** The agent never runs `softwareupdate`. It reads
  `RecommendedUpdates`, `LastSuccessfulDate` and `AutomaticCheckEnabled` from
  `/Library/Preferences/com.apple.SoftwareUpdate` with `defaults read`.
  - Why not `softwareupdate -l`: it contacts Apple's (or the MDM's) catalog, takes from seconds to minutes, can
    stall behind a busy `softwareupdated`, and macOS has no `timeout` to bound it. Every other option of it
    downloads, installs or changes the schedule.
  - If there was no check, or the last one is older than 36 hours (the Patches tab's stale threshold), the scan
    is reported **failed: "Pending updates unknown"**, with the age and whether automatic checking is off. An old
    list is never shown as current.
  - Restart pending is always unknown on a Mac, because macOS does not record it with the list.
- The console refuses password rotation, reinstall and event-log queries for a Mac (`MACOS_AGENT_READ_ONLY`), as it
  does for Linux. The one-click RustDesk client update now skips Macs. Before 0.33 it staged an update there that
  could never apply, because Macs never heartbeated. Server side, `refuseOnLinux` / `isLinuxPlatform` became
  `refuseOnReadOnlyAgent` / `readOnlyAgentOs` in `common/platform.ts`, which covers both platforms.
  `LINUX_AGENT_READ_ONLY` is unchanged.
- The device workspace hides Software and Event logs for a Mac with the agent, as for Linux. **Add device** now
  shows the agent, identity and inventory health rows for Linux and macOS, not only Windows. Its Linux and macOS
  text had still said "remote access only" after 0.32.

#### Fixed

- **Both shell installers exited at their first line of work under `set -euo pipefail`.**
  `PERM_PW=$(tr -dc … < /dev/urandom | head -c 12)` ends with `tr` killed by SIGPIPE. That is status 141, and
  `pipefail` turned it into the script's exit status before anything was installed or printed. Every random-string
  pipeline in the Linux and macOS installers now ends `|| true`. Found while writing the macOS e2e, which now runs
  those lines from both served installers under `bash -c 'set -euo pipefail'`. The Linux installer had only ever
  been checked with `bash -n`, and no Linux endpoint has been installed yet (`docs/capabilities.md`).
- The Linux agent now also refuses a secret file not owned by the account it runs as, through the shared check.
  Before, it checked only the mode.

#### Changed

- `e2e-linux-agent.mjs` links `id` into its minimal PATH (the owner check needs it).
- The agent-coverage report's "non-Windows with no inventory" definition, its hint and `docs/reports.md` no longer
  say Linux and macOS agents send no inventory.

#### Upgrade notes

- **Macs enrolled before 0.33** have no agent. Re-run the installer with `sudo` from a new enrolment link.
  - Older installers kept the device secret in the home directory of whoever ran them. The new one reuses that
    secret, so the computer stays bound, **only if root wrote it** (owner 0, mode 600, not a link), because a copy
    a user wrote is one that user knows. It then deletes every copy.
  - Run without `sudo`, the installer behaves as before (RustDesk and one registration) and says how to add the
    agent.
- No migration and no new route. `AGENT_CONTRACT_VERSION` is unchanged: it tracks the Windows heartbeat script.

#### Verification

- **Evidence: integration-tested only.** No Mac, launchd or root has been involved. `docs/capabilities.md` says so
  and lists a Mac as lab item 5.
- `apps/api/scripts/e2e-macos-agent.mjs`: **106 passed, 0 failed**.
  - It runs the real generated agent against a real API and scratch database, on Linux, unprivileged.
  - Every macOS command is a stub printing recorded macOS output: `sw_vers`, `sysctl`, `vm_stat`, `top`, `who`,
    `df`, `mount`, `ioreg`, `system_profiler`, `defaults`, `plutil`, `dscl`, `hostname` and `uname`.
  - It runs to completion under dash, `bash --posix` and zsh 5.9's sh emulation.
  - It proves that the inventory lands with exact values, and that wrong, missing, 644/640/660/604 and
    foreign-owned secrets are refused.
  - It proves A/B business isolation (claim, inventory, list, command results, rotation as 404) and that hostile
    strings are stripped and never evaluated.
  - The console refusals and the ignored staged rotation, reinstall, client update and event-log query are
    checked.
  - The four update-cache states, and a hung `system_profiler` cut off at 15 s, are covered.
  - Marker stubs for `softwareupdate`, `launchctl`, `shutdown`, `defaults write` and 25 other state-changing
    commands never ran.
- `apps/api/scripts/unit-macos-agent.mjs` (new CI step): **31 passed** with zsh, 27 without.
  - The awk date conversions match JavaScript over 2,008 instants in every shell. This found busybox awk's `%d`
    wrapping at 2³¹ (2038), now `%.0f`.
  - Also covered: the `RecommendedUpdates` parser, platform mapping and template guards.
  - Both agents parse under sh, dash, `bash --posix`, busybox sh and zsh's sh emulation.
- `e2e-linux-agent.mjs` against the refactored Linux agent: **84 passed** (unchanged). The generated Linux script
  was diffed against 0.32's: the only differences are the owner check, the `wc` padding fix, and variable names.
- `e2e-auto-updates` 73, `e2e-reports` 102, `e2e-diagnostics-catalog` 70: all pass.
- `check-security-invariants.mjs`: all checks hold (182 on the branch).
  - §24 is reworked for the shared module and gains the owner check and the macOS console refusals.
  - New §32 covers macOS: the shared guards are assembled in; no `softwareupdate`, `launchctl`, `defaults write`,
    in-place `plutil` or `/usr/local`; the system PATH; `system_profiler` only through `bounded()`; the root-only
    secret and its legacy adoption rule; the daemon only as root; and `--uninstall`.
  - It also checks that every urandom pipeline ends `|| true`.
  - All 18 new or changed checks were shown to fail with their guard removed.
- `pnpm -r lint`, `tsc --noEmit` (both apps), `nest build` and `next build` are clean.

### Integration notes
- Security invariants are numbered, after 0.32's §25 patch policies: **§27** enrolment step-up, **§28** global
  search, **§29** device groups, saved views and bulk actions, **§30** metric history, **§31** system inventory
  snapshots, **§32** the macOS agent. Each branch had numbered its own section §25. **§26 is left free** for the
  0.31.2 security fix (`AccessControlService.assertEndpointInScope`), which is merged in after 0.32's §25. §24 (the Linux agent) is the
  macOS branch's version, reworked for the shared `apps/api/src/public/posix-agent.ts`; §20 is the inventory
  branch's, reading the diagnostics key list from migration 0042 and the per-key result cap.
- `scripts/run-e2e.sh` runs the new suites `enrol-stepup`, `search`, `device-views`, `metric-history`,
  `system-inventory` and `macos-agent` beside 0.32's, exports `METRIC_SWEEP=off` next to `PATCH_POLICY_SWEEP=off`,
  and runs every scratch API with `MONITOR_SWEEP=off CLIENT_UPDATE_SWEEP=off PATCH_POLICY_SWEEP=off
  METRIC_SWEEP=off`. `e2e-metric-history.mjs` sets `METRIC_SWEEP: 'on'` for its own API, because it tests the
  sweep and would otherwise inherit the export. The scratch-API port can be moved with `E2E_API_PORT` (default
  3101).
- Branches built before the enrolment step-up minted tokens with a bare session: `e2e-device-views.mjs` now steps
  up before its token checks, and `e2e-macos-agent.mjs` steps every session up at login, as `e2e-linux-agent.mjs`
  already did. `e2e-macos-agent.mjs` also marks `rpm` (a Mac agent never calls it); the Linux sandbox keeps 0.32's
  `rpm` stub, and both suites pass with a host `rpm` that runs `bash -c` first on `PATH` (without the Linux stub,
  that run fails the four marker checks CI failed).
- The device workspace tabs are Overview · Performance · Monitoring · Software · Processes · Services · Network ·
  Patches · Event logs · Diagnostics · Actions · History.
### Verification (integrated)
- `scripts/run-e2e.sh` against a fresh scratch database, with `RELEASE_BIN` and `ACTION_SIM` built from
  `tools/windows-installer`: **all 39 suites pass, none skipped** (2,490 counted checks over the 34 suites that
  print a count; `smoke`, `full`, `public-api`, `candidate-password` and `security-regression` report pass/fail).
  The new suites: `enrol-stepup` 44, `search` 113, `device-views` 117, `metric-history` 59, `system-inventory` 68,
  `macos-agent` 106; beside them `linux-agent` 86, `patch-policies` 75, `maintenance-actions` 64, `device-list`
  113, `add-device` 62, `script-library` 138, `reports` 102.
- Every unit script CI runs: 18 scripts, 1,091 checks, with `PWSH` set so the PowerShell blocks are parsed and run.
  `go test ./...` in `tools/windows-installer` passes.
- `check-security-invariants.mjs`: 243 checks hold. `check-versions.mjs`, `pnpm -r lint`, `tsc --noEmit` (api,
  web), `nest build`, `next build` and the launcher build pass. `docs/API-REFERENCE.md` regenerated (424 routes,
  56 controllers) and the docs bundle rebuilt.
- Not run: `apps/web/scripts/e2e-navigation.mjs` and `e2e-search-palette.mjs` (browser suites for the docs stack,
  not in CI); nothing on real Windows or a real Mac.

### Upgrade notes (all of 0.33)
- **Schema change:** migrations `0040_device_views`, `0041_metric_history` and `0042_system_inventory` (0039, 0043
  and 0044 were reserved and are unused). Take a `pg_dump` first, then `prisma migrate deploy`, rsync
  `apps/api/prisma/` to the target and run `prisma generate` there, as `CLAUDE.md` describes — without the last two
  the API throws `Unknown field ... on model ...` at runtime.
- No production dependency changed; the target's `node_modules` stays.
- `GET /admin/search` has been gone since 0.31.2 (it scoped computers by business alone). Its replacement is
  `GET /search?q=`.
- **Making an install link needs a fresh re-authentication** for every role, once per 10 minutes. Scripts that
  call `POST /enrollment/tokens` with a session must `POST /auth/step-up` first; API keys are unaffected, but
  creating a key with `enrollment:write` now needs the same confirmation.
- **Existing Linux and macOS installs must re-run the installer to get the agent**: Linux computers enrolled before
  0.32 and Macs enrolled before 0.33 have RustDesk only. Macs need the installer run with `sudo`.
- Windows computers pick up the Processes, Services and Network snapshot functions with their next heartbeat-script
  refresh (reinstall, or the update path that rewrites `heartbeat.ps1`); until then a refresh expires with the
  existing "predates the diagnostics catalog" message.
- **New settings**, all optional: `METRIC_SWEEP` (default on; `off` stops roll-up and pruning in that process — set
  it on scratch and capture APIs), `METRIC_RAW_HOURS` (48, 24–168), `METRIC_HOURLY_DAYS` (90, 7–400),
  `METRIC_ROLLUP_HOURS_PER_PASS` (6), `METRIC_PRUNE_BATCH` (5,000), `METRIC_PRUNE_BATCHES` (10),
  `METRIC_FULL_SCAN_PASSES` (12), `METRIC_SWEEP_SECONDS` and `METRIC_MIN_INTERVAL_SECONDS`. Out-of-range values
  are clamped. Budget ≈ 0.8 MB of database per computer at the defaults; see `docs/server-sizing.md`.
- Browser-saved device views are not migrated automatically: each user is offered *Import N views saved in this
  browser* once.

---

## [0.32.0] — 2026-11-11 · *Fieldkit*

The second increment of the RMM overhaul (`docs/rmm-gap-analysis.md` items 7–12, plus patch policies requested on
2026-11-11). Each part below was built and tested on its own, then integrated. Anything that acts on a computer —
maintenance actions, patch installs, policies — is **simulated only** (S evidence): it needs a signed agent, the
approval signer and approvers, none of which production has yet. `docs/patching-setup.md` is the order to turn them
on, and the Patching page's pre-flight shows what is missing.

### Fixed (dashboard)
- **The dashboard's device map shows by default again**, as in 0.31.1: 0.31.0 hid it behind *Show device locations*
  and it read as removed. *Hide device locations* folds it away per browser (`localStorage` `dashboard.map`).

### Guided Add Device

#### Added

- **Add device: one guided flow** at `/endpoints/enroll`, replacing four ways to do the same thing (the Devices
  page's *Enroll Client* button, its *Generate Enrollment Link* modal, the business page's *Create installer link*,
  and Quick Start's manual-token instructions). Six steps on one page: (1) business, then site or *No site*, and who
  may connect; (2) operating system; (3) the install command, from the existing single-use 24-hour enrolment token
  and the existing install scripts, plus the one-click `.exe` link on Windows; (4) waiting for the device, by
  polling the new `GET /enrollment/tokens/:id/status`; (5) its first health as the server has it: business and
  site it landed in, online, agent type and version (after its first heartbeat), device identity bound, first
  inventory received; (6) links to the device, its Monitoring tab and the business's monitoring policies
  (`/settings/monitoring?businessId=`), with the monitors that already apply listed. Each health line stays
  *waiting* until a row says otherwise; nothing is inferred. The raw token is held only in the page's memory,
  once, as the creation response has always returned it; the URL carries the token's *id*, so a reload keeps
  waiting but cannot show the command again (revoke and make a new one). The Devices page now has one *Add device*
  button, the business page's Downloads tab and Quick Start link to the flow with the business chosen, and a
  computer's *Make an enrollment link for this computer* opens it bound to that computer. `/endpoints/new` stays,
  renamed **Register by RustDesk ID**, because it does something the flow does not: list a machine already
  running RustDesk without installing anything (it gets no agent).
- **An enrolment token can name the site** the device lands in (`siteId` on `POST /enrollment/tokens`, migration
  `0032_add_device_token_site`). Bound at mint time like the business, for the same reason: the machine that
  redeems the token must not choose where it lands, and a site set by the browser after the device appears would
  be lost whenever the person closed the page first. It must be an active site of the token's business; a site of
  another business is refused with the same message as one that does not exist (`Unknown site for this
  business`), so it cannot be used to probe. At claim the site is re-checked: one deactivated in the token's
  24 hours is dropped and the device still enrols into the business. Deleting a site sets the token's site to
  null (`ON DELETE SET NULL`); it never invalidates the token. The site is recorded in `CLAIM_TOKEN_CREATED` and
  `ENDPOINT_CLAIMED` audit metadata.
- **`GET /enrollment/tokens/:id/status`** (`COMPUTERS_VIEW`): `waiting`, `expired`, `claiming` (consumed, endpoint
  not yet recorded) or `enrolled`, and the device's first health. The token is looked up inside the caller's
  business exactly as the token list is (another business's token is a 404, never a 403); the device is read
  through `acl.endpointVisibilityWhere` AND-ed with its id, so a Business User who mints an `ASSIGNED_USERS` token
  for somebody else is told it enrolled but is not shown the device, as the device list would not show it either.
  It returns no token, no token hash and no device secret, only whether a secret is bound and when.

#### Changed

- Token creation's permission checks are unchanged: `computers:add`, the business resolved from the caller's
  scope, a Platform Admin must name one, and naming another business (by `businessId` or the legacy `customerId`)
  is a 403.

#### Upgrade notes

- **Schema change:** run `prisma migrate deploy` (migration `0032_add_device_token_site`, one nullable column and a
  foreign key on `DeviceClaimToken`), then rsync `apps/api/prisma/` to the target and `prisma generate` there, or
  the API throws `Unknown field siteId`. Existing tokens and tokens minted without a site enrol exactly as before.
- Anything that linked to `/endpoints/new` as "Enroll Client" still works; the page is now *Register by RustDesk
  ID*. The *Generate Enrollment Link* modal is gone; bookmarks to `/endpoints` are unaffected.

#### Verification

- `apps/api/scripts/e2e-add-device.mjs` (new, self-starting on port 3201, refuses a database whose name lacks
  `test` or `scratch`; added to `scripts/run-e2e.sh`): **58 passed, 0 failed.** Minting: owner A cannot mint for
  B by `businessId`, legacy `customerId` or with B's site (403); B's site on an A token and a non-existent site
  get the same 400; inactive site refused; `computers:add` required; Platform Admin must name a business; B has no
  tokens after every refused attempt; only the hash is stored; minting audited with business, site and actor.
  Status: owner B gets 404 for A's token before and after enrolment; no `computers:view` is 403; no token, hash or
  device secret in any body. The real device path (claim → heartbeat → inventory command-result) moves status
  waiting → enrolled and fills agent type and inventory only after the device sent them. Owner B cannot see the
  device in the list, on its page, or in the token list. A Business User's `ASSIGNED_USERS` token for a colleague:
  enrolled, not shown, not even the id; a `COMPANY_WIDE` one is shown at the chosen site. Site deactivated before
  claim dropped, site deleted keeps the token. Expired and revoked tokens report as such. Platform Admin as the
  negative control.
- `apps/web/scripts/e2e-navigation.mjs`, extended (Devices has exactly one *Add device* button to
  `/endpoints/enroll` for those who may add, none otherwise, and no old enrol buttons; it opens the flow with its
  six steps; no sideways overflow): **140 passed, 0 failed** against a scratch stack (`next dev`). A first, cold
  run had 2 failures from dev-mode compile timing (an empty tab list read before the page hydrated, and a click
  read before navigation finished); the warm rerun passed every check.
- The flow was driven in a real browser against a scratch stack, light and dark: link made, token claimed as the
  installer would, steps 4–6 followed (a throwaway script, not committed; screenshots only, no check counts kept).
- `node scripts/check-security-invariants.mjs`: 130 checks, all hold. `pnpm -r lint`, `npx tsc --noEmit` (API and
  web), `npx nest build`, `npx next build`: clean. `docs/API-REFERENCE.md` regenerated (384 routes).
- **Not proven:** an install on a real Windows, Linux or macOS machine. The device path was exercised through the
  enrolment API as the install scripts call it, which were not changed.

### Scheduled RustDesk client updates

#### Added

- **Scheduled RustDesk client updates outside working hours** (Settings → *Client updates*,
  `/settings/client-updates`; `GET/PUT /client-updates/policy`, `DELETE /client-updates/policy/sites/:siteId`,
  `GET /client-updates/computers`). A business, and optionally each site, gets a policy: **off by default**, one to
  seven update windows (days, start, end, each at least 30 minutes) in a stated, validated IANA time zone, *skip a
  computer with an open session* (default on) and *skip a computer with someone logged on* (default off; an agent
  that does not say who is logged on is skipped too, because unknown is not "nobody"). A site policy replaces the
  business policy for its computers entirely, including being off when the business is on. Window rules are
  `rbac/schedule.ts`'s, shared rather than copied: an end before the start crosses midnight and belongs to the day it
  starts on, and daylight saving is never computed with local-time arithmetic — a window starting in a
  spring-forward hour opens when the clock next reads a real time, and a fall-back 01:00–02:00 covers both hours that
  read 01:xx. The page shows when each window next opens and closes. Migration `0033_client_update_policy`.
- **The client-update sweep** (`client-updates/client-update-sweep.service.ts`, every `CLIENT_UPDATE_SWEEP_SECONDS`,
  default 120; `CLIENT_UPDATE_SWEEP=off` stops it). Inside an enabled policy's window it queues outdated computers
  through the same `RustdeskNode.updateRequestedAt` path the Update button uses, marked **POLICY**: Windows, not
  archived, online, with a device secret, a reported version older than the pin (else the latest release), nothing
  already queued and no staged-rollout job. At most `CLIENT_UPDATE_SWEEP_BATCH` (default 25, max 500) per sweep
  across every business; the write is conditional on nothing being queued, so two API instances queue — and audit —
  a computer once. An `updates` containment pause skips the business. With no target version (GitHub unreachable,
  no pin) it queues nothing and says so once in the log. Each queued computer is audited as
  `CLIENT_UPDATE_AUTO_QUEUED`, with no actor.
- **Manual and automatic requests are told apart everywhere.** `RustdeskNode` gains `updateRequestSource`
  (MANUAL / POLICY), `updateRequestedById` and the last hold reason. The Updates page shows *by &lt;user&gt;* or
  *auto, waiting: …* and offers *Update now* on an automatic one (which makes it manual); the computer's Updates card
  no longer promises "next heartbeat" for an automatic request; Settings → Client updates lists every visible
  computer with what will happen to it — including, with the reason, the ones that never will (not Windows, no
  device secret, never reported a version).

#### Changed

- **The heartbeat withholds a POLICY request** outside its window, during an open session (the endpoint's own count,
  a confirmed session, or an unconfirmed launch in the last two hours) and, when asked, with someone logged on, and
  records why. It fails closed: if the policy cannot be read, the automatic update waits. A **MANUAL request still
  goes on the next heartbeat**, as before, and every request staged before this version is recorded as manual.
- **Turning a policy off withdraws** the POLICY requests it queued that have not completed; removing a site override
  does the same when the business policy is off. Manual requests are never touched.
- "Is a session open on this computer" is one function (`admin/session-evidence.ts`), used by staged rollouts and by
  the update policy, rather than two copies that could disagree.

#### Security

- **Who may change a policy:** a Business Owner for their own business; a technician whose assignment grants
  `computers:edit` over the *whole* business (an assignment limited to named computers cannot set a policy that
  reaches all of them); the MSP. A Business User cannot, whatever they hold, because they may see only some of the
  business's computers. Turning a policy on, saving one that stays on, or removing a site override needs fresh
  authentication (`STEP_UP_REQUIRED`, action `updates.schedule`) — it lets the server install software on every
  computer in the business unattended. Turning one off never does: stopping is never harder than starting. A site id
  from another business is 404, not 403. Every change is audited as `CLIENT_UPDATE_POLICY_CHANGED` with before,
  after, the window in words and what it withdrew.
- `check-security-invariants.mjs` §21 (17 checks): the edit rules, fresh authentication on both writes, the site
  belonging to the business, withdrawal limited to POLICY, the sweep's off switch, containment, open-window and
  batch guards and its audit, the heartbeat's fail-closed hold and its ordering after containment and the device
  secret, and `run-e2e.sh` running scratch APIs with the sweep off. Each was confirmed to fail with its guard removed.

#### Tests

- `unit-update-window.mjs` (85, in CI): validation, +5:30 / +5:45 / 30-minute-DST zones, windows across midnight,
  both DST transitions, next opening/closing against a minute-by-minute reference, and the shared policy decisions.
- `e2e-auto-updates.mjs` (73, in `run-e2e.sh`; own API on port 3211, sweep every 2 s, scratch/test database only):
  queues inside the window and not outside, batch cap, never the ineligible ones, site overrides, the heartbeat hold
  outside the window and during a session, manual requests going at once, containment, business isolation and the
  edit rules, step-up, withdrawal and audit. Nine guards removed one at a time from `dist`; the suite failed on each.

**Deploying:** this has a schema change — run the migration and regenerate the Prisma client at the target (see
`CLAUDE.md`). No production dependency changed. The standard agent's `heartbeat.ps1` is unchanged: it already
re-runs the installer when the heartbeat says so. Not proven on real Windows; the Windows side is the existing,
unchanged update path.

### Reports

#### Added

- **Reports** (menu entry *Reports*, `GET /reports/{patch-compliance|agent-coverage|alert-frequency|offline-time}`):
  four reports over a business, a site and a period, each computed only from what the database stores. Filters
  are business (Platform Admin, or anyone working in several), site, period (1, 7, 30, 90, 365 days) and, for
  agent coverage, *not heard from in* (1–90 days); other values are a 400, never widened to a default. Filters
  live in the address bar. See `docs/reports.md`.
  - **Patch compliance** per business and site, from stored Windows Update scans, with the dashboard's
    definition stated on the page. The rule now lives in one place, `apps/api/src/patching/compliance.ts`, and
    the dashboard calls it too, so the tile and the report cannot count differently. Devices with a stale scan
    or none are coverage gaps, counted apart and never as compliant; non-Windows devices among *no scan* are
    counted separately.
  - **Agent coverage**: devices by agent type (signed / standard / none) and version; devices with no device
    secret (telling *not bound* apart from *no RustDesk record*; the hash is never returned); devices not heard
    from in N days, oldest first; non-Windows devices with no inventory.
  - **Alert frequency**: alerts raised per business, site, computer and monitor type, by severity, open and
    resolved, with median / mean / longest time to resolve over resolved alerts only. Counted by first raised;
    repeats of an open problem are one alert. More than 50,000 alerts in the period is a 400 asking for a
    narrower report, never a partial count.
  - **Offline time**, derived from OFFLINE monitor alerts because `Endpoint.isOnline` is a sweep flag with no
    history. An episode runs from the alert's recorded `detail.lastSeenAt` (else `firstSeenAt`) to its
    reconnection-resolve, or now; clipped to the period; overlapping episodes (a person resolved while the
    computer was still silent and the monitor re-raised) are merged; alerts closed without a reconnect are
    marked. The page states when records begin and lists which visible computers have an enabled Offline
    monitor **today** (with View computers). **No availability percentage**: `MonitorRule` keeps no history, so
    the time each computer was monitored is unknown and any percentage would be invented.
- **CSV export for each report** (`…/export.csv`), the device list's way: capped at `EXPORT_MAX_ROWS` (10,000,
  refused above it, never truncated), formula cells neutralised with the shared `csvCell`, throttled, and audited
  as the new **`REPORT_EXPORTED`** action (migration `0034_reports_export_audit`) with the report, row count,
  filters and whether it came through a technician assignment — written with `logOrFail` before the file is
  sent, so an export the audit log cannot record is refused. The audit-log page colours it like
  `ENDPOINT_LIST_EXPORTED`.
- **Scoping.** Device reports start from `acl.endpointVisibilityWhere` AND-ed with `status: ACTIVE` and the site
  filter (never spread beside another `OR`); alert reports from `MonitoringAdminService.alertWhere` AND-ed with
  the same endpoint visibility, so a technician or Business User never sees an alert on a computer their grants
  do not cover (a site-wide outage alert, which has no computer, is visible to owners and technicians but not to
  a Business User). A foreign business is a 403, not an empty report. Patch compliance and agent coverage need
  `computers:view`; alert frequency and offline time need `monitoring:alerts`. The nav shows each report only
  for its capability. Filter menus are built from the same scoped query.
- `check-security-invariants.mjs` gains a reports section: every route names its capability, every export is
  throttled, an export is capped, neutralised and audited with `logOrFail` before it returns, and a device
  secret is reported as bound or not, never returned.

#### Not done

- **Scheduled or emailed reports.** There is no outbound mail, and the only outbound channel (alert-notification
  webhooks to destinations a Business Owner approved with a fresh sign-in) is not a safe vehicle for device
  inventories on a timer. Export and send by hand until a delivery mechanism is designed.
- **Availability percentage** (see above) and **trends over time**: scans, agent versions and monitor settings
  are stored as latest value only.

#### Tests

- `apps/api/scripts/e2e-reports.mjs` (new, in `scripts/run-e2e.sh`): its own API from `dist` on port 3221,
  refuses a database whose name lacks `test` or `scratch`. Seeds synthetic businesses A (two sites) and B and
  proves every number against the fixtures, A/B isolation, a Business User's restriction to granted devices
  (including alerts and offline time), a technician's scope, the capability gating per report, a foreign
  business being a 403, and the export audit row and formula neutralisation: 102/102. Mutation-checked against
  `dist`: business-only device scoping (6 failures), business-only alert scoping (2), no audit (2), no
  neutralisation (1) — each caught.
- `e2e-dashboard.mjs` still 53/53 after the shared compliance rule moved into `patching/compliance.ts`.
- `apps/web/scripts/e2e-navigation.mjs` covers the Reports entry: the menu per persona, the tabs per
  capability (a Business User with only `computers:view` sees the two device reports, and a direct visit to an
  alert report says it is not available instead of drawing an empty one), each report page loading, and
  `/reports` opening the first report.
- `docs/API-REFERENCE.md` regenerated (391 routes, matching the runtime table).

### Script library (review only)

#### Added

- **Script library, with review and no way to run anything** (Automation → Script library, `/automation/scripts`;
  `GET|POST /scripts`, `GET /scripts/:id`, `GET /scripts/:id/diff`, `POST /scripts/:id/versions`,
  `GET /scripts/:id/versions/:version`, `POST …/submit`, `POST …/withdraw`, `POST …/review`). PowerShell scripts
  for Windows, **global** (written by a Platform Admin, reviewed by a Platform Admin or an `approvals:review`
  independent reviewer) or **per business** (new capabilities `scripts:author` and `scripts:review`; a technician
  needs them on a grant covering the whole business, because a script is not scoped to a computer). Each version
  is **immutable**: content, its SHA-256, a definition hash over language, target OS, risk and the declared
  parameters (typed, with charset limits), description and author. Editing creates a new draft version; the diff
  compares any two. Review is Draft → In review → Approved or Rejected, both final, with withdraw back to draft.
  An approval names the content hash the reviewer's page showed (`HASH_MISMATCH` otherwise), records it as
  `approvedSha256`, and needs fresh authentication (`assertFresh`, as for approved actions). **SAME_PERSON** is
  refused by user id, so no owner role, Platform Admin flag or technician context makes the author someone else,
  and it covers *contributors*: a version edited from an unapproved one inherits that one's authors, so A writes
  v1, B makes a one-character edit as v2, and A still cannot approve v2. Another business's script and a missing
  one both return 404, whatever business header or body field is sent. Every create, version, submit, withdraw,
  approval, rejection and refused review is audited with hashes and never with content. Design, threat model and
  the eventual execution path are in `docs/script-library.md`.
- **Static checks shown to the reviewer as warnings, never as a verdict**: `Invoke-Expression`, download-and-run,
  `-EncodedCommand`, credential material, disabling Defender, `Set-ExecutionPolicy`, forced and plain restarts,
  event-log tampering, backup and shadow-copy deletion, local admin changes, dynamic code, and hidden Unicode
  (bidirectional overrides, zero-width characters — "Trojan Source"). They flag; they never block, and the page
  says a script with no findings is not thereby safe.
- **Migration `0035_script_library`.** The database enforces what the service does, so a direct write cannot get
  round it: a CHECK that an approved version's approver is neither its author nor a contributor and that
  `approvedSha256` equals `contentSha256`; a trigger that recomputes the content's SHA-256 on insert, makes a
  version's content, hashes, definition, author and contributors unchangeable, allows only the legal status moves,
  and refuses a version inserted as anything but a draft; and a trigger that stops a script moving between
  businesses or scopes.
- **Security invariants §23**: the library imports nothing that creates an action job or reaches an agent, the
  signer or the heartbeat, and nothing outside it imports the library; its route table is exactly the nine routes
  above, with no run, execute, dispatch or approve route here or in any other controller; review checks
  SAME_PERSON, then the hash, then fresh authentication, before it writes; and the immutability trigger covers
  every content and definition column. Each check was confirmed to fail with its guard removed.

**Running a script is not available**, and the page says so: it would run only as a signed action through the
existing two-approval chain, with the signer signing the script's SHA-256 into the plan and the signed agent
verifying it before running it under limits. That agent path has not been validated on real Windows, and the agent
catalog is unchanged.

Tests: `unit-script-library.mjs` (125, in CI) for hashing, validation, contributors, the diff and every static
rule; `e2e-script-library.mjs` (138, own API on port 3231, refuses a database without `test` or `scratch` in its
name, added to `run-e2e.sh`) for isolation, the review lifecycle, every SAME_PERSON route, hash binding, fresh
authentication, the database refusing direct tampering, no action job created, and the audit trail;
`e2e-navigation.mjs` now checks the Automation entry, the notice and that no page offers a Run control.

### Standard Linux agent

#### Added

- **Standard (Linux) agent: heartbeat, inventory and pending updates on Linux.** Until now a Linux computer got
  RustDesk and one registration at install, and nothing after it: no online dot beyond what hbbs could see, no
  inventory, no patch reporting. The Linux installer (`/api/v1/public/install/linux.sh`) now also installs
  `/usr/local/lib/rem0te/rem0te-agent`, a POSIX `sh` script generated by the server
  (`apps/api/src/public/linux-agent.ts`) and embedded in the installer in a quoted heredoc, run every 3 minutes by
  `rem0te-agent.timer` (oneshot, `ProtectSystem=full`, `ProtectHome=read-only`, `NoNewPrivileges`). It
  authenticates with the device secret the installer already generated and the enrolment claim already binds — the
  Windows claim flow, unchanged, no new mechanism and no first-sight binding — kept in `/etc/rem0te-agent.secret`,
  which the installer now forces to `0600 root:root` and the agent refuses to use if it is any looser. Every
  heartbeat reports host name, OS (`/etc/os-release`, read with `sed`, never sourced), uptime and last boot, CPU
  busy share, memory, root filesystem, logged-on users (`who`) and the RustDesk package version; the 6-hourly
  inventory adds kernel, architecture, CPU model, cores and speed, every real filesystem from `df`, and DMI
  (vendor, model, serial, chassis, BIOS) where readable. Pending updates come from `apt list --upgradable` (never
  `apt update`), `dnf -q -C check-update` or `zypper --no-refresh list-updates`, with restart pending from
  `/run/reboot-required`, `needs-restarting -r` or `zypper needs-rebooting`; with none of them the scan is reported
  failed with *"Pending updates unknown"*, never as zero. Shown as **Standard (Linux)** on the device list and the
  workspace, with no Software or Event logs tab; a Linux machine installed before this stays *RustDesk only*.
  `--uninstall` on the installer (`curl … | sudo bash -s -- --uninstall`) removes the timer, the units, the script,
  its config and the secret, and leaves RustDesk. See `docs/inventory.md` ("Linux computers (0.32)") and the new
  column in `docs/capabilities.md`.
- **The Linux agent is read-only, and the console says so.** From a heartbeat response it extracts only command ids
  in a fixed charset and three fixed names (inventory refresh, update scan, and an event-log query it answers with
  "Event logs are Windows-only" so the request closes instead of expiring). Rotations, reinstalls, RustDesk client
  updates, monitor queries, diagnostics and actions are ignored. Rather than let those sit looking accepted, the
  console refuses password rotation, reinstall and event-log queries for a Linux computer
  (`LINUX_AGENT_READ_ONLY`), and a one-click RustDesk client update skips Linux computers. Security invariants §24
  pin all of it to the script's text: no `eval`, `source`, `sh -c`, download or package-changing command, one
  `curl` whose body (carrying the secret) goes through a 0700 temp file and never argv, the response parse, the
  read-only package commands, the secret's mode, and the installer's `0600` and uninstall. Each check was confirmed
  to fail with its guard removed.
- `apps/api/scripts/e2e-linux-agent.mjs` (84 checks, in `scripts/run-e2e.sh`): its own API from `dist` on port
  3241 (`LINUX_API_PORT`), refusing a database without `test` or `scratch` in its name. It fetches the real
  installer, extracts the generated agent, parses it under `sh`, `dash`, `bash --posix` and busybox, and runs it
  unprivileged inside a temp directory (`REM0TE_AGENT_CONF`, `REM0TE_AGENT_SECRET_FILE`, `REM0TE_RUSTDESK_CONFIG`,
  `REM0TE_OS_RELEASE`, `REM0TE_DMI_DIR`, `TMPDIR`) against the host's real `/proc`, `df`, `who` and `apt list`,
  then against stubbed dnf and zypper and a PATH with no package manager. It proves inventory lands, a wrong,
  missing or world-readable secret is refused, one business's agent cannot write into or close commands for
  another's computer, hostile os-release, hostname, `who`, `df`, DMI and package strings arrive reduced and are
  never evaluated, and marker stubs for `rustdesk`, `systemctl`, `apt-get`, `reboot` and friends are never run.
  **Evidence level: integration (real script, real Linux userland, scratch API).** It has not run under systemd,
  as root, or on an installed endpoint.

#### Fixed

- **Device-reported names were stored with control characters.** The heartbeat and claim DTOs bounded hostname,
  platform, OS, agent and RustDesk version by length only, so a machine — or anyone holding its device secret —
  could store a hostname carrying newlines, escape sequences or NULs, which every console view, CSV export and
  audit entry then printed. They now go through `enrollment/device-text.ts` (control characters and whitespace
  runs become one space; empty is "not reported") on heartbeat and claim, for every platform. The Connect `.cmd`
  keeps its own stricter charset on top.
- **A computer that could not answer an automatic collection was asked again every heartbeat.** A failed
  automatic `UPDATE_SCAN` or `INVENTORY_REFRESH` left the scan stale, so the next heartbeat staged another: a
  Windows computer with Windows Update disabled — and now a Linux computer with no supported package manager —
  accumulated ~480 failed rows a day. An automatic collection that came back failed now waits an hour before it is
  staged again; an operator's *Refresh* / *Scan now* is not held back.
- The Linux installer checked for root only after trying to write the device secret, so a non-root run carried on
  without one and registered a computer its agent could never authenticate as. The check now comes first.

### Signed maintenance actions

#### Added

- **Maintenance actions in the signed catalog — simulated only (S evidence).** Four new catalog actions, each on one
  computer, each needing **two distinct passkey approvals on the separate approval signer whatever the computer**
  (high risk everywhere; the portal, the signer and the agent each derive that themselves, so a plan claiming `low`
  is `risk_mismatch` at the signer and `risk_understated` at the agent). None of the Windows calls behind them has
  run on a real computer: the service manager, `shutdown.exe`, `wevtutil.exe` and the RustDesk session count are
  exercised only through `rem0te-action-sim` against a simulated Windows. Production has no approval signer
  installed, so, exactly like the Print Spooler start, these are inert there and the Actions tab says why.
  - **`windows.service.restart@1`** — `{"service": …}` from a fixed allowlist compiled into the agent and repeated in
    the portal: `Spooler`, `wuauserv`, `BITS`, `W32Time`, `WinRM`, `RustDesk`. The agent re-checks the name against
    `^[A-Za-z0-9_]{1,64}$` and its own list, journals *executing*, *stopping* and *starting*, stops it (60 s),
    starts it and checks it is running at 10 and 30 s. A stopped service is only started; a service with running
    dependents fails the stop and nothing else is stopped; the startup type is never changed. Left off on purpose:
    Defender and other security products, the firewall, `lsass`/`SamSs`/`KeyIso`/`VaultSvc`/`Netlogon`, `EventLog`,
    RPC/DCOM, `Dnscache` (Windows 10+ refuses to stop it) and `LanmanWorkstation` (drops open files and mapped
    drives). Restarting `RustDesk` is skipped while a RustDesk session is open.
  - **`windows.reboot.schedule@1`** — `{"delayMinutes": 5…1440}` (whole minutes; the page offers 5 min to 24 h).
    `shutdown.exe /r /t <s> /d p:4:1 /c <fixed warning>`, the warning built only from the time and delay the agent
    computed and the job id it verified; nothing the requester types reaches it. Never immediate. A restart plan's
    signed window is at most 2 hours (portal `WINDOW_TOO_LONG`, signer and agent `bad_window`), because the delay
    counts from delivery and must not land hours after what the approvers had in mind. An already-pending
    restart is left alone (`restart_already_scheduled`). The result says *scheduled for*, never *restarted*.
  - **`windows.reboot.cancel@1`** — no parameters; `shutdown.exe /a`, with its own two approvals. `no_change` when
    nothing was pending. It cancels whatever is pending, including a restart scheduled by someone else.
  - **`windows.logs.collect@1`** — no parameters. Fixed sources: System and Application Critical/Error events from
    the last 24 h (50 each), the agent's action journal, the end of the agent's log, the end of the newest RustDesk
    service log (service profiles only, no links followed). At most 12 KB per source and 40 KB in all. Redacted on
    the computer and **again on receipt** (`actions/logs.ts`: the diagnostics catalog's `redact()` plus a
    `password=`/`token:`/`Authorization: Bearer` rule), then stored in the target's result. Requesting it also needs
    `computers:event_logs` (for a technician, from the same grant as the computer); viewers without it see that
    text was withheld, never the text; a requester who loses it before delivery is canceled at dispatch
    (`requester_lost_capability`). `ACTION_RESULT` audits each source's size, not its text.
- **The remote-session check.** Before scheduling a restart or restarting RustDesk, the agent counts
  `rustdesk.exe --cm` processes (the signal the heartbeat reports). An open session → `not_executed`
  (`remote_session_open`); cannot tell → `not_executed` (`session_state_unknown`). The check runs after every
  verification and the signed pause and before the *executing* journal entry (a new `Precheck` hook), so a
  skipped job changed nothing. Gap, documented: it is made once, when the restart is scheduled, and sees RustDesk
  sessions only — a console or RDP user gets the Windows warning, nothing more.
- **Run action** in the device workspace now offers every direct catalog action: a picker, the one closed choice
  where there is one (service, delay), the action's own acknowledgement, and per-action "not on this agent" when the
  computer's agent does not report it. History rows name the action, show collected logs source by source, and
  reconcile with action-specific choices (`restart_scheduled`, `no_restart_scheduled` added to the reconcile DTO).
- `e2e-maintenance-actions.mjs` (64 checks; its own API on port 3251, refuses a database without `test`/`scratch`
  in its name), added to `scripts/run-e2e.sh`. `rem0te-action-sim` takes `-sessions`, `-stop-fails`, `-events-dir`
  and `-rustdesk-logs`. `unit-approval-signer.mjs` 64 → 79 checks; Go `internal/action` gains `maintenance_test.go`.

#### Changed

- **Security invariants §14 widened, not loosened.** "The agent catalog is Spooler-only" (later "exactly the two
  actions") is now an exact, ordered list of six, the same on the agent and in the portal. New checks: every agent
  entry's `ParamsOK` is one of the known closed forms; the restart allowlist agrees on both sides, is charset-checked
  first and contains no security or core service; the 5-minute delay floor on both sides; every maintenance action
  is `high` and the restart (and RustDesk restart) waits for no open session with "cannot tell" counting as open;
  `Precheck` sits between the signed pause and the *executing* journal and is final; the agent's action package
  runs no process and the Windows side runs only `shutdown.exe` and `wevtutil.exe` from System32; the maintenance
  actions are not offered to ClientSt0r. Each check was confirmed to fail when its guard is removed (24 mutations).
- **ClientSt0r is not offered the maintenance actions.** `capabilities` and action proposals are limited to
  catalog entries marked `integration: true` (the Spooler start and update install); advertising the new ones is a
  ticket-rmm contract change ClientSt0r has not agreed to. A proposal naming one is `ACTION_NOT_IN_CATALOG`.
- The agent journal records the plan's params and the step reached, so an interrupted maintenance job reports how
  far it got (and, for a service restart, the service's state now). No migration.

### Patch policies and installing from the Patches tab

#### Added

- **Automatic patch policies, approved once — fixture-tested only.** Until now every ring of every deployment was
  requested by hand and approved by two people, so "security updates every Saturday night" meant two approvers awake
  every Saturday night.
  - **What a policy is.** A bounded document (`rem0te-patch-policy/1`) naming:
    - one business, and its computers in fixed rings, each bound by enrolled identity (endpoint, RustDesk ID,
      device-secret hash);
    - ring 0, a single canary; later rings of at most 25;
    - the update classes and, optionally, severities it installs, and KBs it never installs;
    - a weekly maintenance window (days, local start and end, IANA time zone, DST-aware, may cross midnight);
    - soak hours and the failure threshold;
    - `reboot: never`;
    - an expiry at most 90 days out.
  - **How it is approved.** Two roster approvers other than its author approve it once, with passkeys, on the
    approval signer's own page (`/approve/policy/<id>`). Customer sign-off applies if the business requires it.
  - **What happens after approval.** The portal's sweep proposes a deployment inside each open window: the canary's
    offered, eligible, policy-allowed updates, at most 20. **The approval signer — not the portal — signs each ring
    plan, only if `evaluatePolicyPlan` accepts it.** That is a pure function shared with the portal
    (`apps/api/src/actions/patch-policy.ts`) and loads no Nest, Prisma or portal module. It checks:
    - every target's identity against the policy;
    - ring order against the signer's own ledger of what it signed (the canary can't be skipped);
    - classes, severities and excluded KBs;
    - that the plan carries the policy's filter;
    - that the window lies inside one occurrence;
    - the expiry and the requester (the policy's author);
    - for every ring after the canary, the previous ring's results, by re-running the same ring gate the portal uses
      (`evaluateRingGate`) — **canary effective**, failure threshold, soak.
  - **Defence on the computer.** Plans carry the filter as a new optional `params.allow`, and the agent applies it to
    Windows Update's own answer (`patch.InstallFiltered`). A mislabelled update is reported `excluded`
    (`classification_not_in_policy`, `severity_not_in_policy`, `kb_excluded_by_policy`), never installed.
  - **The sweep** runs every `PATCH_POLICY_SWEEP_SECONDS` (60). Every attempt is recorded on the policy and audited
    (`PATCH_POLICY_PROPOSED` / `PATCH_POLICY_REFUSED`, deduplicated per window and code). It:
    - proposes once per window, enforced by a unique `(policyId, windowKey)` on `PatchDeployment`;
    - carries an open deployment across windows;
    - leaves a paused one alone;
    - leaves out later-ring computers that aren't ready, each with why;
    - stops on a containment pause;
    - is switched off by `PATCH_POLICY_SWEEP=off`.
  - **Policy pages.** The Patching page lists policies with their next window and last attempt and has a **New
    policy** form. A policy's page shows the approved document, its digest, the approvers, what the signer refused
    and its deployments.
- **Install updates from a computer's Patches tab.**
  - The user picks installable updates, the restart rule (only *never*) and a window, and gives a reason. The request
    becomes a **one-computer deployment** (origin `MANUAL`, a single canary ring) whose plan awaits the usual **two
    approvals** (`POST /endpoints/:id/patches/install`, audited `PATCH_INSTALL_REQUESTED`).
  - It isn't a direct request: `ACTION_NOT_DIRECT` still refuses updates on the Actions tab.
  - When the computer can't be patched there is no button, only the reason and what to do. The reasons are: standard
    agent (switch to the signed channel), not on the published build, no identity, no signed scan, managed by
    WSUS/Intune/WUfB/ConfigMgr, offline, no signer configured, access not including high-impact requests, an earlier
    install pending or uncertain, nothing installable.
- **Production setup runbook** (`docs/patching-setup.md`, in the in-app docs). It sets out the owner's order of work:
  1. publish a signed release;
  2. move computers to the signed channel;
  3. install the signer on a separate host or user;
  4. set `APPROVAL_SIGNER_INTERNAL_URL`;
  5. enrol approvers;
  6. create the first policy.

  It links to `update-signing.md`, `approved-actions.md` and `staged-patching.md` rather than repeating them, and
  states where every key lives: generated and held by the owner, never on the portal host and never in the
  repository.
- **Pre-flight** (`GET /patching/preflight`, Platform Admins; a card on the Patching page). It reports each
  prerequisite as present or missing, from real state only: the served agent target, `approval/keys.json` listing
  the signer's live key id, the signer configured, answering and new enough, roster approver count, computers on the
  signed channel and on the published build, signed scans, and the sweep.
- Signer: `POST /internal/v1/policies`, `GET /internal/v1/policies/:id`, `POST /internal/v1/policies/:id/revoke`,
  `POST /internal/v1/policies/:id/plans`, `GET /internal/v1/capabilities`; CLI `patch-policy list` and
  `patch-policy revoke --id --reason`.

#### Changed

- The ring gate moved from `patching.service.ts` into `actions/patch-policy.ts` (`evaluateRingGate`), so the portal
  and the signer apply one rule. It now also holds a ring whose plan still has targets pending or dispatched.
- A deployment's update class name is the one its classification id means, never the device's own label for it.
- A deployment proposed by a policy can't have a ring requested by hand (`POLICY_DEPLOYMENT`); pause or cancel it,
  or revoke the policy.

#### Security

- **Revocation design: one-way, held by the signer, fail closed.** The portal never asks the signer "is this still
  active?" in a way it could answer for itself.
  - Revoking (fresh sign-in) marks the portal's row `REVOKED` at once, so the sweep stops proposing even if the
    signer is unreachable. It also cancels plans not yet delivered and closes the policy's open deployments, then
    asks the signer to revoke.
  - The sweep keeps asking until the signer confirms (`signerRevokedAt`).
  - The signer's operator can revoke from the CLI too.
  - Either way the signer writes `revocations/<id>.json` with `wx`. It is never rewritten and is merged into the
    policy on every read, so the CLI and the running server can't race each other into un-revoking it. Every later
    plan is refused `policy_revoked`.
  - Already-signed plans stay valid until their window closes. The portal cancels their delivery, but a computer
    holding one can still run it inside its window.
- Creating or revoking a policy needs `assertFresh`. There is no approve, sign, activate or un-revoke route, in the
  portal or in its signer client.
- **Residual risk, stated plainly:** agents don't sign their results. For rings after the canary, the portal relays
  the previous ring's results and scans as evidence. A compromised portal that forges a whole canary success could
  start ring 1 early. It still can't widen the computers, classes, KBs, window or ring order, or keep using a revoked
  or expired policy.
- Invariants **§25**. It checks:
  - no approve or sign route;
  - the signer client can't approve or un-revoke;
  - create and revoke need fresh authentication;
  - the signer evaluates before signing;
  - every refusal code is present;
  - ring order comes from the signer's ledger;
  - revocation is write-once;
  - the pause is consulted on policy routes;
  - the sweep can be switched off and never runs twice at once;
  - one proposal per window;
  - the e2e and docs stacks run with the sweep off;
  - a manual install never passes a policy;
  - a person can't request a ring beside a policy;
  - `ACTION_NOT_DIRECT` holds;
  - `reboot` is `never`.

  §14 now admits `../actions/patch-policy` in the signer and holds `patch-policy.ts` and `posture.ts` to the
  no-Nest/no-Prisma rule. §15's closed-params check covers the optional `allow` and its closed keys.

#### Not done

- **Reboot: deferred.** Policies and manual installs keep `reboot: "never"`. A restart rule needs a full §15 change
  to the agent's closed parameters, plus the window, warning and session rules a restart needs. That is a separate
  increment, not a UI switch. "Restart required" still waits for a person.
- Nothing here has run on a real Windows computer, a real Windows Update service or a real authenticator.

#### Upgrade notes

- **Schema change:** migration `0038_patch_policy_engine` adds:
  - the `PatchPolicy` table and the `PatchPolicyStatus` and `PatchDeploymentOrigin` enums;
  - `origin`, `policyId` and `windowKey` on `PatchDeployment`, with a unique `(policyId, windowKey)`;
  - six `ActivityAction` values.

  Run `prisma migrate deploy`, rsync `prisma/`, and run `npx prisma generate` at the target. No dependency changes.
- **The approval signer must be reinstalled** from `build-approval-signer.mjs` to support policies. Its bundle now
  also carries `actions/patch-policy.js` and `patching/posture.js` (still no Nest or Prisma: `--list`). Existing state
  is kept; the signer adds `policies/` and `revocations/`.
- **Agents need the 0.32 signed build** to accept a plan carrying `allow`. An older agent refuses it as bad params,
  so policies only reach computers on the new build. Manual installs carry no `allow` and work on 0.27+ builds.
- New settings: `PATCH_POLICY_SWEEP` (`off` disables) and `PATCH_POLICY_SWEEP_SECONDS` (default 60). Production has
  no signer and no signed agents, so all of this is inert there until `docs/patching-setup.md` is followed.

#### Verification

- New `apps/api/scripts/unit-patch-policy.mjs` (114 checks, in CI). It covers:
  - every evaluator refusal: computer outside the policy, disallowed class or severity, excluded KB, wider filter,
    outside the window, expired, revoked, ring out of order, canary not effective, altered policy hash, fewer than
    two approvals, wrong requester, retry limit;
  - window arithmetic in UTC, Chicago, Kolkata, Chatham, New York, London and Sydney across both DST changes and
    midnight;
  - the shared ring gate;
  - the signer's policy records: quorum, customer sign-off, rejection, lapse, signature tamper, signing under a
    policy.

  Removing the window check fails 3 of its checks.
- New `apps/api/scripts/e2e-patch-policies.mjs` (75 checks; its own signer on 3262/3263 and API from dist on 3261,
  sweep every 2 s; refuses a database whose name lacks scratch/test or that already holds live policies). It drives
  the portal, the signer and the agent's real decision code against a simulated Windows Update:
  - pre-flight before and after enrolment;
  - no Install button on a standard-agent computer, with the reason;
  - a manual one-computer install through two approvals to effective;
  - policy create (fresh sign-in, bounds refused) and passkey approval;
  - the sweep proposing and the signer auto-signing the canary inside the window, with only the allowed class;
  - the agent installing only that class;
  - signer refusals of a widened ring, a swapped canary, a disallowed class, a wider filter, an out-of-window plan,
    an altered digest, a skipped canary, a duplicate canary, a non-author requester, ring 1 before the canary is
    effective, an expired policy, a revoked policy and a containment pause;
  - an API restart proposing nothing twice;
  - ring 1 auto-signed after the canary is confirmed effective;
  - the deployment completing;
  - revoke reaching the signer and stopping the sweep;
  - audit rows.

  It is added to `scripts/run-e2e.sh`, which now exports `PATCH_POLICY_SWEEP=off` for every other suite and scratch
  API.
- Go: `TestUpdateAllowIsClosedAndOnlyNarrows`, `TestPolicyPlanFilterAppliesWindowsUpdatesOwnAnswer`,
  `TestInstallFilteredOnlyNarrows`. `go test ./...` passes.
- `e2e-staged-patching.mjs` and `e2e-approved-action.mjs` still pass. `docs/API-REFERENCE.md` was regenerated and
  `--check`ed against the runtime route table (389 routes).
- Not tested: anything on real Windows, a real authenticator, or a signer on a separate host.

### Integration notes
- Security invariants are numbered §21 scheduled client updates, §22 reports, §23 script library, §24 Linux agent,
  §25 patch policies, and §26 the 0.31.2 per-computer visibility check (renumbered from 0.31.2's §21); the maintenance actions extend §14 and §15, and patch policies extend §14 (the signer may load
  the pure policy module) and §15 (the optional update filter).
- `scripts/run-e2e.sh` runs every scratch API with `MONITOR_SWEEP=off CLIENT_UPDATE_SWEEP=off PATCH_POLICY_SWEEP=off`.

### Upgrade notes (all of 0.32)
- **Schema change:** migrations `0032_add_device_token_site`, `0033_client_update_policy`, `0034_reports_export_audit`,
  `0035_script_library` and `0038_patch_policy_engine` (0036 and 0037 were reserved and are unused). Take a
  `pg_dump` first, then `prisma migrate deploy`, rsync `apps/api/prisma/` to the target and run `prisma generate`
  there, as `CLAUDE.md` describes.
- No production dependency changed; the target's `node_modules` stays.
- The approval signer is a separate install. A new signer build is needed only once one is installed (production
  has none), for maintenance actions and patch policies.
- New sweeps default **on** and do nothing without configuration: `CLIENT_UPDATE_SWEEP` (needs an enabled client
  update policy) and `PATCH_POLICY_SWEEP` (needs an approved patch policy). Set either to `off` to stop it.

---

## [0.31.2] — 2026-11-11 · *Workbench*

### Security
- **A Business User could read and change, by id, computers in their business that were granted only to
  someone else.** A Business User sees a computer when it is granted to them (a `ComputerAccess` row inside its
  dates) or marked company-wide. The device list, dashboard, map and support-request picker applied that rule
  (`endpointVisibilityWhere`), but `AccessControlService.assertEndpointInScope`, the per-id check behind every
  `:id` route, checked only business scope and technician grants. A Business User who knew or guessed a computer's
  id therefore got it back from routes the list would never have shown it on. The symptom: the computer was
  absent from *Devices*, but `GET /endpoints/:id` returned it in full. With the capabilities a route asks for, the
  same user could also, on that computer:
  - read its details, inventory, last event-log result, patch status, approved-action history, connection
    diagnostics and report, diagnostics-catalog entries, run history and results, notes, who has access
    (`/access`), and the access review;
  - rename or describe it, tag it, add aliases, archive and restore it, queue an inventory refresh and update scan,
    queue an agent reinstall, request a read-only diagnostic (201), add a note, link a Tactical RMM agent, set a
    maintenance window on it, and issue an enrolment token for it;
  - with `users:manage`, grant themselves (or anyone) access, revoke the person it was granted to, and, with
    `computers:edit`, make it company-wide. After that, connecting was genuinely allowed.

  Connecting, the Connect script, launcher tokens, sessions and the password routes were not exposed, because they
  also call `canReachEndpoint`. The password and rotate routes did answer 403 "You have not been given access"
  rather than 404, which confirmed the computer existed. The monitoring view of one computer already called
  `canReachEndpoint` and was not exposed.

  `assertEndpointInScope` now applies the Business User rule. It takes the rule from `endpointVisibilityWhere`
  itself (`count({ where: { AND: [{ id }, endpointVisibilityWhere(actor)] } })`) so the list and the per-id check
  cannot drift apart again, and it answers with the same `404 Computer not found` as an id in another business or
  one that does not exist. Owners, Platform Admins and technicians are unchanged. A company-wide computer needs no
  query. A grant's weekly schedule is still not part of *seeing*, exactly as in the list: a weekday-only grant
  still shows the computer at the weekend, and connecting is still refused by `canReachEndpoint`. No route needed
  a weaker variant. Support requests already choose computers through `endpointVisibilityWhere`, offboarding does not
  use this check, and the access review now needs the same visibility as the computer page it is shown on.
  Because the fix is in the shared check, all 53 call sites are covered. That includes the 0.31 diagnostics-catalog
  routes, which another review found independently.
- **`GET /admin/search` is removed.** It filtered computers by business alone, so a Business User's search returned
  computers granted only to others, with name, hostname, IP address and RustDesk ID. A technician assigned one
  computer got every computer in the business. Nothing in the web app called it. The unused `adminApi.search`
  client is removed too. 0.33's global search replaces it, and that search is built from each list's own rule.
- **Invariant §21** (`scripts/check-security-invariants.mjs`): `assertEndpointInScope` must apply
  `endpointVisibilityWhere` to a Business User with the same NotFound, it must be the only per-computer scope check
  (a weaker variant is a review, not a default), and `/admin/search` must be absent or use
  `endpointVisibilityWhere`. Removing each guard fails the check.

### Tests
- New `apps/api/scripts/e2e-endpoint-visibility.mjs`, added to `scripts/run-e2e.sh`. It runs its own API on 3341.
  The restricted Business User holds every business capability, so only visibility can refuse her. She calls 44
  per-computer routes (reads and writes) on a computer granted only to a colleague. Each route must answer
  `404 Computer not found` and leave the computer unchanged, and the same route on her granted computer is the
  control. It also checks admin search as a Business User and as a one-computer technician. Allowed: company-wide,
  out-of-hours scheduled (seen but not connected to), owner, Platform Admin and technician. Refused: expired grant,
  not-yet-started grant, another business, and a byte-identical answer to a nonexistent id.
- `e2e-business-access.mjs`: its two `/admin/search` checks asserted the old route's results. They now assert that
  it is gone (404).

### Upgrade notes
- API only, plus `docs/` and the regenerated in-app docs bundle. The web change only removes an unused client
  function. No schema or dependency change: rebuild the API, rsync `dist`, copy `version.json` and `CHANGELOG.md`,
  and restart `reboot-remote-api`. Rebuild the web too if you want the docs bundle and the version banner current.
- An integration or script that called `GET /api/v1/admin/search` now gets 404.

### Verification
- `e2e-endpoint-visibility`: **64 passed, 48 failed** against the unfixed build. The failures were all 3 search
  checks, 39 of the 44 routes, the unchanged-computer check, the expired and not-started grants (4), and the
  nonexistent-id comparison. Of those 39 routes, 28 returned or changed data (2xx). The other 11 refused with an
  error other than not-found (400, 403, 500, or "Request not found"), which still confirmed that the computer
  exists. The 5 that already refused were the monitoring view, the Connect script, a catalog action request,
  launcher tokens and Connect.
  **112 passed, 0 failed** after the fix.
- Every suite on a Business User path passes against the fixed build, each API-backed one on a freshly started
  API: device-list 113, business-access 83, full (proof passed), smoke (passed), security-audit 52,
  support-requests 47, offboarding 63, session-mutations 43, credentials 44, presets 113, dashboard 53,
  diagnostics-catalog 70, monitoring 108. The rest of `run-e2e.sh` also passes: security-features 42,
  integration 77, public-api (passed), public-address 43, rollouts 46, sso-passkeys 70, candidate-password
  (passed), security-regression (passed), containment 70, approved-action 76, staged-patching 67,
  signed-updates 46, ticket-workflow 53.
- Two suites asserted the old behaviour and were changed. `e2e-offboarding`: a member with no grant on the computer
  got 403 from the access review, and now gets 404. A new check covers a member who can see the computer but lacks
  `users:view`, which is still 403. `e2e-security-audit` M4: password reveal and set on an ungranted computer now
  return 404, not 403. The `users:manage` check for changing access mode now runs on a computer the editor is
  granted, so that the refusal it tests is the capability and not visibility.
- `pnpm -r lint`, `tsc --noEmit` in both apps, `nest build`, `check-versions.mjs` and the security invariants pass.
  `docs/API-REFERENCE.md` was regenerated (382 routes) and matches the runtime route table.

---

## [0.31.1] — 2026-11-11 · *Workbench*

### Fixed
- **The Linux and macOS installers exited before doing anything.** Both scripts run under `set -euo pipefail`, and
  their first real line generated the device password with `tr -dc … < /dev/urandom | head -c 12`. Once `head` has
  its 12 bytes it exits, `tr` dies of SIGPIPE, `pipefail` makes the pipeline's status 141, and `set -e` ends the
  script on the assignment, silently and with nothing installed. The device-secret line (`head -c 43`) had the same
  flaw. `bash -n` was the only check either script ever had, and it can't see this. All four lines now end
  `|| true` inside the substitution, so the output is kept and the status is ignored. Found while building the
  0.33 macOS agent, whose e2e suite runs the generated script under `pipefail`. **Any Linux or Mac that someone
  tried to enrol with 0.31.0 or earlier got nothing, and needs the installer run again.**
- **The dashboard's device map looked removed.** 0.31.0 moved the map below the tiles behind a small
  *Show device locations* link, and the link started closed, so the map never appeared unless someone found the
  link. Owners reported it as missing. The map now shows by default. *Hide device locations* folds it away, and
  that choice is remembered in the browser (`localStorage` key `dashboard.map`). It is a per-viewer convenience,
  never a permission: when storage is blocked the map simply shows. `docs/setup.md` and
  `docs/technician-guide.md` describe it.

### Upgrade notes
- API and web. No schema or dependency change: rebuild both, rsync `dist` and the web build, copy `version.json`
  and `CHANGELOG.md`, and restart both units.

### Verification
- `pnpm -r lint`, `tsc --noEmit` and both builds pass, and the security invariants and `check-versions.mjs` pass.
- Under `bash -c 'set -euo pipefail; …'`, the old password line exits 141. The fixed lines reach the next statement with
  12- and 43-character values.

---

## [0.31.0] — 2026-11-11 · *Workbench*

The first increment of the RMM overhaul: the technician's screens, reorganised around the work. The plan and the
honest inventory behind it are in `docs/rmm-gap-analysis.md`; the integration with ClientSt0r is tracked in
`INTEGRATION_COORDINATION.md`.

### Added

- **The menu is organised by job:** Dashboard, Devices, Alerts, Patching, Remote Support, and a collapsible
  Settings group that holds the administration (users, audit, businesses, technicians, access, SSO, rollouts,
  security, system status, updates). Pages that belong to one job are tabs of it, so Devices has *All devices*,
  *My devices*, *All assigned*, *Add device* and *Unassigned*, and Remote Support has *Sessions*, *Quick Connect*,
  *Support requests* and *Technician client*. The sidebar and the tabs are drawn from one model
  (`components/layout/nav-model.ts`), so they cannot disagree. Hiding an entry is a convenience; every route still
  checks permissions itself. Page titles now match the menu ("Devices", "Add device", "Technician client"…).
  Automation and Reports are deliberately absent until they exist.
- **Technician dashboard** (`GET /dashboard/overview`): what is broken, who is affected, what needs attention, what
  is being worked on and what to do next, from real data. Online / offline / agent-silent devices, critical alerts
  (maintenance shown apart), site outages, restart pending, patch compliance from stored scans (with its definition,
  coverage and age), failed or uncertain approved-action targets, approvals waiting, live sessions, recent devices,
  and a ranked "work on next" queue where every item says why it is there. Each section reuses the scoping of the
  page it summarises and is absent without that page's capability. Server host health moved to System status; the
  map is behind "Show device locations". Dashboard tiles open the Alerts list already filtered: the Alerts filters
  now follow the URL.
- **Device workspace.** The computer page's header states status (online, offline since…, or reachable through
  RustDesk with a silent agent), business, site and last seen (marked stale past the 10-minute sweep), with an
  attention strip of open alerts, restart pending, pending updates with scan age and agent problems, each linking
  to its tab. Primary actions: Connect, Diagnose, Run action (disabled with the reason when it cannot), Patch, and
  a More menu for view-only, diagnostics report, reinstall and archive — Archive no longer sits beside Connect, and
  each is confirmed. Tabs regrouped: Overview, Monitoring (alerts first), Software, Patches, Event logs,
  Diagnostics, Actions, History (sessions, notes, AI summary, access review). `?tab=` deep-links; old values map
  across.
- **Device list** rebuilt on `GET /endpoints/list`: server-side search and filters (business, site, online, alerts,
  restart pending, agent type, archived), every column sortable, 25–200 per page, online first. Columns: device,
  business, site, OS, health (worst open alert), agent type and version, last seen, logged-in user, CPU/RAM/disk with
  age, pending patches, open alerts, Connect, More. Samples older than 15 minutes and scans older than 36 hours are
  greyed rather than shown as current. Column choice, density and named views are saved in the viewer's browser and
  say so. The always-masked RustDesk ID column is gone (search still matches it). **CSV export** of the filtered
  view (`/endpoints/list/export.csv`): needs View computers, capped at 10,000 rows, formula cells neutralised, and
  audited as `ENDPOINT_LIST_EXPORTED` — written before the file is returned, or the export is refused.
- **Read-only diagnostics catalog** for the standard Windows agent: nine one-click checks — refresh inventory, disk
  space, service health, recent system errors, top processes, network connectivity, DNS resolution, pending updates,
  reboot status. The request carries a catalog key and nothing else; the heartbeat hands `{id, key}` only to an
  authenticated device; `heartbeat.ps1` maps the key to a fixed read-only function and refuses any other; results
  return with the device secret on `POST /enrollment/diagnostic-result`, are re-shaped, redacted and capped at
  32 KB. Lifecycle requested → delivered → running → completed / failed / expired, the requester is re-authorised
  at delivery, there are per-device and per-user limits, and the request and outcome are audited. On the device
  page's Diagnostics tab. See `docs/diagnostics.md`. **Simulated only:** the PowerShell has been parsed by
  PowerShell 7.4 and run under pwsh against stub cmdlets, never on real Windows.
- **Path A of the ClientSt0r integration is proven against ClientSt0r's own code.** `interop-clientst0r.mjs` now
  drives ClientSt0r 3.17.660's `Rem0teProvider` (whoami, connection test, device list and normalisation, the
  business pin, and a second business's key on the same connection, which is refused) against a real rem0te:
  17/17. This is code-level interop with a scratch ClientSt0r, not a test of two deployed applications. Path B
  (ticket-rmm-v1) still has the four gaps recorded in `INTEGRATION_COORDINATION.md`; revision 3 is proposed there
  and awaits ClientSt0r.

### Fixed

- **A Business User saw every computer in their business on `GET /endpoints` and `GET /endpoints/connected`**,
  including `ASSIGNED_USERS` computers granted only to other people. Both scoped by business alone; the newer
  listings already used `acl.endpointVisibilityWhere`. Both now do, AND-ed with the filters. The first attempt at
  this fix still leaked: spreading the search's `OR` into the same object as the visibility rule's `OR` silently
  replaced it. Owners, admins and technicians see what they saw before. The page that lists every device was
  already correct, so the symptom was in pickers and the online-computers list.
- **Tab bars with many tabs and the Users table widened the whole page at tablet width** (found by the new
  navigation test). They now scroll inside their own box.
- **Missing page padding** on Quick Connect, Downloads and Access control.
- **`unit-monitoring.mjs` failed when run under pwsh at certain times of day:** its event fixture used a fixed
  timestamp that drifted out of the two-hour window the check asks for. The fixture is now relative to the clock.
- The product is called Rem0te on `/help` (it still said Reboot Remote).
- **Guide screenshots re-captured for the new menu**, and three whose numbered keys never matched their callouts
  (Devices list, Sessions, Updates) now do. Callout numbers are kept inside the frame instead of losing half to the
  top edge.
- The invariant that view-only is offered only in a technician context followed the button into the workspace's
  More menu; it failed on the old page location and is confirmed to fail again when the gate is removed.

### Removed

- The old device table (`endpoint-table.tsx`) and the unused `endpoint-monitoring.tsx` component.

### Upgrade notes

- **Schema change:** migrations `0030_device_list_export_audit` (an audit action) and `0031_diagnostic_runs` (the
  `DiagnosticRun` table, with CHECK constraints on key and result size). `prisma migrate deploy`, rsync `prisma/`,
  `npx prisma generate` at the target. No dependency changes.
- **Computers get the diagnostics block when their agent is reinstalled.** Until then a requested diagnostic stays
  *Delivered* and expires after 10 minutes, and the page says the agent probably predates 0.31.
- Bookmarks still work: no route moved, only where it sits in the menu.

### Verification

- New: `apps/web/scripts/e2e-navigation.mjs` (Platform Admin, Business Owner, Business User; 1440 and 820 px; light
  and dark — 132 checks; guarded like the capture scripts, §18), `e2e-dashboard.mjs` (53, fails with each scoping
  rule removed), `e2e-device-list.mjs` (113, including Business A / B isolation and the two regressions above, which
  fail on 0.30.1's service), `e2e-diagnostics-catalog.mjs` (70) and `unit-diagnostics-catalog.mjs` (104, in CI).
- Invariants §20 for the diagnostics catalog (19 guard removals confirmed caught).
- `scripts/run-e2e.sh` runs the dashboard, diagnostics-catalog and device-list suites.
- Not tested: anything on a real Windows computer, and the two applications deployed side by side.

## [0.30.1] — 2026-11-10 · *Plumbline*

### Security

- Security hardening.

### Changed

- **Connect asks you to confirm it is you** (step-up) when the launch uses the computer's password, once per
  10 minutes, as revealing the password already did. The password is no longer part of the Connect response.
- **With an authenticator enrolled, step-up needs its code or a passkey**; the password alone is refused. A session
  that began before the authenticator was enrolled must sign in again before revealing a computer's password.
- **Audit entries cannot be changed once written** (migration `0029_audit_insert_only`), not only once sealed.
- **CI runs every end-to-end suite** in a new `e2e` job against a disposable Postgres (`scripts/run-e2e.sh`).

### Fixed

Three bugs that running every suite in sequence on one fresh database turned up:

- **An alert raised before any notification policy existed waited up to an hour after a policy was set.** With no
  policy, the sweep parks an open alert for its hourly recheck; saving a policy cleared the policy cache but left
  the alert parked, so the first notification arrived late. Saving a policy now re-arms open, unsuppressed alerts
  in its scope (the escalation claim still prevents a second send). The monitoring suite's delivery check failed
  roughly one run in two, depending on whether a 2-second sweep landed before the test set its policy; it now
  waits for the alert to be parked first, so it fails every time without the fix.
- **A staged rollout could plan a fleet batch made only of skipped computers.** Skipped computers (non-Windows,
  no device secret, already on target) took a batch slot, and batches followed whatever order the database
  returned. The plan is now ordered by computer name and skipped computers take no slot. Symptom: a rollout
  whose batch 1 "succeeded" without updating anything, and an e2e check that failed on some runs only.
- **`rem0te-audit verify-export --pub` reported every checkpoint written before a checkpoint key was configured**
  as `checkpoint_signature`, so turning signing on left the export failing for good. Unsigned checkpoints anchor
  nothing; they are now counted and shown (as the database check already treated them), and a checkpoint whose
  signature does not verify is still a problem.

### Upgrade notes

- **Schema change:** `prisma migrate deploy`, rsync `prisma/`, `npx prisma generate` at the target. No dependency
  changes.
- **In-app updates now need two settings,** or the About page reports them unavailable:
  `UPDATE_SIGNING_KEY_FINGERPRINT` (the release key's full fingerprint) and `UPDATE_GNUPGHOME` (a keyring used only
  for it). See `docs/setup.md`, "In-app updates are off by default".
- Turning on off-host audit export and signed checkpoints is now written up step by step in `docs/containment.md`.

### Verification

- New: `apps/api/scripts/e2e-credentials.mjs` (44 checks) and `apps/api/scripts/unit-update-signing.mjs` (16, with
  real gpg keys and a signed tag; in CI). Invariants §19 (10 checks), each confirmed to fail when its guard is
  removed.
- `e2e-security-features`, `e2e-presets`, `e2e-full` and `e2e-candidate-password` updated for the new Connect
  behaviour.
- `scripts/run-e2e.sh` also runs 0.30.0's `e2e-ticket-workflow` (with `RELEASE_BIN`), so the CI `e2e` job covers it.
- Regression checks for the three fixes: `e2e-monitoring` (108), `e2e-rollouts` (46) and `unit-audit-chain` (35);
  each new check fails on 0.29.0's build.

## [0.30.0] — 2026-11-10 · *Plumbline*

**Patch status you can trust, and a ticket integration whose contract is pinned down and tested end to end.**

### Added

- **Patch status on every computer's Patches tab.**
  - It leads with the evidence:
    - its source: *Signed agent scan*, *Standard agent scan (read-only)* or *No scan received*;
    - its time and age, marked **fresh**, **stale** (older than 36 hours, which is three missed 12-hour scans) or **unknown**;
    - the last *successful* scan (a signed scan that errored doesn't count);
    - last boot, and online or offline since when.
  - Then what follows from it:
    - restart pending, which is *unknown* rather than *no* when nothing was received;
    - who manages patching: WSUS, Intune/MDM, WUfB policy or ConfigMgr, each with what it means. The standard agent doesn't read update policy, so it shows *Unknown*;
    - the relevant KB numbers;
    - for each update installed by a recent plan, whether a **later scan confirmed** it;
    - whether rem0te can deploy here, and if not, why.
  - Only the `effective` state counts as confirmed: a scan after the install that no longer offers the update, shows no restart pending, and has Windows Update's history recording it. `restart_required` is shown as awaiting confirmation, never as done.
  - `GET /endpoints/:id/patches` returns it as `summary`, built by the pure `patching/summary.ts` from the stored posture, inventory and recent plan targets.
  - The standard agent's results stay read-only. Deploying still needs the signed agent and a fresh signed scan.
- **A redacted patch summary in the linked ticket.**
  - A REBOOT_PENDING alert's contract body carries `patch_summary`, in alert events and in the alert and ticket-link responses. Every other alert carries `null`.
  - It holds:
    - the evidence source, age and freshness, and last boot;
    - `managed_by`, with manager labels;
    - restart pending;
    - pending, confirmed, failed and awaiting-confirmation KB numbers.
  - It never carries update titles, error text, computer identifiers, user names, addresses or registry values.
- **ticket-rmm-v1 revision 2.**
  - `/capabilities` now returns `contract_revision` and `organizations`. For every organization the calling peer is mapped to, it gives the `business_id`, `business_name` and the containment kinds in force.
  - The `(peer, organization_id) → business` binding is now visible to a peer serving several businesses. It's displayed, never accepted: no route takes a business id.
  - New schema: `patch-summary`. Revisions only add fields.
- **Signed examples generated from the real implementation.**
  - `docs/contracts/ticket-rmm-v1/examples/` holds 11 exchanges recorded from a running rem0te by `e2e-ticket-workflow.mjs --write-examples`, signed with fixed-seed TEST-ONLY keys published in `examples/keys/`. They cover both request directions, delegation tokens, response signatures, and job and alert events.
  - `gen-integration-contracts.mjs --check` verifies every signature, `req_sha256` binding and schema, so an example that drifts from the code fails CI.
  - These replace the 0.29 signed-alert fixture and its throwaway key.
- **`e2e-ticket-workflow.mjs`** (53 checks): the real API, worker and approval signer, with a contract-conformant reference peer on loopback. It covers:
  - pairing, and refusal of an HMAC-signed request;
  - ticket analysis returned;
  - two customers with identically named PCs;
  - a revoked technician, an offline endpoint and a paused business (`423 CONTAINED`);
  - an AI suggestion or ticket referral producing only a plan *awaiting approval*, with no approve route, nothing delivered to the device, the catalog enforced and cross-business ids refused;
  - one alert → one ticket → resolved on the same ticket;
  - an API and worker restart with redelivery and no duplicate;
  - the audit trail.
- **`interop-clientst0r.mjs`**: runs ClientSt0r's own code (its Django, processor and `ticket_rmm` modules, on a disposable sqlite) against a real rem0te on a scratch database.
  - Against ClientSt0r 3.17.659 (`a5f8382`), it measured four gaps: HMAC request signing, capabilities shape and tenant pin, callback verification, and job payload shape. Pairing fails at the first.
  - Recorded in `docs/contracts/ticket-rmm-v1/clientst0r-interop.json`, and explained, with what ClientSt0r should consume, in `CLIENTST0R.md`.
- **`docs/capabilities.md`**: what each agent type can do, what needs configuring, and what has been tested on real Windows, simulated, or only with fixtures. It also lists the lab work still outstanding.
- `e2e-staged-patching.mjs` (67 checks, up from 60) gained the summary cases against the agent's real code:
  - standard agent;
  - WSUS, and an Intune update ring;
  - offline with stale evidence;
  - restart required, then restart completed and confirmed;
  - a failed install.
- `unit-patch-summary.mjs` (27 checks) covers the same cases without a database, and runs in CI.

### Changed

- The README no longer says rem0te has "no patch management, software inventory, ticketing or monitoring". It now says which parts of an RMM it does, which agent each needs, and that ClientSt0r cannot pair until it adopts the contract.
- `docs/integration-clientst0r.md`, `staged-patching.md`, `monitoring.md`, the contract README and `/help` describe the patch summary, the business binding and the interop status.

### Not done (needs a lab)

- Real Windows 11 and Server 2022 runs of the five patch cases. The "Real Windows" column in `docs/capabilities.md` stays **No** until then.
- A real authenticator on the approval roster.
- ClientSt0r paired after it adopts revision 2.

## [0.29.1] — 2026-11-10 · *Lighthouse*

### Fixed

- **A computer's Patches tab showed nothing unless it ran the signed agent.**
  - **Symptom:** every production computer showed only *"This computer's agent does not report Windows Update posture.
    It needs the signed agent (update channel `signed`) from 0.27 or later"*. Production runs the `legacy_allowed`
    channel, so no computer has the signed agent, and the tab was a dead end on all of them.
  - **Cause:** the tab only read the signed agent's `patch-scan` posture. But every agent already answers the
    inventory's `UPDATE_SCAN`, every 12 hours and on **Scan now**, with the offered updates (title, KB, severity, size)
    and the reboot flag. That data was stored and never shown there.
  - **Fix:** `GET /endpoints/:id/patches` returns it as `basic` when no signed posture exists. The tab shows it with a
    working **Scan now** that polls for the result, and says that *installing* through a deployment needs the signed
    agent.
  - `e2e-staged-patching` gained a check for this (60 passed).
  - Nothing about installing changes. `basic` is read-only and never feeds a deployment, whose eligibility checks need
    the signed scan's update ids, classifications and manager detection.

## [0.29.0] — 2026-11-10 · *Lighthouse*

**Monitoring and alerts: know when a computer needs a person, once per problem, and tell the right people.**
Monitors cover:
- a computer offline;
- a system disk nearly full;
- processor or memory pinned;
- a Windows service stopped;
- matching events in an event log;
- a restart pending for days.

They are inherited global → business → site → computer. Alerts are deduplicated in the database. A site losing most
of its computers raises one **site outage** instead of a page per machine. **Maintenance windows** hold
notifications, and are deliberately not containment. Up to four **escalation** levels notify webhooks, and alerts
can be offered to **ClientSt0r**, which links back its ticket. Inventory gains **installed software** and a
**change history**. Also in this release:
- **Settings → API keys**, a screen that didn't exist; `PUBLIC-API.md` described one anyway;
- a reorganised **documentation viewer**;
- **annotated screenshots** of the main screens.

**Status: fixture-tested.** Every monitoring path is covered against a scratch database and a simulated agent and
ClientSt0r. The agent's monitor and software collection has run under pwsh against stubs, **not on real Windows**.
Alert events have not been exchanged with a real ClientSt0r. Nothing monitors until monitors exist: install
leaves the set empty, and **Add recommended** is one click.

### Added

- **Monitors** (`apps/api/src/monitoring/`, migration `0028_monitoring`).
  - **Models:**
    - `MonitorRule`: a scope key (`global`, `b:<business>`, `s:<site>` or `e:<computer>`), a key, a kind, a
      severity and parameters.
    - Kinds: `OFFLINE`, `DISK_FREE`, `CPU_HIGH`, `MEMORY_HIGH`, `SERVICE_STOPPED`, `EVENT_MATCH` and
      `REBOOT_PENDING`.
    - Parameters are validated per kind with zod (`engine.ts` `PARAMS`).
  - **Inheritance:** for each key the most specific rule wins. A disabled rule switches the inherited one off at its
    scope. A computer's page shows the rules in effect and where each came from.
  - **Event-log monitors** must name ids, levels or a provider, on System, Application, Security or Setup.
    A monitor on every event in a log is refused (`INVALID_PARAMS`).
  - **Recommended set:** offline, disk free, CPU, memory, restart pending, and disk errors (System 7, 11, 51, 153).
    It is created only when someone clicks **Add recommended**, and each one is an ordinary audited rule.
  - **Limits:** at most 64 rules per scope, 32 services and 8 event queries per computer.
- **The agent's part** (`public/windows-script.ts`), only on authenticated heartbeats.
  - The heartbeat response gains `monitor: {v:1, services, events}`.
  - The agent reads those services (`Get-Service`, names checked against `^[A-Za-z0-9_.-]{1,64}$`) and runs those
    event queries (`Get-WinEvent`, allowed logs only, `MaxEvents 100`, one sample truncated to 300 characters,
    `since` echoed from its own previous report). It POSTs one report to
    `POST /enrollment/monitor-report`, which needs the device secret, is rate limited (30) and keeps only the
    services and keys it asked for (`sanitizeReport`).
  - The block reads and counts; it changes nothing.
- **Alerts** (`MonitorAlert`, `MonitorAlertEvent`, `EndpointMonitorState`).
  - **One open alert per problem:** a partial unique index on `dedupKey` where state ≠ `RESOLVED`. A repeat raises
    `occurrences` and `lastSeenAt`. A lost race (P2002) is retried as a repeat.
  - **Clearing:** live monitors clear after two good samples, and event monitors after `clearAfterMinutes` quiet.
    Offline clears when the computer reports. Resolving by hand needs a note.
  - **Sweep:** every 60 s (`MONITOR_SWEEP_SECONDS`, off with `MONITOR_SWEEP=off`). It runs offline and
    restart-pending evaluation, event clearing, orphan clean-up, outage correlation, then notification. Two API
    processes are safe: creation loses on the index, and each notification level is claimed by compare-and-set on
    `escalationLevel` before it is sent.
  - **Offline hold:** offline alerts wait 3 minutes before notifying (`MONITOR_OFFLINE_HOLD_SECONDS`), so a
    restart pages nobody.
  - **Site outage:** at a site with at least 3 computers, 3 or more offline that are at least half of it raise one
    critical `SITE_OUTAGE` and group the offline alerts under it. The grouped ones aren't notified on their own
    while it is open. It clears below a quarter, or below 2. Resolving it lets the alerts still open be notified
    normally.
- **Maintenance windows** (`MonitorSuppression`).
  - Scoped to a business, or global, optionally to some monitor keys. At most 14 days long, starting at most 90
    days ahead.
  - **Alerts are still raised and shown**, marked *maintenance*. Notification and ClientSt0r's `alert.raised` are
    held until the window ends, and only sent if the alert is still open. Ending a window early releases them at
    once.
  - **Never touches `ContainmentPause` or `SecurityAlert`** (invariant §17). Containment in turn leaves monitoring
    running.
- **Notifications** (`MonitorNotifyPolicy`).
  - **Levels:** up to four, each with `afterMinutes`, a minimum severity and up to five destinations. Each
    destination gets a JSON POST, with a 5 s timeout and no redirects, through `validatePeerUrl`.
  - **Which policy:** a business's own policy if it has one, otherwise the global one.
  - **Escalation:** acknowledging stops it. Resolving tells every level that was notified.
  - **Who may change it:** a Business Owner of that business or the MSP, always with **fresh authentication**
    (`assertFresh`).
  - **Business destinations** must be https on a public host name: no IP literals, `localhost` or internal
    suffixes. The audit log records hosts only, because a webhook path is often its secret. People who can't
    change the policy see shortened URLs.
- **ClientSt0r alert events** (contract ticket-rmm-v1, `features.alerts: true`).
  - **Opt-in:** *Offer alerts to ClientSt0r* in the notification policy, with a severity floor.
  - **Events:** `alert.raised`, then `alert.updated` / `alert.resolved` only after a raise.
    - Sequenced per (peer, organization) through `IntegrationOrgMapping.lastAlertSequence`.
    - Signed over `rem0te-alert-event-v1\n…`, a different prefix from job events.
    - Pushed by the worker to the peer's `eventsUrl` with the existing retry.
  - **Routes:**
    - `GET /api/integration/v1/alerts/events?organization_id=&after=`;
    - `GET /api/integration/v1/alerts/:alert_id`;
    - `POST /api/integration/v1/alerts/:alert_id/ticket`. It is idempotent for the same ticket; a different one is
      `409 TICKET_ALREADY_LINKED`.
    - Service-signed only: no delegation, nothing reaches a computer, and linking grants nothing.
  - New schemas `alert`, `alert-event`, `signed-alert-event` and `alert-ticket-link`, with fixtures. The signed one
    verifies against `fixture-alert-signing-key.pub.pem`.
- **Software inventory and change history** (`EndpointChange`, `EndpointInventory.software`).
  - **Software:** the agent reads the 64- and 32-bit uninstall keys, skipping system components, child entries and
    updates (600 at most). The server keeps 500.
  - **Change history:** each inventory is diffed with the previous one for hardware, OS, disks, network adapters
    and software (`diffInventory`). The first pass is the baseline. A list the agent didn't report isn't compared,
    so upgrading an agent doesn't log every program as new.
- **Permissions:** `monitoring:alerts` (see alerts) and `monitoring:configure`. Presets that allow inventory viewing
  also grant `monitoring:alerts`.
  - A Business User sees computer alerts only for computers they can see, and never a site outage.
  - A technician sees alerts within the computers their grant names.
  - Global monitors and windows are the MSP's: a Platform Admin, or a technician manager outside a technician
    context.
- **Routes** under `/monitoring`:
  - `summary`;
  - alerts: list, one, `acknowledge`, `resolve`;
  - rules: CRUD and `recommended`;
  - `suppressions` and their `revoke`;
  - `notify-policy`;
  - `endpoints/:id`.

  Audited as `MONITOR_RULE_CHANGED`, `MONITOR_SUPPRESSION_CHANGED`, `MONITOR_NOTIFY_POLICY_CHANGED`,
  `MONITOR_ALERT_ACKNOWLEDGED`, `MONITOR_ALERT_RESOLVED` and `MONITOR_ALERT_TICKET_LINKED`.
- **Web:**
  - **Alerts** in the sidebar: totals, filters, and an expandable alert with its history, grouped computers,
    ticket, acknowledge and resolve.
  - **Settings → Monitoring:** monitors with inheritance and *Switch off for this business*, maintenance windows,
    and notifications.
  - A **Monitoring** tab on every computer, reachable with `?tab=` on the computer page.
  - **Settings → Monitoring & API** cards.
  - A *Monitoring* feature on Security Features.
- **Settings → API keys** (`/settings/api-keys`). Until now there was no screen: keys could only be created with
  `POST /api/v1/apikeys`, while `PUBLIC-API.md` sent people to an "Administration → API Keys" page that never
  existed. The page lists keys (prefix, scopes, last use, expiry) and creates one with scopes and an expiry,
  showing the key once with a Copy button. It revokes with a confirmation. Platform Admins pick the business.
- **Documentation viewer** (`/docs`).
  - A **grouped index** landing page with a line on each page. Groups and summaries live in `gen-docs-bundle.mjs`
    `ORDER`, and a group not in `GROUPS` fails the build.
  - A grouped sidebar, with an *All pages* button below a wide screen.
  - **On this page**, which follows the scroll, plus reading time and previous / next links.
  - Heading anchors, with **heading ids de-duplicated per page**. A second "Setup" used to share the first one's id,
    so its contents link went to the wrong place.
  - Search highlights matches, opens with <kbd>/</kbd>, and moves with ↑ ↓ Enter Esc. It searches 4,000 characters
    of each section, up from 1,200, so late paragraphs are findable.
  - Images are figures with captions that open full size, and wide tables scroll in their own box.
- **Annotated screenshots** of the alerts page, monitoring settings, notifications, a computer's Monitoring tab,
  API keys, and the documentation index, search and pages. Each is followed by a numbered key. They are generated
  by `screenshots.mjs` against the docs stack, with new demo data in `prisma/_docs-demo-monitoring.ts`.
- New page `docs/monitoring.md`. Updated: inventory, containment (*a maintenance window is not containment*),
  integration-clientst0r, the contract README and OpenAPI, PUBLIC-API, troubleshooting, README, `/help`, and
  screenshots.md.

### Fixed

- **`screenshots.mjs` had no production guard and defaulted to port 3000**, the production web port. It seeds a
  user and rewrites relay settings for the run, then restores them. It now refuses https, ports 3000 and 443, and
  any database but `reboot_remote_docs`, like the other capture scripts. Invariant §18 checks all three.
  Masking moved to a shared `capture-masks.mjs`, and it now also masks `rk_` API keys.
- **`rem0te-audit verify-export` could hide a bad checkpoint signature.** It printed the first 20 problems in seq
  order, so on a log with more than 20 deletions, a signature that didn't verify fell into "… and N more". That is
  the one finding that says the copy itself can't be trusted. Checkpoint problems are now listed first, and the
  overflow line counts each kind. `e2e-containment` caught it on the scratch database.
- `containment.md` said alert suppression wasn't built. It is now, as maintenance windows, documented as separate
  from containment.

### Verification

- `apps/api/scripts/unit-monitoring.mjs`:
  - 91 checks: engine, inheritance, evaluators, outage decisions, escalation timing, the inventory diff, and the
    software and report sanitisers;
  - plus 9 with `PWSH` set, which run the agent's monitor block under pwsh against stubbed `Get-Service`,
    `Get-WinEvent` and `Invoke-RestMethod`.
- `apps/api/scripts/e2e-monitoring.mjs`: 107 checks against a scratch API, with a webhook receiver and a stand-in
  ClientSt0r events endpoint.
- Invariants §17 (12 checks) and §18 (4). The new §17 service-name check was confirmed to fail when its guard was
  removed, and §18's when a guard was weakened.
- Migration `0028_monitoring` applied to an empty database and to the scratch database.
- Both generated Windows scripts parse under pwsh.
- The full regression set was re-run against the scratch database, and all suites pass:
  - containment 70, presets 112, approved-action 76, staged-patching 59, integration 77, security-features 37,
    signed-updates 46, business-access 83, offboarding 62, security-audit 52, session-mutations 43,
    support-requests 47, public-address 43, rollouts 45, sso-passkeys 70;
  - smoke, full, public-api, candidate-password and security-regression.
- `presets` needed its capability lists to include `monitoring:alerts`. `containment` needed the `rem0te-audit` ordering fix above.

### Upgrade notes

- **Schema change:** run `prisma migrate deploy`, rsync `prisma/` and run `npx prisma generate` at the target.
- **No dependency changes.**
- Nothing monitors until monitors exist. Open **Settings → Monitoring** and **Add recommended**, then set
  **Notifications**.
- Agents report software and run monitor queries from their next heartbeat after the 0.29 script reaches them.
  Re-run the installer, or let the agent update.

## [0.28.0] — 2026-11-10 · *Bulkhead*

**Containment and evidence: stop writes during an incident, in three places that don't trust each other, and
keep an audit log that shows if it was tampered with.** A **global write pause**, or a **suspension of one
business**, stops four kinds of write:
- approved actions, including plans already approved;
- remote connections;
- agent update instructions;
- ClientSt0r jobs.

The portal enforces it on every write path. The **approval signer** keeps its own copy, which the portal can add
but never lift. A **signed `control/pause.json`**, published from the release machine, makes the agents refuse
whatever a compromised portal delivers. The audit log is **hash-chained** and guarded by a database trigger. It is
verified hourly and can be streamed off the host with signed checkpoints, and `rem0te-audit verify --export`
compares the two copies.

**Status: fixture-tested.** The portal pause and the audit chain are active as soon as 0.28 is installed. The
signer layer needs the 0.28 signer build. The agent layer needs a 0.28 signed agent build published through the
offline chain. No real Windows agent has refused under a signed pause yet. Alert suppression during an incident is
**not built**: it belongs with monitoring and is deferred to that milestone. See *What has been proven* in
`docs/containment.md`.

### Added

- **Containment in the portal** (`apps/api/src/containment/`, migration `0027_containment_audit_chain`).
  - `ContainmentPause`: a global or business scope, the kinds (`actions`, `remote`, `updates`, `integration`), a
    reason, who set it and as whom (`msp` / `customer`), the signer's answer, and when, by whom and why it was
    lifted.
  - **Rules:**
    - a global pause is set by a Platform Admin or a technician manager (not in a technician context);
    - a business pause is set by them or by a Business Owner of that business;
    - **a business's own suspension is lifted only by an owner of that business**, and the MSP can't lift it
      (`CUSTOMER_SUSPENSION`);
    - an MSP pause is lifted only by someone other than whoever set it (`SAME_PERSON`), and an owner can't lift it
      (`MSP_SUSPENSION`);
    - setting needs no step-up, lifting always does (`assertFresh`);
    - technicians can't see or change containment.
  - **Enforcement.** Every check comes *after* access, so outsiders aren't told a business is suspended.
    - **Actions:** `evaluateAction` refuses with `403 CONTAINED`. That covers requests, ClientSt0r proposals,
      patch deployments and rings, and the dispatch recheck, which maps it to `contained` rather than
      `requester_no_longer_authorized`.
    - **Approved plans:** `forHeartbeat` **holds** them. Pending targets aren't delivered and nothing is
      re-delivered. They aren't canceled, and the result deadline still runs.
    - **Connections:** `evaluateLaunch` refuses every connection: Connect, connection grants, launcher issue and
      redeem.
    - **Quick Connect:** `admitLaunch` refuses.
    - **Updates:** the heartbeat withholds `updateRustdesk` and `reinstallAgent`. **It checks before
      `reinstallDispatchedAt` is written**, so a held reinstall is never recorded as sent. Rollout dispatch is
      deferred with reason `contained`, like a closed maintenance window. Evidence for jobs already in flight is
      still recorded.
    - **ClientSt0r:** submit answers `423 CONTAINED`, and the worker ends a queued job `FAILED`/`CONTAINED`.
  - **Routes:** `GET /containment`, `GET /containment/banner`, `POST /containment/pauses` and
    `POST /containment/pauses/:id/clear`. Every set and lift is audited (`CONTAINMENT_PAUSED`,
    `CONTAINMENT_CLEARED`).
- **The approval signer's copy** (`approval-signer/store.ts`, `server.ts`, `main.ts`).
  - Pauses are files in `pauses/`.
  - `GET`/`POST /internal/v1/pauses` let the portal **list and add** them. There is no route that lifts one.
  - While one applies, the signer refuses:
    - plan submission (`paused`);
    - the public challenge and decide routes;
    - and, checked again just before it records, a decision that was already in progress.
  - CLI: `pause list | set --global|--business <id> --reason | clear --id --reason`.
  - The portal sends any pause covering actions automatically, and records `held as <id>`, `refused: …` or
    `unreachable`. Its own pause holds either way.
- **The signed pause on the agent** (`internal/action/pause.go`, `action.go`, `internal/agent/agent.go`).
  - **Format:** `control/pause.json` (`rem0te-pause/1`), parsed strictly: unknown fields, trailing data, a bad id or
    a reason over 300 are refused. `updates` is all-or-nothing, because the update command runs before the agent
    knows its business.
  - **Actions:** a covered business or RustDesk ID refuses an approved action with `paused`, after signature
    verification and before the *executing* journal entry. Like every refusal it is final.
  - **Updates:** the update command is refused (`ErrRefuse`) before anything is fetched.
  - **Fail closed:** a pause that is listed but can't be fetched or parsed, or whose state directory can't be
    secured, counts as pausing everything.
  - **Tooling:** `rem0te-release pause-file` writes one (`-actions`, `-updates`, `-business`, `-computer`, `-none`),
    and `release` validates any `control/pause.json` it is given. `rem0te-action-sim` takes `-pause`.
- **Tamper-evident audit log** (`apps/api/src/audit/chain.ts`, `audit-chain.service.ts`).
  - **Columns:** `ActivityLog` gains `seq` (BIGINT), `chainHash`, `sealedRefs`, `chainGap` and `sealedAt`. Existing
    rows are numbered by `(createdAt, id)` in the migration, not in physical order.
  - **Sealing:** every 5 s, under advisory lock 728001, `hash(n) = sha256(hash(n-1) + "\n" + canonical(entry))`.
    The entry covers seq, id, time, action, IP, agent, resource, metadata and the tenant, business and user ids.
    A sequence number that never committed is declared in the next entry after 30 s, so any other gap is a
    deletion.
  - **Trigger:** `rem0te_audit_sealed_guard` refuses any UPDATE of a sealed row, except setting `tenantId`,
    `customerId` or `actorId` to NULL (deleting a business or user). Deletes are detected, not prevented.
  - **Verify:** at start (+20 s), hourly, and on demand (`POST /audit/integrity/verify`). It reports `altered`,
    `deleted`, `reference_changed`, `unsealed_in_chain`, `checkpoint_mismatch` and `checkpoint_signature`. On the
    transition to broken, the API logs `AUDIT CHAIN BROKEN` and writes `AUDIT_CHAIN_ALERT`.
  - **Export:** NDJSON (`rem0te-audit-export/1`) to `AUDIT_EXPORT_FILE` and/or `AUDIT_EXPORT_URL` (HTTPS or
    loopback, bearer `AUDIT_EXPORT_TOKEN`, redirects refused). The export position doesn't advance on a failure,
    so a sink must accept a repeated line.
  - **Checkpoints:** every `AUDIT_CHECKPOINT_INTERVAL_SECONDS` (900), Ed25519-signed with
    `AUDIT_CHECKPOINT_KEY_FILE` when set. `AUDIT_SEALER=off` disables sealing in that process.
  - `GET /audit/integrity` is for Platform Admins and technician managers.
- **`rem0te-audit` CLI** (`dist/cli/rem0te-audit.js`, needs no running API):
  - `verify [--export FILE] [--pub KEY]` compares the database chain against an off-host export entry by entry,
    which is what catches a full rewrite;
  - `verify-export FILE` needs no database;
  - `keygen --out FILE`;
  - `containment list | clear --id --reason [--yes]` is the host escape hatch, audited.

  Exit status: 0 intact, 1 problem, 2 usage.
- **`/api/v1/healthz`** answers `{"status":"ok"}` (503 if the database is down) and nothing more. With
  `x-rem0te-health-token` equal to `HEALTH_TOKEN` (24+ characters, compared in constant time), it adds:
  - the version and the database;
  - whether the signer answers;
  - seal, export and verify lags and the verify result;
  - containment counts.

  It carries no names, ids or addresses, and answers in maintenance mode.
- **`deploy/scripts/rem0te-external-check.py`**: standard library only, for a machine other than the portal host. It
  checks:
  - the portal's healthz detail;
  - the audit lags and verify result;
  - that the signer and hbbs (TCP) answer.

  It exits non-zero on any problem.
- **Web:**
  - Settings → Security → **Containment**: active pauses and lifting them, setting one, the signer's copy, recent
    history, and an audit-integrity card with *Verify now*;
  - a red banner on every page while a pause applies to you;
  - a Containment card on the Settings security tab.
- **Security Features:** a *Containment* row and a *Tamper-evident audit log* row, both partial, with effective
  state (active pauses; the last verify, the sealed head, export and signing).
- **Security invariants §16:**
  - no signer route lifts a pause;
  - the signer refuses while paused;
  - lifting needs step-up;
  - the customer and second-person rules hold;
  - every write path consults containment;
  - the agent checks the pause before journaling *executing*;
  - a listed pause fails closed;
  - the pause is parsed strictly;
  - the trigger is in 0027;
  - healthz gives no detail without its token;
  - `chain.ts` loads no Nest or Prisma.
- **Docs:** `docs/containment.md` and `docs/incident-recovery.md` (both new, in the in-app bundle), with updates to
  `update-signing.md` (publishing a signed pause), `approved-actions.md` (`CONTAINED`, `paused`),
  `integration-clientst0r.md` and the ticket-rmm-v1 contract README (`CONTAINED` 423), `security-model.md`,
  `README.md`, `/help` and `CLAUDE.md`.

### Changed

- `BigInt.prototype.toJSON` returns the decimal string (`src/common/bigint-json.ts`), imported first by the API
  and the integration worker. Without it, every route returning audit rows would throw `Do not know how to
  serialize a BigInt` once `seq` exists. Scripts that `JSON.stringify` raw Prisma audit rows need a replacer.
  `e2e-presets` got one.
- A `ForbiddenException` with code `CONTAINED` is a new answer from action, connect and Quick Connect routes.

### Tests

- **`e2e-containment.mjs`**, 70 checks, against a scratch database, the signer and `rem0te-action-sim`. It covers:
  - every rule above;
  - each write path blocked for Acme while Birch carries on;
  - a held reinstall not recorded as sent;
  - the signer refusing after the portal pause is lifted, until its CLI clears it;
  - an approved plan held and then delivered;
  - the agent refusing under a signed pause fetched through the mirror, final from the journal;
  - a malformed pause refused at release time;
  - sealing, the trigger (an edit refused, a reference repointed refused, a reference nulled allowed);
  - a deletion detected in the database and against the export;
  - signed checkpoints, and the wrong key detected;
  - the host CLI dry run and `--yes`;
  - `/healthz` with no token, the wrong token and the right one.

  **It deletes one audit row on purpose**, so the scratch chain reports that deletion afterwards.
- **`unit-audit-chain.mjs`**, 33 checks: canonical JSON, every tamper kind, declared versus forged gaps, nulled
  versus changed references, checkpoint signatures, the export checker (mid-chain start, repeated lines, dropped and
  edited lines), and a full database rewrite still differing from the export.
- **Go:** `internal/action/pause_test.go` (strict parsing; refused for a business, a computer and all; final;
  checked after the signature) and `internal/agent` (an update refused under a signed pause, run again once lifted,
  and an unreadable pause failing closed).
- **Unchanged suites still pass:**
  - `e2e-approved-action` (76), `e2e-staged-patching` (59), `e2e-integration` (77), `e2e-presets` (112);
  - `e2e-security-features` (37, now requiring the two new rows), `e2e-signed-updates` (46), `e2e-rollouts` (45);
  - `e2e-business-access` (83), `e2e-offboarding` (62), `e2e-public-address` (43), `e2e-security-audit` (52);
  - `e2e-session-mutations` (43), `e2e-support-requests` (47), `e2e-sso-passkeys` (70), `e2e-candidate-password`, `e2e-full`,
    `e2e-public-api`, `e2e-smoke`, `security-regression`;
  - `unit-approval-signer` (65), `unit-integration` (35), `unit-presets` (26), `unit-session-mutations` (30),
    `unit-signed-installer` (51).
- **Test fixes:**
  - `unit-presets` constructs the access policy with a containment stub.
  - `e2e-sso-passkeys`' "listed without key material" excludes `approvalExport`, which has deliberately carried
    the passkey's *public* key since 0.26.
- `docs/API-REFERENCE.md` was regenerated and checked against the runtime route table: 355 routes.

### Deploy

**This is a schema change.**
- Take a dump first.
- Apply `0027_containment_audit_chain`. It numbers existing audit rows and installs the trigger. The API seals
  them after it starts, 500 per pass every 5 s.
- rsync `prisma/`, run `prisma generate` at the target, then chown, as in CLAUDE.md.
- No production npm dependency moved.

New optional settings in `/etc/reboot-remote/api.env`:
- `HEALTH_TOKEN`;
- `AUDIT_EXPORT_FILE` / `AUDIT_EXPORT_URL` / `AUDIT_EXPORT_TOKEN`;
- `AUDIT_CHECKPOINT_KEY_FILE` (create it with `node dist/cli/rem0te-audit.js keygen --out …` and keep the printed
  public key off the host);
- `AUDIT_CHECKPOINT_INTERVAL_SECONDS`, `AUDIT_SEALER`.

The approval signer's pause routes need the 0.28 signer build. An older signer answers 404, which the portal records
as `refused`. The agent layer needs a 0.28 signed agent published.

---

## [0.27.0] — 2026-11-10 · *Bellwether*

**Staged Windows patching: install named Windows updates on a canary, then on rings, each ring one signed plan
that two people on the approval roster authorize with a passkey.** A ring can't be requested until the canary
reports every update *effective* (no longer offered, recorded in Windows' own history, no restart pending), the
ring before it is within its failure threshold, and its soak time has passed. Over the threshold, the deployment
pauses itself. The computer decides what to install from Windows Update's own answer, never from the plan's
titles. It refuses outright when WSUS, Windows Update for Business policy, MDM or Configuration Manager manages
it, and it never restarts.

**Status: fixture-tested.** The agent's real decision code ran against a simulated Windows Update and registry.
The Windows Update script is parsed by PowerShell but hasn't run against a real Windows Update service. See *What
has been proven* in `docs/staged-patching.md`.

### Added

- **A second catalog action, `windows.update.install@1`** (`apps/api/src/actions/catalog.ts`,
  `tools/windows-installer/internal/action/catalog.go`, `updates.go`).
  - **Parameters are closed:** exactly `{"updates":[{"updateId","revision"}…], "reboot":"never"}`, 1–20 unique
    identities. There's no KB, title, URL or file in the parameters.
  - **Always high impact:** two distinct approvers, whatever the device, and never the requester.
  - **Rings:** a plan may name up to 25 computers (the Spooler action stays at one). The agent checks that it is
    one of them, by RustDesk ID and secret hash, and that no RustDesk or endpoint ID appears twice.
  - **Not direct:** `POST /endpoints/:id/actions` refuses it (`400 ACTION_NOT_DIRECT`). Updates go through a
    deployment.
- **Windows Update on the agent** (`internal/patch`, `patch_windows.go`).
  - A fixed `wua.ps1` is compiled into the signed agent and run by Windows PowerShell 5.1 with
    `-NoProfile -NonInteractive -ExecutionPolicy Bypass`, with three modes:
    - **scan** reports offered updates and history;
    - **lookup** asks about the named identities, including superseded ones;
    - **install** downloads, then installs with `ForceQuiet`.
  - **It never** calls `AcceptEula`, restarts, or runs downloaded text. Scans time out after 15 minutes, installs
    after 4 hours.
  - **Eligibility, decided on the computer:**
    - only Security Updates, Critical Updates, Update Rollups and Updates;
    - never drivers, upgrades, feature packs, service packs, tools or definitions;
    - never `BrowseOnly`, user-input or unaccepted-EULA updates.
  - **Strict parsing:** the parsers refuse script answers about identities nobody asked for.
  - **Other update managers**, read from the registry: WSUS (`WUServer` plus `UseWUServer=1`), WUfB policy values,
    `PolicyManager\current\device\Update`, and the `CcmExec` service. If any is present, the whole plan is refused
    with `managed_elsewhere`, before anything else is checked.
  - **Pending restart**, from four sources: component servicing, Windows Update, `PendingFileRenameOperations`,
    and the update agent's own answer.
  - **Per-update outcome:**
    - `installed`, `restart_required` or `already_installed`;
    - `superseded`, `not_offered` or `excluded`;
    - `failed`, with Windows' HRESULT;
    - `unknown` (a script crash is never `failed`) or `not_attempted`.
  - **Overall outcome:** `succeeded`, `restart_required`, `no_change`, `partial`, `failed` or `uncertain`.
- **Detached execution, with locks** (`internal/flock`).
  - The signed installer's heartbeat hook now starts `rem0te-agent.exe action` detached, so a long download
    doesn't hold up the heartbeat.
  - **Per-job lock:** a re-delivery while the job runs is answered `in_progress`. Nothing is journaled or reported.
  - **Windows Update lock:** a scan and an install never run together. The install waits up to 20 minutes, then
    refuses `update_agent_busy`.
  - **Journal:** as for 0.26, it is written before installing. A re-delivered plan is answered from it, and
    Windows Update isn't asked again.
  - The envelope file is removed only if it is in the agent's own inbox.
- **Patch posture.**
  - `rem0te-agent.exe patch-scan` writes `patch\posture.json` (`rem0te-patch-posture/1`).
  - The signed heartbeat sends it while it is unacknowledged, and the portal acknowledges that exact `scannedAt`.
  - **The portal asks for a scan** (`patchScan`) when there is none, when the last is older than 12 h, or after
    *Refresh inventory* / *Scan now*. The agent scans at most every 30 minutes.
  - **What the portal keeps:**
    - posture from signed, authenticated heartbeats only;
    - every field bounded, unknown fields refused whole;
    - nothing more than 10 minutes in the future;
    - only scans newer than the one it has.
  - It also feeds the inventory page's pending-update count and reboot flag.
- **Deployments** (`apps/api/src/patching/`, migration `0026_staged_patching`).
  - **Shape:** a name, 1–20 updates, and 1–5 rings, where ring 0 is exactly one computer and later rings hold up
    to 25. Plus soak hours (default 24), failures allowed per ring (default 0) and the window each ring may run in.
  - **Refused at creation:**
    - a computer in another business (404);
    - one whose updates are managed elsewhere (`MANAGED_ELSEWHERE`);
    - one with no scan (`NO_PATCH_POSTURE`) or not ready;
    - an update nobody is offered (`UPDATE_NOT_OFFERED`);
    - an update that isn't installable (`UPDATE_NOT_INSTALLABLE`);
    - a requester without high-impact rights (an L2 technician, for example: `ACTION_NOT_GRANTED`).
  - **The gate**, in order: `in_progress`, `ring_not_run`, `unreconciled`, `too_many_failures`,
    `canary_not_effective`, `canary_proved_nothing`, `soaking`, `passed`. Requesting a ring while
    the gate before it is closed returns `409 RING_GATE`.
  - **Auto-pause.** A ring over its threshold pauses the deployment. *Resume* allows only a retry of that same
    ring, as a new plan with new approvals and optional exclusions with reasons. It doesn't re-pause over the plan
    it resumed past.
  - **Completed** when the last ring passes.
  - **Cancel** cancels any ring plan still awaiting approval, or approved but not yet delivered.
  - **Per update, per computer, the states are:**
    - before the result: `awaiting approval`, `scheduled`, `delivered`;
    - after it: `installed`, `restart required`, `effective`, `superseded`, `not offered`, `excluded`, `failed`,
      `refused`, `not executed`, `unknown`, `canceled`.
    - `effective` needs a scan taken after the result, as above. An update a later scan offers again is `failed`.
  - **Routes:**
    - `GET /endpoints/:id/patches`;
    - `GET /patching/candidates`;
    - `GET`/`POST /patching/deployments`, `GET /patching/deployments/:id`;
    - `POST /patching/deployments/:id/rings/:ring/request`;
    - `POST /patching/deployments/:id/pause`, `/resume`, `/cancel`.

    There is no approve route.
- **Per-computer plan targets** (`ActionTarget`).
  - **Model:** an `ActionJob` is now one signed plan, with one target row per computer for delivery, result and
    reconciliation. The job's status is rolled up from its targets.
  - **Rechecked per computer at its first delivery:** identity, device class, business and the requester's live
    access. A computer whose identity changed since approval is canceled (`device_identity_changed`), and the rest
    of the ring proceeds.
  - **Fleet-limit admission:** a ring is admitted once, at request time. A single computer is still admitted at
    dispatch.
  - **Result deadline**, per action: 30 minutes for the spooler, 6 hours for updates.
  - **Reconciling a ring names the computer:** `POST /actions/:id/reconcile` takes `endpointId`, with `found`
    `installed` or `not_installed`.
  - **Migration backfill:** `0026` creates a target for every existing job, mapping its status. It was tested in a
    rolled-back transaction against every `ActionJobStatus`. Production has no jobs.
- **Approval page:** it lists every computer in a ring, the deployment and ring (*canary (ring 0)*, *ring x of
  y*), and a table of the updates (KB, title, ID and revision, classification, severity), noting that titles are
  as the computers reported them. These come from a new signed but never-consulted `display` field in the plan.
  The agent's plan struct accepts it and never reads it.
- **Web.**
  - **Patching** in the menu: deployments per business; *New deployment*, which picks from offered updates and
    assigns rings; a deployment page with the update × computer matrix, gate reasons, the approval link, *Request
    ring* with exclusions, per-computer reconcile, and pause, resume and cancel.
  - **A *Patches* tab** on every computer: posture, other managers, pending restart, offered updates with why each
    is or isn't installable, Windows' update history, and *Scan now*.
  - **The *Actions* tab** shows ring plans as this computer's row, links to the deployment, lists per-update
    results, and offers the update reconcile choices. It no longer assumes the first catalog entry is the spooler.
- **Security Features:** a *Staged Windows patching* row, partial, with its effective state (agents reporting
  `windows.update.install@1`, and 30-day deployment counts). The *Approved actions* row and the roadmap rows
  now say there are two actions.
- **Security invariants §15:**
  - closed update params;
  - update risk always high;
  - no restart, licence acceptance or download-and-run in `wua.ps1`;
  - managers and eligibility checked before installing;
  - the classification allowlist;
  - no approve route on patching;
  - the canary and threshold gates;
  - `ACTION_NOT_DIRECT`.

  §14's agent-catalog check now expects exactly the two actions.
- **Docs:** `docs/staged-patching.md` (new, in the in-app bundle), with updates to `approved-actions.md`,
  `security-model.md`, `README.md`, `/help` and `CLAUDE.md`. `docs/API-REFERENCE.md` was regenerated and checked
  against the runtime route table: 348 routes.

### Tests

- **Go**, `internal/patch`, `internal/flock` and `internal/action`:
  - eligibility, manager and restart detection;
  - parser refusals;
  - every per-update state;
  - crash → unknown;
  - the Windows Update lock;
  - replay, and a second process seeing `in_progress`;
  - ring targets, and `managed_elsewhere`.

  `wua.ps1` is parsed by PowerShell and checked for banned cmdlets.
- **`e2e-staged-patching.mjs`**, 59 checks: portal, signer and `rem0te-action-sim` with `-wua`/`-registry`
  fixtures. It covers:
  - posture ingest, acknowledgement and refusal, and legacy posture ignored;
  - scan requests;
  - every creation refusal;
  - the canary, with two approvals and the requester refused;
  - restart required → restart → effective;
  - a three-computer ring with a crash (`uncertain`) and a failure (HRESULT), reconciled;
  - auto-pause, resume, and a retry with an exclusion;
  - an identity changed after approval;
  - replay;
  - a ring plan tampered to add a computer (`bad_signature`) and the genuine plan on an unnamed computer
    (`wrong_target`);
  - cancel, and business isolation.

  It needs the Go binaries, so it runs locally, not in CI.
- `e2e-approved-action` (76) passes after the per-target refactor. Its planted forged jobs now carry a target row,
  and the 30-minute deadline is set on the target. `unit-signed-installer` (51) checks the detached hook, the
  posture send and `patch-scan`, and that the legacy installer has neither.
- `e2e-security-features` (37), `e2e-integration` (77), `e2e-presets` (112), `e2e-signed-updates` (46), `unit-approval-signer` (65),
  `unit-presets` (26), `unit-integration` (35) and `unit-session-mutations` (30) pass.

### Deploy

This is a schema change. Apply `0026_staged_patching`, rsync `prisma/`, run `prisma generate` at the target, then
chown, as in CLAUDE.md. No production npm dependency of the API moved. There are no new server settings.

The feature stays inert until approved actions are set up (the approval signer isn't installed in production yet).
Even then, a computer is offered nothing until it runs a **0.27 signed agent build**, published through the
offline-signed chain. Older signed agents report only `windows.service.start@1`, so they are not ready for updates.
The detached action hook and posture reporting arrive with the regenerated signed installer script.

---

## [0.26.0] — 2026-11-09 · *Countersign*

**The first approved fix: start a Windows computer's Print Spooler, once, after people on an approval roster
authorize that exact plan with a passkey.** It is the only action, and the portal can't make it happen alone. The
portal proposes and delivers. A separate approval signer, holding its own key and roster, signs only plans that
passkeys approved. The agent checks everything again and runs a job at most once.

**Status: fixture-tested.** No real Windows workstation, real authenticator or real ClientSt0r has run it yet. See
*What has been proven* in `docs/approved-actions.md`.

### Added

- **The catalog** (`apps/api/src/actions/catalog.ts`, and the agent's compiled-in copy in
  `tools/windows-installer/internal/action/catalog.go`) holds one entry: `windows.service.start@1`,
  `{"service":"Spooler"}`.
  - No action takes a command, script, path or URL.
  - Credential extraction, backup removal, disabling defenses, admin grants and disk wipes are named as never
    available, so a request for them is refused by name. It isn't switched off; there is nothing to request.
  - The startup type isn't changed, so a disabled spooler stays disabled.
- **The approval signer** (`apps/api/src/approval-signer/`, `deploy/systemd/rem0te-approval-signer.service`).
  - **Isolation.**
    - A separate process under its own Unix user (`rem0te-approver`) with its own state directory (0700),
      Ed25519 key, roster, policy and decision log.
    - It runs from a root-owned install built by `apps/api/scripts/build-approval-signer.mjs`. That script copies
      exactly the files the signer loads and refuses if they ever include Nest, Prisma or a portal module.
  - **Listeners.**
    - Internal on 127.0.0.1:3202, for the portal: submit a plan, read status, cancel.
    - Public on 3201, on **its own origin**: the approval page.
  - **Approval.**
    - Each decision is a user-verified WebAuthn assertion against the roster's public key, with a single-use
      challenge, the signer's own origin and RP ID, and a counter that must move forward.
    - The challenge is derived from the plan digest, the decision and the role, so the passkey signature covers
      the plan the approver saw.
    - The requester can't approve.
    - Customer sign-off must come from a different person.
  - **Restarts.**
    - Passkey counters are kept per credential (`counters/`) rather than by rewriting the roster. A counter save
      could otherwise undo a concurrent `roster disable`.
    - State, including used challenges, survives a restart.
  - **Operator CLI:** `keygen`, `keys`, `roster add|list|disable`, `policy set`.
    - `roster add` requires the approver's fingerprint, read from their own screen
      (`--confirm-fingerprint`).
- **Two-person rule and customer sign-off.**
  - A workstation needs 1 approval. Anything else needs 2 from different people.
  - The agent recomputes the risk from its own Windows product type, so a plan that understates it is refused
    (`risk_understated`).
  - Customer sign-off is a per-business signer policy, re-derived by the signer. A plan whose stated policy
    disagrees with it is refused (`policy_mismatch`).
  - An AI suggestion from ClientSt0r gets no shortcut.
- **What is signed:** canonical JSON prefixed `rem0te-action-plan-v1\n`, covering:
  - the action version and parameters;
  - the agent build's sha256;
  - the business, hostname, device class, RustDesk ID and device-secret hash;
  - the requester and origin;
  - the policy;
  - every approver and their credential;
  - the window (at most 24 h) and a single-use job id.
- **The agent** (`rem0te-agent.exe action --job --envelope`, `internal/action`).
  - **Keys.** It trusts approval keys only from the signed update target `approval/keys.json`, fetched through
    the 0.24 trust chain. `rem0te-release -add approval/keys.json=` refuses a key list the agent would reject.
  - **Order of checks.** Journal first; then signature, key id, strict plan, catalog, identity (RustDesk ID +
    secret hash), window, its own build, and approvals.
  - **At most once.** It journals `executing` (fsync + rename) before starting the service, so a re-delivered
    job gets the recorded result. A job interrupted mid-action is reported `uncertain`, with the state seen now,
    and is never run again.
  - **Clock skew.** A plan that is not valid yet is not consumed, so a clock disagreement delays the job instead
    of burning it.
  - **Verification.** It checks the service 10 s and 30 s after starting it. A result is the service state seen;
    it never says a document printed.
  - **Delivery.** The signed installer's heartbeat hook delivers at most 3 envelopes per beat and reports results,
    which are deleted once acknowledged. The legacy installer is unchanged and never receives actions.
- **Portal lifecycle** (`apps/api/src/actions/`, migration `0025_approved_actions`).
  - **States:** AWAITING_APPROVAL → APPROVED → DISPATCHED → SUCCEEDED / FAILED / REFUSED_BY_ENDPOINT /
    NOT_EXECUTED / UNKNOWN, plus REJECTED / CANCELED / EXPIRED.
  - **Rechecked at the first delivery:**
    - business, identity and device class;
    - the requester's live access and access level;
    - the fleet-abuse pause.
    A failed recheck cancels the plan and audits `ACTION_DISPATCH_BLOCKED`.
  - **No result after 30 minutes** marks the job UNKNOWN, and it is re-delivered while the window is open.
  - **Reconciliation.**
    - An UNKNOWN job blocks new requests for that action on that computer (`409 ACTION_UNRECONCILED`) until the
      requester, a Business Owner or a Platform Admin records what they found (`POST /actions/:id/reconcile`).
    - That is allowed only once the computer can no longer run the job: it has answered, or the window has closed.
  - **There is no approve route.**
  - **New capability:** `actions:request` (*Request approved actions*). It never approves.
- **Actions tab on a computer's page.**
  - Shows the queued-documents warning, a reason and a confirmation before the request.
  - History rows show the approval-page link, cancel, the observed result and the reconcile form.
- **Account → Passkeys** shows each passkey's approval fingerprint and the export an operator enrolls.
- **ClientSt0r proposals** (`POST`/`GET /api/integration/v1/action-proposals`).
  - New delegation scopes `actions:propose` / `actions:read`.
  - Strict schemas (`action-proposal-request`, `action-proposal`) with no command field. A hostname target is a
    schema error.
  - Idempotent per peer and key.
  - Portal refusal codes are passed through and audited.
  - `capabilities.features.actions` lists proposable actions only when a signer is configured.
- **Security Features:** a new *Approved actions* row (layer *Approval signer*), with its effective state: signer
  configured, agents reporting support, and 30-day job counts by outcome.
- **Security invariants §14**:
  - the signer loads no Nest, Prisma or portal module, and no portal module imports it;
  - no approve route;
  - the portal never loads an approval key;
  - the agent catalog is Spooler-only;
  - the portal catalog has no free-form parameter;
  - the journal is written before execution;
  - no DTO array of objects lacks `@Type` (below).

### Fixed

- **Command results from the agent arrived with an empty event list.** With `enableImplicitConversion`,
  class-transformer turned `events?: unknown[]` on the command-result DTO into `[[]]`, so `EVENT_LOG_QUERY`
  results were stored with no events. Production's last stored events were on 2026-09-18, so a dependency move
  since then exposed it.
  - **Fix:** `@Type(() => Object)` on that field and on the new `actionResults`.
  - **Regression guard:** the invariant above fails CI on any untyped object array in a DTO.

### Tests

- `go test ./...`: every agent refusal, replay, crash and journal path.
- `unit-approval-signer.mjs`, 65 checks, with synthetic ES256 passkeys through the real `@simplewebauthn/server`
  verification. It is in CI.
- `e2e-approved-action.mjs`, 76 checks: portal + signer + the agent's real decision code (`rem0te-action-sim`)
  against a simulated Windows. It covers:
  - the roster ceremony;
  - single and dual approval;
  - Birch customer sign-off;
  - lost acknowledgement and replay after restart;
  - an uncertain outcome followed by reconciliation;
  - requester revocation;
  - expiry;
  - forged and tampered envelopes planted in the database;
  - ClientSt0r proposals.

  It needs the Go binaries, so it runs locally, not in CI.
- `e2e-security-features` (37), `e2e-integration` (77), `e2e-signed-updates` (46) and `e2e-presets` (112) pass
  unchanged.

### Deploy

This is a schema change. Apply `0025_approved_actions`, rsync `prisma/`, run `prisma generate` at the target, then
chown, as in CLAUDE.md. No production npm dependency of the API moved.

The signer is a new install (`docs/approved-actions.md` → *Setting it up*). Until `APPROVAL_SIGNER_INTERNAL_URL` is
set, the feature is inert: the Actions tab says the signer isn't configured, and ClientSt0r sees no proposable
actions. Agents need a 0.26 signed build, and `approval/keys.json` signed into the repository, before any computer
is offered the action.

---

## [0.25.1] — 2026-11-09 · *Witness*

**Dependency patch: `golang.org/x/crypto` 0.50.0 → 0.52.0 in the Windows agent, plus one lint-time override.**
No behaviour change. Supersedes Dependabot's #97, which moved `go.mod` but no version — and this module is compiled
into `rem0te-agent.exe` and `rem0te-release`, so it is a production change and gets a release.

- **`golang.org/x/crypto` 0.52.0** (and `golang.org/x/term` 0.43.0, which it requires). Dependabot raised 13 alerts
  against 0.50.0 — eight critical — all of them in `ssh`, `ssh/agent` and `ssh/knownhosts`. **None reached a shipped
  binary**: `go list -deps` for the agent (`GOOS=windows`) and for `rem0te-release` links only `nacl/secretbox`,
  `scrypt`, `pbkdf2`, `salsa20`, `poly1305` and the standard library's vendored `cryptobyte`/`chacha20poly1305`,
  pulled by go-tuf and sigstore for key handling. Bumped anyway, so the alerts close and the next import of `ssh`
  does not start from a vulnerable floor. `go vet` (linux and windows) and `go test ./...` pass unchanged. The new
  agent build reaches endpoints only when it is signed into the update repository with `rem0te-release`.
- **`minimatch` 10.2.6 → 11.0.3 (override, development only).** GHSA-g3hv-75wg-m249, a glob-pattern amplification
  DoS covering `>=7.0.0 <11.0.1`. The only affected copy came from `@typescript-eslint/typescript-estree` (asks for
  `^10`), which runs at lint time. The override in `pnpm-workspace.yaml` is scoped to the 10 line: the 3.1.5 copies
  eslint 8 and 9 use are outside the advisory, and forcing them onto a new major is how the ajv override once
  broke eslint. Both lints pass on 11.
- **`deepmerge` 4.3.1 — not fixed, dismissed.** GHSA-gcqx-w48m-w2h4 (prototype poisoning in `mergeObject()`) has no
  patched release. It reaches us only through `@nestjs/cli` › `fork-ts-checker-webpack-plugin`, which merges its
  own build options at compile time; nothing reaches it with untrusted input, and it is not in the production
  manifest. The alert is dismissed with that reason; revisit when a fix ships or `@nestjs/cli` drops it.

Deploy: no API or web code changed, and no production npm dependency moved, so the target's `node_modules` and
manifest are untouched. Rebuild and re-sign the agent to ship the x/crypto bump to endpoints.

---

## [0.25.0] — 2026-11-09 · *Witness*

**"Which technician can reach this customer's PC, and what evidence will I have afterwards?" — answered from the
code, not the brochure.** A trace of every launch path for this release found the documentation and the UI claiming
restrictions that only ever applied to preset-backed technicians. This release corrects the claims, adds a view that
says what each control actually does, and pins the claims with a test. **No permission changed**: every person can
reach exactly what they could in 0.24.0.

### What the trace found (and is now documented, not changed)

- **View-only was never applied to Business Owners, Business Users, custom assignments or Platform Admins.**
  `AccessPolicyService.evaluateLaunch` approves every non-technician before it looks at the mode, so a view-only
  request released the permanent password and RustDesk opened with full control. The computer page offered them a
  *View only* button with the tooltip "Refused if this computer cannot enforce view-only". The button is now shown
  only in a technician context, where it is enforced (by refusal). `e2e-security-features.mjs` pins the member
  behaviour as a documented limitation so the docs cannot drift from it.
- **An ordinary Connect is unattended in effect.** The installer sets `verification-method = use-permanent-password`
  and no per-feature options, so the endpoint accepts its password with nobody asked, whatever
  `unattendedAccess: off` says. That setting refuses only an explicit unattended launch.
- **A preset launch said "RustDesk will prompt at the computer". It will not.** It now says that no password was
  released and that a computer installed by Rem0te accepts only its permanent password.
- **"This session is limited to N minutes" limited nothing.** It now reads as a policy limit that nothing on the
  computer enforces.
- A refused `connect.cmd` is recorded as `ENDPOINT_PASSWORD_REVEALED` with `meta.denied`; filter on the metadata.
  A Platform Admin with no business selected is matched across every business by the Tactical RMM hostname
  resolver (which answers *ambiguous* rather than guessing). Both documented.

### Added

- **Settings → Security → Security Features** (also the *Security features* tab in Admin → Security).
  - A compact, read-only table: what each control protects, the layer that enforces it (portal, launcher, endpoint
    agent, endpoint RustDesk, the technician's RustDesk, offline signing, or nothing), its shipped default, its
    prerequisites and a link to the setting or the docs. Expand a row for the mechanism, the limitation and the
    evidence.
  - Grouped as *Who can reach a computer*, *What a session can do*, *What you will have afterwards*, guardrails,
    updates, integration, and *Not in this build*.
  - The *Effective* column comes only from what the server can observe, and names its source: portal policy,
    counts of endpoint reports, the mirror, server configuration, or the code itself. Anything it cannot observe,
    such as clipboard and file transfer, reads **Unknown**. Session evidence counts the last 30 days' launches,
    confirmations and measured durations.
  - Who sees it: Platform Admins and `technicians:manage` holders, for the platform or any business (the same as
    `GET /security-controls/policy` already allowed). A Business Owner sees their own business only. Business Users
    and every technician context get 403.
  - The catalog's static text was previously Platform Admin only. It is the same text as the public docs.
- **Session modes as separate rows**: attended consent, unattended, view-only, keyboard and mouse, clipboard, file
  transfer, elevation, session length. Each one states what applies to members and to preset technicians.
- **Roadmap rows, all Unavailable**: background terminal and PowerShell, approved actions and fixes (the first
  planned is the Print Spooler lab action), chat with the user, mobile device management, and backup with verified
  recovery. They say what each needs before it ships. Rem0te has no command channel beyond inventory refresh, update
  scan and event-log query. Any terminal or chat inside a RustDesk session is RustDesk's own feature, governed by
  its defaults and not recorded.
- **`docs/security-model.md`**: the portal / RustDesk / endpoint boundary; why permission to launch is not a
  connection; a worked example with two customers that both have a FRONTDESK; what each session mode really does,
  per actor; roles and presets side by side; the same evidence rule for signed updates, jobs, replay protection,
  fleet limits and ClientSt0r analysis; and the roadmap.
- **README: "How rem0te protects customer access"**, near the top, with the same example, linking to the operator
  guide and to private vulnerability reporting.
- `apps/api/scripts/e2e-security-features.mjs`, 37 checks against a scratch stack with synthetic data:
  - who may see which scope: signed out, Platform Admin, technician manager, Business Owner (own business only),
    Business User, and an L2 technician scoped to one business;
  - Unknown where nothing is observed, and simulated endpoint reports counted per business;
  - the FRONTDESK scenario: a 404 across businesses, `TEMPORARY_GRANT_REQUIRED`,
    `ENDPOINT_CANNOT_ENFORCE_VIEW_ONLY`, and the audit rows for each.
- Security invariants §13 (13 checks):
  - the view refuses technician contexts;
  - an owner cannot widen the scope;
  - clipboard and file transfer carry no effective state;
  - the roadmap rows stay Unavailable;
  - session length stays advisory;
  - the View only button stays technician-only.

### Changed

- `GET /security-controls/catalog` takes `?businessId=` and returns `{ scope, features[] }`, each feature with
  `effective` (or `null`).
- `docs/technician-access.md`:
  - members' modes are not applied;
  - the session length is not enforced;
  - *Disconnected* is observed, not enforced;
  - the "release signing not built" item now points at 0.24's update chain and lists what remains (Authenticode,
    CI provenance, hardware-backed keys).
- `/help` explains what Connect does and does not control.

### Upgrade notes

No migration and no configuration change. Business Owners will see a new *Security Features* card under Settings →
Security. Members who used *View only* will no longer see it: it never restricted their sessions.

## [0.24.0] — 2026-11-09 · *Keystone*

**An offline-signed update chain for Windows agents.** Every Windows agent since 0.8.1 updated by piping this
portal's `windows.ps1` into a SYSTEM PowerShell (`irm … | iex`), whenever a heartbeat said so. That made the portal
and its database the root of trust for every machine. Whoever controlled either could run anything, anywhere, at the
next heartbeat. The RustDesk digest that installer checked came from the same response as the code checking it.

0.24 moves the root of trust off the portal. Agents built with a trust root run only files signed offline by keys the
portal never holds, and the portal becomes a mirror.

**Status: fixture-tested.**
- The Go tests drive the real release tool and the real go-tuf client through every attack below.
- An end-to-end suite runs the mirror and containment against a scratch API.
- The signed installer is parsed, and its parameter block executed, with real PowerShell.
- **No Windows machine has run it**, in a lab or in production. Pilot it on one lab machine first.

### Upgrade notes

- **Migration `0024_signed_updates`.** Additive:
  - `Endpoint.updateChannel`, `trustRootVersion`, `targetsVersion` and `trustReportedAt`;
  - `PlatformSettings.updateTrustMode` (default `legacy_allowed`) and `legacyPortalMigration` (default false).
  - Deploy it with the usual schema-change steps (CLAUDE.md, *A schema change needs two more steps*).
- **Nothing changes until you opt in.** With no `UPDATE_REPO_DIR`, the portal behaves exactly as 0.23:
  - the legacy installer (whose output is byte-identical apart from two lines that record `updateChannel = 'legacy'`);
  - the legacy bootstrap download;
  - legacy heartbeats.
- **No production dependency changed.** The Go module gains go-tuf v2.4.2 and sigstore v1.10.6. These are build-time
  only for the agent; nothing is added to the API's manifest.
- **The agent binary is about 15 MB** (was 2.2 MB), because of go-tuf's verification dependencies. Build release
  binaries with `-trimpath -ldflags "-s -w"`.

### Added

- **`rem0te-release`** (`tools/windows-installer/cmd/rem0te-release`), the offline repository tool:
  - `keygen`, `pubkey`, `init`, `release`, `refresh`, `rotate-root`, `status`, and `verify` (local, or `-mirror` for a
    deployed portal through the real client);
  - root 2-of-3 by default, with separate targets, snapshot and timestamp keys; a key reused across roles is refused;
  - consistent snapshots, and versions are never overwritten;
  - a root rotation is refused if clients trusting the previous root would reject it.
- **`rem0te-agent.exe`** (`tools/windows-installer`), the same binary as the downloadable bootstrap:
  - commands `install`, `migrate`, `update` and `status`;
  - Stage 1: fetch the signed agent into `Program Files\Rem0te`, then run it.
  - Stage 2: refuse unless its own SHA-256 is the signed one; fetch the signed `windows/install.ps1` and the signed
    RustDesk build into a SYSTEM/Administrators-only directory; write a parameters file; run the script.
  - Trusted metadata persists in `ProgramData\Rem0te\tuf`, so rollback and freeze protection survive restarts, and a
    replaced binary carrying an older root can't make the machine forget a rotation.
  - A RustDesk downgrade is refused unless the target is signed `allowDowngrade`.
  - **An installed agent keeps the relay host and key it pinned at install.** A portal asking for a different relay is
    reported (`relayChangeRequested`), never applied. Otherwise a compromised portal could repoint the fleet without
    touching signed code.
  - A build without a trust root (CI or dev, `trustroot/root.json` = `{}`) keeps the legacy behaviour and says so.
- **Signed installer variant** (`apps/api/src/public/windows-script.ts`). The installer template moved out of the
  controller unchanged, and both variants share one body. The signed variant:
  - takes a mandatory `-ParamsFile`, and validates every field again with case-sensitive allowlists;
  - copies the agent-verified RustDesk build instead of downloading it, with the digest mandatory;
  - has a heartbeat hook that runs `rem0te-agent.exe update [--nonce]` instead of `irm | iex`;
  - reports `updateChannel`, `trustRootVersion` and `targetsVersion` on each heartbeat.
  - `apps/api/scripts/build-signed-installer.mjs` writes it deterministically for the release signer.
- **Portal mirror:**
  - `GET /api/v1/public/updates/metadata/:file` and `GET /api/v1/public/updates/targets/*path` serve `UPDATE_REPO_DIR`
    byte-for-byte;
  - strict names, realpath containment (symlinks refused), and `timestamp.json` served `no-store`.
- **`GET /api/v1/public/install/windows-params.json`**: data only. It offers only RustDesk builds that signed targets
  list, and for a staged job exactly that job's version.
- **Settings → Security → Update Signing** (`GET /admin/update-trust`, `PUT /admin/update-trust/mode`):
  - the repository as served: role versions, expiry warnings and targets;
  - the trust mode;
  - the Windows agent inventory: legacy agents, and signed agents behind the current root.
- **Containment.** In `signed_only`:
  - heartbeats hand legacy agents no reinstall or update trigger;
  - `windows.ps1` serves a refusal that runs nothing;
  - the Windows download is the signed agent.
  - With `legacyPortalMigration`, legacy agents get only the reinstall trigger, and `windows.ps1` becomes a short script
    that downloads the signed agent, checks the digest the portal pins, and runs `migrate`. That run trusts the portal
    once.
  - Tightening applies at once. Loosening (back to `legacy_allowed`, or turning portal migration on) is a trust change
    (`update_trust`) needing an independent reviewer and fresh authentication.
- **Migration path** independent of the portal: `rem0te-agent.exe migrate --portal <host>` from the official release,
  through GPO, Intune or locally.
  - It keeps enrollment, the device secret, the RustDesk configuration and password, and the scheduled tasks.
  - It pins the relay the machine already uses.
- **Tests:**
  - `tools/windows-installer/internal/trust/chain_test.go`, the attack drills: tampered target (same length, so only
    the digest catches it), forged targets from a compromised portal holding the online keys, rollback after restart,
    freeze after expiry and recovery by refresh, mix-and-match, stolen timestamp key, two root rotations with a
    targets-key replacement, an under-signed rotation, an older embedded root, key reuse, invalid target names.
  - `internal/agent/agent_test.go`: only signed code runs, stage 2 refuses an unsigned self, unsigned and downgraded
    RustDesk builds are refused, relay pinning on update, migration pins the prior relay, nonce mismatch, hostile
    parameters, a tampered agent binary, the slot parser.
  - `apps/api/scripts/unit-signed-installer.mjs`, in CI: 42 checks, including PowerShell parsing both variants and
    their heartbeats, and executing the signed parameter block against 15 hostile parameter files.
  - `apps/api/scripts/e2e-signed-updates.mjs`: 46 checks against a scratch API, with the real Go client verifying
    through the API mirror.
  - `scripts/check-security-invariants.mjs` § 12: 13 static checks.
  - CI now runs `go test ./...` in the installer job, and the signed-installer tests in the check job.
- Docs: new [update-signing.md](docs/update-signing.md), covering the key ceremony, releases, timestamp refresh,
  containment, migration, rotation and recovery. Also updates.md, architecture.md, troubleshooting.md and the in-app
  help.

### Changed

- **Security features catalog.** *Release signing* is now **partial** (*Signed agent updates, offline-rooted*), with
  the remaining gaps listed.
- `buildWindowsScript` in `public.controller.ts` is now a thin wrapper around `buildLegacyWindowsScript`. The legacy
  output was diffed against the 0.23 template for identical inputs. The only differences are the two
  `updateChannel` / `$RD_LOCAL` lines.

### Not built (this milestone)

- **Authenticode signing of the agent binary.** Windows doesn't vouch for a first download, so a first install trusts
  the file it was given. Use the official release through GPO or Intune for an independent first install.
- CI-built provenance for release artifacts, hardware-backed signing keys, and an automated timestamp-signer service.
- Signing for the Linux and macOS installers, and for the technician-side Connect / setup `.cmd` scripts. Their
  RustDesk downloads still carry no digest check. Found in the trace for this release, and not changed.
- Signed customer policy: a database compromise can still change policy, just not code.
- Job-approval signing and the first approved action (Print Spooler). That is the next milestone, gated on this one.
- A paired-lab run on real Windows: install, migrate a 0.19–0.23 agent, update, rotate.

---

## [0.23.0] — 2026-11-09 · *Gatehouse*

**Technician access presets and abuse prevention.** Three shipped tiers
(L1 Help Desk, L2 Technician, L3 Senior) say what a technician may do in a
business; a single launch policy decides every session start; protected
device classes, fleet-abuse limits and independent review of trust changes
apply to everyone, Platform Admins included. Operator page:
`docs/technician-access.md`. Admin screen: *Settings → Security → Technician
Access*; every safeguard, its enforcement status and its evidence are in
*Admin → Security → Security features*.

**Status: fixture-tested.** `apps/api/scripts/e2e-presets.mjs` (112 checks
against a running API and a scratch database) and `unit-presets.mjs` (26, in
CI). **No RustDesk restriction was live-verified.** View-only and attended
consent are honoured only where an endpoint reports it can enforce them
(`Endpoint.sessionEnforcement`); no shipped agent does, so the tests simulate
it by writing the column. In this build every preset-backed view-only or
consent-gated launch is therefore *blocked with a reason*. It is never opened
with more.

### Upgrade notes

- **Migration `0023_technician_presets`.** New tables `TechnicianPreset`,
  `AccessPolicy`, `TemporaryAccessRequest`, `PrivilegedActivity`,
  `IdentityPause`, `MaintenanceException`, `AlertSuppression`, `SecurityAlert`,
  `TrustChangeRequest`; enum `DeviceClass`; columns `Endpoint.deviceClass`,
  `Endpoint.sessionEnforcement`, `TechnicianAssignment.presetId`,
  `TechnicianDevice.isManagedAdminWorkstation`, and `launchMode` on
  `ConnectionGrant` / `LauncherToken`; fourteen `ActivityAction` values.
  Additive, except a back-fill: `deviceClass` becomes `SERVER` where the
  inventory OS caption contains "Server", `WORKSTATION` where there is other
  inventory, `UNKNOWN` otherwise. **It never assigns a protected class** —
  mark domain controllers, hypervisors, backup servers and the RMM host
  yourself. Run `prisma migrate deploy`, rsync `prisma/`, and `prisma generate`
  at the target (CLAUDE.md, *A schema change needs two more steps*).
- **No production dependency changed.**
- **Existing assignments are unchanged.** Every assignment made before 0.23 is
  *custom* and keeps its capabilities, including Remote connect and credential
  reveal. *Upgrade impact* lists them and flags those holding connect or edit.
  Business members and Platform Admins connect as before — except to a
  protected device class, and except while paused.
- Built-in presets and the platform policy are seeded on startup,
  create-only, so an admin's edits survive restarts and upgrades.
- With a single Platform Admin and no independent reviewer, nothing that
  widens trust can be approved. Appoint a second person before you need to.

### Added

- **Presets.** A preset-backed assignment's capabilities are derived live
  from the preset: `computers:view` and `support:requests`, plus
  `computers:event_logs` for L2/L3 — never `computers:connect`, `:edit`,
  `:add`, `:remove`, `quick_connect` or `users:manage` (checked by
  `check-security-invariants.mjs` § 11). Clone, edit (with a preview of what
  changes and how many assignments it affects), reset to shipped defaults.
  Locked controls (credential reveal, enrollment, scripts, fix approval, fleet
  execution) cannot move; unenforceable ones (clipboard, file transfer,
  standing elevation, unattended) cannot be turned on. A new assignment with
  neither a preset nor capabilities gets **L1**.
- **Launch policy** (`AccessPolicyService.evaluateLaunch`), applied inside
  `authorizeConnect` so `POST /connect`, `connect.cmd`, grant redemption and
  the launcher (at issue *and* redemption) share it. Modes `control`,
  `view_only`, `elevated`, `unattended` (`?mode=` / launcher `mode`). The mode
  is stored on the grant or token and re-evaluated at redemption. **A
  preset-backed launch never receives the permanent password**, so there is no
  credential to reconnect with directly. Refusals are 403 with a code and a
  sentence the UI shows.
- **Temporary access**: request → independent decision (fresh auth) →
  activation by the requester (fresh auth; a passkey for protected-device
  exceptions). Approved-but-not-activated grants do nothing; activation
  re-checks eligibility; expiry is enforced at every launch.
- **Protected device classes.** Domain controller, hypervisor, backup server
  and RMM host are always protected (`SERVER` optional): interactive access is
  denied to everyone unless an approved, activated exception exists *and* the
  launch comes through the launcher from a managed admin workstation.
- **Fleet-abuse limits** (`AbuseGuardService`). Launches, writes and evidence
  reads from the UI, launcher, Quick Connect and the ClientSt0r integration
  (counted for the delegated technician and the peer) are admitted under a
  per-identity Postgres advisory lock that counts distinct computers and
  businesses, launches and writes in the window. A trip pauses the identity
  and alerts the configured webhooks. Pause and alert suppression are
  separate. Maintenance exceptions name computers, kinds of work and an
  expiry, and need an approver other than requester and beneficiary.
- **Independent review of trust widening** (`TrustChangeRequest`): alert
  destinations, independent-reviewer designation, thresholds and window,
  unattended / clipboard / file transfer / consent, protected classes,
  device-class downgrade, managed-workstation designation, preset widening.
  The previous contacts are notified on request and decision. Webhook URLs are
  treated as secrets — shown and recorded as label, origin and ref only.
- **Business Owner tightening** of their own business's policy; the effective
  value is always the stricter of platform and business.
- **Effective access inspector** (technician + business + computer + action →
  decision, reasons, grants) and **upgrade impact** report.
- **Security Features catalog** (`GET /security-controls/catalog`) with scope,
  enforcement status and evidence for every safeguard.
- `approvals:review` platform permission ("Independent reviewer").
- `scripts/unit-presets.mjs` (CI), `scripts/e2e-presets.mjs`,
  `check-security-invariants.mjs` § 11.

### Changed

- **Capability and computer scope now come from the same grant.**
  `canReachEndpoint` / `assertEndpointInScope` take the capability being
  exercised and require one assignment to carry both. Before, a technician
  with event logs on one computer (group grant) and inventory on the whole
  business (direct grant) got event logs on every computer.
- `@RequireCapability(computers:connect)` was removed from `POST
  /endpoints/:id/connect`, `GET /endpoints/:id/connect.cmd` and `POST
  /launcher/token`. The decision moved into `authorizeConnect`, which still
  requires `computers:connect` of members (403 with a reason, as before) and
  decides technicians by grant.
- **Queued endpoint commands are re-authorized at heartbeat dispatch.** One
  whose requester was demoted, revoked or paused is not handed out and is
  marked `FAILED` with the reason.
- No self-assignment: a manager cannot assign themselves or a group they are
  in, or add themselves to a group; nobody appoints themselves a reviewer.
- `ActorResolverService.contextFor()` builds a request-less `ActorContext`;
  `EndpointsService.liveActor` uses it.

### Not built — shown as *Unavailable*

- **Endpoint enforcement of view-only / consent.** No agent reports
  `sessionEnforcement`; clipboard and file transfer are client-side RustDesk
  toggles; endpoint-confirmed session termination is not reported by RustDesk.
- **Managed-workstation attestation.** The launcher carries no device key, so
  the protected-class exception can be approved and activated but never
  satisfied: protected computers are unreachable interactively, fail-closed.
- **Windows privileged helper** (elevation) and **release signing /
  provenance**: neither component exists. The catalog lists what each needs
  before it ships.

### Found by the stolen-session drill, not fixed here

- A stolen Platform Admin session (cookie, no password) can still **create an
  enrollment token** (201). Appointing an approver, removing alert contacts,
  revealing a backup server's password and controlling it were all refused.
  Enrollment is used by API keys and installers, so gating it needs its own
  change.
- 40 single-device inventory refreshes from that session stayed under the
  Platform Admin cap (60) and did not pause it. Lower `thresholds.platformAdmin`
  if that is too generous for your fleet.

## [0.22.0] — 2026-11-09 · *Courier*

First milestone of the ClientSt0r ↔ rem0te integration: **read-only ticket
analysis** under a new versioned contract, **ticket-rmm-v1**
(`docs/contracts/ticket-rmm-v1/`). ClientSt0r owns the ticket, the customer
conversation, AI configuration and every provider key; rem0te maps its
organizations and technicians to businesses and users, runs the job, checks
every model output and returns staff-only findings. Nothing in this release
executes anything on a computer.

**Status: fixture-tested** against a simulated ClientSt0r
(`apps/api/scripts/e2e-integration.mjs`, 77 checks). It has not run paired
with a real ClientSt0r, and it is not a production readiness claim.

### Upgrade notes

- **Migration `0022_integration_ticket_analysis`.** Five new tables, one enum,
  four `ActivityAction` values. Additive; no existing row changes. Run
  `prisma migrate deploy`, then rsync `prisma/` to the target and
  `prisma generate` there (CLAUDE.md, *A schema change needs two more steps*),
  or the API throws `Unknown field … on model …`.
- **No production dependency changed** — the target manifest does not need
  regenerating.
- **Off until configured.** Without `INTEGRATION_PEERS_FILE` every
  `/api/integration/v1` route answers 404 `NOT_CONFIGURED` and the worker
  idles. Setup: `docs/integration-clientst0r.md`.
- **New capability `integration:ticket_analysis`.** Business Owners hold it
  automatically (owners are computed, not stored). No Business User or
  technician assignment gains it on upgrade.
- **Optional new unit** `deploy/systemd/reboot-remote-integration-worker.service`;
  `INTEGRATION_WORKER_INLINE=true` runs the worker in the API process instead.

### Added

- **`GET /api/integration/v1/capabilities`, `POST /api/integration/v1/jobs`,
  `GET /api/integration/v1/jobs/{job_id}`, `GET /api/integration/v1/jobs/{job_id}/events`.**
  Mounted outside the `/api/v1` prefix. Every request is Ed25519-signed over
  audience, method, path, timestamp, nonce and body hash; nonces are persisted,
  so a captured request is refused even after a restart. Optional mTLS pinning
  via the fronting proxy.
- **Delegated technician identity.** A ≤ 5-minute, single-use, audience-bound
  JWS minted with a *separate* ClientSt0r delegation key. The submit token is
  bound to the sha256 of the canonical payload. The body's
  `organization_id`/`technician_id` must match the token. The user's access to
  the business is rebuilt from the database at intake, on every poll, and by
  the worker before every model call. A role revoked mid-job stops the job
  (`ACTOR_REVOKED`) before the next paid call. The integration never acts as
  Platform Admin.
- **Idempotency.** Same key + same payload returns the original job (200,
  `idempotent-replayed: true`); a changed payload is 409. Six concurrent
  identical submits produce one job.
- **Durable worker** (`dist/integration/worker.main.js`). Postgres queue with
  `FOR UPDATE SKIP LOCKED` leases. A killed worker's job is re-claimed when the
  lease lapses, and model profiles that already finished are not bought again.
  Expired jobs never reach the gateway.
- **Model comparison.** Up to three ClientSt0r profiles per job. Category and
  top-hypothesis disagreements are reported, partial failures are listed per
  profile, and the result reports the most cautious confidence any model gave.
- **Untrusted-input handling.** Prompt-injection patterns are flagged. A model
  "fact" citing evidence that does not resolve becomes an `unsupported_claim`.
  Unknown output fields are dropped and counted. Next steps are text
  (`executable: false`), and those touching credential extraction, disabling
  defenses, deleting backups, admin grants, disk wipes or arbitrary commands
  are labelled. Link hosts in draft replies are listed. A gateway response is
  accepted only if it is signed over our nonce and echoes this exact request,
  job, organization and profile.
- **Optional endpoint evidence**, addressed by immutable endpoint id, never by
  hostname. It covers heartbeat freshness, agent version, OS build, uptime,
  memory and system-disk headroom, pending updates and reboot-required. IP,
  MAC, serial, logged-on user and domain are never sent, and device-reported
  names are reduced to an inert charset.
- **Signed, sequenced event outbox** pushed to ClientSt0r with backoff for up
  to 7 days, and readable by scoped polling. A lost acknowledgement costs a
  duplicate delivery, never a lost result.
- **Peer trust lives in a root-owned file**, not the database: keys,
  audiences, the only two outbound URLs (https, no redirects), allowed
  profiles. A database or portal-admin compromise cannot add a peer, swap a key
  or redirect the worker.
- **Platform Admin mapping routes** under `/api/v1/admin/integration`, behind
  step-up (`technicians.manage`).
- Contract package: OpenAPI, 11 JSON Schemas **generated** from the runtime zod
  schemas (`scripts/gen-integration-contracts.mjs`, `--check` in CI), and 19
  fixtures produced by rem0te's own code paths.
- Tests: `apps/api/scripts/unit-integration.mjs` (35, no database, in CI);
  `apps/api/scripts/e2e-integration.mjs` (77, scratch database + simulated
  ClientSt0r).
- `scripts/check-security-invariants.mjs` section 10 pins down the following.
  The integration never spawns a process. It has one outbound call site, which
  takes its URL from a Peer. The worker imports nothing that can launch,
  command or approve. Peers are never read from the database. Replay
  protection is one atomic insert. The delegated actor is never Platform Admin.
  Next steps are never executable.

### Changed

- `main.ts` keeps the raw request body (`rawBody: true`) so signatures are
  checked over the exact bytes received.
- `scripts/gen-api-reference.mjs` understands controllers mounted outside the
  global prefix and labels class-level `IntegrationAuthGuard` /
  `PlatformAdminGuard` routes.

### Known gaps (not in this release)

- No signed bootstrap/update chain yet. Every endpoint code path still trusts
  TLS plus whatever the portal serves. This is why no privileged or
  executable job exists. Approved actions wait for an independently rooted
  update and approval signing chain.
- The existing device AI timeline still uses `ANTHROPIC_API_KEY` on the rem0te
  host. The integration path uses no provider key.

---

## [0.21.1] — 2026-11-09 · *Signpost*

Dependency release: Dependabot's November production group (#90), plus the
development group (#91) that landed on `main` without a release of its own.
No code changes and no new surface.

### Upgrade notes

- **Production dependencies changed — the target manifest must be regenerated.**
  `pnpm deploy:manifest -o /tmp/prod-package.json`, confirm
  `npm install --omit=dev --package-lock-only` exits 0 against it (it does for
  this set), copy it to `/opt/reboot-remote/api/package.json` and run
  `npm install --omit=dev` there *before* restarting the API. Rsyncing `dist`
  alone puts code compiled against these versions onto the old libraries, and
  that only shows on the next restart.
- No migration.

### Changed

- **API:** `@anthropic-ai/sdk` 1.3.0 → 1.6.0, `argon2` 0.45.1 → 0.45.2,
  `maxmind` 5.0.7 → 5.0.8, `openid-client` 6.8.8 → 6.8.9 (still pinned
  exactly — it backs SSO, and its patch releases are taken deliberately).
  The SDK's 1.5/1.6 releases add per-status error classes and set each error's
  `name` to its class name; nothing here matches on `error.name`, so the
  endpoint-summary path is unaffected.
- **Web:** `next` 16.4.3 → 16.4.5, `@tanstack/react-query` 5.105.0 → 5.106.1,
  `lucide-react` 1.63.0 → 1.70.0.
- **Development only (#91, no runtime effect):** `@types/node` 26.6.6,
  `eslint-plugin-security` 4.2.1, `typescript-eslint` 8.72.1,
  `@vitejs/plugin-react` 6.2.1, `vite` 8.3.6, `@playwright/test` / `playwright`
  1.65.0, `autoprefixer` 10.6.2, `eslint-config-next` 15.5.29, `marked` 18.1.3,
  `postcss` 8.5.32.

  #91 had no CI run at all when it was opened — GitHub never emitted the
  `pull_request` event for it, so the PR sat `BLOCKED` with zero checks rather
  than failing. Closing and reopening it re-emitted the event without
  rewriting Dependabot's branch.

- #90 itself was closed rather than merged: once #91 landed, its lockfile
  conflicted, and its `package.json` files were snapshots from before #91, so
  taking them whole would have silently reverted the dev bumps. The seven
  production ranges were reapplied on top of `main` and the lockfile
  regenerated.

---

## [0.21.0] — 2026-11-07 · *Signpost*

The server's public address becomes a setting. Every install is reached at a
different address, and until now the only place to say what it was were
`FRONTEND_URL` and `PUBLIC_API_URL` in `/etc/reboot-remote/api.env`: root-only,
edited over SSH, and applied only by an API restart. This mattered on the
reference server, where 0.20.0 went live with `FRONTEND_URL` still set to the
LAN address `http://192.168.22.87`. Passkeys derive their relying party from
it and browsers refuse an IP address there, so passkeys could not work, and
SSO would have sent people back to an address they could not reach.

### Upgrade notes

- Migration `0021_public_address`: adds `PlatformSettings.publicUrl` and turns
  the new step-up action `platform.configure` on for the existing settings row.
  Run `prisma migrate deploy` and `prisma generate` at the target.
- No dependency changes.
- Nothing changes on upgrade: with the setting empty the API uses
  `FRONTEND_URL` / `PUBLIC_API_URL` exactly as before.

### Added

- **Settings → General → Public address** (Platform Admin). Shows the address
  in use and where it comes from (this setting, the environment, or the
  development default), and warns when the page is being viewed at a different
  address. Saving needs step-up (`platform.configure`). Clearing goes back to
  the environment.
- **Order of precedence:** the setting, then `FRONTEND_URL` / `PUBLIC_API_URL`,
  then the development defaults. One address serves the web app and the API,
  as the supported layout puts both on one host. An install that splits them
  leaves the setting empty.
- **Reachability check before saving.** The server requests
  `<address>/api/v1/public/address-probe/<nonce>`, with a nonce only this
  process knows and redirects not followed, so a saved address is proven to
  lead back to *this* server, not merely to something that answers. A failed
  check returns `409 ADDRESS_UNVERIFIED` with the reason, and the card offers
  *Save anyway* for an address that is right but cannot be reached from the
  server itself (DNS not switched yet, no hairpin NAT). The probe route is
  public, rate-limited, and answers only whether a nonce was issued here.
- The card states what a change affects: links and downloads already handed
  out keep the old address; the SSO redirect URI must be updated at each
  provider; passkeys stop working if the host name changes and
  `WEBAUTHN_RP_ID` does not pin it (with the count, and a confirmation before
  saving); enrolled computers are unaffected, as they check in through the
  RustDesk relay host.
- `auth-recovery --clear-public-url` clears a wrong address from the server, and
  `--status` shows it. The running API picks up a change made this way within
  a minute.
- Security invariant 9: only `PublicUrlService` (plus the config schema and the
  recovery CLI, which only prints it) may read `FRONTEND_URL` or
  `PUBLIC_API_URL`. A link built from the raw variable would silently ignore
  the setting.

### Changed

- Every link the API builds now comes from `PublicUrlService`: customer support
  links, the SSO post-login redirect and suggested redirect URI, the passkey
  RP ID and origin defaults, launcher deep links, Connect and Quick Connect
  download links, session telemetry, the Windows installer's embedded URL
  (still https-only in production, still preferred over request headers), the
  public API's install commands and the diagnostics helper.
- CORS allows the current public address and `FRONTEND_URL`, resolved per
  request, so a change applies without a restart.

### Fixed

- **The recovery tool was not on deployed servers.** 0.20.0 shipped it as
  `apps/api/scripts/auth-recovery.mjs` and documented
  `cd /opt/reboot-remote/api && node scripts/auth-recovery.mjs`, but a deploy
  copies `dist/`, never `scripts/`, so the command did not exist where it was
  needed. It now lives in `src/cli/` and is compiled to
  `dist/cli/auth-recovery.js`. The docs also loaded the environment from
  `/opt/reboot-remote/api/.env`, which does not exist; the API's environment is
  `/etc/reboot-remote/api.env` (root-only), and the docs now say so.

- **The step-up prompt never said what it was for.** The API's
  `STEP_UP_REQUIRED` answer names the action (`credential.reveal`,
  `permissions.change`, …) so the dialog can say *To reveal a computer
  password, confirm your identity*, but the global exception filter rebuilt
  every error body from `code` and `message` alone and dropped it. Every
  prompt since 0.20.0 read *For this action*. The filter now passes `action`
  through, and only as a `word.word` identifier.

### Tests

- New `e2e-public-address.mjs`, 43 checks, against a scratch API and database.
  It covers who may read or change the address, with access checked before
  validation and step-up; eight malformed addresses refused; step-up on save
  and clear; the check telling this server from another server that answers,
  a redirect and nothing listening; 409 without `saveUnverified`; the audit
  record; support link, SSO redirect URI, launcher deep link, CORS and passkey
  RP ID following the setting without a restart; clearing; and the recovery
  CLI, including the running API seeing its change.
- `e2e-sso-passkeys.mjs` runs the recovery tool from `dist/cli/`.

### Limitations

- One address for web and API. Installs that serve them from different hosts
  keep using the two environment variables.
- The reachability check runs from the server, so behind a router without
  hairpin NAT a correct address fails it; *Save anyway* is the way through.
- Changing the address does not rewrite anything already handed out: support
  links sent to customers, downloaded Connect scripts, SSO redirect URIs
  registered at providers.

---

## [0.20.0] — 2026-11-07 · *Switchboard*

Support operations: knowing why a connection fails, what a session actually
did, who may reach a customer's computers and for how long, how a customer
asks for help, how RustDesk gets updated, and what is left behind when
someone leaves. Each feature states its limits in the product and in the docs;
the [Limitations](#limitations-in-0200) below are the honest summary.

### Upgrade notes

- **Migration `0020_support_operations`** adds the tables below. Run
  `prisma migrate deploy` and regenerate the Prisma client at the target (see
  CLAUDE.md, *A schema change needs two more steps*).
- **Two new production dependencies**: `openid-client` 6.8.8 and
  `@simplewebauthn/server` 14.0.3. Regenerate the target manifest with
  `pnpm deploy:manifest` and run `npm install --omit=dev` there, or the API
  fails to start on its next restart.
- **New optional settings**: `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN` (default
  from `FRONTEND_URL`; passkeys are bound to that host name, so set it before
  anyone registers one), and `OIDC_ALLOW_INSECURE_LOOPBACK` (development only).
- **The agent contract is now 0.20.0.** Every managed computer on an older
  agent shows as outdated until *Reinstall agent* is run. That is intended:
  connection confirmation, session counting and version pinning need the new
  agent.
- **`POST /sessions/:id/events` accepts only `connected` and `failed`** from
  a browser. `client_opened` and `client_closed` now answer 400: the client
  side cannot prove a connection, and those events now come from the launcher,
  the Connect script and the endpoint agent, each authenticated.
- **Step-up is on by default** for password reveal, permission changes,
  technician management, SSO configuration and passkey changes. Scripts that
  call those routes need `POST /auth/step-up` first (see `stepUp()` in
  `apps/api/scripts/e2e-security-audit.mjs`).

### Added

- **Connection diagnostics (*Test connection*).** `GET /endpoints/:id/diagnostics`
  runs read-only checks across the server (RustDesk settings; hbbs 21116, hbbr
  21117, NAT test 21115), the endpoint (heartbeat, device secret, agent and
  RustDesk versions, live hbbs registration, stored-credential state, incoming
  sessions) and the technician's own machine. That last one comes from a
  read-only helper `.cmd` that reports back once with a single-use token, and
  only whitelisted fields are stored. Every check says where the fault is.
  Every suggested fix that would change something is marked as such and never
  runs as part of the test. `…/diagnostics/report` is a redacted text report.
- **Session states tied to evidence.** One state machine
  (`sessions/session-state.ts`) decides every transition, and records which
  source may emit which event. *Client opened* never implies a connection.
  *Connection confirmed* comes from the endpoint agent (it counts RustDesk
  `--cm` processes, and confirms only when exactly one launch can own the
  connection) or from the technician, recorded as theirs. Timeouts give
  *Status unknown*, not success or failure. Duration is recorded only when it
  was measured from a confirmed start to an observed end, and `timingQuality`
  says how any other times were obtained. Terminal states are final: a late
  event is stored with `applied=false` and changes nothing. The 0.19.12
  ownership and 409 guarantees are kept and now go through the same machine
  (`session-transitions.ts` is gone).
- **MSP technician access.** `TechnicianAssignment` and `TechnicianGroup`:
  per business, per capability, optionally per computer, with an optional
  start, expiry and weekly schedule in an explicit time zone. Everything is
  re-evaluated on every request. A technician acting in a business is never
  its owner. The `technicians:manage` platform permission (granted only by a
  Platform Admin) delegates management. Self-service access requests need a
  reason and an expiry. A Business Owner can require approval for their
  business, and can narrow a request but not widen it. A business switcher
  (`rem0te_business` cookie / `X-Rem0te-Business`, honoured only for a
  business reachable right now) and an *All assigned* overview, each business
  queried with its own scope. See `docs/technicians.md`.
- **Customer support requests.** A per-business intake link (random 16-char
  slug; disabled and unknown links look the same), a status link that shows
  only status and the technician's first name, and a claim / hand-off /
  release / complete queue with optimistic concurrency. Matched computers are
  shown only if the viewer can connect to them. Quick Connect can carry
  `supportRequestId`. Abuse limits: 5 per minute per address, 3 open per
  address, 25 open per business, a honeypot and a minimum fill time (both
  answered with a fake success), and the address is stored only as a keyed
  hash. Waiting requests expire after 24 hours; closed ones are anonymized
  after 30 days. See `docs/support-requests.md`.
- **Controlled RustDesk and agent updates.** Rollouts with an exact version
  and the GitHub SHA-256 pinned at creation (or explicit signature-only), pilot
  batches, a maintenance window, deferral during sessions, bounded retries with
  exponential backoff, a failure threshold that pauses the rollout (also
  checked at every batch boundary), verify timeouts with a stated reason, and a
  per-computer history. A job succeeds only on the approved version from an
  authenticated heartbeat plus hbbs registration, or registration recorded as
  *unavailable*. A supported-version pin applies to every installer, Connect
  script and Quick Connect download. Windows only. No rollback; the recovery
  procedure is in `docs/updates.md`.
- **Access review and offboarding.** `GET /endpoints/:id/access-review` lists
  everyone who can connect, how, and whether it works right now (with the
  reason if not), computed by the same rules the connect path uses.
  Offboarding (`/offboarding`, step-up `permissions.change`) previews what will
  be revoked and **which RustDesk credentials the person obtained** (reveals,
  released grants, launcher redemptions; refused reveals excluded), flags other
  computers that share a password, and then revokes. Every refusal is decided
  before the first write. Rotations are shown live and stay *pending* until
  each computer confirms. A Business Owner can suspend an account only if their
  business is all it has. See `docs/offboarding.md`.
- **SSO (OIDC) and passkeys.** Authorization code + PKCE with a browser-bound
  `state` and a `nonce`, via `openid-client`. Accounts are matched by issuer and
  subject only, never by email. Accounts are linked by a signed-in user after
  step-up; provisioning is opt-in, needs a verified email that is not already
  in use, and gives no access unless a group mapping grants exactly one
  business as a Business User. SSO still requires the account's TOTP.
  Passkeys use `@simplewebauthn/server` with user verification required, and
  serve for sign-in (counts as MFA) and step-up. Challenges are single-use, and
  a signature counter that goes backwards is refused.
  `scripts/auth-recovery.mjs` disables SSO, removes passkeys or SSO links, and
  signs an account out, straight from the database. See `docs/sign-in.md`.
- **Step-up authentication** for sensitive actions: a 10-minute token bound to
  the user and the session, earned with a password, TOTP or passkey. Access is
  checked before step-up is asked for.

### Changed

- Password reveal checks access before asking for step-up. Someone with no
  access to the computer is refused outright instead of being asked to
  re-authenticate first.
- `AuthService` sign-in now goes through one path (`startSession`) for
  password, SSO and passkey, so status, lockout and TOTP rules cannot drift
  between methods. A password login for an account with no usable password
  answers 401 instead of throwing.
- The four e2e suites that write fixtures refuse to run against port 3001, 443
  or any `https://` API (from 0.19.12), and the new suites carry the same guard.

### Tests

All run against a scratch API and database (`API_BASE=http://127.0.0.1:3101/api/v1`):

| Suite | Checks |
|---|---|
| `unit-session-mutations.mjs` (in CI) | 30 |
| `e2e-session-mutations.mjs` | 43 |
| `e2e-security-audit.mjs` | 52 |
| `e2e-business-access.mjs` | 83 |
| `e2e-support-requests.mjs` (new) | 47 |
| `e2e-offboarding.mjs` (new) | 62 |
| `e2e-sso-passkeys.mjs` (new; mock OIDC provider + software authenticator) | 70 |
| `e2e-rollouts.mjs` (new; endpoints simulated by heartbeats) | 45 |

The web app was also smoke-tested in Chromium against the same scratch stack:
26 page loads per theme (each new page, plus the changed endpoint, sessions, settings,
account, login and public support pages) rendered as Platform Admin, Business
Owner, technician and anonymous visitor, in light and dark. No page crashed or
threw, and no API call returned 5xx. The only console errors were the 404 for
a deliberately bad support link and 403s on Business Settings, which come from
the platform-settings calls that page already made for a Business Owner before
0.20. This was a render check; the e2e suites above verify the behaviour.

`e2e-offboarding.mjs` caught a real defect before release: a refused account
suspension had already disabled the membership. Validation now runs before
any write.

### Limitations in 0.20.0

- The desktop launcher (Rust/Tauri) is unchanged and was not rebuilt.
- Connection confirmation is a heuristic. It counts `rustdesk.exe --cm`
  processes, so it cannot tell two simultaneous incoming sessions apart; with
  more than one open launch on a computer it confirms neither.
- Staged updates are Windows-only. There is no rollback.
- SSO was tested against a standards-compliant mock provider, not Entra ID,
  Google, Okta or any other real one. There is no single or back-channel
  logout and no SSO-only mode.
- Passkeys were tested with a software authenticator, not a real browser or
  security key.
- The technician-side diagnostics helper and the generated PowerShell were
  parse-checked with PowerShell on Linux but not run on a real Windows machine.
- There is no tray shortcut for customers to open a support request; they use
  the link.
- Someone who holds `technicians:manage` but is not a Platform Admin cannot
  list businesses or computers, so the technician pages ask them to paste
  business and computer IDs. Only Business Owners and Platform Admins can
  decide approvals.
- Removing a technician group also removes that group's assignments. There is
  no way to delete a pilot group or to edit a rollout after it is created, and
  a rollout that names no computers and no businesses targets every managed
  computer.
- An offboarding case stays open (never marked complete) while any of its
  computers is unrotated or the person still has access through a technician
  group. *Pending rotations* has to be scoped to one business.

## [0.19.12] — 2026-11-06 · *Homecoming*

### Security

- **`support:history_view` let a technician change other technicians'
  sessions.** The sessions service used one filter both to decide which
  sessions a person may *see* and which they may *change*. That filter drops
  the "your own sessions only" restriction for anyone with
  `support:history_view`, so `PATCH /sessions/:id/complete`, `/cancel` and
  `POST /sessions/:id/events` accepted a colleague's session from anyone holding
  `computers:connect` plus history view. Reading and writing are now separate.
  The read filter is unchanged. Every write then checks that the caller is the
  session's technician, a Business Owner of its business, or a Platform Admin.
  A session someone can see but not change returns **403**; one they cannot see
  still returns 404. Nothing is written in either case. Quick Connect's
  `end` already had an ownership check and keeps it.
- **A launcher token could be bound to someone else's session, or to a closed
  one.** `POST /launcher/token` with a `sessionId` checked only that the
  session was in the caller's business. Redeeming the token then wrote
  `client_opened` into that session. The session must now belong to the
  caller, be pre-client (pending, launch requested or launcher acknowledged),
  and target the same computer or Quick Connect ID as the token. If not, the
  request returns 404.
- **Closed sessions could be reopened.** `client_opened` on
  `/sessions/:id/events` set `CLIENT_OPENED` and a new `startedAt` whatever
  the session's state. A completed session went back to open, and its
  duration restarted. Launcher redemption refused only `SESSION_COMPLETED`, so
  a canceled or failed session could be reopened by redeeming its token.
  complete and cancel read the status, tested it, then wrote unconditionally,
  so two closes racing each other could both succeed. All allowed transitions
  now live in one table (`sessions/session-transitions.ts`):
  - `COMPLETED`, `CANCELED` and `FAILED` are terminal.
  - `client_opened` applies only before a client has opened.
  - `client_closed` applies only after one has.
  - Any other event name is a timeline annotation, accepted only while the
    session is open.

  Each status change is a conditional `updateMany` whose `WHERE` names the
  allowed from-states. Where an event row is written, the change and the event
  row are one transaction. A late, duplicated or out-of-order event changes
  nothing and returns **409**; so does closing an already-closed session (this
  was 400). Event names must be lower-case identifiers. `startedAt` is written
  once, so a repeated `client_opened` can no longer move the start time or the
  duration.
- **Behavioural tests for these, run in CI.** All 15 static invariant checks
  passed while these bugs were live, so the new tests exercise the behaviour
  directly.
  - `apps/api/scripts/unit-session-mutations.mjs` runs the compiled services
    against an in-memory Prisma double, with no database. It covers 24 cases.
    Against 0.19.11 code, 15 of them fail.
  - `apps/api/scripts/e2e-session-mutations.mjs` covers the same ground over
    HTTP against a scratch API and real Postgres. That includes concurrent
    duplicate events and racing closes. It has 38 checks, and 24 of them fail
    on 0.19.11.

### Fixed

- **Four e2e suites were hard-wired to the production API.** `e2e-smoke`,
  `e2e-full`, `e2e-public-api` and `e2e-business-access` always called
  `127.0.0.1:3001`, while their fixtures went to whatever `DATABASE_URL` named.
  Pointed at a scratch database, they still sent requests to the live API. They
  now read `API_BASE` and refuse port 3001, port 443 or `https://`, the same
  guard `e2e-security-audit` already had.
- The Sessions page now shows the server's reason when a cancel is refused,
  instead of a generic "Failed to cancel session".

### Dependencies

- Rechecked the two accepted dev-tooling advisories. Both remain accepted and
  neither is in the production install (`pnpm why --prod` is empty for both,
  and `pnpm audit --prod` reports none).
  - **deepmerge 4.3.1** (GHSA-gcqx-w48m-w2h4): it is still the latest release,
    and no patched one exists. `@nestjs/cli` 12 would drop it, but it needs
    TypeScript 6, so that upgrade is not taken here.
  - **minimatch 10.2.6** (GHSA-g3hv-75wg-m249): the latest typescript-estree,
    eslint and `@eslint/config-array` still all require 10.x. 11.x removes
    `makeRe` and the `AST` export, so forcing it in is not compatible. The
    reasons are recorded next to each ignore in `pnpm-workspace.yaml`.

## [0.19.11] — 2026-11-02 · *Homecoming*

### Added

- **RustDesk client versions on the dashboard.** Platform Admins now get a
  *RustDesk clients* panel beside the map. It lists every client with its
  online state, installed RustDesk version and update status, shows the latest
  release, and has an **Update** button per row and **Update all**. It is the
  same component as the one on the About page, in a compact layout that scrolls
  inside the panel so the dashboard still fits on one screen. Each client name
  links to its endpoint page.

### Fixed

- **A queued RustDesk update could re-run the installer forever.** A queued
  update only cleared when the endpoint reported *exactly* the queued version.
  The installer installs the latest release, though. An update queued for
  1.5.0 that installed 1.5.1 never matched, so every heartbeat told the
  endpoint to re-run the installer. It now clears once the endpoint reports the
  target version or newer, and stops dispatching once it is there.
- **An update queued before a newer release came out offered no way forward.**
  The row read "Queued to v1.5.0" with only **Cancel**, even after 1.5.1 had
  been released. Those rows are now flagged "(v1.5.1 out)" and also have
  **Update**, which re-queues them for the latest release.

## [0.19.10] — 2026-11-01 · *Homecoming*

### Fixed

- **0.19.8's real upgrade left the RustDesk service stopped.** RustDesk's
  `--silent-install` recreates its service in stages: first as a one-shot
  `"RustDesk.exe" --import-config "<user>\RustDesk.toml"`, which it starts,
  stops and deletes, then as `"RustDesk.exe" --service`. The installer
  stopped waiting the moment the new file version appeared and ran
  `taskkill rustdesk.exe`, killing RustDesk's installer between those stages.
  DS-HOME1's re-run at 22:30 showed it exactly: `service state: STOPPED`,
  `BINARY_PATH_NAME ... --import-config ...`. RustDesk was offline and
  `--password` had no service to reach. This never showed up before 0.19.8
  because `/S` never installed anything. The installer (and Connect's elevated
  repair) now waits until the service reads `--service`, and before every
  service start `Ensure-RdService` recreates the service, or resets its
  command line through CIM, if it is missing or in any other form.
- **The Windows installer could report a password the endpoint never got
  ("wrong password" on Connect).** `rustdesk --password` sets the permanent
  password in the running service over IPC and prints `Done!` only if the
  service accepted it; otherwise it prints the IPC error and writes the
  password into the calling admin's profile, which the service never reads.
  The installer ran it once, four seconds after starting the service, with
  its output thrown away, and reported the new password to Rem0te regardless.
  A service still starting up therefore left the endpoint on its old password
  while Rem0te stored the new one. This is the DS-HOME1 "wrong password" from
  2026-10-31, which became visible again once 0.19.7–0.19.9 cleared the Key
  mismatch in front of it. The installer now retries for up to about 70
  seconds, until RustDesk prints `Done!` or the service's own `RustDesk.toml`
  shows the password changed, and logs a clear warning if it never does.

## [0.19.9] — 2026-11-01 · *Homecoming*

### Fixed

- **The Connect and setup `.cmd` closed instantly (0.19.8 regression).** The
  whole PowerShell script was passed on one `powershell -Command "…"` line.
  0.19.8's elevated repair step made that line ~11,600 characters, and
  cmd.exe refuses any line longer than 8191 ("The input line is too long"),
  so the window closed before anything ran or could be read. hbbs saw no
  connection attempt at all after 22:08. The script now sits after the
  batch section's `exit /b`, under a marker, and a ~280-character loader
  line has PowerShell read it back out of the `.cmd` itself. `wrapCmd()`
  refuses to build any batch line over 2000 characters, so this cannot ship
  again unnoticed.

### Removed

- `apps/api/__APPDATA__/RustDesk/config/RustDesk2.toml`, committed by
  accident in 0.19.8. It was output from a local test of the elevated
  RustDesk repair script, run on Linux, where the `__APPDATA__` placeholder
  was never substituted. It held only the server's public key, which is
  already public, and nothing ever read it. No code or behaviour changes.

## [0.19.8] — 2026-11-01 · *Homecoming*

### Fixed

- **RustDesk was never actually upgraded — not on endpoints, not by the
  installer.** Since v0.4.0 the managed installer ran the RustDesk release with
  `/S`, an NSIS switch RustDesk does not have. RustDesk ignores unknown
  arguments, so on a machine that already had RustDesk nothing was installed;
  the step then waited for `rustdesk.exe` to exist, found the *old* one, and
  carried on. Every staged "update" re-ran the installer and left the endpoint
  on the version it started with (all of them still report 1.4.9 while 1.5.0
  is current). The installer now uses `--silent-install` and waits for the
  installed file's version to reach the target, logging a warning if it never
  does. The update stays staged until the heartbeat reports the new version.
- **"Key mismatch" persisted after 0.19.7.** At 22:08 the technician installed
  the 1.5.0 preconfigured client and clicked Connect; hbbs rejected it again.
  Two things were still wrong on the technician side:
  - Launching a new RustDesk while one is already running hands off to the
    running instance, so the "install" changed nothing — still the old version
    with the `… (1)` key. The portable fallback handed its session to that
    same instance, which is why it failed too.
  - 0.19.7's elevated `rustdesk --config` relies on RustDesk syncing the
    service's settings into the user's file within three seconds; it did not,
    so the repair was judged failed.

  Connect and the setup `.cmd` now check the installed client's version as
  well as its server and key. When any is wrong, one elevated step (single UAC
  prompt) stops RustDesk, upgrades it with `--silent-install` if it is out of
  date, and rewrites the server lines directly in the service's and the user's
  `RustDesk2.toml`, keeping every other setting, then restarts the service.
  Log: `%LOCALAPPDATA%\Rem0te\repair.log`. The cached portable copy is also
  refreshed when a newer release is out, instead of being reused forever.

## [0.19.7] — 2026-11-01 · *Homecoming*

### Fixed

- **"Key mismatch" connecting to DS-HOME1 after reinstalling RustDesk.** The
  error was not about DS-HOME1. hbbs logged
  `Authentication failed from 204.1.21.52 for peer 288409205 - invalid key` at
  21:55:50, thirteen seconds after Connect and half a minute after the
  preconfigured client was downloaded again from Downloads: hbbs checks the
  key of the client *making* the connection, and the technician's freshly
  reinstalled RustDesk had the wrong one. RustDesk splits its filename
  `rustdesk-host=<host>,key=<key>.exe` on commas, so the copy a browser saves
  as `… (1).exe` (it already had the first one) carries the key
  `<key> (1)` — and RustDesk's installer writes that key into the installed
  client's settings, replacing whatever was there.
  - Every config-in-filename name now ends `,.exe` (Downloads, Quick Connect,
    the Connect/setup portable copy, the managed installer's setup file), so a
    ` (1)` suffix is an empty trailing token RustDesk ignores.
  - **`rustdesk --config` never did anything.** Every caller (managed
    installer, Connect `.cmd`, setup `.cmd`, desktop launcher) passed base64 of
    `host=…,key=…`. RustDesk 1.4 only parses a string containing `host=` or a
    *reversed*-base64 licence, so the argument was silently ignored; the
    managed installer only worked because it also writes RustDesk2.toml
    directly. It now passes the plain string, so a reinstall genuinely
    overwrites the previous server and key.
  - `--config` is also ignored unless it runs elevated against an installed
    RustDesk, which the Connect and setup `.cmd`s never were. They now read the
    installed client's server and key, and if either is wrong, apply
    `--config` elevated (one UAC prompt, only when needed; a marker in
    `%LOCALAPPDATA%\Rem0te` prevents repeat prompts). Declining falls back to
    the portable copy, whose filename key takes precedence over any saved
    setting.
  - The Quick Start page's `--config` example used semicolons; RustDesk splits
    on commas. Fixed.

Existing technician machines repair themselves on the next Connect. DS-HOME1
itself still has not checked in since 2026-10-30 and still needs its installer
re-run on site.

## [0.19.6] — 2026-10-31 · *Homecoming*

### Dependencies

Production group (#78):

- **`@anthropic-ai/sdk` 0.135.0 → 1.3.0.** This major moves every request from
  API version `2023-06-01` to `2026-10-21`. The only caller is the device
  timeline summary (`EndpointsService`). It was checked against the
  [migration guide](https://platform.claude.com/docs/en/api/migration-2026-10-21)
  and needs no code change:
  - it sends no `temperature`, `top_p` or `top_k`, no documents and no
    citations, and calls no Admin API;
  - its one message is a `role: 'user'` literal, which type-checks under the
    new per-role `MessageParam` union;
  - it passes a single `apiKey` straight to api.anthropic.com, so moving the
    key from `X-Api-Key` to `Authorization: Bearer`, and the one-credential
    rule, change nothing.

  A request intercepted offline went to the same URL with
  `anthropic-version: 2026-10-21` and the key as a bearer token, and its body
  was byte-for-byte the same; the reply parsed as before. Not checked live:
  production has no `ANTHROPIC_API_KEY`, so the summary is off there. The SDK
  is now Apache-2.0 (was MIT).
- `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express` 11.2.7 → 11.2.8;
  `nanoid` 6.0.1 → 6.0.2.
- Web: `next` 16.4.2 → 16.4.3, `axios` 1.20.0 → 1.21.0 (`follow-redirects`
  stays pinned at ≥1.16.2), `@tanstack/react-query` 5.104.5 → 5.105.0,
  `lucide-react` 1.61.0 → 1.63.0.
- Launcher: `@tauri-apps/plugin-deep-link` 2.6.2 → 2.6.3.

Development only (#69, merged without its own release): `typescript-eslint`
8.71.2 → 8.72.0, `@tauri-apps/cli` 2.12.3 → 2.12.4.

---

## [0.19.5] — 2026-10-31 · *Homecoming*

### Fixed

- **After a reinstall was accepted, Connect said "wrong password."** The
  installer sets a new RustDesk password and reports it once, in the same
  request that offers its device secret. If that secret no longer matched, the
  server rejected the request and dropped the password with it. Pressing
  **Accept this device** brought the heartbeat back but not the password:
  the next accepted request was the installer's registration check, which
  carries none. Connect kept sending the previous password, and the real one
  existed nowhere but on the machine. This is what happened to DS-HOME1 on
  2026-10-30, and the only way back was someone at the machine.

  A rejected heartbeat now keeps the password it carried, AES-GCM encrypted,
  next to its candidate secret (`RustdeskNode.candidatePassword`, migration
  0019). Accept writes it into `permanentPassword` in the same conditional
  update that binds the secret, and reports `passwordUpdated`, which is also
  recorded in the audit entry. The password belongs to its secret:
  - a later request with the same secret and no password leaves it alone;
  - a different secret replaces it;
  - a conflicted candidate can't be accepted, so its password can't be adopted.

  An unauthenticated caller can still only offer a candidate, never decide one,
  and no response returns the column.

  The proof is `apps/api/scripts/e2e-candidate-password.mjs`, run against a
  scratch stack: 14 checks covering the rejected reinstall, the password-less
  check, Accept, the conflict refusal, and the column never appearing in a
  response. `e2e-security-audit.mjs` still passes all 51.

  This doesn't recover a password that was lost before 0.19.5. That machine
  still needs its installer re-run on site.

---

## [0.19.4] — 2026-10-31 · *Homecoming*

### Security

- **follow-redirects 1.16.2** (GHSA-mrwp-f3q8-3g9p, high): custom credential
  headers could follow a redirect to another origin. It reaches the web app
  through axios, so this one ships. Pinned with `'follow-redirects': '>=1.16.2'`.
- **glob 14.0.3** (GHSA-3g3m-2fjr-6pw4, moderate): the override floor moved
  from `>=12.0.0` to `>=14.0.2`. Only @nestjs/cli uses it, at build time.
- **minimatch GHSA-g3hv-75wg-m249 accepted, not fixed.** The only patched
  release is 11.x, with no 3.x or 10.x backport. eslint calls minimatch 3's
  function export, so forcing 11 crashes `pnpm lint`. Every consumer is lint
  or build tooling and none is in a production install. The ignore entry in
  `pnpm-workspace.yaml` gives the reasoning; take it out once eslint moves off
  minimatch 3.

All three advisories were published after 0.19.3 was cut, and they failed its
`audit` job.

---

## [0.19.3] — 2026-10-31 · *Homecoming*

### Fixed

- **A machine RustDesk could reach was shown offline.** `Endpoint.isOnline`
  came only from the Rem0te agent heartbeat, so the two Windows machines left
  with an unreadable heartbeat by the 0.18.22 lockdown read "Offline" on every
  page while hbbs had them registered and Connect reached them (it got as far
  as RustDesk's password prompt). The staleness sweep now also asks hbbs, every
  minute, which RustDesk IDs are registered — the `OnlineRequest` the RustDesk
  client uses for its own online dots, sent to TCP 21115 from a non-loopback
  address (`HBBS_PRESENCE_HOST`/`HBBS_PRESENCE_PORT` override). Registered
  machines are marked online; only machines that are neither registered nor
  heartbeating go offline. `lastSeenAt` is untouched, so a silent agent still
  shows as an old "last seen". If hbbs cannot be asked the old heartbeat-only
  behaviour applies. The sweep moved from every 5 minutes to every minute.

---

## [0.19.2] — 2026-10-30 · *Homecoming*

### Fixed

- **Re-running the Windows installer made the heartbeat unreadable, and the
  machine went quiet.** The 0.18.22 state-directory lockdown ran
  `icacls C:\ProgramData\Rem0te /inheritance:r /grant:r <SID>:(OI)(CI)F /T`.
  `/T` applies that to every file as well as the directories. On a file icacls
  strips the inherited permissions and then rejects the `(OI)(CI)` grant as
  an invalid parameter, so every file already in the directory was left with
  an empty DACL. Nobody could open it, SYSTEM and elevated Administrators
  included. Output went to `$null`, so nothing showed.

  What that did, on both production machines after the 16:10 UTC Update on
  2026-10-30:
  - `heartbeat.ps1` could not be read by the task that runs it. The task kept
    firing every three minutes with **Last Result 1** and sent nothing.
  - `heartbeat.dat` could not be read for the old device secret, so the
    installer made a new one, and could not be rewritten to save it. *This,
    not the "user-owned directory treated as planted" path 0.19.0 fixed, is
    what produced the `secret_mismatch` lockout on these machines.* 0.19.0's
    reordering was sound but could not help: the file it read first was
    already unreadable from the 16:10 run.
  - The installer's registration therefore failed, so it scheduled the
    enrolment retry task with the new secret in a fresh, correctly permissioned
    `enroll.dat`. Those retries were the only heartbeats the server saw from
    then on. They looked like a working agent being refused. Once the secret
    was accepted (20:47 UTC), each retry task's first success deleted it, as
    designed, and the machine went silent. Queued inventory refreshes, update
    scans and the RustDesk 1.5.0 upgrade were never collected, because the
    retry script ignores the response. That is why the Updates page sat at
    "Queued to v1.5.0".

  The lockdown now grants the inheritable entries on the directory alone and
  resets everything beneath it to inherit them (`icacls <dir>\* /reset /T /L`).
  That also repairs a machine already in this state, because the preceding
  `takeown /A` makes Administrators the owner and an owner can always rewrite
  a DACL. `/L` makes the reset act on a planted link itself, not its target.
  The old `/T` grant followed links. The installer then proves every file
  under the directory can be opened, and refuses to continue (exit 3) if any
  cannot, instead of trusting icacls. The previous device secret is now read
  *after* the repair, so a damaged machine keeps the secret it has. `$planted`
  is still decided before ownership changes, and nothing is deleted until
  after the read. The per-file grants on `heartbeat.dat` and `enroll.dat` use
  SIDs instead of the localised names `SYSTEM` and `Administrators`. After
  writing the heartbeat files, the installer logs an error if either one
  cannot be read.

  Recovering a machine already affected means re-running the installer on it.
  **Update** cannot reach it, because its heartbeat is not running. It will
  usually then need **Accept this device** once. See *docs/troubleshooting.md →
  A computer went offline right after Update or Reinstall agent*.

  Checked by parsing the generated installer (with and without a claim token)
  with PowerShell 7.4. The agent's heartbeat script is unchanged, so
  `AGENT_CONTRACT_VERSION` stays at 0.17.0.

## [0.19.1] — 2026-10-30 · *Homecoming*

### Security

- **The multer pin did not reach the copy Nest loads.** The generated target
  manifest folds a pin on a direct dependency into that dependency's range,
  because npm refuses an override that disagrees with one (EOVERRIDE). It then
  deleted the override, so the pin bound only the top-level copy.
  `@nestjs/platform-express` depends on multer at an exact version, so after
  0.19.0's `npm install` the target held `multer@2.5.0` at the top level and
  the vulnerable `2.4.0` nested under platform-express. That nested copy is the
  one Nest actually requires. The override is now emitted as `"$multer"`, npm's
  reference to the direct dependency's own range, which binds nested copies
  too and is accepted. Same for `nanoid`. Checked against the lockfile npm
  resolves: one multer, 2.5.0.

---

## [0.19.0] — 2026-10-30 · *Homecoming*

### Fixed

- **"Update" took Windows computers offline for good.** Staging a RustDesk
  update tells each machine to re-run the installer. On a computer first
  enrolled before 0.18.22, that re-run deleted its own device secret: the
  0.18.22 state-directory hardening runs before the secret is read, and it
  treats a `C:\ProgramData\Rem0te` created by the user who ran the original
  install as planted and empties it. The installer then generated a new
  secret. The server still held the old one and refused every heartbeat after
  that (`ENDPOINT_HEARTBEAT_REJECTED`, `reason: secret_mismatch`). So the
  machine showed offline, never reported the new RustDesk version (which is why
  "the update did nothing"), and could not be reached with one-click Connect,
  because the same run had set a RustDesk password the server never got. Both
  production machines went this way at 16:10 UTC on 2026-10-30.

  The installer now reads the previous secret *before* the directory is
  cleaned. Whose file it came from only matters on a run that carries a claim
  token: a claim binds whatever secret is sent, so a file a non-administrator
  could have written is still not trusted then. Without a token nothing is
  bound. The server compares the secret with the one it already holds, so a
  planted value can only fail. The block was parsed with PowerShell 7.4 and
  run against all four combinations of planted/trusted and token/no token.

- **Archived computers were included in "update all".**

### Added

- **Recovery for a computer whose device secret changed.** A rejected
  heartbeat's secret is now remembered on the node (migration 0018), and the
  computer's Overview tab says it is calling in with a new secret, from which
  address and when. **Accept this device** binds it
  (`POST /endpoints/:id/accept-device-secret`, `computers:edit`, audited as
  `ENDPOINT_DEVICE_SECRET_ACCEPTED`). Before this, the only way back was to
  re-run the installer at the machine with a claim token, on a machine nobody
  could now connect to. Acceptance is refused when the secret has not been
  offered in the last 15 minutes. It is also refused when two different
  secrets were offered for the RustDesk ID while one was live, because someone
  who knows the ID can offer a secret too, but cannot stop the real machine
  from offering its own. That conflict clears only after one secret has been
  offered alone for an hour. The bind is a conditional update on the
  candidate it checked, and a heartbeat that matches the bound secret again
  discards any candidate.

- **Restore for archived computers** (`PATCH /endpoints/:id/restore`,
  `computers:remove`, audited as `ENDPOINT_RESTORED`). Archive was one click
  with no confirmation and no way back. It now asks first, and an archived
  computer's page offers Restore instead. Grants the archive deleted are not
  recreated, because nothing recorded them.

### Security

- **Production dependency advisories published since 0.18.25** (raised in
  `pnpm-workspace.yaml` overrides): `body-parser` 2.4.0 and `multer` 2.5.0
  (both high, request-handling DoS), `qs` 6.17.1 and `fast-uri` 3.1.9 (four
  advisories, still held below 4.x). `deepmerge` (GHSA-gcqx-w48m-w2h4, low) has
  no patched release and is reached only through `@nestjs/cli`'s build, so it is
  ignored with a reason, like `braces`. The target's `package.json` is
  regenerated and `npm install --omit=dev` re-run on deploy.

---

## [0.18.25] — 2026-10-23 · *Handshake*

### Changed

- **The computer timeline summary moves from `claude-opus-4-6` to
  `claude-opus-5-5`.** The request changes with the model, not just the ID:
  - **`max_tokens` 1024 → 16000.** Thinking is always on for Opus 5.5 and
    counts toward `max_tokens` even though its text is not returned, so a
    limit sized for a model without thinking can cut the summary off
    mid-paragraph. The reply is still two to four paragraphs.
  - **Effort set explicitly to `medium`.** That is Opus 5.5's default; it is
    written down because Opus models before it defaulted to `high`.
  - **Refusals.** A safety-classifier decline now comes back as
    `stop_reason: "refusal"`. The request opts into server-side fallbacks
    (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`), so a
    decline is retried on the model Anthropic recommends for its category.
    If the whole chain declines, or the reply has no text, the API returns
    an error and keeps the previous summary. Before, it would have saved an
    empty one.
  - The text is found by block type, since the reply can now open with
    `thinking` blocks.

  Only runs where `ANTHROPIC_API_KEY` is set; without it the endpoint still
  answers "not configured", as before.

---

## [0.18.24] — 2026-10-22 · *Handshake*

### Security

- **A Business Owner's "reset access" left the user signed in.** Reset is
  for an account believed compromised: it blanks the password, turns off
  every MFA method, sets the user back to `INVITED` and issues a fresh
  invitation. It did not end the user's sessions. The JWT strategy refuses
  `DELETED` and `SUSPENDED` accounts but not `INVITED`, and this was the one
  credential change 0.18.22 missed when it added `User.sessionsValidAfter`
  to sign-out, password change and reset, and MFA changes. So whoever was
  signed in when the owner reset the account stayed signed in until the
  token expired. `resetUserAccess` now sets `sessionsValidAfter` in the same
  transaction. Draft #47 (2026-10-02) had raised the same class of problem
  for password resets, and its approach of tying each session to the stored
  password hash would have caught this one too.
- `e2e-security-audit.mjs` gains a check (now 51): an owner resets a user,
  and the session that user held before the reset is refused. It fails
  against 0.18.23 and passes here. It runs last and reuses an existing
  fixture session instead of signing in, because login allows 10 attempts a
  minute per IP and the suite is already at that budget. One more sign-in
  anywhere earlier starves the MFA section's `startMfa()` of a partial
  token, which shows up as a confusing 401 on "a fresh code signs in".

API only; no schema change, no dependency change. Deploy `dist` and restart.

---

## [0.18.23] — 2026-10-22 · *Handshake*

### Security

- **`next` 16.3.8 → 16.4.2** clears three advisories published on
  2026-10-22, all affecting every 16.x up to 16.4.0 and fixed in 16.4.1:
  GHSA-2464-fhr4-w9xw (critical: unauthenticated RCE in the Image
  Optimization API when SVG files are used), GHSA-673q-mjm6-r5xr (critical:
  unauthenticated RCE in `use cache` functions returning typed arrays) and
  GHSA-p3m5-59mp-jv5r / CVE-2026-94482 (high: DoS in the App Router via
  Server Actions). The web app has no `use cache` functions and no server
  actions of its own, but `/_next/image` is live on every install, so the
  SVG one is a real exposure. They were not caught by the `audit` job when
  0.18.22 shipped because they had not been published yet. Dependabot's
  production group happened to carry the fix.

### Dependencies

Dependabot's production group (#58) and the Windows installer's Go module
bump (#57), released together. No code changes.

- **`next` 16.4.2**, the move to the 16.4 line that 0.18.19 held back.
  React and React DOM 19.3.1, TanStack Query 5.104, lucide-react 1.61 and
  the Radix primitives move with it.
- **API:** `@nestjs/*` 11.2.7, `@nestjs/throttler` 6.7.1, `zod` 4.6.7, and
  `@anthropic-ai/sdk` 0.125 → 0.135. The SDK's one call site, the device
  timeline summary, uses only `messages.create` and is unaffected.
- **`nanoid` spec ^5 → ^6** is not a real upgrade: the workspace override
  `nanoid >=5.1.7` already resolved 6.0.1 everywhere, and the API never
  imports it.
- **Launcher:** `@tauri-apps/api` 2.12, `plugin-deep-link` 2.6.
- **Windows installer:** `golang.org/x/sys` 0.48.0 → 0.49.0. The served
  binary is rebuilt.
- Also folded in, per the devDependency rule: the development group (#62),
  10 updates: `typescript-eslint` 8.71, `eslint-plugin-security` 4.2,
  `eslint-config-next` 15.5.28, Playwright 1.64, `@tauri-apps/cli` 2.12,
  `marked` 18.1, `@vitejs/plugin-react` 6.1.2.

Checked against a scratch database before release: `security-regression`,
`e2e-smoke`, `e2e-full`, `e2e-public-api`, `e2e-business-access` (82/82)
and `e2e-security-audit` (48/48) all pass.

**Deploying this needs the full production-dependency procedure:** regenerate
the manifest (`pnpm deploy:manifest`), run `npm install --omit=dev` at the
target, and rebuild and redeploy the web standalone for `next`.

---

## [0.18.22] — 2026-10-22 · *Handshake*

### Security

A full security review on 2026-10-22, the first since 0.13.0, found 3
critical, 3 high, 9 medium and a dozen low issues. All are fixed here. Each
one has a check in the new `scripts/e2e-security-audit.mjs` (48 checks) or in
`check-security-invariants.mjs`, and the write-up is in
`docs/SECURITY-AUDIT.md`.

**Upgrading a server installed before this release takes manual steps.** The
sudo wrappers, the web unit's loopback binding and the Caddy changes all live
in files the installer owns. See *Upgrading a server installed before 0.18.22*
in `docs/setup.md`.

#### Critical

- **A managed computer could run commands on the technician's PC.** The
  Connect `.cmd` put the hostname a device reports about itself into a
  `title` line and `rem` comments. cmd.exe parses those for `&`, `|`, `^` and
  `%`, and the old filter let all four through. A hostile enrolled machine
  that called itself `PC&powershell -e …` ran that payload as whichever
  technician next clicked Connect, Platform Admins included. `buildConnectCmd`
  now reduces the name and the RustDesk ID to `[A-Za-z0-9._ -]` itself, so the
  fix holds whatever its caller passes. `ClaimEndpointDto`, which had no
  bounds at all, now requires a numeric `rustdeskId` and length-limits every
  field.
- **The API's service account could become root.** sudoers allowed `dpkg -i`
  on two `.deb` paths in a directory owned by `reboot`, so anything running as
  that user could drop a package with a malicious `postinst` there and install
  it. The SHA-256 check ran in the same process it was meant to guard against.
  RustDesk server upgrades now go through
  `/usr/local/sbin/rem0te-rustdesk-server-upgrade`, a root-owned wrapper. It
  downloads the official packages itself, into a directory only root can
  write, checks the digests GitHub publishes, and only then runs dpkg. The
  caller picks a version but never the bytes.
- **Any local user on a managed Windows PC could get SYSTEM.**
  `C:\ProgramData\Rem0te` is where a SYSTEM scheduled task runs
  `heartbeat.ps1` every three minutes, and it holds the agent secret.
  `New-Item -Force` on a folder that already exists changes nothing, so a
  standard user who created the folder (or the script) first stayed its owner
  and could edit the script. The installer now locks the folder down before it
  writes anything: it removes a junction in its place, takes ownership,
  restricts it to SYSTEM and Administrators by SID, and verifies the result,
  refusing to continue otherwise. Anything a non-administrator could have
  planted is deleted; what a previous install wrote survives, so the machine
  keeps its identity. Downloads are staged inside that folder instead of
  `$env:TEMP`, which on the SYSTEM reinstall path is `C:\Windows\Temp`. The
  RustDesk client is now pinned to the SHA-256 GitHub publishes for that
  release, falling back to a required valid Authenticode signature when the
  server cannot reach GitHub. Before this it was run without any check.

#### High

- **One business could capture another business's computer password.** A
  Business Owner could create a computer using another business's RustDesk ID
  (IDs get read out over the phone). When that machine's real installer ran,
  its claim failed, the heartbeat fallback bound the first secret it saw, and
  the machine's secret and permanent password landed on the attacker's record.
  Typing in a RustDesk ID is now Platform Admin only. The duplicate-ID errors
  also no longer reveal whether an ID exists on another business.
- **The fail2ban sudo rules admitted a root shell.** In sudoers `*` also
  matches spaces, so `set [a-zA-Z0-9_-]* banip …*` matched
  `set <jail> action <a> actionban '<cmd>' banip 1`. Anchored sudoers regexes
  need sudo 1.9.10, and Ubuntu 22.04 ships 1.9.9, so every fail2ban call now
  goes through `/usr/local/sbin/rem0te-f2b`. That root-owned wrapper accepts
  one exact argument shape per operation the API performs and refuses
  everything else.
- **The served Windows installer predated the 2026-08-31 fix to its own
  source.** That fix (https-only, no shell metacharacters in the patched URL)
  never reached the binary, which was built in March with Go 1.22.2. Rebuilt
  with Go 1.26.10, which `go.mod` now names, so CI builds with the same
  toolchain.

#### Medium

- **Open redirect after sign-in.** `returnTo=/%09/evil.example` passed the
  pattern check, because the URL parser strips the tab, and so did
  `/..//evil.example`. The value is now resolved the way the browser will
  resolve it, and used only if it stays on this origin and is not
  protocol-relative.
- **TOTP brute force was limited per IP only, and a code could be replayed.**
  Five wrong codes now lock that account's second factor for 15 minutes,
  whatever address they come from. Each accepted code's time step is recorded
  (`UserMfaMethod.lastTotpStep`) with a conditional update, so a code works
  once.
- **Starting a new TOTP setup switched active MFA off without a code.** It is
  refused while MFA is on; turning MFA off takes a current code. A Business
  Owner can also no longer reset their own MFA through
  `POST /users/:id/mfa/reset`.
- **`computers:edit` skipped per-computer grants.** Revealing, setting or
  rotating a password, and minting a launcher token, now need the same reach
  as connecting. Making a computer company-wide needs `users:manage`.
- **`GET /businesses/:id` listed every computer and RustDesk ID to a member
  with no capabilities.** The list now requires `computers:view`.
- **A note could be attached to another business's session**, and **a
  computer could be pointed at another business's site.** Both ids are now
  checked against the business.
- **Claim tokens could be redeemed twice under a race.** The token is consumed
  by a conditional update before anything else happens, and handed back if
  the claim fails. A claim also has to prove the existing device secret before
  it adopts or replaces a computer in the unassigned pool.
- **A node with no device secret was claimed by whoever heartbeated first.**
  Heartbeats no longer bind a first secret; only a claim does. Production had
  no such nodes. Elsewhere they keep reporting online and can be re-bound
  with *Make an enrollment link for this computer*, now on their Specs tab.
  That link is a token minted for that computer, and only such a token may
  re-claim an existing RustDesk ID. Password rotation is refused for these
  nodes until then.

#### Low

- **Sessions can be revoked.** Signing out, changing your password, turning
  2FA off, and an admin password or MFA reset now end the account's sessions
  (`User.sessionsValidAfter`). Before, a token stayed valid for its full eight
  hours whatever happened to the account. **Signing out now signs out every
  device**, because there is no per-token record to end just one. A password
  change hands the current browser a replacement session. JWT time is in
  whole seconds, which is handled in `auth/session-revocation.ts`.
- **Changing your email address needs your current password.**
  `PATCH /auth/profile` and `POST /auth/change-password` have real DTOs.
  Before, the inline types meant nothing was validated.
- **API keys stop working when their creator stops being a Business Owner**
  (suspended, demoted or removed).
- **Launcher:** a token's `sessionId` must belong to the caller's business,
  ad-hoc tokens obey Quick Connect's platform and business switches, and
  `?token=` is no longer accepted, because a query string lands in Caddy's
  access log.
- **The device heartbeat tells an unauthenticated caller nothing** about which
  record an ID belongs to. `confirm-rotation` and `grants/redeem` have DTOs.
  Two unused, unauthenticated rotation helpers in `EndpointsService` were
  deleted.
- **Logo uploads are raster only**, and the file extension comes from the
  MIME type, never the uploaded name. SVG was served same-origin, and a file
  named `.html` but declared as `image/png` was stored and served as HTML.
  Caddy now serves `/uploads` with a sandboxing CSP.
- **The console has a Content-Security-Policy** and no longer sends
  `X-Powered-By`.
- **Deployment:**
  - Next.js listens on `127.0.0.1` instead of `0.0.0.0`.
  - The plain-HTTP site on the server's LAN IP is a redirect to the domain;
    it used to serve sign-ins in cleartext.
  - The installer enables ufw: default deny inbound; SSH on sshd's actual
    port, 80, 443 and RustDesk's ports allowed.
- **Dependencies:** `follow-redirects` 1.16.1 (two high advisories, via axios
  in the web app; lockfile only). Folded in from devDependencies: `vite`
  8.3.3 for the launcher (six advisories).

---

## [0.18.21] — 2026-10-10 · *Handshake*

No production code changes.

### Changed

- **`.github/SECURITY.md` names an email address** — agit8or@gmail.com — as
  the fallback for anyone who cannot use GitHub's private vulnerability
  reporting. Until now the policy offered no address at all, which also meant
  the OSS Scanner enrolment triage (anthropics/oss-scanner#363) had nothing to
  check its `primary_contact` against. Private advisories remain the preferred
  route.

---

## [0.18.20] — 2026-10-10 · *Handshake*

No production code changes. The Dockerfile builds on 0.18.19's clean dependency tree.

### Added

- **`.oss-scanner/` — build and threat model for Anthropic's OSS Scanner.**
  The free scanner (github.com/anthropics/oss-scanner) clones this repository,
  builds `.oss-scanner/Dockerfile` with network access, then audits the image
  with none. So the Dockerfile fetches everything up front: the pnpm workspace,
  Prisma's engines, the Inter font `next build` pulls from Google, Go modules
  for the Windows installer and Rust crates for the Tauri launcher.

  `start-services.sh` brings up Postgres, Redis and the built API on loopback
  inside that image, so the e2e suites — `e2e-business-access.mjs` above all —
  run offline and give the scanner a working two-business harness. The secrets
  it uses are random values generated during the image build; nothing in
  `.oss-scanner/` is production configuration and nothing there is deployed.

  `threat_model.md` states what the scanner should treat as untrusted, the
  invariants that must hold, and how findings are rated. Its central point:
  **the business is the boundary**, so a cross-business read by any logged-in
  user is High, not "post-auth, therefore low". It can be edited at any time
  without touching the enrolment.

  The Rust launcher compiles in that image on a best-effort basis, and a
  failure there is a warning rather than a failed build — CI still does not
  build `src-tauri` (see 0.18.18).

---

## [0.18.19] — 2026-10-10 · *Handshake*

### Security

`pnpm audit` went from clean to 18 advisories (2 critical, 8 high) between
0.18.18 and now without a line of this repository changing — every one was
published after 2026-09-18. The `audit` job is a required check, so `main` was
unmergeable until this landed.

- **`next` 16.3.5 → 16.3.8.** Clears GHSA-vcvr-r3jv-pc5j (critical: remote
  code execution in `next/og` `ImageResponse`, fixed in 16.3.6) and six later
  advisories fixed in 16.3.8. Stays on the 16.3 line on purpose; 16.4 is a
  separate change.
- **`proxy-addr` >=2.0.8** (override). Critical, GHSA-jqcg-44mw-7w3h:
  IPv4-mapped IPv6 addresses matched trust subnets they are not in. This is
  the library behind Express's `trust proxy`, which is what `TRUSTED_PROXIES`
  configures — so it is the one in this batch that touches the API's own
  security model, not just a dependency's.
- **`fast-uri` back to `^3.1.1`.** The previous override, `>=3.1.1`, was
  unbounded, and had quietly lifted ajv's declared `fast-uri ^3` onto 4.1.3 —
  the version carrying GHSA-qw65-cvwx-89v3, GHSA-58mr-gqgx-xq4g and two more,
  all of which exist only in 4.x. The same trap the `ajv` override's comment
  already warns about. Now resolves 3.1.8.
- **`sharp` >=0.35.5** (raised from >=0.35.0; GHSA-wq5f-xc86-pv6w),
  **`brace-expansion` >=5.0.12** (raised from >=5.0.9; three advisories) and
  **`source-map-js` >=1.2.2** (GHSA-68fv-2mgg-jv7q; launcher build only).
- **One advisory accepted, not fixed:** `braces` <=3.0.3, GHSA-vfj7-8cjw-p6xm
  (stack exhaustion on nested patterns). No patched release exists. It is
  reached only through `eslint-config-next` → `fast-glob` → `micromatch`, i.e.
  the lint run over this repository's own globs, and is absent from every
  production install. Recorded under `auditConfig.ignoreGhsas` in
  `pnpm-workspace.yaml` with that reason; remove it when `braces` ships a fix.

**Deploying this needs the full production-dependency procedure**, not a
`dist` rsync: regenerate the manifest (`pnpm deploy:manifest`) — it now carries
the new overrides — and run `npm install --omit=dev` at the target, or the API
keeps running on `proxy-addr` 2.0.7. Rebuild and redeploy the web standalone
for `next`.

---

## [0.18.18] — 2026-09-18 · *Handshake*

No production code changes.

### Changed

- **`cargo`, `gomod` and `github-actions` move to weekly too**, joining npm.
  They are staggered across the week rather than all landing on Monday — npm
  Monday, cargo Tuesday, gomod Wednesday, actions Thursday — so a week's
  updates arrive as a few small pull requests on separate days instead of one
  pile.

  One caveat is recorded in the config next to the cargo entry, because it
  changes how those pull requests should be read: **nothing in CI compiles the
  Rust side.** The `installer` job cross-compiles the Go installer and the
  launcher job builds only the launcher's TypeScript, so a cargo bump arrives
  with a green check that says nothing about whether `src-tauri` still builds.
  That is the same trap the Go installer was in until 0.18.11, when a
  `golang.org/x/sys` bump sat open for three days behind a check that proved
  nothing. Weekly cargo updates mean meeting that situation more often, not
  less — treat them as unverified until CI grows a Rust toolchain and the
  webkit2gtk system libraries.

- `@types/node` 26.5.1 → 26.6.0 (#40). A devDependency, folded into this
  release rather than given one of its own — the first application of the
  policy added in 0.18.16.

---

## [0.18.17] — 2026-09-18 · *Handshake*

No production code changes.

### Changed

- **Dependabot's npm entry moves from `monthly` to `weekly` (Mondays).** This
  only works because of the release policy added in 0.18.16 — a
  devDependency-only merge folds into the next release instead of getting its
  own. Weekly without that policy is a weekly
  branch-PR-CI-tag-release-restart cycle to record a change that cannot reach
  production. With it, updates arrive weekly and releases stay tied to things
  that ship.

  The three groups are what make the cadence tolerable: one pull request for
  production dependencies, one for development, one for the version-locked
  `prisma`/`@prisma/client` pair — not one per package.

  `cargo`, `gomod` and `github-actions` stay monthly. They are small, they
  move slowly, and neither of them produced the churn this addresses.

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
