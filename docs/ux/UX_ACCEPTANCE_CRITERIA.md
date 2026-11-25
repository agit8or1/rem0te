# UX acceptance criteria

What a UI/UX change must satisfy before it merges, and what the initiative as a
whole is measured against. Each criterion has an id so a pull request can say
which ones it touches and how it checked them. Security criteria are not
negotiable against usability ones: where they conflict, security wins and the
click is counted (directive §21, §28).

Status column: **Baseline** is where the console stood at 0.85.1, from
[UX_AUDIT.md](UX_AUDIT.md) and [WORKFLOW_BENCHMARKS.md](WORKFLOW_BENCHMARKS.md).

## Standalone (release-blocking)

| Id | Criterion | How it is checked | Baseline |
|---|---|---|---|
| S-1 … S-7 | The rules in [STANDALONE_REQUIREMENTS.md](STANDALONE_REQUIREMENTS.md) | The docs stack with nothing configured; the browser suite; P0-5's automated walk | Partly met (see that page) |

## Truthfulness

| Id | Criterion | How it is checked | Baseline |
|---|---|---|---|
| U-1 | No control claims a capability the endpoint, agent or OS cannot enforce. Unavailable features say why and what is missing | Review against `docs/readiness.md` and `docs/capabilities.md`; device pages for a signed, standard, Linux and macOS computer | Met on the device header and Tools panel (§85); keep it |
| U-2 | Launch requested, authorized, client opened, connection confirmed, active, ended, failed and unknown are distinct in every session view | Session detail and history | Met in the session record (0.30); the device page's toast says "Starting the session" for an authorization |
| U-3 | Unknown, stale, unsupported and unavailable are never drawn as healthy, and each says which | Visual review in both themes; unit tests where a pure function decides | Met for connectivity (§49), host security (§84), diagnostics (§86) |
| U-4 | A configuration checkbox is never presented as proof that an endpoint enforces it | Review | Met (session policy text says "nothing on the computer enforces it") |
| U-5 | Evidence classes (simulated, API-tested, lab, fleet) are kept wherever readiness is shown | Review against `docs/readiness.md` | Met |
| U-6 | Every dashboard number has a written definition and links to the filtered records behind it | Each tile and panel | Mostly met: tiles show what they count from; not every tile links to a filtered list |

## Visual consistency

| Id | Criterion | How it is checked | Baseline |
|---|---|---|---|
| V-1 | Colours come from semantic tokens; no new hex or raw palette status colours | Grep counts in COMPONENT_INVENTORY.md may only fall; the P0-2 drift check | 1,258 palette classes, 33 hex literals |
| V-2 | One hue per status meaning, both themes | Grep: no `yellow`/`orange`/`emerald` status classes | Warning in 3 hues, healthy in 2 |
| V-3 | Light, dark and system themes all selectable and persistent | Manual and browser suite | System cannot be re-selected |
| V-4 | Comfortable and compact density, persistent, everywhere tables appear | Browser suite | Device list only |
| V-5 | Minimum text 12 px | Grep | 142 uses of 10–11 px |
| V-6 | One icon per concept in the navigation | `nav-model.ts` review | `ShieldCheck` ×4, `BadgeCheck` ×3, `CalendarClock` ×3 |
| V-7 | Shared terminology (Customer, Device, Site, Pending approval…) in visible text | Grep counts; CROSS_APP_UX_CONTRACT.md §2 | "Business" ≈1,400, "Customer" ≈80 |

## Accessibility (WCAG 2.2 AA)

| Id | Criterion | How it is checked | Baseline |
|---|---|---|---|
| A-1 | No axe violations (wcag2a, 2aa, 21a, 21aa, 22aa) on any audited page, both themes | axe-core 4.11 in the audit walker (P0-8 puts it in the browser suite) | See UX_AUDIT.md §Accessibility |
| A-2 | Text contrast ≥ 4.5:1, large text and UI parts ≥ 3:1 | axe plus the token table | Failures in both themes (UX_AUDIT.md) |
| A-3 | Every control has an accessible name; icon-only buttons have `aria-label` | axe `button-name`; the walker's unlabeled-button count | See UX_AUDIT.md |
| A-4 | Keyboard: every action reachable, visible focus, logical order, focus returns after a dialog | Manual pass per page group | Radix dialogs restore focus; no full manual pass yet |
| A-5 | No colour-only status | Review | Mostly met |
| A-6 | Reduced motion respected (spinners, transitions) | `prefers-reduced-motion` emulation | Not handled globally |
| A-7 | No horizontal page overflow and no clipped action at 390, 768, 1280, 1440, 1920, 2560 px | The walker's `overflowX` | 0 px at 390/1280/1920 on every audited page |
| A-8 | Targets ≥ 24×24 px (2.5.8) | axe `target-size` | See UX_AUDIT.md |
| A-9 | A role is what it looks like: a tab never navigates to another page | Review | Settings' "Access Control" tab navigates away |

## Performance

| Id | Criterion | How it is checked | Baseline |
|---|---|---|---|
| P-1 | An idle page makes no more background requests than its data needs; nothing polls while the tab is hidden unless it must alert the person | The idle walker (`idle.mjs`) | See UX_AUDIT.md §Background traffic |
| P-2 | No request is made twice during one page load | The walker's duplicate count | Three pages duplicate a request (business detail, settings, about; UX_AUDIT.md F-20) |
| P-3 | A slow or absent peer adds no time to a page that does not show peer data | Docs stack with a stalled loopback peer | Not measured yet |
| P-4 | Claims of scale name the fleet size, hardware and dataset measured | `docs/server-sizing.md` style | Measured to 5,000 synthetic computers (heartbeats, group policy); UI not measured at scale |

## Workflows (§28)

The targets and their baselines are in
[WORKFLOW_BENCHMARKS.md](WORKFLOW_BENCHMARKS.md). A workflow passes when its
measured clicks and time meet the target **with every security step still
present**, counted in its own column.

## Every UI pull request

1. Says which criteria it touches.
2. Was looked at in light and dark, at 390 px and at 1280 px or wider.
3. Adds or updates a browser-suite check for anything it gates on server
   state (S-1 needs both the configured and unconfigured case).
4. Does not lower any security criterion to raise a usability one.
5. Updates the page in `docs/` that describes the behaviour, and the
   screenshots it changes.
