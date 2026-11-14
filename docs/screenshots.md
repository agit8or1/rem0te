# Rem0te — screenshot gallery

Every image below is a capture of Rem0te running against an isolated demo
database (most from **v0.36**; the device list, the device tabs, the AI, ticket, chat, winget and Actions images
from **v0.48**), at **1440×1000** or, where marked, **390×844** (phone width), both at
`deviceScaleFactor: 2`.
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
| [Overview and dashboards](#overview-and-dashboards) | The dashboard, search, the customer list |
| [Visual insights and monitoring](#visual-insights-and-monitoring) | Client map, alerts, live sessions, history, audit, host health |
| [Devices](#devices) | The device list, bulk actions, saved views, one device, Linux and macOS |
| [Device tabs](#device-tabs) | Performance, processes, services, network, patches, event log, Ask AI and Create ticket, actions, chat |
| [Everyday workflows](#everyday-workflows) | Adding a device, downloads, Quick Connect, launching from Tactical RMM |
| [Reports, automation and patching](#reports-automation-and-patching) | Reports, the script library, the winget catalog, client-update windows, patch policies |
| [Access and administration](#access-and-administration) | The three-level model, capabilities, accounts |
| [Configuration](#configuration) | Platform settings, branding, AI, PSA / ticketing, releases, documentation |
| [Regenerating these](#regenerating-these) | How to rebuild the gallery without touching production |

Most features appear once, in whichever theme suits them; the dashboard, device
list and a device page are also shown at phone width.

---

## Overview and dashboards

### Dashboard — light
<a href="images/github/dashboard-light.png"><img src="images/github/dashboard-light.png" alt="The Rem0te dashboard in light theme: a red site-outage strip for Harbor Logistics' Tacoma warehouse, tiles for devices, critical alerts, failed actions, awaiting approval, restart pending, patch compliance and active sessions, a ranked Work on next list with the reason for each item, and the customers affected."></a>

What needs a person, first. A site outage is one item rather than three offline
alerts; every tile is a count with what it is counted from; *Work on next* says why
each item is there.

### Dashboard — dark
<a href="images/github/dashboard-dark.png"><img src="images/github/dashboard-dark.png" alt="The same dashboard in dark theme."></a>

The same view in dark. Both themes ship with the product and are switched from
the sidebar.

### Dashboard at phone width — light
<a href="images/github/dashboard-narrow-light.png"><img src="images/github/dashboard-narrow-light.png" alt="The dashboard at 390 pixels wide in light theme: a menu button and search across the top, the whole site-outage sentence with Open alerts, then the tiles two to a row."></a>

At 390 px the sidebar is a drawer behind the menu button, and the page scrolls
instead of fitting the screen. The outage strip is capped only on the fitted
desktop layout, so on a phone it shows its whole sentence.

### Dashboard at phone width — dark
<a href="images/github/dashboard-narrow-dark.png"><img src="images/github/dashboard-narrow-dark.png" alt="The same phone-width dashboard in dark theme."></a>

### Search everything — dark
<a href="images/github/search-dark.png"><img src="images/github/search-dark.png" alt="The Ctrl+K search box in dark theme with harb typed: eight Harbor Logistics devices with online or offline badges and the matched letters highlighted, then the business."></a>

**Ctrl+K** from any page: devices, businesses, sites, people and open alerts, each
group only if you may open its list page.

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

### Alerts — dark
<a href="images/github/alerts-dark.png"><img src="images/github/alerts-dark.png" alt="The Alerts page in dark theme: totals for open, acknowledged, critical, warning and in-maintenance alerts, a filter, and the open alerts including a site outage and a stopped Print Spooler."></a>

Every open alert, deduplicated: a problem that repeats is one alert with a count,
and a site outage gathers the computers it took down.

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

## Devices

### Device list — light
<a href="images/github/computers-inventory-light.png"><img src="images/github/computers-inventory-light.png" alt="The Devices list in light theme at 1440 pixels: search, filters for business, site, group, online, alerts, agent, restart pending and archived, Views, Columns and Export CSV, above a table with device, business, health, last seen, CPU, RAM and disk, and pending patches, and a Connect button per row."></a>

From 0.48.1 the list fits the window from 1280 to 2560 pixels with the sidebar open. Each wider column appears
at its own width: Last seen from 1440 pixels, Agent from 1536, OS from 1700, Site from 1860 and Logged-in user from
2000. Alerts is off by default because Health already shows the worst open
alert.

Every device you may see, across every business. The server does the searching and
filtering, so it covers every page, not just the one on screen.

### Device list — dark
<a href="images/github/computers-inventory-dark.png"><img src="images/github/computers-inventory-dark.png" alt="The same device list in dark theme."></a>

### Bulk actions — dark
<a href="images/github/device-bulk-dark.png"><img src="images/github/device-bulk-dark.png" alt="The device list in dark theme with three devices ticked and the bulk bar showing group membership, Refresh inventory, Queue client update, Update agent, Upgrade to signed and Export selection."></a>

Tick devices for group membership, an inventory refresh, a client update, an agent
update or upgrade, or an export of just those rows.

### Saved views — light
<a href="images/github/device-views-light.png"><img src="images/github/device-views-light.png" alt="The Views menu open on the device list in light theme, listing views shared in each business such as Harbor — offline, with Save current view, Save filters as a rule group and Device groups below."></a>

Filters, sort, columns and density saved under a name, for yourself or shared in a
business. A shared view still shows each person only what they may see.

### Device list at phone width — dark
<a href="images/github/device-list-narrow-dark.png"><img src="images/github/device-list-narrow-dark.png" alt="The device list at 390 pixels wide in dark theme, its filters stacked one per row."></a>

### One business's computers — dark
<a href="images/github/business-computers-dark.png"><img src="images/github/business-computers-dark.png" alt="The Computers tab of a single business in dark theme, listing that customer's machines with Windows, macOS and Linux platform badges and online or offline status."></a>

Scoped to a single customer — the view you use when they phone up.

### A device — light
<a href="images/github/device-detail-light.png"><img src="images/github/device-detail-light.png" alt="HARB-DISPATCH-01's page in light theme: status, Connect, Diagnose, Run action, Patch and More, an attention strip with one critical alert, two pending updates and the signed agent, the tabs, and the Overview's assignment, key alerts, patch status and recent activity."></a>

One device: its state, what is wrong with it, and the tabs for everything else. An
action that is not available says why underneath.

### A device at phone width — light
<a href="images/github/device-overview-narrow-light.png"><img src="images/github/device-overview-narrow-light.png" alt="The same device page at 390 pixels wide in light theme, the actions and the attention strip wrapping onto their own rows and the tabs scrolling sideways."></a>

### Agent silent — light
<a href="images/github/device-agent-silent-light.png"><img src="images/github/device-agent-silent-light.png" alt="NWD-BILLING-RMT's page in light theme in the amber agent-silent state: reachable through RustDesk, but its agent has not checked in for three days, so monitoring, patching and actions are not reporting."></a>

Reachable, but not reporting. RustDesk still sees the computer, so Connect works;
the agent has not checked in for 30 minutes or more, so nothing it measures is
current. The dashboard counts it apart from online and offline, and the map draws
it amber.

### A device group's monitor — dark
<a href="images/github/device-group-monitor-dark.png"><img src="images/github/device-group-monitor-dark.png" alt="HARB-DEPOT-BOI's Monitoring tab in dark theme, showing the Offline monitor coming from the Remote depots device group with its 60-minute threshold rather than the business default."></a>

Policy by device group: the Remote depots group raises its Offline monitor to 60
minutes because the depot VPN drops, and the tab says which scope each rule came
from.

### Resource gauges — light
<a href="images/github/device-resources-light.png"><img src="images/github/device-resources-light.png" alt="The Resources card on a computer's page in light theme: CPU, memory and system disk shown as labelled meters with percentages, the memory meter reading 44 percent of 16 GB and the disk meter showing free space, above a note saying when the sample was taken."></a>

CPU, memory and system disk, sampled on the computer's heartbeat rather than
read from the six-hourly inventory pass — so these are minutes old, and the
card says so instead of letting a needle imply "now". Amber past 80% and red
past 92%, the point at which a Windows volume starts failing updates.

### Device specs — dark
<a href="images/github/device-specs-dark.png"><img src="images/github/device-specs-dark.png" alt="The collected-inventory cards on a computer's page in dark theme: System, Session, Hardware, Memory, Storage with usage bars, Network, and an Updates card showing two pending Windows updates beside the agent and RustDesk versions."></a>

What a managed computer reports about itself, collected by its agent on a
heartbeat rather than fetched live — so every card says how old its contents
are. Hardware, storage and network come in every six hours, pending Windows
updates every twelve, and who is signed in on every beat.

Three separate things can be out of date here — the Rem0te agent, the RustDesk
client, and the machine's own Windows updates — so each is named rather than
merged into one "up to date" claim.

### A Linux device — dark
<a href="images/github/device-linux-dark.png"><img src="images/github/device-linux-dark.png" alt="CASC-FILESRV's page in dark theme: an Ubuntu file server on the read-only Linux agent, with four apt updates pending and a restart required."></a>

Linux and macOS computers run read-only agents: heartbeat, inventory and pending
updates, and nothing the console sends.

### My Computers — dark
<a href="images/github/my-computers-dark.png"><img src="images/github/my-computers-dark.png" alt="The My Computers page in dark theme, showing only the machines the signed-in user has been granted access to, each with a Connect button."></a>

What a Business User sees — only the machines they were granted, and a Connect
button. No RustDesk IDs to type, no passwords to pass around.

### Unassigned computers — light
<a href="images/github/unassigned-light.png"><img src="images/github/unassigned-light.png" alt="The unassigned computers page in light theme, for machines that have enrolled but do not yet belong to a business."></a>

Machines that enrolled but have not landed in a business yet.

---

## Device tabs

### Performance — light
<a href="images/github/device-performance-light.png"><img src="images/github/device-performance-light.png" alt="The Performance tab in light theme over 7 days: processor, memory, system disk and a volume, each the hourly mean with a pale band for the lowest to highest sample."></a>

Metric history: 24 hours of every sample, then hourly means with their range for
7, 30 and 90 days. Hatched stretches are gaps, where no samples arrived.

### Performance — dark
<a href="images/github/device-performance-dark.png"><img src="images/github/device-performance-dark.png" alt="The same Performance tab in dark theme over 24 hours."></a>

### Processes — dark
<a href="images/github/device-processes-dark.png"><img src="images/github/device-processes-dark.png" alt="The Processes tab in dark theme: a snapshot with its age and who asked, a filter, and processes sorted by memory with PID, CPU time, user and start time, each row with End process or a Protected badge."></a>

A snapshot, not a live view: it says when it was taken and who asked. From 0.45 a row's
**End process** asks the full agent to end that process as an approved action; Windows,
security, Rem0te and RustDesk processes show *Protected* instead.

### Ending a process — light
<a href="images/github/process-stop-light.png"><img src="images/github/process-stop-light.png" alt="The End process dialog for SearchIndexer.exe in light theme: the process id, name and start time the computer will check, the option to end the processes it started, the warnings, the reason, the window and the confirmation."></a>

The plan names the process id, its name and when it started; the computer refuses unless
all three still match, so a process id Windows has reused is never ended. It has been
tested against a simulated Windows only.

### Services — light
<a href="images/github/device-services-light.png"><img src="images/github/device-services-light.png" alt="The Services tab in light theme listing services with state, start mode and the account each runs as, with Start, Stop, Restart and Startup type buttons, and protected services marked Protected with the reason."></a>

Display name, name, state, start mode and account. From 0.45 each row offers only the
operations allowed for that service, each a signed approved action.

### Changing a service — dark
<a href="images/github/service-control-dark.png"><img src="images/github/service-control-dark.png" alt="The Startup type dialog for the Print Spooler in dark theme: what the latest list says, the startup types allowed, what is never changed, the warnings, the reason, the window, the confirmation and Run it."></a>

Only the state or the startup type ever changes; the program, account, password,
recovery actions and dependencies never do. Tested against a simulated Windows only.

### Network — dark
<a href="images/github/device-network-dark.png"><img src="images/github/device-network-dark.png" alt="The Network tab in dark theme: one card per adapter with status, speed, addresses, gateway, DNS, MAC and DHCP lease."></a>

### Patches — light
<a href="images/github/device-patches-light.png"><img src="images/github/device-patches-light.png" alt="The Patches tab in light theme: patch status from the standard agent scan, Install updates explaining it needs the signed agent, Windows Update with Scan now, and the two updates offered with KB, severity and size."></a>

What the evidence is and how old, what is offered, and, when deploying is not
possible on this computer, why.

### Event log — dark
<a href="images/github/device-event-log-dark.png"><img src="images/github/device-event-log-dark.png" alt="The Event Log tab on a computer's page in dark theme, with selectors for log, time range and event count, level chips for Critical, Error, Warning and Information, an optional source filter, and a table of returned System log entries with timestamps, level badges, event IDs, providers and messages."></a>

Read a page of a managed computer's Windows event log without connecting to it. From
0.48 each entry has **Ask AI** and **Create ticket**; the second entry here already has a ticket.
Five logs are available — Application, System, Security, Setup and Windows
PowerShell — and nothing else: the allowlist is enforced by the API and again
by the agent that opens the log.

There is no channel to reach into an endpoint, so this is a request rather than
a query: it is collected on the machine's next heartbeat, up to about three
minutes away. Reading logs is its own permission, separate from viewing the
computer, and every request is audited with the log, the window and who asked.

### Ask AI — dark
<a href="images/github/ask-ai-dark.png"><img src="images/github/ask-ai-dark.png" alt="The AI explanation dialog in dark theme for a Print Spooler event 7000: the provider and model, how many values were redacted, what it means, likely causes, whether it matters, safe next steps, Show what was sent and Copy."></a>

The entry is redacted on the server before anything is sent; the dialog names the
provider and model and how many values were removed. The answer shown came from a
loopback stand-in on the demo server, not a real provider.

### Create ticket — light
<a href="images/github/create-ticket-light.png"><img src="images/github/create-ticket-light.png" alt="The Create ticket dialog in light theme: sent to the HaloPSA automation webhook, the filled-in subject, a note, Include AI explanation, and Send."></a>

The ticket goes to the business's own connector, or the platform default. The demo
server's connector is a loopback stand-in; no real PSA was called.

### Actions — light
<a href="images/github/actions-spooler-light.png"><img src="images/github/actions-spooler-light.png" alt="The Actions tab in light theme: the action picker, the Start the Windows Print Spooler warnings, the direct-mode note, Print Spooler Stopped with its time and Refresh, the reason box and Run it."></a>

From 0.47.1 the Spooler action shows the service's last known state. When it is
already running the button reads *Nothing to do*.

### Chat with files — dark
<a href="images/github/chat-files-dark.png"><img src="images/github/chat-files-dark.png" alt="A computer's Chat tab in dark theme: the chat window is open on the computer, a picture of a printer error shown inline, a text file offered as a download, emoji in the messages, a Read receipt, and the emoji and paperclip buttons."></a>

Pictures are shown only when their first bytes say PNG, JPEG, GIF or WebP; anything
else is a download. The tray's chat window has not yet run on real Windows.

### The chat inbox — light
<a href="images/github/chat-inbox-light.png"><img src="images/github/chat-inbox-light.png" alt="The dashboard in light theme with the header's chat inbox open: one open chat on HARB-DISPATCH-01 with two unread replies and the sound switch."></a>

Unread replies from every open chat you can see, from anywhere in the console.

---

## Everyday workflows

### Add a device — light
<a href="images/github/add-device-light.png"><img src="images/github/add-device-light.png" alt="The Add device page in light theme: Harbor Logistics and the Tacoma warehouse chosen in step 1, and step 2 offering Windows, Linux or macOS, each saying which agent it installs."></a>

Business, site, who may connect, then the operating system. All of it is fixed into
the single-use install link: the machine that runs it cannot place itself
somewhere else.

### Add a device — dark
<a href="images/github/add-device-dark.png"><img src="images/github/add-device-dark.png" alt="The same page in dark theme with Cascade Accounting chosen, offering that business's people as the ones who may connect."></a>

Choosing a business narrows the access list to that business's people.

### Downloads — dark
<a href="images/github/downloads-dark.png"><img src="images/github/downloads-dark.png" alt="The Downloads page in dark theme offering the preconfigured RustDesk client, an unconfigured client and a setup command for the technician's own computer."></a>

The clients Rem0te hands out, including the preconfigured RustDesk build that
already knows where your server is.

### Launched from Tactical RMM — dark
<a href="images/github/trmm-match-dark.png"><img src="images/github/trmm-match-dark.png" alt="The from-Tactical-RMM landing page in dark theme, warning that more than one computer matches the hostname reception-pc and listing two candidates from different customer businesses, each with its online status, business, site and last-seen time, and a Connect button."></a>

What a Tactical RMM URL Action lands on. Right-click an agent in TRMM and
Rem0te resolves it to a computer and connects.

Here it will not: two customers both have a machine the front desk calls
`reception-pc`, which is most MSPs rather than a contrived example. Rem0te
refuses to pick — guessing opens a remote session on somebody else's machine —
and remembers whichever you choose, so the next launch goes straight through.

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

## Reports, automation and patching

### Patch compliance — light
<a href="images/github/reports-patch-light.png"><img src="images/github/reports-patch-light.png" alt="The Patch compliance report in light theme: 28 percent compliant, 74 percent coverage, nine coverage gaps and six restart pending, then a table by business."></a>

From stored scans only: a device with no fresh scan is a coverage gap, never counted
as compliant or not.

### Alert frequency — light
<a href="images/github/reports-alerts-light.png"><img src="images/github/reports-alerts-light.png" alt="The Alert frequency report in light theme: alerts raised and resolved by business, site, computer and monitor type, with times to resolve."></a>

### Offline time — dark
<a href="images/github/reports-offline-dark.png"><img src="images/github/reports-offline-dark.png" alt="The Offline time report in dark theme: recorded offline time, episodes, offline now, and a table by site and by computer."></a>

Measured from the Offline monitor's episodes. There is no availability percentage,
because the time each computer was monitored is not recorded.

### Script library — dark
<a href="images/github/script-library-dark.png"><img src="images/github/script-library-dark.png" alt="The Script library in dark theme with How a script runs (only an approved version, only as a signed action, approved twice) and what is and is not proven yet, above three scripts with their scope, review state and risk."></a>

Scripts written, versioned and reviewed in the portal, and run only as signed
actions. The notice says what has been proven and what has not.

### Reviewing a script — light
<a href="images/github/script-review-light.png"><img src="images/github/script-review-light.png" alt="Version 2 of Clear stuck print queue in review in light theme: its versions, hashes, static checks, the content, and Approve and Reject."></a>

The reviewer approves an exact hash, and cannot be the person who wrote the content.

### Browsing the winget catalog — light
<a href="images/github/winget-browse-light.png"><img src="images/github/winget-browse-light.png" alt="The Software catalog page in light theme: the winget community catalog with the catalog to build, a filter, A to Z letters, three packages ticked and Add 3 selected to the global catalog."></a>

Tick up to 25 packages and add them to a catalog in one go; each is pinned to its
latest version and installer hash. The demo server holds a 36-package sample of the index.

### Client updates in a window — light
<a href="images/github/client-updates-light.png"><img src="images/github/client-updates-light.png" alt="Settings, Client updates for Harbor Logistics in light theme: a notice that the sweep is off on this server, the business policy's windows, the Tacoma warehouse override, the Remote depots device-group policy, and each computer's automatic-update state."></a>

Outdated RustDesk clients updated by the server, only inside a window outside
working hours, skipping computers with a session open.

### Patching — dark
<a href="images/github/patch-policies-dark.png"><img src="images/github/patch-policies-dark.png" alt="The Patching page in dark theme for Harbor Logistics: the signed patching pre-flight with nine failing checks and the fix for each, and two automatic patch policies, one awaiting approval and one active."></a>

The pre-flight reads each requirement from the real server. On this demo server they
all fail, because there is no signer, and the page says exactly that.

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

### AI provider — light
<a href="images/github/settings-ai-light.png"><img src="images/github/settings-ai-light.png" alt="Settings, AI in light theme: what is redacted before anything is sent, Enable Ask AI, the provider, the model, the API key shown only as set and its last four characters, Save, and Test the provider."></a>

Platform Admins only. The key is write-only. The demo server's key is a fake one and its
provider a loopback stand-in.

### PSA / ticketing — dark
<a href="images/github/settings-psa-dark.png"><img src="images/github/settings-psa-dark.png" alt="Settings, PSA / ticketing in dark theme: the platform default is a signed webhook named HaloPSA automation, the connector form, the signing secret, and the body the webhook receives."></a>

Where *Create ticket* sends. The saved URL is never shown again, only its host; on the
demo server that host is a loopback stand-in.

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
DATABASE_URL=… ENCRYPTION_KEY=… npx tsx prisma/_docs-demo-data.ts

# 2. Run the API and web against it on non-production ports (4001 / 4000).
#    `output: 'standalone'` bakes the API rewrite in at build time, so patch
#    the copied build rather than relying on INTERNAL_API_URL. See CLAUDE.md.

# 3. Re-anchor the demo clocks, then capture. Online/offline is derived from
#    how recently a device checked in, and the API sweeps the flag as data
#    ages — without this the dashboard counts stop matching the inventory.
DATABASE_URL=… npx tsx prisma/_docs-demo-monitoring.ts # monitors, alerts, a site outage, API keys
DATABASE_URL=… npx tsx prisma/_docs-demo-workbench.ts  # 0.31–0.36 pages, see below
DATABASE_URL=… DOCS_AGENT_SHA256=… [DOCS_CHAT_IMAGE=…] \
  npx tsx prisma/_docs-demo-dispatch.ts                 # 0.41–0.48 pages, see below
DATABASE_URL=… npx tsx prisma/_docs-demo-refresh.ts    # last, right before capturing
# Run the demo API with every sweep off, or it acts on the demo data:
#   MONITOR_SWEEP=off CLIENT_UPDATE_SWEEP=off PATCH_POLICY_SWEEP=off \
#   METRIC_SWEEP=off RETENTION_SWEEP=off REPORT_SCHEDULE_SWEEP=off \
#   SCRIPT_OUTPUT_SWEEP=off CHAT_RETENTION_SWEEP=off AUDIT_SEALER=off \
#   STALE_SWEEP=off SNAPSHOT_SWEEP=off TRAY_SWEEP=off \
#   AUTO_MIGRATION_SWEEP=off WINGET_INDEX_SWEEP=off AGENT_AUTO_UPDATE=off
#   GEOIP_DB_PATH=<a file that does not exist>   # or it reads this host's GeoIP
# For the 0.41–0.48 pages the demo API also needs (see below):
#   NODE_ENV=test AI_TEST_BASE_URL=http://127.0.0.1:<stub>   # loopback AI stand-in
#   APPROVAL_SIGNER_INTERNAL_URL=…  UPDATE_REPO_DIR=…       # a scratch signer and release repo
# STALE_SWEEP=off matters: the demo's agent-silent computer is isOnline with
# an old heartbeat, and the stale sweep would mark it offline.
# The client-update and patching pages then say their sweep is off; that is
# what the screenshots show, and it is true of the demo server.
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
under `docs/screenshots/`. This gallery and that guide do not share files. It
runs against the same stack and refuses any other database:

```bash
DATABASE_URL=…/reboot_remote_docs WEB_URL=http://127.0.0.1:4000 \
  node apps/web/scripts/screenshots.mjs            # guide -> docs/screenshots/
ONLY=guide/alerts,guide/api-keys …                 # just some of them
```

Each guide image is followed in the markdown by a numbered list explaining
its callouts; keep the two in step when a callout is added or moved.

`_docs-demo-workbench.ts` (0.34, extended in 0.36) seeds what the 0.31–0.36 pages need, and can be
re-run: it deletes what it owns first. It refuses any database not named
`reboot_remote_docs`, like the other demo modules. It writes:

- a Linux and a macOS computer on the read-only agents;
- 30 days of metric history (raw samples for the last 24 hours, hourly rows and
  six-hourly disk samples before that, with one deliberate gap);
- process, service and network snapshots, run through the API's own sanitiser
  and size cap;
- device groups and shared saved views;
- resolved alert history, which the alert and offline-time reports count;
- scripts with an approved version and a version in review;
- client-update policies with a site override, a device-group policy on
  Remote depots, and two held updates;
- a device-group Offline monitor on Remote depots (60 minutes);
- two patch policies, one awaiting approval and one active;
- a fictional relay host (`remote.example.net`) and Quick Connect turned on.

`_docs-demo-dispatch.ts` (0.48.1) seeds what the 0.41–0.48 pages need, and can be re-run. It refuses any database
not named `reboot_remote_docs`. It writes:

- a 36-package sample of the winget index, for the catalog browser (no four-part version numbers: the masks below
  would print one as an IP address);
- HARB-DISPATCH-01 and -02 on the signed agent at 0.48.0 with the whole action catalog, so the Services, Processes
  and Actions tabs offer their buttons; their agent digest is `DOCS_AGENT_SHA256`, which must be the
  `windows/rem0te-agent.exe` digest in the scratch release repository `UPDATE_REPO_DIR` points at;
- an open, recorded chat on HARB-DISPATCH-01 with emoji, a picture (`DOCS_CHAT_IMAGE`, or a generated one) and a
  text file, the last reply unread, and the chat window reported open for the next 45 minutes.

The Actions, Services and Processes buttons need an approval signer, so the demo stack runs a scratch one
(`dist/approval-signer/main.js serve`, its own `APPROVAL_SIGNER_DIR`, `policy set --business default
--approval direct`) and a scratch release repository built with `rem0te-release`. Nothing is ever approved or
executed: the captures stop at the dialog. Ask AI and Create ticket point at loopback stand-ins: the API runs with
`NODE_ENV=test` and `AI_TEST_BASE_URL` (honoured only under `test`, loopback only) and an obviously fake key, and
the PSA connector is a webhook to a loopback listener. Never point a demo stack at a real provider, PSA, SMTP server
or webhook. Ask AI caches an answer for a day, and a cached one shows a *cached* badge, so clear `AiAnswer` before
capturing it.

`_docs-demo-refresh.ts` keeps one computer, NWD-BILLING-RMT, deliberately *agent
silent*: still online to RustDesk, heartbeat three days old, so the amber state
is on the dashboard, the map and its own page. Every other computer reads agent
silent too once it has gone 30 minutes without a heartbeat, so re-run the
refresh every few minutes while capturing; it only moves timestamps.

`screenshots.mjs` deletes the audit rows its throwaway admin wrote when it
finishes. The audit chain on the docs database then reports those rows as
deleted; that is expected on a scratch database. Capture the gallery (whose
audit and security pages show the chain) before the guide, or reset the
database between them.

The PNGs are written as Playwright produces them; nothing in the pipeline
recompresses them.

Masking happens in the browser DOM immediately before each shutter and never
writes to the database:

| Value | Shown as |
|---|---|
| Enrollment / claim tokens | `SAMPLE-ENROLLMENT-TOKEN` |
| Long hex secrets | `SAMPLE-TOKEN-VALUE` |
| RustDesk IDs | `•••••••••` |
| Public IP addresses | `198.51.100.24` (RFC 5737 documentation range) |
| API key prefixes | `rk_SAMPLE` |
| Host names outside `mspreboot`, `github`, `rustdesk` and `example`, and the AI providers' fixed `api.anthropic.com` and `api.openai.com` | `remote.example.com` |

Private ranges and loopback are left as they are — they carry nothing.

---

<sub>Rem0te is one of several free tools for MSPs published at
[mspreboot.com](https://mspreboot.com). ↩︎ [Back to the README](../README.md)</sub>
