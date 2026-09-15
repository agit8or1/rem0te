# Rem0te — screenshot gallery

Every image below is a capture of the running application at **1440×1000**
(retina, `deviceScaleFactor: 2`), taken against an isolated demo database.
Nothing is mocked, drawn, or AI-generated.

**All businesses, people, devices and activity shown are fictitious.** The
RustDesk IDs are synthetic and registered with no rendezvous server, so none of
these devices can be reached. Enrollment tokens, RustDesk IDs and public IP
addresses are replaced with sample values in the browser immediately before each
capture — see [Regenerating these](#regenerating-these).

↩︎ [Back to the README](../README.md) ·
[▶ Watch the walkthrough](https://github.com/agit8or1/rem0te/releases/download/v0.13.5/walkthrough.mp4) ·
[Quick start](setup.md) · [Architecture](architecture.md) ·
[More MSP tools at mspreboot.com](https://mspreboot.com)

---

## Contents

| Section | What it covers |
|---|---|
| [Overview and dashboards](#overview-and-dashboards) | The operator's landing view and the customer list |
| [Visual insights and monitoring](#visual-insights-and-monitoring) | Client map, live sessions, history, audit, host health |
| [Device inventory](#device-inventory) | Every computer, per business and per person |
| [Everyday workflows](#everyday-workflows) | Enrolling a device, downloads, Quick Connect |
| [Access and administration](#access-and-administration) | The three-level model, capabilities, accounts |
| [Configuration](#configuration) | Platform settings, branding, releases, documentation |
| [Regenerating these](#regenerating-these) | How to rebuild the gallery without touching production |

Theme coverage is deliberately mixed: most features appear once, in whichever
theme suits them, with the dashboard captured in **both** so the theme support
is visible rather than claimed.

---

## Overview and dashboards

### Dashboard — light
<a href="images/github/dashboard-light.png"><img src="images/github/dashboard-light.png" alt="Rem0te dashboard in light theme: tiles for total computers, offline computers, active sessions and sessions over 7 and 30 days, above a map of client locations across the western United States and a recent-sessions list."></a>

Open Rem0te and see the whole estate at once — how many computers exist, how
many are offline right now, what is connected, and how much support work the
last week actually took.

### Dashboard — dark
<a href="images/github/dashboard-dark.png"><img src="images/github/dashboard-dark.png" alt="The same Rem0te dashboard in dark theme, showing 32 total computers with 24 online, 8 offline, three active sessions, the client location map and a seven-day session bar chart."></a>

The same view in dark. Both themes ship with the product and are switched from
the sidebar — this pair is the one deliberate duplicate in the gallery.

### Businesses — light
<a href="images/github/businesses-light.png"><img src="images/github/businesses-light.png" alt="The Businesses page listing six customer businesses with short code, contact address, computer count, number of people, status and creation date."></a>

Every customer business you manage, with its computer and people counts. This is
the top of the hierarchy: each business owns its own computers, users and history.

### Business overview — dark
<a href="images/github/business-overview-dark.png"><img src="images/github/business-overview-dark.png" alt="A single business detail page in dark theme showing contact details, creation date, and a Quick Connect toggle for that business."></a>

One customer's record, including the per-business Quick Connect switch that
gates temporary support access for their users.

---

## Visual insights and monitoring

### Client locations map — dark
<a href="images/github/client-map-dark.png"><img src="images/github/client-map-dark.png" alt="Close view of the client locations map in dark theme, with clustered green markers over Everett, Spokane, Seattle, Portland, Bend, Boise and Denver, each labelled with a device count."></a>

Managed computers plotted from the address each last checked in from, clustered
by city with a count. Useful for spotting a site that has gone dark.

### Live sessions — dark
<a href="images/github/sessions-live-dark.png"><img src="images/github/sessions-live-dark.png" alt="The Sessions page in dark theme, showing a grid of currently-online enrolled clients, each card with hostname, business, last-seen time and a Connect button."></a>

Everything online right now, grouped as connectable cards. One click launches
the technician's local RustDesk client against that machine.

### Session history — light
<a href="images/github/session-history-light.png"><img src="images/github/session-history-light.png" alt="Session history in light theme, listing completed support sessions with technician, business, issue description, start time and duration."></a>

What was done, by whom, on which machine and for how long — the record you go
back to when a customer asks what you did last Tuesday.

### Audit log — dark
<a href="images/github/audit-timeline-dark.png"><img src="images/github/audit-timeline-dark.png" alt="The audit log in dark theme, a timeline of actions including session completed, session launched, login success and quick connect ended, each with timestamp, actor, resource and source IP."></a>

An append-only trail of every action: sign-ins, session launches, credential
reveals, capability changes. Failures never crash the request path, so the log
is what actually happened.

### Audit log — light
<a href="images/github/audit-timeline-light.png"><img src="images/github/audit-timeline-light.png" alt="The same audit log in light theme with filters for actor ID and resource above a table of timestamped actions."></a>

The same trail with the actor and resource filters, for narrowing to one person
or one machine.

### System status — dark
<a href="images/github/system-status-dark.png"><img src="images/github/system-status-dark.png" alt="System status page in dark theme showing uptime, CPU load, memory and disk usage bars, and a service list with Reboot Remote API, web, Caddy, PostgreSQL, Redis and RustDesk hbbs and hbbr all marked active."></a>

Host health and the services Rem0te depends on — including RustDesk's own `hbbs`
and `hbbr` — so you can tell a platform problem from a customer problem.

### Security overview — light
<a href="images/github/security-overview-light.png"><img src="images/github/security-overview-light.png" alt="The platform security page in light theme summarising security posture checks."></a>

The platform's own security surface, in one place.

---

## Device inventory

### All computers — light
<a href="images/github/computers-inventory-light.png"><img src="images/github/computers-inventory-light.png" alt="The Enrolled Clients list in light theme, showing computers across all businesses with name, owning business, platform badge, masked RustDesk ID, last seen and online status."></a>

Every managed computer across every business, searchable, with platform and live
status. RustDesk IDs are masked in this gallery.

### All computers — dark
<a href="images/github/computers-inventory-dark.png"><img src="images/github/computers-inventory-dark.png" alt="The same enrolled clients inventory in dark theme."></a>

### One business's computers — dark
<a href="images/github/business-computers-dark.png"><img src="images/github/business-computers-dark.png" alt="The Computers tab of a single business in dark theme, listing that customer's machines with Windows, macOS and Linux platform badges and online or offline status."></a>

Scoped to a single customer — the view you use when they phone up.

### Computer detail — light
<a href="images/github/device-detail-light.png"><img src="images/github/device-detail-light.png" alt="A single computer's detail page in light theme showing its platform, operating system version, status and connection controls."></a>

One machine: what it is, what it runs, and the controls to connect to it.

### My Computers — dark
<a href="images/github/my-computers-dark.png"><img src="images/github/my-computers-dark.png" alt="The My Computers page in dark theme, showing only the machines the signed-in user has been granted access to, each with a Connect button."></a>

What a Business User sees — only the machines they were granted, and a Connect
button. No RustDesk IDs to type, no passwords to pass around.

### Unassigned computers — light
<a href="images/github/unassigned-light.png"><img src="images/github/unassigned-light.png" alt="The unassigned computers page in light theme, for machines that have enrolled but do not yet belong to a business."></a>

Machines that enrolled but have not landed in a business yet.

---

## Everyday workflows

### Enrol a managed device — light
<a href="images/github/enroll-device-light.png"><img src="images/github/enroll-device-light.png" alt="The three-step enrollment form in light theme: choose the business, choose which users may connect with one user ticked, and choose Windows, Linux or macOS before generating an installer."></a>

Pick the business, pick who may connect, pick the platform. The business is
bound into the installer when it is generated — the machine that runs it cannot
place itself somewhere else.

### Enrol a managed device — dark
<a href="images/github/enroll-device-dark.png"><img src="images/github/enroll-device-dark.png" alt="The same enrollment workflow in dark theme with a different business selected, showing that business's users as the access options."></a>

Choosing a different business narrows the access list to that business's people.

### Downloads — dark
<a href="images/github/downloads-dark.png"><img src="images/github/downloads-dark.png" alt="The Downloads page in dark theme offering the preconfigured RustDesk client, an unconfigured client and a setup command for the technician's own computer."></a>

The clients Rem0te hands out, including the preconfigured RustDesk build that
already knows where your server is.

### Quick Connect — light
<a href="images/github/quick-connect-light.png"><img src="images/github/quick-connect-light.png" alt="The Quick Connect page in light theme with remote ID and password fields, a client download panel and a five-step explanation of a temporary session."></a>

Temporary help for a machine that is **not** an enrolled device. They run a
client, read you an ID and a one-time password, and closing it ends the session.
No computer record is created.

### Built-in help — dark
<a href="images/github/help-dark.png"><img src="images/github/help-dark.png" alt="The Help and Docs page in dark theme, with an expanded section explaining how RustDesk connections work through the hbbs rendezvous server and hbbr relay, above collapsed sections for server setup, enrolling endpoints and troubleshooting."></a>

Answers in the product, not just the repository — how connections are brokered,
why a Connect can fail, and what to do about it.

---

## Access and administration

### The access model — light
<a href="images/github/access-model-light.png"><img src="images/github/access-model-light.png" alt="The Access Control overview in light theme showing three stacked levels: Platform Admin with full platform access, Business Owner with full control of one business, and Business User with permissions assigned by the owner."></a>

Three levels and no reseller hierarchy. A **Business** is the security boundary,
enforced on the server rather than by hiding buttons.

### Business users and capabilities — dark
<a href="images/github/access-users-dark.png"><img src="images/github/access-users-dark.png" alt="The Business Users tab in dark theme, listing people across businesses with their level, the number of capabilities granted, status, and buttons to edit permissions or change level."></a>

Who can do what, per business. Owners hold everything; each Business User shows
the capabilities actually granted — not a role name that hides the detail.

### Platform admins — light
<a href="images/github/access-admins-light.png"><img src="images/github/access-admins-light.png" alt="The Platform Admins tab in light theme listing the operators who administer the whole platform."></a>

The short list of people who run the service itself.

### Users — dark
<a href="images/github/users-dark.png"><img src="images/github/users-dark.png" alt="The Users page in dark theme listing all accounts with their business, job title and status."></a>

Every account on the platform, across all businesses.

### My account and security — light
<a href="images/github/account-security-light.png"><img src="images/github/account-security-light.png" alt="The My Account page in light theme, on the Profile tab showing identity and contact fields, with Password and Two-Factor Auth available as further tabs."></a>

Your own profile, password and two-factor enrolment, each on its own tab.

---

## Configuration

### Platform settings — dark
<a href="images/github/settings-dark.png"><img src="images/github/settings-dark.png" alt="Platform settings in dark theme covering RustDesk relay configuration, the Quick Connect master switch and MFA policy."></a>

RustDesk infrastructure, the Quick Connect master switch and MFA policy — the
settings that apply to the whole platform.

### Branding — light
<a href="images/github/branding-light.png"><img src="images/github/branding-light.png" alt="The branding settings page in light theme for setting the product name and logo shown to customers."></a>

Name and logo shown to the businesses you support.

### Release history — dark
<a href="images/github/release-history-dark.png"><img src="images/github/release-history-dark.png" alt="The About page in dark theme showing the running version and a parsed list of releases from the changelog."></a>

The running version and the release history, parsed from `CHANGELOG.md`.

### Built-in documentation — light
<a href="images/github/documentation-light.png"><img src="images/github/documentation-light.png" alt="The in-app documentation browser in light theme with a searchable index of guides."></a>

The same guides that live in `docs/`, searchable inside the app.

---

## Regenerating these

Captures run against an **isolated demo stack** — never production, and never a
database with real records. The capture script refuses an `https://` target or
port 3000/443 outright.

```bash
# 1. Throwaway database (the demo-data module refuses any other name)
sudo -u postgres createdb reboot_remote_docs
cd apps/api
DATABASE_URL=postgresql://…/reboot_remote_docs npx prisma migrate deploy
DATABASE_URL=… npx tsx prisma/seed.ts
DATABASE_URL=… npx tsx prisma/_docs-demo-data.ts

# 2. Run the API and web against it on non-production ports (4001 / 4000).
#    `output: 'standalone'` bakes the API rewrite in at build time, so patch
#    the copied build rather than relying on INTERNAL_API_URL. See CLAUDE.md.

# 3. Re-anchor the demo clocks, then capture. Online/offline is derived from
#    how recently a device checked in, and the API sweeps the flag as data
#    ages — without this the dashboard counts stop matching the inventory.
DATABASE_URL=… npx tsx prisma/_docs-demo-refresh.ts   # run from apps/api
WEB_URL=http://127.0.0.1:4000 EMAIL=… PASSWORD=… \
  node apps/web/scripts/capture-media.mjs          # gallery -> docs/images/github/
WEB_URL=http://127.0.0.1:4000 EMAIL=… PASSWORD=… \
  node apps/web/scripts/capture-video.mjs          # recording -> media/raw/
scripts/build-video.sh                             # MP4 + poster + highlight
```

`docs/images/github/manifest.json` records the route, theme and viewport behind
every image. Credentials are passed as environment variables and are never
written to a script, a manifest, or the repository.

`apps/web/scripts/screenshots.mjs` is a **different** tool and is still in use:
it produces the numbered-callout images embedded in the in-app documentation
under `docs/screenshots/`. This gallery and that guide do not share files.

Masking happens in the browser DOM immediately before each shutter and never
writes to the database:

| Value | Shown as |
|---|---|
| Enrollment / claim tokens | `SAMPLE-ENROLLMENT-TOKEN` |
| Long hex secrets | `SAMPLE-TOKEN-VALUE` |
| RustDesk IDs | `•••••••••` |
| Public IP addresses | `198.51.100.24` (RFC 5737 documentation range) |

Private ranges and loopback are left as they are — they carry nothing.

---

<sub>Rem0te is one of several free tools for MSPs published at
[mspreboot.com](https://mspreboot.com). ↩︎ [Back to the README](../README.md)</sub>
