# Compatibility testing

Every release must keep working with the agents already installed. Nothing
forces a computer to update on the day a release ships: the signed agent
checks once a day, a computer may be off for weeks, and an update can be
paused. So a server release is tested against the **older released agents**
still in use, not only against the agent built from the same commit.

## What runs

| Check | What it proves | Evidence level |
|---|---|---|
| `compat (agent vX.Y.Z)` CI jobs | the signed agent's decision code **as released at that tag** still works with this server: approved actions, staged patching and patch policies, maintenance actions, service and process control, technician presets | **Sim** — the agent's real Go code against `rem0te-action-sim`'s fake Windows services |
| `compat-wire (windows / linux / macos)` CI jobs (0.73.1) | the **standard** agents' request bodies, as each release's own scripts build them, are still accepted by this server, have the effect they had at that release, and get answers that release can read | **Wire** — the release's real scripts, run against a stand-in OS and a capture stub; the bytes replayed against this server |
| The ordinary e2e suites | the agent built from this commit works with this server | Sim / API |
| `agent-lab-windows` (when merged) | the agent's Windows code and RustDesk on a real, disposable Windows Server VM | Lab |

None of the compatibility jobs touch a real Windows computer. A green
compatibility run says the older agent's *decisions* still meet the new
server's plans, results and refusals. It does not say the agent's Windows
calls work; that is what the lab and the fleet are for
(`docs/readiness.md` and `docs/lab-testing.md`, both in review).

### New report fields (0.69)

A signed agent from 0.69 adds one heartbeat field, `rustdeskPreflight`
(Managed Secure Access readiness). Older agents send nothing and get exactly
the answer they got before — no new key in it. The portal drops a block it
cannot parse rather than refusing the heartbeat, so an agent newer than the
portal never fails either. `e2e-msa-readiness.mjs` checks both.

## Supported versions

`scripts/compat/supported-agents.json` lists them, each with why it is there:

| Agent | Why |
|---|---|
| v0.64.0 | running on production computers (2026-11-19) |
| v0.67.0 | the previous minor release before 0.68 |
| v0.68.3 | the previous release (0.69 adds the RustDesk preflight; 0.68.3 sends none) |

The agent built from the commit under test is always covered by the ordinary
suites.

**Changing the list is a support decision.** A version leaves only by moving
to `retired` with the date and the reason, so the record of what was once
supported stays. Add the previous release on every release, and any version
still reported by computers you manage.

## When an older agent fails

A supported agent failing a suite fails the job. Either the server broke it
(fix the server), or the change is intentional: then the suite goes in
`knownIncompatible` for that tag, with the reason and what the computers on
that version must do, and the release notes say so. Nothing is dropped
silently.

## Running it yourself

```bash
DATABASE_URL=postgresql://…/<name containing scratch or test> scripts/compat-agents.sh v0.64.0
```

It refuses any other database, builds the agent from the tag with
`git archive` (the working tree is not used), and writes
`.compat-logs/<tag>/evidence.json`: the tag, the server version and commit,
and each suite's result.

The standard agents' wire fixtures (below):

```bash
cd apps/api && npx nest build && cd ../..
DATABASE_URL=postgresql://…/<name containing scratch or test> scripts/compat-wire.sh          # all three
DATABASE_URL=postgresql://…/<name containing scratch or test> scripts/compat-wire.sh windows  # one agent
```

It refuses any other database and any port outside 3981–3988 (`WIRE_API_PORT`),
starts its own API on 127.0.0.1 with every sweep off and no GeoIP file, and
writes `.compat-logs/wire/evidence.json`.

## Wire fixtures: the standard agents (0.73.1)

The standard agents are not built once and published: the server writes them
at install time, so a computer runs whatever its installing server wrote, and
an old one can still be speaking that release's dialect. The portal rejects
any field a DTO does not declare (`forbidNonWhitelisted`), so removing or
renaming a field breaks every older agent that still sends it, and nothing
else would notice.

**What the fixtures are.** `scripts/compat/wire/<agent>/<tag>/NN-<name>.json`,
one request each, in the order the agent sends them, with `manifest.json`
holding what that release reads back. Each holds the agent's exact bytes
(`raw`) and the parsed body, with every secret and identifier replaced by a
`{{placeholder}}` (`{{rustdeskId}}`, `{{agentSecret}}`, `{{password}}`,
`{{token}}`, `{{commandId:TYPE}}`, `{{diagRunId:key}}`, `{{trayKeyId}}`, the
rotation password and its digest). §18's 0.73.1 addendum fails CI if a fixture
holds anything else in those fields. Everything else is synthetic: fixture
names, the `wire.example` domain and RFC 5737 addresses (192.0.2.0/24).

**How they were made** (`scripts/compat/capture-wire.mjs`; nothing was written
by hand). For each tag the script takes `apps/api/src/public` from
`git archive <tag>`, transpiles the release's script builders and generates
the scripts that release served, then runs them:

| Agent | What runs | Stand-in |
|---|---|---|
| Windows (standard) | the installer's `Register` function (claim, and the unclaimed heartbeat), `retry-enroll.ps1`, and `heartbeat.ps1` twice (a first beat that is handed one command of each type, three diagnostics, a monitor query, a rotation and a tray pairing; then a second beat with the tray paired and three more diagnostics) | PowerShell 7 with `scripts/compat/capture/windows-prelude.ps1`: CIM, the uninstall keys, Windows Update, event logs, services and processes, and `Invoke-RestMethod`, which records the body and answers from a canned stub. Windows paths are rewritten into a scratch directory |
| Linux | the installer's registration block (claim, and the unclaimed heartbeat) under bash with a recording `curl`; the agent under dash with real `curl` to a loopback stub, answering all three commands | the agent's own test overrides, OS commands stubbed on `PATH`, and its `/proc`, `/sys` and `/etc` reads rerooted into a fixture tree |
| macOS | the same, from the macOS installer and agent | `REM0TE_TEST_PATH` stubs of `sw_vers`, `sysctl`, `ioreg`, `system_profiler`, `defaults`, … |

**What the replay checks** (`scripts/compat-wire.sh`, then
`scripts/compat-wire.mjs`, against this checkout's API on a scratch database,
port 3981). For every agent × release, fresh computers in a fresh business:

- every request is accepted (HTTP 200, `success: true`): nothing refused that
  was accepted at that release;
- its effect: the claim places the computer in the token's business, binds
  the device secret and consumes the token; the unclaimed heartbeat lands in
  the unassigned pool; a heartbeat writes `lastSeenAt`, the agent version,
  hostname, platform, the live sample and the RustDesk version; results close
  their command (`SUCCEEDED` / `FAILED`) and their diagnostic run; inventory,
  disks, software and pending updates land; the rotation is confirmed and the
  rotated password becomes the active one;
- the answer, read the way that release reads it. **Linux and macOS** search
  the raw response text: it must contain `"authenticated":true`, and the
  release's own `grep -oE` pattern (copied from its script into the manifest)
  must find every command the server handed out — so the server's
  `{"id":…,"type":…}` key order is part of the contract. The command ids
  replayed next are the ones that pattern found. **Windows** reads
  `$resp.data.<field>`: every field the release's `heartbeat.ps1` reads (listed
  in the manifest, taken from the script) has a shape it can use; staged
  commands, diagnostics and a rotation come back with the fields it needs;
  nothing asks it to reinstall, update RustDesk or retire; the tray key matches
  the release's pattern, and the paired key is recognised on the next beat.

The server hands out two commands a heartbeat, so a result whose command has
not been handed out yet waits for the next heartbeat, as on the computer: the
replay sends the same heartbeat again (at most three more times).

### The matrix

Every fixture below is **captured** from the release's own script; none is
constructed. `scripts/compat/wire/agents.json` lists the tags and why each is
there.

| Agent | Releases | Requests per release | Evidence |
|---|---|---|---|
| Windows (standard) | v0.42.0, v0.51.0, v0.64.0, v0.66.0, v0.67.0, v0.68.3, v0.69.0, v0.71.0, v0.73.0 | 23: installer claim, unclaimed heartbeat, retry-enroll claim, 2 heartbeats, 3 command results, 12 diagnostic results (running and completed), monitor report, rotation confirm, tray pairing | captured (pwsh, stand-in Windows) |
| Linux | v0.32.0, v0.33.0, v0.64.0, v0.68.3, v0.71.0, v0.73.0 | 6: installer claim, unclaimed heartbeat, heartbeat, 3 command results | captured (dash, stubbed userland) |
| macOS | v0.33.0, v0.64.0, v0.68.3, v0.71.0, v0.73.0 | 6: as Linux | captured (dash, stubbed macOS commands) |

On 0.73.1: 20 agent × release sets, 273 requests, 1,869 checks, none failed,
none known incompatible.

### Adding a release

1. When a release changes what a standard agent sends (anything in
   `apps/api/src/public/windows-script.ts`, `linux-agent.ts`, `macos-agent.ts`,
   `posix-agent.ts`, or the registration block in `public.controller.ts`), or
   becomes a supported release, add its tag to `scripts/compat/wire/agents.json`
   with the reason. The tag must exist (`git fetch --tags`).
2. Capture: `node scripts/compat/capture-wire.mjs <agent> <tag>` (Windows needs
   PowerShell 7: `PWSH=/path/to/pwsh`, a portable tarball in a scratch directory
   is enough). It writes `scripts/compat/wire/<agent>/<tag>/`.
3. Replay: `DATABASE_URL=postgresql://…/<name containing scratch or test>
   scripts/compat-wire.sh <agent>` after `cd apps/api && npx nest build`.
4. Commit the fixtures with the release.

A release that calls something the stand-in does not provide fails the capture
with the command's name: add it to `windows-prelude.ps1` (or the POSIX stubs in
`capture-wire.mjs`) rather than editing a fixture.

When an old agent's request has to stop working, add an entry to
`knownIncompatible` in `agents.json`: `{ "agent", "tag", "fixture"` (a file
name, or `"*"`)`, "reason" }`, with what the computers on that release must do.
An entry without a reason fails the run. The release notes say so.

## What is not covered yet

- **The standard tray** (`rem0te-tray.exe --standard`, Go): its `/tray/*` calls
  with the tray key. Only the heartbeat's `/tray/pair` is in the fixtures.
- **The standard agent's reinstall and update hooks**: they run the portal's
  current installer (`irm | iex`) and are not replayed; the replay checks only
  that nothing asks an old agent to.
- **Whether the fixtures still reproduce.** CI replays the committed fixtures
  and does not capture again; capturing needs the release tags and pwsh.
- **The OS side of the standard agents.** The bodies are built by the real
  scripts from stand-in values. That a release's CIM, `/proc` or `sw_vers`
  reads work on a real computer is the lab's and the fleet's evidence, not
  this.
- **RustDesk client versions** against the server's connect paths: part of the
  lab.
- **ClientSt0r contract versions:** the integration does not yet interoperate
  with the real ClientSt0r (`docs/readiness.md`).
- **The release gate.** The jobs report on every pull request; making them a
  required check is the owner's call once they have run stably.
