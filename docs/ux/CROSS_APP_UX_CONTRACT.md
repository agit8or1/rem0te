# Cross-application UX contract (Rem0te side, draft 0)

How Rem0te's console behaves next to ClientSt0r and other MSPZero applications:
shared words, links between the two, the application switcher, and what may and
may not cross between them. It is the **user-interface** companion to the
integration protocol; it never replaces it.

- The protocol (who may call what, signatures, payloads) is
  [`ticket-rmm-v1`](../contracts/ticket-rmm-v1/README.md), coordinated in
  [`INTEGRATION_COORDINATION.md`](../../INTEGRATION_COORDINATION.md). Anything
  below that would need a new field, route or claim is marked **proposal** and
  goes through that file first, as its own section, for ClientSt0r to
  acknowledge. Nothing here is implemented by being written here.
- ClientSt0r's own UX specification (`docs/ux` in its repository) was **not
  published** when this was written: checked against ClientSt0r `main`
  `2d26c30`, 2026-11-25. When it is, this page is reconciled against it and the
  adopted commit is recorded in [CLIENTST0R_HANDOFF.md](CLIENTST0R_HANDOFF.md).

## 1. Principles

1. **Independent products.** Each application installs, signs in, stores,
   upgrades and renders on its own. No shared database, cookie, session,
   CSS, JavaScript, font or icon file is served from one to the other, and no
   CDN is required (directive §4).
2. **Optional pairing.** Nothing below appears until a Platform Admin has
   configured the other application (STANDALONE_REQUIREMENTS.md, S-1 to S-4).
3. **Same family, not the same app.** The same tokens, words and patterns
   where practical; each keeps its own navigation, branding and modules.
4. **Rem0te authorizes execution.** A link, a context hand-off or a switch
   never carries authority. Every Rem0te page re-checks the signed-in Rem0te
   user's own permissions, exactly as for a URL typed by hand.

## 2. Shared words

Rem0te's database and API keep their names (`Customer` model, `/customers`,
`Endpoint`, `/endpoints`); only the words a person reads change, and only
through UX_ROADMAP.md P1-1 (a terminology pass with the browser suite updated
in the same commit).

| Shared term | Rem0te today | Notes |
|---|---|---|
| Customer | "Business" in most of the console (about 1,400 occurrences in `apps/web`), "Customer" in a few (the dashboard's *Customers affected*) | The audit's top terminology finding. Rem0te's three-level model (platform → business → people) is documented as "business"; the change is wording only |
| Device | "Device" in navigation and the list, "Computer" in most body text (about 1,700 occurrences) | "Computer" stays where it is precise (a Windows computer as opposed to a phone) |
| Site | Site | Same |
| Pending approval | "Awaiting approval" (dashboard tile, policies), "Approval pending" in places | Adopt "Pending approval" |
| Critical alert | Critical (severity) | Same |
| Maintenance window | Maintenance window (monitoring), "window" (patch policies, restart windows) | Keep "restart window" distinct: it is a different thing |
| Restart pending | Restart pending | Same |
| Work on next | Work on next (dashboard) | Same |

## 3. Links between the applications

### 3.1 Into Rem0te (exists)

ClientSt0r's device sync (path A, public API key, `computers:read`) links each
synced asset to Rem0te's device page, `/endpoints/<rem0te id>`. That route:

- takes the Rem0te database id, never a hostname (two customers' `FRONTDESK`
  are two ids);
- answers 404 to a Rem0te user who may not see that computer, exactly as for an
  id that does not exist, and audits the attempt;
- takes no credential, token or session in the URL.

Stable deep links Rem0te supports for other applications (their paths do not
change without a redirect):

| Target | Path |
|---|---|
| A device | `/endpoints/<id>` |
| A device tab | `/endpoints/<id>?tab=<overview, performance, monitoring, software, processes, services, network, patches, events, diagnostics, actions, terminal, files, chat, history>` |
| An alert | `/alerts?alert=<id>` (also `?state=`, `?severity=`, `?fingerprint=`) |
| A customer | `/businesses/<id>` |

### 3.2 Out of Rem0te (proposal)

Rem0te never builds a link to another application from data that application
sent it. A link out may use only a base URL from the **root-controlled peers
file** (the same file that holds the peer's keys) plus a path from a closed
list, with ids that passed Rem0te's own charset checks. Proposal for
`INTEGRATION_COORDINATION.md` (not yet filed):

- `peers[].consoleUrl` — optional, https, validated like the other peer URLs.
- ClientSt0r's `/capabilities` lists the deep-link paths it supports
  (`ticket`, `customer`, `asset`), each a template with one id placeholder.
- Rem0te shows *Open in ClientSt0r* only for a capability the peer lists and
  an id Rem0te already holds for that record (a `PsaTicket.url` already stored,
  an organization mapping).

No open redirect: Rem0te never accepts a `returnTo` or `next` that is not a
relative path on itself.

### 3.3 Returning to where you were

A person who leaves a Rem0te device page for a peer and comes back must land on
the same device and tab. Rem0te keeps the tab in the URL (`?tab=`), so the
browser's Back and a shared link both work today (WORKFLOW_BENCHMARKS.md B13).

## 4. The application switcher (proposal)

- Drawn only when at least one peer has a `consoleUrl` and the signed-in person
  is staff (never a customer's Business User). Lists only configured
  applications; Rem0te itself first.
- One click opens the other application's own sign-in or session in a new tab.
  No token in the URL, no cookie shared. With SSO configured on both sides the
  provider makes the second sign-in silent; without it, the person signs in.
- Customer context: when the current Rem0te page has a customer that is mapped
  to a ClientSt0r organization, the switch may open that organization's page
  (a capability-listed path). An unmapped customer opens the home page; Rem0te
  never guesses a mapping.
- A peer that is unreachable stays in the list, marked unavailable, with when
  it was last reached. It never blocks the page.

## 5. Notifications, approvals and search across applications

Out of scope for now. Each application's notifications, pending approvals and
search cover its own records. A federated view would need protocol revisions
and is not planned (directive §2, "optional federated search").

## 6. Visual parity

Both applications use the tokens in [design-tokens.json](design-tokens.json) once
reconciled with ClientSt0r's, and the component rules in
[SHARED_DESIGN_SYSTEM.md](SHARED_DESIGN_SYSTEM.md). A drift check (a script
comparing Rem0te's CSS custom properties with the adopted token file) is
UX_ROADMAP.md P0-2.

## 7. What never crosses

- Credentials, RustDesk passwords, device secrets, tokens, session cookies.
- Authority to execute on a computer (S-7).
- Another customer's names or devices in a denial message.
- Assets loaded at runtime from the other application's server.
