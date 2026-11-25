# UI design system

The console's colour tokens, type, spacing, density, focus and motion, as they
are in the code from 0.87 *Compass*. The planning values and their reasoning
are in [ux/design-tokens.json](https://github.com/agit8or1/rem0te/blob/main/docs/ux/design-tokens.json) and
[ux/SHARED_DESIGN_SYSTEM.md](https://github.com/agit8or1/rem0te/blob/main/docs/ux/SHARED_DESIGN_SYSTEM.md); this page is what
shipped. How the menu is built is in
[NAVIGATION_ARCHITECTURE.md](NAVIGATION_ARCHITECTURE.md).

## Where the values live

`apps/web/app/globals.css`, as the HSL triples the shadcn variables take
(`--background`, `--foreground`, `--card`, `--primary`, `--muted-foreground`,
`--border`, `--ring` and the rest), plus three families of our own:

- `--status-{info,success,warning,critical,pending,unknown}` — one hue per
  meaning, in each theme.
- `--nav-*` — the menu's colours, the same in both themes, and its row
  heights (`--nav-row`, `--nav-child-row`).
- Density — `html[data-density="compact"]` lowers the row heights.

Components keep using Tailwind's `bg-background`, `text-muted-foreground` and so
on; the values under them changed, not the class names. **The theme** is still
`localStorage.theme` through `ThemeProvider` (`light`, `dark` or `system`),
which sets `<html class="dark">`. Branding (the portal name, logo and accent a
Platform Admin sets) is unchanged and drawn over these.

## Colour

| Token | Light | Dark |
|---|---|---|
| background | `#F4F7FB` | `#0B1220` |
| foreground | `#172033` | `#E2E8F0` |
| card | `#FFFFFF` | `#152033` |
| popover | `#FFFFFF` | `#1C2A40` |
| primary | `#2563EB`, white ink | `#60A5FA`, dark ink |
| muted / secondary | `#EEF2F7` | `#1C2A40` |
| muted-foreground | `#5B6B82` | `#94A3B8` |
| destructive | `#DC2626`, white ink | the same |
| border | `#D8E0EA` (decorative) | `#2A3A52` |
| input | `#8A9BB0` | `#56677F` |
| navigation | `#14243A`, text white and `#A9B8CC` | the same |

**One deliberate difference from the token draft:** dark `--primary` is the
draft's *primary-text* (`#60A5FA`) with dark ink, not `#3B82F6` with white.
shadcn uses one variable for a button's fill and a link's colour; `#3B82F6`
with white ink is 3.7:1, and as a link on a dark card it is 4.0:1, both under
AA. `#60A5FA` is 7.4:1 with dark ink and 6.4:1 as a link.

### Contrast

Computed (WCAG 2.x relative luminance), not estimated. Every text pair is at
least 4.5:1.

| Theme | Pair | Ratio |
|---|---|---|
| Light | foreground on background | 15.2 |
| Light | foreground on card | 16.3 |
| Light | muted-foreground on card | 5.4 |
| Light | muted-foreground on muted | 4.8 |
| Light | muted-foreground on background | 5.1 |
| Light | white on primary | 5.2 |
| Light | primary on card (links) | 5.2 |
| Light | white on destructive | 4.8 |
| Light | status info / success / warning / critical / pending on card | 5.9 / 5.0 / 5.0 / 6.5 / 7.1 |
| Dark | foreground on background | 15.2 |
| Dark | foreground on card | 13.3 |
| Dark | foreground on popover | 11.7 |
| Dark | muted-foreground on card | 6.4 |
| Dark | muted-foreground on popover | 5.6 |
| Dark | dark ink on primary | 7.4 |
| Dark | primary on card (links) | 6.4 |
| Dark | white on destructive | 4.8 |
| Dark | status info / success / warning / critical / pending on card | 7.6 / 9.4 / 9.8 / 5.9 / 6.0 |
| Both | menu: white on navigation | 15.6 |
| Both | menu: muted on navigation | 7.8 |
| Both | menu: white on the current row | 10.5 |
| Both | menu: focus ring on navigation (non-text, needs 3:1) | 8.7 |

`border` is decorative (1.3:1) and never the only cue: inputs carry `input`
and a background change. The status hues are for words and icons with a label;
colour is never the only signal.

**Not yet done** (UX_ROADMAP.md P0-2 and P0-3): the Tailwind `text-status-*`
classes and the sweep of the 116 files that use `amber`, `yellow`, `orange`,
`green` and `emerald` directly, the showcase page, and the drift check against
the shared ClientSt0r specification (which was not published when this was
written).

## Type

**Inter**, variable weight, served from the build: `apps/web/app/fonts/`
holds the latin and latin-ext subsets under the SIL Open Font License
(`OFL.txt`). Until 0.87 `next/font/google` fetched it from Google on every
build, so an offline build host could not build the console (UX_AUDIT.md
F-18). Fallbacks: the system UI fonts.

Sizes are Tailwind's: page titles `text-xl`/`text-2xl`, body `text-sm`, the
menu `text-sm`. Nothing new in the shell is under 12 px.

## Spacing and density

The shell's measurements:

| | Comfortable | Compact |
|---|---|---|
| Header | 48 px | 48 px |
| Menu group row | 36 px | 32 px |
| Menu page row | 32 px | 28 px |
| Menu icons | 18 px | 18 px |
| Sidebar | 232 px expanded, 60 px collapsed | the same |

Density is a per-person preference in the profile menu, stored with the
navigation preferences. In 0.87 it changes the menu; tables and cards follow in
a later release.

## Focus and keyboard

- A **skip link** is the first thing on every page (*Skip to content*),
  to `main#main-content`.
- Every control shows a visible focus ring: `--ring` on the page, `--nav-focus`
  (`#93C5FD`) in the menu.
- The menu is a `nav` named *Main*; groups are buttons with `aria-expanded`
  and `aria-controls`; the current page has `aria-current="page"`. Collapsed,
  the names are tooltips on focus as well as hover, and flyouts are Radix menus
  (arrow keys, Esc).
- The phone drawer is a modal dialog named *Main menu*; focus stays inside and
  returns to the button.
- The palette is a dialog; arrow keys move, Enter opens, Esc closes.

## Motion

`prefers-reduced-motion: reduce` stops transitions and animations (one frame)
and smooth scrolling everywhere.

## Icons

Lucide (`lucide-react`), 18 px in the menu, `aria-hidden` beside a visible
label and named (`aria-label`) when alone.
