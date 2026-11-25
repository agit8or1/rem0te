# Component inventory (0.85.1 baseline)

What the console is built from today, counted from `apps/web` at `cbdaf90`
(0.85.0) with `grep` over `app/`, `components/`, `lib/` and `hooks/` (about
65,700 lines of TypeScript and TSX). The numbers are the baseline the token
and component work (UX_ROADMAP.md P0-2, P0-3) is measured against; they should
only fall.

## Shared primitives (`components/ui`)

shadcn/ui-pattern wrappers over Radix, styled by the CSS custom properties in
`app/globals.css`.

| Component | Files importing it | Notes |
|---|---|---|
| `button` | 123 | Variants default, outline, ghost, destructive, link, secondary |
| `card` | 113 | Used for nearly every section; the source of "identical grey cards" |
| `label` | 87 | |
| `badge` | 85 | Status is mostly expressed as a Badge with ad-hoc colour classes |
| `input` | 77 | |
| `textarea` | 32 | |
| `dialog` | 30 | Radix; focus trap and Escape come from Radix |
| `select` | 17 | Radix Select. 131 raw `<select>` elements elsewhere |
| `tabs` | 15 | Radix Tabs |
| `dropdown-menu` | 5 | |
| `toast` / `toaster` | 3 (360 `toast({…})` calls through `useToast`) | |
| `progress` | 1 | |
| `separator` | 0 | Unused |

## Shared application components (`components/common`, `components/layout`)

| Component | Users | Notes |
|---|---|---|
| `common/page-header` | 75 | Title, description, actions. No breadcrumbs |
| `common/confirm-dialog` | 14 | 10 other files call `window.confirm` (API keys, users, access control, unassigned, monitoring settings, deploy, device list, bulk actions, add device, the public support status page) |
| `common/connectivity-indicator` | 7 | Online / reachable-agent-silent / offline (§49) |
| `common/gauge` | 1 | |
| `common/history-chart` | 1 | Hand-drawn SVG, Performance tab |
| `common/status-indicator` | **0** | Exists, imported nowhere |
| `layout/sidebar`, `nav-model`, `nav-drawer`, `top-bar`, `section-tabs`, `business-switcher` | shell | `nav-model.ts` is the single source for the sidebar and hub tabs (0.31) |
| `search/command-palette` | shell | Ctrl+K / ⌘K, devices, businesses, sites, people, open alerts |
| `chat/chat-inbox`, `tasks/task-watcher` | shell | Header widgets; both poll in the background (UX_AUDIT.md F-9) |
| `containment/containment-banner` | shell | Polls every 60 s |

## Ad-hoc patterns that should become shared components

| Pattern | Count | Target (SHARED_DESIGN_SYSTEM.md §4) |
|---|---|---|
| Raw `<table>` | 52 elements in 43 files | `DataTable` |
| Local `*Badge` / status functions | 15 files | `StatusBadge` |
| Raw `<select>` | 131 | `Select` |
| Raw `<input type="checkbox">` | 88 | `Checkbox` / `Switch` |
| "Loading…" text | 122 | `Skeleton` / `LoadingState` |
| `Loader2` spinners | 152 | Same, plus reduced-motion |
| Skeleton loaders | 0 | — |
| Local `Section`, `Field`, `Row`, `Stat`, `Tile`, `Empty` helpers | 13 definitions | `Section`, `Field`, `Stat`, `EmptyState` |
| Pagination | 4 separate implementations (device list, report kit, winget browser, docs) | `Pagination` |

## Colour and type usage

| Measure | Count |
|---|---|
| Tailwind palette classes (`bg-`/`text-`/`border-`… `-red-500` etc.) | 1,258 in 116 files |
| …amber / yellow / orange (all used for "warning") | 397 / 125 / 9 |
| …green / emerald (both used for "healthy") | 177 / 109 |
| …red | 185 |
| …sky / blue / indigo / purple | 72 / 60 / 8 / 24 |
| …slate / gray / zinc | 60 / 12 / 8 |
| `dark:` variants (each a hand-paired dark colour) | 495 |
| Hex literals in TS/TSX | 33 (map basemap 8, branding defaults 6, contrast helper 4, others) |
| `text-[11px]` / `text-[10px]` | 97 / 45 |
| `rounded-md` / `rounded-lg` / `rounded-xl` | 449 / 35 / 0 |

## Icons

`lucide-react` only, which is the set the directive names. Overloaded icons in
the navigation (`nav-model.ts`): `ShieldCheck` is Patching, *Full agent*,
*Access control* and the *Patch compliance* report; `BadgeCheck` is
*False positives & rules*, the *Warranty* report and Settings → Warranty;
`CalendarClock` is *Schedules*, *Scheduled reports* and *Client updates*.

## Device workspace

`components/endpoints/workspace/`: one header (`device-header`,
`device-actions`), a Tools panel (§85), and **15 tabs in one strip**: Overview,
Performance, Monitoring, Software, Processes, Services, Network, Patches, Event
logs, Diagnostics, Actions, Terminal, Files, Chat, History. At 1280 px the strip
overflows and scrolls; the header's action buttons wrap to a second row.
