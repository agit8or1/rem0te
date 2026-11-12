# ClientSt0r integration (ticket analysis)

rem0te can analyse a ClientSt0r ticket, optionally with evidence from one enrolled computer, and hand back
**staff-only** findings and draft replies. Since 0.34 the device page's AI summary is also written through
ClientSt0r ([below](#the-device-pages-ai-summary-034)): **rem0te holds no model-provider key anywhere.** This is contract **ticket-rmm-v1**, defined in
[`docs/contracts/ticket-rmm-v1/`](contracts/ticket-rmm-v1/README.md).

> **Status (0.30.0): proved against a reference peer; the real ClientSt0r does not pair yet.** Every behaviour
> on this page is exercised against a simulated ClientSt0r by `e2e-integration.mjs` and `e2e-approved-action.mjs`,
> and the whole workflow by `e2e-ticket-workflow.mjs`, with the real API, worker and approval signer. Run against
> ClientSt0r 3.17.659's own code (`interop-clientst0r.mjs`), pairing fails: ClientSt0r signs with HMAC and expects
> another capabilities and job shape. The four measured gaps, and what ClientSt0r should consume, are in
> [CLIENTST0R.md](contracts/ticket-rmm-v1/CLIENTST0R.md). Ticket analysis is read-only. An
> [action proposal](#proposing-an-approved-action-026) runs nothing until people on the approval roster approve
> it, outside ClientSt0r.

## Who owns what

| ClientSt0r | rem0te |
|---|---|
| The ticket, the customer conversation, what is sent to the customer | Which ClientSt0r organization is which business, and which technician is which user |
| AI configuration, model choice, **every provider key**, usage limits | Collecting bounded evidence from an enrolled computer |
| The inference gateway (`POST /api/integration/v1/inference`) | Running the job durably, checking every model output, signing results |
| Receiving events (`POST /api/integration/v1/events`) | `GET /capabilities`, `POST /jobs`, `GET /jobs/{id}`, `GET /jobs/{id}/events` |

rem0te never receives a provider key. It asks the gateway for a *profile* (for example `triage-fast`), and
ClientSt0r decides which model and key that means. There is no model-provider SDK, endpoint or key variable in
rem0te's API at all (`check-security-invariants.mjs` §41); an `ANTHROPIC_API_KEY` left in `api.env` from before
0.34 is ignored and can be deleted.

## What a job can and cannot do

**Can:** read the ticket text ClientSt0r sent; read one computer's heartbeat freshness, agent version, OS
build, uptime, memory and system-disk headroom, pending updates and reboot-required flag; call the inference
gateway once per profile; return a signed result.

**Cannot:** run a shell or any command, fetch any URL except the two in the peers file, open a remote session,
issue a launcher token, queue an endpoint command, reveal a credential, or approve anything. (Proposing a
catalog action, below, is a separate route, and it can't approve anything either.) The worker
process does not load the modules that do those things, and `scripts/check-security-invariants.mjs` fails
CI if that changes.

IP and MAC addresses, serial numbers, the logged-on user and the domain are **never** sent to the gateway.
A device-reported computer name is reduced to a plain character set first.

Tickets, Windows-reported values and model output are all treated as untrusted:

- prompt-injection patterns in the ticket are reported as `untrusted_input_flags`;
- a model "fact" whose evidence reference rem0te cannot resolve becomes an `unsupported_claim`;
- unknown fields in model output are dropped and counted;
- next steps are text (`executable: false`), and suggestions to extract credentials, disable defenses,
  delete backups, grant admin, wipe disks or run commands are labelled `blocked_category`;
- link hosts in draft replies are listed for the reviewer;
- a gateway response not signed for this exact request, job, organization and profile is rejected.

## Setting it up

### 1. Keys and the peers file (root, on the server)

```bash
sudo install -d -m 0750 -o root -g reboot /etc/reboot-remote/integration
sudo openssl genpkey -algorithm ed25519 -out /etc/reboot-remote/integration/rem0te-signing.pem
sudo chown root:reboot /etc/reboot-remote/integration/rem0te-signing.pem
sudo chmod 0640 /etc/reboot-remote/integration/rem0te-signing.pem
```

ClientSt0r generates **two** Ed25519 key pairs — one for signing requests and responses, one for minting
technician delegation tokens — and gives you only the public halves.

`/etc/reboot-remote/integration/peers.json` (root:reboot, 0640):

```json
{
  "self": { "keyId": "rem0te-2026-11", "privateKeyFile": "/etc/reboot-remote/integration/rem0te-signing.pem" },
  "peers": [{
    "id": "clientst0r",
    "audience": "rem0te:remote.example.com",
    "peerAudience": "clientst0r:tickets.example.com",
    "requestKeys":    [{ "kid": "req-2026-11", "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n…" }],
    "delegationKeys": [{ "kid": "del-2026-11", "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n…" }],
    "inferenceUrl": "https://tickets.example.com/api/integration/v1/inference",
    "eventsUrl":    "https://tickets.example.com/api/integration/v1/events",
    "capabilitiesUrl": "https://tickets.example.com/api/integration/v1/capabilities",
    "modelProfiles": ["triage-fast", "triage-deep", "summary-fast"],
    "clientCertSha256": []
  }]
}
```

Add `INTEGRATION_PEERS_FILE=/etc/reboot-remote/integration/peers.json` to `/etc/reboot-remote/api.env`. URLs
must be `https` (plain `http` is accepted only for loopback, for the lab simulator) and may carry no
credentials, query or fragment. The file is read once at start: restart the API and the worker after editing it.
`capabilitiesUrl` is optional (0.34) and is only used for the [device summary](#the-device-pages-ai-summary-034);
without it that summary stays off.

**Nothing in the portal can edit this file.** That is the point: a compromised database or Platform Admin
account cannot add a peer, swap a key or redirect the worker.

### 2. Optional mTLS

To pin ClientSt0r's client certificate in addition to request signatures, terminate mTLS in Caddy and
forward the fingerprint (the API honours the header only from the loopback proxy):

```caddy
remote.example.com {
    tls { client_auth { mode require_and_verify; trusted_ca_cert_file /etc/caddy/clientst0r-ca.pem } }
    handle /api/integration/* {
        reverse_proxy localhost:3001 { header_up X-Client-Cert-Sha256 {http.request.tls.client.fingerprint} }
    }
}
```

and list the SHA-256 fingerprint(s) in `clientCertSha256`.

### 3. The worker

```bash
sudo cp deploy/systemd/reboot-remote-integration-worker.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now reboot-remote-integration-worker
```

For a single-box lab, `INTEGRATION_WORKER_INLINE=true` runs it inside the API process instead.

### 4. Map organizations and technicians (Platform Admin, step-up)

```
POST /api/v1/admin/integration/mappings/organizations  { "peerId", "externalOrgId", "businessId" }
POST /api/v1/admin/integration/mappings/technicians    { "peerId", "externalOrgId", "externalTechnicianId", "userId" }
GET  /api/v1/admin/integration/mappings
GET  /api/v1/admin/integration/peers
```

A mapping grants nothing on its own. The user must also reach that business — as a member or through a
current [technician assignment](technicians.md) — and hold **Ticket analysis (ClientSt0r)**
(`integration:ticket_analysis`) there. Business Owners hold it automatically; Business Users and technician
assignments need it granted. Removing it stops in-flight jobs before their next model call.

## When something goes wrong

| Symptom | Cause |
|---|---|
| Every call 404 `NOT_CONFIGURED` | `INTEGRATION_PEERS_FILE` not set, or no enabled peers |
| 401 `UNAUTHENTICATED` | Clock skew over 120 s, wrong `audience`, wrong key id, or body changed after signing |
| 401 `REPLAYED` | Nonce or delegation `jti` reused — retries must sign afresh |
| 403 on submit | Organization or technician not mapped, no current access to the business, or capability missing |
| 409 `IDEMPOTENCY_CONFLICT` | Same idempotency key, different payload (for example a new ticket revision) |
| 423 `CONTAINED` on submit, or job `failed` / `CONTAINED` | ClientSt0r jobs are paused for that business or globally ([Containment](containment.md)). Retry after the pause is lifted; queued jobs are ended, not held |
| Job `failed` / `ACTOR_REVOKED` | The technician lost access while the job ran |
| Run `RESPONSE_SIGNATURE_INVALID` / `RESPONSE_MISMATCH` | Gateway response not signed for this request, or echoes a different job/org/profile |
| Events not arriving | Check `lastDeliveryError` on `IntegrationEvent`; ClientSt0r can always poll `GET /jobs/{id}/events` |

Audit actions: `INTEGRATION_JOB_ACCEPTED`, `INTEGRATION_JOB_REJECTED`, `INTEGRATION_JOB_FINISHED`,
`INTEGRATION_MAPPING_CHANGED`, and for the device summary `AI_TIMELINE_REQUESTED`, `AI_TIMELINE_FINISHED`,
`AI_TIMELINE_REFUSED`.

## Proposing an approved action (0.26)

ClientSt0r can **propose** a catalog action on one computer, today only `windows.service.start@1` with
`{"service":"Spooler"}`. The 0.32 maintenance actions (service restart, restart schedule and cancel, log
collection) are not offered to ClientSt0r and a proposal naming one is `ACTION_NOT_IN_CATALOG`: advertising them is a
change to the ticket-rmm contract that has not been agreed. It can't approve, dispatch or run one. The proposal goes through the same path as the
portal's own **Request approval** button, as the delegated technician, and it gets the same live access check
and the same approval signer.

| Route | Delegation scope | What it does |
|---|---|---|
| `POST /api/integration/v1/action-proposals` | `actions:propose` | Creates a plan awaiting approval, and returns its `approval_url` and `plan_digest` |
| `GET /api/integration/v1/action-proposals/{job_id}` | `actions:read` | Status, outcome and what the computer observed |

`GET /capabilities` lists the proposable actions under `features.actions`. The list is empty until an approval
signer is configured.

- **No command field, ever.** The request schema is strict: an `action` names a catalog id and version, and
  `params` must equal the catalog's. A `command`, a `script`, or a target given as a hostname is a schema
  error.
- **An AI suggestion gets no shortcut.** `origin: "ai_suggestion"` with a `ticket_ref` is shown to the
  approvers as such, and needs exactly the approvals a person's request needs.
- **Idempotent.** The same `idempotency_key` returns the same proposal; a different request under it is
  `409 IDEMPOTENCY_CONFLICT`.
- **Refusals pass through with the portal's codes:** `ACTION_NOT_IN_CATALOG`, `PARAMS_NOT_ALLOWED`,
  `ACTION_NOT_GRANTED`, `PROTECTED_DEVICE_CLASS`, `ENDPOINT_NOT_READY`, `ACTION_PENDING`,
  `ACTION_UNRECONCILED`, and `CONTAINED` while actions are paused. Each is audited as `ACTION_DISPATCH_BLOCKED` with `stage: proposal`.

The technician needs **Request approved actions** (`actions:request`) in that business, in addition to the
mapping. Show `approval_url` to the people who will approve. Approval happens there, never in ClientSt0r.
The whole lifecycle is described in [approved-actions.md](approved-actions.md).

## Alerts and tickets (0.29)

rem0te can offer monitoring alerts to ClientSt0r so it opens a ticket, and show that ticket on the alert. Turn it
on per business, or globally, in **Settings → Monitoring → Notifications → Offer alerts to ClientSt0r**, with a
severity floor (critical by default). Only alerts at or above it are sent. Nothing else is needed on the rem0te
side: the peer's existing `eventsUrl` receives the alert events, and the existing organization mapping decides
which business is which organization.

| Route | What it does |
|---|---|
| (push) `POST {eventsUrl}` | `{alert_event, signature}` — `alert.raised`, `alert.updated`, `alert.resolved` |
| `GET /api/integration/v1/alerts/events?organization_id=&after=` | Signed alert events after a sequence, for a gap |
| `GET /api/integration/v1/alerts/{alert_id}?organization_id=` | The alert now |
| `POST /api/integration/v1/alerts/{alert_id}/ticket` | Record the ticket opened for it |

- **Service-level, not delegated.** No technician token: nothing here acts for a person or reaches a computer.
  The only write is the ticket link, and it grants nothing.
- **One ticket per alert.** A different ticket for an already-linked alert is `409 TICKET_ALREADY_LINKED`;
  changing it is done in rem0te.
- **What ClientSt0r learns.** The alert title, severity, state, the computer's and site's names, the rem0te
  computer id and the times. Not inventory, not event-log text beyond the alert title.
- **When it is sent.** `alert.raised` goes out with the first notification level, so it waits like a
  notification does: offline alerts are held for three minutes, an alert grouped under an open site outage is
  never sent on its own (the outage is), and a **maintenance window holds it until the window ends** — and then
  only if the alert is still open. Planned work does not open tickets.
- **Containment does not stop alert events.** They report; they change nothing on a computer.
- **Only the kinds the contract names (0.36).** `alert.kind` is an enum in the contract; an alert of a kind
  outside it is not signed or sent at all. The 0.36 *agent silent* monitor (`AGENT_SILENT`) is such a kind:
  with ticketing on it is notified as usual but never offered to ClientSt0r. Carrying it means adding it to the
  enum — a contract revision ClientSt0r must accept first, since a strict validator would refuse the event.

- **Patch summary (0.30).** A *restart pending* alert carries `patch_summary`, a redacted summary of the
  computer's Patches tab: evidence source and age, freshness, last boot, who manages patching, restart pending,
  pending KB numbers and which KBs were confirmed by a later scan, failed or await confirmation. No update titles,
  error text, identifiers, user names or addresses. See [What each agent can do](capabilities.md).

## The device page's AI summary (0.34)

**History → AI-written summary** on a computer asks ClientSt0r's gateway to summarise that computer's notes and
remote sessions. Before 0.34 rem0te called a model provider itself, with `ANTHROPIC_API_KEY` in its own
environment, and sent the computer's name, hostname, business, site, tags and every note verbatim. That call and
the `@anthropic-ai/sdk` dependency are gone.

> **Status: built on rem0te's side, unavailable against the real ClientSt0r.** The operation it needs,
> `device_timeline_v1`, and the ClientSt0r capabilities document that advertises it, are **proposals ClientSt0r has
> not agreed** (P11 and P12 in [INTEGRATION_COORDINATION.md](../INTEGRATION_COORDINATION.md) §5A; schemas in
> [`contracts/ticket-rmm-v1/proposed/`](contracts/ticket-rmm-v1/proposed/)). Until ClientSt0r's capabilities list
> it, the button is disabled and the panel says *Needs ClientSt0r support for device_timeline_v1*. No summary is
> invented in the meantime. `e2e-ai-timeline.mjs` proves the behaviour against a reference peer, which is not
> ClientSt0r.

**How a request goes**

1. The computer's business must be mapped to exactly one ClientSt0r organization (the same mapping as ticket
   analysis). Mapped to none: `NOT_MAPPED`. To two peers: `AMBIGUOUS_MAPPING` — rem0te will not guess.
2. An `integration` [containment](containment.md) pause for the business, or a global one, stops it (`CONTAINED`)
   before rem0te contacts ClientSt0r for anything, capabilities included.
3. rem0te reads ClientSt0r's capabilities document from the peers file's `capabilitiesUrl`: a signed `GET`, whose
   response must be signed by ClientSt0r over rem0te's nonce and name this peer. It is believed for 60 seconds
   (`INTEGRATION_CAPABILITIES_TTL_MS`). No `capabilitiesUrl`, or a document that does not list
   `device_timeline_v1`: `PEER_UNSUPPORTED`. Unreadable or badly signed: `PEER_UNREACHABLE`.
4. The profile is the first one ClientSt0r offers for the task that the peers file's `modelProfiles` also lists.
   None: `PROFILE_NOT_ALLOWED`.
5. `AI_TIMELINE_REQUESTED` is written to the audit log; if it cannot be written, nothing is sent.
6. One signed `POST {inferenceUrl}` with `task: "device_timeline_v1"`, the organization, the profile and the
   redacted payload. The answer is accepted only if signed by ClientSt0r over the nonce and echoing the same
   request id, organization, profile and task. Its `output.summary` (at most 4,000 characters, control and
   bidi characters stripped, any other field dropped and counted) is stored on the computer. A forged, mismatched,
   refused or malformed answer saves nothing and returns `502` with the reason.
7. `AI_TIMELINE_FINISHED` records the outcome, model, latency and token usage.

**Who may.** Seeing the panel and the preview needs `computers:view`. Requesting a summary needs
`computers:edit` (it replaces the stored summary) **and** `integration:ticket_analysis` (it sends the computer's
notes to ClientSt0r's AI) in that business. Business Owners hold both. Another business's computer is a 404.

**What leaves rem0te.** The panel's *What is sent to ClientSt0r* lists it, shows the redaction counts, and
*Show the exact text* displays the segments exactly as they are sent (the preview and the request are built by the
same function from the same rows):

| Sent | Never sent |
|---|---|
| The computer's rem0te id (opaque), platform, OS version and agent version (plain character set only), enrolment state, online flag, last seen and enrolled dates | The computer's name and hostname; the business, site and tags |
| The 30 newest notes: date, pinned, text (each cut to 2,000 characters) | Who wrote a note or ran a session |
| The 20 newest remote sessions: date, state, minutes, issue and resolution text | A session's contact name and e-mail, its separate notes field, telemetry and events |
| How many values of each kind were redacted (counts) | IP and MAC addresses, the logged-on user and domain, the RustDesk ID and any password |

The payload is capped at 24,000 characters; the oldest notes and sessions are dropped first.

**Redaction** (`integration/timeline.ts`, `redactForPeer`), applied to every note and every session issue and
resolution: `key=value` / `key: value` credentials and *"password is …"* in prose; `Bearer`/`Basic` tokens and
credentials in URLs; prefixed keys (`rk_…`, `sk-…`, `ghp_…`, `xox…`); e-mail addresses; **every** IPv4 and IPv6
address, private ranges included (stricter than screenshot masking, because the integration's rule is that
addresses never reach the gateway); MAC addresses; 9–10-digit RustDesk IDs; hex of 32+ and opaque strings of
40+ characters; Windows user-profile paths. It is pattern-based: a secret written in a shape none of these
match (a password spelled out in a sentence without the word "password", say) is sent as written.

**Audit.** `AI_TIMELINE_REQUESTED` (peer, organization, profile, request id, field list, note and session counts,
characters, redaction counts), `AI_TIMELINE_FINISHED` (status, code, model, latency, usage, summary length) and
`AI_TIMELINE_REFUSED` (the code). None of them holds a note, a session's text or the summary.

| Code | Meaning |
|---|---|
| `NOT_CONFIGURED` | No `INTEGRATION_PEERS_FILE` |
| `NO_BUSINESS` / `NOT_MAPPED` / `AMBIGUOUS_MAPPING` | The computer's business is not mapped to exactly one organization |
| `CONTAINED` (403) | An `integration` pause covers the business |
| `PEER_UNSUPPORTED` | No `capabilitiesUrl`, or ClientSt0r does not list `device_timeline_v1` — *Needs ClientSt0r support for device_timeline_v1* |
| `PEER_UNREACHABLE` (503) | The capabilities document could not be read or was not signed by the peer |
| `PROFILE_NOT_ALLOWED` | ClientSt0r offers the task only with profiles the peers file does not allow |
| `NO_CAPABILITY` (403) | Missing `computers:edit` or `integration:ticket_analysis` |
| `RESPONSE_SIGNATURE_INVALID`, `RESPONSE_MISMATCH`, `MODEL_REFUSED`, `OUTPUT_SCHEMA_INVALID`, `GATEWAY_UNAVAILABLE` (502) | ClientSt0r's answer was not usable; nothing was saved |

Routes: `GET /api/v1/endpoints/{id}/timeline` (status and preview) and
`POST /api/v1/endpoints/{id}/timeline/generate` (10 a minute).

## Which business a request is for

The binding is `(peer, organization_id) → business`, one to one, created here by a Platform Admin with step-up.
A ClientSt0r serving several customers is **one peer with one organization per customer**; every request names its
`organization_id`, and computers are named by `rem0te_endpoint_id`, never by name, so two customers' `FRONTDESK`
PCs never meet. `GET /capabilities` (contract revision 2) lists the calling peer's `organizations`, each with
`business_id`, `business_name` and the containment kinds in force (`paused`), so the peer can check the mapping.

## Examples and the version to build against

`docs/contracts/ticket-rmm-v1/examples/` holds real signed exchanges recorded from rem0te by
`e2e-ticket-workflow.mjs --write-examples`, with the TEST-ONLY keys that verify them;
`gen-integration-contracts.mjs --check` re-verifies every one in CI. ClientSt0r should build against revision 2,
rem0te 0.30.0.

The schemas, fixtures and examples are in the [contract](contracts/ticket-rmm-v1/README.md).

## Revision status

| Revision | State |
|---|---|
| 2 | **Current.** What `/capabilities.contract_revision` reports |
| 3 (P1–P10: capabilities list and diagnostic catalog, diagnostic requests and events, fix referrals and events, remote launch, handoff notes, `Idempotency-Key`, device health summary) | **Acknowledged by ClientSt0r on 2026-11-11, as proposed. Not built.** ClientSt0r confirmed that a handoff is a staff note in the computer's History with the ticket ref and nothing else (P7), and asked for two additions rem0te has not agreed to yet: signed remote-session started/ended events (P6, its R6) and per-field-group agent version and `observed_at` in the device summary (P10). `contract_revision` moves to 3 only when rem0te ships these items |
| 4 (P11–P12: the device page's AI summary through ClientSt0r) | **Proposed, not agreed.** ClientSt0r's 2026-11-11 response does not address it |

ClientSt0r also sent fourteen requests (R2–R16): how a peer handles fields from a newer revision, a
technician-mapping probe, no pause reason in `CONTAINED` bodies, proposal-status events, more ticket-proposable
actions, ticket state back, longer retry of a restarting gateway, structured alert metrics, diagnostics without
AI, maintenance windows, account and software reads. None is agreed or built. The full record, with what ClientSt0r
reports of its unreleased development branch and its own cross-peer test (99 passed, 3 failed, not reproduced
here), is [INTEGRATION_COORDINATION.md](../INTEGRATION_COORDINATION.md) §6, §8, §9 and §9A.

