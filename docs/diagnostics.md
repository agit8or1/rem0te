# One-click diagnostics

From 0.31 a Windows device with the standard agent has a short list of **read-only diagnostics** a technician
can run with one click: disk space, services, recent errors, the busiest processes, network reach, DNS, pending
updates, restart status and a fresh inventory. Each one is a fixed check that the agent already carries. Nothing
on the device is changed, no approval is needed, and every run is recorded in the audit log.

From 0.33 the same catalog also carries three **full snapshots** — every process, every service and every network
connection — shown on the device page's **Processes**, **Services** and **Network** tabs rather than in the
Diagnostics list. See [The Processes, Services and Network tabs](#the-processes-services-and-network-tabs).

From 0.76 it also carries thirteen more read-only checks — **security posture, networking and maintenance** — each
result read as findings marked Healthy, Warning, Critical, Unknown or Unsupported. See
[The read-only palette (0.76)](#the-read-only-palette-076).

This is not a "run a command" feature, and it cannot become one. The request names a **catalog key** — and, for the
two 0.76 network tests only, a host name and port checked against closed rules — and nothing else; there is no
script box to type into. Why that matters is in [inventory.md](inventory.md#why-there-is-no-run-a-command-button).

## The catalog

| Key | What it reports | Takes | Needs |
|---|---|---|---|
| `refresh_inventory` | Hardware, OS, disks, network adapters and installed software, written to the Specs tab (the same collection as the Refresh button) | About a minute | View devices |
| `disk_space` | Size, free space and percent free of every fixed volume | Seconds | View devices |
| `service_health` | Services set to start automatically that are not running, and every service a monitor watches on this device, with its state | Seconds | View devices |
| `recent_system_errors` | Critical and Error events from the System and Application logs in the last 24 hours, grouped by source and event id: count, first and last time, and one shortened message | Seconds | **Read event logs** |
| `top_processes` | The ten processes using the most processor time and the ten using the most memory: name, process id, CPU seconds, working set | Seconds | View devices |
| `network_connectivity` | Whether the device can open a TCP connection to this rem0te server on port 443, and each network adapter's state and addresses | Seconds | View devices |
| `dns_resolution` | The DNS servers in use, and the answer and time for this server's name and for `dns.msftncsi.com` | Seconds | View devices |
| `pending_updates` | Updates Windows Update offers but has not installed (the existing update scan), written to the Patches tab. Installs nothing | Several minutes | View devices |
| `reboot_status` | Whether a restart is pending and which signal says so — component servicing, Windows Update, files waiting to be replaced, the update agent — and the last boot | Seconds | View devices |
| `process_list` (0.33, Processes tab) | Every running process: name, process id, processor time, working set, the user it runs as (where the agent can read it) and when it started | Seconds | View devices |
| `service_list` (0.33, Services tab) | Every installed service: name, display name, state, start mode and the account it runs as | Seconds | View devices |
| `network_adapters` (0.33, Network tab) | Every connection Windows lists under Network Connections: status, speed, MAC, IPv4/IPv6, gateways, DNS servers and suffix, DHCP server and lease | Seconds | View devices |

Every entry is `risk: read_only`, expected impact *none*, approvals *none (read-only)*, supported on Windows only.
The keys are stable and snake_case: `INTEGRATION_COORDINATION.md` §5 (in the repository root) proposes
offering this catalog to ClientSt0r later (P1/P2). No integration route exists yet.

**Why those permissions.** Everything except `recent_system_errors` reports what the Specs and Monitoring tabs
already show, so it needs only *View devices* — the same as the inventory Refresh button. The 0.33 snapshots add
the account each process and service runs as; that is the same kind of fact as the signed-in user the device header
already shows, so they stay at *View devices* too. Command lines, which can carry secrets, are never collected
by any key. `recent_system_errors`
returns event-log message text, which is exactly what *Read event logs* gates on the Event Log tab. Someone without
it sees that the diagnostic ran, and when, but not what it said.

## What a run looks like

There is no connection into a managed device, so a run is a request the device collects:

| Status | Means |
|---|---|
| **Requested** | Waiting for the device's next check-in, normally within three minutes |
| **Delivered** | The heartbeat handed it to the device |
| **Running** | The agent said it started |
| **Completed** | The result arrived and was stored |
| **Failed** | The agent reported an error, the result was malformed, or the requester lost access before delivery |
| **Expired** | It stalled — and the run says where (below) |

Each step's time is shown, with who asked and how old the result is. Clicking **Run** again while a run of the
same diagnostic is still open returns the open one.

**Why a run expires**

| Stalled at | After | The run says |
|---|---|---|
| Requested | 15 minutes | The device did not check in: it is probably offline, asleep, or its heartbeat task is not running |
| Delivered | 10 minutes | It never started: the agent probably predates 0.31 — reinstall the agent from the Specs tab |
| Running | 5, 10 or 30 minutes (by how long the diagnostic takes) | No result arrived: the device may have gone offline mid-run |

**Limits.** At most 20 runs per device and 40 per person in any ten minutes (HTTP 429 beyond that), three runs
handed to a device per check-in, and the fleet abuse guard applies as it does to an event-log fetch.

## What the device does

The heartbeat response carries `diagnostics: [{ id, key }]` — with `params` only for `dns_lookup` and `tcp_port`
(0.76, below) — and only to a heartbeat that
authenticated with the device secret. The agent checks the key against its own copy of the catalog, maps it to one
fixed function compiled into `heartbeat.ps1`, and posts `running`, then the result, to
`/enrollment/diagnostic-result` with the device secret. The functions only read: CIM queries, `Get-Service`,
`Get-WinEvent`, `Get-Process`, registry presence checks, a DNS lookup and one TCP connect to this server. A key it
does not know is refused and reported as failed.

**Never collected:** command lines, executable or service binary paths, process modules, environment variables,
the contents of the pending-rename list (it holds file paths), or any secret. The account a process or service runs
as is collected by the 0.33 snapshot keys only (`process_list`, `service_list`) and by no other key. Event messages
have user-profile paths (`C:\Users\name\…`) replaced with `%USERPROFILE%` on the device and again on the server.

## What the server keeps

Every result is re-shaped field by field before it is stored (`apps/api/src/diagnostics-catalog/catalog.ts`):
unknown fields dropped, strings clamped and stripped of control characters, profile paths and long opaque tokens
redacted, numbers range-checked, lists cut (50 error groups, 10 processes, 16 adapters…), and the whole result
capped at **32 KB** — **128 KB** for the three snapshot keys, which list everything. A run is only updated by the device it was staged for, under its own key. `service_health`
keeps only the monitored services this server asked about. `refresh_inventory` and `pending_updates` go through the
inventory service exactly as the automatic collections do, and the run keeps a summary.

The catalog is closed in four places: the request (unknown key: 400 `UNKNOWN_DIAGNOSTIC`), the heartbeat, the
result, and the database — `DiagnosticRun.key` has a `CHECK` constraint listing the twenty-five keys (migration 0042
added the snapshots, 0092 the palette, along with a `CHECK` on `params`), and results over 64 KB (256 KB for a snapshot) are refused by another. Adding a diagnostic is
a migration on purpose. `scripts/check-security-invariants.mjs` §20 checks all of it, and §31 the snapshots.

**Who may see what.** Every route here applies customer scope *and* the device-list visibility rule: a Business User
sees only the devices granted to them (or marked company-wide), and any other device — in their customer or
not — reads as missing (404). Before 0.33 only customer scope was checked here, so such a user could stage a run on
a device they could not see (it then failed at delivery) and read that device's run history.

**Audit.** `ENDPOINT_DIAGNOSTIC_REQUESTED` (who, which key, the run) and `ENDPOINT_DIAGNOSTIC_COMPLETED` (outcome
completed, failed or expired, size, whether truncated) — never result content. **Automatic snapshots (0.35) are not
audited run by run** (see [below](#automatic-snapshots)): the run itself, with no requester, is their record, and
changing the schedule is audited (`SNAPSHOT_SCHEDULE_CHANGED`, before and after). A result posted with the wrong device
secret is `ENDPOINT_HEARTBEAT_REJECTED`, reason `diagnostic_result_unauthenticated`.

## Routes

| Route | Who |
|---|---|
| `GET /endpoints/:id/diagnostics/catalog` | View devices; the catalog with `allowed` per entry for you; from 0.76 also `group`, `minAgent`, `params`, `evidence` and `needsNewerAgent` per entry, the device's `agentVersion`, and `osSupport` |
| `POST /endpoints/:id/diagnostics/runs` `{ "key": "disk_space" }` | View devices, plus the entry's permission. `params` only for `dns_lookup` (`{ "name" }`) and `tcp_port` (`{ "host", "port", "timeoutSeconds" }`), otherwise 400 `INVALID_DIAGNOSTIC_PARAMS`; 409 `DIAGNOSTIC_NEEDS_NEWER_AGENT` for a 0.76 key on an older agent |
| `GET /endpoints/:id/diagnostics/runs` | View devices; results withheld where you lack the entry's permission |
| `GET /endpoints/:id/diagnostics/runs/:runId` | As above |
| `GET /endpoints/:id/diagnostics/snapshots/:key` (0.33) | View devices; `key` is `process_list`, `service_list` or `network_adapters` (anything else: 400 `UNKNOWN_SNAPSHOT`). The newest completed result, `takenAt`, an open refresh (`pending`) and a newer failure (`lastFailure`); from 0.35 also `automatic` (`state`, `reason`, `nextAt`, `intervalMinutes`, `basis`), `agentSilent` and `agentVersion`. Reading it marks the tab as open (see below) |
| `GET /admin/snapshot-schedule`, `PUT /admin/snapshot-schedule` (0.35) | Platform Admin. The automatic snapshot schedule; `PUT` takes any of `enabled`, `minutes` (per key) and `watchMinutes` |
| `POST /enrollment/diagnostic-result` | The device, with its device secret |

## The read-only palette (0.76)

Thirteen checks in three groups on the Diagnostics tab (and in the device's Tools panel), each run on its own or —
for Security — all five with **Run all security checks**. Same path as every other key: the same request route,
heartbeat delivery, device secret, scope, capability, containment, audit, expiry and limits. No new action, nothing
signed, no new route. Every one only reads; none changes the device.

| Key | Group | What it reads | Never read | Needs |
|---|---|---|---|---|
| *Windows support* (no key) | Security | Worked out **on the server** from the stored inventory's caption and build against a static end-of-servicing table (`OS_SUPPORT` in `interpret.ts`, reviewed 2026-11-20; it reads Unknown once it is a year old). Nothing is asked of the device or of any network service | — | View devices |
| `defender_status` | Security | `Get-MpComputerStatus`: real-time, behaviour monitoring, tamper protection, running mode, signature version and date, last quick and full scan; on a desktop, the antivirus products Security Center lists (Server has no Security Center) | Exclusions, threat history | View devices |
| `firewall_status` | Security | `Get-NetFirewallProfile -PolicyStore ActiveStore` (what is in force, including Group Policy): each profile on or off and its default actions; the active network categories; the firewall service | Rules | View devices |
| `bitlocker_status` | Security | `Get-BitLockerVolume`: each volume's type, protection, encryption state, method and percentage, and the **kinds** of protector (TPM, recovery password…). Unsupported where the BitLocker feature is not installed (Server by default) | **Recovery passwords and protector ids** | View devices |
| `secure_boot_tpm` | Security | `Confirm-SecureBootUEFI` (on, off, or Unsupported on legacy BIOS), `Get-Tpm` and `Win32_Tpm`'s spec version | TPM owner authorisation | View devices |
| `local_admins` | Security | The Administrators group by its SID (`S-1-5-32-544`): names, kinds and sources only, from `Get-LocalGroupMember`, falling back to the CIM group association where that fails (it does on some domain-joined machines) | SIDs | View devices |
| `dns_lookup` | Networking | The system resolver's answer for a name **you give**, with the time taken, and the configured DNS servers | — | **Remote connect** |
| `tcp_port` | Networking | Whether a TCP connection to a host and port **you give** opens within 1, 2, 3, 5 or 10 seconds: open, refused, no answer, not resolved. It connects and closes; nothing is sent or read | — | **Remote connect** |
| `route_table` | Networking | `Get-NetRoute`: the default route and gateway, and up to 400 routes (multicast and link-local dropped) | — | View devices |
| `time_sync` | Maintenance | The W32Time configuration from the registry, the service state, and `w32tm.exe /query /status` from System32 — the only program the palette runs | — | View devices |
| `windows_activation` | Maintenance | `SoftwareLicensingProduct` for Windows: name, channel, licence status, grace remaining | **Product keys, partial keys** | View devices |
| `unexpected_shutdowns` | Maintenance | The System log, last 30 days, ids 41 (Kernel-Power), 6008 (unexpected shutdown) and 1001 (blue screen, with its bugcheck code), at most 200 events | Event message text | View devices |
| `scheduled_tasks` | Maintenance | Every task that is not Microsoft's: path, name, state, author, the account it runs as, last and next run and last result; Microsoft's own are only counted | **Task actions** (commands and arguments) | View devices |
| `signed_in_sessions` | Maintenance | Who is signed in, one row per session, from the owners of `explorer.exe` | — | View devices |

`reboot_status` (0.31) is interpreted the same way from 0.76.

**Why Remote connect for two of them.** Every other check reports a fact about the device. The DNS lookup and
TCP test make it reach a host the requester names, on its own network — what a remote session already lets someone
do — so they need the same permission (`computers:connect`).

**Typed parameters.** Only those two keys take any, and only these: `dns_lookup { name }` and `tcp_port { host,
port, timeoutSeconds }`. A name is 1–253 characters of dot-separated labels (letters, digits and inner hyphens, at
most 63 to a label; an IPv4 literal passes, a URL, a path, a space, a shell character or a line break does not); a
port is an integer 1–65535; the timeout is one of 1, 2, 3, 5 or 10 seconds (default 5). The same rule, character
for character, is checked by the portal (`parseDiagnosticParams`, at request and again at delivery), by the
database (0092's `CHECK`) and by the agent (`Test-Rem0tePalHost`, `Test-Rem0tePalKeys`), which refuses anything
else as a failed run before it resolves or dials anything. Asking again for the same target returns the open run; a
different target is a new run. The request's audit entry records the parameters.

**States.** Each result is turned into findings by one pure module, `apps/api/src/diagnostics-catalog/interpret.ts`,
each stamped with the time of the evidence (the run's completion). The overall state is the worst finding, in the
order Critical, Warning, Unknown, Unsupported, Healthy — so **something that could not be read is never shown as
Healthy**. The thresholds:

| Finding | Warning | Critical |
|---|---|---|
| Defender signatures | older than 3 days | older than 7 days; real-time protection off with no other antivirus enabled |
| Last scan | older than 14 days | — |
| Firewall profile | off and not in use; inbound allowed by default | in use and off; Public off; the service stopped |
| BitLocker | protection suspended, not encrypted, encrypting | — |
| Secure Boot / TPM | off / absent or not ready | — |
| Local administrators | more than three user accounts besides the built-in one; a member that cannot be named | — |
| DNS lookup | slower than one second | failed or timed out |
| TCP port | — | refused, no answer, not resolved |
| Time sync | last sync older than 8 days; a free-running clock; the service stopped | last sync older than 30 days |
| Activation | in a grace period | unlicensed, or in notification |
| Unexpected shutdowns | one or two dirty restarts | three or more, or any blue screen |
| Scheduled tasks | a task whose last run failed | — |
| Windows support | ends within 90 days | ended (unless the device has Extended Security Updates, which cannot be seen from here) |

**Agent version.** The checks live in the served `heartbeat.ps1`, not in the signed Go agent, so there is no new
agent binary. A standard agent gets them when it is reinstalled or updated from a 0.76 portal; a signed agent gets
them with the next signed release published at or after 0.76.0 (`rem0te-signed-publish`). A device that reports an
older agent is refused a palette key with `DIAGNOSTIC_NEEDS_NEWER_AGENT`, and the tab says so. If an older agent is
handed one anyway, it reports the key as unknown and the run fails at once with "update the agent".

**The guard.** Every served script passes `assertPaletteBlockSafe` (`windows-script.ts`) when it is built: only
`Get-*` and a short read-only list of commands; no `Set-`, `Enable-`, `Disable-`, `Remove-`, `Start-`, `Stop-` or
`Restart-`; no `Invoke-Expression`, no download, no script block; a fixed list of .NET calls; one `New-Object` (the
TCP client); and the call operator exactly once, on the `w32tm.exe /query /status` line. It also refuses reading a
recovery password, protector id, product key or a task's actions. `check-security-invariants.mjs` §86 checks the
same things independently of the guard.

**It has run only on GitHub's Windows Server runner**, and the console labels every palette check that way. See
[How far this has been tested](#how-far-this-has-been-tested).

## The Processes, Services and Network tabs

From 0.33, a Windows device's page has three more tabs. Each shows the newest result of one catalog key, **when it
was taken and how old it is**, and a **Refresh** that asks for a new one exactly as **Run** does on the Diagnostics
tab — the request carries the key and nothing else, and the device answers on its next check-in (normally within
three minutes). While a refresh is on its way the old snapshot stays on screen with the refresh beside it; if the
refresh fails or expires, the reason is shown and the last good snapshot stays. A snapshot more than a day old is
flagged. These are pictures of a moment, not live views.

From 0.35 the server also takes them **automatically** ([Automatic snapshots](#automatic-snapshots)), and the tab
**updates itself**: it re-reads every 4 seconds while a refresh is on its way and every 30 seconds while it is open
(not while the browser tab is hidden), so a new snapshot appears without a reload. Under the age it says how often the
snapshot is refreshed and roughly when the next automatic one is due.

| Tab | What it lists | Bounds |
|---|---|---|
| **Processes** | Name, PID, processor time since start, working set, user, start time; sortable and filterable. If the agent could not read users (`Get-Process -IncludeUserName` needs elevation), the tab says so | The agent sends the 1,000 largest by memory; the server keeps 1,000 and cuts to 128 KB |
| **Services** | Display name, name, state, start mode (including delayed start) and the account it runs as; a filter, and *Automatic, not running* | 1,000 services; 128 KB |
| **Network** | One card per connection: status, speed, IPv4/IPv6, gateway, DNS servers and suffix, MAC, DHCP server and lease | 32 adapters, 16 addresses each |

![The Processes tab: the snapshot notice, its age, Refresh, the filter, the sortable columns and End process](screenshots/guide/device-processes.png)

1. **Read-only snapshot** — the list itself is a picture of a moment; reading it changes nothing on the device.
2. **When it was taken** — how old it is (flagged after a day) and who asked, or *automatically*. The amber line
   under it is the docs server's own: it runs with `SNAPSHOT_SWEEP=off`, so it never asks for one itself, and the tab says so.
3. **Refresh** — asks for a new one on the device's next check-in.
4. **Filter** — by name, PID or user. *Keep refreshing* beside it asks for a new list at most once a minute while
   the tab is open.
5. **The columns** — click one to sort.
6. **End process** (0.45) — a signed approved action on this one process. Core Windows, security, rem0te and RustDesk
   processes show *Protected* instead; see [Services and Task Manager](approved-actions.md#services-and-task-manager-045).

![The Services tab filtered to "sp": the Print Spooler stopped, with Start and Startup type…](screenshots/guide/device-services.png)

1. **Filter** — by display name or name; *Automatic, not running* beside it.
2. **A service** — state, start mode and account. This Print Spooler is the one the open Windows-service alert is about.
3. **Refresh** — as on Processes.
4. **The row's buttons** (0.45) — only the operations allowed for this service: here *Start* and *Startup type…*,
   because it is stopped. Each is a signed approved action; protected services show *Protected* and the reason.

![The Network tab: one card per adapter](screenshots/guide/device-network.png)

1. **An adapter** — status, speed, addresses, gateway, DNS, MAC and the DHCP lease.
2. **A disconnected adapter** — listed with its status rather than hidden.
3. **Refresh** — as on Processes.

**Reading a snapshot never acts on the device.** From 0.45 the Services tab's row buttons (*Start*, *Stop*,
*Restart*, *Startup type…*) and the Processes tab's *End process* are signed approved actions, each on one device,
needing the approval signer and a 0.45+ signed agent: see
[Services and Task Manager (0.45)](approved-actions.md#services-and-task-manager-045). They have been tested only
against a simulated Windows. Without the signer or that agent, the rows say why and offer nothing. When a result had
to be cut to fit, the tab says so.

## Automatic snapshots

*Added in 0.35.* Before 0.35 a snapshot existed only once someone pressed Refresh, so a device nobody had looked at
showed *Never taken on this device*. Now the server asks for each one itself.

**How.** On the heartbeat — not a sweep over the fleet. When a device checks in and one of its snapshots is older
than its interval, that heartbeat's response asks for it, as an ordinary diagnostics run with **no requester**. It is
delivered, sanitised, capped (128 KB) and stored exactly like one a person asked for, and the tab shows it as taken
*automatically*. A device that is not checking in is never asked, so nothing piles up for it. A Refresh while an
automatic run is open returns that run, so the device collects once.

**When** (defaults; Settings → Monitoring & API → *Automatic snapshots*, Platform Admin, audited):

| | Default | Range |
|---|---|---|
| Processes, Services, Network adapters | every **6 hours** each | off, or 1 hour – 7 days |
| While the snapshot's tab is open | every **5 minutes** | off, or 3 – 60 minutes |
| Switch | on | — |

The 6 hours is the inventory pass's cadence. A process list is out of date within minutes, so polling it hourly across a
fleet buys little: the 5-minute interval while the tab is open is what keeps it current when someone is looking. "Open"
means the snapshot was read in the last 90 seconds (the tab re-reads every 30 s), by someone who can see the device;
a refused read does not count. The sizes behind the numbers are in [server-sizing.md](server-sizing.md#automatic-snapshots-035).

After a failed or expired automatic run the next one waits an hour (or the interval, if shorter) rather than going
out on the next heartbeat. At most `SNAPSHOT_MAX_PER_MINUTE` (default 120) scheduled runs start per minute across the
server, so the first round after an upgrade or an outage is spread over a couple of hours; a key held back stays due.
Watched runs are not held back.

**A device with nothing due is not re-checked on every heartbeat (0.36).** When a heartbeat finds none of the
three keys due and none open, the API remembers, in its own memory, when the soonest one falls due — capped at an
hour — and answers that device's heartbeats until then without the three database reads that decide it. Opening a
tab, a result arriving, a run expiring and a change to the intervals all end the window at once, so a watched key is
still asked for on the next heartbeat. What it does not see is a row changed in the database by hand or by the
[retention sweep](data-retention.md): that is noticed when the window ends, at most an hour later. A restart forgets
every window, which costs one full check per device. `SNAPSHOT_QUIET=off` turns it off. The cost it removed is in
[server-sizing.md](server-sizing.md#automatic-snapshots-035).

**Who is asked.** A device that is active, on Windows, bound to a device secret, running an agent from **0.33 or
later** (older agents do not know the snapshot keys: 0.31–0.32 refuse them and anything earlier never starts them),
and checking in (a heartbeat in the last 30 minutes, the same window the device header uses for *Online*). When one of these fails, the tab says which instead of offering a
Refresh that would expire:

| The tab says | Why |
|---|---|
| *Reachable (RustDesk) · agent silent …*. Its agent has not checked in since …, so remote control should work but nothing can be collected until it does (or, when RustDesk cannot reach it either, just "Its agent has not checked in since …") | `agent_silent`: no heartbeat for 30 minutes (the header's *Reachable (RustDesk) · agent silent* window). `isOnline` can still be true through RustDesk (0.34); nothing can be collected until the agent checks in |
| This device's agent (0.32.0) predates 0.33 … | `agent_too_old`; reinstall the agent |
| … has never reported its version … | `agent_unknown` |
| Collected by the Windows agents only … | `unsupported_platform`: the Linux and macOS agents run nothing the console asks for |
| Automatic snapshots are turned off on this server | `disabled` in Settings |
| … not on an automatic schedule | `key_off`: this key's interval (and the open-tab one) is off |
| … switched off where this server runs (SNAPSHOT_SWEEP=off) | `process_off` |

No snapshot is ever made up: a tab with nothing taken says *Never taken* and why.

**What is kept.** Only the newest completed automatic run of each key per device: an older one is deleted when a
newer one completes, and a failed one when the next is asked for. People's runs are left to the
[retention sweep](data-retention.md), which also covers automatic ones. The database refuses an automatic run of any
key but the three snapshot keys, and a second open automatic run of a key (migration 0059).

**Containment does not apply.** No pause kind covers reading: a pause stops writes, and viewing keeps working during
one ([containment.md](containment.md)) — the same as the automatic inventory pass and a manual Refresh.

**Off switch.** `SNAPSHOT_SWEEP=off` in the API's environment stops all automatic requests in that process (Refresh
still works); Settings then says so. The e2e runner and the browser suite set it for every suite but
`e2e-auto-snapshots.mjs`. `check-security-invariants.mjs` §50 checks the rules above.

**MAC addresses** are shown in full, as on the Specs tab: no masking policy applies to them today. (RustDesk IDs
are masked in the device list; that is a different identifier.)

**What the agent runs.** Three functions in `heartbeat.ps1`, reached only from the catalog switch:
`Get-Process -IncludeUserName` (falling back to `Get-Process`), `Get-CimInstance Win32_Service`, and
`Get-CimInstance Win32_NetworkAdapter` / `Win32_NetworkAdapterConfiguration`. Every string put into a result goes
through one of two helpers first — one strips control characters and clamps, the other also requires an explicit
charset (process names may not contain a path separator; accounts, service names, MACs, addresses and DNS suffixes
each have their own) — and is checked again on the server. A **build-time guard** (`assertSnapshotBlockSafe` in
`public/windows-script.ts`) refuses to produce an installer whose snapshot block calls anything but `Get-*`
cmdlets (plus `Sort-Object` / `Select-Object`), uses `Invoke-*`, `iex`, script blocks, the call operator,
`New-Object` or `Add-Type`, reads `PathName`, `CommandLine`, `.Path`, modules or the environment, or puts a field
into a result without one of the helpers — the same idea as `RustdeskService.joinPs()`, for the one script that is
not built from statements.

**Linux.** Not offered. The standard Linux agent reads only command ids and three fixed command types from the
heartbeat response, never a diagnostics run, and `systemctl` is deliberately absent from it (§24). Adding these
would mean widening what that agent reads and runs, so the tabs are not shown for Linux and a request is refused
(`DIAGNOSTIC_OS_UNSUPPORTED`).

## How far this has been tested

| | Real Windows | Simulated | Integration |
|---|---|---|---|
| The diagnostics block in `heartbeat.ps1` | **No** | Parsed by PowerShell 7.4's parser, both installer variants; run under pwsh against stub cmdlets (`unit-diagnostics-catalog.mjs`) | — |
| Request, delivery, results, expiry, limits, cross-customer refusal, audit | — | — | Real API and database with a simulated heartbeat (`e2e-diagnostics-catalog.mjs`) |
| The 0.76 palette (thirteen checks) | **Windows Server only**: GitHub's `windows-latest` runner, Windows PowerShell 5.1, as the administrator and as SYSTEM, read-only, with a before/after configuration fingerprint (`tools/lab/windows/diagnostics-lab.mjs`, the `agent-lab-windows (diagnostics palette)` job). Never on Windows 10/11 or the fleet | Parsed and run under pwsh against stubs in a desktop and a Server world, with secrets planted in the stubs that must not reach a post; the build-time guard proven by mutation (`unit-diagnostics-palette.mjs`) | Catalog, typed parameters, the 0092 CHECK, Remote connect, the agent-version refusal, results and interpretation (`e2e-diagnostics-palette.mjs`) |
| The 0.33 snapshot functions | **No** | Parsed with `ParseFile()`; run under pwsh 7.4 against stub `Get-Process` / `Get-CimInstance`, elevated and not, with hostile values and 1,505 processes (`unit-system-inventory.mjs`); the build-time guard proven by mutation | Request → heartbeat → result, hostile and oversized results, visibility, A/B isolation, capability, audit (`e2e-system-inventory.mjs`) |

The stubs stand in for `Get-CimInstance`, `Get-Service`, `Get-WinEvent`, `Get-Process`, the registry and the TCP
connect. Until it has run on a real Windows machine, treat property names that differ between Windows PowerShell 5.1
and PowerShell 7 (for example a delayed-start service's `StartType`) as unverified. The same goes for the snapshots:
`Win32_Service.DelayedAutoStart` is absent on older Windows builds (the start mode then reads *Automatic*),
`Get-Process -IncludeUserName` has not been run as SYSTEM on a real machine, and a real `Win32_NetworkAdapter`
`Speed` for a disconnected adapter is assumed to be the Int64 maximum (dropped as unknown).

## See also

- [inventory.md](inventory.md) — the specs, update scan and event-log fetch these reuse
- [monitoring.md](monitoring.md) — monitors, whose watched services `service_health` reports
- [capabilities.md](capabilities.md) — what each agent type can do
