# Backups

From 0.81 (*Vault*), Rem0te has a **Backups** page and four opt-in backup monitors. They show what a backup
provider reports about the machines it protects:

- the last job, and whether it completed;
- whether that job's integrity check passed;
- whether a restore of it was tested, and the last verified restore;
- recovery point and recovery time objectives (RPO and RTO), measured against a target you set.

Rem0te only reads. Nothing on the page, and nothing in the API, starts a backup, a restore, a restore drill or a
failover.

This page also covers the service-monitor templates for the UrBackup and Comet agents on Windows (roadmap 4.2).

The plan behind it is Phase 4 of
[session-maintenance-mdm-backup-audit.md](session-maintenance-mdm-backup-audit.md#phase-4-backup-verified-recovery-and-standby).
The owner accepted these decisions on 2026-11-21:

- **16.** Destructive actions need a second person and always ask. No such action exists yet.
- **17.** St0r pushes to Rem0te. A provider Rem0te reads must be on public DNS with valid TLS.
- **19.** St0r is the first provider once it can send a token. Otherwise Comet is.
- **20.** Standby is readiness only.

## Three facts, never one

A backup job carries three separate facts, and the page shows them in separate columns:

| Fact | Values | Where it comes from |
|---|---|---|
| **Completion** | succeeded, partial, failed, cancelled, running, unknown | The provider's report of the job |
| **Integrity** | passed, failed, not checked | The provider's own check of what was stored, if it made one |
| **Restore test** | verified, failed, not tested | **Rem0te works this out.** It is verified only when a restore drill that really ran passed, used *this job's own* recovery point, and checked what it restored. |

**A successful job is never shown as verified.** These rules hold that line:

- **The provider cannot say a restore was verified.** The report has no `restoreTest` or `verified` field, and the
  schema refuses one.
- **Rem0te derives the restore test from stored drills, in one place** (`deriveRestoreTests`). The newest finished
  drill that was not simulated decides it.
- **A simulated drill never counts.** It is stored, marked as simulated, and shown as *Simulated only (not
  verified)*.
- **A pass must have checked something.** A drill that reports `passed` with the validation `none` is refused.
- **The database enforces it too.** Migration 0097 refuses a job marked `verified` or `failed` unless the drill it
  names is a non-simulated drill of that job's own recovery point, with the matching result.

The page's **Last verified restore** column shows:

- when the drill ran;
- the recovery point it restored;
- its scope: file, volume, full image or application;
- how long it took.

When the newest real drill failed, the column says so, and still shows the last restore that passed before it.

## Providers

| Provider | How it reaches Rem0te | State in 0.81 |
|---|---|---|
| **St0r** (UrBackup) | St0r **pushes** to Rem0te with a per-customer token | **Requires setup.** Rem0te accepts the push, but St0r does not send one yet: that needs a change on the St0r side |
| **Comet Backup** | Rem0te would **read** it with a read-only Comet API token | **Planned** (roadmap 4.4). Creating a Comet connection is refused (`BACKUP_PROVIDER_NOT_AVAILABLE`) |
| Test stand-in | Rem0te reads it | **Test only.** It works only under `NODE_ENV=test`, with `BACKUP_TEST_BASE_URL` on `127.0.0.1` |

Until a Platform Admin connects a provider for the customer, the page shows **Requires setup** and explains what
is needed. Once a provider is connected but has not reported, the page shows **Waiting for the first report**.

### St0r: what it needs

St0r is the owner's front end for UrBackup. It already keeps backup, offsite replication and verified recovery as
separate statuses, and records simulated drills as simulated. Its routes need a signed-in user, and it has no
service token. So Rem0te does not connect to it. St0r pushes to Rem0te instead (decision 17).

1. **Create the connection.** A Platform Admin opens **Administration → Backup connections** (from 0.82), picks the customer, and
   presses **Create St0r connection**. If *Settings → Confirm it is you* asks for `backup.connection`, confirm it is
   you first. The push token is shown **once**, masked until you press **Reveal**, with a **Copy** button. Rem0te
   keeps only its SHA-256 and its last four characters.
2. **Configure St0r.** The page lists exactly what St0r needs: the push address, the token and the headers, with a
   curl example. St0r must be 3.2.140 or later, *with the Rem0te push added*, which is still being written on the
   St0r side. Its developers build to the [St0r push contract](st0r-push-contract.md).
3. **Make the portal reachable.** The St0r host must reach the portal over HTTPS. Rem0te never opens a connection
   to a St0r host. The push address is built from *Settings → General → Public address*, and the page warns when
   that address is not HTTPS or is not set.
4. **Test it.** St0r sends the same request with `?dryRun=1`. The page shows the newest test push and whether it
   was valid.

**Limitations:**

- One St0r manages one UrBackup server, and a customer can have only one St0r connection today.
- Drills are St0r's. Rem0te shows them, but starts none in 0.81.
- Standby is readiness only: neither St0r nor UrBackup fails a workload over.

### Comet: what it will need

Comet is planned and is not built in 0.81. When it is built, it will need:

- **A public address.** A Comet Server on a public DNS name with a valid certificate. A private address is refused
  (decision 17).
- **A read-only login.** A Comet admin with a personal API token (`AuthType` `Token`), limited to the tenant that
  matches the customer.

**Limitations, from Comet's API reference:**

- **No verified restores.** Comet has no test-restore or dry-run method, so a Comet asset always shows "restore
  never tested".
- **A live device is needed.** Listing recovery points goes through a live, connected device.
- **Read-only.** Many write methods refuse token authentication. Rem0te would only read.
- **No failover.** Standby is readiness only.

## Administration → Backup connections (0.82)

**Administration → Backup connections** is where a Platform Admin sets St0r up for one customer. After picking the customer, the
page shows:

- **Five steps:**
  1. create the connection (the token shown once);
  2. what to give St0r: the address, the token and the headers;
  3. a test push, with a curl example whose token is masked until revealed;
  4. the real push;
  5. backup monitors and linking assets.
- **The connections.** Each one shows:
  - its last push, its last result and how many assets it reported (and how many are linked to a device);
  - the token's last four characters, and when it was created and rotated;
  - why the last push was refused, if it was. This is Rem0te's own parse message, never the feed.
- **Rotate and Revoke** for each connection.
- **What works for this customer**, each capability in one of the four states: **available**, **requires setup**,
  **planned** or **unsupported**:

  | Capability | State |
  |---|---|
  | The St0r push, the test push, the three separate facts, linked assets and backup alerts | **Requires setup** until done, then **available** |
  | Comet | **Planned** |
  | Starting a drill from Rem0te | **Planned** |
  | Failover | **Unsupported** |
- **Comet**, shown as planned, with what it will need.

The **Backups** page keeps a short list of the connections, for a Platform Admin, and points here. A credential is
managed in one place.

**Why only a Platform Admin.** A push token is a credential that writes a customer's backup status and raises its
alerts. 0.81 made connections a Platform Admin's, and 0.82 keeps that. A Business Owner cannot create, rotate or
revoke one.

### Rotating a token

**Rotate token** issues a new token for the same connection, shown once. **The old token stops working at once:
there is no overlap.**

- **Why no overlap.** A token is usually rotated because it may be known to someone else, and an overlap would be a
  window in which it still works.
- **Nothing is lost by the gap.** The pushes refused until St0r has the new token are simply sent again, and
  re-sending is safe.

Rotation:

- asks the person to confirm it is them when `backup.connection` asks, as creating does;
- is audited before it happens (`BACKUP_CONNECTION_ROTATED`, with the last four characters before and after);
- succeeds only if nobody rotated or revoked the connection in the meantime.

Revoking still never asks, and is final.

### The test push (dry run)

`POST /api/v1/backups/push?dryRun=1` takes the same token and is checked against the same schema as a real push.
It writes **nothing but one audit row** (`BACKUP_PUSH_DRY_RUN`, counts only):

- no asset, job, point or drill;
- not the connection's last result.

It answers `200` with:

- `valid`, and the problems if it is not;
- what a real push would write;
- how each asset would link: by Rem0te id, by hostname, by a person's choice, or not at all. It never says which
  device;
- warnings, such as a drill whose recovery point Rem0te does not hold, or a simulated drill.

### Linking an asset by hand

When St0r's name for a machine matches no device, someone who configures the customer can link it on the
**Backups** page. That is a Business Owner, a Platform Admin, or someone with *Monitoring: configure* for the whole
customer: the same people who set RPO and RTO targets, because the link decides which device a backup alert is
raised on. In the asset's **Device** column, they choose one of:

- **A device** of that customer. A report never changes the link afterwards.
- **Not a device.** A report never links it.
- **Automatic.** The provider's report decides again. The asset is unlinked until the next report.

The rules:

- **Where.** Only a device of the asset's own customer, and one the person can see.
- **Who can see the asset.** A Business User never sees an unlinked asset, so they cannot link one either.
- **Audit.** Every change is audited (`BACKUP_ASSET_LINKED`, before and after).
- **When it ends.** A device that moves to another customer loses the link, and the asset goes back to automatic
  (migration 0099).

## The push (St0r)

**[The St0r push contract](st0r-push-contract.md)** is the full specification for St0r's developers, version 1:
the body, limits, idempotency, errors, retries and clocks, with examples that CI checks against the API. A summary
follows.

```
POST /api/v1/backups/push
Authorization: Bearer rbk_<connection id>_<64 hex>
Content-Type: application/json

{ "v": 1, "assets": [ … ] }
```

The checks run in this order, and nothing is written before they all pass:

1. **The token.** The header must parse as a push token.
2. **The connection.** The connection the token names must exist, be a live push connection, and have a stored
   SHA-256 that matches the secret. The comparison is constant-time. An unknown connection, a wrong secret and a
   revoked token all get the same `401 BACKUP_PUSH_UNAUTHORIZED`.
3. **The body.** The body must be a strict feed, or it is refused with `400 BAD_FEED`. The reason is kept on
   the connection for Administration → Backup connections.

**The customer comes from the token, never from the body.** The feed has no customer field, so a feed that names
one is refused. A feed that names another customer's device links nothing.

The route is public, rate-limited, and capped by the API's 1 MB body limit. A feed holds at most:

| Item | Limit |
|---|---|
| Assets | 500 |
| Jobs per asset | 50 |
| Recovery points per asset | 50 |
| Drills per asset | 20 |

A push is accepted during an `integration` containment pause, because it is inbound monitoring data. A pull is
not made during one.

**Re-sending is safe in any order (0.82).** Every item is keyed by its `externalId`. A fact never moves backwards:

- a finished job is never put back to `running`;
- an integrity result is never put back to `not_checked`;
- a finished drill is never put back to `running`.

So a push retried late cannot undo a newer one. The answer's `kept` counts what was held back.

**From 0.82, a drill must name the recovery point it restored** (`recoveryPointExternalId`). A drill that names
none could never verify anything, so it is refused.

**Errors are coded.** A body over 1 MB answers `413 PAYLOAD_TOO_LARGE`, and a body that is not JSON answers
`400 BAD_REQUEST`. Both were `500` before 0.82, for every route. The rate limit answers `429 TOO_MANY_REQUESTS`
with `Retry-After-main`; before 0.82 its code was `INTERNAL_ERROR`.

Each asset in the feed is:

```json
{
  "externalId": "fs01-c", "name": "FS01 C: volume", "type": "server",
  "computer": { "rem0teId": "<endpoint id>" },
  "jobs": [{ "externalId": "j1", "startedAt": "…", "finishedAt": "…", "completion": "succeeded", "integrity": "passed" }],
  "recoveryPoints": [{ "externalId": "p1", "pointAt": "…", "location": "offsite", "jobExternalId": "j1" }],
  "drills": [{ "externalId": "d1", "target": "isolated_vm", "scope": "full_image", "result": "passed", "simulated": false,
               "validation": "boot", "startedAt": "…", "finishedAt": "…", "elapsedSeconds": 900, "recoveryPointExternalId": "p1" }]
}
```

### Linking an asset to a device

An asset is linked to a device of the token's customer in one of two ways:

- **By id.** It names the device's Rem0te id (`computer.rem0teId`).
- **By hostname.** It names a hostname that matches **exactly one** active device in that customer.

An asset that matches no device, such as a mailbox or a file share, appears on the page as **Not linked**. A
device that moves to another customer loses its links. From 0.82, an asset can be
[linked by hand](#linking-an-asset-by-hand).

## Who can see it

| Who | What they see |
|---|---|
| Platform Admin | Every customer, or the one picked on the page |
| Business Owner | Their customer |
| Business User with **See backup status** (`backups:view`) | Only assets linked to a device they can see. Never an unlinked asset, because nothing they can see vouches for it |
| Technician | Through an assignment that carries `backups:view`: the whole customer on a whole-customer assignment, else only assets on its devices |

`backups:view` is new in 0.81. It is not given to Business Users by default.

**Why it is a separate permission.** A backup report names more than the devices it protects. It can also name
mailboxes, databases and file shares, which the device permissions say nothing about.

**RPO and RTO targets** are set with *Monitoring: configure* for the whole customer. They are monitor thresholds.
A target can be set for the customer, or for one asset, and an asset's own target comes first. Every change is
audited (`BACKUP_OBJECTIVE_SET`, before and after).

**Connections** are a Platform Admin's:

- **Creating one** asks the person to confirm it is them when the `backup.connection` key asks. It is audited with
  `logOrFail` before the row exists.
- **Rotating one** (0.82) asks the same way, and is audited before the write.
- **Revoking one** never asks. It drops the token hash and the credential, and keeps what was reported.

**Linking an asset by hand** (0.82) needs what targets need: *Monitoring: configure* for the whole customer, or a
Business Owner or Platform Admin. It is audited (`BACKUP_ASSET_LINKED`).

## How RPO and RTO are measured

- **RPO** is measured from the newest recovery point. If the provider reports no points, it is measured from the
  last successful job.
- **RTO** is measured **only** from a verified restore drill's elapsed time. Without one it is *Not measured*,
  never guessed from a job's duration.

## Monitors

There are four new monitor kinds in **Monitoring → Monitoring policies**. None is in **Add recommended**, and none is added
for you.

| Monitor | Raises when | Clears when |
|---|---|---|
| **Backup stale** (`BACKUP_STALE`, default 26 h) | No successful job for this long. If the asset or customer has an RPO target, that target is the window. A new asset gets the window before it alerts | A successful job arrives |
| **Backup failed** (`BACKUP_FAILED`, default 1) | The newest finished jobs failed this many times in a row | A job succeeds |
| **Restore drill failed** (`DRILL_FAILED`, default 30 days) | A real (not simulated) drill failed in the window, with no pass since | A later drill passes, or the failure leaves the window |
| **RPO exceeded** (`RPO_EXCEEDED`) | The newest recovery point is older than the asset's target, else the customer's. With no target, the asset is skipped unless the monitor sets `fallbackHours` | A newer point arrives |

How the monitors behave:

- **Stored rows only.** The monitoring sweep reads only what the provider reported and Rem0te stored. It checks at
  most every five minutes (`MONITOR_INVENTORY_SECONDS`, the cadence 0.55's inventory monitors use).
  `MONITOR_SWEEP=off` stops them.
- **One alert per linked asset.** Each alert is keyed `<monitor>:<computer>:<asset>`, and is raised on the device
  the asset is linked to. So the alert list's visibility rule, notifications, maintenance windows and automatic PSA
  tickets all apply as they do for any other alert.
- **Unlinked assets raise no alert in 0.81.** An asset with no device shows on the page only.
- **Unlinking closes the alert.** An asset that stops being linked to the device closes its alert.

## Templates for backup agents (4.2)

**Monitoring → Monitoring policies → Backup agent templates** adds service monitors for backup agents on Windows. A template
is added only when someone presses it, as ordinary audited monitors. Each one uses `alertIfMissing: false`, so a
device without that agent raises nothing, and it is safe to set for a whole customer. Nothing changes on the
agent.

| Template | Monitor | Service | Source |
|---|---|---|---|
| UrBackup client (Windows) | `backup-urbackup-client`, *Windows service stopped* | `UrBackupClientBackend` (display name "UrBackup Client Service for Backups", automatic start) | The client installer, [`urbackup.nsi`](https://github.com/uroni/urbackup_frontend_wx/blob/dev/urbackup.nsi) (`SERVICE create "UrBackupClientBackend"`) |
| Comet Backup agent (Windows) | `backup-comet-delegate`, *Windows service stopped* | `backup.delegate`, which runs scheduled jobs | Comet's [installation](https://docs.cometbackup.com/latest/installation/comet-backup-installation) and [troubleshooting](https://docs.cometbackup.com/latest/troubleshooting) pages |

**Left out, on purpose:**

- **Comet's `backup.elevator` service.** Comet's documentation names it: it takes VSS snapshots and installs
  updates. But the documentation does not say the service is meant to run at all times, so a "stopped" alert could
  be wrong.
- **Event-log templates.** Neither vendor documents a Windows event that marks a failed backup:
  - UrBackup's Windows installer registers no event source.
  - Comet's documentation names no event source or event id.

  A template on an undocumented event would be a guess. If you know your agents' events, add an *Event log*
  monitor by hand.

## Switches

| Variable | Effect |
|---|---|
| `BACKUP_SYNC_SWEEP=off` | Stops the pull sweep, which reads each enabled pull connection (exact; `run-e2e.sh` exports it, the browser suite sets it). A St0r push still arrives. In 0.81 the only pull driver is the test stand-in, so on a production server the sweep has nothing to do |
| `BACKUP_SYNC_SECONDS` | How often the pull sweep runs (default 900) |
| `BACKUP_TEST_BASE_URL` | The stand-in's address. Read only under `NODE_ENV=test`, only when it is `http://127.0.0.1:<port>` |

## What has been tested

- **Unit:** `apps/api/scripts/unit-backups.mjs`, in CI. It covers the feed, restore-test derivation, asset state,
  the four monitors, the push token and the templates.
- **Behavioural:** `apps/api/scripts/e2e-backups.mjs`, on ports 4051 to 4053, with a scratch database,
  `MONITOR_SWEEP` on and a loopback stand-in. It is in `run-e2e.sh`. It proves:
  - default deny, and refusal of another customer;
  - the push token's refusals;
  - a successful job without a drill is never verified, and nor is one with only a simulated drill;
  - a stale backup raising and clearing;
  - `DRILL_FAILED` and `RPO_EXCEEDED`;
  - the pull sweep skipping a paused customer.
- **Browser:** `apps/web/scripts/e2e-ui.mjs` drives the page at both widths and in both themes, and from 0.82
  Administration → Backup connections and the link control too.
- **0.82, unit:** `apps/api/scripts/unit-backup-setup.mjs`, in CI. It checks:
  - every example in the St0r push contract against the API's own schema;
  - that the JSON Schema file is regenerated identically;
  - idempotency, rotation, the push address and the four states.
- **0.82, behavioural:** `apps/api/scripts/e2e-backup-setup.mjs`, on ports 4061 and 4062, in `run-e2e.sh`. It
  proves:
  - create and the one-time token;
  - the dry run writing nothing;
  - re-sending in any order;
  - rotation refusing the old token at once;
  - linking by hand, scoped and audited;
  - another customer refused;
  - fresh authentication on `ask`;
  - 413 and 429.

**Not yet tested against a real provider:**

- No real St0r push has been received, because St0r does not send one yet.
- No Comet server has been read.
- No template has been applied to a real fleet.
