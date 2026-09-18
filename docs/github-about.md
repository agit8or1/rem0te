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

**This is a remote-support tool and the copy says only that.** A previous edit
listed pending Windows updates and event logs here, which reads as a claim to do
patch management. Rem0te *reports* what a machine is waiting to install; it does
not install it, schedule it, or remediate anything — and the Tactical RMM
integration is one more way to open a session, not a foothold in that category.

Somebody who arrives expecting an RMM leaves disappointed, and the disappointment
is the copy's fault rather than the product's. The inventory, the event-log viewer
and the TRMM launch are all documented and in the gallery for anyone who reads
further; they do not belong in the sentence that sets expectations.

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

Fourteen, as currently set. GitHub allows up to 20.

```
rustdesk
remote-support
remote-access
self-hosted
msp
remote-desktop
multi-tenant
tactical-rmm
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
- `tactical-rmm` — kept, because there is a real integration to find and it is
  squarely about remote control: right-click an agent in TRMM, open a session
  here. Someone searching this finds a way to connect, which is what it is.
- `nestjs`, `nextjs`, `typescript`, `postgresql`, `systemd`, `ubuntu` — the
  stack and how it deploys, for contributors.

**Deliberately not `rmm`, and no longer `asset-inventory`.** Rem0te is a
remote-support tool. It does not patch, monitor or remediate, and it collects
inventory only so that a technician can see what they are about to connect to.
Both topics would advertise a category this does not compete in, and topics are
how people decide whether to click.

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
- [x] **Settings → Rules → Rulesets** — a repository ruleset named `main`,
      enforcement *active*, targeting `~DEFAULT_BRANCH`, with two rules:
      **Restrict deletions** and **Block force pushes**. No bypass actors, so it
      binds repository admins too — which is the point, since the account that
      would force-push by accident is the one with admin.

      Verify server-side rather than with `git push --dry-run`, which never
      contacts GitHub for rule evaluation and happily reports a force-push it
      would not be allowed to make:

      ```bash
      gh api repos/agit8or1/rem0te/rules/branches/main -q '[.[].type]'
      # ["deletion","non_fast_forward"]
      ```

- [ ] **Require status checks** — deliberately NOT set. CI (`check`, `audit`)
      runs *on push* to `main`, so a commit cannot already be green at the
      moment it is pushed; requiring checks would block every direct push and
      force a pull-request workflow. This repository commits straight to `main`.
      Turn it on together with that change of workflow, not before, and require
      both `check` and `audit`.

- [ ] Confirm the default branch is `main`, which the CI badge in the README assumes.
