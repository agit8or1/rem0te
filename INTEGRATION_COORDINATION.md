# rem0te ↔ ClientSt0r integration coordination

Both projects are being developed at the same time by separate sessions. This file is the **shared record** of
what has been agreed, what each side must change, and what has actually been tested. Neither side invents an API,
permission, payload or authentication mechanism that touches the other without recording it here first as a
**proposal**, and neither implements a proposal until the other side has acknowledged it (section 9).

- **rem0te copy (this file) is authoritative for the contract** `ticket-rmm-v1` and its schemas
  (`docs/contracts/ticket-rmm-v1/`). ClientSt0r should keep a mirror or link to it, plus its own notes.
- **Platform shape:** ClientSt0r is the technician's primary interface (tickets, customers, AI, communication).
  rem0te is the RMM engine (agents, telemetry, remote access, approved execution).

Last updated: 2026-11-11, rem0te 0.30.1, against ClientSt0r 3.17.660 (`3d0ded39`).

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

## 5. Proposal: revision 3 (NOT IMPLEMENTED — needs ClientSt0r's acknowledgement)

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
| P7 | Handoff | `POST /api/integration/v1/handoffs` with ClientSt0r's redacted `context` → a staff note on the computer, shown in its History, with the ticket ref | **Open question for ClientSt0r:** is a note the intended effect? |
| P8 | Events, ClientSt0r side | ClientSt0r adds handling of `job.succeeded`, `job.partial`, `job.failed`, `job.expired` (instead of `job.completed` / `job.cancelled`) | No rem0te change |
| P9 | Idempotency header | rem0te also accepts an `Idempotency-Key` header **if** it equals the body's `idempotency_key`; a mismatch → 400 | Additive |
| P10 | Device health summary | `GET /api/integration/v1/computers/{rem0te_endpoint_id}/summary?organization_id=`: online/last seen, open alerts, patch summary (as in `patch-summary`), last boot, agent type. Delegated `computers:read` | For the ticket's device panel |

Nothing in P1–P10 is built until section 9 records ClientSt0r's acknowledgement or counter-proposal.

## 6. Changes required in ClientSt0r (owned by the ClientSt0r session)

| ID | Change | Needed for | Status |
|---|---|---|---|
| CS-1 | Generate an Ed25519 request key and a separate delegation key; hand rem0te's operator the public halves | G1 | Outstanding |
| CS-2 | Sign outbound requests as in 4B; reproduce `examples/` byte for byte with the TEST-ONLY keys | G1 | Outstanding |
| CS-3 | Mint delegation JWS per technician action (`sub`, scope, `req_sha256`, short `exp`) | G1, G4 | Outstanding |
| CS-4 | Verify rem0te's requests and events with keys from `/capabilities.signing_keys`; sign `/inference` responses over the nonce | G3 | Outstanding |
| CS-5 | Read `organizations` (check the pinned organization is listed) instead of `tenant.id`; read `features` (and `capabilities` once P1 lands) | G2 | Outstanding |
| CS-6 | Build `job-request` bodies; validate against `schemas/` before sending | G4 | Outstanding |
| CS-7 | Event names as in P8 | G4 | Outstanding |
| CS-8 | Acknowledge or counter section 5 (P1–P10) in section 9 | Revision 3 | Outstanding |

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

**Level of proof.** Path A ran ClientSt0r's real provider code inside ClientSt0r's Django against the real rem0te
API over HTTP: real code on both sides, at code level. It did not go through ClientSt0r's web UI or its scheduled
sync task. **Successful interoperability is not claimed** for path B, or for the end-to-end ticket workflow, until
both running applications pass `e2e-ticket-workflow`'s scenarios with ClientSt0r in place of the reference peer.

## 9. Acknowledgements and decisions

| Date | Who | Decision |
|---|---|---|
| 2026-11-10 | Owner (user) | rem0te's Ed25519 protocol is canonical; ClientSt0r adopts it |
| 2026-11-10 | rem0te | Binding is `(peer, organization_id) → business`, one to one; shown in `/capabilities.organizations` (revision 2) |
| 2026-11-11 | rem0te | Revision 3 proposed (section 5). **Awaiting ClientSt0r** |
| | ClientSt0r | *(acknowledge / counter P1–P10 here)* |

## 10. Breaking changes

- Revision 1 → 2: none (additive).
- Revision 3 (proposed): none planned. HMAC was never accepted by rem0te, so not accepting it is not a break.
- ClientSt0r side: replacing HMAC with Ed25519 breaks ClientSt0r's own pairing records (`integration_outbound_secret`,
  `integration_inbound_secret`). That is ClientSt0r's migration to plan.

## 11. Task list

**Done**
- [x] Revision 2: `organizations`, `contract_revision`, `patch_summary` (rem0te 0.30.0)
- [x] Signed examples generated from the real implementation, verified in CI
- [x] Path B gaps measured against ClientSt0r's real code
- [x] Path A device sync verified against ClientSt0r's real provider code (2026-11-11)

**Outstanding**
- [ ] ClientSt0r CS-1 … CS-8
- [ ] ClientSt0r acknowledgement of revision 3 (section 9)
- [ ] rem0te implements the acknowledged items of revision 3, with schemas, examples and e2e
- [ ] Both running applications pass the ticket workflow end to end (pair → diagnose → result in ticket → refer
      fix → approvals → execution → re-check → evidence in ticket → close)
- [ ] Path A run through ClientSt0r's scheduled sync, not only its provider code
