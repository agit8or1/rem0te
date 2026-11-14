# AI and tickets

From 0.48, every Windows event-log entry on a computer's **Events** tab, and every alert on its
**Monitoring** tab, has two buttons:

- **Ask AI** — explains what the entry means, likely causes, whether it matters and safe next steps,
  using the AI provider a Platform Admin set under **Settings → AI**.
- **Create ticket** — opens a ticket in whatever PSA is connected under **Settings → PSA / ticketing**:
  the business's own connector if it has an enabled one, otherwise the platform default.

Both buttons name the entry by reference (the stored event-log result and its position, or the
alert's id). The server reads the entry itself from what the computer reported, so neither button
can be used to send arbitrary text to a provider or a PSA.

## Ask AI

### What is sent

Only this, and only after redaction:

| Sent | Never sent |
|---|---|
| Event ID, provider (source), level, log name, time | The computer's name or hostname |
| The event message, redacted | The business or site |
| The computer's Windows version | Who asked |

For an alert: its kind, monitor, severity, title and detail (all redacted) and when it was first seen.

The whole input is capped at about 8 KB (the message at 6,000 characters).

### Redaction

Before anything leaves this server, the entry passes through `apps/api/src/ai/redact.ts`:

1. The names this server knows for the computer — its name, hostname, serial number, domain, the
   logged-on user (both halves of `DOMAIN\user`), its business and site — are replaced wherever they
   appear, along with any host under that domain (`dc01.corp.example.com`).
2. What Windows writes about people and machines is replaced by pattern: account SIDs
   (`S-1-5-21-…`; well-known ones such as `S-1-5-18` are kept), `DOMAIN\user` (but not `NT AUTHORITY\…`,
   registry roots or paths), UNC host names, the labelled account and workstation fields of
   Security-log messages (`Account Name:`, `Workstation Name:`, `Source Network Address:` …),
   `\Users\<name>` paths, fully qualified host names (file names such as `wuaueng.dll` are kept),
   serial-like tokens and labelled serial numbers (KB numbers and `0x8007…` codes are kept).
3. Then the same redactor used for ClientSt0r (`redactForPeer`): credentials and tokens, keys,
   e-mail addresses, every IPv4 and IPv6 address, MAC addresses, RustDesk IDs and
   `C:\Users\<name>` profile paths.

The dialog says how many values were removed, and **Show what was sent** displays the exact redacted text.

### The prompt and the answer

The instructions are fixed. The entry goes in the user message inside `<untrusted_log_data>` tags,
and the model is told it is data, never instructions, and never to recommend anything destructive
(deleting data, wiping disks, disabling security software, Windows Update or the firewall, unbacked
registry edits, running downloaded commands). The answer is shown as text: a few headings, bold and
bullets are drawn as page elements, HTML is removed, and links are not made clickable.

AI can be wrong. Check its suggestions before acting on them.

### Cost, caching and limits

- An identical entry (same provider, model and redacted content, whatever its time) is answered from
  a cache for a day and costs nothing; the dialog shows **cached**.
- 30 questions per person per hour (`AI_ASK_PER_HOUR`), and 10 a minute per address.
- Each request has a 60-second timeout and a 256 KB response cap.

### Who can ask

`computers:view` on the computer (another business's computer is a 404), plus
`computers:event_logs` for an event-log entry (the same permission that reads the log) or
`monitoring:alerts` for an alert.

### Audit

`AI_ASKED` is written **before** the request leaves (if it cannot be written, nothing is sent) and
`AI_ANSWERED` after. They hold ids, the provider and model, sizes, redaction counts and token counts —
never the entry, the prompt or the answer.

## Settings → AI (Platform Admin)

One provider at a time:

| Provider | Endpoint | Key header |
|---|---|---|
| Anthropic | `POST https://api.anthropic.com/v1/messages` (`anthropic-version: 2023-06-01`) | `x-api-key` |
| OpenAI | `POST https://api.openai.com/v1/chat/completions` | `Authorization: Bearer` |
| OpenAI-compatible (Azure v1, OpenRouter, Groq, Mistral…) | `POST {base URL}/chat/completions` | `Authorization: Bearer`, or `api-key` for Azure |

Anthropic models: `claude-sonnet-5-5` (default), `claude-opus-5-5`, `claude-haiku-5-5`, or a typed id.
OpenAI and compatible providers take a typed model id.

**How the key is protected.**

- Stored AES-256-GCM-encrypted under the server's `ENCRYPTION_KEY`, bound to its purpose, and
  decrypted only to make one request.
- Never returned by any page or API: only "set · …abcd" (its last four characters).
- Never in an audit row or log line. `AI_SETTINGS_CHANGED` records only whether the key was set, kept
  or cleared.
- Changing the provider, base URL or key header **clears the saved key** unless a new one is entered
  in the same save, so a key is never sent somewhere other than where it was entered for.
- Saving needs a Platform Admin and a fresh sign-in every time. It is not one of the everyday changes
  that **Settings → General** can relax.

**Test** sends a tiny "reply with OK" prompt and shows the result; no event data is sent.

**A custom base URL** must be `https://` on a public DNS name (no IP address, `localhost`, single-label
or internal name, no user name, query or fragment). On every call it is resolved and every address
checked (no private, loopback, link-local or metadata address), the connection is made to the
checked address with the name used for the certificate check, certificates are verified, and
redirects are never followed. Anthropic's and OpenAI's own endpoints go through the same checks.

When no provider is on, the button says *Not configured — a Platform Admin sets a provider in Settings → AI*.

## Create ticket

### The ticket

- **Subject**: `[Rem0te] <computer> — <log>/<event id> <level>` (or the alert's title), editable before
  sending, one line, at most 200 characters.
- **Body**: the computer, business, who asked, a link to the computer in the portal, the entry (log,
  event id, source, level, time and message — not redacted: it goes to your own PSA), your note, and,
  if you tick **Include AI explanation** and the entry has been asked about, the AI's answer with its
  provider and model.

Afterwards the row shows **Ticket created · <ref>** when the PSA returned a reference, a `PsaTicket`
record keeps the computer, the entry, the connector, the reference and who made it (no text), and a
note is added to the computer's **History**.

### Who can create one

`computers:view` and visibility on the computer, the entry's own permission (`computers:event_logs`
or `monitoring:alerts`), and **`tickets:create`** ("Create PSA tickets"), which a Business Owner has
and a Business User or technician must be given. It is not part of the L1–L3 presets.
20 tickets per person per hour, 5 a minute per address.

A **containment pause on outbound emails** (`notifications`) stops ticket sends for the business it
covers, whatever the connector. A ClientSt0r connector is also stopped by an `integration` pause.

### Audit

`PSA_TICKET_CREATED` and `PSA_TICKET_FAILED` carry the connector kind and scope, ids, the entry
reference, whether the AI answer and a note were included, and the PSA's reference — never the
subject, note or body. `PSA_CONNECTOR_CHANGED` records the kind, an email connector's masked address
or a webhook's host, and whether a signing secret was set — never the secret or the full URL.

## Settings → PSA / ticketing

A Platform Admin sets the **platform default**; a Business Owner may set their business's own
connector, which wins for that business's computers. Every save needs a fresh sign-in.

### Email-to-ticket

For ConnectWise, Autotask, HaloPSA, Syncro, Freshdesk, Zendesk and any other PSA with an inbound
support address. Add the address to the scope's email addresses on the same page and pick it. It
must be **confirmed** before any ticket is sent: the confirmation email arrives in the PSA as a
ticket — open it and follow its link. Tickets go through the relay in **Settings → Email** with all
of its rules (see [Email](email.md)).

### Webhook

An HTTPS POST to a public URL, for HaloPSA or Syncro automations, Zapier, Make and n8n. The URL
follows the same rules as a custom AI base URL (public HTTPS name, resolved and checked on every
send, certificate verified, no redirects; 15-second timeout). The saved URL is never shown again —
its path is often its secret — only its host.

The body is fixed:

```json
{
  "source": "rem0te", "type": "ticket.create", "version": 1, "sent_at": "2026-11-14T10:00:00.000Z",
  "ticket": {
    "subject": "...", "body": "...", "note": null, "link": "https://portal.example.com/endpoints/...",
    "computer": { "id": "...", "name": "..." }, "business": { "id": "...", "name": "..." },
    "requested_by": "tech@example.com", "source_ref": "event:<commandId>:<index>",
    "event": { "logName": "System", "eventId": 7031, "provider": "...", "level": "Error", "timeCreated": "...", "message": "..." },
    "alert": null, "ai": null
  }
}
```

With a **signing secret** (16+ characters, stored encrypted, never shown), each request carries:

```
X-Rem0te-Timestamp: <unix seconds>
X-Rem0te-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
```

Check the signature over the raw body and refuse an old timestamp. A secret is kept only while the
URL stays the same. To show a reference in rem0te, answer with JSON naming `ticket_id` (or `id`,
`ticketId`, `number`, `ref`) and optionally an `https` `url`.

### ClientSt0r

For businesses mapped to a ClientSt0r organization. Rem0te sends a signed `ticket.create_request`
event to the peer's events URL — a **proposed** contract addition (P16 in
`INTEGRATION_COORDINATION.md`, schemas under `docs/contracts/ticket-rmm-v1/proposed/`) that
ClientSt0r has not agreed. It is offered only when ClientSt0r's signed capabilities document lists
`ticket_create_request_v1`; until then the button says so and nothing is sent.

### Native API connectors

HaloPSA, Autotask and ConnectWise REST connectors are not built. Adding one is one new file in
`apps/api/src/psa/connectors/` implementing `PsaDriver` (`apps/api/src/psa/connector.ts`), its kind
added to `KINDS` and to migration CHECK `PsaConnector_kind`, and a line in `connectors/index.ts`.
Its HTTP must go through `common/safe-https.ts` and its secrets through `common/secret-box.ts`.

## What has not been tested

The automated suites use loopback stand-ins for Anthropic-shaped and OpenAI-shaped APIs, a webhook
receiver and an SMTP server. **No real AI provider or PSA has been called**: the request shapes
follow each provider's documentation, and a provider that changes its API will show up as a failed
**Test**.
