# Inventory and event logs

What a managed computer reports about itself, how it gets here, and how to ask
it for a slice of its Windows event log.

All of it lives on a computer's page, under **Computers → *the machine* →
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

| What | Cadence | Cost on the endpoint |
|---|---|---|
| Signed-in user, uptime, last boot | **Every heartbeat** (~3 min) | Two CIM queries |
| Full specs — CPU, memory, disks, GPUs, adapters, BIOS, chassis, serial | **Every 6 hours**, or on request | A handful of CIM queries |
| Windows Update pending patches | **Every 12 hours**, or on request | Tens of seconds, and network |

The Windows Update scan is the expensive one. It starts the Windows Update
agent and goes out to whatever update source the machine is pointed at, which
is why it is a separate command on its own slow cadence rather than part of the
inventory pass. Its timestamp is separate too: *Collected 4m ago* on the
Overview tab does **not** mean the update list was re-checked then.

Everything is a **snapshot**, not a live reading. Free memory and free disk
space are true as of the collection, and the cards say when that was.

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

A staged RustDesk client upgrade also re-runs the installer, so a fleet you
upgrade through **Updates → RustDesk Clients** picks up the new agent as a side
effect.

---

## Event logs

**Computers → *the machine* → Event Log** requests a page of one Windows event
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

## See also

- [clients.md](clients.md) — the managed installer and what it puts on a machine
- [updates.md](updates.md) — the other three things that can be out of date
- [access-control.md](access-control.md) — the capability model
- [architecture.md](architecture.md) — where the heartbeat sits in the whole
