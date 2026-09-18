# GitHub repository metadata

The values to set on the repository's **About** panel and social preview. This file
is the source of truth for them; GitHub itself has no way to version this, so edit
here first and then apply the settings by hand (see the checklist at the bottom).

## Description

Keep it under GitHub's 350-character limit; the first ~120 characters are what shows
in search results and social cards.

> Self-hosted remote support portal for managing multiple customer businesses on top
> of RustDesk. Organise each customer's computers, see their specs and pending
> Windows updates, read an event log without connecting, launch from Tactical RMM,
> and keep an audit trail — without RustDesk Pro.

The first sentence is unchanged on purpose: it is what shows in search results and
social cards, and it was already the clearest statement of what this is. The second
carries what 0.14–0.18 added, because "organise computers and keep an audit trail"
undersold a tool that now reports hardware, pending patches and event logs, and
plugs into an RMM.

Short form, if a shorter field is needed:

> Self-hosted remote support for customer businesses, powered by RustDesk.

## Website

**`https://mspreboot.com`** — currently set on the repository and verified live
(HTTP 200, "MSP Consulting for Operations, Profitability & Growth | MSP Reboot").

MSPReboot publishes Rem0te. Its *Free Projects* page lists this repository as
"Rem0te — Open Source — Multi-tenant remote support built on RustDesk", alongside
ClientSt0r, OPNMGR, Depl0y and St0r. Pointing **Website** there gives a visitor
the publisher and the sibling tools, which is the most useful destination that
currently exists.

Some sibling projects have a dedicated product site (`clientst0r.mspreboot.com`,
`depl0y.mspreboot.com`, `st0r.mspreboot.com`). Rem0te does **not** — neither
`rem0te.mspreboot.com` nor `remote.mspreboot.com` resolves. If one is published
later, prefer it here as the primary About URL and keep the MSPReboot links in
the README and gallery.

MSPReboot sells consulting, and **offers hosting and support for Rem0te** for
people who would rather not self-host. Rem0te itself stays free and
MIT-licensed, and self-hosting requires no engagement — keep both halves of that
true in any copy written here. Do not attach specific uptime, response-time or
service-level figures to it unless they are published somewhere checkable.

## Topics

Fifteen, as currently set. GitHub allows up to 20.

```
rustdesk
remote-support
remote-access
self-hosted
msp
remote-desktop
multi-tenant
tactical-rmm
asset-inventory
nestjs
nextjs
typescript
postgresql
systemd
ubuntu
```

- `rustdesk`, `remote-support`, `remote-access`, `self-hosted`, `msp` — how
  people looking for this kind of tool actually search.
- `remote-desktop`, `multi-tenant` — the broader category and the shape.
- `tactical-rmm` — there is a real integration to find: URL Actions, agent
  matching and a Collector Task. People run TRMM and search for what works with
  it.
- `asset-inventory` — accurate since 0.14.0, which added hardware, storage,
  network and pending-update collection.
- `nestjs`, `nextjs`, `typescript`, `postgresql`, `systemd`, `ubuntu` — the
  stack and how it deploys, for contributors.

**Deliberately not `rmm`.** Rem0te is a remote-support portal that *integrates*
with an RMM; it does not do patching, monitoring or scripted remediation.
Claiming the category to catch searches would bring people here expecting a
Tactical RMM competitor and send them away again.

## Repository settings checklist

Apply these by hand in the GitHub UI; none of them can be set from the repository
contents.

- [x] **About → Description** — applied via `gh repo edit`.
- [x] **About → Website** — `https://mspreboot.com` (already set).
- [x] **About → Topics** — applied via `gh repo edit`.
- [ ] **About** — tick *Releases*; untick *Packages* and *Environments* if unused.
- [ ] **Settings → General → Features** — Issues and Discussions on (both are linked
      from the README); Wiki off, since the documentation lives in `docs/`.
- [ ] **Settings → Security → Private vulnerability reporting** — **enable it**.
      [`.github/SECURITY.md`](../.github/SECURITY.md) tells reporters to use it, so
      the link is broken until this is on.
- [ ] **Settings → Social preview** — upload a preview image. A 1280×640 crop of
      `docs/images/github/hero-businesses.png` works.
- [ ] Confirm the default branch is `main`, which the CI badge in the README assumes.
