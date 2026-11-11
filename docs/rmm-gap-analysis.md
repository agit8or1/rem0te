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
| Sign-in security | MFA (TOTP, passkeys), SSO (OIDC), step-up, short-lived sessions, rate limits, security invariants in CI | U, I, P |
| Enrolment | Expiring enrolment tokens, Windows install script, pool adoption bound to the token's business, signed update channel. **Guided Add device** (0.32): business → site → OS → command → waits for the device → first health → monitoring links, with the site bound to the token | I (add-device 58), P (standard channel; the guided flow is not yet P) |
| Standard agent (Windows) | Heartbeat, online/offline, hardware/OS inventory, logged-on user, CPU load (point value), disks, installed software with change history, event-log reading, Windows Update scan (read-only), restart pending | I, **P** (standard channel; observed, not a controlled test) |
| Monitoring | Global → business → site → computer rules; offline, disk, CPU, memory, services, event patterns, restart pending; dedup (one open alert per problem), hysteresis, cooldowns, site-outage correlation, maintenance windows, 4-level escalation, webhooks, alerts → ClientSt0r tickets | U (91), I (108) — **not R**: the monitor block has never run on real Windows |
| Audit | Sealed hash chain, insert-only entries, signed checkpoints, off-host export, verification CLI | U (35), I |
| Containment | Pause actions, remote, updates or integration, per business or globally; three enforcement layers | I (70) |
| Device sync to ClientSt0r | ClientSt0r's provider syncs computers by API key, scoped to one business | Code-level interop with ClientSt0r 3.17.660 (`INTEGRATION_COORDINATION.md` §8) |

## Partially working

| Area | What exists | What is missing |
|---|---|---|
| **Signed agent** | Signed binary and update chain; patch scan; approved actions with journaling; signed pause; device binding | Never run on real Windows (**S** only). Not deployed: production is on the standard channel and the approval signer is not installed, so approved actions and patch deployment are **inert in production** |
| **Approved actions** | Catalog of exactly two: start the Print Spooler once, and install Windows updates. Independent passkey approvals on a separate signer, risk levels, journal, audit | No diagnostics catalog; no service restart, policy refresh, reboot scheduling, log collection or repair actions. Only **S** evidence |
| **Patching** | Scan, KB, severity, classification, restart detection, WSUS/Intune/WUfB/ConfigMgr detection and refusal, canary, rings, two approvals, auto-pause, retry, reconcile, evidence-first status (0.30); **Install updates** from one computer's Patches tab, as a one-computer deployment with two approvals (0.32); **patch policies** approved once on the signer, then rolled out inside a maintenance window, with each ring signed by the signer only if it falls inside the policy (0.32); a live production pre-flight (0.32) | No compliance report; no restart rule (computers are never restarted); rings are chosen by hand; ring results relayed to the signer aren't signed by the agents; failure reasons only as Windows HRESULTs. Only **S**, and not deployed: production has no signer and no signed agents ([Patching setup](patching-setup.md)) |
| **Diagnostics** | "Test connection" (RustDesk reachability) and event-log fetch | No one-click diagnostics (DNS, network, service health, disk, heavy processes); event collection takes up to ~3 minutes with no visible progress |
| **Device workspace** | One page with 9 tabs: Overview, Event Log, Test connection, Actions, Patches, Monitoring, Access review, Notes, AI Timeline | The header doesn't say what's wrong; alerts are buried in Monitoring; no Services/Processes/Software/History tabs; Archive sits beside Connect; "Access review" and "AI Timeline" are unclear |
| **Device list** | Search, status, last seen, Connect | 6 columns; no alerts/patch/user/resource columns, no business or site filter, saved views, bulk actions, column choice or density; the RustDesk ID column is always masked |
| **Dashboard** | Tiles: computers, offline, sessions 7d/30d, businesses; a map; server CPU/memory/disk | Answers none of the five questions (what's broken, who's affected, what needs attention, what's being repaired, what's next). Mixes server health with fleet health |
| **Ticket ↔ RMM (path B)** | Contract revision 2, signed examples, workflow proven against a reference peer (53 checks) | **Does not interoperate with real ClientSt0r**: four measured gaps. Revision 3 is proposed and awaiting ClientSt0r |
| **Linux / macOS** | Linux (0.32): RustDesk plus a read-only agent on a systemd timer — heartbeat, inventory, pending updates (apt/dnf/zypper); evidence **I** (real script, scratch API, unprivileged). macOS: RustDesk plus a one-time registration | Linux: no software list, services/events monitoring, diagnostics or anything acted on; not yet run on an installed endpoint. macOS: no heartbeat, inventory, monitoring or patch reporting |
| **AI** | Ticket analysis through ClientSt0r's inference endpoint (rem0te holds no provider key). Separately, the device page's "AI Timeline" calls Anthropic **directly from rem0te** with `ANTHROPIC_API_KEY`, sending notes and session history | The direct call conflicts with "provider keys stay in ClientSt0r". It is unset in production, so inert. Decide: remove it, route it through ClientSt0r, or keep it as an explicitly optional standalone feature with redaction |
| **Reports** | Audit log, session history, alerts list, audit export | No report pages, no scheduling, no exports for patch compliance, uptime, alert frequency or agent coverage |

## Not implemented

- **Script library and automation engine:** the library and its review now exist (immutable hashed versions, static
  warnings, independent approval bound to the content hash; [script-library.md](script-library.md), I). Not
  implemented: running a script at all, and so signing, scheduling, job queue, bulk runs, output capture and
  redaction, retries. Running waits for the signed agent's real-Windows testing. This is still the largest gap.
- **Software deployment:** catalog, verified packages, install/uninstall jobs, detection rules, version compliance.
  Inventory only.
- **Process list, full service list, network adapter details** in the agent. Services are checked only when a
  monitor names them.
- **Metric history:** CPU/RAM/disk are latest values; there is no time series and no retention policy.
- **Remote-session controls:** file-transfer authorization, chat, recording, clipboard policy, multi-monitor
  selection. RustDesk doesn't report enforcement, so none of these can be offered as restrictions (see Security).
- **Browser-based remote desktop.**
- **Global search** across computers, businesses and users.
- **Saved device views, device groups in the UI, bulk actions.**
- **Server sizing guidance** by endpoint count.

## Security limitations (current, honest)

| Limitation | Effect | Direction |
|---|---|---|
| RustDesk session restrictions are not enforced or reported by the endpoint | View-only presets are blocked rather than faked. Clipboard, file-transfer and recording controls cannot be advertised | Needs a signed-agent-side enforcement point or a different transport. Never add a UI-only toggle |
| Standard agent's heartbeat authority | It reports, it never executes. Execution is signed-agent only | Keep the split. Move production endpoints to the signed channel only after real-Windows testing |
| Approval signer not installed in production | Nothing can be executed in production at all. Safe, but the action catalog is unusable there | Install per `docs/approved-actions.md` once real-device tests pass |
| In-app updater requires a pinned key (0.30.1) | Updates are unavailable until `UPDATE_SIGNING_KEY_FINGERPRINT` and `UPDATE_GNUPGHOME` are set | Operator configuration |
| A stolen admin session can still create enrolment tokens | Known since 0.23 | Consider step-up for token creation |
| Direct AI call from rem0te (above) | Notes and session history would leave rem0te if a key were set | Decide and document |

## Usability findings from the screenshots

The full review lists issues per screen. The ones that shape the plan:

1. **Navigation:** about 30 flat sidebar entries, mixing personal, daily-work and platform-admin items. Duplicates:
   Help/Documentation, Users/Technicians/Access Control, Downloads/Enroll Computer, Security in two places,
   Updates vs Patching.
2. **No workflow spine.** Alert → computer → diagnose → action → verify → ticket isn't linked, and there's no
   global search.
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
| 4 | **Device list:** alert, patch, user and resource columns (marked stale when stale), business/site filters, sort, density, saved views | P0 | Finding the computer |
| 5 | **Read-only diagnostics catalog** (disk, services, network/DNS, recent errors, heavy processes, pending updates, restart state) on the standard agent; results bounded, redacted and audited | P0 | Basic one-click diagnostics; also the first half of revision 3 (P2/P3) |
| 6 | Revision 3 items ClientSt0r acknowledges | P0 | Blocked on ClientSt0r (coordination §9) |
| 7 | Guided Add Device — **built (0.32)** | P1 | |
| 8 | Maintenance actions for the signed catalog (restart an approved service, schedule a reboot, collect logs) | P1 | Built in 0.32 (`windows.service.restart`, `windows.reboot.schedule` / `.cancel`, `windows.logs.collect`); **S only** — needs real-Windows testing of the signed agent |
| 9 | Script library with review and immutable approval binding | P1 | Largest new surface. Design note first |
| 10 | Reports: patch compliance, agent coverage, alert frequency | P1/P2 | |
| 11 | Linux heartbeat and inventory | P2 | Done in 0.32 (integration-tested, `e2e-linux-agent.mjs`); real-endpoint test outstanding |
| 11b | ~~Patch approval policies and maintenance-window rollouts; install from the Patches tab; production setup runbook and pre-flight~~ **Done in 0.32** (fixture-tested only). Left: a restart rule (a §15 change to the agent's closed params), agent-signed results, and a run on real Windows | P1 | Deployments were created and approved by hand, ring by ring |
| 12 | **Scheduled RustDesk client updates** (requested 2026-11-11): opt-in per business or site, applied only inside an update window outside working hours, never while a session is open, honouring the `updates` containment pause; reuses the staged-rollout path (signed agent) or the queued-reinstall path (standard agent) | P1 | Today every client update is queued by hand and applied on the next heartbeat, whatever the time |

**Real-device dependency.** Items 5 and 8 need a disposable Windows 11 machine and a Windows Server 2022 machine
to move past **S**. Until then their changelog entries say *simulated only*.
