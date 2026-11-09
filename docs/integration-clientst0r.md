# ClientSt0r integration (ticket analysis)

rem0te can analyse a ClientSt0r ticket, optionally with evidence from one enrolled computer, and hand back
**staff-only** findings and draft replies. This is contract **ticket-rmm-v1**, defined in
[`docs/contracts/ticket-rmm-v1/`](contracts/ticket-rmm-v1/README.md).

> **Status (0.22.0): fixture-tested, read-only.** Every behaviour on this page is exercised against a
> simulated ClientSt0r by `apps/api/scripts/e2e-integration.mjs`. It has **not** yet run paired with a real
> ClientSt0r, and nothing in it executes anything on a computer.

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
issue a launcher token, queue an endpoint command, reveal a credential, or approve anything. The worker
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
| Job `failed` / `ACTOR_REVOKED` | The technician lost access while the job ran |
| Run `RESPONSE_SIGNATURE_INVALID` / `RESPONSE_MISMATCH` | Gateway response not signed for this request, or echoes a different job/org/profile |
| Events not arriving | Check `lastDeliveryError` on `IntegrationEvent`; ClientSt0r can always poll `GET /jobs/{id}/events` |

Audit actions: `INTEGRATION_JOB_ACCEPTED`, `INTEGRATION_JOB_REJECTED`, `INTEGRATION_JOB_FINISHED`,
`INTEGRATION_MAPPING_CHANGED`.
