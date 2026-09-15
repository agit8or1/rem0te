# GitHub repository metadata

The values to set on the repository's **About** panel and social preview. This file
is the source of truth for them; GitHub itself has no way to version this, so edit
here first and then apply the settings by hand (see the checklist at the bottom).

## Description

Keep it under GitHub's 350-character limit; the first ~120 characters are what shows
in search results and social cards.

> Self-hosted remote support portal for managing multiple customer businesses on top
> of RustDesk. Organise each customer's computers, control who can connect to what,
> enrol managed devices, and keep an audit trail — without RustDesk Pro.

Short form, if a shorter field is needed:

> Self-hosted remote support for customer businesses, powered by RustDesk.

## Website

`https://mspreboot.com` — set on the repository and verified live (HTTP 200,
"MSP Consulting for Operations, Profitability & Growth | MSP Reboot").

Note what it is: the maintainer's MSP consulting site, not a product page for
Rem0te and not a hosted demo. That is a reasonable thing to point at, but if a
project page or demo is published later, prefer it here — a visitor clicking
**Website** from the repo is looking for more about Rem0te.

## Topics

Thirteen, as currently set. GitHub allows up to 20.

```
rustdesk
remote-support
remote-access
self-hosted
msp
remote-desktop
multi-tenant
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
- `nestjs`, `nextjs`, `typescript`, `postgresql`, `systemd`, `ubuntu` — the
  stack and how it deploys, for contributors.

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
