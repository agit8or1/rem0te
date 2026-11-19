# Readiness: what works, and how we know

This page says, feature by feature, what Rem0te does on each kind of computer,
who enforces it, and **what evidence there is that it works on a real
machine**. A feature is not called ready because its API exists, or because a
simulator passed. It supersedes the capability and gap tables in
[capabilities.md](capabilities.md), [rmm-gap-analysis.md](rmm-gap-analysis.md)
and [implementation-status.md](implementation-status.md) wherever they
disagree; those pages are being brought in line with it.

Audited at v0.68.0 (2026-11-19). Re-audit with each minor release.

## Evidence levels

From strongest to weakest. Each row in the matrix names the strongest it has.

| Level | Meaning |
|---|---|
| **Lab** | A controlled test on a disposable real machine, with a recorded result. **Nothing has this level yet.** |
| **Fleet** | Seen working on the production fleet (below) and recorded in the database or the changelog. Real, but not controlled: one run, on whatever the machine happened to be doing, with no negative cases. |
| **Runner** | Go tests on GitHub's `windows-latest` / `macos-latest` runners. Today these run only the agent's **portable** packages; none of the code that calls a Windows API directly (service control manager, Windows Update, the registry, the tray host) has a test that runs there. |
| **Sim** | End-to-end against the real API and a scratch database with `rem0te-action-sim`: the agent's real Go decision code against a fake service manager, Windows Update, registry, winget and session list. |
| **pwsh** | Generated PowerShell parsed, or run against stub cmdlets, under PowerShell 7 on Linux. Not Windows PowerShell 5.1, not as SYSTEM. |
| **API** | End-to-end against the real API, with the test posting what an agent would. No agent code runs. |
| **Unit** | Pure-function tests. |
| **None** | No evidence. |

## The production fleet

Four real Windows computers, all on the signed agent. This is the only
real-machine evidence there is, and it is observational.

| Computer | OS | Build | Agent | Enrolled |
|---|---|---|---|---|
| DESKTOP-4SADDCN | Windows 11 Pro | 26100 | signed 0.64.0 | 2026-08-25 |
| DS-HOME1 | Windows 10 Pro | 19045 | signed 0.67.0 | 2026-08-27 |
| DEWEY-WKS2022 | Windows 11 Pro | 22000 | signed 0.64.0 | 2026-11-13 |
| DSLAPTOP-2021 | Windows 11 Pro | 22631 | signed 0.67.0 | 2026-11-19 |

No Windows Server, Linux or macOS computer has ever been enrolled. The two at
0.64.0 pick up the current agent at their next daily signed update check (they
last checked before 0.65 was published): **a published agent can take up to a
day to reach a computer.**

What the fleet's records show worked (read from the production database
2026-11-19, read-only):

| Feature | Real results | Where |
|---|---|---|
| Heartbeat, online/offline, live sample | continuous since 2026-08-25 | all four |
| Inventory pass (`INVENTORY_REFRESH`) | 430 succeeded, 2 expired | all four |
| Update scan (`UPDATE_SCAN`) | 218 succeeded, 1 expired | all four |
| Event log query | 2 succeeded (2026-09) | |
| Diagnostics: processes, services, network adapters | 9 completed, 4 expired | DESKTOP-4SADDCN, DEWEY-WKS2022, DS-HOME1 |
| Diagnostics: pending updates, service health | 1 each | DEWEY-WKS2022, DS-HOME1 |
| Monitoring: event-log rule raised a real alert | 1 (the disk-errors false positive fixed in 0.66) | DS-HOME1 |
| Monitoring: update-failure alerts from signed patch history | 2 open | |
| `windows.update.install` (direct mode) | 1, **restart required**; the restart itself not yet recorded | DEWEY-WKS2022, 2026-11-14 |
| `windows.software.remove` | 1 succeeded | DS-HOME1, 2026-11-14 |
| Signed agent automatic update | 10 updated; plus 17 standard-agent updates before migration | DEWEY-WKS2022, DS-HOME1 |
| Migration standard → signed | 9 completed (1 by hand, 8 automatic), 2 cancelled | |
| Tray self-help (`net.test`, `net.details`) | 2 succeeded | DEWEY-WKS2022 |
| Chat | 2 conversations, 5 messages | |
| Remote sessions (RustDesk via Connect) | 109 completed, 12 failed, 3 cancelled, 2 unknown | |
| Enrolment through Add device (0.68 fixes) | 1, inventory 3 min after enrolment | DSLAPTOP-2021 |

Never exercised on the fleet: service control, End process, maintenance
actions (Spooler, service restart, log collection), restart scheduling and
restart windows, script runs, automation schedules, software install or
uninstall, containment pauses, PSA tickets, chat files, support requests, the
`.msi`, warranty lookups, SSO.

## Capability matrix

**Std** standard agent (PowerShell scheduled tasks) · **Sgn** signed agent
(`rem0te-agent.exe`) · **Lin / Mac** the POSIX shell agents, which only read
(they act on `INVENTORY_REFRESH`, `UPDATE_SCAN`, and answer `EVENT_LOG_QUERY`
"Windows-only").

**Enforced by:** *portal* (the API refuses), *signer* (the separate approval
signer signs or refuses), *agent* (the endpoint verifies the signed plan and
refuses on its own).

| Feature | Std | Sgn | Lin | Mac | Enforced by | Strongest evidence | Readiness |
|---|---|---|---|---|---|---|---|
| Enrolment, device secret, Add device | Yes | Yes | Yes | Yes | portal; Sgn verifies its update chain | Fleet (Win); API (Lin/Mac) | Windows: in use. Linux/macOS: unverified (never installed as root, never under systemd/launchd) |
| `.msi` package | — | Yes | — | — | portal | Unit (built and read back on Linux) | Unverified: never run on Windows |
| Heartbeat, online/offline, agent silent | Yes | Yes | Yes | Yes | portal | Fleet (Win) | Windows: in use |
| Hardware, OS and software inventory | Yes | Yes | HW/OS | HW/OS | — | Fleet (Win); recorded output (Mac) | Windows: in use. macOS only against recorded output |
| CPU, memory, disk and their history | Yes | Yes | Yes | Yes | — | Fleet (Win) | Windows: in use |
| Monitors: offline, disk, CPU, memory, uptime, agent silent | Yes | Yes | Yes | Yes | portal | Fleet (Win) | Windows: in use |
| Monitors: service stopped, event log (with 0.66 classification, 0.67 quality rules) | Yes | Yes | No | No | portal; charset check in agent | Fleet (one real event alert) | Windows: partly proven; the five-sample block (0.66) unverified |
| Monitors: updates missing / update failed | No | Yes | No | No | portal | Fleet (2 alerts) | Windows signed: in use |
| Patch scan | read-only | Yes, with other-manager detection | from cache | last result | — | Fleet (218 scans) | Windows: in use. WSUS/Intune detection: Sim only |
| Patch install (deployments, policies, all at once or canary) | No | Yes | No | No | **signer + agent** | Fleet (1 install, direct mode) | Partly proven: one install, restart pending; rings, canary gate, signed results: Sim only |
| Restart scheduling, restart windows, in-window restart after updates | No | Yes | No | No | signer + agent | Sim | **Unverified: has never restarted a real computer** |
| Software install / uninstall (winget, pinned hash) | No | Yes | No | No | signer + agent | Sim | Unverified |
| Remove an installed program | No | Yes | No | No | agent (reads key, recognised forms only) | Fleet (1 removal) | Partly proven: one MSI-or-quiet form; Inno/NSIS/Chromium forms Sim only |
| Scripts (`script.run`), automation schedules | No | Yes | No | No | signer + agent | Sim with pwsh 7 | **Unverified under Windows PowerShell 5.1 as SYSTEM** |
| Service control, End process | No | Yes | No | No | signer + agent | Sim | Unverified; the Windows code has no test that runs on Windows |
| Maintenance actions (Spooler, service restart, logs) | No | Yes | No | No | signer + agent | Sim | Unverified |
| Diagnostics catalog, snapshots | Yes | Yes | No | No | portal | Fleet | Windows: in use |
| Remote access (RustDesk launch, presets, grants) | Yes | Yes | Yes | Yes | **portal only** | Fleet (109 sessions) | In use, with the limits below |
| Password rotation, reinstall, RustDesk update | Yes | Yes | No | No | portal stages, agent applies | Fleet | In use |
| View-only, consent, clipboard, file transfer, ending a session | No | No | No | No | portal refusal only | API (enforcement simulated) | **Not enforceable today** (below) |
| Chat, tray, self-help | Yes (3 read-only tools) | Yes | No | No | portal + pipe DACL | Fleet (2 tools, 2 chats) | Partly proven; chat files, elevated self-help unverified |
| Support request → PSA ticket | Yes | Yes | No | No | portal | API (stub PSA) | Unverified: no real PSA called |
| Agent auto-update, migration to signed | Yes | Yes | No | No | portal; Sgn verifies signatures | Fleet | In use; first real migrations failed (0.37.3 BOM) before this worked |
| Containment pauses | portal | portal + **signed pause checked by agent** | portal | portal | portal + signer + agent (Sgn) | Sim; never used on the fleet | Unverified on a real machine |
| Unassigned pool, deployment keys, adoption | Yes | Yes | Yes | Yes | portal | API | Server-side; GPO/Intune/RMM deployment methods never run |
| Warranty (Dell, Lenovo, HP, Apple) | any | any | any | any | portal | API (stand-ins) | Unverified: no vendor API called |
| AI, PSA connectors | — | — | — | — | portal | API (stubs) | Unverified: no provider or PSA called |
| ClientSt0r integration | — | — | — | — | portal + signer | API (reference peer) | **Does not interoperate with real ClientSt0r** (HMAC vs Ed25519) |
| SSO (OIDC/Keycloak) | — | — | — | — | portal | API (mock IdP) | Unverified: no real IdP |
| Audit chain | — | — | — | — | database trigger + verifier | Unit, API | In use; detects tampering, cannot prevent a full rewrite without an export |

## Remote access: what the portal cannot enforce today

From [security-model.md](security-model.md), [offboarding.md](offboarding.md)
and [connecting.md](connecting.md). None of it is a regression; all of it is
the RustDesk architecture as shipped.

1. **The permanent password works outside Rem0te.** The installer sets
   `use-permanent-password`. Anyone who has seen it can connect with any
   RustDesk client pointed at the server, and no session record is made.
2. **Revoking access does not revoke a seen password.** It stops new launches
   through Rem0te at once. Rotation is staged and applied at the next
   check-in; until then the old password works, and an offline computer stays
   exposed. Linux and macOS cannot be rotated from the console.
3. **View-only and consent are not enforced by the endpoint.** For preset
   technicians the portal refuses them (`endpoint_cannot_enforce_view_only`,
   `_consent`), so nothing weaker is substituted. For owners and admins they
   are "not applied".
4. **Clipboard and file transfer** are RustDesk client toggles; Rem0te
   enforces neither.
5. **The portal cannot end a session**, and session length is advisory.
6. **Session evidence is thin.** "Connection confirmed" counts
   `rustdesk.exe --cm` processes; there is no record of what was done.

These are design problems, not test gaps: Phase 2 of the roadmap.

## Where the documentation is wrong today

To be corrected in the next documentation release:

- **Understated:** `capabilities.md`, `rmm-gap-analysis.md` and several
  invariants in `CLAUDE.md` say the signed agent, its patch install, removal,
  monitoring and migration have "never run on real Windows", and that
  production has no signer or signed agents. The fleet records above say
  otherwise (observationally).
- **Overstated or stale:**
  - `rmm-gap-analysis.md` (written at 0.30): a two-action catalog (now 12), no
    diagnostics catalog, no compliance report, unsigned ring results, no
    script scheduling, AI only via ClientSt0r. All since changed.
  - `security-model.md` and `integration-clientst0r.md` still say Rem0te has
    no AI provider endpoint or key (reversed in 0.48), and that patching
    always canaries with two approvers (all at once is the default since
    0.62; direct mode since 0.40).
  - `implementation-status.md` is a 0.54 snapshot.
  - The CI comment on `agent-real-os` says service and launchd code meets a
    real OS. There is no launchd code, and the Windows service code is not
    run there.

## Roadmap, in dependency order

Each step is its own release with tests and docs. Nothing in it relaxes the
approval signer, the signed plans, containment or tenant isolation.

### 1. Real-endpoint validation (Phase 1) — first

Without it, everything after it builds on unproven ground.

- **1a. Windows on GitHub's runners.** `windows-latest` is a disposable,
  isolated Windows Server VM with administrator rights. Add
  `//go:build windows` tests that run the agent's Windows code against the
  real OS: create, control and delete a test service through the service
  control manager; spawn and End a process (PID reuse); a read-only Windows
  Update scan through COM; install a test MSI and Inno fixture and remove it
  through `windows.software.remove`; the scheduled-task retire path; script
  runs under **Windows PowerShell 5.1**; the job-object kill on timeout. Then
  a full signed install against a test API on the runner. This turns most
  "Sim only" rows into **Lab** for Windows Server 2022/2025.
- **1b. Windows 10/11 desktops.** Runners are Server only. Desktop builds need
  disposable VMs that this host cannot run (it is itself a VM without nested
  virtualisation, 7 GB RAM). Needs an owner decision: a hypervisor elsewhere,
  or cloud VMs.
- **1c. Linux and macOS.** `ubuntu-latest` and `macos-latest` can install the
  POSIX agents as root under systemd and launchd against a test API.
- **1c'. Older agents against the new server.** Proven 2026-11-19: the v0.64.0
  signed agent, built from its release tag and run through the action
  simulator, passed six suites (611 checks) against the current server. A CI
  job will do this for every supported release tag on every release.
- **1d. Evidence reports.** Each run writes a per-feature result file (OS,
  build, feature, pass/fail, log) published with the release, and this page's
  matrix is regenerated from them. Nothing reaches **Lab** without one.
- **1e. Fleet evidence, kept honest.** A Platform Admin page reading the same
  records as the table above, so "Fleet" evidence stays current without
  anyone running queries.

### 2. Remote access security (Phase 2): Managed Secure Access

Designed in [managed-secure-access.md](managed-secure-access.md). Build behind
a feature flag, every computer staying in today's mode until an admin moves it.

- **Ephemeral credentials:** the signed agent sets a fresh one-time password
  for each portal-authorised session and clears it at session end or expiry,
  replacing the permanent password. A grant is short-lived, signed, and bound
  to one technician and one computer.
- **Endpoint enforcement:** the signed agent applies view-only, consent,
  clipboard and file-transfer restrictions through RustDesk's local
  configuration before the session and verifies them; if it cannot, the
  session is refused (today's rule, kept).
- **Termination and timeout:** the agent ends the session (rotating the
  one-time password and restarting the RustDesk connection manager) on
  revocation or expiry.
- **Evidence:** agent-reported session start, end and peer.
- If RustDesk cannot enforce a control, document it and evaluate an
  alternative (a Rem0te-controlled RustDesk build, or another transport)
  rather than accept a weaker control silently.

### 3. Agent reliability (Phase 3)

Minimum agent version enforcement; rollback after a failed signed update;
local log retention and a connectivity self-test; device-key rotation;
duplicate-enrolment handling; shorter update lag (today up to a day).

### 4–6. Patching, software, scripting (Phases 4–6)

Mostly built and enforced by the signer and agent; the gaps are evidence and
reporting: distinct requested / approved / downloaded / installed / restart
required / restart completed / verified states; KB and CVE references;
blackout windows; Windows PowerShell 5.1 parity; a reviewed library of
read-only maintenance scripts. Linux and macOS write actions only after the
Go agent is ported and 1c is in place.

### 7. Monitoring (Phase 7)

0.66–0.67 delivered classification and false-positive feedback. Remaining:
Defender/AV, firewall, BitLocker, SMART, battery; baselines and flapping
detection; evidence source, collection time and age on every alert; and
"unknown" never shown as healthy (0.68 started this on the device list).

### 8. AI install detector (Phase 8)

Off by default; signature-based detection of installed or running AI
software from inventory and process snapshots, never content.

### 9. ClientSt0r interoperability (Phase 9)

Blocked on signing (HMAC vs Ed25519) and a real ClientSt0r instance to test
against. ClientSt0r changes are pull requests only.

### 10–12. Hardening, scale, technician experience

A full attack-surface review; fleet benchmarks above 5,000 (measured only to
5,000 on a synthetic fleet); the remaining UI work.
