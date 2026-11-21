# What each agent can do

> **0.68.1:** [Readiness and evidence](readiness.md) is the current, evidence-graded view of what works where, including what has run on the production fleet. Where this page disagrees with it, it is right and this page is being corrected.

Rem0te started as a RustDesk portal and now does part of an RMM's job: monitoring, inventory, read-only patch
reporting, approved patch deployment and ClientSt0r ticket integration. Which of it works on a computer depends on
**what is installed there**, and some of it needs configuration on the server first. This page says which, and how
far each part has been tested. "Tested" here means one of three things, and they are not the same:

| Level | Meaning |
|---|---|
| **Real Windows** | Ran on a real Windows machine, against the real Windows service it uses |
| **Simulated** | The agent's real code ran against fakes of Windows (Windows Update, registry, service manager), driven through the real API, in CI |
| **Fixture-tested** | The server side ran against a stand-in for the device or peer; the device code did not run |

## The agent types

| | **Standard agent** | **Signed agent** (0.27+) | **Standard (Linux)** (0.32+) | **Standard (macOS)** (0.33+) | **RustDesk only**: Linux before 0.32, macOS before 0.33 or without `sudo` | **Quick Connect** |
|---|---|---|---|---|---|---|
| What it is | The Windows install script's scheduled tasks (update channel `legacy`) | The signed `rem0te-agent.exe`, installed from the signed update channel (`signed`) | A POSIX `sh` script and a systemd timer, installed by the Linux installer; read-only | A POSIX `sh` script and a LaunchDaemon in `/Library/Rem0te`, installed by the macOS installer run with `sudo`; read-only | RustDesk plus a one-time registration at install | A one-off RustDesk session, nothing installed |
| Remote access (RustDesk, launch policy, audit) | Yes | Yes | Yes | Yes | Yes | Yes, for that session |
| Managed Secure Access readiness (0.69): a read-only RustDesk preflight (version, build, service, eleven `--option` reads; never a value, never `--password`) | No: Unsupported | Yes, every 6 hours or when RustDesk changes | No: Unsupported | No: Unsupported | No | No |
| Heartbeat, online/offline | Yes | Yes | Yes, every 3 minutes, with the device secret | Yes, every 3 minutes, with the device secret | At install only | No |
| Inventory (hardware, OS, disks, last boot) | Yes | Yes | Yes: os-release, kernel, uptime, CPU model and load, memory, disks (`df`), logged-on users (`who`), DMI where readable | Yes: `sw_vers`, kernel, boot time (`sysctl`), CPU model and load (`top`), memory (`vm_stat`), volumes (`df`, `mount`), console user, model and serial (`ioreg`, `system_profiler`) | No | No |
| Installed software and change history (0.29) | Yes | Yes | No | No | No | No |
| Windows event log reading | Yes | Yes | No (a staged query is refused) | No (a staged query is refused) | No | No |
| One-click read-only diagnostics (0.31): disk, services, errors, processes, network, DNS, updates, restart | Yes | Yes (the same heartbeat script) | No | No | No | No |
| Metric history (0.33): CPU, memory, system disk per heartbeat; each volume per inventory pass | Yes | Yes | Yes | Yes | No | No |
| Processes, Services and Network tabs (0.33): full read-only snapshots | Yes | Yes (the same heartbeat script) | No (its agent reads no diagnostics) | No (its agent reads no diagnostics) | No | No |
| Monitoring (offline, disk, CPU, memory, services, events, restart pending) | Yes | Yes | Offline, system disk, CPU, memory and restart pending, from the values it reports; **no services or events** | Offline, system disk, CPU and memory; **no services, events or restart pending** | Offline only (it stops heartbeating) | No |
| **Patches: pending updates, restart pending** | **Yes — read-only**, every 12 h or on *Scan now* | Yes | **Yes — read-only**: `apt list --upgradable`, `dnf -C check-update` or `zypper --no-refresh list-updates`, from the package manager's existing cache; **unknown** with none of them | **Yes — read-only**: the list macOS itself last found (`defaults read com.apple.SoftwareUpdate`), never `softwareupdate`; **unknown** if macOS has not checked within 36 hours. Restart pending: always unknown | No | No |
| Patches: update identities, history, restart sources | No | Yes | No | No | No | No |
| Patches: who manages patching (WSUS, Intune, WUfB, ConfigMgr) | **No — shown as Unknown** | Yes | No — shown as Unknown | No — shown as Unknown | No | No |
| Patches: confirmed by a later scan | No | Yes | No | No | No | No |
| **Deploying updates** (canary, rings, two approvals) | **No** | Yes, when approvals are configured | **No** | **No** | No | No |
| Approved actions (start the Print Spooler) | No | Yes, when approvals are configured | No | No | No | No |
| Maintenance actions (restart an allowlisted service, schedule or cancel a restart, collect logs) | No | Yes (0.32+ agent), when approvals are configured | No | No | No | No |
| Chat with the person at the computer (0.34; [chat.md](chat.md)) | Yes (0.36+, through the tray, once the installer has been re-run) | Yes (0.34+ agent; **seen on the fleet**: 2 conversations, 5 messages, not a controlled test) | No | No | No | No |
| Tray icon: support request with usage and screenshot, read-only self-help (0.36; [tray.md](tray.md)) | Yes (the Windows account is reported, not proven) | Yes (**seen on the fleet**: two read-only self-help tools, `net.test` and `net.details`; support requests not yet) | No | No | No | No |
| Tray self-help as SYSTEM: flush DNS, renew IP, restart RustDesk (0.36) | No | Yes (**not yet run on real Windows**) | No | No | No | No |
| Background terminal (0.77; [remote-terminal.md](remote-terminal.md)): cmd or PowerShell as SYSTEM with no screen sharing, Platform Admins only, outbound long-poll | No | Yes (0.77+ agent; **lab-tested on Windows Server** as administrator and SYSTEM: output, Job Object kill of the tree, expiry; **not yet run on a desktop or the fleet**) | No | No | No | No |
| Background file transfer (0.78; [file-transfer.md](file-transfer.md)): send or fetch a file as SYSTEM, SHA-256 at both ends, Platform Admins only (send and fetch separately), the same outbound worker | No | Yes (0.78+ agent; **lab-tested on Windows Server** as administrator and SYSTEM: send, exists/overwrite, fetch with hashes, a junction and a UNC path refused; **not yet run on a desktop or the fleet**) | No | No | No | No |
| Password rotation, reinstall, RustDesk client update from the console | Yes | Yes | **No** — the console refuses them; re-run the installer on the computer | **No** — the console refuses them; re-run the installer on the computer | No | No |
| Agent card (0.34): type, version (0.70.1: a signed agent on the published build shows the published release, whatever label it last recorded), current or behind, channel, portal update mode, last update result | Yes | Yes (last update result from 0.34 signed builds) | Yes, with the command to re-run the installer | Yes, with the command to re-run the installer | Type only | No |
| **Update agent** from the console (0.34) | Yes: re-runs the current standard installer (the reinstall path) | **Check for update now**: `rem0te-agent.exe update`, signed files only | **No** — re-run the installer on the computer | **No** — re-run the installer on the computer | No | No |
| **Upgrade to full agent** (the signed agent) from the console, one computer or a selection (0.34) | Yes, with a fresh sign-in and a reason, while the portal is not in *Signed only*; **seen on the fleet** (9 migrations completed, 1 by hand and 8 automatic) | Already signed | No signed agent for Linux | No signed agent for macOS | No | No |
| Containment honoured on the device | Server side only | Server side, and the agent checks the signed pause | Server side only (it acts on nothing anyway) | Server side only (it acts on nothing anyway) | Server side only | Server side only |

The standard agent never deploys anything. The Linux and macOS agents go further: they act on **nothing** the
server sends. From a heartbeat response they read only command ids and three fixed command names (inventory refresh,
update scan, and an event-log query they answer with "Windows-only"); rotations, reinstalls, client updates, monitor
queries, diagnostics and actions are ignored, and the console refuses to stage the ones it would otherwise accept
(`LINUX_AGENT_READ_ONLY`, `MACOS_AGENT_READ_ONLY`). The two share that code (`posix-agent.ts`), and
`scripts/check-security-invariants.mjs` §24 (both) and §32 (macOS: no `softwareupdate`, `launchctl`, `defaults
write`, nothing under `/usr/local`) check it against the scripts' text.

The standard agent never deploys anything. The Patches tab shows what it reports, labelled
*Standard agent scan (read-only)*, and says that deploying needs the signed agent.

## Patch status on the Patches tab (0.30)

Every computer's Patches tab now leads with **Patch status**: the evidence first, then what follows from it.

| Field | Where it comes from |
|---|---|
| Evidence | *Signed agent scan*, *Standard agent scan (read-only)* or *No scan received*, with its time, its age and **fresh / stale / unknown**. Stale means older than 36 hours: three missed 12-hour scans |
| Last successful scan | A signed scan that came back with an error is not a successful scan |
| Last boot | The inventory's last boot time |
| Connection | Online, or offline since when |
| Restart pending | From the scan; **unknown** when nothing was received, never "no" |
| Who manages patching | **WSUS**, **MDM (Intune) update policy**, **Windows Update for Business policy** or **Configuration Manager**, with what that means, when the signed agent finds them. **Unknown** from the standard agent, which does not read update policy. *Windows Update (rem0te can deploy)* when the signed agent found none |
| Relevant KBs | The KB numbers offered, critical and important first |
| Installed by an approved plan | Each update from a recent plan, and whether a **later scan confirmed** it. Only a scan taken after the install, which no longer offers the update, shows no restart pending and has Windows Update's history recording it, counts |
| Deploy from rem0te | Available, or why not: no signed agent, managed elsewhere, no signed scan yet, or the scan is stale |

**WSUS and Intune ownership.** When a computer takes its updates from WSUS (Group Policy `WUServer` with
`UseWUServer=1`) or from an Intune update ring (the `PolicyManager\current\device\Update` policy), approvals and
timing belong to that system. Rem0te shows what the computer reports and will not deploy there. The signed agent
refuses too, so the two never fight over a computer.

**In a linked ticket.** When a *restart pending* alert is offered to ClientSt0r, it carries a redacted summary
(contract revision 2, `alert.patch_summary`): evidence source and age, freshness, last boot, who manages patching
(as a label), restart pending, the pending KB numbers, and which KBs were confirmed, failed or are awaiting
confirmation. It never carries update titles, error text, computer identifiers, user names, addresses or registry
values.

## Session controls, terminal, MDM and backup (0.76.1, updated 0.78.1)

These rows use four states: **available**, **requires setup**, **unsupported** and **planned**. Each one names
the component that enforces it. The full audit, with sources and evidence, is
[session-maintenance-mdm-backup-audit.md](session-maintenance-mdm-backup-audit.md). *Legacy* is today's Connect
on every production computer. *Managed* is a computer moved into Managed Secure Access, which needs
`MSA_GRANTS=on` (off everywhere in production) and the signed Windows agent. The owner accepted every
recommendation for the audit's decisions 8–20 on 2026-11-21.

| Capability | Legacy | Managed | Enforced by | Evidence |
|---|---|---|---|---|
| Clipboard off | **unsupported** (RustDesk default, on) | **requires setup**: in view always off; in control off per policy with the **0.78.1** agent (`access-mode=custom`; agents 0.73.0–0.78.0 set `full`, which overrode it: finding F1) | RustDesk on the computer, set by the agent | Lab (readback, and the effective state by RustDesk's own rule; Windows Server; no connection made) |
| Clipboard one way (either direction) | **unsupported** | **unsupported**. Stock RustDesk has no setting; a custom client can block only "computer → technician" | — | RustDesk source |
| Text clipboard without file clipboard | **unsupported** | Only by turning file transfer off | RustDesk | RustDesk source |
| In-session file transfer off | **unsupported** | **requires setup**: in view always; in control per policy with the 0.78.1 agent (F1) | RustDesk | Lab (readback and effective state by RustDesk's rule) |
| In-session upload / download separately, size limits | **unsupported** | **unsupported** | — | RustDesk source |
| Background file transfer, separate upload and download, size limits, per-file audit | **requires setup**: shipped in 0.78.0 *Courier* (owner decision 2026-11-21); the 0.78 signed agent and `files.transfer` | Same | Signed agent + portal | See [file-transfer.md](file-transfer.md) |
| Background terminal (cmd, Windows PowerShell) | **requires setup**: shipped in 0.77.0 *Conduit*, as SYSTEM, with a fresh confirmation (`terminal.open`, default ask) | Same | Signed agent + portal | See [remote-terminal.md](remote-terminal.md) |
| RustDesk's own terminal (1.4.1+) | **On by default and ungoverned**: anyone with the permanent password; SYSTEM with an administrator's credentials | **Closed** (`enable-terminal=N` on every grant) with the **0.78.1** agent; open under 0.73.0–0.78.0 (F1). Camera, remote printer, block-input, privacy mode (RustDesk ≥ 1.4.7) and recording likewise | Signed agent + RustDesk | Unit; Lab (readback and effective state by RustDesk's rule) |
| Session elevation | **unsupported** (refused: `elevation_unavailable`) | **unsupported**; decision 13 (owner, 2026-11-21): none now, a temporary local administrator only after a threat model (roadmap 1.8) | Portal (refuses) | API |
| Maximum session length | **unsupported** (advisory) | **requires setup**: the agent ends it at `maxMinutes` | Signed agent + RustDesk (`stop-service`) | Lab (termination, Windows Server); Unit |
| Ending a session from the console | **unsupported** | **requires setup** (signed revocation) | Signed agent | API; Unit |
| Customer chat (Windows tray) | **available** | **available** | Portal + tray | Fleet (observed); API |
| Chat retention period per business | **planned** (on/off per business is available) | Same | Portal | API |
| MDM for iOS/iPadOS and Android: read-only inventory, ownership, compliance, command history (0.80; [mobile-devices.md](mobile-devices.md)) | **requires setup**: the model, driver interface, sync and pages exist; no real provider can be connected yet (3.2) | — | External provider; portal reads | API (loopback stand-in only); Unit |
| MDM provider acceptance vs device completion, shown separately | **requires setup** (two timestamps, a pure state machine and 0096 CHECKs) | — | Portal, from provider states | API (stand-in); Unit |
| MDM lost-device and destructive actions (lock, lost mode, wipe, retire, work-data removal) | **planned** (3.3; 3.4 with a second approver) | — | External provider | None |
| Backup status, verified restore, drills | **planned** (St0r and Comet evaluated) | — | External provider | None |
| Failover and failback | **unsupported** by either provider | — | — | Provider docs |

## What needs configuring

| To use | You need |
|---|---|
| Monitoring and notifications | Nothing to start: global monitors are seeded. Webhooks: a notification policy ([monitoring.md](monitoring.md)) |
| The signed agent | The signed update channel ([update-signing.md](update-signing.md)), and endpoints moved to it — locally, by GPO/Intune, or from the computer's Agent card (0.34) |
| Approved actions, update deployment | The approval signer, installed separately, with roster approvers who have passkeys ([approved-actions.md](approved-actions.md), [staged-patching.md](staged-patching.md)) |
| Ask AI on event-log entries and alerts (0.48) | A Platform Admin's provider and key in **Settings → AI** (Anthropic, OpenAI or an OpenAI-compatible service). Off until saved and switched on ([ai-and-tickets.md](ai-and-tickets.md)) |
| Background terminal (0.77) | The signed agent 0.77.0 published and installed, a Platform Admin, and a reason; transcripts are off until a Platform Admin turns them on per business ([remote-terminal.md](remote-terminal.md)) |
| Background file transfer (0.78) | The signed agent 0.78.0 published and installed, a Platform Admin, and a reason; up to 100 MB per file until a Platform Admin sets the business's limit (at most 2 GB) ([file-transfer.md](file-transfer.md)) |
| Mobile devices (0.80) | An MDM provider connector, which this release cannot create: the page says **Requires setup** and lists what Intune, the Android Management API and native Apple MDM each need. People need `mobile:view` (a Business Owner has it; off for a Business User; a technician needs it on a whole-business assignment) ([mobile-devices.md](mobile-devices.md)) |
| Create ticket (0.48) | A connector in **Settings → PSA / ticketing**: email-to-ticket (needs the email relay and a confirmed PSA address), a webhook, or ClientSt0r once it advertises tickets. People need `tickets:create` |
| Service control and End process (0.45), removing programs (0.41) | The approval signer, and a signed agent from that release on the computer |
| ClientSt0r ticket analysis and alert tickets | A peers file, the integration worker, organization and technician mappings ([integration-clientst0r.md](integration-clientst0r.md)). **ClientSt0r cannot pair yet**: see the contract's [CLIENTST0R.md](contracts/ticket-rmm-v1/CLIENTST0R.md) |

## What has been tested, and how

| Capability | Real Windows | Simulated | Fixture-tested |
|---|---|---|---|
| Remote access, launch policy | **Yes** (production fleet) | — | Yes |
| RustDesk preflight for Managed Secure Access readiness (0.69) | **Windows Server only**: the Windows lab ran it as the administrator and as SYSTEM against RustDesk 1.4.1–1.5.3 (`TestLabRustdeskPreflight`). Not on a Windows 10/11 desktop or the fleet | The agent's decision code with a fake runner (`internal/msa`) | Yes (`e2e-msa-readiness.mjs`, `unit-msa-readiness.mjs`) |
| Standard agent: heartbeat, inventory, update scan | **In production use**, standard channel: observed, not a controlled test | — | Yes |
| Standard (Linux) agent: heartbeat, inventory, pending updates (0.32) | **No installed Linux endpoint yet** | The real generated script, run unprivileged on a Linux host against a scratch API, reading that host's real `/proc`, `df`, `who` and `apt list`; dnf and zypper from stubs (`e2e-linux-agent.mjs`). Not installed under systemd, not run as root | Yes |
| Standard (macOS) agent: heartbeat, inventory, pending updates (0.33) | **No Mac yet** — **integration-tested only** | The real generated script against a real API and database, but on Linux: every macOS command (`sw_vers`, `sysctl`, `vm_stat`, `top`, `df`, `mount`, `ioreg`, `system_profiler`, `defaults`, `plutil`) is a stub printing recorded macOS output, and run under dash, `bash --posix` and zsh's sh emulation (`e2e-macos-agent.mjs`, `unit-macos-agent.mjs`). Not run on a Mac, under launchd or as root; the installer's macOS steps are only parsed | Yes |
| Monitoring collection (services, events, software) | **Fleet** (observed, not controlled): software inventory on all four computers, and one real event-log alert (DS-HOME1, the false positive fixed in 0.66). No service monitor seen alerting | Under pwsh against stubs (`unit-monitoring.mjs`) | Yes (`e2e-monitoring.mjs`) |
| Mobile devices through an MDM provider (0.80) | Not applicable: **no real provider or phone has been used**; nothing runs on a device | — | Yes, against a loopback stand-in only (`e2e-mdm.mjs`: sync, scope, default deny, cross-tenant 404, accepted vs completed); the state machine and schemas by unit (`unit-mdm.mjs`) |
| One-click diagnostics (the nine catalog checks) | **No** | Parsed by PowerShell's parser and run under pwsh against stubs (`unit-diagnostics-catalog.mjs`) | Yes: real API and database, simulated heartbeat (`e2e-diagnostics-catalog.mjs`) |
| Signed agent: patch scan, install, restart detection | **Fleet**: 218 scans; one direct-mode install, which reported restart required (DEWEY-WKS2022). **Lab**: the scan under Windows PowerShell 5.1 against a WSUS server that does not exist ([lab-testing.md](lab-testing.md)). The restart itself has not been recorded | Yes: `e2e-staged-patching.mjs` runs the agent's real `internal/patch` code through `rem0te-action-sim` | — |
| Patch status: restart required | **No** | Yes | Yes (`unit-patch-summary.mjs`) |
| Patch status: restart completed, confirmed by a later scan | **No** | Yes | Yes |
| Patch status: failed update (Windows' HRESULT) | **No** | Yes | Yes |
| Patch status: offline, stale evidence | **No** | Yes (scan time moved back 80 hours in the database) | Yes |
| Patch status: externally managed (WSUS, Intune) | **No** | Yes (the agent's registry detection against a simulated registry) | Yes |
| Approved actions (Print Spooler) | **No** | Yes (`e2e-approved-action.mjs`) | Yes |
| Agent upgrade from the console (0.34): the request, the heartbeat handing exactly that computer its nonce, the served script and its digest pin | **Fleet**: 9 migrations completed (1 by hand, 8 automatic), 2 cancelled, after the 0.37.3 fix | The heartbeat's agent-status block under pwsh against fixture files (`unit-agent-migration.mjs`) | Yes: real API, real signed repository from `rem0te-release`, a stand-in agent binary (`e2e-agent-upgrade.mjs`) |
| Maintenance actions (service restart, restart schedule/cancel, log collection) | **No** | Yes (`e2e-maintenance-actions.mjs`; service manager, `shutdown.exe`, `wevtutil` and the session count simulated) | Yes |
| Service control and End process (0.45) | **Lab** (Windows Server 2025, administrator): the real service control manager and process table, PID reuse included ([lab-testing.md](lab-testing.md)). Not on a desktop or the fleet | Yes (`e2e-service-process.mjs`; the service manager and process table simulated by `rem0te-action-sim -scm`) | Yes |
| Removing installed programs (0.41–0.42: MSI, quiet, Inno, NSIS, Chromium) | **Fleet**: one removal (DS-HOME1). **Lab**: the quiet string, MSI and both Inno forms. NSIS and Chromium: no | Yes (`e2e-software-catalog.mjs`, stub registry) | Yes |
| Chat files, pictures and emoji (0.44) | **No** — the tray's WebView2 window has not shown a picture or saved a download | `/assist` driven as a page against the real API (`e2e-chat-attachments.mjs`) | Yes |
| Ask AI and Create ticket (0.48) | Not Windows-dependent. **No real AI provider or PSA has been called** | Loopback stand-ins in the Anthropic and OpenAI shapes, a webhook receiver and an SMTP sink (`e2e-ai-psa.mjs`) | Yes (`unit-ai-psa.mjs`) |
| ClientSt0r workflow | — | — | Against a contract-conformant reference peer (`e2e-ticket-workflow.mjs`). **Against the real ClientSt0r: does not interoperate yet** (`interop-clientst0r.mjs`, four measured gaps) |

### Still needs a lab

These are the remaining steps that need hardware or accounts this repository's CI does not have:

1. **A disposable Windows 11 client and a Windows Server 2022** on the signed channel, enrolled to a scratch
   rem0te, each with the five cases set up for real:
   - an update that needs a restart;
   - the same after the restart;
   - an update made to fail (for example, a blocked download host);
   - the machine powered off for 40 hours;
   - one joined to WSUS and one enrolled in Intune with an update ring.
2. A real **authenticator** on the approval roster, to approve a ring.
3. **ClientSt0r**, after it adopts ticket-rmm-v1 ([CLIENTST0R.md](contracts/ticket-rmm-v1/CLIENTST0R.md)), paired
   with a scratch rem0te: `e2e-ticket-workflow.mjs`'s scenarios repeated with ClientSt0r in place of the
   reference peer.

4. **A disposable Debian or Ubuntu VM and a Fedora or openSUSE VM**, installed from a scratch rem0te's Linux
   installer as root, so the systemd timer, the 0600 secret and `--uninstall` run for real.
5. **A Mac (Apple silicon, and ideally an Intel one with Homebrew)** installed from a scratch rem0te's macOS
   installer with `sudo`, so the LaunchDaemon, the root-only secret, the migration of a pre-0.33 secret,
   `--uninstall`, and the real `sw_vers`, `vm_stat`, `top`, `system_profiler` and `com.apple.SoftwareUpdate`
   output are exercised. Until then the recorded output the tests use is the only evidence of those formats.

Until those have been run, a "Real Windows" entry above means either the Windows lab, which is Windows Server
on a disposable runner ([lab-testing.md](lab-testing.md)), or the production fleet, seen working but not tested
under control. Neither is a Windows 10/11 desktop test. The Linux and macOS agents are integration-tested only.
(Corrected in 0.73.2: this page said the column stays **No**, which stopped being true with the 0.68.3 lab;
see [rmm-expansion-audit.md](rmm-expansion-audit.md#stale-statements-found).)
