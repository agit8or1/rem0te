# Managed Secure Access (MSA) — audit and design

**Status: build steps 2–4 built, behind `MSA_GRANTS`, off.** Readiness
reporting (§3.9) shipped in 0.69; grants and the long-poll (§3.10) in 0.71;
agent enforcement, the managed test session, cutover and rollback (§3.11) in
0.72. Everything after readiness runs only when the server's environment has
`MSA_GRANTS=on`, which no production server does. Even then **nothing on a
computer changes until a Platform Admin moves that one computer into
Managed (pending)**, with a fresh confirmation — never a group, a business
or the fleet, and never automatically. Every other computer stays in today's
mode (*Legacy*), and a 0.72 agent on a Legacy computer behaves exactly as
0.71's. Technician Connect through grants, revocation and session evidence
are step 5 and not built. RustDesk stays the remote desktop.

**Managed Secure Access has run only in the Windows lab** (GitHub's Windows
Server runners, RustDesk 1.4.1–1.5.3): never on a Windows 10 or 11 desktop
and never on the fleet.

Written 2026-11-19 against Rem0te 0.68 and RustDesk's source at 1.2.3–1.5.3
(client) and 1.1.16 (hbbs/hbbr OSS). Every RustDesk claim below names the
behaviour in RustDesk's own source; anything not yet run on a real Windows
computer is marked **unverified on Windows**.

## 1. Audit: remote access today

### What each control is today

| Control | Today | Who enforces it |
|---|---|---|
| Who may press Connect (role, preset, business, assignment, containment, unassigned pool) | **Enforced** | portal |
| Launch token (short-lived, one use, bound to technician and computer) | **Enforced** | portal |
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

Fail-closed launch policy (a mode the endpoint cannot enforce is refused, never
silently weakened), tenant isolation on every remote path, sealed credentials,
the tamper-evident audit chain, containment, and the signed agent's verified
update chain. MSA builds on all of them and relaxes none.

### Limitations (architectural, not confirmed exploits)

1. A permanent password, once seen, is a standing credential outside Rem0te.
2. The portal's decisions stop at the launch; nothing on the computer knows
   about them.
3. The technician's identity is not visible to the computer: RustDesk's peer
   ID and name are asserted by the connecting client and checked by nobody
   (RustDesk `src/server/connection.rs`; the source says so itself).
4. hbbs OSS has no per-peer authorization. Its `-k` key is the public key every
   client holds: it means "configured for this server", not "authorized".

## 2. What unmodified RustDesk enforces on the computer

From RustDesk's source (`src/server/connection.rs`, `password_security.rs`,
`core_main.rs`, `hbb_common/src/config.rs`). "Enforced" means the controlled
side drops or refuses it, whatever the technician's client does.

| Control | Enforced by the computer? | How | Notes |
|---|---|---|---|
| View-only | **Yes** | `access-mode=view` | Flutter builds (Windows since 1.2); Sciter builds ignore it |
| Keyboard and mouse | **Yes** | `enable-keyboard=N` | events dropped |
| Clipboard | **Yes** | `enable-clipboard=N` | |
| File transfer | **Yes** | `enable-file-transfer=N` | login refused; files via clipboard on Windows **unverified** |
| Audio, tunnels, remote restart, block input, privacy mode | **Yes** | `enable-*` keys | |
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

### 3.1 Modes, per computer

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

When an authorized technician presses Connect on a managed computer, the
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
  the computer and removes the standing credential; it does not add a second
  person to ordinary support (the directive's "no repetitive approvals").
- **Agent checks:** signature, `endpointId` and `rustdeskId` are its own,
  `notBefore ≤ now ≤ notAfter`, `grantId` never seen before (kept until
  expiry), mode and permissions within the computer's ceiling, no `remote`
  containment pause in its signed pause file.
- **Delivery:** a managed computer's signed agent keeps one long-poll request
  open to the portal (device secret, TLS), so a grant arrives within seconds.
  Legacy computers never open it. The portal side was built in 0.71
  (`POST /msa/agent/poll`, §3.10); the agent's poller in 0.72 (§3.11).
- **Publishing the key (0.72):** the agent trusts a grant key only when it is
  listed in `msa/grant-keys.json`, a target in the signed release metadata
  the agent already verifies. The portal never sends a key to an agent. The
  console shows a Platform Admin the exact command for the release host
  (`sudo rem0te-signed-grant-key add --key-id … --public-key …`, then
  `sudo rem0te-signed-publish --republish`); see §3.11.

### 3.3 What the agent does with a grant

1. Sets, through RustDesk's CLI as SYSTEM: `verification-method=use-permanent-password`;
   `access-mode` and `enable-keyboard / -clipboard / -file-transfer / -audio /
   -tunnel / -remote-restart` from the grant; `approve-mode=click` when consent
   is required, else `password`; `allow-auto-disconnect` with the idle limit.
2. Sets the permanent password to the grant's one-time password.
3. **Reads every value back** and reports *applied* or *enforcement failure*.
   On failure the grant is refused and the portal says so; nothing weaker is
   substituted.
4. The portal hands the one-time password to the launcher, as it hands the
   permanent password today: Select → Connect → Work is unchanged.
5. At session end, `maxMinutes`, `notAfter` without a connection, or revocation:
   sets the password to a fresh random value **no one is told**, and ends any
   open session with `stop-service Y` → `N`.

Between sessions a managed computer's password is that unknown random value,
so **an old permanent password is not a bypass.** This is the property the
directive asks to test directly.

### 3.4 Revocation

Disconnect one session, all of a technician's sessions, a business's, or a
computer's, and the `remote` containment pause, all reach the agent over the
same long-poll and end the session (step 5). **Offline:** a computer that cannot
reach the portal cannot receive a grant, so it cannot be connected to in
managed mode at all (fail closed; Legacy behaves as today). A session already
open when the network drops ends at `maxMinutes` or idle timeout, enforced by
the agent and RustDesk locally.

### 3.5 Session evidence

The agent reports: grant received, settings applied (with readback), connection
opened and closed (RustDesk's own log lines and the `--cm` process), consent
accepted or dismissed where observable, revocation applied. The console shows
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
  computer** at a time (0.72 has no group or business cutover). The legacy
  password is kept until a managed test session succeeds; only then is it
  replaced. Never automatic, never fleet-wide. **Built in 0.72** (§3.11).
- **Rollback** to Legacy is an admin action: the agent restores the previous
  RustDesk settings and the portal stages a new sealed permanent password
  through the ordinary rotation. **Built in 0.72** (§3.11).
- Nothing rotates the fleet, reinstalls RustDesk, or moves a computer by
  itself.

### 3.8 What MSA cannot do (stated in the console, too)

- Authenticate the technician inside RustDesk.
- Stop the technician's client recording.
- Prevent a local administrator from changing RustDesk settings: the agent
  re-applies and reports drift as *Enforcement failure* (Connect refused).
- Work unattended at the logon screen with consent required.
- Protect computers without the signed agent (Linux, macOS, standard agent).

A modified RustDesk client (AGPL-3.0: source must be published with every
build) would be needed for locked settings or endpoint-side recording. Not
planned unless the agent-based design proves insufficient.

### 3.9 Readiness reporting (built, 0.69)

**Readiness only — Managed Secure Access is not available yet; nothing has
changed on any computer.** The console says this above every readiness view.

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
check-in, a leftover standard heartbeat or a pooled computer. Anything that
does not parse is dropped; the heartbeat never fails for it, so an older or
newer agent is never refused. One row per computer (`RustdeskPreflight`,
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
(Overview), and *Devices → Remote access readiness*: counts per state and every
computer the viewer can see, from `GET /msa/readiness` (View computers;
`endpointVisibilityWhere`). `GET /msa/readiness/:endpointId` is the card's.

**Evidence.** The preflight ran on real Windows Server 2025 in the Windows lab
against RustDesk 1.4.1, 1.4.6, 1.4.7, 1.4.9 and 1.5.3, as the administrator and
as SYSTEM through the real `rem0te-agent.exe` from a scheduled task
(`TestLabRustdeskPreflight`). It has **not** run on a Windows 10 or 11 desktop,
with someone signed in, or on any fleet computer: reports appear only once a
computer's signed agent has updated to 0.69, through the existing automatic
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
(`required`), `maxMinutes` (60), `idleMinutes` (15). Refused: a computer the
caller cannot see (404), an unassigned one (`ENDPOINT_UNASSIGNED`), one not on
Windows or not running the signed agent (`409 MSA_SIGNED_AGENT_REQUIRED`), one
with no RustDesk ID or device secret (`409 MSA_GRANT_NO_DEVICE`), a `remote`
containment pause (`403 CONTAINED`), and a malformed body
(`400 MSA_GRANT_INVALID`). `MSA_GRANT_ISSUED` (ids, mode, consent, key id) is
written before the grant exists, and a failure to write it refuses the grant.
A newer grant cancels an older undelivered one for the same computer.

**The long-poll**, `POST /msa/agent/poll` (`rustdeskId`, `agentSecret`,
optional `ack` of up to 20 grant ids, optional `wait: false`): the device
secret is checked first, then only an assigned Windows computer whose
identity is the signed agent (§64) may poll (`403 MSA_SIGNED_AGENT_REQUIRED`
otherwise). It answers at once with the computer's undelivered grants inside
their window (at most five); with none, it holds for up to 25 s and wakes as
soon as one is issued (in process; every 5 s it also looks at the database).
One held poll per computer — a second ends the first, which then hands
nothing over (`superseded: true`) — and at most 500 in a process
(`retryAfterMs`). An `ack` marks those of its own grants still issued and in
their window *delivered*, conditionally, so a repeated ack changes nothing.
Under a `remote` pause grants are withheld (`paused: true`). An undelivered
grant past its window is marked *expired* when the computer polls or the list
is read; there is no sweep. The 0.71 agent never calls it.

**Reading:** `GET /msa/grants/endpoint/:endpointId` (View computers, the
computer in scope) lists its 50 most recent grants — state, mode,
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
update to 0.72 as they always do. On a Legacy computer — every computer, until
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

**Per-computer mode** (`MsaManagedComputer`, migration 0089; no row is
Legacy): `pending` → `verified`, or `enforcement_failure`, or
`rollback_pending` → row deleted. Only `MsaManagedService` writes it.
Readiness shows *Managed (pending)*, *Managed and verified* (only while the
agent's last full readback is inside the report window) and *Enforcement
failure* from this row and the agent's reports, never from a saved setting.

**Cutover**, `POST /msa/managed/:endpointId/cutover`: Platform Admin, a fresh
confirmation when `msa.cutover` asks, one computer in scope. Refused when the
computer is unassigned, not the signed Windows agent, not *Compatible*,
running an agent older than 0.72 (`MSA_AGENT_TOO_OLD`), under a `remote`
pause, already managed, or when the grant key is not in the published
release. Audited (`MSA_CUTOVER`) before the row is written. The next
heartbeat says `msaPoll: true`, and the signed heartbeat starts
`rem0te-agent.exe msa-poller` as SYSTEM.

**The poller** (`internal/msa/enforce`, wired in `msa_poller_windows.go`)
holds the long-poll with the device secret and, on each answer: exits for
Legacy; for each grant verifies it under the published keys, this computer's
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
password are refused (`409 MSA_MANAGED` / `msa_managed`). Because technician
Connect through grants is step 5, **a verified computer can be reached only
through Platform Admin test grants until step 5 ships**; roll it back to
connect the ordinary way.

**Rollback**, `POST /msa/managed/:endpointId/rollback`: Platform Admin, never
asks for a fresh confirmation, audited. It cancels undelivered grants and
stages a fresh sealed permanent password through the existing rotation path;
the agent ends any session, restores the saved settings, reads them back and
reports `restored` (the row is deleted) or `restore_failed`. **Finish
rollback without the agent** (`force: true`) is only for a computer already
rolling back whose agent is gone. Rollback needs the switch on: turning
`MSA_GRANTS` off with a verified computer stops its poller but still refuses
its legacy password (fail closed) — roll back first.

**Not in 0.72 (step 5):** Connect issuing grants for technicians, `control`
mode or any permission above the view-only ceiling, group or business
cutover, revocation and the session evidence timeline, a console switch for
`MSA_GRANTS`.

**Evidence.** `apps/api/scripts/e2e-msa-managed.mjs` (port 3961),
`unit-msa-managed.mjs`, `unit-msa-readiness.mjs`, the Go
`internal/msa/enforce` tests (a fake RustDesk), check-security-invariants
§82, and the Windows lab's `TestLabRustdeskEnforce` (save, apply, readback,
password, end session, restore — as the administrator and as SYSTEM, RustDesk
1.4.1–1.5.3). The lab runs the agent's enforcement code against real
RustDesk, but not the portal, the long-poll or a real remote connection.

## 4. Build order (each a reviewable PR, none deployed without approval)

1. **Lab proof** on GitHub's `windows-latest`: install RustDesk, run the signed
   agent's `--option` / `--password` / readback / `stop-service` path as SYSTEM
   against RustDesk 1.2.x, 1.3.x, 1.4.6 and 1.4.7+. Go/no-go for everything
   below. **Done in 0.68.3** for 1.4.1–1.5.3 (go); 1.3.9 and older untested.
2. **Capability reporting and modes** (read-only): the agent reports RustDesk
   version, build and preflight; the console shows each computer's mode.
   **Built in 0.69** (§3.9).
3. **Grants and the long-poll channel**, behind a feature flag, off.
   **Built in 0.71, behind `MSA_GRANTS`, off** (§3.10): the portal side and a
   pure Go verifier no command imports. Publishing the grant key in the
   signed release metadata is step 4.
4. **Agent enforcement** (signed agent release), managed test session, cutover
   and rollback. **Built in 0.72, behind `MSA_GRANTS`, off** (§3.11): one
   computer at a time, view-only, grant keys in the signed release.
5. **Revocation, session evidence**, console controls.
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
  the new API.
- Lab jobs on `windows-latest` for the real-Windows paths, including RustDesk.
- Each release's notes carry the matrix: versions tested, at which evidence
  level, and what was not tested.
