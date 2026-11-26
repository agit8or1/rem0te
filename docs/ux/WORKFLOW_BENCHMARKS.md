# Workflow benchmarks

Baselines for the directive's §28 usability targets at 0.85.1, so that later
releases can be held to numbers. **These are measurements of the console as it
stands, not claims that a target is met in the field.** Every row counts
security steps in its own column. No measurement bypassed or turned off a
security step to get a better number. The confirm policy was simply at its
shipped default.

## Starting conditions

| Condition | Value |
|---|---|
| Build | 0.85.1, the production `next build` (standalone), unmodified except for the API address in a copy of the build |
| Stack | The isolated docs stack: database `reboot_remote_docs`, API and web on loopback scratch ports, every sweep off, `_docs-demo-refresh.ts` run immediately before |
| Data | Docs demo seed: 34 computers across 5 businesses, open alerts, live sessions, patch scans |
| Person | A Platform Admin, already signed in (password + TOTP done once, before timing) |
| Confirm policy | Shipped default (0.64): every catalog key `off` except `terminal.open`, so none of the rows below asks for a step-up |
| Configured | Nothing: no approval signer, PSA connector, ClientSt0r peer, AI provider or SMTP |
| Browser | Chromium headless shell (Playwright 1.65), 1280 × 800, light, reduced motion |
| Runs | 3 each. Ranges are min–max |
| Timing | Wall clock from the first interaction to the evidence named in the row, driven by a script. **Human reading and deciding time is not included**, so these are floors, not what a technician will see |

Not yet done: timing with real people (§28 asks for junior and experienced
technicians "where practical"), phone widths, and a Business Owner's or
technician's view. The scripts that produced these numbers were kept out of
the repository with the screenshots. P0-8 moves the repeatable parts into the
browser suite, and P1 items re-measure the rows they touch.

## Results

| # | §28 target | How it was done | Clicks / keys | Security steps (separate) | Measured | Baseline verdict |
|---|---|---|---|---|---|---|
| B1 | Find a customer or device within 5 s | Ctrl+K from the dashboard, type part of the name, Enter | 1 shortcut, typing, Enter; 0 clicks | None | Device result shown 0.42–0.55 s, device page open 0.81–0.99 s. Customer result 0.40–0.43 s | Met (machine time) |
| B2 | Open a device workspace in one click | Click the name in the device list | 1 click | None | 0.26–0.28 s to the header's *Connect* | Met |
| B3 | Start an authorized remote session in 1–2 clicks | *Connect* in the device header | 1 click | None asked under the demo's launch policy. A launch policy (security controls) may add a reason, the customer's consent or recent MFA; each is a counted step, never skipped | `POST /connect` 200 and the `.cmd` fetched, 1.13–1.14 s | Met to the script download. The RustDesk client opening and connecting on the technician's PC was not measured (no RustDesk here) |
| B4 | View device health in one click | The device header | 0 from the device page, 1 from the list | None | Header shows connectivity, open alerts and worst severity, updates pending with scan age, and agent kind and version | Met, but spread across chips and cards; no single health summary (F-7, P1-2) |
| B5 | View pending patches in 1–2 clicks | The header chip *N updates pending* (0 clicks), the *Patches* tab (1) | 0–1 from the device page, 1–2 from the list | None | Tab switch 0.10–0.13 s | Met. At 1280 px the tab strip overflows, so later tabs (*Actions*) are cut off (F-7) |
| B6 | Request a supported approved action in 3 clicks, excluding approvals | *Run action* → choose the action → *Request* | 3 clicks plus a typed reason (by design) | Two approvers on the signer's origin, or direct mode (§58); a step-up if `actions.direct` asks | **Not measured**: no approval signer on the docs stack, so *Run action* is disabled and says why | Not measured. Needs a stack with a signer (`e2e-approved-action.mjs`'s setup) |
| B7 | Open a related PSA ticket in one click where supported | — | — | — | Not applicable: no connector is configured, so no ticket exists | N/A standalone. With a connector: not yet measured (P1-12, blocked on contract revisions 3–6) |
| B8 | Generate an endpoint installer within 30 s | Sidebar *Add device* → business → *Who may connect* → *Continue* → operating system → *Make the install command* | 7 clicks (2 for the business list) | `enrollment.create` (off by default); when on, one confirmation, counted here | Download link shown 0.73–0.78 s after the first click | Met (machine time). *Who may connect* defaults to *Specific people*, so a person must be ticked or the default changed: one extra click every time |
| B9 | Create a customer within two minutes | Settings → Businesses → *Add Business* → name → *Create* | 2 clicks and 1 field from the Businesses page; 4 clicks from the dashboard | None | `201` in 0.29–0.54 s | Met. Customers live under Settings, two clicks deep (F-25, P0-4) |
| B10 | Generate an endpoint health report in 3 clicks | *Reports* | 1 click lands on Patch compliance, with CSV export | None | Page loaded 0.88–1.46 s | **Not met**: there is no endpoint health report. Patch compliance, coverage and warranty reports exist separately (P1-15) |
| B11 | Switch configured applications in one click | — | — | — | No application switcher exists | N/A. The switcher is P0-4 and renders nothing until a peer's `consoleUrl` is agreed (CROSS_APP_UX_CONTRACT.md) |
| B12 | Complete secure pairing within 5 minutes after prerequisites | — | — | Pairing is the root-only peers file and CLI on each host, by design (`docs/integration-clientst0r.md`) | Not a console workflow | N/A in the UI. Any console view of pairing stays read-only (S-7) |
| B13 | Return to the originating device without losing context | Device → another page → browser Back | 1 (Back) | None | Not timed. The device page keeps its tab in the URL (`?tab=`), so Back restores the device and the tab | Partly met: Back works, but there are no breadcrumbs, and a page reached from a device does not offer a way back to it (P0-4) |

## What the numbers do not show

- **Human time.** Every time above is the console's own response. The
  slowest step for a person is reading: until 0.88 the device page put about
  440 px of header before the first tab at 1280 px (F-7; ≈ 300–320 px from
  0.88), and the dashboard clips panels (F-6).
- **Scale.** 34 computers. The device list, search and dashboard have not been
  timed at 1,200 or 5,000 (P-4, P1-16).
- **Network.** Loopback, one host. A remote technician adds their round trip
  to every row.
- **Security steps under a stricter policy.** With every catalog key at `ask`,
  B6 and B8 each gain a confirmation (password, code or passkey) at most
  once per 10 minutes. That is the intended cost, counted separately. It is
  never a reason to fail a row.
