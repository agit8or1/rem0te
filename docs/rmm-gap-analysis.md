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
| Sign-in security | MFA (TOTP, passkeys), SSO (OIDC), step-up (from 0.33 also for every enrolment token and enrollment:write API key), short-lived sessions, rate limits, security invariants in CI | U, I, P |
| Enrolment | Expiring enrolment tokens, Windows install script, pool adoption bound to the token's business, signed update channel. **Guided Add device** (0.32): business → site → OS → command → waits for the device → first health → monitoring links, with the site bound to the token | I (add-device 58), P (standard channel; the guided flow is not yet P) |
| Standard agent (Windows) | Heartbeat, online/offline, hardware/OS inventory, logged-on user, CPU load (point value), disks, installed software with change history, event-log reading, Windows Update scan (read-only), restart pending | I, **P** (standard channel; observed, not a controlled test) |
| Metric history (0.33) | CPU, memory and system-disk use per authenticated heartbeat (≤ 1/min), each volume per inventory pass; hourly min/mean/max roll-up; 48 h raw / 90 d hourly retention, configurable with caps; bounded, idempotent sweep (`METRIC_SWEEP=off`); gaps returned as gaps; Performance tab with 24 h–90 d ([metric-history.md](metric-history.md)) | U (42), I (59) — not R; storage measured on synthetic data (≈ 0.8 MB per computer) |
| Monitoring | Global → business → site → computer rules; offline, disk, CPU, memory, services, event patterns, restart pending; dedup (one open alert per problem), hysteresis, cooldowns, site-outage correlation, maintenance windows, 4-level escalation, webhooks, alerts → ClientSt0r tickets | U (91), I (108) — **not R**: the monitor block has never run on real Windows |
| Audit | Sealed hash chain, insert-only entries, signed checkpoints, off-host export, verification CLI | U (35), I |
| Containment | Pause actions, remote, updates or integration, per business or globally; three enforcement layers | I (70) |
| Global search (0.33) | Ctrl+K palette and `GET /search`: devices (name, hostname, RustDesk ID, serial, signed-in user, IP, adapter IPv4, alias), businesses, sites, people and open alerts, eight per group. Each group reuses its list route's where builder and capability; another business's objects are not found even by exact hostname or RustDesk ID; throttled, not audited, query not logged | U (37), I (search 98; business-access 83 after /admin/search was removed); browser 24 (`e2e-search-palette.mjs`, scratch stack: light, dark, phone width) |
| Device sync to ClientSt0r | ClientSt0r's provider syncs computers by API key, scoped to one business | Code-level interop with ClientSt0r 3.17.660 (`INTEGRATION_COORDINATION.md` §8) |

## Partially working

| Area | What exists | What is missing |
|---|---|---|
| **Signed agent** | Signed binary and update chain; patch scan; approved actions with journaling; signed pause; device binding | Never run on real Windows (**S** only). Not deployed: production is on the standard channel and the approval signer is not installed, so approved actions and patch deployment are **inert in production** |
| **Approved actions** | Catalog of exactly two: start the Print Spooler once, and install Windows updates. Independent passkey approvals on a separate signer, risk levels, journal, audit | No diagnostics catalog; no service restart, policy refresh, reboot scheduling, log collection or repair actions. Only **S** evidence |
| **Patching** | Scan, KB, severity, classification, restart detection, WSUS/Intune/WUfB/ConfigMgr detection and refusal, canary, rings, two approvals, auto-pause, retry, reconcile, evidence-first status (0.30); **Install updates** from one computer's Patches tab, as a one-computer deployment with two approvals (0.32); **patch policies** approved once on the signer, then rolled out inside a maintenance window, with each ring signed by the signer only if it falls inside the policy (0.32); a live production pre-flight (0.32) | No compliance report; no restart rule (computers are never restarted); rings are chosen by hand; ring results relayed to the signer aren't signed by the agents; failure reasons only as Windows HRESULTs. Only **S**, and not deployed: production has no signer and no signed agents ([Patching setup](patching-setup.md)) |
| **Diagnostics** | "Test connection" (RustDesk reachability) and event-log fetch | No one-click diagnostics (DNS, network, service health, disk, heavy processes); event collection takes up to ~3 minutes with no visible progress |
| **Device workspace** | One page with 9 tabs: Overview, Event Log, Test connection, Actions, Patches, Monitoring, Access review, Notes, AI Timeline | The header doesn't say what's wrong; alerts are buried in Monitoring; no Software/History tabs; Archive sits beside Connect; "Access review" and "AI Timeline" are unclear. **0.33:** Processes, Services and Network tabs — read-only snapshots (every process with user and start time, every service with start mode and run-as account, every connection with gateway, DNS and DHCP), each with its age and a Refresh, through the diagnostics catalog; standard Windows agent only, not Linux. Evidence **U** (92), **S** (pwsh stubs), **I** (68) — **not R** |
| **Device list** | 0.31: server-side search, filters, sort and pages; alert, patch, user and resource columns marked stale; column choice, density, audited CSV export. **0.33:** saved views on the account — personal, or shared within one business by someone who may manage it, storing only list parameters and opened as the viewer; static device groups per business (filter, *Group* column, audited); bulk actions on up to 200 selected devices — group add/remove, refresh inventory, queue a RustDesk client update, export the selection — each device re-checked with the single action's checks and its own result (I: device-views 117, device-list 113, unit 60) | Groups are static and single-membership (a computer is in one group; no rule-based groups). Bulk covers only those four repeatable actions, by design: connect, archive, delete and approved actions keep their own flows |
| **Dashboard** | Tiles: computers, offline, sessions 7d/30d, businesses; a map; server CPU/memory/disk | Answers none of the five questions (what's broken, who's affected, what needs attention, what's being repaired, what's next). Mixes server health with fleet health |
| **Ticket ↔ RMM (path B)** | Contract revision 2, signed examples, workflow proven against a reference peer (53 checks) | **Does not interoperate with real ClientSt0r**: four measured gaps. Revision 3 is proposed and awaiting ClientSt0r |
| **Linux / macOS** | Linux (0.32): RustDesk plus a read-only agent on a systemd timer — heartbeat, inventory, pending updates (apt/dnf/zypper); evidence **I** (real script, scratch API, unprivileged). macOS (0.33): the same read-only agent (shared `posix-agent.ts`) on a launchd LaunchDaemon, installed with `sudo` — heartbeat, inventory (`sw_vers`, `sysctl`, `vm_stat`, `top`, `df`, `ioreg`, `system_profiler`), and the updates macOS itself last found (never `softwareupdate`); evidence **I** only (real script and API, but on Linux against stubs of every macOS command) | Both: no software list, services/events monitoring, diagnostics or anything acted on; neither has run on an installed endpoint (no **R**). macOS also: restart pending is unknown, and pending updates are unknown when macOS has not checked within 36 hours; the installer's macOS steps are only parsed |
| **AI** | Ticket analysis through ClientSt0r's inference endpoint (rem0te holds no provider key). Separately, the device page's "AI Timeline" calls Anthropic **directly from rem0te** with `ANTHROPIC_API_KEY`, sending notes and session history | The direct call conflicts with "provider keys stay in ClientSt0r". It is unset in production, so inert. Decide: remove it, route it through ClientSt0r, or keep it as an explicitly optional standalone feature with redaction |
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
- **Software deployment:** catalog, verified packages, install/uninstall jobs, detection rules, version compliance.
  Inventory only.
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
- **Remote-session controls:** file-transfer authorization, chat, recording, clipboard policy, multi-monitor
  selection. RustDesk doesn't report enforcement, so none of these can be offered as restrictions (see Security).
- **Browser-based remote desktop.**
- *(Global search — built in 0.33, see Working today. Not included: saved searches, searching inside notes, software lists or event logs, and a search index; the fleet is scanned per query.)*
- ~~Saved device views, device groups in the UI, bulk actions~~ — built in 0.33 (see *Device list* above).
  Not implemented: dynamic (rule-based) groups and membership in more than one group.
- ~~Server sizing guidance by endpoint count~~ — done in 0.33: [server-sizing.md](server-sizing.md), from measured
  heartbeat cost and row sizes (I). It found that one API process is near its measured limit at 5,000 computers,
  mostly because every heartbeat starts a `sqlite3` process for the hbbs presence lookup.

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
| A stolen admin session could create enrolment tokens (known since 0.23) | 0.33 | Making a token needs a fresh re-authentication for every role (`enrollment.create`, not configurable), and so does creating an API key with `enrollment:write` (`apikey.enrollment`). API keys keep minting without one: the key is the second proof. Registering by RustDesk ID mints no credential and is not gated. [sign-in.md](sign-in.md#always-on-whatever-is-configured); `e2e-enrol-stepup.mjs`; invariant §27 (**I**) |

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
| 11b | ~~Patch approval policies and maintenance-window rollouts; install from the Patches tab; production setup runbook and pre-flight~~ **Done in 0.32** (fixture-tested only). Left: a restart rule (a §15 change to the agent's closed params), agent-signed results, and a run on real Windows | P1 | Deployments were created and approved by hand, ring by ring |
| 12 | **Scheduled RustDesk client updates** (requested 2026-11-11): opt-in per business or site, applied only inside an update window outside working hours, never while a session is open, honouring the `updates` containment pause; reuses the staged-rollout path (signed agent) or the queued-reinstall path (standard agent) | P1 | Today every client update is queued by hand and applied on the next heartbeat, whatever the time |

**Real-device dependency.** Items 5 and 8 need a disposable Windows 11 machine and a Windows Server 2022 machine
to move past **S**. Until then their changelog entries say *simulated only*.
