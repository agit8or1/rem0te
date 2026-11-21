# Session controls, maintenance, MDM and backup: audit (0.76.1)

This page audits the owner's four-phase directive of 2026-11-21 (remote session controls, endpoint maintenance,
MDM, and backup with verified recovery) against Rem0te **0.75.1** (main `a68d269`), then puts the work in order.
It is a planning record. It adds no feature, and nothing on it is a promise that something works.

Every claim about Rem0te was checked against source, migrations and tests. Every claim about RustDesk names the
function in RustDesk's own source (client **1.5.3**, with **1.4.4** where it matters) or a page of RustDesk's
documentation. Provider claims cite the provider's public documentation. Nothing here called a real provider,
vendor or RustDesk server.

It continues [rmm-expansion-audit.md](rmm-expansion-audit.md) (0.73.2), which covers PowerShell, the script
library, bulk runs and backup *monitoring*. Where the two overlap, this page points there rather than repeating
it. Owner decisions continue that page's numbering: its seven are **decisions 1–7** (listed under
[Owner decisions](#owner-decisions)), and this page adds **8–20**.

> **Owner decisions, 2026-11-21.** A background terminal (cmd and PowerShell) and background file transfer ship,
> with no screen-sharing session. Opening a terminal asks for a fresh confirmation through a new key,
> `terminal.open`, which defaults to **ask**. The first terminal runs as SYSTEM, shown as such; run-as-user and
> least privilege are planned. This settles decisions 4, 11, 14 and 14a. Both are first in the roadmap and in
> progress on separate branches: **0.77.0 *Conduit*** (terminal) and **0.78.0 *Courier*** (file transfer).

> **Read this first: finding F1.** A Managed Secure Access *control* grant does not enforce what it says.
> RustDesk's Flutter builds treat `access-mode=full` as "every permission on", ignoring each `enable-*` key, and
> the agent sets `access-mode=full` for every control grant. So on a Managed computer in control mode, clipboard
> off, file transfer off, **no TCP tunnel and no remote restart are not enforced**, and RustDesk's terminal,
> camera, remote printer, block-input, privacy-mode and recording permissions are on. View-only grants are not
> affected. All of it is behind `MSA_GRANTS`, which is off on every production server, so no live computer is
> exposed. Details and the fix are under [F1](#f1-a-control-grant-turns-every-permission-on); it is the first
> pull request of Phase 1.

## How to read this page

**Capability state** uses exactly four words, as the directive asks:

| State | Meaning |
|---|---|
| **available** | Built, on by default or reachable through ordinary settings, and enforced by the component named. Says nothing about evidence; see the Evidence column |
| **requires setup** | Built, but works only after configuration someone has to do: an environment switch (`MSA_GRANTS`), the approval signer, a provider account, a computer moved to Managed |
| **unsupported** | Nothing in Rem0te, RustDesk or the OS can enforce it in that combination today. Building more Rem0te code would not change that without a different component |
| **planned** | Not built. Can be built with components Rem0te controls. Listed in the roadmap below |

**Enforcing component** is the one that actually refuses or ends something: *portal* (the API), *signed agent*,
*RustDesk (controlled side)*, *RustDesk (technician's client)*, *hbbs/hbbr*, *OS*, *external provider*, or
*nothing*. A setting the portal saves but nothing on the computer applies is enforced by *nothing*.

**Evidence** is the strongest level that exists, on the ladder in [readiness.md](readiness.md#evidence-levels):
**Lab** (GitHub's `windows-latest`, Windows Server 2025, never a desktop) > **Fleet** (the four production
computers, observed) > **Sim** (the agent's real code against simulated Windows) > **API** (real API against a
stand-in device or peer) > **Unit**. *Wire fixture* is 0.73.1's recorded request bodies. *Source* means RustDesk's
source was read and nothing was run. Simulation is never real-Windows evidence.

**Session modes** referred to below:

| Mode | What it is |
|---|---|
| **Legacy** | Today's Connect on every production computer: the sealed permanent password, portal-only authorization ([managed-secure-access.md](managed-secure-access.md) §3.1) |
| **Managed view** | A Managed Secure Access grant in view mode (`access-mode=view`) |
| **Managed control** | A grant in control mode (`control` and `unattended` launches) |
| **Quick Connect** | A one-off RustDesk session to an unenrolled computer; nothing installed |

## RustDesk: what the controlled side can enforce

Checked against RustDesk 1.5.3 source (`src/server/connection.rs`, `src/common.rs`, `src/ui_cm_interface.rs`,
`src/server/terminal_service.rs`, `hbb_common/src/config.rs`) and 1.4.4's `connection.rs`, and
[RustDesk's advanced-settings documentation](https://rustdesk.com/docs/en/self-host/client-configuration/advanced-settings/).
"Settable by the agent" means `rustdesk.exe --option <key> <value>` run as SYSTEM, the path the lab proved for
RustDesk 1.4.1–1.5.3 ([lab-testing.md](lab-testing.md)).

| Question | Answer | Where in RustDesk | Settable by the agent? |
|---|---|---|---|
| Clipboard on or off | **Yes**, both directions together | `enable-clipboard`; `Connection::clipboard_enabled()` gates both receiving the technician's clipboard and sending this side's | Yes |
| Clipboard **per direction** | **Only "controlled → technician" can be turned off**, and only in a custom client | `one-way-clipboard-redirection` is read with `get_builtin_option`; `can_sub_clipboard_service()` stops this side's clipboard going out, while incoming clipboard is still applied. Documented as ">=1.3.1, controlled side" | **No.** Built-in settings are filled only by `read_custom_client`, from a config verified against RustDesk's own signing key (RustDesk Server Pro's custom-client generator). `--option` writes ordinary settings, not built-in ones |
| Technician → endpoint blocked, endpoint → technician allowed | **No** | Nothing | — |
| Text clipboard separate from **file** clipboard | **Partly.** File copy-paste needs both `enable-clipboard` and `enable-file-transfer` (`can_sub_file_clipboard_service`, and the `is_file_data_request` path). So "text yes, files no" is possible only by turning file transfer off entirely | `connection.rs` | Yes (as file transfer off) |
| File clipboard off while file transfer stays on | **No** on the controlled side. `enable-file-copy-paste` is a **technician-client** session toggle (`client.rs`, `ui_session_interface.rs`) | — | — |
| File transfer on or off | **Yes**, both directions together | `enable-file-transfer`; a file-transfer login without it is refused | Yes |
| Upload separate from download | **Only "upload only"**, and only in a custom client | `one-way-file-transfer` (built-in): refuses `Send` (controlled → technician), and remove, rename, create and remove-dir, and stops serving this side's clipboard files. Documented as ">=1.3.1" | **No** (built-in, as above) |
| Download only (no upload) | **No** | Nothing refuses `Receive` on its own | — |
| Size limits | **No byte limit.** A file-**count** limit exists | `file-transfer-max-files` (built-in, default unlimited; `ui_cm_interface.rs`) | **No** (built-in) |
| Per-direction or per-transfer approval | **No.** Consent (`approve-mode=click`) is per connection; with `enable-perm-change-in-accept-window` the person at the computer can toggle permissions in the accept window | `ui_cm_interface.rs` | Consent: yes |
| File transfer audit (actor, direction, name, size) | **Only to an API server.** `post_file_audit` sends direction (`RemoteSend` / `RemoteReceive`), the path, the ten largest file names and sizes and a count, when a job starts, never its outcome. It goes to `api-server`'s `/api/audit/file` | `connection.rs` `post_file_audit`; `common.rs` `get_audit_server` | Rem0te implements no API server, and the installer sets `api-server = ''` (`common/rustdesk.service.ts`) |
| Elevation ("Request elevation") | **Not for an installed RustDesk.** `handle_elevation_request` answers "No need to elevate" when RustDesk is installed; it starts the portable service only for a portable copy, after the person at the computer accepts UAC. An installed RustDesk runs as a SYSTEM service and already shows the secure desktop, so UAC prompts are visible and clickable in the session: the technician acts as the signed-in user, and passes UAC by consent (if that user is an administrator) or by typing an administrator's credentials | `connection.rs` | — |
| Terminal | **Present since 1.4.1**, `enable-terminal`, **default on** (`option2bool`: any `enable-*` key that is not `N`). On Windows the shell runs as the console user; if the technician types a local or domain **administrator's** credentials, it runs as the RustDesk service's own token, **SYSTEM** (`fill_terminal_user_token`, `handle_administrator_check`). Refused at the logon screen. Terminal sessions can be **persistent** and survive a disconnect (up to an hour idle, `SERVICE_IDLE_TIMEOUT`) | `connection.rs`, `terminal_service.rs`; [1.4.1 release coverage](https://linuxiac.com/rustdesk-1-4-1-remote-desktop-adds-terminal-and-stylus-support/) | Yes (`enable-terminal`), but the agent does not set it today |
| Hard session termination | **Yes, for every session on the computer at once**: `--option stop-service Y`, then `N`. There is no CLI to end one connection | `config.rs`; proven in the lab ([managed-secure-access.md](managed-secure-access.md) §2) | Yes |
| Maximum session length | **No.** Only an **idle** disconnect (`allow-auto-disconnect`, `auto-disconnect-timeout`) | Documented as inactivity, not length | Idle: yes |
| `access-mode` | `view` turns **every** permission off; `full` turns **every** permission on; anything else (`custom`, the default) reads each `enable-*` key | `Connection::is_permission_enabled_locally` (1.5.3), `Connection::permission` (1.4.4), under `feature = "flutter"`; the Flutter settings page shows the same three choices | Yes |

What Rem0te controls today, per mode:

| Control | Legacy | Managed view | Managed control | Quick Connect |
|---|---|---|---|---|
| Clipboard | Nothing sets it: RustDesk default (on). Business and preset policy `clipboard: off \| request` is saved and enforced by **nothing** (`security-features.ts`, `clipboard`: *unavailable*) | Off (`access-mode=view`) | **Intended** per policy (`connect-terms.ts`); **not enforced** (F1) | RustDesk default |
| File transfer | As clipboard | Off | **Intended** per policy; **not enforced** (F1) | RustDesk default |
| Terminal, camera, remote printer | On (RustDesk default) | Off | **On** (F1) | RustDesk default |
| TCP tunnel, remote restart | On (RustDesk default) | Off | **On**, despite `enable-tunnel=N` and `enable-remote-restart=N` being written and read back (F1) | RustDesk default |
| Consent | Refused for preset technicians (`endpoint_cannot_enforce_consent`) | `approve-mode=click` when required | Same | Person at the computer accepts |
| Session length | Advisory (`security-features.ts`, `session-length`) | Agent ends it at `maxMinutes` (`stop-service`) | Same | Nothing |
| Ending a session from the console | Not possible | Signed revocation → agent `stop-service` (§83) | Same | Not possible |
| Reconnect resetting the timer | — | Impossible: the grant is single-use (replay set), and the password is replaced by one nobody is told when the session ends | Same | — |

### F1: a control grant turns every permission on

- **What the agent sets.** `Desired()` in `tools/windows-installer/internal/msa/enforce/enforce.go` sets
  `access-mode` to `full` for a control grant, then `enable-clipboard`, `enable-file-transfer`, `enable-audio`
  from the grant and `enable-tunnel=N`, `enable-remote-restart=N`. `args.go` accepts only `view` and `full` for
  `access-mode`.
- **What RustDesk does with it.** In Flutter builds (every official Windows build), `access-mode=full` makes
  `is_permission_enabled_locally` return true for **every** `enable-*` key before looking at the key. The Flutter
  settings page says the same: *Full Access* greys out every checkbox as ticked. So the clipboard, file-transfer,
  tunnel and restart keys are written and read back correctly, and ignored.
- **What else is on.** The agent never writes `enable-terminal`, `enable-camera`, `enable-remote-printer`,
  `enable-block-input`, `enable-privacy-mode` or `enable-record-session`. Under `full` they are all on, so a
  managed control session can open RustDesk's terminal, as SYSTEM with an administrator's password.
- **Why the lab did not catch it.** `TestLabRustdeskEnforce` (`lab_enforce_windows_test.go`) proves that values
  are written and read back. It never connects, so it cannot see what RustDesk does with them.
- **Who is exposed.** Nobody in production: `MSA_GRANTS` is off, and no computer is Managed. View-only grants are
  correct (`view` turns everything off).
- **The fix**, Phase 1's first pull request:
  1. Write `access-mode=custom` for control (documented value; anything but `full`/`view` reads the keys).
  2. Write `enable-terminal`, `enable-camera`, `enable-remote-printer`, `enable-block-input`,
     `enable-privacy-mode` and `enable-record-session` as `N` on every grant, and read them back.
  3. Add a Go test that no desired map ever holds `access-mode=full`.
  4. Give the lab a behavioural check, not only a readback.

  It is a new signed agent build, inside the existing ceiling, so it reverses nothing.
- **Docs that overstate it until then.** [managed-secure-access.md](managed-secure-access.md) §3.12 ("never a
  TCP tunnel or a remote restart") now carries a note pointing here.

### What has to be blocked when a tenant requires a control

When a business's policy asks for something the session mode cannot enforce, the launch is refused rather than
opened weaker. Rem0te already does this for view-only and consent (`endpoint_cannot_enforce_view_only`,
`endpoint_cannot_enforce_consent`). Applied to the directive:

| Tenant requires | Legacy | Managed view | Managed control (after F1) | Quick Connect |
|---|---|---|---|---|
| Clipboard disabled | **Block** | Allowed | Allowed | **Block** |
| Clipboard technician → endpoint only | **Block** | Allowed (stricter: none) | **Block**, or clipboard off (decision 9) | **Block** |
| Clipboard endpoint → technician only | **Block** | Allowed (stricter) | **Block**, or clipboard off (decision 9) | **Block** |
| Text clipboard without file clipboard | **Block** | Allowed | Allowed only with file transfer off | **Block** |
| File transfer disabled | **Block** | Allowed | Allowed | **Block** |
| Upload only, or download only | **Block** | Allowed (stricter) | **Block**, or file transfer off (decision 9) | **Block** |
| A size limit | **Block** | Allowed | **Block**, or file transfer off | **Block** |
| Maximum session length enforced | **Block** | Allowed | Allowed | **Block** |
| Hard termination available | **Block** | Allowed | Allowed | **Block** |
| No terminal | **Block** | Allowed | Allowed | **Block** |

Today only the consent and view-only rows are enforced this way, and only for preset technicians. Legacy launches
for members and Platform Admins apply none of it ([security-model.md](security-model.md)).

## Phase 1: remote session controls

### 1. Clipboard

| Sub-item | Today | Enforcing component | State | Platforms, versions | Evidence |
|---|---|---|---|---|---|
| Per-tenant policy | `AccessPolicy.controls.clipboard` (`off` \| `request`), platform and business, merged most-restrictive (`presets.ts` `mergeControls`) | Portal saves it; **nothing** applies it on Legacy | **available** as a setting; enforced only in Managed | — | API (`e2e-presets.mjs`) |
| Per-role policy | Preset `clipboard: off \| allowed` (L1–L3, `presets.ts`) | As above | **available** as a setting | — | API |
| Per-session-mode policy | None. One value covers every mode | — | **planned** | — | None |
| Disabled | Managed view: off. Managed control: intended, not enforced (F1) | RustDesk (controlled side), set by the signed agent | **requires setup** (Managed view); **planned** (Managed control, F1); **unsupported** on Legacy and Quick Connect | Windows, signed agent ≥ 0.73.0, RustDesk 1.4.1–1.5.3 Flutter | Lab (readback only, Server) |
| Technician → endpoint only | — | Nothing | **unsupported** (stock RustDesk). A custom client cannot do it either | — | Source |
| Endpoint → technician only | — | Custom client only (`one-way-clipboard-redirection`, ≥ 1.3.1) | **unsupported** with the RustDesk Rem0te installs (decision 10) | — | Source; RustDesk docs |
| Bidirectional | Managed control with `clipboard: request` (after F1); Legacy by default | RustDesk | **requires setup** (Managed); Legacy: on, uncontrolled | As above | Lab (readback) |
| Effective policy visible to technicians | Settings → Security features lists clipboard as *unavailable*; the Connect dialog does not show what a session will allow | Portal | **planned** | — | None |
| Enforced by transport or endpoint | Endpoint (RustDesk settings applied by the agent), Managed only | Signed agent + RustDesk | **requires setup** (after F1) | As above | Lab (readback) |
| Text vs file clipboard | File clipboard needs file transfer on; no separate switch on the controlled side | RustDesk | **unsupported** as a separate control; "text only" = file transfer off | — | Source |
| Audit policy changes | `POLICY_*` audit on access-policy and preset changes (`policy-admin.service.ts`) | Portal | **available** | — | API |
| Audit blocked attempts where observable | RustDesk does not tell the controlled side's agent about a refused clipboard event | Nothing | **unsupported** | — | Source |
| Contents never logged or recorded | Rem0te never sees clipboard contents | — | **available** (nothing to log) | — | Static |

### 2. File transfer

| Sub-item | Today | Enforcing component | State | Platforms, versions | Evidence |
|---|---|---|---|---|---|
| Upload and download permissions, separate | One `fileTransfer: off \| request` | RustDesk: one switch; signed agent for background transfer | **unsupported** in RustDesk sessions. **In progress** as background transfer (0.78.0 *Courier*, decided: decision 11) | — | Source |
| Default disabled | Platform default `fileTransfer: 'off'` (`presets.ts`) | Portal, as a setting | **available** as a setting; enforced only on Managed after F1 | — | API |
| Per-direction approval | — | Nothing in RustDesk | **unsupported** in sessions; separate upload and download permissions in *Courier* (in progress); per-transfer approval **planned** | — | Source |
| Size limits | — | Nothing in RustDesk (only a built-in file count) | **unsupported** in sessions; **in progress** for background transfer (*Courier*) | — | Source |
| Tenant file restrictions (types, paths) | — | Nothing in RustDesk | **unsupported** in sessions; **planned** in Design B (quarantine, B3) | — | Source |
| Show direction, progress, cancel, failure | RustDesk's own windows show them on both sides; Rem0te shows nothing | RustDesk | **available** in RustDesk; **unsupported** in the console | Any | None |
| Audit actor, endpoint, direction, filename, size, outcome | Not observable by the agent. RustDesk's API-server hook would give direction, names and sizes at start, never the outcome | Nothing today; portal for background transfer | **unsupported** in RustDesk sessions (outcome); **in progress** for background transfer (*Courier*) | — | Source |
| Tenant-scoped access to that audit | Audit chain reads are scoped today (`audit-log`) | Portal | **available** for what is recorded | — | API |
| Every transfer path honours policy | Paths into a computer during a session: file-transfer window, file clipboard, terminal (`type`/`copy con`), tunnel, remote printer. Under F1 none is closed in Managed control | RustDesk | **planned** (F1 closes file transfer, file clipboard, terminal, tunnel and printer together) | — | Source |
| Mark unsupported combinations and block the mode | Not done | Portal | **planned** (Phase 1, PR 1.3) | — | None |

### 3. Session elevation

| Sub-item | Today | Enforcing component | State | Platforms, versions | Evidence |
|---|---|---|---|---|---|
| Time-limited, session-scoped elevation | `TemporaryAccessRequest` mode `ELEVATION` exists and is always refused (`temporary-access.service.ts`, `elevation_unavailable`). Launch mode `elevated` refused everywhere | Portal (refuses) | **unsupported** today; **planned** only after decision 13 | — | API (`e2e-presets.mjs`) |
| Supported OS mechanism | Windows offers UAC prompts on the secure desktop (visible through an installed RustDesk); a separate local administrator account; or a third-party privilege manager such as Microsoft's Endpoint Privilege Management. Rem0te uses none | OS | **planned** (decision 13) | Windows | None |
| Distinct permission and reason | Preset `elevation: off \| request`; a reason on every temporary request | Portal | **available** as a setting (it grants nothing) | — | API |
| Customer consent or supervisor approval per tenant | Temporary requests need an approver who is not the requester; `attendedConsent` per business | Portal | **available** for the request; nothing to approve into | — | API |
| Record request, approval, start, expiry, revocation | Temporary access is audited (request, decision, activation) | Portal | **available** for the request | — | API |
| Enforce expiry and revocation at endpoint or transport | — | Would be the signed agent (Managed grant channel) | **planned** | Windows | None |
| Credentials never in chat, output, logs, recordings | No elevation credential exists. MSA passwords are sealed, never logged (§81–§83) | Portal, agent | **planned** for elevation; the MSA rule is the model | — | API (MSA) |
| Support per platform and connection mode | Windows only; Linux and macOS agents act on nothing (§24, §32) | — | **unsupported** on Linux, macOS, Legacy and Quick Connect | — | — |
| Show when an OS prompt needs local interaction | Not shown. A UAC prompt needs either the signed-in user's consent (if an admin) or typed admin credentials; RustDesk's terminal refuses at the logon screen | Portal (display) | **planned** | — | None |
| **The ungoverned path that exists now** | RustDesk's terminal runs as SYSTEM when given an administrator's credentials, on Legacy computers and in Managed control (F1) | Nothing | **unsupported** to govern; F1 closes it on Managed; decision 8 for Legacy | RustDesk ≥ 1.4.1 | Source |

### 4. Maximum session length

| Sub-item | Today | Enforcing component | State | Platforms, versions | Evidence |
|---|---|---|---|---|---|
| Enforced by the component controlling the live connection | Managed: the agent ends the session at `maxMinutes` with `stop-service` (`enforce/poller.go`, outcome `max_minutes`). Legacy: advisory | Signed agent + RustDesk | **requires setup** (Managed); **unsupported** (Legacy, Quick Connect) | Windows, agent ≥ 0.73.0, RustDesk 1.4.1–1.5.3 | Lab (`stop-service` ends sessions, Server); Unit (timer) |
| Show expiry and warning countdown | The grant's `maxMinutes` is shown in the session timeline; no countdown, no warning on either side | Portal / tray | **planned** | — | None |
| Terminate at expiry | As above | Signed agent | **requires setup** | As above | Lab (termination); not with a real connection |
| Fresh authorization for a new session | Every Managed Connect is a new grant through `authorizeConnect` (§83) | Portal + agent (single-use grant) | **requires setup** | As above | API |
| Refresh, reconnect or switching clients cannot reset the timer | Grant ids are single-use (persisted replay set); the session's password is replaced when it ends; the timer starts at `applied` | Signed agent | **requires setup** | As above | Unit (Go replay); API |
| Show which modes support hard termination | Not shown in the console | Portal (display) | **planned** | — | None |
| Caveat | `stop-service` ends **every** session on the computer, including another technician's Legacy session. RustDesk's persistent terminal may outlive the connection; whether `stop-service` ends its helper is **unverified** | — | — | — | Source |

### 5. Customer chat

**Item 5 is largely built** (0.34–0.51, §45, §55; [chat.md](chat.md), [tray.md](tray.md)). The gaps are
retention as a per-business period, a transcript-reading permission, binding a chat to a remote session, and chat
without an agent.

| Sub-item | Today | Enforcing component | State | Platforms, versions | Evidence |
|---|---|---|---|---|---|
| Real-time technician ↔ customer chat | Chat tab ↔ tray window (`/assist`), long-poll | Portal + signed or standard agent's tray | **available** | Windows, tray from 0.36 (both agents); not Linux/macOS (decision 0.36.1) | Fleet (2 conversations, 5 messages, observed); API (`e2e-chat.mjs`); Unit (Go tray) |
| For an authorized session | Chat is per computer, needs `support:chat`, not tied to a remote session | Portal | **planned** (link to an MSA session id) | — | — |
| For a support request | `supportRequestId` link on start (needs `support:requests`) | Portal | **available** | Windows | API |
| Customer-visible identity | The tray banner names the technician (first and last name) and business, from the portal | Portal + tray | **available** | Windows | API, browser (`e2e-ui.mjs`) |
| Notification | Tray badge; console inbox and toast | Tray, portal | **available** | Windows | API; tray never on a real desktop |
| Delivery state | Sent → Delivered → Read (agent receipts only) | Agent | **available** | Windows | API |
| End chat | Both sides; **End chat** asks once more | Portal + tray | **available** | Windows | API |
| Tenant-scoped | `endpointVisibilityWhere` on every route (§45) | Portal | **available** | — | API |
| Retention as a tenant setting | On/off per business (`CHAT_RECORDING_CHANGED`, owner or Platform Admin, `assertFresh`). The **period** is one platform value (`CHAT_RETENTION_DAYS`, 400, 30–3650) | Portal | **available** (on/off); **planned** (period per business) | — | API |
| Disclosed to participants | Both sides show whether the chat is recorded, frozen at start | Portal + tray | **available** (recorded or not); **planned** (the period) | — | API |
| Access restricted | Anyone who can see the computer reads the transcript (`computers:view`) | Portal | **planned** (a `chat:transcripts` capability) | — | API |
| Retention off: bodies out of persistent logs and telemetry; basic audit stays | Unrecorded messages deleted once both sides have them; audit meta never holds text (§45) | Portal | **available** | — | API (`e2e-chat.mjs`, `e2e-tray.mjs`) |
| Chat without an agent (support-link customers) | None. `/assist` is reachable only through the tray's one-time code | — | **planned** only after decision 15 | — | — |

## Phase 2: endpoint maintenance

### 6. Background terminal and PowerShell

**Decided by the owner, 2026-11-21:** *"we still need to be able to run background dos/powershell/xfer files.
maybe 2fa for dos/powershell"*. This settles decision 4 (the 0.73.2 audit's conflict 6) and decisions 11 and 14
below. Recorded:

- **A background terminal ships**: `cmd` and Windows PowerShell on enrolled computers, with no screen-sharing
  session.
- **Background file transfer ships**, to and from a computer, also with no screen-sharing session.
- **Opening a terminal asks for a fresh confirmation** through a new §62 catalog key, `terminal.open`, separate
  from file transfer. It defaults to **ask** (decision 14a; the owner said "ok, go" to that recommendation on
  2026-11-21). File transfer has its own key, `files.transfer`, defaulting to `off`.
- **The first terminal runs the shell as SYSTEM, shown as such.** Run-as-user and a least-privilege identity
  are planned (owner, 2026-11-21).

In progress on a separate branch: **0.77.0 *Conduit*** (the background terminal) and **0.78.0 *Courier***
(background file transfer, with separate upload and download permissions).

Nothing is on `main` yet. RustDesk's own terminal (1.4.1+) is also a background shell, but it cannot give least
privilege, cannot be bounded or audited by Rem0te, and is open on Legacy computers to anyone with the permanent
password. So the decision is met by a **native agent terminal** ([its design](#the-terminal-and-file-transfer-design)),
and RustDesk's terminal is closed wherever Rem0te sets RustDesk's options (F1).

| Sub-item | Today | Enforcing component (when built) | State | Evidence |
|---|---|---|---|---|
| No screen-sharing session needed | RustDesk terminal (ungoverned); Rem0te: read-only diagnostics palette (0.76.0, #187) and signed scripts | Signed agent | **in progress** (0.77.0 *Conduit*) | Source (RustDesk) |
| Windows PowerShell first; `cmd` too | Scripts run System32 Windows PowerShell 5.1 as SYSTEM (§39) | Signed agent: System32 `powershell.exe` or `cmd.exe`, fixed paths | **in progress** (0.77.0 *Conduit*) | Lab (scripts, 5.1, admin) |
| Terminal-specific permission | — | Portal: a new capability, `computers:terminal` | **in progress** (0.77.0 *Conduit*) | — |
| Explicit request, reason, short-lived authorization bound to one endpoint | The MSA grant is the model (one computer, five-minute start window, single use) | Portal signs; agent verifies | **in progress** (0.77.0 *Conduit*) | — |
| Fresh confirmation (the owner's "2FA") | §62 catalog, 49 keys, every one default `off` since 0.64 | Portal (`assertFresh('terminal.open')`) | **in progress** (0.77.0 *Conduit*); default `ask` (decision 14a, decided) | — |
| Tenant rules: unattended access, consent, approval | `unattendedAccess`, `attendedConsent` exist for remote sessions | Portal | **in progress** (0.77.0 *Conduit*); consent is a later step | — |
| Least privilege by default; elevation through item 3 | RustDesk terminal: console user or SYSTEM, nothing between | Signed agent (the token it starts the shell with) | **in progress** as SYSTEM, shown as such (0.77.0 *Conduit*, decided); run-as-user and least privilege **planned** | — |
| Show operating identity, connection state, timeout, cancel | — | Portal + agent | **in progress** (0.77.0 *Conduit*) | — |
| Audit access and termination | — | Portal (`TERMINAL_OPENED` with `logOrFail` before the grant, `TERMINAL_CLOSED` with the reason) | **in progress** (0.77.0 *Conduit*) | — |
| History and output under tenant policy, restricted | Script output: 64 KB a stream, redacted twice, 90-day prune (§39) | Portal | **planned**: a per-business setting after *Conduit* | — |
| What happens to processes on expiry or disconnect | RustDesk keeps persistent terminal sessions up to an hour idle after a disconnect, unverified on Windows. Scripts: job object killed at the timeout | Signed agent: a job object with kill-on-close | **in progress** (0.77.0 *Conduit*, to be proven in the lab) | Lab (scripts only) |

### 7. Scripts, fixes and patches

Most of this is the previous audit's P0 sequence. The rows below say where each sub-item lives; the new gaps
are rollback notes, retries for repeatable actions, and concurrency.

| Sub-item | Today | Enforcing component | State | Evidence |
|---|---|---|---|---|
| Reviewed, versioned library bound to the exact approved revision and scope | `ScriptVersion` content hash on the signer's allowlist; plans bind the hash (§39); catalog actions closed (§14) | Approval signer + signed agent | **requires setup** (signer) | Lab (exec); Sim |
| Inputs validated by schema | Typed parameters, same charsets in TS and Go (§39, §40, §61) | Portal, signer, agent | **requires setup** | Unit, Sim |
| Inventory and applicability checks | Software: from inventory; patching: from the signed scan; service and process: from the latest snapshot (§61) | Portal | **available** | Fleet (inventory) |
| Target preview | `POST /automation/schedules/preview`; none before bulk | Portal | **requires setup** (automation); **planned** elsewhere (rmm-expansion-audit P0 #5) | API |
| Pilot rings | Canary optional (§75); rings ≤ 25 | Signer | **requires setup** | Sim |
| Maintenance windows | Patch and automation windows (§66, §71), restart windows (§73) | Signer | **requires setup** | Sim |
| Concurrency limits | One open run per computer; none per business | — | **planned** (P0 #5) | — |
| Reboot policy | `never` / `if_required_in_window` (§37), restart windows (§73) | Signer + agent | **requires setup** | Sim |
| Confirmation for broad rollouts | Two passkey approvers (signed mode) or one fresh sign-in (direct); bulk ≤ 200 (§35) | Signer, portal | **requires setup** | Sim |
| Cancellation | Before delivery only (`POST /actions/:id/cancel`) | Portal | **available** (undelivered); **planned** (running, conflict 3 → decision 2) | Sim |
| Per-device results | `ActionTarget` per computer, `GET /tasks` (§65) | Portal | **available** | API, Sim |
| Exit codes, timeouts | Script runs: exit code, duration, `TIMEOUT_MINUTES` [1,5,10,15,30] | Agent | **requires setup** | Lab |
| Offline behaviour | `notAfter` on every plan; automation `run_when_online` | Signer + agent | **requires setup** | Sim |
| Bounded retries for safe-to-repeat actions | Signer retry limits exist (`ring_retry_limit`, `restart_retry_limit`); nothing retries automatically, and no action is marked safe to repeat | — | **planned** | Sim (limits) |
| Duplicate-job protection | One open plan per computer; `ring_already_signed`; automation "no overlap" (§71) | Portal, signer | **requires setup** | Sim |
| Post-execution state verification | Software `effective`, patch confirmed by a later scan, service control reads back | Agent, portal | **requires setup** | Sim; Lab (service control) |
| Rollback documented per action | Not documented per action | Docs | **planned** | — |
| Partial failures shown | Per-target states and the agent's `outcome` (`restart_required`, `partial`) (`tasks/lifecycle.ts`) | Portal | **available** | API |
| Recurring execution only through approved catalog actions and tenant scope | Automation schedules (§71): signer-approved document, business or group scope, approved scripts or catalog software only | Signer | **requires setup** | Sim |

## Phase 3: MDM (iOS/iPadOS and Android)

Nothing is built. Rem0te only *detects* Intune as a Windows patch manager (`managed_elsewhere`). Every sub-item of
item 8 is **planned**, and every one needs an external provider. The evaluation below is what has to happen first.

### Provider options

| | Native Apple MDM | Android Management API | Third-party MDM API (for example Microsoft Intune through Graph) |
|---|---|---|---|
| What Rem0te would be | The MDM server itself: check-in and command endpoints, device identity certificates, declarative management | An EMM: Google holds the device channel, Rem0te holds policies and reads state | A reader and command relay over the customer's existing MDM |
| Prerequisites | An **MDM Vendor CSR Signing Certificate**, requested from Apple by the Account Holder of an Apple Developer Program or Enterprise Program account ([Apple](https://developer.apple.com/help/account/certificates/mdm-vendor-csr-signing-certificate)); per customer, an **APNs MDM push certificate** from the Apple Push Certificates Portal, renewed every year with the same Apple Account or every enrolled device is orphaned ([Apple Platform Deployment](https://support.apple.com/guide/deployment/dep2de55389a/1)); **Apple Business Manager or School Manager** for automated enrollment and supervision; Managed Apple Accounts and the customer's domain for account-driven User Enrollment (BYOD) | A **Google Cloud project** with the API on, a service account, Pub/Sub for notifications, an **enterprise** per customer (signup URL → `enterprises.create`, a managed Google Play Accounts enterprise or a managed Google domain). Since October 2025 a new project starts with **no device quota**: up to 500 devices needs a business justification, more needs a separate application, at most two projects per developer ([Google](https://developers.google.com/android/management/permissible-usage); community reports of reviews taking weeks) | The customer's provider tenant, an app registration or API account with least-privilege scopes, and a provider licence per device |
| Ownership | Supervised (ADE) vs User Enrollment (BYOD, managed data only) | Fully managed (corporate) vs work profile (BYOD; deleting the device removes only the profile) | As the provider reports it (Intune: `managedDeviceOwnerType` company / personal) |
| Lost-device and destructive actions | Lock, lost mode (supervised), erase; BYOD: remove managed data only | `LOCK`, `RESET_PASSWORD`, `REBOOT`, `START_LOST_MODE`, `RELINQUISH_OWNERSHIP`; wipe is `devices.delete` | Provider actions (Intune: remote lock, retire, wipe, locate) |
| Accepted vs completed | APNs push is fire-and-forget; completion is the device's next check-in result | Commands are long-running Operations; `done` and the device report are separate | Provider action states (Intune `deviceActionResults`: pending, done, failed) |
| Effort | Highest: a protocol server, certificates, renewals | Medium | Lowest: a connector, like `PsaDriver` |
| What this host can validate | Plist and protocol handling against recorded fixtures only. No APNs without a certificate, no device | Enterprise and policy calls only after quota; no enrollment without a phone | A loopback stand-in only, until the owner provides a tenant |

**Recommendation (decision 18).** First, a provider-neutral `MdmDriver` interface and a read-only data model,
proven against a loopback stand-in, which needs no account. Then the owner's existing provider as a
**read-only connector**: enrollment state, inventory, ownership, compliance. Intune is the likely one, since the
fleet's Windows patch detection already meets it, but the choice is the owner's. Ask Google for Android
Management API quota early, because the review takes weeks. Native Apple MDM last, if ever: it needs Apple's
vendor certificate and a yearly renewal per customer, and the host cannot prove any of it.

### Item 8, sub by sub

| Sub-item | Enforcing component | State | Blocked on |
|---|---|---|---|
| Enrollment | External provider (enrollment happens there) | **planned** | Decision 18, provider account |
| Inventory | External provider, read by the portal | **planned** | As above |
| Ownership type (corporate vs BYOD) | Provider | **planned** | As above |
| Compliance | Provider evaluates; portal shows | **planned** | As above |
| Policy assignment | Provider | **planned** (after read-only) | As above |
| Action history | Portal (audit) + provider | **planned** | As above |
| Evaluate providers, document prerequisites and limitations first | — | This page | — |
| Enrollment and inventory first, then compliance and lost-device actions | — | Roadmap order below | — |
| Work-profile or managed-data removal (BYOD) | Provider | **planned** | Decision 16 |
| Separate permissions and approval for destructive actions | Portal | **planned** | Decision 16 |
| States queued, sent, acknowledged, completed, failed, expired | Portal, from provider states | **requires setup** (0.80: a pure state machine and 0096 CHECKs; a stand-in only) | A provider (3.2) |
| Provider acceptance ≠ device completion | Portal | **requires setup** (0.80: separate `providerAcceptedAt` and `deviceCompletedAt`, shown side by side) | A provider (3.2) |
| Platforms | iOS/iPadOS and Android only through a provider; never through the Rem0te agent | — | — |

## Phase 4: backup, verified recovery and standby

Nothing is built. Backup *monitoring* is in [rmm-expansion-audit.md](rmm-expansion-audit.md#backup-monitoring)
(P1, Missing). The two providers named in the directive:

### St0r

[St0r](https://github.com/agit8or1/St0r) is the owner's own web front end for UrBackup 2.5.x (v3.2.140 on
2026-11-20). Rem0te's repository mentions it only in the README's list of sibling projects. Nothing in
`INTEGRATION_COORDINATION.md` describes a St0r API. Read from its public repository:

- **Same host.** St0r runs on the UrBackup server itself, reading UrBackup's SQLite databases and calling its
  local API on `localhost:55414`. One St0r manages one UrBackup instance.
- **It already models what the directive asks for.** Its recovery drills (`docs/recovery-verification.md`) keep
  **backup**, **offsite replication** and **verified recovery** as three separate statuses that are never
  combined.
  - A file drill restores a canary from the offsite copy and checks it against a SHA-256 St0r keeps
    independently.
  - An optional isolated boot drill restores a Windows image as a disposable Proxmox clone with no network,
    and checks that a service runs.
  - It records the recovery point's age, elapsed time and every step, and alerts on `drill_failed` and
    `drill_rpo`.
  - **Simulator runs are recorded as simulated and never count as verified.**
- **No integration API.** Every route (`backend/src/routes/recovery.ts` and the rest) sits behind a user's
  session (`authenticate`; JWT in a cookie or `Bearer`), with `requireAdmin` for writes. There is no API key and
  no read-only service token. Reads exist (`GET /recovery/status`, `/report`, `/drills`, `/runs`), and so does a
  drill trigger (`POST /recovery/drills/:id/run`).
- **What validates first.** A St0r-side pull request for a read-only, per-customer API token, then Rem0te
  reading status, drills and runs against a loopback stand-in built from St0r's own fixtures (St0r ships a mock
  UrBackup API, `scripts/demo/mock-urbackup-api.mjs`). Restore and test restore exist in St0r as drills and the
  file browser, never as "restore over production".

### Comet Backup

From Comet's public API reference
([docs.cometbackup.com/latest/api/api-methods](https://docs.cometbackup.com/latest/api/api-methods)):

- **Authentication.** Every admin call is a `POST` with `Username` and `AuthType`: `Password`, `PasswordTOTP`,
  `PasswordWebAuthn`, `TOTP`, `SessionKey`, or a personal API token (`Token`). A token inherits its admin's
  permissions, checked live on every request. Many write and configuration methods refuse token
  authentication. Tenant administrators cannot call some top-level methods.
- **Read methods that accept a token:**
  - `/api/v1/admin/list-users-full`: users, devices, protected items, retention and schedules in each profile;
  - `/api/v1/admin/get-jobs-for-date-range`, `get-jobs-for-custom-search`, `get-job-properties`,
    `get-job-log`;
  - `/api/v1/admin/meta/version`;
  - `/api/v1/admin/meta/webhook-options/get`;
  - `/api/v1/admin/dispatcher/list-active`.
- **Recovery points.** `/api/v1/admin/dispatcher/request-vault-snapshots` (≥ 18.9.1) and `request-stored-objects`
  (≥ 19.3.0). Both go through a **live connected device**.
- **Restore.** `/api/v1/admin/dispatcher/run-restore` (≥ 17.9.3) and `run-restore-custom` (≥ 19.6.0) tell a live
  device to restore locally.
- **Integrity.** `/api/v1/admin/dispatcher/deepverify-storage-vault`.
- **No test-restore or dry-run method.** A drill would be `run-restore-custom` to an isolated path on a device,
  and Rem0te could not check the restored data without the agent.
- **What validates first.** Read-only job history and protected items, against a loopback stand-in shaped from
  the reference. No Comet server is available, and the server is licensed.

### Recommendation (decisions 17 and 19)

St0r first, if the owner agrees to add a read-only token to St0r. Both ends are the owner's, and its statuses
already separate completion, integrity and verified restore. Comet second, read-only.

Neither provider offers controlled **failover or failback** of a workload. The nearest is St0r's isolated boot
drill on Proxmox, through Depl0y. So standby is shown as **readiness only** until decision 20.

### Item 9, sub by sub

| Sub-item | Enforcing component | State | Notes |
|---|---|---|---|
| Inventory, schedules, job history, recovery points, protected assets, retention | External provider, read by the portal | **planned** | St0r: needs a token; Comet: token methods above |
| Alerting | Portal (monitor kinds over provider facts, through the existing notification policies and PSA tickets) | **planned** | `BACKUP_STALE`, `BACKUP_FAILED`, `DRILL_FAILED`, `RPO_EXCEEDED` |
| Completion, integrity verification and test-restore success tracked separately | Portal (three fields, never merged) | **planned** | St0r already separates them |
| Latest verified restore, recovery point, scope, elapsed time | Provider (St0r drill runs) | **planned** | Comet: no verified-restore fact |
| Isolated restore drills with an explicit target, validation and audited result | Provider (St0r drills); portal triggers and audits | **planned** | Decision 16 for approval |
| RPO/RTO against measured | Portal, from provider timestamps | **planned** | — |
| Standby readiness | Provider (St0r replication status) | **planned** | — |
| Controlled failover and failback | Nothing | **unsupported** by either provider | Decision 20 |
| Dedicated permissions and explicit approval | Portal | **planned** | Decision 16 |
| Stale points, failed drills, missing prerequisites, provider limits | Portal | **planned** | — |
| A successful job alone is not "verified" | Portal | **planned** (the same rule as St0r's) | — |

## The terminal and file transfer design

The owner's 2026-11-21 decision reverses invariants, as §41, §62, §67, §75 and §76 did. The implementing pull
request gets its own invariant section and must change the named sections' wording in the same commit.

This is the audit's design sketch, written before implementation started. **Where 0.77.0 *Conduit* and 0.78.0
*Courier* differ from it, those branches and their invariant sections are authoritative**, and this section
should be brought in line when they merge.

### What it reverses

| Invariant | Today | After |
|---|---|---|
| **§14, the closed catalog** | The agent runs only the twelve catalog actions, each with closed parameters, and the action package runs no process (Windows: only `shutdown.exe` and `wevtutil.exe` from System32) | The catalog stays closed **for actions**. The terminal is a separate session type, outside the catalog and its signer path, with its own package and its own invariant section. §14's list does not grow, and no action can start a shell |
| **"The agent runs no process"** (§32's action package, §61's `svcproc_windows.go`, §64's `retire.go`) | Each exec site is named and fixed | One new exec site, in the terminal package only: System32 `cmd.exe` or `powershell.exe`, by absolute path, as an argument array, inside a pseudo-console. Every other package keeps "runs no process" |
| **§39, one constant command line** | A script runs through a fixed wrapper; nothing in a plan becomes a command | It holds for scripts, unchanged. In a terminal the technician's keystrokes reach a shell. That is the point of a terminal, and it is what is reversed, for this session type only. The shell's own command line is still constant: no argument from the portal reaches `CreateProcess` |

### What keeps the rest intact

- **A distinct capability.** `computers:terminal` opens a terminal and `computers:file_transfer` moves files.
  Neither is implied by `computers:edit` or `support:chat`. Presets get a `terminal` control, default `off` for
  L1–L3.
- **One computer, short-lived.** The portal signs a terminal grant with Ed25519, under its own prefix
  (`rem0te-terminal-grant-v1\n`). The grant names:
  - one computer and its RustDesk ID;
  - the technician;
  - the shell (`cmd` or `powershell`) and the identity;
  - a five-minute start window;
  - a maximum length (default 60 minutes, at most 240) and an idle limit (default 15 minutes).

  The agent verifies it against keys from the signed release metadata, as for MSA (§82: published by
  `rem0te-signed-publish`, never sent by the portal). Its replay set makes it single-use.
- **What this trusts, stated.** The portal signs terminal grants itself, not the approval signer. A compromised
  portal can open a terminal, as it can launch a Legacy session today. The owner asked for a fresh confirmation,
  not a second approver.
- **The fresh confirmation.** `assertFresh` naming `terminal.open`, after scope, the capability,
  `assertAssigned` (§70), Windows, `runsSignedAgent` (§64) and containment, and before the audit row and the
  grant. File transfer has its own key, `files.transfer`.
- **Containment.** The `remote` pause stops both, at the portal (no grant) and on the computer (the agent
  checks its signed pause before starting, as §16 requires of actions). A new pause kind is not needed: the
  label already reads "remote connections and chat" and becomes "remote connections, terminals, file transfer
  and chat". Setting the pause revokes open sessions on the next poll, as it does MSA grants (§83).
- **Audit.** `TERMINAL_OPENED` is written with `logOrFail` before the grant: ids, shell, identity, limits and
  the reason. `TERMINAL_CLOSED` records why: ended, expired, idle, revoked, paused, disconnected or failed.
  - File transfer: `FILE_TRANSFERRED` per file, with direction, name (through the existing name sanitiser),
    size, SHA-256 and outcome.
  - Audit meta never carries terminal input or output.
- **Output and history.** Proposed: off at first, nothing stored and the browser holding the only copy; later a
  per-business setting, shown to the technician at open:
  - retention days within fixed bounds;
  - redaction on the agent and again in the portal, as §39 does;
  - reading needs its own capability, not `computers:view`.
- **Transport. Never a listener on the computer.**
  - The agent learns of a pending grant from its authenticated heartbeat (a flag, as `msaPoll` is). A first release can accept
    heartbeat-interval latency to start, and the console says so.
  - The agent then opens **one outbound TLS WebSocket** to the pinned portal, authenticated with the device
    secret and the grant id. The portal relays it to the technician's browser over the console's own session.
  - An always-on long-poll for faster starts is a later, measured option.
  - Nothing listens on the computer, and nothing goes through RustDesk.
- **The process tree dies with the session.** The shell runs in a job object with kill-on-close. The agent
  closes it at expiry, idle, revocation, the pause, the agent's own restart, or a dropped WebSocket (after a
  30-second reconnect grace that reuses the same grant, never a new one).
  - The lab must prove no process survives each case, including a child that detaches (`start`,
    `Start-Process`).
  - Unlike RustDesk's persistent terminal, nothing outlives the session.
- **Operating identity, shown before the session opens and in its title bar.**

  | Identity | For | Against |
  |---|---|---|
  | SYSTEM | Everything works; what scripts already use | Full control of the computer for anyone with the permission and a confirmation |
  | The signed-in user | The customer's own context | Acts as the customer; no one is signed in on a server or at the logon screen; its rights vary from computer to computer |
  | A low-privilege identity that is not the customer: Windows' built-in `LOCAL SERVICE` (no password exists to manage), or the dedicated `rem0te-run` account already decided for scripts (2026-11-16) | Least privilege; works unattended; never the customer | Cannot change system settings; what it can read must be proven in the lab |

  **Decided (owner, 2026-11-21):** the first terminal, 0.77.0 *Conduit*, runs the shell **as SYSTEM**, named
  as SYSTEM before it opens and in its title bar. Least privilege is **planned** as a later step: one of the
  two low-privilege identities above, chosen after the lab shows what `LOCAL SERVICE` can read, and run-as the
  signed-in user. This page had recommended a low-privilege default first. The owner chose SYSTEM so the
  terminal is useful at once, and the fresh confirmation (`terminal.open`, default `ask`) is what stands in
  front of it.
- **File transfer** (0.78.0 *Courier*, in progress) follows Design B as decided on 2026-11-16, brought forward.
  This page's sketch, for the record:
  - Download (B1) comes before upload (B3), with separate permissions for each direction.
  - Every file has a size limit per business (default 100 MB, a hard ceiling), and a session has a total.
  - Every file is hashed on the agent before it moves and checked on arrival.
  - Uploads land in quarantine.
  - Deletes go to the seven-day Rem0te trash, and the tray shows a notice while a session is open.
  - The transport is the same outbound WebSocket, with no RustDesk involved.

### Decision 14a: how `terminal.open` asks

**Decided: (b), default `ask`** (the owner's "ok, go", 2026-11-21). The reasoning is kept here.

The owner wrote "maybe 2fa for dos/powershell". Since 0.64 every catalog key defaults to `off` (§62), so a new
key with the ordinary default would **not ask on a fresh install**, and the
owner's "maybe" would be met only if someone turned it on.

| Option | Effect | Cost |
|---|---|---|
| (a) The catalog default, `off` | Asks only where a Platform Admin sets it to *Ask* | Contradicts the stated intent on every new install |
| (b) **Default `ask`**, one of the few | Asks unless a Platform Admin turns it off, which itself needs `confirm.relax` | A narrow exception to 0.64's "every key defaults off". §62's `DEFAULTS` already come from each catalog entry, so it is data, not a new mechanism |
| (c) Always ask: join `passkey.manage`, `fresh.auth.passkey` and `confirm.relax` | Can never be turned off | §62's always-ask set grows from three to four |

**Decided:** (b) for `terminal.open`. `files.transfer` takes the catalog default, `off`, because the owner asked
for the confirmation on the terminal only. Whether a later, separate *SYSTEM versus least-privilege* choice
should always ask (c) is open until run-as-user ships.

## Conflicts with existing invariants

| # | Directive assumes | Invariant | Options | Recommendation |
|---|---|---|---|---|
| C1 | A background terminal and file transfer | §14 closed catalog; §39 one constant command line, never built from a plan; §61 and §32 "the action package runs no process" | (a) none; (b) RustDesk's terminal as a grant permission; (c) a native agent terminal under its own invariant section | **Decided by the owner (2026-11-21): (c)**, an owner reversal like §41/§62/§67/§75/§76; [the design](#the-terminal-and-file-transfer-design). Close RustDesk's terminal on Managed too (F1) |
| C2 | Session elevation | MSA ceiling (§82, §83): control, clipboard, files, audio, never more; `elevated` refused everywhere | (a) none: elevated work through signed actions as SYSTEM; (b) a signed action that creates a temporary local administrator, hands its password over once, and removes it at expiry; (c) an external privilege manager | Decision 13. (a) now; (b) only with its own section, after F1 |
| C3 | Chat for any authorized session or request | §45 and §55: chat is per computer, reached only through the tray's pipes and `/assist`'s one-time cookie | Link chats to MSA sessions (design); a browser chat for agentless customers is a new unauthenticated surface | Design for the link; decision 15 for agentless chat |
| C4 | Recurring execution | §71: signer-approved schedule, approved scripts and catalog software only | — | **No conflict.** §71 already satisfies "only via approved catalog actions and tenant-defined scope" |
| C5 | MDM and backup providers | §41: provider calls only through `safe-https` (public DNS, resolved and judged each call, TLS verified), keys sealed, never in a response, audit or log | (a) public hosts only; (b) an allow-listed private address per connector; (c) the provider pushes signed summaries to Rem0te | Decision 17. (a) for cloud providers; (c) or (a) behind a reverse proxy for St0r and self-hosted Comet. Never (b) silently |
| C6 | Destructive MDM and backup actions with approval | §62 (0.64): every confirm key defaults to `off`; the always-ask set is three keys | (a) new keys, default off like every other; (b) add them to the always-ask set; (c) the temporary-access pattern (a second person approves) | Decision 16: (c) plus (b) for wipe, retire, restore over production and failover |
| C7 | Per-direction clipboard and file controls | MSA's ceiling is compiled into the agent; RustDesk cannot enforce most directions | Refuse, degrade to off, or a custom client | Decisions 9 and 10 |

## Owner decisions

Decisions **1–7** are the seven in [rmm-expansion-audit.md](rmm-expansion-audit.md#conflicts-with-existing-invariants):
1. a lighter approval tier for read-only scripts (its conflict 1);
2. who may stop a running script (conflict 3);
3. ClientSt0r requesting the ten `integration: false` actions (conflict 4);
4. an interactive PowerShell terminal (conflict 6): **decided 2026-11-21**: it ships (cmd and PowerShell, background), see decision 14;
5. service recovery settings (conflict 8);
6. an MSI/EXE catalog (conflict 9);
7. widening §32 for macOS health reads (conflict 13).

New:

| # | Decision | Options | Recommendation |
|---|---|---|---|
| 8 | **Legacy computers.** RustDesk's terminal (SYSTEM with admin credentials), tunnel, file transfer and clipboard are open to anyone with the permanent password, and the console's policy settings for them are enforced by nothing | (a) leave Legacy unchanged and say so on the Connect dialog; (b) the signed agent applies a hardening baseline on Legacy computers (`enable-terminal=N`, `enable-tunnel=N`), which breaks MSA's promise that a Legacy computer is untouched; (c) refuse a Legacy launch when the business's policy asks for a control Legacy cannot enforce | (c) now, the existing fail-closed pattern; (b) later as an opt-in per business |
| 9 | **Combinations RustDesk cannot enforce** (one-way clipboard or files, size limits) in Managed control | (a) refuse the control session and offer view-only; (b) open it with the control turned fully off and tell the technician | (a) by default; (b) only where the business says "stricter is acceptable" |
| 10 | **A custom RustDesk client** for one-way clipboard and upload-only files | (a) none; (b) RustDesk Server Pro's custom-client generator; (c) an own AGPL-3.0 build | (a). It still cannot do technician → endpoint only, download only or a byte limit |
| 11 | **File transfer**: RustDesk's in-session transfer or a background transfer by the agent | (a) RustDesk on/off only; (b) background transfer with per-direction permissions, size limits and per-file audit (Design B's model), RustDesk's in-session transfer governed by the session policy | **Decided (owner, 2026-11-21): background transfer ships.** 0.78.0 *Courier*, in progress: separate upload and download permissions, `files.transfer` defaulting to `off` |
| 12 | **RustDesk's API-server audit hook** (connection and file audit posted to `api-server`) | (a) no; (b) the portal as `api-server`, behind its own flag. The same channel carries RustDesk's sync, which applies pushed settings ([managed-secure-access.md](managed-secure-access.md) §3.5) | (a). Background transfer (decision 11) gives per-file audit without it |
| 13 | **Elevation mechanism** (C2) | (a) none; (b) a temporary local administrator from a signed action; (c) an external privilege manager | (a) now. (b) after F1 and a threat model, Windows only, Managed only, with its own invariant section |
| 14 | **Terminal** (C1, settling decision 4) | (a) none; (b) RustDesk's terminal as a grant permission (it cannot give least privilege: console user or SYSTEM); (c) a native agent terminal | **Decided (owner, 2026-11-21): (c)**, cmd and PowerShell, background, on enrolled Windows computers with the signed agent. 0.77.0 *Conduit*, in progress, runs the shell **as SYSTEM**, shown as such; run-as-user and least privilege planned. RustDesk's terminal is closed wherever Rem0te sets RustDesk (F1) |
| 14a | **How `terminal.open` asks** | (a) catalog default `off`; (b) default `ask`; (c) always ask | **Decided (owner, 2026-11-21): (b), default `ask`** ([reasoning](#decision-14a-how-terminalopen-asks)) |
| 15 | **Chat without an agent**, for support-link customers | (a) none; (b) a browser chat bound to the support request's one-time link | (a). Quick Connect and the tray cover it |
| 16 | **Approval for destructive MDM and backup actions** (C6) | (a) a confirm key, default off; (b) always-ask; (c) a second person approves, as temporary access does | (c) plus (b) |
| 17 | **Providers on private networks** (C5) | (a) public DNS and TLS only; (b) an allow-listed private address; (c) push from the provider | (a), and (c) for St0r |
| 18 | **First MDM implementation** | Native Apple, Android Management API, or a third-party provider's API | The interface and a stand-in first, then the owner's existing provider, read-only. Request Android quota early |
| 19 | **First backup provider** | St0r (needs a read-only token added to St0r) or Comet (read-only token methods exist) | St0r, if the token is added; else Comet |
| 20 | **Failover and failback** | (a) readiness only; (b) Rem0te orchestrates through Depl0y/Proxmox | (a) |

## Roadmap

Each line is one reviewable pull request. Within a phase, the quickest first unless a dependency says otherwise.
None is deployed without the owner's explicit approval. **Blocked** names what it waits for. Phases are
independent: MDM and backup do not wait for sessions.

Every PR keeps the same test bar. *Unit* is a pure-module test in CI. *e2e* runs on a scratch API and database,
never ports 3000/3001. *Lab* is a `windows-latest` job, which is Windows Server only.

### The owner's priority: background terminal and file transfer

The owner's priority (2026-11-21), first in the sequence, ahead of every phase below. Both are in progress on
separate branches. This page records them, and does not design them further than
[the design sketch](#the-terminal-and-file-transfer-design).

| # | Pull request | Scope | Enforcing component | Tests | Evidence it can claim | State |
|---|---|---|---|---|---|---|
| T1 | **0.77.0 *Conduit*: background cmd/PowerShell terminal** | Windows, signed agent only. System32 `cmd.exe` and Windows PowerShell 5.1, **as SYSTEM, shown as such**; a fresh confirmation through `terminal.open` (default `ask`); the invariant reversals named above, under their own section | Signed agent + portal | Go unit; e2e on a scratch API; a Lab job (the shell starts, the process tree dies on expiry and disconnect) | Lab (Windows Server) at best; never a desktop or the fleet until run there | **In progress** |
| T2 | **0.78.0 *Courier*: background file transfer** | To and from a computer, no screen session; separate upload and download permissions; `files.transfer` defaulting to `off` | Signed agent + portal | Go unit; e2e; Lab | Lab (Windows Server) at best | **In progress** |

**Then**, as owner-directed follow-ups:
- run-as the signed-in user and a least-privilege identity;
- output retention as a per-business setting;
- PowerShell 7;
- consent and approval rules for the terminal.

### Phase 1: remote session controls

| # | Pull request | Scope | Enforcing component | Tests | Evidence it can claim | Blocked |
|---|---|---|---|---|---|---|
| 1.1 | **F1: control grants enforce their permissions** (patch, signed agent build) | `access-mode=custom` for control; terminal, camera, remote printer, block-input, privacy-mode and recording `N` on every grant, read back; `args.go` refuses `full`; §82 extended; `security-features.ts` and managed-secure-access.md corrected | Signed agent + RustDesk | Go unit (no desired map holds `full`; every `enable-*` key named); `unit-msa-managed.mjs`; lab `TestLabRustdeskEnforce` readback, plus a loopback connection to a second RustDesk process if the lab can make one | Lab (readback, Server); behavioural only if the loopback works | — |
| 1.2 | **Effective session policy, shown** | One pure module derives, per computer and mode, each control's state (available, requires setup, unsupported) and its enforcing component; shown on the Connect dialog and the device page; replaces the hand-written session entries in `security-features.ts` | Portal (display only) | Unit (every mode × control), e2e, `e2e-ui.mjs` | Unit, API | 1.1 |
| 1.3 | **Fail closed on Legacy and Quick Connect** | Refuse a launch whose business asks for a control the mode cannot enforce, for every launch path, not only preset technicians | Portal | e2e (`e2e-presets.mjs` extended), unit | API | Decision 8 |
| 1.4 | **Session length: countdown and warning** | Console countdown from the grant's `maxMinutes`; a warning at 5 minutes; *hard termination: yes / no* per mode; optional tray notice | Portal; tray (agent build, if the notice) | e2e (`e2e-msa-sessions.mjs`), Go tray tests | API; Sim (tray) | `MSA_GRANTS` to use |
| 1.5 | **Chat: retention per business, transcript permission, session link** | `retentionDays` per business (within today's bounds), shown to both sides; a `chat:transcripts` capability; `msaGrantId` on a chat | Portal + `/assist` page | `unit-chat.mjs`, `e2e-chat.mjs`, `e2e-tray.mjs`, `e2e-ui.mjs` | API | — |
| 1.6 | **Direction-aware policy model** | `clipboard` and `fileTransfer` widen to `off`, `to_endpoint`, `from_endpoint`, `both`, plus file clipboard; unenforceable combinations refused or degraded; audit unchanged | Portal | Unit, e2e | API | Decision 9 |
| 1.8 | **Elevation threat model** (docs) | The (b) design for decision 13: account creation, password handover, expiry and revocation on the agent offline, UAC on the secure desktop, what the person at the computer sees | — | — | — | Decision 13 |

### Phase 2: endpoint maintenance

| # | Pull request | Scope | Enforcing component | Tests | Evidence | Blocked |
|---|---|---|---|---|---|---|
| 2.1 | **Rollback and repeatability per action** (docs + catalog data) | Each of the twelve catalog actions documents its rollback (or "none: …") and whether it is safe to repeat; the flag is data in the closed catalog on both sides (§14 lists it) | Portal + agent catalog | Unit; §14 extended | Unit | — |
| 2.2 | **Bounded automatic retry for safe-to-repeat actions** | Retry an offline or transient failure of an action marked safe to repeat, within the signer's existing limits, audited | Portal, signer | e2e, `unit-approval-signer.mjs` | Sim | 2.1 |
| 2.3–2.5 | **The previous audit's P0 #4–#6** | Built-in reviewed library; bulk runs with preview, concurrency and pace; `windows.script.run@2` | See [rmm-expansion-audit.md](rmm-expansion-audit.md#p0-in-order) | — | — | As listed there (decision 2 for stopping a running script) |
| 2.6 | **Terminal identity: run-as-user and least privilege** | After *Conduit*: the signed-in user, and a low-privilege identity (`LOCAL SERVICE` or `rem0te-run`) proven in the lab | Signed agent | Go unit, Lab | Lab | T1 |

### Phase 3: MDM

| # | Pull request | Scope | Enforcing component | Tests | Evidence | Blocked |
|---|---|---|---|---|---|---|
| 3.1 | **MDM data model and driver interface** (**built: 0.80.0 *Tablet***, [mobile-devices.md](mobile-devices.md)) | `MobileDevice` (ownership, compliance, provider ids), `MdmCommand` with separate `providerAcceptedAt` and `deviceCompletedAt` and the directive's states; an `MdmDriver` interface on the `PsaDriver` pattern; a loopback stand-in; read-only routes through `endpointVisibilityWhere`'s business scope | Portal | Unit, e2e against the stand-in | API (stand-in only) | — |
| 3.2 | **First provider connector, read-only** | Enrollment state, inventory, ownership, compliance; credential sealed under its own secret-box purpose; `safe-https` only | External provider | Unit, e2e against a stand-in in the provider's shape | API (stand-in). Real only once the owner connects a tenant | Decisions 17 and 18; provider account |
| 3.3 | **Lost-device actions** | Lock, lost mode, locate; a separate capability; audited; accepted vs completed shown | Provider | e2e | API | 3.2 |
| 3.4 | **Destructive actions** | Wipe, retire, work-profile removal; second-person approval | Provider | e2e | API | Decision 16 |

### Phase 4: backup, verified recovery, standby

| # | Pull request | Scope | Enforcing component | Tests | Evidence | Blocked |
|---|---|---|---|---|---|---|
| 4.1 | **Backup data model, driver interface, monitor kinds** | Protected assets, jobs, recovery points; completion, integrity and verified restore as three fields; `BACKUP_STALE`, `BACKUP_FAILED`, `DRILL_FAILED`, `RPO_EXCEEDED` as opt-in kinds; a loopback stand-in | Portal | Unit, e2e (`MONITOR_SWEEP` on, scratch only) | API (stand-in) | — |
| 4.2 | **Service and event templates for backup agents** (the previous audit's P1 #7 first step) | `SERVICE_STOPPED` / `EVENT_MATCH` templates for the UrBackup client and the Comet agent on Windows | Signed or standard agent (existing monitors) | `unit-monitoring.mjs` | Unit; Fleet once applied | — |
| 4.3 | **St0r connector, read-only** | Status, drills, runs, recovery-point age per customer, mapped to businesses and computers | External provider (St0r) | e2e against a stand-in from St0r's fixtures | API | A St0r-side token PR; decisions 17 and 19 |
| 4.4 | **Comet connector, read-only** | Users, devices, protected items, jobs, job logs | External provider | e2e against a stand-in | API | Decision 19; a Comet server to go further |
| 4.5 | **Restore drills from the console** | Trigger a St0r drill; audited; separate permission; simulated runs never verified | Provider | e2e | API | 4.3, decision 16 |
| 4.6 | **Standby readiness** | Replication lag and last verified drill as readiness; no failover | Portal | e2e | API | Decision 20 |

### The first pull request of each phase

- **First of all: T1 and T2**, the owner's priority, both in progress (0.77.0 *Conduit*, 0.78.0 *Courier*).
- **Phase 1: 1.1**, the F1 fix. Small, inside the existing ceiling, and it closes RustDesk's terminal, tunnel and
  restart on Managed computers before anyone turns `MSA_GRANTS` on.
- **Phase 2: 2.1**, rollback and repeatability per catalog action (the terminal itself is T1). Data and docs, no new surface. The library,
  bulk and `@2` items already have a place in the previous audit's sequence.
- **Phase 3: 3.1**, the MDM model and driver interface against a stand-in. It needs no account.
- **Phase 4: 4.2** is the quickest: monitor templates, no provider. **4.1** is the foundation for everything else.

## Corrections made in this release

- **[managed-secure-access.md](managed-secure-access.md)** §3.12 says a control grant is "never a TCP tunnel or a
  remote restart". True of the grant, not of RustDesk's behaviour (F1). A note now says so.

Left for the implementing pull requests (they are console text in code, not docs):

- **`security-features.ts`** (`clipboard`, `file-transfer`) says RustDesk applies clipboard and file transfer
  "on the technician's own client". It is the controlled side (`enable-clipboard`, `enable-file-transfer`) that
  enforces them. The technician's client has its own toggles too, which only narrow. Fixed in 1.1 or 1.2.

## GitHub

The repository keeps no roadmap on GitHub. It has two issues, both closed, and no milestones. The *ClientSt0r
Roadmap* project (owner agit8or1) holds 43 items, all from `agit8or1/clientst0r`, and none from rem0te. This page
and [rmm-expansion-audit.md](rmm-expansion-audit.md) are the roadmap of record.
