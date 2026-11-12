# Inventory and event logs

What a managed computer reports about itself, how it gets here, and how to ask
it for a slice of its Windows event log.

All of it lives on a computer's page, under **Devices → *the machine* →
Overview**, **Software** and **Event logs** (the tabs are described in
[the technician guide](technician-guide.md#the-device-workspace-031)).

---

## The shape of it

Rem0te has no channel to reach into an endpoint. It never has — a Connect
happens because the API hands out a credential, not because it talks to the
machine. Inventory works the same way, and everything below follows from it:

```
  Console                        Endpoint
     |                              |
     |  stage a command             |
     |  (a row in EndpointCommand)  |
     v                              |
  Postgres                          |
     ^                              |
     |         heartbeat (~3 min)   |
     |<-----------------------------|
     |  response carries the work   |
     |----------------------------->|
     |                              |  collects it
     |  POST /command-result        |
     |<-----------------------------|
```

**Nothing here is synchronous.** Pressing *Refresh* on the Overview tab queues
a collection; the machine performs it on its next heartbeat, up to about three
minutes later. The UI says so rather than spinning, because a spinner with no
explanation reads as a hang.

This reuses the channel the credential rotation and the RustDesk client upgrade
already ride on. There is deliberately no second protocol, and no push channel
to secure.

---

## What is collected, and how often

Three different things can be out of date on a managed machine — the **Rem0te
agent**, the **RustDesk client**, and the machine's own **Windows updates** —
and they are updated by three different mechanisms. The Overview tab names each
rather than merging them.

| What | Cadence | Cost on the endpoint |
|---|---|---|
| Signed-in user, uptime, last boot, **CPU load, free memory, free system-disk space** | **Every heartbeat** (~3 min) | Three CIM queries |
| Full specs — CPU, memory, disks, GPUs, adapters, BIOS, chassis, serial | **Every 6 hours**, or on request | A handful of CIM queries |
| Windows Update pending patches | **Every 12 hours**, or on request | Tens of seconds, and network |
| Installed software (0.29) — name, version, publisher, install date | With the full specs | Two registry reads (64- and 32-bit uninstall keys) |
| Monitored services and event-log queries (0.29) | **Every heartbeat**, only those a monitor asks for | One `Get-Service`, one bounded `Get-WinEvent` per query |

The Windows Update scan is the expensive one. It starts the Windows Update
agent and goes out to whatever update source the machine is pointed at, which
is why it is a separate command on its own slow cadence rather than part of the
inventory pass. Its timestamp is separate too: *Collected 4m ago* on the
Overview tab does **not** mean the update list was re-checked then.

The Resources card at the top of the Overview tab — CPU, memory and system
disk — is fed by the per-heartbeat sample and carries its own timestamp,
`liveSampledAt`. That is separate from `collectedAt` on purpose: one moves
every three minutes and the other every six hours, and one timestamp for both
would let a gauge claim a freshness it does not have.

Everything here is still a **snapshot**, not a live feed — a gauge on that card
is minutes old, not seconds — and every card says when its contents were taken.
The one genuinely live view in Rem0te is the host health on System status
(Platform Admins; it was on the dashboard until 0.31), which describes this
server rather than an endpoint.

---

## "This computer cannot report its specs yet"

Two different messages, two different causes, and they are worth telling apart.

**"…cannot report its specs yet"** — the machine enrolled before per-device
secrets existed, so it has no `agentSecretHash`. The server takes *nothing* it
says beyond an online check: not a hostname, not a rotation, and not an
inventory report. Re-run the managed installer on it. See
[clients.md](clients.md).

**"Specs have not been collected yet"** — the machine is authenticated, but its
agent is older than v0.14.0 and does not understand the command queue. It will
keep being handed an inventory command and will never answer, and after four
heartbeats the queue gives up and says so on the command rather than retrying
forever. Re-running the installer replaces the heartbeat script, which is what
actually upgrades the agent.

### Upgrading the agent

**Devices → *the machine* → Overview → Reinstall agent** re-runs the
installer on the next heartbeat. The installer is idempotent: it keeps the
server configuration, the permanent password and the enrolment, and replaces
the heartbeat script. That is what upgrades the agent.

Use this rather than staging a client upgrade. **Updates → RustDesk Clients**
re-runs the installer as a side effect, but it filters on the client version
and skips any endpoint already on the latest release — so it cannot reach the
machines that are otherwise healthy, which is usually most of them.

> **A machine that has never authenticated with a device secret cannot be
> reinstalled from the console**, and the button says so rather than accepting
> the request. The heartbeat only hands work to an authenticated endpoint, so
> staging for an unbound one would look like it worked and never run. Run the
> installer on that machine once, locally, and it can be managed from here
> afterwards.

The agent version is shown on the Overview tab next to the RustDesk client
version. It is baked into the installer at generation time, so it names the
platform version whose installer last ran — which is exactly the question when
a machine is reporting nothing.

**An agent behind the platform version is not necessarily out of date.** The
agent only changes when the generated heartbeat script changes, which is rarer
than a release: 0.14.0 and 0.15.0 changed it, 0.16.x did not. The Overview tab
compares a reported agent against `AGENT_CONTRACT_VERSION` in
`apps/api/src/common/agent-contract.ts` — the last version in which the agent
actually changed — and flags it only when it falls short of that.

Comparing against the platform version instead, which is what this did at
first, marks the whole fleet outdated on every release including a
documentation fix, next to a button offering a ~40 MB reinstall per machine.
That trains people to ignore the one case that matters. If you change the agent,
bump that constant in the same commit.

---

## Linux computers (0.32)

The Linux installer (`/api/v1/public/install/linux.sh`, from **Devices → Add
device**) now installs the **standard Linux agent** alongside RustDesk:

| File | What it is |
|---|---|
| `/usr/local/lib/rem0te/rem0te-agent` | A POSIX `sh` script, generated by the server and embedded in the installer |
| `/etc/systemd/system/rem0te-agent.timer` / `.service` | Runs it every 3 minutes (first run 2 minutes after boot), as a oneshot with `ProtectSystem=full`, `ProtectHome=read-only`, `NoNewPrivileges` |
| `/etc/rem0te-agent.conf` | `API_BASE=https://<server>/api/v1`, read with `sed`, never sourced |
| `/etc/rem0te-agent.secret` | The device secret, root-only (`0600`); the agent refuses to run if it is any looser |

It authenticates exactly as the Windows agent does: the installer generates the
device secret, the enrolment claim binds its hash to the computer, and every
heartbeat carries it. There is no first-sight binding — a heartbeat whose
secret the server does not hold gets liveness at most, and the agent logs
that the computer needs re-installing from an enrolment link. On the device
list and the workspace it is shown as **Standard (Linux)**; a Linux computer
installed before 0.32 never sends an agent version and stays *RustDesk only*.

**What it reports.** Every heartbeat: host name, OS (`PRETTY_NAME` from
`/etc/os-release`), uptime and last boot (`/proc`), CPU busy share over one
second (`/proc/stat`), memory (`/proc/meminfo`), root filesystem space
(`df /`), everyone with a session (`who`), and the RustDesk package version
(`dpkg-query` or `rpm`). On the 6-hour inventory pass: kernel, architecture,
time zone, CPU model, cores, threads and speed, every real filesystem from
`df` (pseudo-filesystems and duplicates dropped) and, where `/sys/class/dmi/id`
is readable, manufacturer, model, serial, chassis and BIOS.

**Pending updates** come from whatever the computer's package manager already
knows; nothing refreshes a repository or changes a package:

| Package manager | Command | Restart pending |
|---|---|---|
| apt | `apt list --upgradable` (as of the last `apt update` on that computer; never run by the agent). `-security` pockets are marked *Security* | `/run/reboot-required`; *unknown* if `update-notifier-common` (which writes it) is absent |
| dnf | `dnf -q -C check-update` (cache only; an empty cache is a failed scan, not "none") | `needs-restarting -r`, where installed |
| zypper | `zypper --non-interactive --no-refresh list-updates` | `zypper needs-rebooting` |
| none of them | — the scan is reported **failed: "Pending updates unknown"**, never as "0 pending" | unknown |

A scan the agent answers with a failure is not re-staged on the next heartbeat;
the automatic collection waits an hour before asking again (an operator's
*Scan now* is not held back). Before this, a computer that could not answer was
given a fresh scan every three minutes.

**What it does not do.** It is read-only and acts on nothing the server
sends. From the heartbeat response it extracts command ids and three fixed
names — inventory refresh, update scan, and an event-log query, which it
answers with "Event logs are Windows-only" so the request closes rather than
expiring. Credential rotation, reinstall, RustDesk client updates, monitor
queries (services, events), diagnostics and approved actions are ignored; the
console refuses to stage rotation, reinstall and event-log queries for a Linux
computer (`LINUX_AGENT_READ_ONLY`), and a one-click client update skips it.
There is no software list. Everything it sends is reduced on the device to
printable ASCII without `"` or `\`, host names to `A-Za-z0-9._-`, and the
server strips control characters again from every device-reported name
(`enrollment/device-text.ts`) on heartbeat and claim, for Windows too.

### Removing the Linux agent

```bash
curl -fsSL '<the installer URL>' | sudo bash -s -- --uninstall
```

or by hand:

```bash
sudo systemctl disable --now rem0te-agent.timer
sudo rm -f /etc/systemd/system/rem0te-agent.timer /etc/systemd/system/rem0te-agent.service \
  /usr/local/lib/rem0te/rem0te-agent /etc/rem0te-agent.conf /etc/rem0te-agent.secret
sudo systemctl daemon-reload
```

This removes the timer, the script, its config and the device secret; RustDesk
stays (`apt remove rustdesk`). Archive the computer in Rem0te as well:
re-installing later needs a new enrolment link, because the server still holds
the old secret's hash. Logs while it is installed: `journalctl -u rem0te-agent`.

---

## macOS computers (0.33)

Run with `sudo` — which is how **Devices → Add device** shows the command — the macOS installer
(`/api/v1/public/install/mac/<token>`) now installs the **standard macOS agent** alongside RustDesk. It is the
Linux agent's twin: the code that handles the device secret, talks to the server and reads its response is the
same POSIX `sh` (`apps/api/src/public/posix-agent.ts`), and only the measuring differs.

| File | What it is |
|---|---|
| `/Library/Rem0te/rem0te-agent` | The agent, a POSIX `sh` script generated by the server and embedded in the installer |
| `/Library/LaunchDaemons/com.rem0te.agent.plist` | Runs it as root every 180 seconds and at load, at background priority, with `PATH=/usr/bin:/bin:/usr/sbin:/sbin` |
| `/Library/Rem0te/agent.conf` | `API_BASE=https://<server>/api/v1`, read with `sed`, never sourced |
| `/Library/Rem0te/agent.secret` | The device secret, `root:wheel 0600`; the agent refuses it if it is any looser or owned by anyone but root |
| `/var/log/rem0te-agent.log` | What it says, one line a run; rotated by `/etc/newsyslog.d/rem0te-agent.conf` (three 512 KB files) |

Everything is under `/Library/Rem0te`, not `/usr/local`: on an Intel Mac with Homebrew, `/usr/local` belongs to an
admin account, and a root daemon running a script from there could be replaced from that account. The agent fixes
its `PATH` to the system directories for the same reason.

**Without `sudo`** (the plain command on the Downloads page) the installer does what it did before 0.33: RustDesk and
a one-time registration, no agent, and it says how to add one. The computer shows as *RustDesk only*.

**Upgrading a Mac enrolled before 0.33.** Re-run the installer with `sudo` from a new enrolment link. Older
installers kept the device secret in the home directory of whoever ran them; the new one keeps that secret (the
server holds its hash, so the computer stays bound) **only if root wrote it** — owner root, mode 600, not a link —
because a copy a user wrote is one that user knows. It then deletes every copy. A Mac whose old secret was written
by a user gets a new one and is bound by the new link's claim.

It authenticates exactly as the Windows and Linux agents do — the claim binds the secret, every heartbeat carries
it, and there is no first-sight binding. On the device list and the workspace it is shown as **Standard (macOS)**.

**What it reports.** Every heartbeat: host name (`hostname -s`), OS (`sw_vers`: *macOS 14.5*), uptime and last boot
(`sysctl kern.boottime`, converted in `awk` because BSD and GNU `date` disagree), CPU busy share (`top -l 2`, the
second sample — the first is the average since boot), memory (`sysctl hw.memsize`; available is free + inactive +
speculative pages from `vm_stat`), the startup volume's space (`df /`), the **console user** (`who`, the `console`
line — not SSH sessions), and the RustDesk version from `/Applications/RustDesk.app`'s `Info.plist`. On the 6-hour
inventory pass: build and kernel (*23F79, Darwin 23.5.0*), architecture, time zone, CPU model, cores and threads
(`sysctl`; Apple silicon publishes no clock speed), every real volume from `df` with its type from `mount` (the APFS
system volumes under `/System/Volumes` share the startup volume's container and are left out), manufacturer, model
and serial (`ioreg`, one registry class), and the model name and firmware version (`system_profiler
SPHardwareDataType`, cut off after 15 seconds; `ioreg` still supplies model and serial if it is). The hardware UUID
is not sent.

**Pending updates: what macOS last found, never a check of our own.** macOS checks for updates by itself (daily, by
default) and records the result in `/Library/Preferences/com.apple.SoftwareUpdate`. The agent reads that with
`defaults read` — the list (`RecommendedUpdates`), when the check last succeeded, whether automatic checking is on —
and never runs `softwareupdate`:

- `softwareupdate -l` contacts Apple's catalog (or the MDM's), takes from seconds to minutes, can stall behind a busy
  `softwareupdated`, and macOS has no `timeout` command to bound it;
- every other option of it downloads, installs or changes the schedule;
- it is the macOS twin of the Linux agent's "`apt list --upgradable`, never `apt update`".

| macOS recorded | The scan reports |
|---|---|
| A check within the last 36 hours, with a list | The list (each update's name and version) |
| A check within 36 hours and a count of zero | 0 pending |
| No successful check ever | **Failed: "Pending updates unknown"**, naming automatic checking if it is off |
| A check older than 36 hours | **Failed, "unknown"**, with its age — an old list is never shown as current |

36 hours is the Patches tab's own stale threshold, so nothing older is presented as fresh. **Restart pending is
always unknown on a Mac**: macOS does not record it with the list. A failed scan is not re-asked for an hour, as on
Linux.

**What it does not do.** Exactly what the Linux agent does not do: it reads command ids and three fixed names from
the heartbeat response and nothing else, answers an event-log query with "Event logs are Windows-only", and ignores
rotation, reinstall, client updates, monitor queries, diagnostics and actions. The console refuses rotation,
reinstall and event-log queries for a Mac (`MACOS_AGENT_READ_ONLY`), and a one-click client update skips it.
Beyond Linux's list it never runs `launchctl`, `shutdown`, `pmset`, `systemsetup`, `defaults write` or anything that
installs; a binary `Info.plist` is converted with `plutil -convert xml1 -o -`, to standard output, never in place.
No software list.

**How far this is proven: integration-tested only.** `apps/api/scripts/e2e-macos-agent.mjs` runs the real generated
script against a real API and database — but on Linux, unprivileged, with every macOS command replaced by a stub
that prints recorded macOS output, and run under dash, `bash --posix` (what `/bin/sh` is on a Mac) and zsh's sh
emulation. It has not run on a Mac, under launchd or as root, and the installer's macOS steps have only been parsed.
See [capabilities.md](capabilities.md).

### Removing the macOS agent

```bash
curl -fsSL '<the installer URL>' | sudo bash -s -- --uninstall
```

or by hand:

```bash
sudo launchctl bootout system/com.rem0te.agent
sudo rm -f /Library/LaunchDaemons/com.rem0te.agent.plist /etc/newsyslog.d/rem0te-agent.conf \
  /Library/Rem0te/rem0te-agent /Library/Rem0te/agent.conf /Library/Rem0te/agent.secret /var/log/rem0te-agent.log*
sudo rmdir /Library/Rem0te
```

This removes the daemon, the script, its config, its log and the device secret; RustDesk stays (delete
`/Applications/RustDesk.app` to remove it). Archive the computer in Rem0te as well: re-installing later needs a new
enrolment link.

---

## Event logs

**Devices → *the machine* → Event logs** requests a page of one Windows event
log. Pick the log, a time range, the levels, and how many of the most recent
events you want; the request is queued and the table fills in when the machine
answers.

Five logs are readable, and only these five:

```
Application   System   Security   Setup   Windows PowerShell
```

The allowlist is enforced in two places — the API rejects any other name before
a row is written, and the agent checks again before it reads anything, because
the agent is the process that actually holds the log open and it should not be
talkable into opening one nobody authorised.

Bounds, also enforced server-side: **200 events** maximum, **14 days**
maximum, **2000 characters** per message. Those three numbers are what keep the
API's 1 MB request body enough for a full page; raising one without the others
turns a large query into a 413 that looks, from the endpoint, exactly like the
server going away.

### Who can read them

Reading event logs is its own capability, `computers:event_logs`, separate from
`computers:view`:

> Somebody else's System and Security logs are a different kind of access from a
> name and an online dot. Plenty of people who should see the inventory should
> not see every failed logon on the machine.

A Business Owner holds it. A Business User gets it only if the owner turns it
on, under **Users → *the person* → Permissions**. See
[access-control.md](access-control.md).

Every request is written to the audit log as `ENDPOINT_EVENT_LOG_REQUESTED`,
with the log name, the window, the levels and the requesting user. The
*results* are not audited — they are stored on the command row and rendered
once — but the fact that somebody asked always is.

### "No events matched"

The commonest outcome of a narrow query, and not an error. `Get-WinEvent`
treats a filter that matches nothing as a failure rather than an empty result,
so the agent distinguishes the two on the error id (`NoMatchingEventsFound`),
not the message — that message is localised, and keying on its English text
would make every non-English machine report an empty log as broken.

---

## Why there is no "run a command" button

`EndpointCommandType` has three values: `INVENTORY_REFRESH`, `UPDATE_SCAN`,
`EVENT_LOG_QUERY`. Each maps to one specific, read-only collection on the
agent.

There is no type that runs arbitrary code, and adding one would undo the rest of
this system. The agent runs as SYSTEM on every managed machine, the queue is a
database table, and a compromise of the console would otherwise become
arbitrary SYSTEM execution across the whole fleet in one `INSERT`. The blast
radius of the current design is "an attacker learns what hardware a customer
has", which is a different order of problem.

The same reasoning is why the endpoint's own report is not trusted either.
Every string that arrives from a heartbeat is length-clamped, every number is
range-checked, every array is truncated, and every unrecognised field is
dropped rather than stored — a machine that has been taken over must not be
able to park megabytes in a shared database or hand the console markup to
render. Reported timestamps are bounded to 1990–2100, because a machine with a
dead CMOS battery reports 1980 and every "how old is this?" calculation
downstream then reads as absurd.

The one-click diagnostics (0.31, [diagnostics.md](diagnostics.md)) follow the same rule with a different
queue: a request is one of nine catalog keys, the agent maps each to a fixed read-only function, and the
server, the agent and the database all refuse any other key.

---

## Where it is stored

| Table | What |
|---|---|
| `EndpointInventory` | One row per endpoint, rewritten in place. A snapshot, not a history. |
| `EndpointCommand` | The queue. Status, params, result, and who asked. Expires after 30 minutes unclaimed. |
| `DiagnosticRun` | One-click diagnostics (0.31): catalog key, status and the time of each step, who asked, the capped result. See [diagnostics.md](diagnostics.md). |

Sizes in `EndpointInventory` are **megabytes**, not bytes. Prisma maps `BigInt`
to a JavaScript `BigInt`, which `JSON.stringify` throws on outright, so a byte
count in a column would take down whichever response carried it. Byte-precise
per-disk figures live inside the JSON columns, where they are ordinary JSON
numbers.

---

## Software and change history (0.29)

> From 0.34 the same list is one source of evidence for [software version compliance](software-deployment.md#version-compliance)
> (display-name rules only), and the computer's Software tab also shows **Managed software**: the catalog entries,
> with Install / Uninstall through the software catalog's signed, two-approver plans.

From 0.29 the inventory includes **installed software**: what Windows lists under Programs and Features, from
the 64- and 32-bit uninstall registry keys, skipping system components and updates, up to 500 entries. It is
shown on the computer's **Software** tab (0.31; before that, the Monitoring tab) with a filter, the age of the
inventory it came from, and the latest software changes.

Each inventory is also **compared with the one before**. Hardware, operating system, disks, network adapters and
software that were added, removed or changed are recorded as a change history on the **Monitoring** tab — *software added:
7-Zip 24.08*, *memory changed: 16 GB → 32 GB*. The first inventory is the baseline and records nothing; a list an
older agent does not report (software, before 0.29) is not compared, so upgrading an agent does not log every
program as newly installed.

From 0.34 changes are kept for `RETENTION_CHANGE_DAYS` (default 400 days) and then deleted; see
[data-retention.md](data-retention.md).

Monitors — offline, disk, CPU, memory, services, event-log matches, pending restart — and alerts are described in
[monitoring.md](monitoring.md).

## On the device list (0.31)

The **Devices** list shows a summary of the same stored data, one row per device, without opening each one:

| Column | Source | Stale after |
|---|---|---|
| Logged-in user | `loggedOnUser` from the live sample | 15 minutes (greyed with the sample) |
| CPU / RAM / disk | `cpuLoadPercent`, `memoryFreeMb`/`memoryTotalMb`, `systemDiskFreeMb`/`systemDiskTotalMb`, sampled at `liveSampledAt` | 15 minutes — five missed three-minute heartbeats |
| Pending patches, *restart* | the signed agent's patch scan (`patchPosture`) if there is one, otherwise the standard agent's update scan (`pendingUpdates`, `rebootRequired`) — the same precedence as the Patches tab | 36 hours — the Patches tab's threshold |

Nothing on the list is fetched from the machine when the list loads: every value is what the last heartbeat or
scan stored, shown with its age, and greyed once it is stale. *Not sampled* and *No scan* mean nothing has been
reported, not zero.

Filtering, sorting and paging happen on the server (`GET /endpoints/list`), so a list of thousands is never sent
to the browser. The first step selects the caller's visible devices with the same access rules as every other
device query; the second derives alert counts, patch counts and percentages for exactly those ids, then filters,
sorts and pages them. **Export CSV** (`GET /endpoints/list/export.csv`) returns the whole filtered view — up to
10,000 rows — and is written to the audit log (`ENDPOINT_LIST_EXPORTED`) before the file is sent. Device-reported
text that a spreadsheet would read as a formula is prefixed with an apostrophe.

## See also

- [monitoring.md](monitoring.md) — monitors and alerts built on this data
- [diagnostics.md](diagnostics.md) — one-click read-only diagnostics
- [clients.md](clients.md) — the managed installer and what it puts on a machine
- [updates.md](updates.md) — the other three things that can be out of date
- [access-control.md](access-control.md) — the capability model
- [architecture.md](architecture.md) — where the heartbeat sits in the whole
