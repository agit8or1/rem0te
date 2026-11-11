# Inventory and event logs

What a managed computer reports about itself, how it gets here, and how to ask
it for a slice of its Windows event log.

All of it lives on a computer's page, under **Devices → *the machine* →
Overview** and **Event Log**.

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
The one genuinely live view in Rem0te is the host health row on the dashboard,
which describes this server rather than an endpoint.

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

## Event logs

**Devices → *the machine* → Event Log** requests a page of one Windows event
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

---

## Where it is stored

| Table | What |
|---|---|
| `EndpointInventory` | One row per endpoint, rewritten in place. A snapshot, not a history. |
| `EndpointCommand` | The queue. Status, params, result, and who asked. Expires after 30 minutes unclaimed. |

Sizes in `EndpointInventory` are **megabytes**, not bytes. Prisma maps `BigInt`
to a JavaScript `BigInt`, which `JSON.stringify` throws on outright, so a byte
count in a column would take down whichever response carried it. Byte-precise
per-disk figures live inside the JSON columns, where they are ordinary JSON
numbers.

---

## Software and change history (0.29)

From 0.29 the inventory includes **installed software**: what Windows lists under Programs and Features, from
the 64- and 32-bit uninstall registry keys, skipping system components and updates, up to 500 entries. It is
shown on the computer's **Monitoring** tab with a filter.

Each inventory is also **compared with the one before**. Hardware, operating system, disks, network adapters and
software that were added, removed or changed are recorded as a change history on the same tab — *software added:
7-Zip 24.08*, *memory changed: 16 GB → 32 GB*. The first inventory is the baseline and records nothing; a list an
older agent does not report (software, before 0.29) is not compared, so upgrading an agent does not log every
program as newly installed.

Monitors — offline, disk, CPU, memory, services, event-log matches, pending restart — and alerts are described in
[monitoring.md](monitoring.md).

## See also

- [monitoring.md](monitoring.md) — monitors and alerts built on this data
- [clients.md](clients.md) — the managed installer and what it puts on a machine
- [updates.md](updates.md) — the other three things that can be out of date
- [access-control.md](access-control.md) — the capability model
- [architecture.md](architecture.md) — where the heartbeat sits in the whole
