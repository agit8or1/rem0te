# Background file transfer

*0.78.0 "Courier".* A Platform Admin can send a file to a Windows device, or
fetch one from it, without a screen-sharing session. Nothing appears on the
device's screen. The agent reads and writes the file as **SYSTEM**, which
means **full control of the device**: it can write anywhere on a local drive
and read any file there. The console says so wherever a transfer can be
started.

This extends the [background terminal](remote-terminal.md)'s exception to
files, at the owner's request, and travels the same way: the same outbound
worker, the same Platform-Admin-only rule. [What it reverses, and what still
holds](#what-it-reverses-and-what-still-holds) lists exactly what changed.

## Who can use it

| | Send a file | Fetch a file | See that a transfer happened | Cancel someone's transfer |
|---|---|---|---|---|
| Platform Admin | yes | yes | yes | yes (revoke) |
| Business Owner | **no** | **no** | yes, on their devices | yes (revoke) |
| Business User with *Edit devices* | **no** | **no** | yes | yes (revoke) |
| Business User without it | no | no | yes, with *View devices* | no |
| MSP technician | **no** | **no** | yes, on assigned devices | no |

Sending and fetching are **two capabilities**, `computers:files_upload` and
`computers:files_download`. Both are platform-only, like `computers:terminal`:

- They are not customer capabilities, so a Business Owner does not hold them.
- No grant can carry them. That covers a Business User grant, a technician
  assignment or preset, and an SSO mapping. The server drops them from
  anything stored.

The reason is the same as the terminal's. Writing a file as SYSTEM is enough
to run anything on the device, and reading as SYSTEM reaches every user's
files and the registry hives. If a customer could grant that, default-deny
would be a setting the customer could switch off. They are two capabilities so
that, when delegation is added ([planned](#planned)), fetching logs can be
given without the power to write.

Only the Platform Admin who asked for a transfer moves its bytes. Another
Platform Admin sees the transfer, and can cancel it, but cannot send its
chunks or read them.

## Starting one

On the device's **Files** tab (or *Tools → Terminal and files*), give:

- **A path.** An absolute local path on the device, such as
  `C:\Windows\Temp\setup.msi`. See [Paths](#paths).
- **A reason.** 3 to 500 characters. It goes into the audit log.
- **Overwrite** (sending only). Off by default. Without it, a file that is
  already there is never replaced: the transfer fails with *exists*.

Sending a file first hashes it in the browser (SHA-256, in slices, so a large
file does not have to fit in memory at once). The size and hash go to the
server with the request.

Then:

1. The server checks the request in this order:
   1. the device is in scope, with the direction's capability (404 if not);
   2. the path rule, the reason, and for a send, the size (within the
      customer's limit) and the SHA-256 (400);
   3. a fresh confirmation, when *Settings → Confirm it is you* asks for
      `files.transfer`. **It is off by default.** A Platform Admin can turn
      it on there.
   4. the device itself (below).
2. The request is written to the audit log (`FILE_TRANSFER_REQUESTED`, with
   the path, size, SHA-256 and reason), and only then does the transfer exist.

| Refusal | Code |
|---|---|
| The device is in the unassigned pool | `403 ENDPOINT_UNASSIGNED` |
| Not Windows, or not the signed (full) agent | `409 FILES_SIGNED_AGENT_REQUIRED` |
| No device secret on record | `409 FILES_NO_DEVICE_SECRET` |
| The agent is older than 0.78.0 | `409 FILES_AGENT_TOO_OLD` |
| A `remote` containment pause | `403 CONTAINED` |
| Not reporting | `409 FILES_OFFLINE` |
| Two transfers already running on that device | `409 FILES_TOO_MANY` |
| A path the rule refuses | `400 FILES_PATH_REFUSED` |
| Larger than the customer allows | `400 FILES_TOO_LARGE` |

## How it reaches the device, and how long it takes

The bytes go through the server: browser → server → agent for a send, and
agent → server → browser for a fetch. The agent never accepts a connection.

- **Starting.** A waiting transfer makes the device's next heartbeat
  answer `remotePoll`, which starts the remote worker
  (`rem0te-agent.exe remote-worker`). That is the same worker and long-poll
  as the terminal, and it does not depend on `MSA_GRANTS`. The heartbeat runs
  every few minutes, so a transfer starts **within about three minutes**. If
  the worker is already running for a terminal or another transfer, it starts
  within a second.
- **Moving.** Files move in **512 KiB chunks**. Each chunk carries its own
  SHA-256, checked by the server on the way in and by the other end on the
  way out. At most **eight chunks** wait on the server at once. A send that
  gets ahead of the agent is told to wait (`409 FILES_WINDOW_FULL`) and the
  browser tries again. Throughput is bounded by round trips through the
  server, not by the link: plan on minutes for tens of megabytes, not
  seconds.
- **Keep the tab open.** The browser moves the bytes. Closing the tab stops a
  send. A fetch that stops being read stalls, and ends after ten minutes
  without progress.

## Paths

Paths are checked by the server and again by the agent, with the same rule
(one shared fixture, `internal/remote/testdata/file-paths.json`, is asserted
by both). A path must be:

- an absolute path on a drive letter: `C:\…`;
- at most 1,024 characters, with backslashes only.

The rule refuses:

- a UNC path (`\\server\share`);
- a device or long-path prefix (`\\?\`, `\\.\`);
- `..`, `.` and empty components;
- an alternate data stream (`file:stream`);
- reserved names (`CON`, `NUL`, `COM1`, `LPT1` and the rest, with or without
  an extension);
- a component ending in a dot or a space;
- control characters and `< > " | ? *`.

On the device, the agent also:

- **Drives.** Accepts only a fixed or removable drive; a network drive, a
  RAM disk or a CD is refused.
- **Links.** Refuses a reparse point (a junction, a symbolic link or a mount
  point) on **any** folder in the path and on the file itself
  (`reparse_point`).
- **Folders.** Never creates one. A folder that does not exist is
  `no_folder`.
- **Writing.** Writes to a temporary file beside the target,
  `.rem0te-<id>.part`. It creates that file exclusively and checks it by
  handle (`GetFinalPathNameByHandle`), so a link swapped in at the last moment
  is caught (`path_changed`).
- **Placing.** Hashes the whole file before it is put in place. A mismatch is
  `hash_mismatch` and the temporary file is deleted. The file is then moved
  into place with `MoveFileEx`, which replaces an existing file only when the
  transfer says overwrite.

A fetch refuses a folder (`not_a_file`) and a missing file (`not_found`). The
agent hashes the file, declares its size and SHA-256, then reads it again to
send it. If the file changed in between it is `file_changed`. The browser
checks every chunk and the whole file before it offers *Save*. A file that
does not match is never offered.

## Limits

| | Value | Where |
|---|---|---|
| Largest file | **100 MB** by default, per customer, **1 MB to 2 GB** | `fileMaxMb`; 0095 CHECK; the agent's 2 GiB ceiling |
| Chunk | 512 KiB | TS, Go, 0095 CHECK |
| Chunks waiting on the server | 8 | TS, 0095 CHECK |
| A transfer in all | 60 minutes | TS, Go, 0095 CHECK; the agent stops at its own limit |
| Without progress | 10 minutes | the server's sweep, and every read |
| Running on one device | 2 | TS, Go |
| A finished fetch's chunks | kept 15 minutes for the browser, then deleted | the sweep |

A Platform Admin sets the size limit per customer with
`PUT /api/v1/remote-ops/settings/:businessId` (`{ "fileMaxMb": 500 }`). It is
audited (`REMOTE_OPS_SETTINGS_CHANGED`).

## Ending a transfer

A transfer ends as:

- **completed**, once the agent has verified the hash;
- **cancelled**, by its technician;
- **revoked**, by a Platform Admin or the customer's own member with *Edit
  devices*;
- **paused**, by a `remote` containment pause, which also refuses new
  transfers;
- **expired**, at the 60-minute limit;
- **stalled**, after 10 minutes without progress;
- one of the agent's codes (`exists`, `no_folder`, `reparse_point`,
  `hash_mismatch` and the rest).

Cancelling never asks for a fresh confirmation. On the device, a send that
ends early deletes its temporary file; nothing is left half-written.

## What is kept

- **The audit log.** `FILE_TRANSFER_REQUESTED`, then one of
  `FILE_TRANSFER_COMPLETED`, `FILE_TRANSFER_FAILED` or
  `FILE_TRANSFER_CANCELLED`. They carry the ids, the direction, the path, the
  reason, the size, the **SHA-256**, the bytes moved and the duration.
  **Never the content.**
- **The bytes are temporary.** A chunk is deleted as soon as the other end
  has it, and every chunk goes when a transfer ends. A finished fetch's
  chunks wait up to 15 minutes for the browser, then the sweep deletes them.
  The server keeps no copy of any file.
- **Logs.** The agent's worker logs a transfer's id, its direction and its
  end code, never a path or content.

The sweep is the terminal's (`TERMINAL_SWEEP`). `TERMINAL_SWEEP=off` is for
test stacks only: with it, a transfer nobody reads is not ended at its limit
until someone next reads it, and a finished fetch's chunks stay until then.

## What it reverses, and what still holds

The terminal's three reversals ([remote-terminal.md](remote-terminal.md))
already let the agent act on what a technician sends. File transfer extends
that, for files only:

- **The agent writes and reads a path the portal sends.** Before 0.78 the
  agent never took a path from the portal.

Everything else still holds, and `check-security-invariants.mjs` §88 checks
it:

- **Who.** A Platform Admin only, sending and fetching separately, with a
  reason and scope through the ordinary visibility rule.
- **Which devices.** An assigned Windows device running the signed agent
  0.78.0 or later, with a device secret and reporting.
- **Authentication.** Every agent call checks the device secret before
  anything else. Another device's secret reaches nothing.
- **No process.** The file code runs no process and opens no socket. The
  worker still listens on nothing.
- **Containment.** The `remote` pause refuses new transfers and ends live
  ones.
- **The record.** The audit log carries the hash, never the bytes, and the
  server keeps no copy.

## Before turning it on: publish the agent first

File transfer needs the **signed agent 0.78.0** on the device. The server
refuses an older agent (`FILES_AGENT_TOO_OLD`):

1. Deploy the server.
2. Publish the agent: `sudo rem0te-signed-publish` on the release host.
3. Let devices take the update.

## Evidence

- **Server.** `unit-files.mjs` (in CI) covers:
  - the path rule against the shared fixture;
  - the limits and the agent's error codes agreeing with Go and 0095;
  - the order of the request decision;
  - the clocks;
  - the chunk checks;
  - the capabilities;
  - the confirm key's default;
  - the browser's SHA-256 against node:crypto.

  `e2e-files.mjs` drives the routes against the agent's own worker code
  (`rem0te-remote-sim -files-root`). It covers:
  - default deny;
  - cross-customer refusal;
  - the step-up when the key asks;
  - every refusal;
  - a three-chunk send whose file on disk has the declared hash;
  - exists versus overwrite;
  - a missing folder, a symbolic link and a wrong hash refused by the agent;
  - a fetch whose bytes and hash match the file;
  - another technician refused;
  - cancel and revoke;
  - the pause (with nothing left on disk);
  - stalled and expired, through a read and the sweep;
  - audit rows with the hash and no content.
- **Simulation is not Windows.** In the simulator the file system is a
  directory (`C:\a` is `<root>/C/a`) and a symbolic link stands in for a
  reparse point.
- **Windows lab.** `internal/remote/lab_files_windows_test.go` runs the real
  Windows file system on GitHub's `windows-latest` runner, as the
  administrator and as SYSTEM (through the terminal lab's scheduled task). It
  covers:
  - a 1.5 MiB send;
  - *exists* refused, then overwrite;
  - a fetch with matching hashes;
  - a junction (`mklink /J`) refused;
  - a UNC path refused.

  It does not cover the heartbeat starting the worker or the HTTP channel to
  a real server.
- **Not yet tried.** No file has been transferred on a desktop or on the
  fleet.

## Planned

- **Delegation** of either capability to a named person, as a Platform Admin
  grant with its own audit.
- **Resuming** a transfer that was interrupted, instead of starting again.
- **A console setting** for the size limit (today it is the API above).
