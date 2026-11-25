# Standalone requirements

Rem0te is a complete product on its own. ClientSt0r, a third-party PSA, an AI
provider, an identity provider, a backup provider and an MDM provider are each
**optional**. This page turns section 2 of the owner's UI/UX directive
(2026-11-25) into rules that a change can be checked against, and lists where
the console stands against them at 0.85.1.

It is a permanent requirement, not a phase. A release that breaks it is not
shippable (directive §29: "Standalone operation is a release-blocking
acceptance requirement").

## What Rem0te keeps for itself

Each of these works with no other application configured, and none of them may
come to depend on one:

| Area | Where it lives in Rem0te | Depends on a peer? |
|---|---|---|
| Installer and setup | `deploy/scripts/install.sh`, `docs/setup.md` | No |
| Database, configuration storage | PostgreSQL, `PlatformSettings` | No |
| Authentication, recovery, break-glass | Passwords, TOTP, passkeys, recovery CLI, `docs/break-glass.md` | No. SSO is optional (§72) |
| Users, customers (businesses), roles and permissions | `/users`, `/businesses`, `/admin/access`, `/admin/technicians` | No |
| Endpoint management, enrolment, adoption | `/endpoints`, `/endpoints/enroll`, `/admin/deploy`, `/admin/unassigned` | No |
| Monitoring and alerts | `/alerts`, Settings → Monitoring | No. Tickets are an optional output |
| Remote support | Connect, Quick Connect, sessions, chat, tray | No |
| Automation, scripts, software, patching | `/automation/*`, `/patching`, the approval signer | No. The signer is Rem0te's own install |
| Agent updates | the signed update chain (`docs/update-signing.md`) | No |
| Security configuration | Settings → Security, Admin → Security | No |
| API | `/api/v1`, API keys | No |
| AI provider | Settings → AI (§41) | Optional, Rem0te's own key |
| Notifications, email | Settings → Email, monitoring notify policies | No |
| Reporting | `/reports/*`, scheduled reports | No |
| Backup and recovery of Rem0te itself | `docs/incident-recovery.md` | No |
| Documentation | `/docs`, `/help`, `docs/` | No |
| Health | Admin → System status, `/healthz` | No |

## Optional integrations, and where each is configured

| Integration | Configured in | Console surfaces when configured |
|---|---|---|
| A PSA connector (email, webhook, ClientSt0r) | Settings → PSA / ticketing | *Create ticket* on alerts and event-log entries; automatic alert tickets (Settings → Monitoring); the tray's *Open a support request* |
| ClientSt0r, contract `ticket-rmm-v1` | root-owned peers file (`docs/integration-clientst0r.md`) | The device page's AI-written summary; *Offer alerts to ClientSt0r* in a notify policy; ClientSt0r proposals on the Actions tab; the `integration` containment kind |
| AI provider | Settings → AI | *Ask AI* on alerts and event-log entries |
| Identity provider (OIDC / Keycloak) | Settings → Single sign-on | Sign-in buttons on the login page |
| Backup provider (St0r push, Comet planned) | Settings → Backups | Backups page, backup monitors |
| MDM provider / Rem0te's own MDM | Settings → Mobile devices | Mobile devices page |
| Warranty lookups (Dell, Lenovo, HP, Apple) | Settings → Warranty | Looked-up dates on the device and the report |
| Tactical RMM | URL Actions in Tactical (`docs/tactical-rmm.md`) | `/trmm` landing only |

Every integration stays discoverable from Settings (directive §2, last line).
Nothing else in the console may advertise one.

## The rules

### S-1. Nothing a person cannot use is drawn

When an integration is **not configured at all**, its controls are not drawn:
no disabled button on every row, no empty card, no reserved space. One quiet
line where the feature would be configured (Settings) is enough.

When it **is configured but cannot be used right now** (paused by containment,
not mapped for this business, the peer is unreachable, the peer does not offer
the capability), the control stays and says why, because the reason is
actionable and the feature is real.

The test for a control is the server's own answer, never a guess in the
browser: the PSA status's `connector`, the timeline status's `code`, the AI
status's `enabled`.

### S-2. No persistent warnings about missing optional integrations

No banner, toast or header line on an everyday page says that ClientSt0r, a
PSA, an AI provider, SSO, a backup provider or an MDM provider is missing.
Setup checklists may list them as optional, once, and must be dismissible.

### S-3. No upsell

No advertisement, recommendation or prompt to install ClientSt0r or another
MSPZero product anywhere in the console, the customer pages (`/download`,
`/quick`, `/support/*`, `/assist`) or the tray.

### S-4. The application switcher is absent until an application is configured

There is no switcher today. When one is built (UX_ROADMAP.md P0-4), it renders
only with at least one configured, reachable-or-recently-reachable peer that
the signed-in person may open, and lists only those. With none, no icon, no
empty menu, no reserved space.

### S-5. Setup never requires a peer

The setup path (today `docs/setup.md` and the Quick start page; the wizard is
UX_ROADMAP.md P1) must complete with every optional step skipped.

### S-6. A peer's failure never blocks local work

- Every outbound call has a bounded timeout. Today: `safe-https` (every
  provider, PSA webhook and vendor call), the integration gateway
  (`INTEGRATION_*_TIMEOUT_MS`, 5 s for capabilities, 60–90 s for inference).
- No page waits for a peer before it renders. A section that asks a peer
  renders its own "checking…" state and the rest of the page is unaffected.
- A failed external call is reported once, in the section that made it, with
  the integration named. It is not repeated as a toast on every poll.
- Information from a peer that may be stale says when it was read.
- Removing or disabling an integration deletes no local device, inventory,
  monitoring history, automation history, session record or audit entry.
  Ticket references already recorded (`PsaTicket`, `MonitorAlertTicket`) stay
  readable.
- Approval, signing, revocation and containment are never relaxed because a
  peer is down.

### S-7. A peer never authorizes execution

ClientSt0r and any PSA request and record. Rem0te authorizes, approves on its
own approval signer, executes and reports (`INTEGRATION_COORDINATION.md` §1).
A UI change must not blur this, for example by labelling a ClientSt0r proposal
as "approved".

## Status at 0.85.1

Checked against the running console on the docs stack, with no PSA connector,
no ClientSt0r peer, no AI provider and no SSO provider configured
([UX_AUDIT.md](UX_AUDIT.md#standalone-mode)).

| Rule | Status | Evidence / gap |
|---|---|---|
| S-1 | **Partly met; fixed in 0.85.1 for two surfaces** | *Create ticket* was drawn disabled on every alert and event-log row with no PSA connected, and the device History tab drew an "AI-written summary" section with a disabled Generate button when no ClientSt0r peer existed. Both are now hidden when nothing is configured (and kept, with the reason, when a connector or peer exists). Remaining: *Ask AI* is drawn disabled on every row with no AI provider (owner decision 3 in UX_ROADMAP.md); *Offer alerts to ClientSt0r* in a notify policy is drawn with no peer (needs an API flag, UX_ROADMAP.md P0-5); the containment pause kind is labelled *ClientSt0r jobs* although it also stops warranty, backup and MDM syncs (UX_AUDIT.md F-17) |
| S-2 | **Met for peers.** One related case | No page warns about a missing PSA or ClientSt0r. The device header's "Run action unavailable: No approval signer is configured" line shows on every device page; the signer is Rem0te's own optional module, not a peer, but the line is persistent (UX_ROADMAP.md P1-2) |
| S-3 | **Met for ClientSt0r.** One owner decision | No ClientSt0r promotion anywhere. The sidebar's *Support Rem0te* menu (GitHub star, Sponsors, mspreboot.com) is shown to every signed-in person, including a customer's Business Users (owner decision 2) |
| S-4 | **Met trivially** | No switcher exists |
| S-5 | **Met** | Nothing in setup asks for a peer |
| S-6 | **Mostly met** | Timeouts are bounded everywhere outbound. The History tab's AI summary reads ClientSt0r's capabilities on every view, with a 5 s timeout and no cache or circuit breaker (UX_ROADMAP.md P0-5) |
| S-7 | **Met** | Unchanged by this work |

## How to check a change

1. Run the browser suite (`apps/web/scripts/e2e-ui.mjs`), and look at the
   changed pages on the docs stack, which has no PSA connector, ClientSt0r
   peer, AI provider or SSO provider.
2. For a change that adds a peer-dependent control: show it with the peer
   configured and confirm it is absent with none. Add both to the suite.
3. Grep the change for `ClientSt0r`, `PSA`, `ticket` and `AI` in visible text,
   and confirm each is gated on the server's own status.

An automated standalone check (UX_ROADMAP.md P0-5) will walk every page of the
docs stack with nothing configured and fail on a visible peer-only control.
