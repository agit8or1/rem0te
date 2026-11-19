# Windows lab testing

Most of what the Windows agent does has been tested only against simulators: `rem0te-action-sim` fakes the
service control manager, the process table, the registry and Windows Update, and the `agent-real-os` CI job
runs only the agent's portable Go tests on Windows. The **Windows lab** (0.68.3) is the one place where the
agent's Windows code, and RustDesk's command line, meet a real Windows computer under our control.

That computer is GitHub's `windows-latest` hosted runner: a fresh Windows Server virtual machine with
administrator rights, created for one job and thrown away afterwards. The lab changes it freely — installs
RustDesk, creates and deletes a service, ends processes, removes programs, points Windows Update at a server
that does not exist — because nothing survives the job.

The lab is the `Windows lab` workflow (`.github/workflows/lab-windows.yml`). It runs on every pull request, on
every push to `main`, and by hand (*Actions → Windows lab → Run workflow*). It is **not a required check**: a red
run is a finding about Windows or RustDesk (or a broken lab), and it never blocks a merge.

## What runs

### RustDesk's command line as SYSTEM (`agent-lab-windows (RustDesk …)`)

The question it answers: can a process running as **SYSTEM** — as the signed agent does, in session 0 — change
an installed RustDesk's settings while it runs, read them back, set its permanent password, and turn its
service off and on again, all through `rustdesk.exe`'s own command line? And did that change in 1.4.7, which
restricted who may talk to RustDesk's local IPC pipe?

One fresh runner per RustDesk release: **1.3.9, 1.4.1, 1.4.6, 1.4.7, 1.4.9 and 1.5.3**. On each,
`tools/lab/windows/rustdesk-lab.ps1`:

1. **Keeps RustDesk off its public servers before it ever runs.** The rustdesk.com names it uses resolve to
   127.0.0.1 through the hosts file; Windows Firewall blocks outbound connections by the installer and the
   installed `rustdesk.exe`; and its configuration (rendezvous, relay and API server all `127.0.0.1`) is
   written for the installing user and both service profiles before installation and again after.
2. **Downloads the official `rustdesk-<version>-x86_64.exe`** from github.com/rustdesk/rustdesk and checks its
   SHA-256 against the digest GitHub's release API publishes for that asset. A release with no published
   digest is **not installed**: it is recorded as a failed `download` test, "unverified download". (GitHub
   began recording asset digests in 2025; 1.3.9 and everything older have none. 1.4.1 is the oldest release
   that does.)
3. **Installs it as a service** with `--silent-install` and waits for the service's final `--service` form.
4. **Runs `rustdesk-probe.ps1` as SYSTEM**, from a scheduled task (`/RU SYSTEM`, session 0), then resets the
   service and runs it again **as the runner's elevated administrator** for comparison.

For each option the Managed Secure Access design uses — `access-mode`, `enable-keyboard`,
`enable-clipboard`, `enable-file-transfer`, `enable-audio`, `enable-tunnel`, `enable-remote-restart`,
`approve-mode`, `verification-method`, `allow-auto-disconnect` and `auto-disconnect-timeout` — the probe:

- reads the value (`rustdesk.exe --option <key>`), sets a non-default one (`--option <key> <value>`) and reads
  it back at once;
- records what each `RustDesk2.toml` says (the LocalService service profile, SYSTEM's profile and the
  caller's own);
- reads it again 5 seconds later, and again after restarting the RustDesk service;
- sets a second value and reads that back, so a value left over from the other caller can never pass for a
  change.

It also sets a random permanent password with `--password` and records the exit code, the output (with the
password removed) and whether the stored password line in each `RustDesk.toml` changed — compared by a
truncated hash of the encrypted line. The password itself is never written anywhere. Then it sets
`stop-service` to `Y`, records what the service and its processes did, sets it back to `N` and records whether
RustDesk's server process came back.

**Did the running server take it?** A readback and a file can agree while the running server never heard of
the change: when RustDesk's IPC pipe refuses a caller, its command line falls back to writing its own
process's configuration, and for SYSTEM that is the same LocalService file the service reads at start. So the
probe also checks something only the running server does. With `direct-server` set to `Y` the server opens a
TCP listener on port 21118; with `stop-service` `Y` it stops serving and closes it; with `N` it opens it again;
with `direct-server` `N` it closes it. The probe times each of these from the outside
(`Get-NetTCPConnection`). Nothing connects to the listener, and the firewall keeps inbound closed.

**The negative control.** The same probe step is repeated with a copy of the whole RustDesk install in another
directory (`C:\lab\rdcopy`, blocked outbound by the firewall too), run as the same caller. RustDesk 1.4.7
restricted its IPC pipe to callers running the same executable; a copy is the same files at a different path.
If the copy's change reaches the running server, the pipe accepted it; if not, it was refused. The control's
row is `fail` when the copy did **not** reach the server — on 1.4.7 and later that is the expected answer, and
it is what shows the live check above can tell an accepted change from a refused one.

A refusal by RustDesk is a result, not an error: the job stays green whatever RustDesk refused. It goes red
only when the lab itself broke — RustDesk did not install, or a probe produced no result.

### The agent's RustDesk preflight (0.69, in the same RustDesk jobs)

After the probe, on every release the lab installs (1.4.1, 1.4.6, 1.4.7, 1.4.9, 1.5.3; not 1.3.9, which is never
installed), the RustDesk job builds the real `rem0te-agent.exe` and runs `TestLabRustdeskPreflight` (tagged
`windows && labwindows`, gated by `REM0TE_LAB=1` and `REM0TE_LAB_RUSTDESK=<version>`). The preflight only reads —
`rustdesk.exe --option <key>` with no value for the eleven Managed Secure Access keys, the service's configuration
and state with query rights, the exe's version resource and two file names beside it — so running it after the
probe changes nothing.

- **`admin`**: the preflight in the test process, as the runner's elevated administrator.
- **`system`**: the real agent's `rustdesk-preflight` subcommand as SYSTEM in session 0, from a scheduled task, with
  no `--force`. It waits for `C:\ProgramData\Rem0te\msa\preflight.json`, then starts the task again and checks
  the file is not rewritten: the 6-hour rate limit holds.

Both require: installed, the service running that same exe (RustDesk writes the service's path as
`"C:\Program Files\RustDesk\RustDesk.exe" --service`, in mixed case; the comparison ignores case), service
running, build `flutter`, a version beginning with the release (`1.4.7+65`), and all eleven reads answered. Ids:
`agent/rustdesk-preflight/<version>/admin` and `…/system`. The Flutter/Sciter check is a heuristic
(`flutter_windows.dll` or `sciter.dll` beside the exe): the lab can confirm only the Flutter half, since every
official x64 build is Flutter.

### The agent's Windows code (`agent-lab-windows (agent Go tests)`)

Go tests tagged `windows && labwindows` — never built by `go test ./...` — and skipped again unless
`REM0TE_LAB=1`, so they run nowhere but here. They drive the real Windows implementations through
`internal/action`'s whole `Run`: a signed envelope, the verifier, the journal, the precheck and the action.
Only the approval key (generated by the test), the computer's identity (RustDesk ID and device secret) and the
agent's own hash are stand-ins; those are what `verify()` compares, and nothing the action does depends on
them.

| Tests | What is real |
|---|---|
| `agent/service-control/*` (`lab_windows_test.go`) | A throwaway service (the test binary itself) registered with the real service control manager; start, stop, restart, every startup type including *automatic (delayed)*, start refused while disabled, only the start type changing (binary path, account, display name and error control compared before and after); a protected service (`EventLog`, in two cases), RustDesk's stop, a driver and an unknown name refused |
| `agent/process-stop/*` | A child process ended through `OpenProcess` / `TerminateProcess`; refused with a creation time one second off (`process_changed`); the handle-level PID-reuse check refusing a time 5 ms off; a tree of two ended together; `svchost` refused |
| `agent/program-remove/*` | Real HKLM uninstall keys: a `QuietUninstallString` run through the agent's one exec site until its key is gone; `cmd.exe` refused and not run; a renamed program and `RustDesk` refused; the 64-bit and 32-bit (`WOW6432Node`) views kept apart; an MSI built with the WiX Toolset, installed and removed with `msiexec /x`; and an Inno Setup program built with `ISCC`, removed once by its `QuietUninstallString` and once, with that value deleted, by the recognised Inno form (`unins000.exe` with the agent's fixed arguments) — each **only when the runner has the tool** |
| `agent/windows-update/scan-offline` | `wua.ps1` under Windows PowerShell 5.1 and the Windows Update Agent COM API, with Windows Update **pointed at a WSUS server on localhost that does not exist** — see below |
| `agent/script-run/*` (`internal/action/lab_windows_test.go`) | `windows.script.run` under System32's `powershell.exe` (5.1, Desktop edition): arguments arriving as data, the wrapper never evaluating them, the job object killing a child `powershell.exe` at the timeout, the job memory limit refusing a 700 MB allocation (and, as the control, the same allocation succeeding under a 2 GB limit), and the output cap |

**Windows Update is scanned offline on purpose.** An online scan asks Microsoft Update, and the lab contacts
nothing but GitHub and localhost. Before it scans, the test:

- sets Windows Update's policy (`HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate`) to a WSUS server at
  `http://127.0.0.1:8530`, where nothing listens, with `DoNotConnectToWindowsUpdateInternetLocations` and
  automatic updates off — this is the part that works;
- blocks outbound traffic for `wuauserv`, `BITS`, `DoSvc`, `UsoSvc` and `WaaSMedicSvc` in Windows Firewall
  (by service) and points the Windows Update host names at 127.0.0.1;
- stops and disables `wuauserv` directly through the service manager (the agent itself never does), to record
  what Windows does with that.

The scan then fails where Windows Update cannot reach its server (`0x80240438`), and the test requires exactly
that: a well-formed posture with the error in it, no updates, `wsus` read from the policy as the update manager.
It proves the agent's scan path runs under PowerShell 5.1 and fails cleanly. It does **not** prove that an
online scan returns the right updates.

**Two earlier runs of this test did reach Microsoft Update** while the lab was being built (both on
2026-11-19, recorded in the 0.68.3 changelog). Stopping and disabling `wuauserv` did not hold — Windows
had it running again, start type *Manual*, by the time the scan finished — and the firewall rules and hosts
entries alone still let a scan return an update. Only the policy stopped it. The finding that a disabled
`wuauserv` is turned back on during a scan is recorded on every run.

## Reading the evidence

Every run uploads one artifact, **`lab-evidence-windows`**:

```bash
gh run download <run id> -n lab-evidence-windows
```

- **`summary.md`** — the same summary as the run page: the Windows build of every runner, the RustDesk table
  (one row per release and caller; `ok` means the value read back is the value set), and every result.
- **`lab-evidence.json`** — machine-readable:
  - `runners`: each job's Windows caption, version, build and update revision;
  - `results`: one entry per test — `id`, `status` (`pass`, `fail` or `skip`), `detail` (what was observed),
    `real` (false only for a skip) and the `os` it ran on;
  - `problems`: anything that means the lab broke rather than Windows or RustDesk answering;
  - `rustdesk`: each release's full probe output, per caller: every command's arguments (password redacted),
    exit code, output, and every file readback.

For RustDesk rows, `fail` means RustDesk did not do what was asked. That is a finding, and an important one;
it is not a defect in the lab. Ids look like `rustdesk/1.4.7/system/option/enable-keyboard`.

## What it found (2026-11-19)

On Windows Server 2025 Datacenter 10.0.26100, the runner GitHub calls `windows-latest`:

- **RustDesk 1.4.1, 1.4.6, 1.4.7, 1.4.9 and 1.5.3, as SYSTEM and as an elevated administrator:** every one of the
  eleven options was set, read back, still held 5 seconds later and after a service restart, and took a second
  value. `--password` exited 0 saying `Done!` and changed the stored password line in the LocalService profile
  (and, for the administrator, in its own profile too). `stop-service` `Y` closed the server's listener within
  about 1.3 s with the service itself still running, and `N` brought it back. `direct-server` reached the
  running server every time, within 1.3 s. So **SYSTEM can change a running RustDesk's settings with its command
  line on every release tested, 1.4.7 and later included.**
- **The 1.4.7 IPC restriction is real, and is about the executable, not the account.** A copy of RustDesk in
  another directory reached the running server on 1.4.1 and 1.4.6 and was refused on 1.4.7, 1.4.9 and 1.5.3,
  as SYSTEM and as the administrator. Refused, its command line still exited 0 and still wrote the
  LocalService file when run as SYSTEM, so the change would apply at the next service start, not now. The agent
  calls the installed `rustdesk.exe`, which is accepted.
- **RustDesk 1.3.9 was not tested.** GitHub publishes no digest for its assets, so it was not downloaded.
- **The agent's service control, process ending (with the PID-reuse guard), program removal (quiet string, MSI
  and both Inno forms), PowerShell 5.1 script runs and the offline Windows Update scan all behaved as the
  simulators say they do.** Two Windows details the simulators do not have: `Tcpip` is reported as a
  boot-start driver, and Windows turns a disabled `wuauserv` back on (*Manual*, running) during a scan.

## What it cannot prove

- **It is Windows Server, not Windows 10 or 11.** The runner's edition and build are in the evidence. Service
  control, the process table, the registry, msiexec and PowerShell 5.1 behave the same way on both, but a
  desktop's defaults (UAC prompts, Defender settings, Store-installed components) are not tested.
- **There is no real user session.** Nobody is signed in at the console. Anything that depends on the person
  at the computer — RustDesk's connection-approval prompt, the tray, chat, a restart warning someone reads — is
  untested here. The RustDesk server process runs in whatever session the service starts it in, and the
  evidence records which.
- **No RustDesk connection is made.** There is no second machine and no rendezvous server. The lab proves
  what the settings *say* after a change, and — for `direct-server` and `stop-service` — that the running
  server acted on it. It does not prove that a live session obeys the other options: that keyboard input is
  actually refused with `enable-keyboard` off, for instance.
- **Windows Update is not contacted** (see above; two runs while the lab was built did reach it), and no
  update is installed.
- **The MSI and Inno removals run only when the runner has the WiX Toolset and Inno Setup.** Otherwise each is
  a recorded skip: nothing is downloaded to build one.
- **The signed agent itself is not installed.** The tests call the same code the agent's `action` command
  calls, compiled into a test binary; the agent's installation, update chain, heartbeat and tray host are not
  exercised.
