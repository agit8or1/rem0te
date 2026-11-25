# Shared design system (Rem0te adoption, draft 0)

How Rem0te's console will adopt the MSPZero shared design system, and the
rules Rem0te follows until the shared specification is published.

**Status at 0.85.1: planning only.** The console's look is unchanged by this
page. ClientSt0r is the reference implementation of the shared system, but its
specification (`docs/ux` in github.com/agit8or1/clientst0r) was not published
when this was written (checked against ClientSt0r `main` `2d26c30`,
2026-11-25). Until it is, Rem0te plans against the owner's initial tokens
(directive §5), recorded with accessible variants in
[design-tokens.json](design-tokens.json), and avoids any decision that would
be expensive to reverse (directive §4).

## 1. What the console is built on today

| Layer | Today | Keep? |
|---|---|---|
| Framework | Next.js 16 (App Router, standalone output), React 19 | Yes. No rewrite (directive §5, §30) |
| Styling | Tailwind CSS 3, shadcn/ui pattern, CSS custom properties in `apps/web/app/globals.css` (HSL, shadcn's default slate palette) | Yes; the tokens move into the custom properties |
| Primitives | Radix UI (dialog, dropdown-menu, select, tabs, toast, label, progress, separator, slot) | Yes |
| Icons | `lucide-react` only | Yes. It is the set the directive names |
| Font | Inter through `next/font/google`: fetched once at build time, then served by the console itself | Yes; vendor the files so the build needs no network (UX_ROADMAP.md P0-2) |
| Charts | Hand-drawn SVG (`history-chart.tsx`, dashboard, reports). No chart library | Yes |
| Theme | light, dark and system in `lib/theme-provider.tsx`; the sidebar button toggles only light/dark | Expose *System* (P0-3) |
| Density | The device list's own Comfortable/Compact toggle; nowhere else | Make it a global preference (P0-3) |

Everything is bundled. The console loads no CSS, script, font or icon from
another server at runtime. (One exception outside the console: the public
`/download` page asks `api.github.com` for RustDesk's latest release from the
visitor's browser, with a fixed fallback; see UX_AUDIT.md F-19.)

## 2. Tokens

[design-tokens.json](design-tokens.json) holds the planning values. The
directive's colours are kept exactly as given for **fills, icons, bars and
chart series**. Where one of them is used for **words**, it fails WCAG AA on a
light surface, so a darker text variant is defined:

<a id="contrast"></a>

| Token | Directive value | As text on #FFFFFF | Text variant (light) | Text variant (dark, on #152033) |
|---|---|---|---|---|
| Primary | #2563EB | 5.17 ✓ | #2563EB | #60A5FA (6.42) |
| Accent | #0D9488 | 3.74 ✗ | #0F766E (5.47) | #2DD4BF (8.77) |
| Information | #0284C7 | 4.10 ✗ | #0369A1 (5.93) | #38BDF8 (7.62) |
| Healthy | #16A34A | 3.30 ✗ | #15803D (5.02) | #4ADE80 (9.37) |
| Warning | #D97706 | 3.19 ✗ | #B45309 (5.02) | #FBBF24 (9.78) |
| Critical | #DC2626 | 4.83 ✓ (4.49 on #F4F7FB ✗) | #B91C1C (6.47) | #F87171 (5.90) |
| Pending approval | #7C3AED | 5.70 ✓ | #6D28D9 (7.10) | #A78BFA (6.00) |
| Primary text | #172033 | 16.27 | — | #E2E8F0 (13.24) |
| Muted text | — | — | #5B6B82 (5.05 on #F4F7FB) | #94A3B8 (6.37) |

The navigation colour #14243A takes white text at 15.6:1 and a muted
#A9B8CC at 7.8:1.

Two consequences worth recording for ClientSt0r (CLIENTST0R_HANDOFF.md §6):

- A filled **success** button cannot use #16A34A with white text (3.3:1). Use
  #15803D.
- A filled **primary** button in dark mode cannot use a lighter blue with white
  text (#3B82F6 is 3.7:1). Keep #2563EB for filled buttons in both themes.

Ratios were computed with the WCAG 2.x relative-luminance formula, not
estimated.

## 3. Rules Rem0te follows now

These hold for every change from 0.85.1, before the token layer lands:

1. **One hue per meaning.** Healthy is green, warning amber, critical red,
   pending approval violet, information sky, unknown/stale slate. The audit
   found warning drawn in three hues (amber 397 uses, yellow 125, orange 9) and
   healthy in two (green 177, emerald 109). New code uses the tailwind
   `amber`, `green`, `red`, `violet`, `sky`, `slate` families until the
   semantic classes exist, and never `yellow`, `orange` or `emerald` for a
   status.
2. **Status is never colour alone.** A word, or an icon with an accessible
   name, always goes with it.
3. **Unknown is never healthy.** Missing, stale, unsupported and unavailable
   evidence uses the unknown style and says which (UX_ACCEPTANCE_CRITERIA.md
   U-3). This is already the console's rule (0.68, §49, §84); keep it.
4. **No new hard-coded colours.** No hex value in a component except the brand
   accent, a map basemap or a chart's own palette. The audit counted 33 hex
   literals in `apps/web` and 1,258 palette classes; the number may only fall.
5. **Smallest text is 12 px.** No new `text-[10px]` / `text-[11px]` (142 today).
6. **Confirmations use `ConfirmDialog`**, never `window.confirm` (10 files
   still do).
7. **Every disabled control says why**, in its `title` and, where the reason
   matters, in text next to it. This is already the console's habit on the
   device header; keep it.

## 4. Components to standardise

The inventory and the duplicates are in
[COMPONENT_INVENTORY.md](COMPONENT_INVENTORY.md). The shared set, in the order
UX_ROADMAP.md builds them:

| Component | Rem0te today | Target |
|---|---|---|
| Status indicator | Several local badges (`session-status-badge`, `connectivity-indicator`, device-header chips, per-page `*Badge` functions in 15 files); `common/status-indicator.tsx` exists and is imported nowhere | One `StatusBadge` with the six semantic tones and a required label |
| Page header | `common/page-header.tsx` (75 pages) | Keep; add breadcrumbs and a freshness slot |
| Section/card | `ui/card` (113 files) plus local `Section` helpers | Card with header, optional aside, optional footer link to filtered records |
| Tables | 43 files with a raw `<table>`; the device list has sorting, density and a sticky action column | One `DataTable` shell: sticky header, density, empty and error rows, column chooser, pagination |
| Empty, loading, error | "Loading…" text 122 times, `Loader2` 152 times, no skeletons | `EmptyState`, `ErrorState`, `Skeleton` |
| Forms | `ui/input`, `ui/label`, plus 131 raw `<select>` and 88 raw checkboxes | `Select`, `Checkbox`, `Switch` primitives styled by token |
| Dialogs | Radix `Dialog`, `ConfirmDialog` (14 files), `window.confirm` (10) | `Dialog` and `ConfirmDialog` only |
| Tabs | Radix tabs; the device page has 15 in one strip | Grouped secondary navigation on the device page (P1) |
| Toasts | `useToast`, 360 calls | Keep; one success/partial/failure wording pattern |
| Charts | Hand-drawn SVG | Keep; one legend and axis convention, accessible names |

## 5. Showcase

A component showcase page (directive §5) is planned as an internal,
Platform-Admin-only route that renders every shared component in both themes
and both densities with fixture data (UX_ROADMAP.md P0-2). It reads nothing from
the API.

## 6. Adopting the shared specification

When ClientSt0r publishes `docs/ux`:

1. Record the commit or tag in [CLIENTST0R_HANDOFF.md](CLIENTST0R_HANDOFF.md).
2. Diff its tokens against [design-tokens.json](design-tokens.json). Adopt
   theirs; where Rem0te's accessibility checks disagree, raise it through the
   handoff rather than diverge silently.
3. Re-run the contrast table above against the adopted values.
4. Update the drift check's reference file (P0-2).

Rem0te never loads the specification at runtime; it is a development-time
reference (directive §4).
