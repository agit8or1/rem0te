# ClientSt0r handoff (UI/UX)

Rem0te's record of the shared design work with ClientSt0r (directive §32).
ClientSt0r is the reference implementation of the shared design system;
Rem0te follows it and proposes changes through this page and
[`INTEGRATION_COORDINATION.md`](../../INTEGRATION_COORDINATION.md). Rem0te never
changes ClientSt0r's repository.

## 1. Adopted specification

| | |
|---|---|
| Shared specification | **Not yet published.** `github.com/agit8or1/clientst0r/tree/main/docs/ux` answered 404 |
| Checked against | ClientSt0r `main` at `2d26c30920c5ca12a12893c46ac5ada31fe26a06` (2026-11-25 16:16 UTC) |
| Adopted version | none |
| Rem0te planning tokens | [design-tokens.json](design-tokens.json), draft 0, from the owner's directive §5 |
| Rem0te version | 0.85.1 |

Rem0te proceeds independently until it is published (directive §4): audit,
baselines, standalone fixes and Rem0te-only improvements. Nothing in 0.85.1
changes the console's colours, fonts or layout.

## 2. Compatibility matrix

| Rem0te | Design specification | Integration protocol | ClientSt0r tested against |
|---|---|---|---|
| 0.85.1 | none adopted (planning tokens draft 0) | `ticket-rmm-v1` revision 2; revisions 3–6 proposed (see `INTEGRATION_COORDINATION.md` §5–§5C) | none in this batch; path A code-level only (2026-11-11) |

## 3. Implemented design components

None yet. Inventory and targets: [COMPONENT_INVENTORY.md](COMPONENT_INVENTORY.md),
[SHARED_DESIGN_SYSTEM.md](SHARED_DESIGN_SYSTEM.md) §4.

## 4. Shared navigation compliance

| Directive §6 item | Rem0te 0.85.1 |
|---|---|
| Application identity | Yes (branding name, logo, accent) |
| Optional application switcher | No switcher (correct while nothing is paired) |
| Customer selector | A business switcher for an MSP technician with live assignments; a Platform Admin has no customer context selector (pages take a business filter instead) |
| Global search, Ctrl+K | Yes (devices, businesses, sites, people, open alerts) |
| Favourites, recent records | "Your recent devices" on the dashboard only; no favourites |
| Notifications | Chat inbox and task toasts; no general notification centre |
| Pending approvals | A dashboard tile; no header indicator |
| Help and documentation | Yes (sidebar, `/docs`, `/help`) |
| User profile | Yes (My Account) |
| Theme selection | Light/dark toggle; *System* is stored but cannot be chosen again once toggled |
| Density | Device list only |
| Collapsible sidebar, icon rail, flyouts, nav search | Drawer below `md`; no rail, no collapse, no nav search |
| Logical groups | Dashboard, Devices, Alerts, Automation, Patching, Backups, Remote Support, Reports, Settings. Customers (Businesses) sits inside Settings |
| Breadcrumbs | None |

## 5. Standalone requirements compliance

See [STANDALONE_REQUIREMENTS.md](STANDALONE_REQUIREMENTS.md#status-at-0851).

## 6. Proposed shared design improvements (for ClientSt0r to consider)

1. **Text variants of the status colours.** Four of the directive's colours
   (accent, information, healthy, warning) are under 4.5:1 as text on white.
   Rem0te's draft adds a `text-light` / `text-dark` variant per status
   ([SHARED_DESIGN_SYSTEM.md §2](SHARED_DESIGN_SYSTEM.md#contrast)). Proposed for
   the shared tokens.
2. **Filled buttons.** White on #16A34A (3.3:1) and on a lighter dark-mode blue
   (#3B82F6, 3.7:1) fail. Proposed: success buttons #15803D; primary buttons
   #2563EB in both themes.
3. **An `unknown` status tone** (slate) distinct from healthy, used for
   unknown, stale, unsupported and unavailable, each with its own word.
4. **12 px minimum text** in the shared type scale.

## 7. Supported integration capabilities (unchanged by this work)

Path A (device sync over the public API) and path B (`ticket-rmm-v1`
revision 2) as recorded in `INTEGRATION_COORDINATION.md` §3–§4. No protocol
change is made by the UX initiative's first batch.

## 8. Proposed protocol changes

Drafted in [CROSS_APP_UX_CONTRACT.md](CROSS_APP_UX_CONTRACT.md) §3.2 and §4, not
yet filed in `INTEGRATION_COORDINATION.md` and not implemented:

- `peers[].consoleUrl` in Rem0te's root-controlled peers file;
- deep-link templates (`ticket`, `customer`, `asset`) in ClientSt0r's
  `/capabilities`, so Rem0te shows *Open in ClientSt0r* only where ClientSt0r
  says it works.

They will be filed as their own revision proposal before any code, and wait for
ClientSt0r's acknowledgement.

## 9. Compatibility requirements and security constraints

- No shared cookies, sessions, databases or security domains. No token or
  credential in a URL. No runtime asset from the other application's server.
- A switch or link never authorizes anything; Rem0te re-checks every request.
- Links out use only root-configured base URLs and capability-listed paths;
  no open redirect.
- ClientSt0r never approves privileged execution on a Rem0te computer.

## 10. Known limitations

- No shared specification to adopt yet.
- No running ClientSt0r instance has been used for any UX check.
- The terminology pass (Business → Customer in visible text) is planned, not
  done; ClientSt0r should expect "Business" in Rem0te screenshots until it
  ships.

## 11. Reference screenshots

The baseline audit's screenshots (every major page, light and dark, at 390,
1280 and 1920 px) were taken on an isolated demo stack and kept outside the
repository. The published gallery is [`docs/screenshots.md`](../screenshots.md);
it predates this audit and is listed as stale in
[UX_AUDIT.md](UX_AUDIT.md#documentation-and-screenshots).

## 12. Test results

UX audit results and baselines: [UX_AUDIT.md](UX_AUDIT.md),
[WORKFLOW_BENCHMARKS.md](WORKFLOW_BENCHMARKS.md). No cross-application test was
run in this batch.

## 13. Dependencies on ClientSt0r

| Needed | For | Blocking? |
|---|---|---|
| The published `docs/ux` specification and tokens | P0-2 token layer final values | No: Rem0te builds the layer on the draft tokens and swaps values |
| Acknowledgement of the deep-link / `consoleUrl` proposal | P0-4 switcher, *Open in ClientSt0r* | Yes, for those two only |
| Revisions 3–6 already proposed | Ticket workflows (directive §17) | Yes, for the paired workflows only |
