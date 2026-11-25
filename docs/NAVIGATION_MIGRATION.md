# Navigation migration (0.87)

0.87 *Compass* regrouped the console's menu: from eight jobs plus a
twenty-item **Settings** group to nine groups. **No URL changed.** A bookmark,
an alert e-mail's link or a link in a ticket opens the same page as before; only
where the page is listed moved. The design is in
[NAVIGATION_ARCHITECTURE.md](NAVIGATION_ARCHITECTURE.md).

If you cannot find something, press **Ctrl+K** (⌘K on a Mac) and type its
name: the palette's *Pages and settings* group lists every page you may
open, whatever the menu mode.

## Summary

| | Before (0.86) | After (0.87) |
|---|---|---|
| Top-level entries | 9 (Dashboard, Devices, Alerts, Automation, Patching, Backups, Remote Support, Reports, Settings) | 9 groups (Dashboard, Devices, Remote support, Monitoring, Patching, Automation, Reports, Security, Administration) |
| Menu entries | 51, plus 3 in the sidebar footer | 58 in the menu, 4 in the header's profile and help menus |
| Pages reached only from a Settings tab | 7 | 0 |
| Entries in Settings / Administration | 20 | 15 (Security pages moved to their own group) |
| Places called "Security" | 3 (a Settings tab, Settings → Security pages, Admin → Security) | 1 group |
| URLs changed | — | 0 |

**Standard** mode (the default) lists each group's everyday pages; the rest
are tabs along the top of the same pages and in Ctrl+K. **Advanced** lists
every page. Both reach the same pages; switch in the profile menu
(top right) under *Menu*.

## Every old entry

`unit-nav-model.mjs` reads this table: every URL in it must still be in the
menu or the palette, and the *Now* column must name the group it is in.

| Was | Where it was | URL | Now |
|---|---|---|---|
| Dashboard | Dashboard | `/dashboard` | Dashboard |
| All devices | Devices | `/endpoints` | Devices → All devices |
| My devices | Devices | `/my-computers` | Devices → My devices |
| All assigned | Devices | `/technician` | Devices → All assigned |
| Add device | Devices (shortcut) | `/endpoints/enroll` | Devices → Add device (also header + Quick actions) |
| Unassigned | Devices | `/admin/unassigned` | Devices → Unassigned (Advanced; a tab of All devices) |
| Deploy agents | Devices | `/admin/deploy` | Devices → Deploy agents (Advanced; a tab of All devices) |
| Full agent | Devices | `/endpoints/full-agent` | Devices → Full agent (Advanced; a tab of All devices) |
| Agent migrations | Devices | `/endpoints/agent-migrations` | Devices → Agent migrations (Advanced; a tab of All devices) |
| Remote access readiness | Devices | `/endpoints/remote-readiness` | Remote support → Remote access readiness (Advanced; a tab of Sessions) |
| Managed sessions | Devices | `/endpoints/managed-sessions` | Remote support → Managed sessions (Advanced; a tab of Sessions) |
| Mobile devices | Devices | `/mobile-devices` | Devices → Mobile devices |
| Alerts | Alerts | `/alerts` | Monitoring → Alerts |
| False positives & rules | Alerts | `/alerts/quality` | Monitoring → False positives & rules (Advanced; a tab of Alerts) |
| Script library | Automation | `/automation/scripts` | Automation → Script library |
| Software catalog | Automation | `/automation/software` | Automation → Software catalog |
| Tasks | Automation | `/automation/tasks` | Automation → Tasks |
| Schedules | Automation | `/automation/schedules` | Automation → Schedules |
| Patching | Patching | `/patching` | Patching → Patch management |
| Backups | Backups | `/backups` | Monitoring → Backups |
| Sessions | Remote Support | `/sessions` | Remote support → Sessions |
| Quick Connect | Remote Support | `/quick-connect` | Remote support → Quick Connect |
| Support requests | Remote Support | `/support-requests` | Remote support → Support requests |
| Technician client | Remote Support | `/downloads` | Remote support → Technician client (Advanced; a tab of Sessions) |
| Patch compliance | Reports | `/reports/patch-compliance` | Reports → Patch compliance |
| Agent coverage | Reports | `/reports/agent-coverage` | Reports → Agent coverage |
| Alert frequency | Reports | `/reports/alert-frequency` | Reports → Alert frequency |
| Offline time | Reports | `/reports/offline-time` | Reports → Offline time (Advanced; a tab of every report) |
| Software compliance | Reports | `/reports/software-compliance` | Reports → Software compliance (Advanced; a tab of every report) |
| Warranty | Reports | `/reports/warranty` | Reports → Warranty (Advanced; a tab of every report) |
| Scheduled reports | Reports | `/reports/schedules` | Reports → Scheduled reports (Advanced; a tab of every report) |
| Configuration | Settings | `/settings` | Administration → Settings |
| Users | Settings | `/users` | Administration → Users |
| Offboarding | Settings | `/offboarding` | Administration → Offboarding (Advanced; a tab of Settings) |
| Technician approvals | Settings | `/technician-approvals` | Administration → Technician approvals (Advanced; a tab of Settings) |
| Audit log | Settings | `/audit` | Security → Audit log |
| Businesses | Settings | `/businesses` | Devices → Customers |
| Technicians | Settings | `/admin/technicians` | Administration → Technicians |
| Access control | Settings | `/admin/access` | Security → Access control (Advanced; a tab of Containment) |
| Single sign-on | Settings | `/admin/sso` | Security → Single sign-on (Advanced; a tab of Containment) |
| Client updates | Settings | `/settings/client-updates` | Patching → Client updates (Advanced; a tab of Patch management) |
| Client rollouts | Settings | `/admin/rollouts` | Patching → Client rollouts (Advanced; a tab of Patch management) |
| Email | Settings | `/settings/email` | Administration → Email (Advanced; a tab of Settings) |
| AI | Settings | `/settings/ai` | Administration → AI (Advanced; a tab of Settings) |
| Warranty | Settings | `/settings/warranty` | Administration → Warranty (Advanced; a tab of Settings) |
| Backups | Settings | `/settings/backups` | Administration → Backup connections (Advanced; a tab of Settings) |
| Mobile devices | Settings | `/settings/mobile-devices` | Administration → Mobile device setup (Advanced; a tab of Settings) |
| PSA / ticketing | Settings | `/settings/psa` | Administration → PSA / ticketing (Advanced; a tab of Settings) |
| Security | Settings | `/admin/security` | Security → Server security |
| System status | Settings | `/admin/status` | Administration → System status |
| Updates | Settings | `/about` | Administration → Updates (others: profile menu → About) |
| Security features | Settings → Security tab | `/settings/security/features` | Security → Security features (Advanced; a tab of Containment) |
| Technician access | Settings → Security tab | `/settings/security/technician-access` | Security → Technician access (Advanced; a tab of Containment) |
| Containment | Settings → Security tab | `/settings/security/containment` | Security → Containment |
| Update signing | Settings → Security tab | `/settings/security/update-signing` | Security → Update signing (Advanced; a tab of Containment) |
| Monitoring policies | Settings → Monitoring & API tab | `/settings/monitoring` | Monitoring → Monitoring policies |
| API keys | Settings → Monitoring & API tab | `/settings/api-keys` | Administration → API keys (Advanced; a tab of Settings) |
| Branding | Settings → Branding tab | `/settings/branding` | Administration → Branding (Advanced; a tab of Settings) |
| My Account | Sidebar footer | `/account` | Profile menu → My account (Account & help) |
| Help & docs | Sidebar footer | `/help` | Header → Help (Account & help) |
| About | Sidebar footer | `/about` | Profile menu → About; Administration → Updates for a Platform Admin |

The **Settings** page keeps its tabs (General, Security pages, Confirm it is
you, Monitoring & API, Quick Connect, RustDesk, Branding, Network / Ports).
Its *Access Control* tab is gone: it was a tab that left the page
(UX_AUDIT.md F-13). Access control is in the Security group.

## Wording (0.87.1)

The menu already said *Customers* and *Devices* in 0.87; from 0.87.1 the pages
say it too (UX_ROADMAP.md P1-1). Nothing in this table changed: the *Was*
column keeps the old names, because that is what someone looking for a page
remembers.

| You may remember | It says now |
|---|---|
| Business, businesses | Customer, customers |
| Computer, endpoint | Device |
| Awaiting approval, Waiting for approval | Pending approval |
| *Settings → Security → Containment* (and the other Security pages) | *Security → Containment* |
| *Settings → Monitoring* | *Monitoring → Monitoring policies* |
| *Settings → Client updates*, *Client rollouts* | *Patching → Client updates*, *Client rollouts* |
| *Settings → Warranty*, *Backups*, *API keys*, *Email*, *AI*, *PSA / ticketing*, *System status* | *Administration → …* (*Backups* is *Backup connections*) |
| *Admin → Security* | *Security → Server security* |
| *Remote Support → …* | *Remote support → …* |

The role names *Business Owner* and *Business User* are unchanged, and so are
URLs, API fields and codes (`/businesses`, `/endpoints`, `businessId`,
`computers:view`). The words, and what was kept and why, are in
[UI_DESIGN_SYSTEM.md](UI_DESIGN_SYSTEM.md#words).

## Moved out of the sidebar footer

| Was | Now |
|---|---|
| Theme (light ↔ dark toggle) | Profile menu → Theme: Light, Dark or **Match system** (UX_AUDIT.md F-8: the toggle could never get back to System) |
| Support Rem0te menu | Profile menu, for the MSP's staff only (owner decision 2) |
| Sign out | Profile menu → Sign out |
| Version line | Still at the bottom of the sidebar |
| Business switcher (technicians) | Header → customer selector |

## The device page

The fifteen tabs are seven groups now: **Overview** (Overview, Performance),
**Health** (Monitoring, Event logs), **Software & updates** (Software,
Patches), **System** (Processes, Services, Network), **Tools** (Diagnostics,
Actions), **Remote** (Terminal, Files, Chat) and **History**. Every
`?tab=` link still works, including the pre-0.31 values. A **Terminal**
button sits beside Connect.

## For scripts and tests

- `[data-nav="<group>"]` is now a group's toggle button (or the link, for
  a one-entry group such as Dashboard); entries are `a[data-nav-item="<href>"]`.
- `nav-shortcut-devices`, `brand-header`, `nav-drawer`, `nav-drawer-trigger`,
  `global-search-trigger` and every `tab-<id>` are unchanged.
- A device tab outside the open group is opened by clicking its group,
  `[data-tabs~="<id>"]`, first.
