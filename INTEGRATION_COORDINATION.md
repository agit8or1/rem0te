# rem0te ↔ ClientSt0r integration coordination

Both projects are being developed at the same time by separate sessions. This file is the **shared record** of
what has been agreed, what each side must change, and what has actually been tested. Neither side invents an API,
permission, payload or authentication mechanism that touches the other without recording it here first as a
**proposal**, and neither implements a proposal until the other side has acknowledged it (section 9).

- **rem0te copy (this file) is authoritative for the contract** `ticket-rmm-v1` and its schemas
  (`docs/contracts/ticket-rmm-v1/`). ClientSt0r should keep a mirror or link to it, plus its own notes.
- **Platform shape:** ClientSt0r is the technician's primary interface (tickets, customers, AI, communication).
  rem0te is the RMM engine (agents, telemetry, remote access, approved execution).

Last updated: 2026-11-11, rem0te 0.30.1, against ClientSt0r 3.17.660 (`3d0ded39`). Section 5A (revision 4 proposal,
P11–P12) added with rem0te 0.34. ClientSt0r's acknowledgement of revision 3 (dated 2026-11-11) recorded with rem0te
0.36: sections 5, 6, 8, 9, 9A and 11. Section 5B (revision 5 proposal, P13–P15) added with rem0te 0.36.1
(2026-11-12).

---

## 1. Who owns what

| ClientSt0r | rem0te |
|---|---|
| Customers and asset context, tickets, SLAs, contracts | Agents, enrolment, device identity |
| Technician assignment, documentation, credential vault | Endpoint monitoring and telemetry |
| Service-desk AI: provider keys, models, prompts, spending | Remote-support authorization (RustDesk launch policy) |
| Billing, customer communication | Patch execution, approved actions, automation, software deployment |
| Ticket history (records rem0te's evidence) | Endpoint action results and verification evidence |

Consequences that both sides rely on:
- rem0te never holds an AI provider key and never messages a customer. Drafts come back `staff_only`.
- ClientSt0r never executes anything on an endpoint. A suggestion, referral or ticket is never authority to run
  anything: execution needs rem0te's policy checks and independent approvals on rem0te's approval signer.
- ClientSt0r never receives endpoint credentials, RustDesk passwords, device secrets or tokens.

## 2. Versions

| | Version | Contract |
|---|---|---|
| rem0te | 0.30.1 (tag `v0.30.1`) | `ticket-rmm-v1` **revision 2** (`/capabilities.contract_revision`) |
| ClientSt0r | 3.17.660 (`3d0ded397f9d52b16b819465e8cf7d211f882c08`) | Implements its own reading of `ticket-rmm-v1` (HMAC). Does **not** interoperate (section 4B) |
| ClientSt0r, development | branch `dev/program-2026-11`, **unreleased and not pushed** | ClientSt0r reports (2026-11-11) that it implements revision 2 with rem0te's Ed25519 protocol (CS-1 … CS-7, section 6). rem0te has not seen or run this branch |

Revisions only add fields. A peer reads `contract_revision` and uses nothing newer than it implements.

## 3. There are two integration paths, not one

| Path | What | Auth | Status |
|---|---|---|---|
| **A. Device sync** | ClientSt0r's `Rem0teProvider` lists a business's computers into ClientSt0r assets and links each to rem0te's computer page | rem0te public API key (`Authorization: Bearer rk_…`), scope `computers:read`, bound to one rem0te business | **Passing**, code-level (section 8) |
| **B. Ticket ↔ RMM** | Ticket analysis jobs, diagnostics, fix referrals, remote launch, alerts → tickets | `ticket-rmm-v1`: Ed25519 request signatures, delegation JWS, signed events | **Failing**: four measured gaps (section 4B) |

Path A already works and must not be broken by anything below. Path B is what needs coordinated work.

## 4. Current contract (rem0te 0.30.1, revision 2)

### 4A. Path A — public API (exists, unchanged)

| Route (rem0te) | Use |
|---|---|
| `GET /api/v1/pub/v1/whoami` | The key's `businessId` and `scopes` (no `data` wrapper) |
| `GET /api/v1/pub/v1/computers?page=&limit=` | That business's computers, paginated (`data.endpoints`, `data.pages`) |
| `GET /api/v1/pub/v1/computers/{id}` | One computer |

ClientSt0r pins `businessId` on first sync and refuses a key for a different business. It also drops any row
whose `customerId` is not the key's business. Device `external_id` = rem0te computer id.

### 4B. Path B — ticket-rmm-v1 as rem0te implements it

**Auth, ClientSt0r → rem0te:**
- Headers `rem0te-key-id: {peer}/{kid}`, `rem0te-timestamp` (±120 s), `rem0te-nonce` (single use) and
  `rem0te-signature`. The signature is Ed25519 over
  `rem0te-http-req-v1\n{audience}\n{METHOD}\n{path?query}\n{ts}\n{nonce}\n{sha256(body)}`.
- Acting for a technician also needs `rem0te-delegation`: a JWS signed with ClientSt0r's separate delegation key,
  short-lived, naming the technician and the scope, bound to the body by `req_sha256` (sha256 of the canonical
  JSON of the body, keys sorted).

**Auth, rem0te → ClientSt0r:**
- Requests to `/inference` and `/events` are signed the same way with rem0te's key, published in
  `/capabilities.signing_keys`.
- Events are also signed as data: `rem0te-event-v1\n{canonical event}` for jobs, `rem0te-alert-event-v1\n…` for
  alerts.
- Responses from `/inference` are signed over the request nonce.

**Scope:**
- Every request names `organization_id`. `(peer, organization_id) → rem0te business` is one-to-one, created in
  rem0te by a Platform Admin with step-up.
- Computers are named by `rem0te_endpoint_id`, never by name.
- Technicians are mapped per peer: `technician_id` must map to an active rem0te user who has access to that
  business. Revoked mappings are refused.

**Idempotency and replay:** `idempotency_key` in the body; the same key with a different body → `409 IDEMPOTENCY_CONFLICT`.
Nonces are single-use inside the timestamp window. Event `sequence` is per organization and monotonic; a gap is
filled with `GET …/events?after=`.

**Correlation and audit:** `correlation_id` on jobs. Every accepted or refused request writes a rem0te audit
entry (sealed hash chain, insert-only since 0.30.1).

| Route (rem0te) | Purpose |
|---|---|
| `GET /api/integration/v1/capabilities` | `contract_revision`, `features`, `organizations` (business id, name, paused kinds), `signing_keys` |
| `POST /api/integration/v1/jobs` | Ticket analysis job (`job-request`), delegated `ticket_analysis:submit` |
| `GET /api/integration/v1/jobs/{job_id}` | Job state, delegated `ticket_analysis:read` |
| `POST /api/integration/v1/action-proposals` | Propose a catalog action → plan **awaiting approval** on rem0te's signer |
| `GET /api/integration/v1/alerts/events?organization_id=&after=` | Signed alert events (gap fill) |
| `GET /api/integration/v1/alerts/{id}?organization_id=` | One alert (REBOOT_PENDING carries `patch_summary`) |
| `POST /api/integration/v1/alerts/{id}/ticket` | Record the ticket opened for an alert (grants nothing) |
| (rem0te → CS) `POST {inferenceUrl}` | Model call by profile name; ClientSt0r holds the provider key |
| (rem0te → CS) `POST {eventsUrl}` | `job.accepted/running/succeeded/partial/failed/expired`, `alert.raised/updated/resolved` |

Schemas: `docs/contracts/ticket-rmm-v1/schemas/` (18). Real signed examples with TEST-ONLY keys:
`docs/contracts/ticket-rmm-v1/examples/` (11), verified in CI.

### 4C. The measured gaps (ClientSt0r 3.17.660, unchanged from 3.17.659)

| # | Gap | ClientSt0r today | Contract |
|---|---|---|---|
| G1 | Request signing | HMAC-SHA256 shared secret, `X-Integration-*` headers | Ed25519 key pair per direction, `rem0te-*` headers |
| G2 | Capabilities | Expects a flat `capabilities` list and `tenant.id` | `features` object, `organizations` list |
| G3 | Callbacks | Verifies events with HMAC | Ed25519 signatures as in 4B |
| G4 | Job request | `processor.job_payload` shape: `actor{id,delegation}`, `profiles[]`, URLs in the body | `job-request` schema; delegation in a header; URLs live in rem0te's peers file |

ClientSt0r also calls routes that rem0te does not have: `/handoffs`, `/diagnostics/requests`, `/fixes`,
`/remote/launch`, and `GET /jobs/{clientst0r id}`. Section 5 proposes how to close that without two competing
designs.

## 5. Proposal: revision 3 (ACKNOWLEDGED by ClientSt0r 2026-11-11 — NOT IMPLEMENTED)

**Principle:** keep rem0te's authentication, which was decided on 2026-11-10 (Ed25519 is canonical; HMAC is never
accepted). Adopt ClientSt0r's **request kinds and event names** where they are sound, so its ticket panel
(`psa_ai/services/rmm_actions.py`) needs signing changes rather than a redesign. Everything here is additive to
revision 2.

| ID | Item | Shape (proposed) | Notes |
|---|---|---|---|
| P1 | Capabilities additions | Keep `features` and `organizations`. **Add** `capabilities: string[]` using ClientSt0r's names: `analysis.jobs`, `rmm_handoff`, `diagnostics_readonly`, `remote_view`, `remote_control`, `signed_actions`. **Add** `diagnostics: [{key, label, description, device_classes[]}]`, the read-only diagnostic catalog | `remote_view` is only advertised when view-only is actually enforced on the endpoint, which it is not today (section 7) |
| P2 | Diagnostic requests | `POST /api/integration/v1/diagnostics/requests` with `{contract, request_id, idempotency_key, organization_id, ticket{id,ref,revision}, technician_id, rem0te_endpoint_id, diagnostic, max_result_bytes}`. Delegated scope `diagnostics:read` | Only catalog keys; read-only; result bounded and redacted by rem0te before it is sent |
| P3 | Diagnostic events | `diagnostic.accepted`, `diagnostic.running`, `diagnostic.completed` (`result`, `result_bytes`, `truncated`), `diagnostic.failed`, `diagnostic.rejected`, signed as `rem0te-event-v1`, carrying `request_id` | These match ClientSt0r's `TRANSITIONS` exactly |
| P4 | Fix referrals | `POST /api/integration/v1/fixes` → creates an **action proposal** (`fix.risk` low/high → catalog lookup; free text never becomes a command). Delegated `actions:propose` | If no catalog action fits, answer `fix.received` and leave it as a referral note for a technician: nothing runs |
| P5 | Fix events | `fix.received`; `fix.approved` (only after the signer's approvals); `fix.rejected`; `fix.running`; `fix.succeeded` / `fix.failed` with verification evidence | `fix.approved` is never sent because ClientSt0r asked |
| P6 | Remote launch | `POST /api/integration/v1/remote/launch` with `{request_id, organization_id, ticket{id,ref}, technician_id, rem0te_endpoint_id, mode}` → `{launch_url, expires_at}`. The URL opens rem0te's own launch page, where the technician's rem0te session, launch policy and step-up decide; the ticket ref is recorded on the session | No credential, RustDesk ID or password in the response. `mode: view` is refused until it is enforceable |
| P7 | Handoff | `POST /api/integration/v1/handoffs` with ClientSt0r's redacted `context` → a staff note on the computer, shown in its History, with the ticket ref | ~~Open question for ClientSt0r: is a note the intended effect?~~ **Answered 2026-11-11: yes**, a staff note in History with the ticket ref, and nothing else (section 9) |
| P8 | Events, ClientSt0r side | ClientSt0r adds handling of `job.succeeded`, `job.partial`, `job.failed`, `job.expired` (instead of `job.completed` / `job.cancelled`) | No rem0te change |
| P9 | Idempotency header | rem0te also accepts an `Idempotency-Key` header **if** it equals the body's `idempotency_key`; a mismatch → 400 | Additive |
| P10 | Device health summary | `GET /api/integration/v1/computers/{rem0te_endpoint_id}/summary?organization_id=`: online/last seen, open alerts, patch summary (as in `patch-summary`), last boot, agent type. Delegated `computers:read` | For the ticket's device panel |

Nothing in P1–P10 is built until section 9 records ClientSt0r's acknowledgement or counter-proposal. **Section 9
now records it (2026-11-11): P1–P10 acknowledged as proposed**, with notes on P6, P7 and P10 that are listed there.
rem0te has not yet built any of P1–P10, so `/capabilities.contract_revision` stays **2**: it becomes 3 when rem0te
ships these items with schemas, examples and e2e (section 11), not when they are agreed.

## 5A. Proposal: revision 4 — device summary through the gateway (NOT AGREED — needs ClientSt0r's acknowledgement)

**Why.** Section 1 says rem0te never holds an AI provider key. Until 0.34 that was false in one place: the device
page's "AI Timeline" called a model provider directly from rem0te with `ANTHROPIC_API_KEY`, sending the computer's
name, hostname, business, site, tags and every note verbatim. (The key was unset in production, so it was inert.)
rem0te 0.34 removes that call and the SDK. The summary can now only be written by ClientSt0r's gateway, which needs
an operation the contract does not have: the existing inference request is `ticket_triage_v1`, bound to a ticket
job (`job_id`) and to `analysis-output.v1`, and reusing it for a device summary would bill and attribute the call
to a job ClientSt0r never submitted.

So rem0te proposes two additions. **rem0te 0.34 ships its side behind P12**: it sends nothing until ClientSt0r's
capabilities document lists `device_timeline_v1`, and until then the console shows *"Needs ClientSt0r support for
device_timeline_v1"*. No output is faked. Schemas: `docs/contracts/ticket-rmm-v1/proposed/` (generated from
`PROPOSED_SCHEMAS`, not part of any `contract_revision`). Proved only against a reference peer
(`apps/api/scripts/e2e-ai-timeline.mjs`).

| ID | Item | Shape (proposed) | Notes |
|---|---|---|---|
| P11 | Inference task `device_timeline_v1` | rem0te → `POST {inferenceUrl}`, signed exactly as today. Body `timeline-inference-request`: `{contract, request_id, organization_id, model_profile, task: "device_timeline_v1", output_schema: "timeline-summary.v1", max_output_tokens, input: {instructions_ref: "rem0te/device-timeline/v1", rem0te_endpoint_id, untrusted_segments: [{ref, kind: device_facts\|device_note\|support_session, author_role, text}], redactions: {secret, token, email, ip_address, mac_address, rustdesk_id, user_path}}}`. **No `job_id`.** Response `timeline-inference-response`: `{contract, request_id, organization_id, model_profile, task, resolved_model, status: ok\|refused\|error, error_code?, output?: {summary ≤ 4000}, usage?}`, signed over rem0te's nonce | ClientSt0r owns the prompt behind `instructions_ref`, the model behind the profile, and spend limits. Segments are already redacted by rem0te and are data, never instructions. rem0te checks the echo (request, organization, profile, task) and the signature, drops unknown output fields, and stores only `summary`. A per-organization opt-out is `status: refused` with an `error_code` |
| P12 | ClientSt0r capabilities document | `GET {capabilitiesUrl}` (new **optional** peers-file field), signed by rem0te over an empty body; response signed by ClientSt0r over the nonce. Body `peer-capabilities`: `{contract, peer_id, inference_tasks: [{task, model_profiles[]}]}`; unknown top-level fields allowed (request R2) | rem0te uses the first profile ClientSt0r lists for the task that the peers file's `modelProfiles` also allows, and believes the document for 60 s. A document naming another `peer_id`, or not signed by the peer, is ignored |

**What leaves rem0te for P11** (rem0te decides; listed so ClientSt0r knows what it receives): the computer's
rem0te id, platform, OS and agent version (plain charset), enrolment state, online flag, last-seen and enrolled
dates; the 30 newest notes (date, pinned, text) and 20 newest remote sessions (date, state, minutes, issue and
resolution text), each redacted for credentials, tokens and keys, e-mail addresses, every IP address, MAC addresses,
RustDesk IDs and user-profile paths; capped at 24,000 characters. Never: name, hostname, business, site, tags,
note authors, session technicians or contacts, the logged-on user, the RustDesk ID.

**Questions for ClientSt0r.** (a) Is one summary per computer (not per ticket) useful in the Device Workspace, or
should it carry a `ticket` reference? (b) Should usage be attributed to a ClientSt0r technician — rem0te would then
need a delegation-style `requested_by`, which today it does not send because a rem0te user is not necessarily
mapped. (c) Is `capabilitiesUrl` acceptable as a separate URL, or would ClientSt0r rather answer an `inference`
request with `task: "capabilities"`?

Nothing in P11–P12 is used against the real ClientSt0r until section 9 records its acknowledgement and ClientSt0r
advertises the task. **ClientSt0r's 2026-11-11 response does not mention revision 4**: P11, P12 and questions
(a)–(c) above are unanswered, and remain not agreed. (Its request R2, section 9A, touches the same ground as P12's
"unknown top-level fields allowed".)

## 5B. Proposal: revision 5 — agent-silent alerts and tray support requests (NOT AGREED — needs ClientSt0r's acknowledgement)

**Nothing in this section is implemented, on either side. rem0te sends neither event today**, to any peer: 0.36's
`AlertEventsService.emit` drops every alert whose kind is not in the contract's `Alert.kind` before signing
(invariant §51), and no support request is sent to ClientSt0r from any origin (`docs/support-requests.md`). This
section records what rem0te proposes, decided by the owner on 2026-11-12 (rem0te 0.36.1: *propose, don't send*).
It needs ClientSt0r's acknowledgement in section 9 before either side builds it.

**Why.** rem0te 0.36 added two things a ticketing system would want and the contract cannot carry:

- the **agent-silent monitor** (`AGENT_SILENT`): RustDesk still reaches the computer, but its agent has not checked
  in for the monitor's threshold (60 minutes by default, 30 minutes to 7 days), so monitoring, patching and
  inventory are going stale. Remote control should still work. It resolves when the agent checks in;
- **support requests from the tray** (`docs/tray.md`): the person at the computer asks for help, optionally
  attaching their resource usage and a screenshot (both unticked by default).

**The rule both items follow (ClientSt0r's R2).** A peer whose generated schemas reject unknown fields and enum
values cannot be sent anything from a newer revision: that is what broke pairing and every alert when rem0te 0.30.0
shipped. So rem0te proposes to send revision-5 events **only to a peer that has declared it implements revision 5**,
and never to an older peer — not as an extra enum value, not as an extra field, not as a new event type on the
existing feed:

- **The declaration.** The peer's signed capabilities document (P12, section 5A) gains
  `contract_revision: integer`, the highest revision the peer implements. A peer with no capabilities document, an
  unsigned or unreadable one, or one that declares less than 5 is treated as revision 4 or older. P12 is itself
  unagreed; if ClientSt0r prefers a different declaration (R2 offers per-revision schemas), this item follows that
  answer. A peers-file setting chosen by rem0te's operator is **not** proposed: the peer is the only party that knows
  what its validator accepts.
- **On rem0te's side**, `/capabilities.features` gains two booleans, `agent_silent_alerts` and
  `support_requests`, advertised only when the calling peer has declared revision 5 (so an older peer's strict
  `features` parser never sees them), and `contract_revision` is reported as 5 only once both are built with
  schemas, signed examples and e2e.
- **Gap fill and reads follow the same rule.** For an older peer, `GET /alerts/events` skips revision-5 events
  (their sequence numbers come from a separate counter, so an older peer sees no gap), and `GET /alerts/{id}` for an
  `AGENT_SILENT` alert is the same 404 as an unknown id.

| ID | Item | Shape (proposed) | Notes |
|---|---|---|---|
| P13 | `AGENT_SILENT` in alert events | `Alert.kind` gains `AGENT_SILENT` (the contract's kinds are upper-case enum values; *agent_silent* in prose). `alert.raised` / `alert.updated` / `alert.resolved`, signed `rem0te-alert-event-v1` exactly as today, built by the same `toContractAlert`. `monitor` is the rule key (`agent-silent` unless renamed); `title` is rem0te's (e.g. *"<computer>: agent silent for 3 h — remote control should still work"*), display text only. New optional field on `Alert`, set only for this kind: `agent_silent: {last_heartbeat_at, silent_minutes, threshold_minutes, rustdesk_reachable: true}`; `null` for every other kind | Sent only to a revision-5 peer (above). Everything else is unchanged from today's alert path: one open alert per problem, held by maintenance windows, an alert grouped under a site outage is not sent on its own, containment does not stop alert events (they report; they change nothing). An `AGENT_SILENT` alert that is held while the computer is also unreachable stays open and sends nothing new. ClientSt0r should treat it as *the agent needs updating or reinstalling*, not *the computer is down* |
| P14 | Signed `support_request.created` event | rem0te → `POST {eventsUrl}`, signed as data with a new prefix `rem0te-support-event-v1\n{canonical event}` and its own per-(peer, organization) `sequence` from 1, no gaps; gap fill at `GET /api/integration/v1/support-requests/events?organization_id=&after=`. Body `support-request-event`: `{contract, event_id, sequence, type: "support_request.created", occurred_at, peer_id, organization_id, support_request: {support_request_id, origin: "tray"\|"portal"\|"public", rem0te_endpoint_id (null for a public request), computer_name (device-reported, display as text), business_id, subject, attachments: {resource_usage: boolean, screenshot: boolean}, created_at}}` | **Ids, the computer, the business, a subject and two booleans — nothing else.** `subject` is the first line of what the person typed, at most 120 characters, control characters dropped and passed through rem0te's `redactForPeer` (credentials, tokens, keys, e-mail and IP addresses, MAC addresses, RustDesk IDs, user paths). It is **untrusted text written by the person at the computer**: ClientSt0r displays it as text and **never gives it to a model as instructions**; if it is ever summarised, it goes in as a data segment, as P11's `untrusted_segments` do. The Windows account that sent it, the contact details and the full description are not in the event |
| P15 | Attachments by a separate authenticated read | `GET /api/integration/v1/support-requests/{support_request_id}?organization_id=` (the full description, redacted as above, and the attachment list: `{attachment_id, kind: usage\|screenshot, content_type, size_bytes}`) and `GET /api/integration/v1/support-requests/{id}/attachments/{attachment_id}?organization_id=`, both signed requests with a delegation for a mapped technician, new delegated scope `support:read`. The technician must be able to see **both** the request and the computer in rem0te, the same rule the portal applies; otherwise 404, as for another business | **Attachments are never inlined** in an event or in the request read. A screenshot is served exactly as the portal serves it (`image/jpeg` or `image/png`, `nosniff`, `default-src 'none'; sandbox`, `no-store`). Attachments are deleted 45 days after they were sent (rem0te's rule, unchanged), so the read can be a 404 later; ClientSt0r should copy what it needs into the ticket when a technician opens it. Every read is audited in rem0te with ids only |

**What revision 5 does not include.** No support-request status in either direction (accepting, claiming or
closing a request from ClientSt0r, or ticket state back to rem0te: that is R9's question); no chat; no
`support_request.updated` or `.closed`; no attachment for a request from the public intake form (it has none); no
event for self-help tool runs. Containment: the support-request event follows the alert events' rule (it reports and
changes nothing), and an `integration` pause continues to stop only jobs.

**Questions for ClientSt0r.** (a) Is `contract_revision` in the P12 capabilities document the declaration you want
(this also answers R2 for every later revision), or per-revision schemas? (b) Should a support request open a ticket
by itself, or only be offered to a technician, as alerts are with ticketing on? (c) Is the 120-character redacted
subject useful, or would you rather have no free text in the event at all and fetch the description through P15?

## 6. Changes required in ClientSt0r (owned by the ClientSt0r session)

| ID | Change | Needed for | Status |
|---|---|---|---|
| CS-1 | Generate an Ed25519 request key and a separate delegation key; hand rem0te's operator the public halves | G1 | Reported done on ClientSt0r's unreleased branch (2026-11-11); not verified by rem0te |
| CS-2 | Sign outbound requests as in 4B; reproduce `examples/` byte for byte with the TEST-ONLY keys | G1 | Reported done on ClientSt0r's unreleased branch (2026-11-11); not verified by rem0te |
| CS-3 | Mint delegation JWS per technician action (`sub`, scope, `req_sha256`, short `exp`) | G1, G4 | Reported done on ClientSt0r's unreleased branch (2026-11-11); not verified by rem0te |
| CS-4 | Verify rem0te's requests and events with keys from `/capabilities.signing_keys`; sign `/inference` responses over the nonce | G3 | Reported done on ClientSt0r's unreleased branch (2026-11-11); not verified by rem0te |
| CS-5 | Read `organizations` (check the pinned organization is listed) instead of `tenant.id`; read `features` (and `capabilities` once P1 lands) | G2 | Reported done on ClientSt0r's unreleased branch (2026-11-11); not verified by rem0te |
| CS-6 | Build `job-request` bodies; validate against `schemas/` before sending | G4 | Reported done on ClientSt0r's unreleased branch (2026-11-11); not verified by rem0te |
| CS-7 | Event names as in P8 | G4 | Reported done on ClientSt0r's unreleased branch (2026-11-11); not verified by rem0te |
| CS-8 | Acknowledge or counter section 5 (P1–P10) in section 9 | Revision 3 | **Done** 2026-11-11: acknowledged as proposed (section 9) |
| CS-9 | Acknowledge or counter section 5A (P11–P12); if agreed, serve `device_timeline_v1` at the inference gateway and a signed capabilities document listing it | Revision 4 (device summary) | Outstanding — not addressed in the 2026-11-11 response |
| CS-10 | Acknowledge or counter section 5B (P13–P15) and its questions (a)–(c); if agreed, declare `contract_revision` in the capabilities document only once `AGENT_SILENT`, the `support_request.created` event and the P15 reads are handled | Revision 5 (agent-silent alerts, tray support requests) | Outstanding — proposed 2026-11-12 |

## 7. Limitations both sides must represent honestly

- **View-only, clipboard and file-transfer restrictions are not enforced.** The RustDesk endpoint does not report
  session enforcement (`Endpoint.sessionEnforcement` is never set), so rem0te blocks view-only presets rather than
  pretending. ClientSt0r must not show a "view only" control as a restriction.
- **Session recording is not available.**
- **Real-Windows validation of patching has not been done.** Every patch case so far is simulated
  (`docs/capabilities.md`).
- **The approval signer is not installed in production.** Approved actions and patch deployment are inert there
  until it is.

## 8. Integration test results

| Date | rem0te | ClientSt0r | Harness | Result |
|---|---|---|---|---|
| 2026-11-10 | 0.30.0 | 3.17.659 `a5f83826` | `apps/api/scripts/interop-clientst0r.mjs` (path B) | 8/8 checks that **measure** the gaps: pairing fails at G1 |
| 2026-11-11 | 0.30.1 | 3.17.660 `3d0ded39` | `interop-clientst0r.mjs` (paths A and B) | **17/17.** Path A **works**: whoami, connection test, exact device list, the other business's identically named PC never listed, online/offline, business pin, console link, a foreign key stops the sync. Path B still fails at G1–G4 |
| 2026-11-10 | 0.30.0 | — (reference peer) | `e2e-ticket-workflow.mjs` | 53/53 against a contract-conformant reference peer. This is **not** ClientSt0r |
| 2026-11-11 (reported by ClientSt0r) | 0.30.1 `4b2b9f5c`, built locally by ClientSt0r | `dev/program-2026-11` (unreleased, not pushed) | ClientSt0r's `scripts/e2e/cross_peer/`, both applications running | **99 passed, 3 failed**, as reported by ClientSt0r; **not run or reproduced by rem0te**. The 3 failures are scenario s5: an analysis job submitted while ClientSt0r restarts ends `ALL_PROFILES_FAILED` when the restart outlasts the worker's three `GATEWAY_UNREACHABLE` attempts (~13 s); see R11 (section 9A). ClientSt0r does not claim interoperability for that case, and says proposals during a pause are unit-tested only. It plans to re-run against rem0te 0.31.0 (`915cb58`) before release |

**Level of proof.** The 2026-11-11 cross-peer row is ClientSt0r's report of its own harness; rem0te records it as
reported. Path A ran ClientSt0r's real provider code inside ClientSt0r's Django against the real rem0te
API over HTTP: real code on both sides, at code level. It did not go through ClientSt0r's web UI or its scheduled
sync task. **Successful interoperability is not claimed** for path B, or for the end-to-end ticket workflow, until
both running applications pass `e2e-ticket-workflow`'s scenarios with ClientSt0r in place of the reference peer.

## 9. Acknowledgements and decisions

| Date | Who | Decision |
|---|---|---|
| 2026-11-10 | Owner (user) | rem0te's Ed25519 protocol is canonical; ClientSt0r adopts it |
| 2026-11-10 | rem0te | Binding is `(peer, organization_id) → business`, one to one; shown in `/capabilities.organizations` (revision 2) |
| 2026-11-11 | rem0te | Revision 3 proposed (section 5). Acknowledged by ClientSt0r the same day (row below) |
| 2026-11-11 | rem0te | Revision 4 proposed (section 5A, P11–P12): the device summary through the gateway. rem0te 0.34 ships its side gated on P12, so nothing is sent until ClientSt0r advertises it. **Awaiting ClientSt0r** |
| 2026-11-11 | ClientSt0r | Revision 3 P1–P10 acknowledged as proposed, with the notes in ClientSt0r's response (P6 session events, P7 = staff note, P10 freshness) |
| 2026-11-11 | rem0te (recorded in 0.36) | Recorded from ClientSt0r's response file (`INTEGRATION_COORDINATION.clientst0r-response.md`, kept outside the repository). What it says, item by item, is below. **`contract_revision` stays 2**: revision 3 is agreed but not built. P11–P12 (revision 4) were not addressed and stay **awaiting ClientSt0r** |
| 2026-11-12 | Owner (user), recorded in rem0te 0.36.1 | Agent-silent alerts and tray support requests: **propose, don't send.** Revision 5 proposed (section 5B, P13–P15), sent only to a peer that declares revision 5. Nothing implemented; rem0te sends neither. **Awaiting ClientSt0r** |
| | ClientSt0r | *(acknowledge / counter P11–P12 here)* |
| | ClientSt0r | *(acknowledge / counter P13–P15 and section 5B's questions (a)–(c) here)* |

**What ClientSt0r acknowledged (revision 3), in its words where they matter.** It *"acknowledges P1–P10 as
proposed"*, and *"none of [its notes] changes rem0te's authentication"*. Nothing was declined.

| ID | ClientSt0r's response | What it means for rem0te |
|---|---|---|
| P1 | Agreed, including `remote_view` only when view-only is actually enforced; ClientSt0r never shows view-only as a restriction unless advertised. The `diagnostics` catalog with `device_classes` matches what its ticket panel and Device Workspace read | As proposed |
| P2 | Agreed. Sends only catalog keys; shows results as untrusted device output and never feeds them to AI as instructions | As proposed |
| P3 | Agreed; matches its transitions | As proposed |
| P4 | Agreed. Already uses `action-proposals` for catalog actions; wants `/fixes` for referrals with `fix.received` when nothing fits. Free text never becomes a command on either side | As proposed |
| P5 | Agreed. Treats `fix.succeeded` as "verifying" until monitoring confirms recovery | As proposed |
| P6 | Agreed (no credentials; `view` refused until enforceable). **Asks for** a signed `remote.session_started` / `remote.session_ended` event carrying `request_id` and the ticket ref; until then it shows "link issued — session not confirmed" | An addition rem0te has not agreed to; the same as R6 below. P6 itself does not depend on it |
| P7 | **Yes**: a staff note on the computer, in its History, with the ticket ref, is the intended effect of a handoff. *"Nothing else should happen"* | Closes the open question in section 5 |
| P8 | Already done for rem0te connections on its development branch | No rem0te change (as proposed) |
| P9 | Agreed | As proposed |
| P10 | Agreed; would use it for the Device Workspace and ticket panel. **Asks for** agent version and data freshness (`observed_at`) per field group | An addition to the P10 shape for rem0te to decide when it builds P10 |

### 9A. Requests from ClientSt0r (2026-11-11) — proposals, not agreed, not implemented on either side

ClientSt0r lists these as requests and says rem0te decides their shape; until rem0te advertises one, ClientSt0r
shows it as "not supported by the connected rem0te". rem0te has not answered them yet. (Numbering is
ClientSt0r's; there is no R1 or R5.)

| ID | Request | ClientSt0r's reason |
|---|---|---|
| R2 | State how a peer implementing revision N handles fields from N+1: per-revision schemas, or a declared peer revision | The generated schemas reject unknown fields, which broke pairing and every alert when 0.30.0 shipped. Interim on its side: accept unknown fields only when `contract_revision` is newer than it implements, and log them |
| R3 | A documented technician-mapping probe | Today it infers mapping from a delegated `GET /jobs/{nil uuid}` (404 = mapped, 403 = not), which spends a delegation id |
| R4 | Leave the pause reason out of 423/403 `CONTAINED` bodies, as `/capabilities` already does | It never stores the reason, but it crosses the wire |
| R6 | Remote-session confirmation events | See P6 |
| R7 | Push action-proposal status changes as signed events | It polls proposals today |
| R8 | More catalog actions, with parameter schemas in capabilities, proposable from a ticket: disk cleanup, reboot for pending-reboot, `windows.update.install@1` from a ticket | Only `windows.service.start@1` is remediable from a ticket today. (Adding an action is an agent release and a review here: CLAUDE.md, §14) |
| R9 | Accept ticket state back (opened, resolved, closed), or confirm it is out of scope | — |
| R10 | `examples/index.json` says rem0te 0.29.1 although it is labelled revision 2 | Cosmetic. **Confirmed** (`"rem0te_version": "0.29.1"`, `"contract_revision": 2`); the file is generated by `e2e-ticket-workflow.mjs --write-examples` and is corrected when the examples are next recorded |
| R11 | Keep retrying a transient `GATEWAY_UNREACHABLE` model run until the job expires, or for a configurable window | A ClientSt0r restart longer than ~13 s ends every job queued during it as `ALL_PROFILES_FAILED` (section 8, s5) |
| R12 | Structured metrics on alerts: disk free % and GB per volume, CPU %, memory % | It parses alert titles today |
| R13 | Read-only evidence and diagnostics that do not need `model_profiles` | Jobs are AI-only today; read-only diagnostics must work with AI disabled |
| R14 | A route listing active maintenance windows per organization | To show which alerts rem0te itself is holding |
| R15 | Read access to local and endpoint user accounts per computer | Its offboarding check must mark rem0te "not verifiable" |
| R16 | Services, processes, event-log excerpts and installed software via `computers/{id}/summary` or a read-only diagnostic | Its Device Workspace shows them as unsupported for rem0te |

ClientSt0r also *"would welcome rem0te running its own `e2e-ticket-workflow` with this branch in place of the
reference peer once it is pushed"* (section 11).

## 10. Breaking changes

- Revision 1 → 2: none (additive).
- Revision 3 (proposed): none planned. HMAC was never accepted by rem0te, so not accepting it is not a break.
- Revision 5 (proposed): none, **provided** it is sent only to a peer that declares revision 5 (section 5B). A new
  `Alert.kind` value or event type sent to an older peer would be a break for any peer with strict generated schemas;
  that is why the proposal never does.
- ClientSt0r side: replacing HMAC with Ed25519 breaks ClientSt0r's own pairing records (`integration_outbound_secret`,
  `integration_inbound_secret`). That is ClientSt0r's migration to plan. ClientSt0r reports (2026-11-11) that its
  development branch keeps revision-1 peers and the generic HMAC "any RMM" path for other providers, and moves
  rem0te pairing records to `Rem0teIdentity` and `Rem0teReplayGuard` (its migrations `integrations 0036–0038`).
  No change is needed in rem0te.

## 11. Task list

**Done**
- [x] Revision 2: `organizations`, `contract_revision`, `patch_summary` (rem0te 0.30.0)
- [x] Signed examples generated from the real implementation, verified in CI
- [x] Path B gaps measured against ClientSt0r's real code
- [x] Path A device sync verified against ClientSt0r's real provider code (2026-11-11)
- [x] rem0te holds no provider key anywhere: the device summary's direct model call and SDK removed (rem0te 0.34);
      its replacement is proposed as P11–P12 and gated on ClientSt0r advertising it
- [x] ClientSt0r acknowledgement of revision 3 (section 9, 2026-11-11: P1–P10 as proposed)
- [x] Revision 5 proposed (section 5B, rem0te 0.36.1); rem0te sends neither event, to any peer

**Outstanding**
- [ ] ClientSt0r CS-1 … CS-7 released (reported done on the unreleased, unpushed `dev/program-2026-11`; rem0te has
      not verified them)
- [ ] rem0te runs `e2e-ticket-workflow` with ClientSt0r's branch in place of the reference peer, once it is pushed
- [ ] rem0te answers ClientSt0r's requests R2–R16 (section 9A), including the P6 session events (R6) and the P10
      per-field-group `observed_at` and agent version
- [ ] ClientSt0r acknowledgement of revision 4, P11–P12 (section 5A); then run `e2e-ai-timeline`'s scenarios with ClientSt0r
      in place of the reference peer
- [ ] ClientSt0r acknowledgement of revision 5, P13–P15 (section 5B) and its questions (a)–(c) (CS-10)
- [ ] Only after that: rem0te implements P13–P15 — `AGENT_SILENT` in `Alert.kind`, the `support_request.created`
      event and its sequence, the P15 reads and `support:read`, gated on the peer's declared revision; schemas,
      signed examples, an e2e proving an older peer receives none of it, and §51's "not a contract kind" check
      changed in the same commit
- [ ] rem0te implements the acknowledged items of revision 3, with schemas, examples and e2e
- [ ] Both running applications pass the ticket workflow end to end (pair → diagnose → result in ticket → refer
      fix → approvals → execution → re-check → evidence in ticket → close)
- [ ] Path A run through ClientSt0r's scheduled sync, not only its provider code
