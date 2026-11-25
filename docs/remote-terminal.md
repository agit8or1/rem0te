# Background terminal

*0.77.0 "Conduit".* A Platform Admin can open a **cmd** or **PowerShell**
prompt on a Windows device without a screen-sharing session. Nothing appears
on the device's screen. The shell runs as **SYSTEM**, which means **full
control of the device**. The console says so wherever a terminal can be
opened.

This is a deliberate exception to rules Rem0te has kept since 0.26, made at the
owner's request. Normally the agent runs only approved, signed catalog actions
and never a command line built from input. A terminal runs whatever is typed.
[What it reverses, and what still holds](#what-it-reverses-and-what-still-holds)
lists exactly what changed. Read it before turning anything on.

## Who can use it

| | Open a terminal, see its output, type | See that a terminal was opened | End someone's terminal |
|---|---|---|---|
| Platform Admin | yes | yes | yes (revoke) |
| Business Owner | **no** | yes, on their devices | yes (revoke) |
| Business User with *Edit devices* | **no** | yes | yes (revoke) |
| Business User without it | no | yes, with *View devices* | no |
| MSP technician | **no** | yes, on assigned devices | no |

**Only a Platform Admin holds the `computers:terminal` capability.** It is not
a customer capability, for these reasons:

- A Business Owner does not get it. An owner's capabilities are the whole
  customer list.
- No grant can carry it. That covers a Business User grant, a technician
  assignment or preset, and an SSO mapping. The server drops it from anything
  stored, and the Users page offers no checkbox for it.

A Business Owner decides who in the customer may connect. If owners could also
grant a SYSTEM shell on every device, default-deny would become a setting the
customer could switch off. Letting a Platform Admin delegate the terminal to a
named person, with its own audit trail, is [planned](#planned).

The person who opens a terminal is its only technician. Nobody else sees its
output or can type into it, not even another Platform Admin. Anyone else who
can see the device sees that the terminal exists: who opened it, the shell,
the reason, when, and the byte counts.

## Opening one

Open the device and go to the **Terminal** tab, or **Tools → Terminal → Open
a terminal**. Then:

1. Choose **PowerShell** or **Command Prompt**.
2. Give a **reason** of 3 to 500 characters. It goes into the audit log.
3. Choose **Open as SYSTEM**.
4. **Confirm it is you.** This is the `terminal.open` function in *Settings →
   Confirm it is you*.
   - `terminal.open` is the only function that is **on by default**. Every
     other function has been off by default since 0.64.
   - A Platform Admin can turn it off there. Turning it off asks for a fresh
     confirmation first (`confirm.relax`), like turning off any other function.

The device must meet all of these, or the server refuses the terminal and
says why:

| Refusal | Why |
|---|---|
| `ENDPOINT_UNASSIGNED` | the device is in the unassigned pool: adopt it first |
| `TERMINAL_SIGNED_AGENT_REQUIRED` | not Windows, or not the signed (full) agent |
| `TERMINAL_NO_DEVICE_SECRET` | the device never authenticated with a device secret |
| `TERMINAL_AGENT_TOO_OLD` | the agent is older than **0.77.0** |
| `CONTAINED` | a `remote` containment pause covers the customer |
| `TERMINAL_OFFLINE` | the device is not reporting |
| `TERMINAL_ALREADY_OPEN` | you already have a terminal open on it |
| `TERMINAL_TOO_MANY` | three terminals are already open on it |

## How it reaches the device, and how long it takes

The device opens no port and listens on nothing. Every connection goes out
from the device to the server:

1. The signed agent's heartbeat runs every three minutes. While a terminal is
   waiting for the device, the heartbeat's answer says `remotePoll: true`.
   This is the only change to the heartbeat. Older agents ignore it.
2. The heartbeat then starts `rem0te-agent.exe remote-worker`. Only one worker
   runs at a time.
3. The worker long-polls `POST /api/v1/remote/agent/poll` with the device's
   device secret. The server holds each poll for up to 20 seconds and answers
   as soon as there is work.
4. The worker starts the shell, sends what it prints to
   `POST /api/v1/remote/agent/terminal/output`, and writes what you type to the
   shell.
5. The worker exits after a minute with nothing to do.

Expect these delays:

| What | Typical | Worst |
|---|---|---|
| The shell starting after you open it | under 3 minutes (the next heartbeat) | 3 minutes plus a poll |
| Your input reaching the shell | well under a second | about 2 seconds (the poll's database recheck) |
| Output reaching your browser | about 1 second (the console reads once a second) | a few seconds |

This does not depend on Managed Secure Access or `MSA_GRANTS`. It reuses the
same long-poll pattern on its own route.

## The shell

The shell is one of these two, started by absolute path from the device's own
System32. The arguments are fixed:

```
C:\Windows\System32\cmd.exe /D
C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile -NonInteractive -Command -
```

- **`/D`** stops cmd from running the registry's AutoRun commands.
- **`-NoProfile`** stops PowerShell from loading any profile.
- **`-Command -`** makes PowerShell read its commands from standard input.

Nothing from the server reaches the path or the arguments. The worker is told
only "cmd" or "powershell".

**Identity.** The shell runs as the worker does, which is **SYSTEM** in session
0. It does not run as the signed-in user, and the console never claims it does.
Running as the signed-in user is [planned](#planned).

**The process tree.** The shell is created suspended and put in a Windows Job
Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` before it runs. Anything it
starts is in the same job. When the session ends for any reason, the worker
terminates the job, which kills the shell **and everything it started**. The
job is also closed if the worker itself exits or dies. The Windows lab proves
this both as an administrator and as SYSTEM.

**Not a full console.** Input and output go through pipes, not a
pseudo-console:

- Programs that draw a full-screen interface or ask for a password at the
  console do not work. Examples are `edit`, `diskpart`'s interactive prompts
  and `Read-Host -AsSecureString`.
- Ctrl-C is not passed through.
- Output is shown as UTF-8. cmd writes the console code page, so accented
  characters may show as replacement marks. In cmd, `chcp 65001` changes that.

## Limits

| Limit | Value | Enforced by |
|---|---|---|
| Idle | **15 minutes** without your input | the server, and the worker separately |
| Total | **60 minutes** from opening, never extended | the server, the database (`notAfter` CHECK) and the worker from its own start |
| One input | 4,096 bytes | the server and the worker |
| One output frame | 16,384 bytes, 16 frames a post | the server and the worker |
| A whole session | 1 MB in, 8 MB out | the server and the worker |
| Live terminals | one per technician per device, three per device | the server (and a unique index) |
| Server unreachable | the worker ends every shell after **90 seconds** | the worker |

**What moves the idle clock.** Only your input, or **Keep alive**, moves it.
These do not:

- reading the output;
- reloading the page, or opening it from a second browser;
- the worker's polls.

So reconnecting continues a session without extending it. The panel shows both
countdowns.

**What happens at a limit.** The session ends whether or not anybody is
looking:

- every read, write and agent call checks the limits first;
- the terminal sweep runs every 30 seconds;
- the worker checks its own clocks every second.

## Ending a session

- **End session** (the technician) is recorded as `TERMINAL_CLOSED`.
- **End session** from the list of sessions is a revocation, recorded as
  `TERMINAL_REVOKED`. It is available to:
  - a Platform Admin;
  - the customer's own member with *Edit devices*, who did not open it and
    could not.
- Ending never asks for a fresh confirmation.
- **Containment.** A `remote` pause (*Security → Containment*,
  labelled "remote connections and chat") refuses new terminals. It also ends
  live terminals the next time anything touches them, at most 30 seconds later
  through the sweep. The session ends with `paused` and its worker kills the
  shell. A separate pause kind was not added: a terminal is remote access.
- **Exits and failures.** The shell exiting ends the session with its exit
  code. A worker that restarts and no longer holds a shell ends that session
  (`agent_error`).

## What is kept

**Always**, in the audit log:

- who opened the session, the device, the customer, the shell and the reason;
- when it started on the device;
- who ended it, and why;
- how long it lasted;
- the bytes typed and printed.

**Never**, without a transcript: what was typed or printed. While a session is
open, what is typed and printed passes through the database as short-lived
frames:

- a frame is deleted once it has been delivered;
- every remaining frame is deleted when the session ends.

The API and the agent log neither. A test in the end-to-end suite checks the
audit rows, the API's log and the worker's log for it.

**Transcripts** are a per-customer setting, **off by default**.

- **Who changes it.** Only a Platform Admin. The change is audited as
  `REMOTE_OPS_SETTINGS_CHANGED`.
- **What it covers.** Sessions opened while it is on keep what was typed and
  printed. Each session records whether it does. Turning the setting off does
  not delete transcripts already kept.
- **Who reads one.** Only someone holding `computers:terminal`.
- **How long they are kept.** 30 days by default, configurable from 1 to 365.
  The terminal sweep prunes them.

Set it with `PUT /api/v1/remote-ops/settings/:businessId` (`{
"terminalTranscripts": true, "transcriptDays": 30 }`).

`TERMINAL_SWEEP=off` stops the sweep. It is a test switch and must not be set
in production. Security → Server security lists it among the off switches.

## What it reverses, and what still holds

These three rules are reversed for the terminal only, at the owner's request:

- **§14's closed catalog.** The agent runs only the approved catalog's actions.
  A terminal is not a catalog action and is not signed by the approval signer.
- **"The agent runs no process"** (§14, §61). The remote worker starts
  `cmd.exe` or `powershell.exe`.
- **§39's constant command line.** A script run is one fixed command line. The
  terminal's command line is still fixed, but its standard input is whatever
  the technician types.

Everything else still holds, and `check-security-invariants.mjs` §87 checks it:

- **Who.** A Platform Admin only. Opening needs a fresh confirmation by
  default, a reason, and scope through the ordinary visibility rule.
- **Which devices.** An assigned Windows device running the signed agent
  0.77.0 or later, with a device secret and reporting. A pooled device is
  refused (§70).
- **Authentication.** Every agent call checks the device secret before
  anything else, then Windows and the signed agent, then the pool.
- **Transport.** Outbound only. Nothing listens on the device.
- **The exec site.** There is one, with two possible executables at absolute
  System32 paths and constant arguments, inside a Job Object.
- **Limits.** The same in the server, the database and the agent. The agent
  enforces them without the server.
- **Containment.** The `remote` pause refuses new terminals and ends live ones.
- **The record.** Audit rows carry no input or output. Transcripts are opt-in.

Approved actions, scripts, patching and software deployment are unchanged. The
approval signer is not involved in a terminal and gains no new power.

## Before turning it on: publish the agent first

The terminal needs the **signed agent 0.77.0** on the device. The server
refuses an older agent (`TERMINAL_AGENT_TOO_OLD`), so nothing happens until
devices have updated:

1. Deploy the server.
2. Publish the agent: `sudo rem0te-signed-publish` on the release host.
3. Let devices take the update. They do this through their daily check, or
   *Update agent* on the Agent card.

Nothing else needs configuring. The heartbeat starts the worker only while a
terminal is waiting.

## Evidence

- **Server.** The unit tests (`unit-terminal.mjs`, in CI) cover:
  - the open decision and its order;
  - the clocks;
  - who may end a session;
  - the frame caps;
  - that the limits agree with the agent's Go constants and migration 0094.

  The end-to-end suite (`e2e-terminal.mjs`) drives the routes against the
  agent's own worker code (`rem0te-remote-sim`). It covers:
  - default deny for an owner, a user and a technician;
  - cross-customer refusal;
  - the step-up;
  - every refusal;
  - the device secret;
  - start, type and output;
  - reconnecting without moving the clock;
  - revocation killing a child process;
  - idle and hard-limit expiry, including through the sweep;
  - the pause;
  - a restarted worker;
  - transcripts;
  - audit rows with no content.
- **Simulation is not Windows.** In the simulator the shell is `/bin/sh` in a
  process group.
- **Windows lab.** `internal/remote/lab_windows_test.go` runs the real Windows
  exec site, cmd and PowerShell in a Job Object, on GitHub's `windows-latest`
  runner. It runs twice: as the runner's administrator, and as SYSTEM through a
  scheduled task. It proves:
  - a command runs and its output comes back;
  - `whoami` is `nt authority\system`;
  - ending the session kills the shell and a child it started;
  - the hard limit expiring does the same.

  It does not prove the heartbeat starting the worker, or the HTTP channel to a
  real server.
- **Not yet tried.** No terminal has been opened on a desktop or on the fleet.

## Planned

- **Run as the signed-in user** instead of SYSTEM.
- **Delegating** `computers:terminal` to a named person, as a Platform Admin
  grant with its own audit.
- **A pseudo-console** (ConPTY), for Ctrl-C, full-screen programs and the
  console code page.
- **File transfer** in both directions shipped in 0.78 "Courier", over the
  same worker: [file-transfer.md](file-transfer.md).
