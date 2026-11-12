# RMM gap analysis (2026-11-11, rem0te 0.30.1; status updated for 0.31.0)

An honest inventory against the RMM overhaul brief. It is written from the code, the test suites and a review of
every published screenshot. It is a planning record for maintainers, not product documentation, so it is not
bundled into `/docs`. Integration work is tracked separately in
[`INTEGRATION_COORDINATION.md`](../INTEGRATION_COORDINATION.md).

**Evidence levels used below.** A feature is only as proven as its strongest evidence:

| Level | Meaning |
|---|---|
| **U** | Unit-tested (pure logic, no database) |
| **I** | Integration-tested: the real API against a scratch database |
| **S** | Simulated endpoint: the agent's real code against fake Windows services |
| **R** | Real endpoint: ran on a real Windows/Linux/macOS machine under test |
| **P** | Production-validated: observed working in production use |
| — | No evidence |

## Working today

| Area | What works | Evidence |
|---|---|---|
| Remote access | RustDesk launch from the computer page; the Windows launcher; launch policy (presets L1/L2/L3, protected classes, step-up for password use); session history; Quick Connect; customer support requests | I, **P** |
| Tenancy | Businesses, sites, per-business access, technician assignment across businesses, offboarding, technician approvals | I (business-access 83, offboarding 62, presets 113), P |
| Sign-in security | MFA (TOTP, passkeys), SSO (OIDC), step-up (from 0.33 also for every enrolment token; from 0.34 for creating any API key — keys are immutable, revoking never asks), short-lived sessions, rate limits, security invariants in CI | U, I (enrol-stepup 67), P |
| Enrolment | Expiring enrolment tokens, Windows install script, pool adoption bound to the token's business, signed update channel. **Guided Add device** (0.32): business → site → OS → command → waits for the device → first health → monitoring links, with the site bound to the token | I (add-device 58), P (standard channel; the guided flow is not yet P) |
| Standard agent (Windows) | Heartbeat, online/offline, hardware/OS inventory, logged-on user, CPU load (point value), disks, installed software with change history, event-log reading, Windows Update scan (read-only), restart pending | I, **P** (standard channel; observed, not a controlled test) |
| Metric history (0.33) | CPU, memory and system-disk use per authenticated heartbeat (≤ 1/min), each volume per inventory pass; hourly min/mean/max roll-up; 48 h raw / 90 d hourly retention, configurable with caps; bounded, idempotent sweep (`METRIC_SWEEP=off`); gaps returned as gaps; Performance tab with 24 h–90 d ([metric-history.md](metric-history.md)) | U (42), I (59) — not R; storage measured on synthetic data (≈ 0.8 MB per computer) |
| Monitoring | Global → business → site → computer rules; offline, disk, CPU, memory, services, event patterns, restart pending; dedup (one open alert per problem), hysteresis, cooldowns, site-outage correlation, maintenance windows, 4-level escalation, webhooks, alerts → ClientSt0r tickets | U (91), I (108) — **not R**: the monitor block has never run on real Windows |
| Audit | Sealed hash chain, insert-only entries, signed checkpoints, off-host export, verification CLI | U (35), I |
| Data retention (0.34) | One bounded, idempotent sweep (`RETENTION_SWEEP=off`) ages out finished commands and diagnostics (90 d, the newest of each type kept), inventory changes and resolved alerts (400 d), session event detail (400 d; sessions kept), unused expired tokens and grants, the abuse-guard window; every window an env setting with floor and ceiling; the audit chain never touched, one `RETENTION_PRUNED` entry per removing pass; Settings → System status shows each table's rows, oldest row and window; alert reports state the window they cover ([data-retention.md](data-retention.md)) | U (47), I (43), invariant §33 — not P; sweep cost measured on synthetic rows only |
| Containment | Pause actions, remote, updates or integration, per business or globally; three enforcement layers | I (70) |
| Global search (0.33) | Ctrl+K palette and `GET /search`: devices (name, hostname, RustDesk ID, serial, signed-in user, IP, adapter IPv4, alias), businesses, sites, people and open alerts, eight per group. Each group reuses its list route's where builder and capability; another business's objects are not found even by exact hostname or RustDesk ID; throttled, not audited, query not logged | U (37), I (search 98; business-access 83 after /admin/search was removed); browser 24 (`e2e-search-palette.mjs`, scratch stack: light, dark, phone width) |
| Device sync to ClientSt0r | ClientSt0r's provider syncs computers by API key, scoped to one business | Code-level interop with ClientSt0r 3.17.660 (`INTEGRATION_COORDINATION.md` §8) |

## Partially working

| Area | What exists | What is missing |
|---|---|---|
| **Signed agent** | Signed binary and update chain; patch scan; approved actions with journaling; signed pause; device binding | Never run on real Windows (**S** only). Not deployed: production is on the standard channel and the approval signer is not installed, so approved actions and patch deployment are **inert in production** |
| **Approved actions** | Catalog of exactly two: start the Print Spooler once, and install Windows updates. Independent passkey approvals on a separate signer, risk levels, journal, audit | No diagnostics catalog; no service restart, policy refresh, reboot scheduling, log collection or repair actions. Only **S** evidence |
| **Patching** | Scan, KB, severity, classification, restart detection, WSUS/Intune/WUfB/ConfigMgr detection and refusal, canary, rings, two approvals, auto-pause, retry, reconcile, evidence-first status (0.30); **Install updates** from one computer's Patches tab, as a one-computer deployment with two approvals (0.32); **patch policies** approved once on the signer, then rolled out inside a maintenance window, with each ring signed by the signer only if it falls inside the policy (0.32); a live production pre-flight (0.32); a **restart rule** on deployments, installs and policies — never (default) or restart if required inside the plan's window, after a fixed 15-minute warning, deferred while a RustDesk session is open or when the window would close first (0.34, **S** only) | No compliance report; the in-window restart has never run on real Windows, has no user postponement and no retry once deferred; rings are chosen by hand; ring results relayed to the signer aren't signed by the agents; failure reasons only as Windows HRESULTs. Only **S**, and not deployed: production has no signer and no signed agents ([Patching setup](patching-setup.md)) |
| **Diagnostics** | "Test connection" (RustDesk reachability) and event-log fetch | No one-click diagnostics (DNS, network, service health, disk, heavy processes); event collection takes up to ~3 minutes with no visible progress |
| **Device workspace** | One page with 9 tabs: Overview, Event Log, Test connection, Actions, Patches, Monitoring, Access review, Notes, AI Timeline | The header doesn't say what's wrong; alerts are buried in Monitoring; no Software/History tabs; Archive sits beside Connect; "Access review" and "AI Timeline" are unclear. **0.33:** Processes, Services and Network tabs — read-only snapshots (every process with user and start time, every service with start mode and run-as account, every connection with gateway, DNS and DHCP), each with its age and a Refresh, through the diagnostics catalog; standard Windows agent only, not Linux. Evidence **U** (92), **S** (pwsh stubs), **I** (68) — **not R** |
| **Device list** | 0.31: server-side search, filters, sort and pages; alert, patch, user and resource columns marked stale; column choice, density, audited CSV export. **0.33:** saved views on the account — personal, or shared within one business by someone who may manage it, storing only list parameters and opened as the viewer; static device groups per business (filter, *Groups* column, audited; **0.34:** a computer may be in any number of its business's groups, held in the database by triggers on the membership table — same business only, and a computer that changes business leaves the old one's groups); bulk actions on up to 200 selected devices — group add/remove, refresh inventory, queue a RustDesk client update, export the selection — each device re-checked with the single action's checks and its own result. **0.34 rule groups:** a group may instead be a rule — the list's own closed filters (now also platform, OS, tag, update state, RustDesk version range, last-seen age) — whose members are computed on every read as the reader (rule AND business AND visibility), never stored; in the group filter, facet, *Groups* column, CSV and as a bulk target resolved at request time (I: device-views 142, device-list 113, dynamic-groups 98; U: device-views 73, dynamic-groups 68) | Monitoring and client-update policies cannot yet be scoped to a group (they are per business / per computer). The device page does not list the rule groups a computer is in. Bulk covers only those four repeatable actions, by design: connect, archive, delete and approved actions keep their own flows |
| **Dashboard** | Tiles: computers, offline, sessions 7d/30d, businesses; a map; server CPU/memory/disk | Answers none of the five questions (what's broken, who's affected, what needs attention, what's being repaired, what's next). Mixes server health with fleet health |
| **Ticket ↔ RMM (path B)** | Contract revision 2, signed examples, workflow proven against a reference peer (53 checks) | **Does not interoperate with real ClientSt0r**: four measured gaps. Revision 3 is proposed and awaiting ClientSt0r |
| **Linux / macOS** | Linux (0.32): RustDesk plus a read-only agent on a systemd timer — heartbeat, inventory, pending updates (apt/dnf/zypper); evidence **I** (real script, scratch API, unprivileged). macOS (0.33): the same read-only agent (shared `posix-agent.ts`) on a launchd LaunchDaemon, installed with `sudo` — heartbeat, inventory (`sw_vers`, `sysctl`, `vm_stat`, `top`, `df`, `ioreg`, `system_profiler`), and the updates macOS itself last found (never `softwareupdate`); evidence **I** only (real script and API, but on Linux against stubs of every macOS command) | Both: no software list, services/events monitoring, diagnostics or anything acted on; neither has run on an installed endpoint (no **R**). macOS also: restart pending is unknown, and pending updates are unknown when macOS has not checked within 36 hours; the installer's macOS steps are only parsed |
| **AI** | Ticket analysis through ClientSt0r's inference endpoint (rem0te holds no provider key). Separately, the device page's "AI Timeline" calls Anthropic **directly from rem0te** with `ANTHROPIC_API_KEY`, sending notes and session history | The direct call conflicts with "provider keys stay in ClientSt0r". It is unset in production, so inert. Decide: remove it, route it through ClientSt0r, or keep it as an explicitly optional standalone feature with redaction |
| **Software deployment** (0.34) | A catalog of allowlisted winget packages per business or global, each pinned by exact version and installer SHA-256 (read from the winget-pkgs manifest with its digest, or pasted, and labelled so). Changes need the Business Owner or a Platform Admin with a fresh sign-in, and are audited. `windows.software.install@1` / `uninstall@1`: closed params, always high risk, two approvers on the signer, one computer or a canary and rings of ≤ 25 with a gate on the agent's own detection, not offered to ClientSt0r. The agent finds winget for SYSTEM under WindowsApps (or says `winget_unavailable`), runs it as an argument array from one exec site, hashes the downloaded installer itself and refuses a mismatch, detects before (no-op) and after (effective), journals, honours pause and containment, times out to *uncertain*. Version compliance report: compliant / outdated / missing / unknown per entry ([software-deployment.md](software-deployment.md)) | **Never run on real Windows** (**S** only: stub winget through the real exec path). U (unit-software 146, signer 98), S (Go: 41 software tests), I (e2e-software-deploy 156). Residual: `winget install` re-downloads; those bytes are checked by winget against the source manifest, not re-hashed by the agent. Not deployed: production has no signer and no signed agents |
| **Reports** | Audit log, session history, alerts list, audit export | No report pages, no scheduling, no exports for patch compliance, uptime, alert frequency or agent coverage |

## Not implemented

- **Script library and automation engine:** the library and its review exist (immutable hashed versions, static
  warnings, independent approval bound to the content hash; [script-library.md](script-library.md), I). **0.34
  runs an approved version** on up to 25 Windows computers as the signed action `windows.script.run@1`: the version's
  SHA-256 must be on the approval signer's own allowlist (two passkey approvals there, revocable one-way), each run
  needs two more approvers who did not write it, arguments are typed and checked by the portal, the signer and the
  agent, and output (64 KB per stream, redacted twice, kept 90 days) appears on the device history. Evidence **S**
  with real PowerShell 7 on Linux (`e2e-script-run.mjs`, Go tests under pwsh); **never run on real Windows**. Not
  implemented: scheduling, a job queue beyond one plan, retries, Linux and macOS scripts.
- ~~**Software deployment:** catalog, verified packages, install/uninstall jobs, detection rules, version compliance~~
  — built in 0.34 for Windows as a winget allowlist (see *Software deployment* above,
  [software-deployment.md](software-deployment.md)). Not implemented: running on real Windows (fixture-tested only),
  uploading your own installers (deliberately no upload route), the msstore source, per-user installs, installer
  switches, dependencies, automatic remediation from the compliance report, and software on Linux or macOS.
- **Linux and macOS beyond read-only reporting:** no installed-software list, service or event monitoring,
  diagnostics, client updates or any action on either; macOS reports no restart-pending state. Both agents have
  run only against a scratch API (Linux on real Linux userland, macOS against recorded output), never installed.
- ~~**Process list, full service list, network adapter details** in the agent~~ — done in 0.33 as read-only snapshots
  on the device workspace ([diagnostics.md](diagnostics.md#the-processes-services-and-network-tabs)); never run on
  real Windows. Still not implemented: the same on Linux (its agent reads no diagnostics), and anything that acts on
  a process or service from these lists (by design: service restart is a signed maintenance action).
- **Metric history** (0.33, [metric-history.md](metric-history.md)): CPU, memory and disk are now kept over time. Still not
  implemented: network throughput, per-process history, fleet-wide or per-business charts, exporting history, and
  alerting on a trend (the threshold monitors still judge each reading alone). Non-system volumes are sampled only
  every inventory pass (≈ 6 h), because the heartbeat carries the system volume only.
- **Restarts after updates** (0.34, [staged-patching.md](staged-patching.md#restarting-after-updates)): the in-window
  restart rule exists, **S** only. Not implemented: letting the person at the computer postpone it, retrying a
  deferred restart later in the window, checking console or Remote Desktop sessions (only RustDesk sessions are
  counted), and any run on real Windows.
- **Remote-session controls:** file-transfer authorization, chat, recording, clipboard policy, multi-monitor
  selection. RustDesk doesn't report enforcement, so none of these can be offered as restrictions (see Security).
- **Browser-based remote desktop.**
- *(Global search — built in 0.33, see Working today. Not included: saved searches, searching inside notes, software lists or event logs, and a search index; the fleet is scanned per query.)*
- ~~Saved device views, device groups in the UI, bulk actions~~ — built in 0.33 (see *Device list* above).
  Membership in more than one group and rule-based (dynamic) groups: built in 0.34. Not implemented: scoping
  monitoring or client-update policies to a group.
- ~~Server sizing guidance by endpoint count~~ — done in 0.33: [server-sizing.md](server-sizing.md), from measured
  heartbeat cost and row sizes (I). It found that one API process is near its measured limit at 5,000 computers,
  mostly because every heartbeat starts a `sqlite3` process for the hbbs presence lookup. ~~That lookup~~ — fixed in
  0.34: one shared read of hbbs's peer table per 10 s window (`hbbs-peer-snapshot.ts`, invariant §36,
  `e2e-presence-cache.mjs`), which roughly halves API CPU per heartbeat and leaves 5,000 computers with headroom on one
  process (measured on a synthetic fleet, not a real one). Still not implemented: running more than one API process.
- ~~Data retention ("nothing that grows is ever pruned", server-sizing 0.33)~~ — done in 0.34:
  [data-retention.md](data-retention.md) (U, I). Not implemented: archiving rows before they are deleted,
  per-business windows, pruning the ClientSt0r job and alert-event outboxes (needs the peer to agree a horizon),
  and any way to shorten the audit log (deliberately: it is evidence).
- ~~Agent-signed patch results~~ — done in 0.34: the signer opens a policy's later ring only on results and scans
  each computer signed with its own key ([staged-patching.md](staged-patching.md#signed-results-034), I). Not
  implemented: proof of a computer's key on first sight (it is trusted on first use, checked by a fingerprint
  read-back), signed results from the Linux and macOS agents, and any check of signed results outside patch
  policies (manual rings are approved by people, who read the portal's copy).

## Security limitations (current, honest)

| Limitation | Effect | Direction |
|---|---|---|
| RustDesk session restrictions are not enforced or reported by the endpoint | View-only presets are blocked rather than faked. Clipboard, file-transfer and recording controls cannot be advertised | Needs a signed-agent-side enforcement point or a different transport. Never add a UI-only toggle |
| Standard agent's heartbeat authority | It reports, it never executes. Execution is signed-agent only | Keep the split. Move production endpoints to the signed channel only after real-Windows testing |
| Approval signer not installed in production | Nothing can be executed in production at all. Safe, but the action catalog is unusable there | Install per `docs/approved-actions.md` once real-device tests pass |
| In-app updater requires a pinned key (0.30.1) | Updates are unavailable until `UPDATE_SIGNING_KEY_FINGERPRINT` and `UPDATE_GNUPGHOME` are set | Operator configuration |
| Direct AI call from rem0te (above) | Notes and session history would leave rem0te if a key were set | Decide and document |

### Resolved

| Limitation | Resolved in | How |
|---|---|---|
| A stolen session could mint an API key of any scope — long-lived access that outlives the session | 0.34 | Creating any key needs a fresh re-authentication (`apikey.create`, not configurable; 0.33 asked only for `enrollment:write`), after scope and validation, before the write; the audit records the method. Keys are immutable — no route widens scopes or restores a revoked key — and revoking never asks. [sign-in.md](sign-in.md#always-on-whatever-is-configured); `e2e-enrol-stepup.mjs`; invariant §34 (**I**) |
| A stolen admin session could create enrolment tokens (known since 0.23) | 0.33 | Making a token needs a fresh re-authentication for every role (`enrollment.create`, not configurable), and so does creating an API key with `enrollment:write` (`apikey.enrollment`). API keys keep minting without one: the key is the second proof. Registering by RustDesk ID mints no credential and is not gated. [sign-in.md](sign-in.md#always-on-whatever-is-configured); `e2e-enrol-stepup.mjs`; invariant §27 (**I**) |
| A compromised portal could forge a canary success and start a patch policy's ring 1 early (known since 0.32) | 0.34 | Agents sign their results and scans with a key generated on the computer; the policy names each key, the signer pins it on approval and verifies every previous-ring result under it before a later ring. Missing, forged, cross-device, cross-plan and stale results are refused by name. Trust-on-first-use until the first approved policy, closed by a fingerprint read-back. [staged-patching.md](staged-patching.md#signed-results-034); `e2e-patch-policies.mjs`; invariant §38 (**I**) |

## Usability findings from the screenshots

The full review lists issues per screen. The ones that shape the plan:

1. **Navigation:** about 30 flat sidebar entries, mixing personal, daily-work and platform-admin items. Duplicates:
   Help/Documentation, Users/Technicians/Access Control, Downloads/Enroll Computer, Security in two places,
   Updates vs Patching.
2. **No workflow spine.** Alert → computer → diagnose → action → verify → ticket isn't linked, and there's no
   global search. *(Global search: Ctrl+K, 0.33.)*
3. **Terminology drift:** computer / endpoint / client / enrolled client / device; business / company /
   organisation; a different set of session states in every view; three spellings of the product name.
4. **Status colour carries no meaning:** the same blue for buttons and for "Active" pills, and green for "not run".
5. **Destructive actions next to primary ones:** Archive beside Connect, a bare "×" on rows.
6. **Layout defects:** missing page padding (Quick Connect, Downloads, Access), sidebar footer clipping entries,
   a stray callout.
7. **The GitHub gallery shows v0.18.10**, not what ships.

## Priority fixes (the order this will be built in)

Each increment is a release with tests, docs, a changelog entry and screenshots. None is deployed without the
owner's approval.

| # | Increment | Phase | Why first |
|---|---|---|---|
| 1 | **Navigation: Dashboard · Devices · Alerts · Automation · Patching · Remote Support · Reports · Settings**, with admin grouped under Settings; one term for each object; fixes for the layout defects | P0 | Every other improvement lands inside it |
| 2 | **Technician dashboard** answering the five questions from real data: open alerts by customer, offline computers, restart pending, failed actions, active sessions, approvals waiting, site outages; server health moved to System Status | P0 | The first screen should say what to do |
| 3 | **Device workspace:** a header with status, customer, site, last seen and open problems; primary actions Connect · Diagnose · Run action · Patch · More; tabs regrouped; destructive actions in a menu | P0 | The centre of the technician workflow |
| 4 | **Device list:** alert, patch, user and resource columns (marked stale when stale), business/site filters, sort, density, saved views | P0 | Finding the computer. Columns, filters, sort and density built in 0.31; saved views, device groups and bulk actions in 0.33 |
| 5 | **Read-only diagnostics catalog** (disk, services, network/DNS, recent errors, heavy processes, pending updates, restart state) on the standard agent; results bounded, redacted and audited | P0 | Basic one-click diagnostics; also the first half of revision 3 (P2/P3) |
| 6 | Revision 3 items ClientSt0r acknowledges | P0 | Blocked on ClientSt0r (coordination §9) |
| 7 | Guided Add Device — **built (0.32)** | P1 | |
| 8 | Maintenance actions for the signed catalog (restart an approved service, schedule a reboot, collect logs) | P1 | Built in 0.32 (`windows.service.restart`, `windows.reboot.schedule` / `.cancel`, `windows.logs.collect`); **S only** — needs real-Windows testing of the signed agent |
| 9 | Script library with review and immutable approval binding | P1 | Library and review built in 0.32; running approved versions through the signed catalog (`windows.script.run@1`, signer-side hash allowlist) in 0.34; **S only** (PowerShell 7 on Linux) — needs real-Windows testing of the signed agent |
| 10 | Reports: patch compliance, agent coverage, alert frequency | P1/P2 | |
| 11 | Linux and macOS heartbeat and inventory | P2 | Linux done in 0.32 (`e2e-linux-agent.mjs`), macOS in 0.33 (`e2e-macos-agent.mjs`, against stubs); both integration-tested only, real-endpoint tests outstanding |
| 11b | ~~Patch approval policies and maintenance-window rollouts; install from the Patches tab; production setup runbook and pre-flight~~ **Done in 0.32** (fixture-tested only); the restart rule followed in 0.34 (fixture-tested only), and agent-signed results **done in 0.34** ([staged-patching.md](staged-patching.md#signed-results-034); invariant §38, I). Left: a run on real Windows | P1 | Deployments were created and approved by hand, ring by ring |
| 12 | **Scheduled RustDesk client updates** (requested 2026-11-11): opt-in per business or site, applied only inside an update window outside working hours, never while a session is open, honouring the `updates` containment pause; reuses the staged-rollout path (signed agent) or the queued-reinstall path (standard agent) | P1 | Today every client update is queued by hand and applied on the next heartbeat, whatever the time |

**Real-device dependency.** Items 5 and 8 need a disposable Windows 11 machine and a Windows Server 2022 machine
to move past **S**. Until then their changelog entries say *simulated only*.
