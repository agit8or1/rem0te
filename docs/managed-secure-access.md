# Managed Secure Access (MSA) — audit and design

**Status: design.** Nothing on this page is built yet, and nothing on it is
turned on for any computer. Every computer stays in today's mode (*Legacy*)
until a Platform Admin moves it, one computer or group at a time, after it
passes a preflight. RustDesk stays the remote desktop; the technician still
selects a computer and presses **Connect**.

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

**Unverified on Windows:** whether `--option` / `--password` run by the signed
agent from session 0 pass RustDesk 1.4.7+'s tightened local-pipe check. This is
the first thing the lab must prove (Phase 1a, below); MSA does not proceed
without it.

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
  Legacy computers never open it.

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
  Upgrade available / Unsupported.
- **Cutover** needs a Platform Admin (fresh sign-in), one computer, a group or
  a business at a time, canary first. The legacy password is kept until a
  managed test session succeeds; only then is it replaced. Never automatic,
  never fleet-wide by default.
- **Rollback** to Legacy is an admin action: the agent sets a new sealed
  permanent password and restores the previous RustDesk settings.
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

## 4. Build order (each a reviewable PR, none deployed without approval)

1. **Lab proof** on GitHub's `windows-latest`: install RustDesk, run the signed
   agent's `--option` / `--password` / readback / `stop-service` path as SYSTEM
   against RustDesk 1.2.x, 1.3.x, 1.4.6 and 1.4.7+. Go/no-go for everything
   below.
2. **Capability reporting and modes** (read-only): the agent reports RustDesk
   version, build and preflight; the console shows each computer's mode.
3. **Grants and the long-poll channel**, behind a feature flag, off.
4. **Agent enforcement** (signed agent release), managed test session, cutover
   and rollback.
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
