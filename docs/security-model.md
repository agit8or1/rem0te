# Security model: who can reach a computer, and what you will have afterwards

This page is for the MSP owner who needs to answer two questions about a customer's PC:

1. **Which technician can reach it?**
2. **What evidence will I have afterwards?**

It describes only what this release enforces, and says where each control is enforced. Everything here is
also shown, per control, in **Settings → Security → Security Features**. That view adds the effective state
for your platform or one business, wherever the server can observe it, and reads **Unknown** where it cannot.

The rule this page follows:

> **A hidden button is not a restriction, and a portal audit event is not proof of what happened on the
> computer.** A control counts as enforced only if a layer refuses the action, and that layer is named here.

## The three layers

| Layer | What it is | What it decides | What it cannot see |
|---|---|---|---|
| **Portal** (this app and its API) | Accounts, businesses, assignments, policy, audit | Whether to **release** a credential or a single-use launch grant for one computer | Anything after the release: whether RustDesk connected, what was done, when it ended |
| **RustDesk** (`hbbs`/`hbbr` on your server, RustDesk on the technician's machine) | Rendezvous and relay; the technician's client | Brokers the connection. Clipboard, file transfer, chat and view-only are toggles **in the technician's client** | The portal's decisions. RustDesk does not know about assignments or presets |
| **Endpoint** (RustDesk service and the Rem0te agent on the customer's PC) | The machine being reached | RustDesk on the endpoint accepts or rejects a password. The agent reports a heartbeat, inventory and a count of incoming RustDesk connections | Who is connecting: it sees a process count, not an identity |

The installer configures the endpoint's RustDesk with your server, its key, and
`verification-method = use-permanent-password`. It sets **no** per-feature options. The endpoint therefore:

- accepts its permanent password without asking anyone at the keyboard;
- gives each session the installed RustDesk version's default features: keyboard and mouse, clipboard, file
  transfer, and chat or terminal where that version offers them.

Rem0te does not restrict those defaults on the endpoint, and it does not record their use.

## Permission to launch is not a connection

When the portal says yes, it does one of two things:

- releases the computer's **permanent password** (Business Owners, Business Users, custom technician
  assignments, Platform Admins). Since 0.30.1 it is never in the Connect response itself: it travels in the
  Connect script or a single-use launcher grant, either needs a fresh step-up (`credential.reveal`), and each
  release is recorded as `ENDPOINT_PASSWORD_REVEALED` before the password leaves — if that record cannot be
  written, the release is refused;
- or, for preset-backed technicians, releases a **90-second, single-use grant** that never carries the
  password.

Either one is permission to launch, nothing more. Two things follow:

- **Anyone who has seen a permanent password can connect without the portal.** All it takes is any RustDesk
  client pointed at your server, and it creates no session record. Revoking someone's access does not change a
  password they have already seen. **Offboarding** lists which passwords each person saw. Rotate them.
- **The portal cannot end a session.** Nothing on the endpoint terminates RustDesk on the portal's behalf.
  *Disconnected* means the endpoint agent saw the incoming-connection count fall to zero.

## Example: two customers, two PCs named FRONTDESK

**The setup:**

- *Acme Dental* and *Birch Law* each have a PC called `FRONTDESK`.
- Dana is an MSP technician with an **L2** assignment in Acme only.
- Pat is an Acme **Business User** who has been given Acme's FRONTDESK.

**How the right machine is chosen.** A computer is never chosen by its name.

- Every computer has a database id. Connect, the password, the launcher token and the session all take that
  id.
- The computer list is filtered to the **active business**, which is re-read from the database on every
  request. Dana's business switcher offers only businesses she is currently assigned to. Her Acme list shows
  one FRONTDESK.
- Birch's FRONTDESK is not in that list. It is not in search results, and it is not offered as a match.

| Who | Does | Result | Recorded |
|---|---|---|---|
| Dana | Opens a link to **Birch's** FRONTDESK (or calls the API with its id) | **404 "Computer not found"**, the same answer as a nonexistent id, so nothing is learned | `CONNECTION_GRANT_DENIED`, reason `wrong_business` |
| Dana | Clicks Connect on **Acme's** FRONTDESK | **403 `TEMPORARY_GRANT_REQUIRED`**: L2 control needs a temporary grant, approved by someone else and activated with fresh authentication | `CONNECTION_GRANT_DENIED` / `PRIVILEGED_WORK_DENIED` |
| Dana | Same, with an activated grant | **403 `ENDPOINT_CANNOT_ENFORCE_CONSENT`**: policy requires the user's consent, and no shipped endpoint can enforce it | as above |
| Dana | Clicks View only | **403 `ENDPOINT_CANNOT_ENFORCE_VIEW_ONLY`** | as above |
| Pat | Clicks Connect on Acme's FRONTDESK, confirms it is them (step-up) | A Connect script carrying the password is released, and the session record starts | `CONNECTION_GRANT_CREATED`, `ENDPOINT_PASSWORD_REVEALED` (via connect_script, or via launcher when a launcher grant is redeemed), `SESSION_LAUNCHED`, then state changes |
| Pat | Tries Birch's FRONTDESK | **404**, as for Dana | `CONNECTION_GRANT_DENIED` |

So, on endpoints as shipped, a **preset-backed technician cannot open an interactive session at all**. The
portal refuses rather than opening something it cannot restrict. A **custom** assignment with Connect behaves
like Pat.

**Afterwards you will have:**

- the audit entries above, with who, which computer and when;
- the session record, each state labelled with how it was established (see
  [connecting.md](connecting.md#what-the-session-status-means-v020)):
  - *Client opened* means RustDesk started on Pat's machine. It is not a connection.
  - *Connection confirmed* means the Acme agent saw one incoming RustDesk connection while this was the only
    open launch for that PC, or that Pat said so, which is recorded as Pat's claim.
  - *Disconnected* means the agent saw it end. Duration appears only when both ends were measured.
- **Offboarding**, which shows that Pat has seen FRONTDESK's password.

**You will not have:** what was done in the session; whether files or clipboard contents moved; who was at the
keyboard; or any record of a connection made outside the portal with a known password.

## What each session mode really does

Supported client and launch path: the **Windows endpoint installed by Rem0te**, reached through the
**Connect script** (`connect.cmd`) or the **desktop launcher** (`reboot-remote://`). Neither path passes a
mode to RustDesk. The client is told only the ID to connect to.

| Mode | Business Owner / User, custom assignment, Platform Admin | Preset technician (L1/L2/L3) | Enforced by |
|---|---|---|---|
| **Attended (consent)** | Not asked. The endpoint accepts the permanent password | Refused while consent is required, because no endpoint reports it can enforce consent | Portal refusal only |
| **View-only** | **Not applied.** The session has full control, so from 0.25.0 the button is offered only in a technician context | Refused, because no endpoint reports it can enforce view-only | Portal refusal only |
| **Keyboard and mouse** | Full, RustDesk default | Needs an activated temporary grant, then consent (above) | Portal refusal; the endpoint does not stop input when a grant expires |
| **Clipboard** | RustDesk default | Presets cannot enable it, but the policy value reaches nothing | Nothing in Rem0te. It is a toggle on the technician's client |
| **File transfer** | RustDesk default | As clipboard | Nothing in Rem0te |
| **Elevation** | Whatever rights the signed-in Windows user has | Always refused | Portal refusal. No privileged helper exists |
| **Unattended** | **In effect, yes.** An ordinary Connect releases a password the endpoint accepts with nobody present | Explicit unattended launches refused while policy is off | Portal refusal of the explicit mode only |
| **Session length** | Not limited | Shown at launch; nothing ends the session | Nothing (advisory) |

How this was verified:

- **The portal refusals** are driven by `apps/api/scripts/e2e-presets.mjs`, with an enforcing endpoint
  simulated by writing `Endpoint.sessionEnforcement` directly.
- **The endpoint behaviour** comes from the installer's configuration (`apps/api/src/public/windows-script.ts`)
  and the launch code. **None of these restrictions has been live-verified against RustDesk on a lab machine.**
- **Nothing in a shipped agent writes `sessionEnforcement`.** That is why every enforcement-dependent launch is
  refused.

## Roles and technician presets

These are two separate systems. Presets are not roles. They apply only to MSP technicians acting in a business
through an assignment.

| | Scope | Default capabilities | Interactive launch |
|---|---|---|---|
| **Platform Admin** | Every business, explicitly | All | Yes, with the password |
| **Business Owner** | Their own business | All, in that business | Yes, with the password |
| **Business User** | Their own business, per computer | `computers:view`, `computers:connect` on computers they are given (or company-wide ones) | Yes, with the password |
| **L1 Help Desk** | One business per assignment | `computers:view`, `support:requests` | No |
| **L2 Technician** | One business per assignment | L1 + `computers:event_logs`, basic diagnostics | Only by temporary grant, and refused on shipped endpoints (above) |
| **L3 Senior** | One business per assignment | L2 + advanced diagnostics, not limited to standard workstations | As L2, plus Windows update deployments (high impact). Elevation is not built |
| **Custom assignment** (pre-0.23, or made from a group with capabilities) | One business per assignment | Exactly what was granted | As a Business User |

**What an admin can restrict:**

- clone and narrow a preset, or reset it;
- set dates and a weekly schedule on an assignment;
- limit an assignment to named computers;
- require Business Owner approval of assignments (off by default);
- tighten the platform policy at once, or loosen it through an independent reviewer. A Business Owner can
  tighten their own business only (consent, unattended, clipboard, file transfer, extra protected classes,
  shorter sessions).

**What no setting can change:**

- No preset can ever grant Connect, credential reveal, edit, add, remove, Quick Connect or user management.
- Nobody approves their own request.
- Protected device classes are refused to everyone.

Details: [technician-access.md](technician-access.md), [technicians.md](technicians.md),
[access-control.md](access-control.md).

## The same rule, applied elsewhere

| Control | What is enforced, and where | Default | What it does not prove |
|---|---|---|---|
| **Signed agent updates** ([update-signing.md](update-signing.md)) | The endpoint agent runs only targets signed offline against its compiled-in root. The portal holds no key | *Legacy allowed*, no repository configured | Fixture-tested only. Legacy agents still trust the portal until migrated |
| **Approved actions** ([approved-actions.md](approved-actions.md)) | Two catalog actions: start the Print Spooler, and (0.27) install named Windows updates through a staged deployment. The portal only proposes; a separate approval signer signs the exact plan after user-verified passkey approvals from roster members who are not the requester (one for a standard workstation, two distinct otherwise, plus customer sign-off where required); the agent verifies that signature with keys from the offline-rooted chain, its own identity, product type, window and build, and journals the job so it never runs twice. The command channel is otherwise an allowlist: inventory refresh, update scan, event-log query | Off until an approval signer is configured | Fixture-tested only. A started spooler is not a printed document. A compromised portal can delay or withhold delivery, but cannot sign |
| **Staged Windows patching** ([staged-patching.md](staged-patching.md)) | A canary, then rings of up to 25, each one signed plan needing two distinct approvers. The next ring is refused until the canary reports every update effective, the failure threshold holds and the soak has passed; over the threshold the deployment pauses itself. Each computer refuses if WSUS, WUfB policy, MDM or ConfigMgr manages it, and installs only what Windows Update itself offers as a security, critical, rollup or ordinary update. It never restarts or accepts a licence | Off until approved actions are, and agents run the 0.27 signed build | Fixture-tested only, against a simulated Windows Update. *Effective* is what the computer reports, not proof a vulnerability is fixed. No restarts, no uninstall |
| **Containment** ([containment.md](containment.md)) | A global write pause, or a suspension of one business, stops approved actions (and delivery of approved plans), remote connections, agent update flags and ClientSt0r jobs, asked by every write path after access. A business's own suspension is lifted only by its owner; an MSP pause by a second person; lifting needs fresh authentication. The approval signer keeps its own copy that only its CLI lifts, and a signed `control/pause.json` makes agents refuse whatever the portal delivers | Nothing paused | A compromised portal ignores its own pause; the signer and signed-pause layers hold then. Fixture-tested only |
| **Tamper-evident audit log** ([containment.md](containment.md#the-tamper-evident-audit-log)) | Every entry is hash-chained within seconds, sealed entries are guarded by a database trigger, the chain is verified hourly, and entries can be streamed off the host with Ed25519-signed checkpoints and compared with `rem0te-audit verify --export` | Sealing and verify on; export and signing off until configured | Detects, does not prevent: a database superuser can still delete rows and is caught afterwards. Without an export, a full rewrite of the chain is not detectable |
| **API keys** ([PUBLIC-API.md](PUBLIC-API.md)) | A key acts as a Business Owner of one business, only within its scopes, and only while its creator still is one. Creating any key needs a fresh re-authentication (0.34; `apikey.create`), checked by the API after scope and before the key is written. Keys are immutable: no route widens scopes or restores a revoked key. Revoking is immediate and never needs a step-up | No keys | A key keeps working after the session that made it ends, until it is revoked or expires; the portal cannot tell who holds it. Keys made before 0.34 without a step-up keep working — review them |
| **The tray: chat, support requests, self-help** ([tray.md](tray.md), [chat.md](chat.md)) | On Windows, chat and self-help happen outside RustDesk. The **signed** tray holds no credential: it asks a SYSTEM tray host over pipes whose access list names only SYSTEM and the session's user, and the account is read from the session token. The **standard** tray holds a tray key that opens only `/tray/*` and never an elevated tool (refused by the API and by a database `CHECK`). The chat page is reached by a 60-second one-time code, exchanged once for an HttpOnly, SameSite=Strict cookie on `/assist`, and has its own strict CSP. The elevated tools (flush DNS, renew IP, restart RustDesk) run only in the signed host, only `ipconfig` from System32 or the RustDesk restart, under `actions` / `remote` containment. Changing whether chats are recorded needs a fresh sign-in; a chat that is not recorded deletes each message once both sides have it. Screenshots are shown only to someone who can see the computer | Tray on with both agents; chats recorded | Not run on real Windows. On a standard computer the Windows account is reported by the tray, unproven, so a local user can chat or ask for help under another local account's name |
| **Replay protection** | Connection grants (90 s), launcher tokens (120 s), enrollment tokens and integration nonces are single-use by conditional update. Integration nonces are stored in Postgres, so they survive a restart | Always on | — |
| **Fleet limits** | Per-identity caps on distinct computers, businesses, launches and writes. A trip pauses the identity until someone else clears it | 60-minute window; see [technician-access.md](technician-access.md#fleet-abuse-limits) | Connections made outside the portal are not counted |
| **AI through ClientSt0r: ticket analysis and the device summary** ([integration-clientst0r.md](integration-clientst0r.md)) | **Provider keys stay in ClientSt0r, everywhere:** since 0.34 rem0te has no model-provider SDK, endpoint or key variable at all (invariant §41), and the device page's AI summary is one signed request to ClientSt0r's gateway with a redacted, listed minimum (no name, hostname, business, addresses, authors or RustDesk ID), audited before it leaves, refused under an `integration` pause, and sent only once ClientSt0r advertises the operation. For ticket analysis, rem0te authorizes each job itself: a signed request, an explicit mapping, the delegated technician's live access (never Platform Admin), and a fleet-limit admission. A job reads bounded evidence. Its output is text only (`executable: false`). From 0.26 ClientSt0r may *propose* the catalog action as the delegated technician; an AI suggestion is labelled as one and gets exactly the same approvals | Off until configured | A mapped ticket is context, not authority. A proposal authorizes nothing. Fixture-tested against a simulated ClientSt0r. The device summary's operation is a proposal ClientSt0r has not agreed, so it is off against the real ClientSt0r |

## Roadmap (not in this build)

These appear in the Security Features view as **Unavailable**, so nobody mistakes a plan for a setting.

| Capability | Where it stands | What it needs before it ships |
|---|---|---|
| **Further approved actions, scripts, drivers and third-party patches** | Two actions ship in 0.27: the Print Spooler ([approved-actions.md](approved-actions.md)) and Windows update installs ([staged-patching.md](staged-patching.md)); nothing else can be requested | A catalog entry per action, compiled into a new signed agent build, with its own warnings and on-endpoint verification. No free-form script channel is planned |
| **Background terminal / PowerShell** | Not built. Any terminal inside a RustDesk session is RustDesk's own feature, outside Rem0te | The same as approved actions, per command, with a signed action catalog in place of free text |
| **Elevation (privileged helper)** | Not built | Authenticated named-pipe IPC with a SID-restricted DACL, per-request signed intent, no arbitrary command surface |
| **Endpoint-enforced view-only, consent, clipboard, file transfer, session end** | Not built. Launches that need them are refused | An endpoint agent that enforces each one and reports it |
| **Mobile device management** | Not built. Planned order: read-only inventory, then compliance, then acknowledged Lost Mode per platform. Wipe and location get separate approval | Apple supervised or eligible company-owned Android enrollment, platform credentials |
| **Backup, verified recovery, standby** | Not built. A recovery badge only after a boot, service and data check in an isolated network | An independently administered backup engine and destination |
| **Device attestation for admin workstations** | Not built, so protected computers are unreachable for everyone | A launcher device key |

## Reporting a problem

Security issues go through private vulnerability reporting. See [SECURITY.md](../.github/SECURITY.md). Do not
open a public issue.
