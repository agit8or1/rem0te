# Data retention

*Added in 0.34.* Before 0.34 nothing that grows was ever pruned: commands, inventory changes, alerts and
diagnostics accumulated at about 1.3 MB per computer per year ([server-sizing.md](server-sizing.md)). The
**retention sweep** now ages out operational history and transient rows on a schedule. The audit log is never
pruned.

Every table that grows with time falls into one of three kinds:

- **Evidence** is kept for ever. Retention never deletes or changes it.
- **Operational history** ages out after a window you can configure.
- **Transient** rows only mean something until they expire, and are removed some time after that.

**Settings → System status → Data retention** (Platform Admin only) lists each table with its real row count,
its oldest row, its window and what removes it. The counts are taken when the page loads and are cached for a
minute. The refresh button recounts.

## What is kept, and for how long

| Data | Kind | Kept (default) | Variable (min – max) | Never removed |
|---|---|---|---|---|
| Audit log (`ActivityLog`) and its checkpoints (`AuditCheckpoint`) | Evidence | For ever | — | Everything: see *The audit log* |
| Approved actions, patch deployments, remote sessions, security alerts | Evidence | For ever | — | Everything |
| Agent commands (`EndpointCommand`: inventory, update scan, event-log query) | History | 90 days after they were requested | `RETENTION_COMMAND_DAYS` (7 – 3650) | Pending and dispatched commands; the newest command of each type per computer, and the newest that succeeded |
| Diagnostic runs (`DiagnosticRun`, including the Processes/Services/Network snapshots) | History | 90 days after they were requested | `RETENTION_DIAGNOSTIC_DAYS` (7 – 3650) | Runs not finished; the newest run of each diagnostic per computer, and the newest that completed |
| Inventory change history (`EndpointChange`) | History | 400 days | `RETENTION_CHANGE_DAYS` (30 – 3650) | — |
| Monitor alerts and their events (`MonitorAlert`, `MonitorAlertEvent`) | History | 400 days after they were resolved | `RETENTION_ALERT_DAYS` (30 – 3650) | Open and acknowledged alerts; a site-outage alert with a computer alert under it that is still open |
| Session event detail (`SupportSessionEvent.metadata`) | History | 400 days | `RETENTION_SESSION_DETAIL_DAYS` (30 – 3650) | The session and event rows themselves; anything on a session that has not ended |
| Unused launcher tokens and connection grants | Transient | 30 days after they expired | `RETENTION_TOKEN_DAYS` (1 – 365) | A token or grant that was used |
| Abuse-guard window (`PrivilegedActivity`) | Transient | 30 days | `RETENTION_PRIVILEGED_ACTIVITY_DAYS` (2 – 365) | — |
| Metric samples and roll-ups | History | 48 hours raw, 90 days hourly | `METRIC_*` (the [metric sweep](metric-history.md#downsampling-and-retention)) | — |
| Support requests | History | Rows kept; contact details erased 30 days after closing | (the support-request sweep) | — |
| Client update jobs, ClientSt0r jobs and alert events | History | Not pruned in 0.34 | — | — |

A value outside its range is clamped to the nearest limit. A value that is missing or not a number takes the
default. So `RETENTION_ALERT_DAYS=0` means 30 days, not "delete everything", and a typo cannot turn retention off.
The System status card shows the windows in force after clamping.

### Why these defaults

- **Alerts, 400 days.** The alert reports ([reports.md](reports.md)) offer periods up to 365 days. 400 days covers
  the longest period with a month to spare. An alert is deleted only once it has been resolved for that long, so
  every alert first raised in the last 400 days is still stored. If you set it below 365, the Alert frequency and
  Offline time pages say how far back they can see. A 365-day report under 90-day retention says it covers only
  the last 90 days and that resolved alerts older than that are not counted.
- **Inventory changes, 400 days.** The same reasoning: a year of software history plus a margin. They are the
  second-largest source of growth (≈ 0.15 MB per computer per year).
- **Commands and diagnostics, 90 days.** These are most of the growth (≈ 1.0 MB per computer per year for
  automatic collections). An automatic inventory or update-scan row is a work order. What it produced is already
  stored on the computer's record, so the row matters only while someone is debugging the agent. 90 days covers a
  quarter of that. The newest of each type, and the newest that succeeded, are kept at any age, because the Event
  Log tab and the diagnostic panels show "the last result", and a six-month-old result is still the last one.
- **Session detail, 400 days; sessions kept.** Remote sessions are evidence of who connected to what. Offboarding
  reads them, and the session history shows measured connection times. They are small (≈ 0.11 MB per computer per
  year with their events). Only an event's free-form detail (at most a few hundred bytes, for example the
  attribution note "only recent launch for this computer") is cleared. The event, its time, its source and the
  state change stay.
- **Tokens and grants, 30 days after expiry, unused only.** An unused, expired token is useless. A used one is
  kept, because offboarding lists the computers a person reached through it.
- **Abuse guard, 30 days.** The guard and the bulk-action budget read at most the last 24 hours (`windowMinutes`
  is capped at 1,440). The 2-day floor keeps every row either of them could read.

### What pruning changes

- **Reports.** Alert frequency and offline time can see back `RETENTION_ALERT_DAYS`, and their pages say so.
  Patch compliance and agent coverage read each device's current record, which retention never removes.
- **The device workspace.** The Inventory tab's change history goes back `RETENTION_CHANGE_DAYS`. The diagnostic
  history and the command list go back their windows, but always show the latest result.
- **Audit entries keep their references.** An audit entry such as `MONITOR_ALERT_RESOLVED` or
  `ENDPOINT_DIAGNOSTIC_COMPLETED` names the alert or computer it was about, and its metadata carries the facts (who,
  which monitor, the note). Once the alert itself has aged out, the entry still says what happened, but the link to
  the alert is to a row that no longer exists. The entry is the record. The deleted row was operational detail.

## The audit log

The audit log is **never pruned and never modified** by retention. Its rows are sealed into a hash chain, a
database trigger refuses changes, and a deleted row is reported by the verifier as tampering
([containment.md](containment.md)). The retention sweep does not name `ActivityLog`, `AuditCheckpoint` or
`AuditChainState` in any statement (`check-security-invariants` §33).

Each pass that removed or trimmed anything writes **one** audit entry, `RETENTION_PRUNED`, with the counts per
table, the windows in force and which tables had more to do. That entry is an insert into the chain, which is how
the chain records anything. A pass that found nothing to do writes nothing.

The audit log is the one table that keeps growing, at about 0.76 KB per entry once sealed. If its size becomes a
problem, the answer is the off-host export (`AUDIT_EXPORT_FILE` / `AUDIT_EXPORT_URL`) and a deliberate archive
procedure, not retention. No such procedure exists yet.

## How the sweep works

It runs inside the API process every `RETENTION_SWEEP_SECONDS` (default 3600, range 2 – 86400). The first pass
starts two minutes after the API does, so a restart is not also the moment a large delete runs. For each table,
in order:

1. Select up to `RETENTION_BATCH` (2,000) rows past the window and in a finished state, oldest first, and delete
   (or, for session detail, clear) exactly those.
2. Repeat until a statement removes fewer than a batch, at most `RETENTION_BATCHES` (10) times.

So one pass removes at most 20,000 rows per table by default. A larger backlog is cleared over several passes. The
first pass after upgrading to 0.34 on a long-running server is where that shows: a year of commands on 1,000
computers is about 2 million rows, of which about 1.6 million are past 90 days. At 20,000 an hour that takes about
three and a half days. Raise `RETENTION_BATCHES` for a while if you want it faster.

Each statement deletes by cutoff and state, so it is **idempotent**: a second pass, or a second API process, finds
nothing more to do. Alerts are deleted with their events in one transaction per batch, locked `SKIP LOCKED`, so two
sweepers never wait on each other.

| Variable | Default | Meaning |
|---|---|---|
| `RETENTION_SWEEP` | on | `off` stops the sweep in this process. Nothing is pruned until it is on again |
| `RETENTION_SWEEP_SECONDS` | 3600 | how often a pass runs (2 – 86400) |
| `RETENTION_BATCH` | 2000 | rows per statement (1 – 50,000) |
| `RETENTION_BATCHES` | 10 | statements per table per pass (1 – 100) |

The windows are in the table above. Set them in `/etc/reboot-remote/api.env` and restart the API.

**Measured** on 2026-11-11 against a scratch PostgreSQL 16 database on a shared, loaded host (load average 6–7),
with 540,000 commands (500 computers × 180 days × 6 a day) and 180,000 changes:

| Statement | Per 2,000-row batch |
|---|---|
| Commands (the "newest of each type" check included) | 180 – 460 ms |
| Inventory changes | 30 – 50 ms |
| Commands, nothing due | 5 ms |

A full default pass over a backlog is a few seconds of database time an hour. A pass with nothing due costs
milliseconds. Migration 0046 adds the indexes these cutoffs use.

**Disk space.** PostgreSQL does not return deleted space to the operating system. Autovacuum marks it reusable,
so the tables stop growing rather than shrink. To get the space back after the first large clean-up, run
`VACUUM (FULL, ANALYZE)` on the tables concerned in a maintenance window. It locks each table while it runs.

## Testing it

- `apps/api/scripts/unit-retention.mjs`: defaults, clamps and parsing of every variable, cutoffs, the per-pass cap
  and batch loop, report coverage, and the table inventory (CI).
- `apps/api/scripts/e2e-retention.mjs`: seeds aged and current rows in every swept table for two businesses,
  starts its own API three times (sweep off, sweep on with two rows per pass, clamped settings). It proves that
  aged rows go and open, newest, used and in-window rows stay. It also proves that the audit chain verifies the same
  before and after, with every sealed entry and checkpoint intact, that each removing pass wrote one entry and later
  passes write none, that the status route is Platform Admin only, and that the reports state their coverage.
  `scripts/run-e2e.sh` runs it. Every other suite runs with `RETENTION_SWEEP=off`, because the sweep acts on the
  whole database.
- `scripts/check-security-invariants.mjs` §33: the sweep never names the audit chain and writes only to the
  allow-listed tables, every statement names the finished states, every statement is bounded, `RETENTION_SWEEP=off`
  is honoured, and the status route is a Platform Admin read with no route that runs or changes the sweep.

## Not done

- **Archiving before deleting.** Rows past their window are deleted, not exported. Back up the database
  ([setup.md](setup.md)) if you need history beyond the windows.
- **Per-business windows.** Windows are server-wide. A business that needs a longer alert history needs the server
  setting raised for everyone.
- **ClientSt0r job and alert-event outboxes.** These are signed, sequenced streams the peer may read from any
  point. Pruning them needs the peer's agreement on a horizon. They grow with alerts sent to mapped businesses.
- **Changing windows from the console.** Retention is set in the server's environment on purpose: a stolen admin
  session cannot shorten it to erase history.
