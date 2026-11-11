# Changelog

All notable changes to Rem0te are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
