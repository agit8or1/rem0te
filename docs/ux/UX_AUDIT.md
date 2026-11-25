# UX audit — 0.85.1

The first deliverable of the owner's UI/UX initiative (directive of
2026-11-25, §3). It records what the console looks and behaves like at 0.85.0
*Mooring*, measured in the running application, so later releases can be held
to numbers rather than impressions. The plan that follows from it is
[UX_ROADMAP.md](UX_ROADMAP.md); what a change must satisfy is
[UX_ACCEPTANCE_CRITERIA.md](UX_ACCEPTANCE_CRITERIA.md); the click and time
baselines are [WORKFLOW_BENCHMARKS.md](WORKFLOW_BENCHMARKS.md).

Nothing here is evidence about endpoints. A page that looks right says nothing
about whether a computer enforces what it shows; `docs/readiness.md` is the
only place that question is answered.

## How it was measured

- **The stack.** The isolated docs stack (`docs/screenshots.md`,
  "Regenerating these"): a scratch database `reboot_remote_docs` seeded with the
  docs demo data (34 computers in five businesses, alerts, sessions, patch
  scans, warranty, backups), `_docs-demo-refresh.ts` run before each pass, an
  API on a loopback scratch port with every sweep off and `NODE_ENV=test`, and a
  copy of the standalone web build patched to that API. Nothing was configured
  beyond the seed: **no PSA connector, no ClientSt0r peer, no AI provider, no
  approval signer, no SMTP relay, no MDM credentials.** That makes the walk a
  standalone walk as well (§2).
- **The walker.** Playwright (Chromium headless shell) signed in as a Platform
  Admin and loaded 45 pages — the dashboard, the device list, a device's
  Overview, Patches, Actions, Monitoring, History and Services tabs, and every
  page reachable from the sidebar — in light and dark, at 390, 1280 and 1920 px:
  270 loads. Per load it recorded time to network idle, API requests, any
  request made twice, failed responses, console errors, horizontal overflow,
  the first heading, visible PSA / ClientSt0r wording, unnamed buttons and tab
  count. At 1280 px it ran axe-core 4.11.1 (already present in the workspace,
  transitively) with the WCAG 2.0/2.1/2.2 A and AA rules.
- **Idle traffic.** A second walker left five pages open for 120 s each and
  counted every request.
- **Code.** Grep counts over `apps/web` for colours, sizes, components and
  wording ([COMPONENT_INVENTORY.md](COMPONENT_INVENTORY.md) holds the full
  tables and the commands, so a later release can re-run them).
- **Screenshots** were kept outside the repository (they show demo data from a
  scratch database, masked by `capture-masks.mjs`). None is committed.

## Summary

The console is functionally rich and, for its size, consistent in structure:
every page is the same shell, the same card and table idiom, and the same
TanStack Query data layer. It does not overflow horizontally anywhere at 390,
1280 or 1920 px, and no page failed to load. Its problems are those of a
product that grew a release at a time:

- **Colour carries meaning inconsistently.** Warning is drawn in three hues and
  healthy in two; there are 1,258 raw palette classes and no semantic status
  tokens.
- **Contrast and naming fail accessibility checks on 43 of 45 pages.** Most
  are three systematic causes: the sidebar's version footer, inactive tab
  labels and white text on the red badge.
- **Standalone mode was mostly right but not entirely.** Two
  integration-only controls were drawn with no integration configured
  (fixed in this release); two more remain.
- **The device page is long before it is useful**, and the navigation hides
  customers inside Settings.
- **Background polling never stops**, including in a hidden tab.

## Findings, ranked

Ranked by how much each costs a technician or misleads them, then by reach.
**Fixed** means fixed in 0.85.1; everything else is assigned to a roadmap item.

| # | Finding | Where | Severity | State |
|---|---|---|---|---|
| F-1 | The History tab drew a ClientSt0r *AI summary* section with no peer configured, and its text still said "Rem0te holds no AI provider key", untrue since 0.48 | `history-tab.tsx` | High (standalone, §2; truthfulness) | **Fixed**: the section and its anchor are drawn only when a peer is configured or a stored summary exists |
| F-2 | *Create ticket* (and its "Create ticket: reason" notice) was drawn on alerts and event rows with no PSA connector | `ai-ticket-actions.tsx`, `endpoint-event-log.tsx` | High (standalone) | **Fixed**: drawn only when a connector exists |
| F-3 | Status hues: warning in `amber` (397 uses), `yellow` (125) and `orange` (9); healthy in `green` (177) and `emerald` (109). The same state looks different on neighbouring pages | 116 files | High (§4) | P0-2, P0-3 |
| F-4 | *Offer alerts to ClientSt0r* is a checkbox in every notification policy with no peer configured. The console has no read that says whether a peer exists | Settings → Monitoring | Medium (standalone) | P0-5 |
| F-5 | *Ask AI* is a disabled button on every alert and event row when no provider is configured | Alerts, event log | Medium (standalone, clutter) | P0-5, owner decision 3 |
| F-6 | Dashboard panels clip their own content at 1280 × 800: *Work on next*, *Devices needing attention*, *Customers affected* and *Patch status* cut off mid-line inside fixed-height scroll areas, and tile sub-lines are truncated. axe also flags two of those scroll areas as not keyboard-reachable | Dashboard | Medium | P0-6 |
| F-7 | The device page spends ≈ 440 px (1280 wide) and ≈ 575 px (390 wide) before the first tab; its 15 tabs overflow at 1280; the action row wraps so *More* sits alone on a second line; a persistent "Run action unavailable: no approval signer" line sits under every header; the green *Full agent* button reads as a healthy status chip | Device page | Medium | P0-7, P1-2, owner decision 5 |
| F-8 | The theme toggle switches light ↔ dark only. `ThemeProvider` supports *System*, but once someone has toggled there is no way back to it | Sidebar | Medium (§4) | P0-4 |
| F-9 | Background polling never pauses. The chat inbox (every 10 s) and the task watcher poll with `refetchIntervalInBackground`; an idle dashboard makes 28 requests in two minutes. The chat inbox is limited to 30 a minute per caller, so a few reloads in a row produce `429`s (seen on 97 of 270 walker loads) | Shell | Medium (§25) | P1-16 |
| F-10 | axe: colour contrast on 43 of 45 pages (223 nodes light, 123 dark), unnamed buttons on 5 pages, unnamed select on 1, unfocusable scroll regions on 3 | See [Accessibility](#accessibility) | High (§26) | P0-8; the naming part **fixed** (F-15) |
| F-11 | `window.confirm` in 10 files next to `ConfirmDialog` in 14: two different confirmation experiences, one unstyled and untranslatable | Monitoring, users, others | Low | P0-3 |
| F-12 | Icon reuse in the navigation: `ShieldCheck` for four different things, `BadgeCheck` three, `CalendarClock` three | `nav-model.ts` | Low (§6) | P0-4 |
| F-13 | Settings has a tab named *Access Control* that navigates to another page (`/admin/access`). A tab that leaves the page is a role mismatch for keyboard and screen-reader users. *Security* is also three different places (a Settings tab, Settings → Security pages, Admin → Security) | Settings | Medium | P0-7 |
| F-14 | The browser tab said "Reboot Remote" on every page, and the public `/download` page used the old name rather than the portal's branding | `layout.tsx`, `/download` | Low | **Fixed**: "Rem0te" with a per-page template; `/download` uses the portal title |
| F-15 | Icon-only buttons with no accessible name: the row menu on every person in Users (18), the business filter, monitor and escalation-level *Remove*, client-update window *Remove*, audit pagination, the status page's refresh. The sidebar's version line was 10 px at 2.3:1 | Several | High (A-3) | **Fixed** (`aria-label` on each; version line 12 px `text-muted-foreground`) |
| F-16 | The History tab asks the ClientSt0r peer for its capabilities on every view, with a 5 s timeout and no cache or breaker. A slow peer would slow every History tab | `timeline.service` | Medium (§2: a peer's failure never blocks local work) | P0-5 |
| F-17 | The containment pause kind `integration` is labelled *ClientSt0r jobs* everywhere, but since 0.56 it also stops warranty lookups, backup pulls and MDM syncs. Someone pausing "ClientSt0r jobs" during an incident would not expect warranty and MDM to stop, and someone with no ClientSt0r would not think to use it | Containment page, banner, Settings, Help | Medium (truthfulness) | P1-13 (wording only; the pause itself is unchanged) |
| F-18 | Inter is loaded through `next/font/google`, so every build fetches from Google; an offline or restricted build host cannot build the console | `layout.tsx` | Low | P0-2 |
| F-19 | The public `/download` page asks `api.github.com` from the customer's browser for RustDesk's latest release (with a fallback) | `/download` | Low (privacy, standalone) | Owner decision 8 |
| F-20 | A request made twice in one load: `/auth/me` under two query keys (`['auth','me']` and `['me']`) on Settings, About and the business page; `/platform/:id` on Settings; `app-version` and `confirm-policy` on the business page | Data layer | Low (§25) | P1-16 |
| F-21 | On a phone the device list truncates names and shows no business, so two computers with the same name in different businesses cannot be told apart; the toolbar takes four rows; the density toggle is labelled with its current state rather than what pressing it does | Devices at 390 px | Medium | P1-3 |
| F-22 | Terminology: *business* ≈ 1,398 times in the web app against *customer* 83; *computer* ≈ 1,712 against *device* 757. Both pairs appear on the same pages | Everywhere | Low (§6) | P1-1, owner decision 1 |
| F-23 | Visible type below 12 px: `text-[11px]` 97 times, `text-[10px]` 45 | 40+ files | Low (A, V-5) | P0-3 onward |
| F-24 | The sidebar's *Support Rem0te* menu (GitHub star, Sponsors, mspreboot.com) is shown to every signed-in person, including a customer's Business Users | Sidebar | Low | Owner decision 2 |
| F-25 | Settings holds about twenty sidebar items and nine tabs; customers (Businesses) are reached through Settings; Title Case strays (*Add Business*, *Business Name \**, *Network / Ports*) | Navigation | Medium (§6) | P0-4, P0-7 |

### What already meets the directive

Recorded so a redesign does not lose it:

- **Ctrl+K search** across devices, businesses, sites, people and alerts, with
  keyboard navigation.
- **The device list**: density toggle, saved views, column choice, CSV export
  and *Connect* on each row.
- **Dashboard tiles** each name what they count and link to filtered records.
- **The device page keeps its tab in the URL** (`?tab=`), so Back returns to
  the tab.
- **Connectivity is three states** (online, reachable but agent silent,
  offline), never collapsed into a green dot (§49).
- **Readiness is honest.** The Tools panel (§85), Managed Secure Access
  readiness (§80) and host security (§84) say unknown when they do not know.
- **Every outbound call** goes through safe-https with a timeout.
- **The containment banner** says what is stopped and why on every page.

## Standalone mode

§2 and [STANDALONE_REQUIREMENTS.md](STANDALONE_REQUIREMENTS.md). The walk ran
with nothing configured, so every integration was absent.

| Integration | What the console drew with it absent | Verdict |
|---|---|---|
| ClientSt0r peer | History tab: *AI summary* section (F-1); notify policy: *Offer alerts to ClientSt0r* (F-4); containment: *ClientSt0r jobs* as a pause kind (F-17); Settings → ClientSt0r page explains how to connect one | F-1 fixed; F-4 and F-17 open; the settings page is correct |
| PSA connector | *Create ticket* on alerts and events (F-2); Settings → PSA / ticketing explains how to add one; the tray never offers support requests (§55) | F-2 fixed; the rest correct |
| AI provider | *Ask AI* disabled on every alert and event row (F-5); Settings → AI explains setup | F-5 open |
| Approval signer | "Run action unavailable: no approval signer" under every device header; the Actions tab and Tools panel say the same with a link to setup | Truthful but repetitive (F-7, owner decision 5) |
| SMTP relay | Email settings say mail is off; notification recipients cannot be confirmed and say why | Correct |
| MDM credentials | Mobile devices pages say no provider is configured | Correct (and owned by the MDM branch) |
| Warranty vendors | The warranty report says why each computer has no date (§74) | Correct |
| Backups | The backups page says no connection is configured | Correct |

Nothing failed or slowed down because a peer was absent: every page loaded and
no request went to an integration. What remains is clutter and one misleading
label, not breakage. P-3 (a *slow* peer adds no time) is not yet measured;
P0-5 does that with a stalled loopback peer.

## Visual system

- **Theme.** shadcn's default slate variables in `globals.css`, light and dark,
  with a `prefers-color-scheme` start. The sidebar uses the same background as
  the page, so the shell has no visual anchor in light mode. Dark mode is
  complete: no page drew light surfaces in dark.
- **Colour.** 1,258 raw palette classes in 116 files and 495 `dark:` variants;
  33 hex literals. Status colours are chosen per file (F-3). The directive's
  palette fails contrast as *text* for success, warning, accent and info on
  white; [SHARED_DESIGN_SYSTEM.md](SHARED_DESIGN_SYSTEM.md#contrast) has the
  table and the text variants that pass.
- **Type.** Inter. Headings are consistent (one `h1` per page on every audited
  page). Small text is below the 12 px floor in 142 places (F-23).
- **Spacing and density.** Cards use `p-6`/`p-4` consistently; tables vary
  between 52 raw `<table>` elements and the shared one. Comfortable/compact
  exists only on the device list (V-4).
- **Components.** 131 raw `<select>`, 88 raw checkboxes, 122 "Loading…" strings
  and 152 spinners against no skeletons; `common/status-indicator.tsx` and
  `ui/separator.tsx` are unused. Detail in
  [COMPONENT_INVENTORY.md](COMPONENT_INVENTORY.md).
- **Icons.** lucide-react throughout, which is right; reuse in the navigation
  (F-12).

## Navigation and layout

- **Sidebar**: Dashboard, Devices (+ Add device), Alerts, Automation, Patching,
  Backups, Remote Support, Reports, Settings (≈ 20 items inside), then My
  Account, Help & docs, Support Rem0te, theme, sign out and the version. §6's
  groups (Customers, Monitoring, Security, Administration) do not exist yet;
  customers live in Settings (F-25).
- **No breadcrumbs** on detail pages. Back works because tabs are in the URL.
- **Page titles** were the same on every page (F-14); 0.85.1 adds a per-page
  template that pages can now use (P0-4 sets them).
- **Responsive**: no page overflowed horizontally at 390, 1280 or 1920 px. At
  390 the sidebar becomes a drawer and tables scroll inside their cards.

## Device page

The page a technician spends most time on (§10). At 1280 × 800, in order:
name and connectivity, the identity line, the action buttons (wrapping), the
"Run action unavailable" line, the containment banner when present, four
summary cards, then the 15-tab strip, which scrolls sideways. The first tab's
content starts about 440 px down; on a phone about 575 px. Overview, Patches,
Actions, Monitoring, History and Services each made 15–21 API requests on load
and took 0.96–1.68 s to network idle on the scratch stack (F-7, P1-2).

## Accessibility

axe-core 4.11.1, WCAG 2.0/2.1/2.2 A and AA, at 1280 px, after the page settled.

| Rule | Impact | Pages (of 45) | Nodes, light / dark | Cause | State |
|---|---|---|---|---|---|
| `color-contrast` | serious | 43 | 185 / 89 | The sidebar's version line at 10 px and 60 % opacity (2.3:1 light, 3.4:1 dark) on every page; inactive tab labels, `#64748b` on `#f1f5f9` (4.34:1) wherever there are tabs; white on the red badge, `#f8fafc` on `#ef4444` (3.59:1); muted text on tinted alert strips (4.35:1); `emerald-600` badges on white (3.76:1) | Version line **fixed**; the rest are token values, fixed in P0-2 |
| `button-name` | critical | 5 | 29 / 29 | Icon-only buttons (F-15) | **Fixed** |
| `select-name` | critical | 1 | 1 / 1 | A ring selector in a patch policy's form | P0-8 |
| `scrollable-region-focusable` | serious | 3 | 4 / 4 | Dashboard panels, a `<pre>` on Deploy, a report table | P0-6, P0-8 |

Only two pages had no violation at all: the device list and the device's
Services tab. After 0.85.1's fixes, a re-run of the affected pages shows no
`button-name` violation and no version-line contrast violation; the remaining
contrast nodes are the three token pairs above.

Not checked by axe and not yet walked by hand: keyboard order through each
page, focus return after every dialog, screen-reader announcements of live
updates, reduced motion (no global `prefers-reduced-motion` handling exists),
and 768 / 1440 / 2560 px. P1-17 is that pass.

## Performance and background traffic

Time to network idle at 1280 px, light, on the scratch stack (one host, a
34-computer dataset, so these are relative numbers, not capacity claims):
0.79–1.87 s, median ≈ 0.87 s. Slowest: About (1.87 s, it reads the release
notes and update state), the business page (1.78 s), a device's Monitoring tab
(1.68 s), Admin → Security (1.62 s).

Idle, 120 s with the page left alone:

| Page | Requests | Of which |
|---|---|---|
| Dashboard | 28 | chat inbox 12, task watcher 8, overview 4, containment banner 2, map 2 |
| Devices | 26 | chat inbox 12, task watcher 8, device list 4, containment banner 2 |
| A device (Overview) | 28 | chat inbox 12, task watcher 8, inventory 4, containment banner 2, the device's tasks 2 |
| Alerts | 30 | chat inbox 12, task watcher 8, summary 4, alert list 4, containment banner 2 |
| Sessions | 34 | chat inbox 12, session list 8, task watcher 8, connected list 4, containment banner 2 |

Twenty of each page's requests, about 10 a minute, are the shell's own.

The chat inbox (every 10 s) and the task watcher (every 15 s) are on every
page and keep polling in a hidden tab (`refetchIntervalInBackground`). The
inbox's own rate limit (30 a minute) is tight enough that reloading a page a
few times in quick succession returns `429`, which the console logs as an
error. P1-16 pauses what does not need to alert the person while hidden and
shares one task poll.

Duplicate requests within one load are listed in F-20. No page made a request
that failed, other than those `429`s. (An earlier walker run showed
`/businesses/undefined` 404s; that was the walker passing a missing id, not the
console.)

## Documentation and screenshots

- `docs/screenshots.md` (the GitHub gallery) and the in-app `/docs` guide
  images predate the 0.6x–0.8x pages; the walkthrough video is from 0.53. They
  are accurate for what they show and silent on newer pages. Regenerating them
  waits until the shell changes (P1-18), or they would be redone twice.
- The in-app `/help` page is long and current, but it is one page; it repeats
  the docs rather than linking to them in places.
- This directory, `docs/ux/`, is not in the in-app docs bundle: it is
  maintainer material, and `gen-docs-bundle.mjs` reads only top-level pages.
  Bundled pages link to it by GitHub URL.

## Not audited

- The customer-facing `/assist` page and the Windows tray (no Windows here).
- The Mobile devices pages, which another branch is changing (MDM M4).
- A Business Owner's and a technician's view in depth: the walk used a
  Platform Admin, who sees everything. Role-specific clutter is P1-4.
- Real fleets above the demo's 34 computers (P-4).
