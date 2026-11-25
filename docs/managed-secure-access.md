# Managed Secure Access (MSA) — audit and design

**Status: build steps 1–5 built; steps 3–5 behind `MSA_GRANTS`, off.**
Readiness reporting (§3.9) shipped in 0.69; grants and the long-poll (§3.10)
in 0.71; agent enforcement, the managed test session, cutover and rollback
(§3.11) in 0.72; Connect through grants, revocation, session evidence and
group or customer cutover runs (§3.12) in 0.73. Everything after readiness
runs only when the server's environment has `MSA_GRANTS=on`, which no
production server does. Even then **nothing on a device changes until a
Platform Admin moves it into Managed (pending)** with a fresh confirmation —
one device, or a cutover run that moves a canary first and then paced
batches, each device through its own checks. Never the fleet at once, and
never automatically. Every other device stays in today's mode (*Legacy*),
and a 0.73 agent on a Legacy device behaves exactly as 0.71's. RustDesk
stays the remote desktop.

**Managed Secure Access has run only in the Windows lab** (GitHub's Windows
Server runners, RustDesk 1.4.1–1.5.3): never on a Windows 10 or 11 desktop,
never with a real technician connecting through RustDesk, and never on the
fleet. The lab runs the agent's enforcement code against real RustDesk as
SYSTEM; it does not run the portal, the long-poll or a remote connection.

Written 2026-11-19 against Rem0te 0.68 and RustDesk's source at 1.2.3–1.5.3
(client) and 1.1.16 (hbbs/hbbr OSS). Every RustDesk claim below names the
behaviour in RustDesk's own source; anything not yet run on a real Windows
device is marked **unverified on Windows**.

## 1. Audit: remote access today

### What each control is today

| Control | Today | Who enforces it |
|---|---|---|
| Who may press Connect (role, preset, customer, assignment, containment, unassigned pool) | **Enforced** | portal |
| Launch token (short-lived, one use, bound to technician and device) | **Enforced** | portal |
| MFA / passkeys at sign-in, fresh sign-in for sensitive changes | **Enforced** | portal |
| Permanent password: generated, sealed, revealed only to whom policy allows, rotation staged | **Enforced** (portal side) | portal + agent applies the rotation |
| Use of a seen permanent password outside Rem0te | **Not prevented** | nobody: any RustDesk client pointed at the server connects |
| View-only for preset technicians | **Refused, not enforced** (`endpoint_cannot_enforce_view_only`) | portal refuses rather than pretend |
| Consent for preset technicians | **Refused, not enforced** (`endpoint_cannot_enforce_consent`) | portal |
| View-only / consent for owners and admins | "Not applied" | nobody |
| Clipboard, file transfer | **Not enforced** (RustDesk client toggles) | nobody |
| Session length | **Advisory** | nobody |
| Ending a session from the console | **Not possible** | — |
| Revocation of a seen password | **Staged rotation**, applied at the next check-in | agent, when online |
| Session evidence | "Connection confirmed" heuristic (`rustdesk.exe --cm` count) | agent, partial |
| Containment `remote` pause | **Enforced for launches** | portal |

### Strengths to keep

Fail-closed launch policy (a mode the device cannot enforce is refused, never
silently weakened), tenant isolation on every remote path, sealed credentials,
the tamper-evident audit chain, containment, and the signed agent's verified
update chain. MSA builds on all of them and relaxes none.

### Limitations (architectural, not confirmed exploits)

1. A permanent password, once seen, is a standing credential outside Rem0te.
2. The portal's decisions stop at the launch; nothing on the device knows
   about them.
3. The technician's identity is not visible to the device: RustDesk's peer
   ID and name are asserted by the connecting client and checked by nobody
   (RustDesk `src/server/connection.rs`; the source says so itself).
4. hbbs OSS has no per-peer authorization. Its `-k` key is the public key every
   client holds: it means "configured for this server", not "authorized".

## 2. What unmodified RustDesk enforces on the device

From RustDesk's source (`src/server/connection.rs`, `password_security.rs`,
`core_main.rs`, `hbb_common/src/config.rs`). "Enforced" means the controlled
side drops or refuses it, whatever the technician's client does.

| Control | Enforced by the device? | How | Notes |
|---|---|---|---|
| View-only | **Yes** | `access-mode=view` | Flutter builds (Windows since 1.2); Sciter builds ignore it |
| `access-mode` itself | — | `view`, `full`, anything else | Flutter builds: `view` is every permission **off** and `full` every permission **on**, before any `enable-*` key is read; anything else (`custom`, or unset, which RustDesk's own settings page writes for *Custom*) reads each key (`Connection::permission` in 1.4.1–1.4.6, `is_permission_enabled_locally` from 1.4.7). The agent writes `view` or `custom`, never `full` (0.78.1, F1) |
| Keyboard and mouse | **Yes** | `enable-keyboard=N` | events dropped |
| Clipboard | **Yes** | `enable-clipboard=N` | |
| File transfer | **Yes** | `enable-file-transfer=N` | login refused; files via clipboard on Windows **unverified** |
| Audio, tunnels, remote restart, block input, recording | **Yes** | `enable-*` keys | an `enable-*` key that is unset, or anything but `N`, is **on** (hbb_common `option2bool`) |
| Terminal, camera, remote printer | **Yes** | `enable-terminal`, `enable-camera`, `enable-remote-printer` | present in every supported release (1.4.1–1.5.3) |
| Privacy mode | **From 1.4.7** | `enable-privacy-mode` | 1.4.1–1.4.6 have no such permission: there privacy mode is refused only when unsupported. The agent writes `N` on every release; before 1.4.7 RustDesk stores it and ignores it |
| Permission changes in the accept window | **No** (not settable) | `enable-perm-change-in-accept-window` | a *built-in* option (custom clients only), so the person at the device can widen keyboard, clipboard, audio, file, restart, recording, block-input and privacy mode for their own session |
| Server-sent permissions | — | `ControlPermissions` (1.4.9+) | only RustDesk Server Pro sends them, and they override the local keys; Rem0te's open-source hbbs never does |
| Consent (Accept / Dismiss) | **Yes**, and no password bypasses it | `approve-mode=click` | prompt waits for a signed-in user: not usable unattended at the logon screen |
| Which password works | **Yes** | `verification-method=use-permanent-password` | |
| Idle disconnect | **Yes** | `allow-auto-disconnect=Y`, `auto-disconnect-timeout` | idle, not a maximum |
| End every session, refuse new ones | **Yes** | `--option stop-service Y`, then `N` | |
| Session recording by the technician | **No** | `enable-record-session` is advisory | recording happens on the technician's side |
| Technician identity | **No** | — | self-asserted |

Settings are changed live with `rustdesk.exe --option <key> <value>` and
`--password <pw>` run as SYSTEM (an installed copy; no service restart). Editing
the TOML files while the service runs does not work: the service keeps its
settings in memory and writes them back. A changed permanent password applies
to the next login at once and does not end sessions already open.

**Proven in the Windows lab (0.68.3, `docs/lab-testing.md`):** `--option` and
`--password` run as SYSTEM from session 0 change a running RustDesk 1.4.1,
1.4.6, 1.4.7, 1.4.9 and 1.5.3, read back, and survive a service restart.
1.4.7 and later refuse a *copy* of `rustdesk.exe` outside its install folder,
so the agent only ever runs the installed one. 1.3.9 was not tested. Windows 10
and 11 desktops, a signed-in user and a live session are still untested.

## 3. Design

### 3.1 Modes, per device

| Mode | Meaning |
|---|---|
| **Legacy** | Today. Permanent password, portal-only authorization. The default, and unchanged. |
| **Compatible** | Signed agent and RustDesk new enough, and the agent's preflight passed. Still behaves as Legacy. |
| **Upgrade available** | Would be Compatible after a signed agent or RustDesk update. |
| **Managed (pending)** | An admin approved cutover; the agent is applying it. Legacy still works. |
| **Managed and verified** | The agent read back every enforced setting, a managed test session succeeded, and the legacy password has been replaced. |
| **Enforcement failure** | Managed, but the agent's last readback disagreed (a local admin changed a setting, RustDesk was replaced). Connect is refused until it is restored. |
| **Unsupported** | Linux, macOS, the standard agent, RustDesk Sciter builds. Stays Legacy. |
| **Unknown** | No recent report. Never shown as managed. |

A saved setting is never shown as enforcement: only the agent's readback is.

### 3.2 Session grant

When an authorized technician presses Connect on a managed device, the
portal issues a **session grant**: a small JSON document signed with Ed25519
(`node:crypto`; Go's `crypto/ed25519` on the agent).

```
{ v: 1, grantId, endpointId, rustdeskId, businessId, technicianId,
  mode: "view" | "control", permissions: { clipboard, files, audio, tunnel, restart },
  consent: "required" | "not_required", notBefore, notAfter (≤ 5 min to start),
  maxMinutes, idleMinutes, password (one-time) }
```

- **Signing key:** a dedicated grant key, separate from the approval signer's
  keys and from the portal's session secrets. The agent learns its public key
  from the signed release metadata it already verifies (TUF targets), so a
  substituted key needs a signed release. A compromised portal can still issue
  grants, exactly as it can launch sessions today: MSA moves enforcement onto
  the device and removes the standing credential; it does not add a second
  person to ordinary support (the directive's "no repetitive approvals").
- **Agent checks:** signature, `endpointId` and `rustdeskId` are its own,
  `notBefore ≤ now ≤ notAfter`, `grantId` never seen before (kept until
  expiry), mode and permissions within the device's ceiling, no `remote`
  containment pause in its signed pause file.
- **Delivery:** a managed device's signed agent keeps one long-poll request
  open to the portal (device secret, TLS), so a grant arrives within seconds.
  Legacy devices never open it. The portal side was built in 0.71
  (`POST /msa/agent/poll`, §3.10); the agent's poller in 0.72 (§3.11).
- **Publishing the key (0.72):** the agent trusts a grant key only when it is
  listed in `msa/grant-keys.json`, a target in the signed release metadata
  the agent already verifies. The portal never sends a key to an agent. The
  console shows a Platform Admin the exact command for the release host
  (`sudo rem0te-signed-grant-key add --key-id … --public-key …`, then
  `sudo rem0te-signed-publish --republish`); see §3.11.

### 3.3 What the agent does with a grant

1. Sets, through RustDesk's CLI as SYSTEM: `verification-method=use-permanent-password`;
   `access-mode` (`view`, or `custom` for control — never `full`) and
   `enable-keyboard / -clipboard / -file-transfer / -audio / -tunnel /
   -remote-restart` from the grant; from 0.78.1 `enable-terminal / -camera /
   -remote-printer / -block-input / -privacy-mode / -record-session` as `N` on
   every grant; `approve-mode=click` when consent is required, else
   `password`; `allow-auto-disconnect` with the idle limit.
2. Sets the permanent password to the grant's one-time password.
3. **Reads every value back** and reports *applied* or *enforcement failure*.
   On failure the grant is refused and the portal says so; nothing weaker is
   substituted.
4. The portal hands the one-time password to the launcher, as it hands the
   permanent password today: Select → Connect → Work is unchanged.
5. At session end, `maxMinutes`, `notAfter` without a connection, or revocation:
   sets the password to a fresh random value **no one is told**, and ends any
   open session with `stop-service Y` → `N`.

Between sessions a managed device's password is that unknown random value,
so **an old permanent password is not a bypass.** This is the property the
directive asks to test directly.

### 3.4 Revocation

Disconnect one session, all of a technician's sessions, a customer's, or a
device's, and the `remote` containment pause, all reach the agent over the
same long-poll and end the session. **Built in 0.73** (§3.12). **Offline:** a device that cannot
reach the portal cannot receive a grant, so it cannot be connected to in
managed mode at all (fail closed; Legacy behaves as today). A session already
open when the network drops ends at `maxMinutes` or idle timeout, enforced by
the agent and RustDesk locally.

### 3.5 Session evidence

The agent reports: grant received, settings applied (with readback), connection
opened and closed (the `--cm` process), revocation applied. **Built in 0.73**
(§3.12). Not built: reading RustDesk's own log lines (an undocumented format,
and it holds the other side's details) and consent accepted or dismissed,
which the agent cannot observe — the timeline says so. The console shows
*Requested → Authorized → Launched → Connected → Disconnected / Expired /
Revoked / Failed*, and never treats *Launched* as *Connected*. What the agent
cannot see (what happened inside the session, the technician's identity at the
RustDesk layer) is labelled as such.

**Later, optional:** RustDesk can post connection audits (`/api/audit/conn`,
with connection ids) and accept a `disconnect` list from an API server. That
protocol is undocumented, and in ≤1.4.x the same channel applies any pushed
setting unfiltered, including which server to use. Not part of the first
release; if added, HTTPS only, behind its own flag.

### 3.6 Consent and identity

RustDesk's consent prompt shows the connecting client's self-asserted name.
The agent cannot change that prompt. So the grant binds identity instead: the
one-time password goes only to the technician the portal authorized, through
their own signed-in launch, and the session's audit row names them. The tray
can show "Technician *name* from *MSP* has been authorized for view-only
access until *time*" just before the prompt, from the grant, which the agent
verified.

### 3.7 Cutover, upgrade, rollback

- **Preflight** (read-only, any time): signed agent version, RustDesk version
  and Flutter build, CLI works as SYSTEM, readback works. Result: Compatible /
  Upgrade available / Unsupported. **Built in 0.69** — see §3.9.
- **Cutover** needs a Platform Admin (fresh sign-in) and moves **one
  device** at a time. The legacy password is kept until a managed test
  session succeeds; only then is it replaced. Never automatic, never
  fleet-wide. **Built in 0.72** (§3.11). **Group or customer cutover runs**
  (0.73, §3.12) move a canary first, then batches a Platform Admin advances,
  each device through the same one-device cutover.
- **Rollback** to Legacy is an admin action: the agent restores the previous
  RustDesk settings and the portal stages a new sealed permanent password
  through the ordinary rotation. **Built in 0.72** (§3.11).
- Nothing rotates the fleet, reinstalls RustDesk, or moves a device by
  itself.

### 3.8 What MSA cannot do (stated in the console, too)

- Authenticate the technician inside RustDesk.
- Stop the technician's client recording.
- Prevent a local administrator from changing RustDesk settings: the agent
  re-applies and reports drift as *Enforcement failure* (Connect refused).
- Work unattended at the logon screen with consent required.
- Protect devices without the signed agent (Linux, macOS, standard agent).

A modified RustDesk client (AGPL-3.0: source must be published with every
build) would be needed for locked settings or device-side recording. Not
planned unless the agent-based design proves insufficient.

### 3.9 Readiness reporting (built, 0.69)

**Readiness only — Managed Secure Access is not available yet; nothing has
changed on any device.** The console says this above every readiness view.

**What the agent reports.** `rem0te-agent.exe rustdesk-preflight`, started by
the signed heartbeat at most every 30 minutes, runs for real at most every 6
hours, or sooner when the installed `rustdesk.exe` changed (its version, size
or modification time; kept locally, never reported). It writes one small block
(`rem0te-rustdesk-preflight/1`, at most 4 KB) that the heartbeat sends until
the portal acknowledges it:

| Field | What it is |
|---|---|
| `installed` | `%ProgramFiles%\RustDesk\rustdesk.exe` exists as a regular file (not a reparse point) |
| `expectedPath` | the RustDesk service runs that file. A boolean, **never the path**: a RustDesk installed elsewhere usually lives under a user's profile, and the path would carry their name |
| `version` | the exe's FileVersion resource (`1.4.7+65`), strict charset, or null |
| `build` | `flutter` / `sciter` / `unknown` — **a heuristic**: `flutter_windows.dll` or `sciter.dll` beside the exe. The lab confirms only the Flutter half (every official x64 build is Flutter); no Sciter build has been checked |
| `service` | `running` / `stopped` / `missing` / `other`, read with query rights only |
| `cli`, `keys` | whether each of the eleven `rustdesk.exe --option <key>` **reads** answered with a well-formed value (`ok` / `unparsed` / `timeout` / `error`); `cli` is `ok`, `partial`, `failed` or `not_run` |

It never reports a setting's value, never passes a value to `--option`, never
calls `--password`, and runs nothing but the installed exe, by its absolute
path, as an argument array with no shell, and only when the service runs that
same file. Each read times out after 15 s and keeps at most 4 KB of output.

**What the portal accepts.** Only from an authenticated heartbeat on the
signed channel that may act (§64): never a standard heartbeat, an installer's
check-in, a leftover standard heartbeat or a pooled device. Anything that
does not parse is dropped; the heartbeat never fails for it, so an older or
newer agent is never refused. One row per device (`RustdeskPreflight`,
migration 0087), newest report wins.

**The states** (`apps/api/src/msa/readiness.ts`, one pure function; the first
rule that applies decides):

| State | When |
|---|---|
| Unsupported | Linux or macOS; the standard agent; a Sciter build |
| Unknown | the platform is not reported; not reporting now (no heartbeat within 30 minutes); no report yet; a report older than 7 days; the build or version unreadable; RustDesk newer than the newest lab-tested release (1.5.3); the service not running; any read unanswered |
| Upgrade available | a signed agent older than 0.69.0 (it cannot report); RustDesk not in Program Files\RustDesk, no service, or a service running another copy (Update RustDesk fixes it); RustDesk older than 1.4.1 — **not lab-tested**, not known to be broken |
| Compatible | everything above passed on a release within 1.4.1–1.5.3, every read answered. It says whether that exact release was in the lab. Still Legacy |

*Managed (pending)*, *Managed and verified* and *Enforcement failure* exist in
the type and in the console's vocabulary, and nothing can produce them yet: a
unit test runs 622,080 combinations of facts and the security invariants
(§80) check the source. No readiness answer is ever marked verified.

**Where it shows.** The device page's *Secure remote access readiness* card
(Overview), and *Remote support → Remote access readiness*: counts per state and every
device the viewer can see, from `GET /msa/readiness` (View devices;
`endpointVisibilityWhere`). `GET /msa/readiness/:endpointId` is the card's.

**Evidence.** The preflight ran on real Windows Server 2025 in the Windows lab
against RustDesk 1.4.1, 1.4.6, 1.4.7, 1.4.9 and 1.5.3, as the administrator and
as SYSTEM through the real `rem0te-agent.exe` from a scheduled task
(`TestLabRustdeskPreflight`). It has **not** run on a Windows 10 or 11 desktop,
with someone signed in, or on any fleet device: reports appear only once a
device's signed agent has updated to 0.69, through the existing automatic
update policy.

### 3.10 Grants and the long-poll (built, 0.71, behind `MSA_GRANTS`, off)

**Off unless the server's environment has `MSA_GRANTS=on`, exactly.** It is
not a console setting, on purpose: nobody can switch it on from the UI
before the agent enforces a grant (steps 4 and 5). With it off every route
below answers `404 MSA_NOT_ENABLED` before a session, a device secret or a
row is read, no key is generated and nothing is stored. Do not set it on a
production server until step 4 ships.

**The grant key.** A dedicated Ed25519 key, separate from the approval
signer's keys and from every session secret, generated on the first issuance
(table `MsaGrantKey`, migration 0088; at most one active). Its private key is
sealed under `ENCRYPTION_KEY` (secret-box purpose `rem0te-msa-grant-key-v1`)
and appears in no response, log or audit row; the key id is the first 16 hex
characters of the SHA-256 of the raw public key. Creating it is audited
(`MSA_GRANT_KEY_CREATED`, the key id only). A key sealed under an earlier
`ENCRYPTION_KEY` is refused (`503 MSA_GRANT_KEY_UNAVAILABLE`) rather than
silently replaced.

**The document** is §3.2's, defined in one pure module,
`apps/api/src/msa/grant.ts`: one canonical serialisation (the fixed key
order, no whitespace, every string inside a strict charset), signed with
Ed25519 over `rem0te-msa-grant-v1\n` + those bytes, in an envelope
`{ keyId, grant: base64, sig: base64 }`. `notAfter` is exactly five minutes
after `notBefore` when issued (at most five accepted), `maxMinutes` is 1–480,
`idleMinutes` 1–120 and no more than `maxMinutes`. The one-time password is
24 characters from `A–Z a–z 0–9`, made by the server; a request cannot choose
it. It is stored only sealed (`rem0te-msa-grant-pw-v1`), as is the envelope
(`rem0te-msa-grant-envelope-v1`), and is never logged or audited.

**The agent's verifier** is `tools/windows-installer/internal/msa/grant` (Go,
pure: it reads no clock, file or network). It refuses, in this order and with
these codes: `envelope_malformed`, `unknown_key`, `bad_signature`,
`grant_malformed` (including any non-canonical spelling), `unsupported_version`,
`bad_window`, `wrong_endpoint`, `wrong_rustdesk_id`, `remote_paused`,
`not_yet_valid`, `expired` (both with 30 s of clock skew), `replayed`,
`mode_not_allowed`, `permission_not_allowed`. The portal's `verifyEnvelope` is
the same list in the same order, and both are tested against one fixture
(`internal/msa/testdata/msa-grants.json`, 63 cases, test-only keys). **No
command imports the verifier**: the 0.71 agent binary is unchanged.

**Issuing** (step 3 has no Connect path): `POST /msa/grants/test/:endpointId`,
Platform Admin, with a fresh confirmation when *Settings → Confirm it is you*
has **Managed Secure Access test grants** (`msa.grant`) on *Ask*. Body, all
optional: `mode` (`view`), `permissions` (all `false`), `consent`
(`required`), `maxMinutes` (60), `idleMinutes` (15). Refused: a device the
caller cannot see (404), an unassigned one (`ENDPOINT_UNASSIGNED`), one not on
Windows or not running the signed agent (`409 MSA_SIGNED_AGENT_REQUIRED`), one
with no RustDesk ID or device secret (`409 MSA_GRANT_NO_DEVICE`), a `remote`
containment pause (`403 CONTAINED`), and a malformed body
(`400 MSA_GRANT_INVALID`). `MSA_GRANT_ISSUED` (ids, mode, consent, key id) is
written before the grant exists, and a failure to write it refuses the grant.
A newer grant cancels an older undelivered one for the same device.

**The long-poll**, `POST /msa/agent/poll` (`rustdeskId`, `agentSecret`,
optional `ack` of up to 20 grant ids, optional `wait: false`): the device
secret is checked first, then only an assigned Windows device whose
identity is the signed agent (§64) may poll (`403 MSA_SIGNED_AGENT_REQUIRED`
otherwise). It answers at once with the device's undelivered grants inside
their window (at most five); with none, it holds for up to 25 s and wakes as
soon as one is issued (in process; every 5 s it also looks at the database).
One held poll per device — a second ends the first, which then hands
nothing over (`superseded: true`) — and at most 500 in a process
(`retryAfterMs`). An `ack` marks those of its own grants still issued and in
their window *delivered*, conditionally, so a repeated ack changes nothing.
Under a `remote` pause grants are withheld (`paused: true`). An undelivered
grant past its window is marked *expired* when the device polls or the list
is read; there is no sweep. The 0.71 agent never calls it.

**Reading:** `GET /msa/grants/endpoint/:endpointId` (View devices, the
device in scope) lists its 50 most recent grants — state, mode,
permissions, window, who issued it — never the password or the envelope.
`GET /msa/grants/keys` (Platform Admin) lists the public keys.

**States** (0088 CHECK): `issued`, `delivered`, `expired`, `cancelled`.
0.72 (0089) adds `applied`, `failed` and `ended`; revocation is step 5.

**Evidence.** `apps/api/scripts/e2e-msa-grants.mjs` (68 checks: the switch
off and on, every refusal, delivery and verification under the published key,
ack, wake, supersede, the hold, the cap, expiry, cancellation, the pause, no
password anywhere, the database's CHECKs), `unit-msa-grants.mjs`, the Go
`internal/msa/grant` tests and check-security-invariants §81. **Nothing of it
has run on Windows**, and no agent has polled.

### 3.11 Enforcement, the managed test session, cutover and rollback (built, 0.72, behind `MSA_GRANTS`, off)

**This is a new signed agent build.** On deploy the fleet's signed agents
update to 0.72 as they always do. On a Legacy device — every device, until
a Platform Admin moves one — the 0.72 agent does exactly what 0.71 did: the
heartbeat never says `msaPoll`, the poller never starts, and no RustDesk
setting or password is touched.

**Grant keys in the signed release.** `rem0te-signed-grant-key add | list |
retire` (installed by `rem0te-signed-setup.sh`) records grant **public** keys
in the release user's state directory (`msa-grant-keys.json`, at most 8; key
material, and a key id that is not the key's own SHA-256 prefix, are
refused). `rem0te-signed-publish` signs the list in as the target
`msa/grant-keys.json` (schema `rem0te-msa-grant-keys/1`) on every publish;
`rem0te-signed-status` shows its digest. The agent reads it only through the
verified TUF chain (`agent.MsaTrust`, which also reads the signed pause). No
list, an empty list, or a key not on it: every grant is refused (`no_keys` /
`unknown_key`). The Managed Secure Access card shows a Platform Admin the two
commands with the active key filled in until the published release lists it,
and cutover is refused until it does (`MSA_GRANT_KEY_NOT_PUBLISHED`).

**Per-device mode** (`MsaManagedComputer`, migration 0089; no row is
Legacy): `pending` → `verified`, or `enforcement_failure`, or
`rollback_pending` → row deleted. Only `MsaManagedService` writes it.
Readiness shows *Managed (pending)*, *Managed and verified* (only while the
agent's last full readback is inside the report window) and *Enforcement
failure* from this row and the agent's reports, never from a saved setting.

**Cutover**, `POST /msa/managed/:endpointId/cutover`: Platform Admin, a fresh
confirmation when `msa.cutover` asks, one device in scope. Refused when the
device is unassigned, not the signed Windows agent, not *Compatible*,
running an agent older than 0.72 (`MSA_AGENT_TOO_OLD`), under a `remote`
pause, already managed, or when the grant key is not in the published
release. Audited (`MSA_CUTOVER`) before the row is written. The next
heartbeat says `msaPoll: true`, and the signed heartbeat starts
`rem0te-agent.exe msa-poller` as SYSTEM.

**The poller** (`internal/msa/enforce`, wired in `msa_poller_windows.go`)
holds the long-poll with the device secret and, on each answer: exits for
Legacy; for each grant verifies it under the published keys, this device's
identity, the persisted replay set, the compiled **ceiling — view only,
nothing beyond (no keyboard, clipboard, files, audio, tunnel or restart)** —
and the signed pause; writes the replay set and (before the first change
ever) saves every current setting to a SYSTEM-only directory; then sets every
§3.3 setting, reads each back, and sets the one-time password last (RustDesk
must print `Done`). Any disagreement ends the session at once (a random
password nobody is told, `stop-service Y`, a pause, `N`) and reports `failed`
with the closed key names; nothing weaker is applied. It ends the session
when the connection closes, at `maxMinutes`, or when nobody connected by
`notAfter`, and reads the settings back hourly at rest (drift is
*Enforcement failure*). Two exec sites name `--option` (the preflight's reads
and enforcement's closed argument lists) and one names `--password`; both
run only the installed `rustdesk.exe` the RustDesk service runs, as an
argument array with no shell. The password is never logged, reported or
audited.

**The managed test session** (while *pending*): a Platform Admin sends a
view-only test grant (`POST /msa/grants/test/:endpointId`, consent required),
the agent applies it, **Reveal one-time password** shows it once
(`POST /msa/managed/grants/:grantId/reveal`, `msa.reveal`, audited as
`MSA_PASSWORD_REVEALED` with ids only, claimed by a conditional write), and
the admin connects with RustDesk. The agent reports the connection
(`rustdesk.exe --cm`) and its end. While pending, the agent restores the
saved settings after each test session and the portal stages a legacy
rotation, so Legacy Connect keeps working between test sessions; a staged
rotation waits while a grant is in flight.

**Verified**, `POST /msa/managed/:endpointId/confirm` (Platform Admin,
`msa.cutover`): only after a test session since cutover that read back and
connected. The agent then replaces the permanent password with one nobody is
told (`secured`). From then on legacy Reveal, Connect, rotation and set
password are refused (`409 MSA_MANAGED` / `msa_managed`). From 0.73 Connect
on a verified device goes through a session grant (§3.12).

**Rollback**, `POST /msa/managed/:endpointId/rollback`: Platform Admin, never
asks for a fresh confirmation, audited. It cancels undelivered grants and
stages a fresh sealed permanent password through the existing rotation path;
the agent ends any session, restores the saved settings, reads them back and
reports `restored` (the row is deleted) or `restore_failed`. **Finish
rollback without the agent** (`force: true`) is only for a device already
rolling back whose agent is gone. Rollback needs the switch on: turning
`MSA_GRANTS` off with a verified device stops its poller but still refuses
its legacy password (fail closed) — roll back first.

Step 5 (0.73, §3.12) added Connect through grants, the control ceiling,
revocation, the session timeline and cutover runs. There is still no console
switch for `MSA_GRANTS`.

**Evidence.** `apps/api/scripts/e2e-msa-managed.mjs` (port 3961),
`unit-msa-managed.mjs`, `unit-msa-readiness.mjs`, the Go
`internal/msa/enforce` tests (a fake RustDesk), check-security-invariants
§82, and the Windows lab's `TestLabRustdeskEnforce` (save, apply, readback,
password, end session, restore — as the administrator and as SYSTEM, RustDesk
1.4.1–1.5.3). The lab runs the agent's enforcement code against real
RustDesk, but not the portal, the long-poll or a real remote connection.

### 3.12 Connect through grants, revocation, evidence and cutover runs (built, 0.73, behind `MSA_GRANTS`, off)

**A new signed agent build (0.73.0).** Agents update as they always do; on a
Legacy device it behaves exactly as 0.71's. Everything below needs
`MSA_GRANTS=on`; with it off every new route answers `404 MSA_NOT_ENABLED`
and the console asks none of them.

**Connect.** On a *Managed and verified* device the device page's Connect
calls `POST /msa/sessions/connect/:endpointId` with only the mode the
technician picked (`control`, `view_only`, `unattended`). In order, the
portal refuses with a reason:

| Refusal | When |
|---|---|
| `MSA_NOT_MANAGED` / `MSA_NOT_VERIFIED` | Legacy or Managed (pending): use the ordinary Connect |
| `MSA_ROLLBACK_PENDING`, `MSA_ENFORCEMENT_FAILURE` | the device's state |
| `MSA_AGENT_TOO_OLD` | the agent is older than 0.73.0 (it could not be told to end a session) |
| `MSA_AGENT_NOT_POLLING` | no poll held and none in the last 90 s: offline, or its poller is not running |
| `MSA_SESSION_ACTIVE` | another person's managed session is live there |
| the launch policy's own codes | `authorizeConnect` with `managed: true` — role, preset, assignment, hours, containment, temporary grant |

Then the grant's terms come from the policy, never from the request:

- **Mode.** `view_only` → view with nothing beyond; `control` and
  `unattended` → control. Elevated never reaches a grant.
- **Clipboard and file transfer** only when the customer's access controls
  say `request` and, for a preset technician, the preset allows them.
  **Audio** with control. **Tunnel and remote restart never.**
- **Consent** (`approve-mode=click`) when a preset technician's access
  controls require attended consent.
- **Session limit** is the preset's, or the access controls'
  `maxSessionMinutes` (1–480), enforced by the agent. Idle disconnect is 15
  minutes, or the limit if shorter.

So **view-only and attended consent are enforceable on a managed device**:
an L2 technician whose Legacy Connect is refused as
`ENDPOINT_CANNOT_ENFORCE_VIEW_ONLY` gets a view-only, consent-required grant
here. On a Legacy device nothing changed: it is still refused.

The portal signs the grant and the console shows its progress: *Authorized*,
*Received by the agent*, *Applied (settings read back)*. **It waits at most 60
seconds** for `applied`. A grant not applied by then is revoked (`timeout`),
the console says why, and nothing is handed over; a late `applied` changes
nothing. Once applied, *Download Connect script* hands over the session's
one-time password **once**, to that technician only
(`GET /msa/sessions/grants/:grantId/connect.cmd`, `MSA_PASSWORD_RELEASED`
audited with ids). It is not the permanent password and needs no fresh
confirmation: it opens only this session, and the agent replaces it when the
session ends. **There is never a fallback to a Legacy password.** The
`rem0te://` launcher is not used for managed devices in 0.73; it refuses
one, as before.

**Control mode and the ceiling.** The managed ceiling is **control with
clipboard, file transfer and audio; never a TCP tunnel or a remote restart**,
the same in the agent (`enforce.Ceiling`, compiled in) and the portal
(`MANAGED_CEILING`). Control is what ordinary support needs, and those three
are what the access controls and presets already govern. A tunnel reaches
other hosts on the customer's network and a remote restart breaks the
session's own enforcement window; neither has a control in Rem0te, so
neither is offered. Widening the ceiling is a signed agent release.

> **Correction (0.76.1), fixed in 0.78.1: agents 0.73.0–0.78.0 did not enforce this.** For a control grant
> those agents wrote `access-mode=full`. In RustDesk's Flutter builds (every official Windows build), `full`
> turns **every** permission on before any `enable-*` key is read (`Connection::is_permission_enabled_locally`
> in 1.4.7–1.5.3, `Connection::permission` in 1.4.1–1.4.6). So in control mode clipboard off, file transfer
> off, no tunnel and no remote restart were written and read back but not enforced, and RustDesk's terminal
> (1.4.1+, SYSTEM with an administrator's credentials), camera, remote printer, block-input, privacy mode and
> recording were on, because the agent never wrote their keys. View-only grants were unaffected, and no
> production device was exposed: `MSA_GRANTS` is off. Finding F1 in
> [session-maintenance-mdm-backup-audit.md](session-maintenance-mdm-backup-audit.md#f1-a-control-grant-turns-every-permission-on).
>
> **What 0.78.1's signed agent does** (roadmap 1.1):
>
> - **Control is `access-mode=custom`**, which makes RustDesk read each `enable-*` key. `full` is refused by
>   every argument builder (`args.go`), including a rollback: a device that had `full` before cutover gets
>   RustDesk's default (*Custom*, unset) back, with each `enable-*` key restored as it was.
> - **Every grant, view and control alike, sets `enable-terminal`, `enable-camera`, `enable-remote-printer`,
>   `enable-block-input`, `enable-privacy-mode` and `enable-record-session` to `N`** and reads each back. A
>   readback that disagrees refuses the grant (`readback_mismatch`, naming the key) and ends the session with
>   a password nobody is told. Those are all of RustDesk's permission options in 1.4.1–1.5.3, with the six a
>   grant governs. The names are the same in every supported release; `enable-privacy-mode` is honoured only
>   from **1.4.7**, so on 1.4.1–1.4.6 a control session can still turn privacy mode on where Windows supports it.
> - **Before it writes anything**, the agent evaluates RustDesk's own rule (`enforce.Effective`, a port of
>   `is_permission_enabled_locally` and `option2bool`) over the values it is about to set, and refuses the grant
>   if RustDesk would allow anything the grant and the ceiling do not.
> - A device cut over by an older agent is brought forward: the agent adds the six keys' current values to
>   the settings it saved before cutover (it never changed them), and treats a remembered `full` as `custom`, so
>   the hourly readback corrects it.
>
> **What is still not enforced by RustDesk:** the person at the device can change permissions in RustDesk's
> accept window (`enable-perm-change-in-accept-window` is a built-in option only a custom client can set), and
> RustDesk Server Pro could override the local keys (`ControlPermissions`), which Rem0te's hbbs never sends.
>
> **Evidence.** Go unit tests (every mode × every permission combination: no `full`, effective permissions
> exactly the grant's), and the Windows lab: after apply, `access-mode` reads `view` or `custom`, every one of
> the twelve permission options reads back as set, and RustDesk's rule over what RustDesk reports grants
> exactly the grant's permissions, as the administrator and as SYSTEM on RustDesk 1.4.1, 1.4.6, 1.4.7, 1.4.9
> and 1.5.3. **That effective state is derived, not observed:** RustDesk 1.4.1–1.5.3 has no command line or
> documented interface that answers what a connection would be allowed, and the lab has no second RustDesk
> that can log in headless, so no connection was made. It has not run on a desktop or the fleet.

**Revocation.** A signed revocation, Ed25519 under the same grant key with
its own prefix (`rem0te-msa-revoke-v1\n`), so a grant signature can never be
replayed as one. It names one device and either a list of grants or `all`
(every grant issued before it), and lives at most nine hours. The agent
verifies it (`grant.VerifyRevocation`), ends the open session it covers,
remembers the revoked grant ids so they can never be applied later, and acks.
It only reduces: it can end a session, never start or widen one.

| Scope | Who may (any of them, never a fresh confirmation) |
|---|---|
| One session (*Disconnect*) | its technician; the customer's own Owner or Admin (not a technician, with Edit devices); a Platform Admin |
| A list (*Managed sessions → Disconnect selected*) | the same, per session; the others are reported refused |
| Every session on a device | the customer's Owner or Admin; a Platform Admin |
| A technician's sessions | the customer's Owner or Admin (in their customer); a Platform Admin |
| A customer's sessions | its Owner or Admin; a Platform Admin |
| The `remote` containment pause | whoever may set the pause; every delivered or applied grant is revoked on the next poll, by the system |

Each revocation is audited (`MSA_SESSION_REVOKED`: who, the reason, the
grant ids). **Offline:** a revoked session on a device that cannot reach
the portal ends at its session limit or idle timeout, enforced locally; the
console says so (*waiting for the agent to end it*).

**Session evidence.** Each session's timeline: *Requested → Authorized →
Received → Applied → Launched → Connected → Disconnected / Expired / Revoked
/ Failed*, each with its time, only for what the portal or the agent saw.
*Launched* (the password went to a Connect script) is never shown as
*Connected*; *Connected* is the agent seeing RustDesk's connection manager.
Every timeline says what the agent cannot see: who is at the other end,
whether the person at the device accepted the consent prompt, and what
happened inside the session.

**Cutover runs** (`/msa/cutover-runs`, Platform Admin; starting, advancing
and confirming need a fresh confirmation, `msa.cutover`; halting and rolling
back never do). A run covers one customer or one of its device groups, at
most 500 devices, one open run per customer.

1. **Canary.** Starting a run cuts over its canary (one named device, or
   the first eligible). It is confirmed on its own page as in §3.11 — a test
   session that read back and connected. Nothing else moves until it is
   verified (`MSA_CANARY_NOT_VERIFIED`).
2. **Batches.** *Advance* moves the next batch (1–25, default 5). Each
   device goes through the one-device cutover with its own blockers and
   audit row; one that is refused is **skipped** with the code. Each
   device moved is sent a five-minute view-only verification grant.
3. **Pacing.** The next batch waits until every device in the last one has
   read back its verification grant, or an hour has passed. Nothing runs on a
   timer: every batch is a person pressing *Advance*.
4. **Confirm.** Marks verified each device whose agent applied and read
   back its verification grant since its cutover (the canary proved a real
   connection). Each one is its own `MSA_VERIFIED` row naming the run.
5. **Halt** stops the run; **Rollback** rolls back every device the run
   moved.

**The console.** The device page lists the device's managed sessions with
their timelines and *Disconnect* (only when the server says
`managedControls`). *Remote support → Managed sessions* lists live sessions on every
device the viewer can see, with bulk *Disconnect*. *Remote readiness*
shows cutover runs to Platform Admins.

**Evidence.** `apps/api/scripts/e2e-msa-sessions.mjs` (port 3971: Connect
end to end with a stand-in agent, every refusal, view-only enforced on a
managed device and still refused on Legacy, revocation for each scope and
the pause, the timeline, group and customer runs with canary, skip, confirm,
halt and rollback, inertness with the switch off, no password in an audit
row), `unit-msa-sessions.mjs` (the shared revocation fixture
`internal/msa/testdata/msa-revocations.json`, every combination of policy
facts against the ceiling, the timeline), the Go `internal/msa/grant` and
`internal/msa/enforce` session tests, check-security-invariants §83, and the
Windows lab's `TestLabRustdeskEnforce`, which now also applies and reads back
the control ceiling and checks that a revocation ends the session (RustDesk
1.4.1–1.5.3, as the administrator and as SYSTEM). **Not run:** a real
technician connecting through RustDesk to a managed device, a Windows 10
or 11 desktop, or any fleet device.

## 4. Build order (each a reviewable PR, none deployed without approval)

1. **Lab proof** on GitHub's `windows-latest`: install RustDesk, run the signed
   agent's `--option` / `--password` / readback / `stop-service` path as SYSTEM
   against RustDesk 1.2.x, 1.3.x, 1.4.6 and 1.4.7+. Go/no-go for everything
   below. **Done in 0.68.3** for 1.4.1–1.5.3 (go); 1.3.9 and older untested.
2. **Capability reporting and modes** (read-only): the agent reports RustDesk
   version, build and preflight; the console shows each device's mode.
   **Built in 0.69** (§3.9).
3. **Grants and the long-poll channel**, behind a feature flag, off.
   **Built in 0.71, behind `MSA_GRANTS`, off** (§3.10): the portal side and a
   pure Go verifier no command imports. Publishing the grant key in the
   signed release metadata is step 4.
4. **Agent enforcement** (signed agent release), managed test session, cutover
   and rollback. **Built in 0.72, behind `MSA_GRANTS`, off** (§3.11): one
   device at a time, view-only, grant keys in the signed release.
5. **Connect through grants, revocation, session evidence**, cutover runs,
   console controls. **Built in 0.73, behind `MSA_GRANTS`, off** (§3.12).
6. **Compatibility suite** (below) gates every release from step 2 on.

## 5. Permanent compatibility testing

Proven 2026-11-19 on a scratch database: the **v0.64.0** signed agent (built
from its release tag, run through `rem0te-action-sim`) passed six suites against
the current server (presets, approved actions, staged patching, maintenance
actions, patch policies, service and process control; 611 checks). The plan:

- A CI job that builds the agent from each **supported release tag** (the
  current one and the versions still on the fleet) and runs the action suites
  against the server under test. A supported version that fails blocks the
  release.
- Wire fixtures for the standard agent and the POSIX agents: the heartbeat
  and command-result bodies each supported release sends, replayed against
  the new API. **Built in 0.73.1** (`compat-wire` CI jobs,
  docs/compatibility.md "Wire fixtures"): 20 agent × release sets, every
  request captured from the release's own scripts.
- Lab jobs on `windows-latest` for the real-Windows paths, including RustDesk.
- Each release's notes carry the matrix: versions tested, at which evidence
  level, and what was not tested.
