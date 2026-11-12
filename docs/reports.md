# Reports

**Reports** (in the menu from 0.32) answer four questions over a business, a site and a period, from data
Rem0te really stores. Nothing on these pages is estimated, sampled or filled in: a figure with no evidence
behind it says *No data*, and an empty report says what is missing.

| Report | Answers | Needs |
|---|---|---|
| **Patch compliance** | Which devices are up to date with Windows Update, per business and site, and which have no current scan | View computers |
| **Agent coverage** | Which agent each device runs and at what version; devices without a device secret; devices not heard from in N days; non-Windows devices with no inventory | View computers |
| **Alert frequency** | How many alerts each business, site, computer and monitor type raised in a period, and how long they took to resolve | monitoring:alerts |
| **Offline time** | How long computers were unreachable, from the offline episodes the Offline monitor recorded | monitoring:alerts |
| **Software compliance** (0.34) | For each software catalog entry, how many Windows computers are compliant, outdated, missing or unknown | View computers |

Each report shows only what you can already see elsewhere:

- **Devices** are the ones on your device list: a Business User sees only the computers granted to them (and
  company-wide ones), a technician only their assignment's.
- **Alerts** are the ones on your Alerts page, and in addition only on computers you can see. A site outage
  alert, which belongs to no computer, is in an owner's or technician's report but never a Business User's.
- Archived and not-yet-enrolled devices are not counted, as on the dashboard. Alerts raised on a device that
  was archived later are still counted in alert frequency: they happened.
- A business you cannot address is refused (403), never answered with an empty report.

Filters: **Business** (a Platform Admin, or anyone who works in several), **Site**, and for the alert reports a
**Period** (24 hours, 7, 30, 90 or 365 days). Agent coverage has its own *Not heard from in* choice (1 to 90
days). The filters stay in the address bar, so a report can be bookmarked; whoever opens the link sees it with
their own permissions.

## Patch compliance

The definition is the dashboard's, from the same code (`apps/api/src/patching/compliance.ts`), so the two
cannot disagree:

> A device is **up to date** when its latest Windows Update scan is under **36 hours** old and lists no pending
> updates. **Compliance** counts only devices with such a scan; **coverage** is how many devices have one.

So a device with a stale scan or none at all is a **coverage gap**: it is not counted as compliant or as
non-compliant, because nothing current is known about it. Per business and per site the report shows devices,
compliance, up to date over fresh scans, devices needing updates, coverage, stale scans, no scan, and restarts
pending (from fresh scans). *No scan* includes devices that are not Windows, which have no Windows Update to
scan; the report says how many.

The scan is the signed agent's patch scan when there is one, otherwise the standard agent's 12-hourly update
scan. Both are read-only evidence; see [Staged patching](staged-patching.md) and the device's *Patches* tab.

Below the tables, every device that is not up to date (needing updates first, then stale scans, then no scan)
links to its Patches tab.

## Agent coverage

- **Agent type and version.** *Signed*: the agent reports the signed update channel. *Standard*: it reports an
  agent version on the standard channel. *No agent report*: no agent has ever reported a version (a
  RustDesk-only machine, or one that never checked in). The same definition as the device list's Agent column.
- **No device secret.** The installer generates a secret per device and the server binds it. Without one, the
  heartbeat is accepted as "online" but nothing it reports is written, and no credential rotation is handed to
  it. The report tells *not bound* apart from *no RustDesk record at all*. It never shows the secret or its
  hash.
- **Not heard from in N days.** No heartbeat in that long, or never. Oldest first.
- **Non-Windows with no inventory.** Devices whose platform is not Windows (or was never reported) that have
  never sent an inventory pass. The read-only Linux (0.32) and macOS (0.33) agents send one, so this is now the
  Linux and macOS computers installed before their agent existed (or a Mac installed without `sudo`), and
  anything else that registered once; re-running the installer on them adds the agent.

## Alert frequency

An alert counts in the period it was **first raised**. A repeat of the same open problem is the same alert (its
*occurrences* go up), so this counts problems, not readings. A site outage and each computer's offline alert
grouped under it are each counted.

Per business, site, computer and monitor type: alerts raised, by severity, still open, resolved, and **time to
resolve**, from first raised to resolved (by the monitor reading normal again or by a person). Alerts still
open are not in the time. The median, mean and longest are shown; read the median, because one alert left open
over a weekend moves the mean a long way. Alerts raised in a maintenance window are counted and marked.

## Offline time

`isOnline` on a computer is a flag the staleness sweep overwrites. It keeps no history, so it cannot be turned
into a time series and the report does not try. What is recorded is the **Offline monitor's alerts**: each
stores the computer's last heartbeat before the silence, when the monitor noticed, and when it cleared because
the computer reconnected. Offline time is measured from those:

- an episode runs from the **last heartbeat** before the silence to the moment the computer **reconnected**,
  or to now if it has not;
- the part outside the chosen period is not counted;
- if a person resolved the alert while the computer was still silent, the monitor raised a new one; the two
  overlap and are counted once;
- an alert closed because the monitor stopped applying (it was switched off, or the computer was retired) is
  measured to the close and marked *closed without reconnecting*: the computer may still have been offline.

What this cannot tell you, and why there is **no availability percentage**:

- Only computers with an enabled Offline monitor have records. The report lists which visible computers have
  one **today**; it cannot say which had one last month, because monitor settings keep no history.
- Only silences longer than the monitor's threshold (15 minutes by default) are recorded.
- Records begin with the oldest offline alert in view; the report says when.

An availability percentage needs the time each computer was monitored, which is not recorded, so any
percentage would be invented.

## How far back the alert reports can see

Resolved alerts are deleted `RETENTION_ALERT_DAYS` (default 400) days after they were resolved
([data-retention.md](data-retention.md)). Every alert first raised inside that many days is still stored, so with the
default the 365-day period is complete. If the setting is lower than the period you choose, Alert frequency and
Offline time say so above the report, and say how many days they cover. Patch compliance and agent coverage
read each device's current record, which retention never removes, and have no window.

## Software compliance

Per [software catalog](software-deployment.md) entry, over the Windows computers it applies to (a business's entries
over that business's computers, global entries over every computer you can see), from the newest evidence:

- the inventory's installed-software list, for a **display name** detection rule only; the inventory carries no
  uninstall key names or file versions, so the other two rules are never answered from it;
- the detection the computer reported when a software plan ran there (before, after, or at a timeout), for any
  rule, counted only for the same package under the same rule.

| State | Means |
|---|---|
| **Compliant** | The detection rule holds |
| **Outdated** | Found, at a version the rule does not accept |
| **Missing** | Not found |
| **Unknown** | No evidence, or none newer than 14 days (counted separately as *stale*) |

Unknown is never folded into compliant or missing. A rule nothing has evidence for is honestly all unknown. The page
shows the totals, each entry's counts, how many visible computers are not Windows (and so not counted), and the
computers needing attention (outdated, then missing, then unknown). The export has one row per entry and computer.

## Exporting

Every report has **Export CSV**. The export is the whole report as rows (one per device for patch compliance
and agent coverage, one per alert raised in the period for alert frequency, one per computer with offline time)
with the same scoping and filters as the page.

- Capped at **10,000 rows**. A larger report is refused with a request to narrow it; it is never silently cut.
- Cells a spreadsheet would read as a formula (starting `=`, `+`, `-`, `@`, tab or carriage return) are
  prefixed with an apostrophe. Device names, hostnames and alert titles come from the devices, so this matters.
- Each export is written to the audit log as **`REPORT_EXPORTED`** (who, which business, which report, how many
  rows and with which filters) *before* the file is sent. If the audit log cannot be written, the export is
  refused.

## Scheduled reports

From 0.34 any report can be emailed weekly or monthly to confirmed addresses, with a link and optionally this
same CSV export (same row cap, same `REPORT_EXPORTED` audit row, naming the schedule). It is computed with the
schedule owner's access when it is sent, and fails closed if they have lost it. See
[Email and scheduled reports](email.md).

## Not done

- **Availability percentage**: see above.
- **Trends over time** (compliance last month against this month): scans and agent versions are stored as the
  latest value, not as history.

## API

`GET /api/v1/reports/{patch-compliance|agent-coverage|alert-frequency|offline-time|software-compliance}` and the same path with
`/export.csv`, taking `businessId`, `siteId`, `days` (1, 7, 30, 90, 365) and `silentDays` (1, 3, 7, 14, 30,
90). Other values are a 400. See the [API reference](API-REFERENCE.md).
