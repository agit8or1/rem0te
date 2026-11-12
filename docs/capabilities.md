# What each agent can do

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
| Chat with the person at the computer (0.34; [chat.md](chat.md)) | No | Yes (0.34+ agent; **not yet run on real Windows**) | No | No | No | No |
| Password rotation, reinstall, RustDesk client update from the console | Yes | Yes | **No** — the console refuses them; re-run the installer on the computer | **No** — the console refuses them; re-run the installer on the computer | No | No |
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

## What needs configuring

| To use | You need |
|---|---|
| Monitoring and notifications | Nothing to start: global monitors are seeded. Webhooks: a notification policy ([monitoring.md](monitoring.md)) |
| The signed agent | The signed update channel ([update-signing.md](update-signing.md)), and endpoints moved to it |
| Approved actions, update deployment | The approval signer, installed separately, with roster approvers who have passkeys ([approved-actions.md](approved-actions.md), [staged-patching.md](staged-patching.md)) |
| ClientSt0r ticket analysis and alert tickets | A peers file, the integration worker, organization and technician mappings ([integration-clientst0r.md](integration-clientst0r.md)). **ClientSt0r cannot pair yet**: see the contract's [CLIENTST0R.md](contracts/ticket-rmm-v1/CLIENTST0R.md) |

## What has been tested, and how

| Capability | Real Windows | Simulated | Fixture-tested |
|---|---|---|---|
| Remote access, launch policy | **Yes** (production fleet) | — | Yes |
| Standard agent: heartbeat, inventory, update scan | **In production use**, standard channel: observed, not a controlled test | — | Yes |
| Standard (Linux) agent: heartbeat, inventory, pending updates (0.32) | **No installed Linux endpoint yet** | The real generated script, run unprivileged on a Linux host against a scratch API, reading that host's real `/proc`, `df`, `who` and `apt list`; dnf and zypper from stubs (`e2e-linux-agent.mjs`). Not installed under systemd, not run as root | Yes |
| Standard (macOS) agent: heartbeat, inventory, pending updates (0.33) | **No Mac yet** — **integration-tested only** | The real generated script against a real API and database, but on Linux: every macOS command (`sw_vers`, `sysctl`, `vm_stat`, `top`, `df`, `mount`, `ioreg`, `system_profiler`, `defaults`, `plutil`) is a stub printing recorded macOS output, and run under dash, `bash --posix` and zsh's sh emulation (`e2e-macos-agent.mjs`, `unit-macos-agent.mjs`). Not run on a Mac, under launchd or as root; the installer's macOS steps are only parsed | Yes |
| Monitoring collection (services, events, software) | **No** | Under pwsh against stubs (`unit-monitoring.mjs`) | Yes (`e2e-monitoring.mjs`) |
| One-click diagnostics (the nine catalog checks) | **No** | Parsed by PowerShell's parser and run under pwsh against stubs (`unit-diagnostics-catalog.mjs`) | Yes: real API and database, simulated heartbeat (`e2e-diagnostics-catalog.mjs`) |
| Signed agent: patch scan, install, restart detection | **No** | Yes: `e2e-staged-patching.mjs` runs the agent's real `internal/patch` code through `rem0te-action-sim` | — |
| Patch status: restart required | **No** | Yes | Yes (`unit-patch-summary.mjs`) |
| Patch status: restart completed, confirmed by a later scan | **No** | Yes | Yes |
| Patch status: failed update (Windows' HRESULT) | **No** | Yes | Yes |
| Patch status: offline, stale evidence | **No** | Yes (scan time moved back 80 hours in the database) | Yes |
| Patch status: externally managed (WSUS, Intune) | **No** | Yes (the agent's registry detection against a simulated registry) | Yes |
| Approved actions (Print Spooler) | **No** | Yes (`e2e-approved-action.mjs`) | Yes |
| Maintenance actions (service restart, restart schedule/cancel, log collection) | **No** | Yes (`e2e-maintenance-actions.mjs`; service manager, `shutdown.exe`, `wevtutil` and the session count simulated) | Yes |
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

Until those have been run, the "Real Windows" column above stays **No**, and the Linux and macOS agents are
integration-tested only.
