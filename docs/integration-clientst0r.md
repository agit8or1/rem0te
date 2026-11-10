# ClientSt0r integration (ticket analysis)

rem0te can analyse a ClientSt0r ticket, optionally with evidence from one enrolled computer, and hand back
**staff-only** findings and draft replies. This is contract **ticket-rmm-v1**, defined in
[`docs/contracts/ticket-rmm-v1/`](contracts/ticket-rmm-v1/README.md).

> **Status (0.26.0): fixture-tested.** Every behaviour on this page is exercised against a simulated
> ClientSt0r by `apps/api/scripts/e2e-integration.mjs` and `e2e-approved-action.mjs`. It has **not** yet run
> paired with a real ClientSt0r. Ticket analysis is read-only. An [action proposal](#proposing-an-approved-action-026)
> runs nothing until people on the approval roster approve it, outside ClientSt0r.

## Who owns what

| ClientSt0r | rem0te |
|---|---|
| The ticket, the customer conversation, what is sent to the customer | Which ClientSt0r organization is which business, and which technician is which user |
| AI configuration, model choice, **every provider key**, usage limits | Collecting bounded evidence from an enrolled computer |
| The inference gateway (`POST /api/integration/v1/inference`) | Running the job durably, checking every model output, signing results |
| Receiving events (`POST /api/integration/v1/events`) | `GET /capabilities`, `POST /jobs`, `GET /jobs/{id}`, `GET /jobs/{id}/events` |

rem0te never receives a provider key. It asks the gateway for a *profile* (for example `triage-fast`), and
ClientSt0r decides which model and key that means.

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
    "modelProfiles": ["triage-fast", "triage-deep"],
    "clientCertSha256": []
  }]
}
```

Add `INTEGRATION_PEERS_FILE=/etc/reboot-remote/integration/peers.json` to `/etc/reboot-remote/api.env`. URLs
must be `https` (plain `http` is accepted only for loopback, for the lab simulator) and may carry no
credentials, query or fragment. The file is read once at start: restart the API and the worker after editing it.

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
`INTEGRATION_MAPPING_CHANGED`.

## Proposing an approved action (0.26)

ClientSt0r can **propose** a catalog action on one computer, today only `windows.service.start@1` with
`{"service":"Spooler"}`. It can't approve, dispatch or run one. The proposal goes through the same path as the
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

The schemas and fixtures are in the [contract](contracts/ticket-rmm-v1/README.md).

