# Technician access presets and abuse prevention

*Added in v0.23.*

Technician assignments ([technicians.md](technicians.md)) say **where** someone may work. Presets say **what** they may do there, as three shipped tiers an MSP can clone and tighten. Around them sit the safeguards that apply to everyone, Platform Admins included: protected device classes, fleet-abuse limits, and independent review of anything that widens trust.

Everything here lives at **Settings → Security → Technician Access**. The Security Features catalog (**Admin → Security → Security features**) lists every safeguard with its scope, whether this build actually enforces it, and the test that proves it.

## The three presets

| | L1 Help Desk | L2 Technician | L3 Senior |
|---|---|---|---|
| Inventory and liveness | ✓ | ✓ | ✓ |
| Work assigned support requests | ✓ | ✓ | ✓ |
| Event logs (bounded) | — | ✓ | ✓ |
| Diagnostics | — | basic | advanced |
| Standard workstations only | yes | yes | no |
| Attended view-only | off (an admin may enable it) | allowed where the endpoint enforces it | allowed where the endpoint enforces it |
| Interactive control | — | temporary grant only | temporary grant only |
| Elevation | — | — | may request (*Unavailable*: no privileged helper) |
| Staged patches | — | — | may request (*Unavailable*: not implemented) |
| Catalog fix requests | — | low-risk (*Unavailable*) | higher-risk (*Unavailable*) |
| Max session | 30 min | 60 min | 120 min |

**Off for every tier, and not configurable:** unattended access, clipboard, file transfer, credential reveal, enrollment, scripts, fleet execution, fix approval. Every control in the Settings screen shows one of four states: **Off**, **Allowed in scope**, **Request time-limited**, or **Locked** (mandatory) / **Unavailable** (this build cannot enforce it, with the reason).

A tier grants **no** approval, execution, enrollment, administration or cross-business access. An L3 can be separately designated an **independent reviewer** (the `approvals:review` platform permission), which is a different thing from the tier and is itself an independently reviewed change.

### How a preset becomes capabilities

A preset-backed assignment's capabilities are **derived live** from the preset on every request: `computers:view`, `support:requests`, and `computers:event_logs` for L2 and L3. That is all. No preset can produce `computers:connect`, `computers:edit`, `computers:add`, `computers:remove`, `quick_connect` or `users:manage`. `scripts/check-security-invariants.mjs` § 11 fails CI if that changes. Nothing is ever inferred from `computers:connect` or `computers:edit`.

**Capability and computer scope come from the same grant.** A technician in a group with L2 on one computer and a direct L1 on the whole business gets event logs on that one computer only. Before 0.23 the two grants were unioned: capabilities from one, scope from the other.

### Defaults, migration and upgrade

- New assignments with no preset and no explicit capabilities get **L1 Help Desk**. A new technician has no assignments at all until someone creates one.
- Existing assignments (and any new one given explicit capabilities) are **custom** and behave exactly as before. That includes `computers:connect` and credential reveal: nothing existing is silently changed. **Upgrade impact** on the Settings screen lists every live assignment, what it would gain or lose under each tier, and flags the ones holding connect or edit.
- The built-in presets are seeded on startup, **create-only**: an admin's edit survives restarts and upgrades. **Reset defaults** is the way back. If the shipped definition is wider than the current one, the reset goes to review like any other widening.
- Migration `0023_technician_presets` back-fills `Endpoint.deviceClass` from inventory: `SERVER` when the OS caption contains "Server", otherwise `WORKSTATION`, and `UNKNOWN` when there is no inventory. It never assigns a protected class. Mark domain controllers, hypervisors, backup servers and the RMM host yourself.

## Starting a session

Every way of starting a session goes through one decision (`AccessPolicyService.evaluateLaunch`): `POST /endpoints/:id/connect`, `connect.cmd`, a connection-grant redemption, and a launcher token at issue **and** at redemption. In order:

1. **Paused identity** gets nothing.
2. **Protected device class** (below): denied for everyone.
3. **Unattended** mode: refused while the policy says off.
4. Business members and Platform Admins: the pre-0.23 decision, unchanged.
5. Custom technician assignments with `computers:connect` on this computer: unchanged.
6. **Preset-backed** technicians:
   - **view-only** needs a preset that allows it on this device class, *and* an endpoint that reports it can enforce view-only and (when consent is required) attended consent;
   - **control** needs an *activated* temporary grant for this computer, and consent enforcement;
   - **elevation** is unavailable.

**If the endpoint cannot enforce it, the launch is blocked with the reason.** It is never silently opened with more. And **a preset-backed launch never receives the permanent password**: it would outlive the grant and allow a direct reconnect the portal never sees.

The launch mode is recorded on the grant and the launcher token, and redemption re-evaluates **that mode**, never a wider one. A demotion, revocation, pause or expiry between minting and redemption ends it.

### What the endpoint can enforce today

RustDesk's view-only, clipboard and file-transfer switches are toggles on the **technician's** client. The endpoint options that exist apply machine-wide, and the shipped installer sets `verification-method=use-permanent-password`, so the endpoint never asks its user to accept. **No shipped agent reports `Endpoint.sessionEnforcement`.** So in practice:

- every view-only and every consent-gated launch is **blocked** with `ENDPOINT_CANNOT_ENFORCE_VIEW_ONLY` / `ENDPOINT_CANNOT_ENFORCE_CONSENT`;
- clipboard and file transfer are **Unavailable**;
- endpoint-confirmed session termination is **not implemented** (RustDesk does not report it).

The test suite simulates an enforcing endpoint by writing `sessionEnforcement` directly. **None of these restrictions has been live-verified against RustDesk.**

## Temporary access

Three steps, held by different people:

1. **Request**: the technician, for one computer and one mode (`CONTROL`, `ELEVATION`, `PROTECTED_EXCEPTION`), with a reason and a duration capped at the policy's maximum session.
2. **Decide**: an independent reviewer, never the requester, with fresh authentication.
3. **Activate**: the requester, with fresh authentication. For a protected-device exception that must be a **passkey**; password and authenticator codes are refused. Activation starts the clock and re-checks eligibility, so a demotion after approval ends it here.

An approved grant that is never activated does nothing. The requester, a reviewer or an admin can revoke it at any time, without step-up.

## Protected device classes

Domain controllers, hypervisors, backup servers and the RMM host are **always** protected; an admin can add `SERVER`. Interactive access to a protected computer is denied to everyone, **Platform Admin included**, unless all of these hold:

- an activated `PROTECTED_EXCEPTION` from someone else's approval;
- the launch comes through the launcher;
- it comes from a **managed admin workstation**.

Customer and explicit denies win, and neither ClientSt0r nor a portal shortcut can authorize anything on an endpoint.

> **Gap:** nothing in this build attests a managed admin workstation. The launcher carries no device key, so no launch can prove where it came from. The requirement therefore cannot be met, and **protected computers are unreachable interactively for everyone.** That is deliberate fail-closed behaviour until device attestation exists. Exceptions can still be requested, approved and activated, and all of it is audited.

Re-classing a protected computer as something unprotected is a reviewed trust change. Marking one protected applies at once.

## Fleet-abuse limits

Every unit of privileged work is admitted by `AbuseGuardService`, whatever the entry point (UI, launcher, Quick Connect, integration):

| Kind | What counts |
|---|---|
| `LAUNCH` | minting a connection grant, a launcher token, a `connect.cmd`, a Quick Connect session |
| `WRITE` | credential set / rotate / reveal, agent reinstall, accepting a device secret |
| `EVIDENCE` | inventory refresh, event-log reads, integration jobs (counted for the delegated technician **and** for the peer) |

Admission takes a per-identity Postgres advisory lock and counts **distinct computers**, **distinct businesses**, launches and writes inside the window (60 min by default). Forty concurrent single-device jobs split across five entry points serialise on that lock, so exactly the cap gets in. That is tested with a 5-device cap.

Default limits per window:

| Row | Devices | Businesses | Launches | Writes |
|---|---|---|---|---|
| L1 | 10 | 3 | 5 | 0 |
| L2 | 15 | 3 | 10 | 20 |
| L3 | 25 | 5 | 20 | 40 |
| custom (pre-0.23 assignment) | 25 | 5 | 25 | 50 |
| member (own business) | 40 | 1 | 40 | 80 |
| Platform Admin | 60 | 20 | 60 | 120 |
| integration peer | 100 | 50 | 0 | 0 |

L1's five launches are headroom for an admin who enables attended view-only, not an allowance.

**On a trip** the identity is **paused**: all new privileged work is refused with `IDENTITY_PAUSED` until **someone else** clears it. An alert is recorded and sent to every configured destination.

- **Pause and alert suppression are separate.** Suppressing an alert (24 h max, never about yourself) silences delivery only; it never lifts a pause.
- **Maintenance exceptions** let named computers past the cap for named kinds of work, until an expiry (7 days max). They need approval from someone who is neither the requester nor the beneficiary.
- Commands are **re-checked at dispatch**. A command queued by someone who has since been demoted, revoked or paused is not handed to the endpoint; it is marked `FAILED` with the reason.

## Independent review of trust

These changes are **not applied by the person who asks**. They become a pending request that a Platform Admin or independent reviewer, other than the requester, approves with fresh authentication:

- adding, removing or replacing an **alert destination** (the recovery contact);
- designating an **independent reviewer**;
- raising a threshold, shortening the window, allowing unattended / clipboard / file transfer, loosening consent or trusted workstations;
- removing `SERVER` from the protected classes (the four mandatory ones cannot be removed at all);
- re-classing a protected computer as unprotected;
- marking a workstation as a managed admin workstation;
- widening a preset.

The **previous** contacts are told when a change is requested and when it is decided. If the change replaces them, they are exactly who must hear about it. Before/after values are recorded. Webhook URLs are treated as secrets: shown and recorded as label, origin and a ref only, and an edited policy refers to an existing destination by its ref.

Tightening always applies at once. A **Business Owner** can tighten their own business (consent, unattended, clipboard, file transfer, extra protected classes, shorter sessions), never loosen it: the effective value is always the stricter of the platform and the business.

With a single Platform Admin and no reviewer, nothing that widens trust can be approved. That is intended: appoint a second person first.

## Fresh authentication

Every mutation under `/security-controls` needs a fresh re-authentication, **whatever step-up actions the platform has enabled**. Revoking a grant, clearing a request, and revoking a suppression or exception are the only exceptions: removing access must always be easy.

## Effective access inspector

**Settings → Security → Technician Access → Inspect** answers *technician + business + computer + action* with the decision, the reasons, and the grants it came from. It rebuilds the person's live actor exactly as a request would and asks the same questions the enforcement points ask. It changes nothing.

## Not built (shown as Unavailable)

- **Windows privileged helper.** None exists, so elevation cannot be enabled anywhere. Before one ships, it needs authenticated named-pipe IPC with a SID-restricted DACL, per-request signed intent from the portal, no arbitrary command surface, and tests for impersonation and pipe squatting.
- **Release signing and provenance.** Installers are generated per request by the API, not built by CI, and there is no signing workflow. Before one ships: isolate PR builds from signing secrets, pin workflow actions to commit SHAs, publish provenance and verify it at install, refuse installers built from forks, and separate signing keys per channel.
- **Device attestation for managed admin workstations** (see above).
- **A scheduler entry point.** There is none in this build; when one is added it must call `AbuseGuardService.admit()`.

## Evidence

| Check | Where |
|---|---|
| Preset grants and denials, launch-policy branches, widening, tighten-only, redaction, pairwise grants | `apps/api/scripts/unit-presets.mjs` (CI) |
| Static invariants (no connect from a preset, pairwise reach, launch policy wired in, advisory lock, no self-review, suppression never clears a pause) | `scripts/check-security-invariants.mjs` § 11 (CI) |
| Behaviour against a running API: every tier, same hostname in two businesses, conflicting groups, alternate membership, API keys, demotion mid-job, trust review, 40 concurrent jobs, stolen-session drill | `apps/api/scripts/e2e-presets.mjs` (scratch database only) |

## API

All under `/api/v1/security-controls`. See [API-REFERENCE.md](API-REFERENCE.md) for the generated route table.

| Route | Who |
|---|---|
| `GET catalog` | Platform Admin |
| `GET/PUT/DELETE presets…`, `POST presets/:id/clone`, `…/preview`, `…/reset` | `technicians:manage` |
| `GET/PUT policy`, `PUT policy/business/:id` | Platform Admin / that Business Owner |
| `GET inspect`, `GET upgrade-preview`, `GET trust-changes` | `technicians:manage` |
| `POST trust-changes/:id/decision` | independent reviewer |
| `POST temporary-access`, `…/:id/activate` | the technician |
| `POST temporary-access/:id/decision` | independent reviewer |
| `PATCH endpoints/:id/device-class`, `PATCH technician-devices/:id/managed` | Platform Admin |
| `GET pauses`, `POST pauses/:id/clear`, maintenance exceptions, alerts, suppressions | Platform Admin or independent reviewer |
