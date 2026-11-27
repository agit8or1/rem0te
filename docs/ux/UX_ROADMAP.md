# UX roadmap

The owner's UI/UX initiative (directive of 2026-11-25) as pull-request-sized
items, in order. It sits alongside the existing plans and replaces none of
them: [readiness.md](../readiness.md#roadmap-in-dependency-order) (real-endpoint
validation first), [implementation-status.md](../implementation-status.md)
(the expanded-RMM tracker), [rmm-expansion-audit.md](../rmm-expansion-audit.md)
and [session-maintenance-mdm-backup-audit.md](../session-maintenance-mdm-backup-audit.md).
The directive's own limits apply throughout:

- **Presentation, usability, accessibility, compatibility and standalone work
  only.** Nothing here implements a deferred feature because the directive
  describes its future interface (§3, §15, §34). Those are listed at the end.
- **No security step is removed to save a click** (§21, §28).
- **No item claims readiness from a working UI** (§30). Evidence classes stay
  as `docs/readiness.md` defines them.
- Each item is one release with its version bump, changelog, tests in CI and
  screenshots of what it changed, light and dark, phone and desktop.

Section numbers (§) are the directive's. Findings (F-n) are
[UX_AUDIT.md](UX_AUDIT.md)'s; criteria (S-, U-, V-, A-, P-) are
[UX_ACCEPTANCE_CRITERIA.md](UX_ACCEPTANCE_CRITERIA.md)'s.

## Status

| Item | Release | State |
|---|---|---|
| P0-1 Audit, baselines, standalone requirements | 0.85.1 | Done (#206) |
| P0-2 Design tokens, Inter bundled | 0.87.0 | **Partly done**: the colour tokens are in `globals.css` (both themes, every text pair AA, [UI_DESIGN_SYSTEM.md](../UI_DESIGN_SYSTEM.md)), Inter is bundled. The Tailwind status classes, the showcase page and the drift check are not |
| P0-4 Application shell | 0.87.0 | **Done** except the nav search box (the Ctrl+K palette searches pages instead) and the pending-approvals indicator. The app switcher renders nothing (S-4) |
| P0-7 Critical navigation and labelling defects | 0.87.0 | **Partly done**: Access Control and the three Securities. Title Case strays and the *Full agent* chip remain |
| Everything else | — | Planned |

## P0

### P0-1. Audit, baselines, standalone requirements (0.85.1)

§3, §2, §28, §32, §35. The ten `docs/ux/` pages; the CLAUDE.md section on
standalone operation and shared design; four safe fixes (F-1, F-2, F-14, F-15
in UX_AUDIT.md). No visual change.

### P0-2. Design-token layer, Inter bundled, showcase, drift check

§4, §5. Depends on: nothing (uses draft tokens; values swap when ClientSt0r
publishes). **Recommended next.**

- Semantic CSS custom properties in `globals.css` from
  [design-tokens.json](design-tokens.json): surfaces, text, borders, focus, and
  `--status-{info,success,warning,critical,pending,unknown}-{base,text,soft}`
  in both themes. Tailwind classes over them (`text-status-warning`,
  `bg-status-critical-soft`). The shadcn variables keep their names, mapped to
  the new values, so existing components pick them up without edits.
- The sidebar takes the navigation colour (#14243A) in both themes.
- Inter's files vendored under `apps/web` (`next/font/local`), so the build
  makes no request to Google (F-18).
- `scripts/check-design-tokens.mjs` in CI: the custom properties must match
  `design-tokens.json`, and the grep counts in COMPONENT_INVENTORY.md may not
  rise (hex literals, `yellow`/`orange`/`emerald`, sub-12 px text,
  `window.confirm`).
- `/admin/ux` showcase: Platform Admin only, fixture data, no API reads, every
  shared component in both themes and densities.
- Acceptance: V-1 (no rise), V-3, A-2 for the new tokens; screenshots of every
  page in both themes before and after, since the palette shift touches all of
  them.

### P0-3. Shared status, feedback and confirmation components

§5, §24. Depends on P0-2.

- `StatusBadge` (six tones, label required) replacing the 15 local badge
  functions and the unused `common/status-indicator.tsx`.
- `EmptyState`, `ErrorState` (what failed, whether retrying is safe, what to
  do next), `Skeleton`; reduced-motion spinners (A-6).
- `ConfirmDialog` in the 10 files that call `window.confirm` (F-11).
- Status colour sweep: `yellow`/`orange` → warning, `emerald` → success
  (F-3). Mechanical, page by page, with screenshots.
- Acceptance: V-2, V-5 for touched files, A-6.

### P0-4. Application shell

§6, §7. Depends on P0-2. Owner decision 4 (navigation groups).

- Sidebar groups per §6, only for configured and permitted modules:
  Dashboard, Devices, Customers (out of Settings), Remote Support, Monitoring
  (Alerts), Patching, Automation, Mobile Devices, Backup, Reports, Security,
  Administration. `nav-model.ts` stays the single source.
- Collapsible icon rail with flyouts, a persistent preference, nav search;
  one icon per concept (F-12, V-6).
- Header: theme selector with *System* (F-8, V-3), density as a global
  preference (V-4), a pending-approvals indicator, recent devices in Ctrl+K.
- Breadcrumbs on detail pages (device, customer, policy, deployment).
- Page titles per route through the 0.85.1 title template.
- The application switcher component, rendering nothing (S-4). Its contents
  wait for ClientSt0r to acknowledge the `consoleUrl` proposal
  (CROSS_APP_UX_CONTRACT.md §3.2, §4); **that part is blocked**.

### P0-5. Standalone checks and integration fault isolation

§2, §17, §29. Depends on nothing.

- A read-only integration status for the console (whether a ClientSt0r peer is
  configured; no peer ids for non-admins), so *Offer alerts to ClientSt0r* in a
  notify policy is hidden with no peer (F-4).
- Cache ClientSt0r capability reads (TTL, per peer) with a simple circuit
  breaker, so a down peer is asked once a minute, not on every History tab
  view (F-16).
- Owner decision 3 applied to *Ask AI* (F-5).
- An automated standalone walk in the browser suite: every page of a stack
  with nothing configured, failing on visible peer-only controls (S-1, S-2),
  and the same pages with a loopback peer and connector, asserting the
  controls appear.
- Acceptance: S-1, S-2, S-6, P-3 (measured with a stalled loopback peer).

### P0-6. Dashboard

§8. Depends on P0-3.

- Panels that clip their own content at 1280 × 800 (*Work on next*, *Patch
  status*, tiles truncating their sub-line) get their space back (F-6).
- A definition for every tile and panel (a popover), each already linking to
  its filtered records (U-6; the links exist today).
- Unknown and stale distinct from healthy in every panel (U-3).
- Role defaults (technician, owner) as a choice of which panels show, stored
  per person. Drag-and-resize layouts are P2 (owner decision 6).

### P0-7. Critical navigation and labelling defects

§3, §6. Depends on nothing; can go before P0-4.

- Settings' *Access Control* "tab" that navigates to another page (F-13, A-9).
- Three places named Security (Settings → Security tab, Settings → Security
  pages, Admin → Security): one name each.
- Title Case strays (*Add Business*, *Business Name*, *Network / Ports*) to
  sentence case.
- The device page's *Full agent* button looks like a healthy status chip.

### P0-8. Accessibility baseline in CI

§26, §30. Depends on nothing. Owner decision 7 (a dev dependency).

- axe in `e2e-ui.mjs` over the pages it already visits, both themes, failing
  on new violations; the current ones listed and burned down (F-10).
- Fix the systematic ones first: colour contrast of muted text and status
  text, unnamed icon buttons, `target-size`.
- Acceptance: A-1 to A-3 trending to zero, A-7 at all six widths.

## P1

| Item | § | Notes |
|---|---|---|
| P1-1 Terminology: Customer and Device in visible text | §6 | Owner decision 1. Wording only; models, routes, API and contract unchanged. Browser suite selectors updated in the same commit |
| P1-2 Device workspace | §10 | 15 tabs grouped into secondary navigation; a compact header (today ≈ 440 px before the first tab at 1280, ≈ 575 px at 390); freshness on every panel; the "Run action unavailable" line moved into the button's reason (owner decision 5). **Done in 0.88.0** (*Bridge*): compact header, one row of buttons on a phone, a freshness line on every tab that shows reported state, the header sharing the tabs' catalog read. Fewer requests per load beyond that is P1-16 |
| P1-3 Device list | §9 | Customer and site visible on phones when names repeat; default views (§9 list); favourites; mobile toolbar in one row. **Done in 0.89.0** (*Manifest*): customer and site under shared or phone-width names, twelve built-in views over the server's filters (failed automation, aging hardware and backup failures listed as not offered, with why), favourites and recent devices as views and from the row menu, a one-row phone toolbar |
| P1-4 Technician workspace modes | §11 | Presentation only; never changes authorization. **Done in 0.90.0** (*Focus*): All pages / L1 / L2 / L3 in the profile menu, stored per person (0105); the sidebar lists the workspace's pages and the device page orders its tab groups; Ctrl+K, tabs and URLs unchanged; escalation and PSA tickets named as having no page, with why |
| P1-5 Remote support states | §12 | The eight states in every place a launch is shown; Managed Secure Access fields per §12 (no fleet enablement). **Done in 0.91.0** (*Beacon*): one stage model over the existing evidence (`lib/remote-states.ts`) on the Sessions page, its details, the device History tab, the technician page, Quick Connect, support requests, the dashboard and managed sessions; *Session active* only on the agent's recent signal; the device card lists the twelve Managed Secure Access items with Yes, No or Partly and why; nothing enabled |
| P1-6 Alerts answer the eight questions | §16 | Local acknowledge-investigate-resolve without a ticket (already possible); freshness and "why it matters" |
| P1-7 Background tools | §13 | Progress, timeouts, cancellation, audit references; no widening of who may run them |
| P1-8 Patching, guided | §14 | The eleven states as distinct labels; WSUS/Intune/WUfB ownership in plain English; templates that never enable deployment or restarts on selection |
| P1-9 Software and automation | §15 | Catalog search and metadata, script metadata, schedule previews |
| P1-10 Guided setup | §18 | A resumable wizard over the existing settings; every optional step skippable (S-5). Larger than one release: split when started |
| P1-11 Onboarding checklist | §19 | Customer → site → groups → deployment key → first inventory, resettable |
| P1-12 PSA workflows | §17 | Only what the agreed contract supports. **Blocked** on revisions 3–6 (`INTEGRATION_COORDINATION.md`) |
| P1-13 Security centre | §21 | One page over existing reads (MFA coverage, signer health, signed-agent coverage, MSA readiness, containment, audit chain, certificates); portal-enforced and endpoint-enforced kept apart |
| P1-14 Templates and presets | §20 | Preview, explicit confirmation, never grants privilege or bypasses approval |
| P1-15 Reports | §23 | An *Endpoint health* report preset (§28's three-click target has no single report today, B10) |
| P1-16 Performance | §25 | Background polling (F-9): pause when hidden except the chat inbox's unread count, one shared task poll; the console at 1,200 / 5,000 synthetic computers, measured and recorded |
| P1-17 Accessibility, full pass | §26 | Keyboard and screen-reader walk per page group; 768, 1440, 2560 px |
| P1-18 Screenshot gallery regenerated | §27 | After P0-2 to P0-4 land, so the gallery shows the new shell; the 0.53 walkthrough video likewise |

## P2

Expanded training (first-login tour, role paths, 60-minute basic course),
drag-and-resize dashboards, NOC wallboards, advanced customisation, and
MSPZero design compatibility beyond ClientSt0r (§27, §33).

## Not planned here (deferred feature work)

The directive describes interfaces for these; building the interface is not a
reason to build the feature. Each stays on its own roadmap:

- Alert-triggered remediation builder (§15): roadmap 2b in
  `implementation-status.md`, after its signer work.
- Federated search, cross-application notifications and approvals (§2, §6).
- MDM commands beyond read and enrollment; any wipe (§22): `docs/own-mdm.md`.
- Starting backups, restores or drills (§22): `docs/backups.md`.
- Linux and macOS execution (§10): the Go agent port, `implementation-status.md`.
- Enabling Managed Secure Access for a fleet (§12): its own release criteria.
- Real-endpoint validation (§31): `docs/readiness.md` phase 1, unchanged.

## Owner decisions

**Decided 2026-11-25, "accept recs": every item below as recommended** (1a, 2b, 3b, 4 yes,
5b, 6a, 7 yes, 8b). Numbered as in the batch report.

1. **"Business" → "Customer" in visible text.** (a) Rename wording only; (b)
   keep "Business". *Recommend (a)*, as P1-1.
2. **The sidebar's *Support Rem0te* menu** (GitHub star, Sponsors,
   mspreboot.com) is shown to every signed-in person, including a customer's
   Business Users. (a) Keep; (b) staff only; (c) move to About. *Recommend (b).*
3. **Ask AI with no provider configured.** (a) Keep the disabled button on
   every row; (b) hide it and keep one line where AI is configured.
   *Recommend (b)*, consistent with S-1.
4. **Navigation regrouping** per §6, including Customers out of Settings and
   separate Security and Administration groups. *Recommend yes*, in P0-4.
5. **"Run action unavailable: no approval signer"** under every device
   header. (a) Keep; (b) move into the disabled button's reason and the Tools
   panel. *Recommend (b).*
6. **Dashboard customisation scope.** (a) Role presets and show/hide panels
   (P0-6/P1); (b) also drag and resize now. *Recommend (a)*, drag and resize
   in P2.
7. **axe as an explicit devDependency** for the browser suite (it is present
   today only transitively). *Recommend yes* (P0-8).
8. **The public `/download` page asks `api.github.com`** from the customer's
   browser for RustDesk's latest version. (a) Keep, with its fallback; (b) have
   the server answer from the version it already tracks. *Recommend (b).*

### Navigation redesign decisions (0.87, decided 2026-11-25, "accept recs")

Numbered N1–N4 to keep them apart from the audit's eight.

- **N1. Sidebar at tablet width (820 px).** Decided: collapse to the icon rail
  by default below 1024 px (follow-up; 0.87 shows it at full width).
- **N2. Density.** Decided: extend compact/comfortable from the menu to tables
  and cards, in P1.
- **N3. `e2e-navigation.mjs`.** Decided: give it a seeded fixture so CI runs it
  (follow-up; manual against the docs stack in 0.87).
- **N4. The 13 in-page "Settings → Security" strings.** Decided: fix them in the
  P1-1 wording pass, not in 0.87.
