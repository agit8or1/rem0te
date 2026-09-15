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

**None.** There is no public website or hosted demo for this project at present, and
no URL has been verified. Leave the **Website** field empty rather than pointing it
at a page that does not exist.

If one is published later, set it here first. Using the GitHub Pages URL for the repo
is only appropriate once Pages is actually enabled and serving content.

## Topics

Ten topics, ordered most to least important. GitHub allows up to 20.

```
rustdesk
remote-support
remote-access
self-hosted
msp
remote-desktop
nestjs
nextjs
typescript
postgresql
```

- `rustdesk`, `remote-support`, `remote-access`, `self-hosted`, `msp` — how people
  looking for this kind of tool actually search.
- `remote-desktop` — the broader category.
- `nestjs`, `nextjs`, `typescript`, `postgresql` — the stack, for contributors.

## Repository settings checklist

Apply these by hand in the GitHub UI; none of them can be set from the repository
contents.

- [ ] **About → Description** — paste the description above.
- [ ] **About → Website** — leave empty (see above).
- [ ] **About → Topics** — add the ten topics above.
- [ ] **About** — tick *Releases*; untick *Packages* and *Environments* if unused.
- [ ] **Settings → General → Features** — Issues and Discussions on (both are linked
      from the README); Wiki off, since the documentation lives in `docs/`.
- [ ] **Settings → Security → Private vulnerability reporting** — **enable it**.
      [`.github/SECURITY.md`](../.github/SECURITY.md) tells reporters to use it, so
      the link is broken until this is on.
- [ ] **Settings → Social preview** — upload a preview image. A 1280×640 crop of
      `docs/images/github/hero-businesses.png` works.
- [ ] Confirm the default branch is `main`, which the CI badge in the README assumes.
