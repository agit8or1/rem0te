# St0r push contract

**Contract version 1** (`"v": 1`). Rem0te 0.82.0 *Wharf*, 2026-11-21.

This is the contract between St0r and Rem0te for backup status. St0r sends Rem0te what it knows about the backups
it manages. Rem0te shows it on the **Backups** page and raises the backup alerts. It is written for the people
building the St0r side. Rem0te implements every rule here, and its tests check this page's examples against the
API's own schema, so the examples cannot drift from what the API accepts.

The machine-readable schema is
[`st0r-push-contract.schema.json`](https://github.com/agit8or1/rem0te/blob/main/docs/st0r-push-contract.schema.json)
(JSON Schema 2020-12). It is generated from the API's schema, so it holds exactly the same types, lists, patterns
and limits.

## Message to the St0r developers

> Rem0te is ready to receive St0r's backup status. Nothing in Rem0te waits on St0r, and Rem0te will never connect to
> a St0r host.
>
> **What to build:** a job in St0r that, for each Rem0te connection configured in St0r (a URL and a token per
> business), sends `POST <url>` with `Authorization: Bearer <token>` and a JSON body as described below.
>
> 1. **Start with a dry run.** Send the body to `<url>?dryRun=1`. It checks the token and the body exactly as a real
>    push does, writes nothing, and tells you what it would write and what is wrong.
> 2. **Push.** Send changes as they happen, and the recent state of every asset at least every 15 minutes.
> 3. **Keep the three facts apart.** These are three separate facts, never one status:
>    - `completion`: did the job finish;
>    - `integrity`: did St0r verify the stored data;
>    - a restore drill: did a restore of a recovery point work.
>
>    Every drill names the recovery point it restored, and says whether it was `simulated`. Rem0te decides
>    "verified"; St0r never sends it.
> 4. **Re-send freely.** Every item is keyed by St0r's own id, and re-sending is safe in any order.
> 5. **Retry 429, 5xx and network errors** with backoff. Never retry a 400, 401 or 413 unchanged.
>
> Questions or a change you need: open an issue on the Rem0te repository. Anything beyond an added optional field
> is a new contract version.

## How it fits together

- **St0r pushes; Rem0te never connects to St0r** (decision 17). St0r's routes need a signed-in user and it has no
  service token, so Rem0te does not read from it.
- **One connection per business.** A Platform Admin creates it in Rem0te under **Settings → Backups**. Each
  connection has its own token. The token decides the business: the body names no business and cannot.
- **What Rem0te does with it:**
  - shows it on **Backups**;
  - measures RPO (from the newest recovery point) and RTO (only from a verified drill's elapsed time);
  - raises *Backup stale*, *Backup failed*, *Restore drill failed* and *RPO exceeded* alerts on the computer an
    asset is linked to.

  It never starts a backup, a restore, a drill or a failover.

## Authentication

```
POST https://<rem0te>/api/v1/backups/push
Authorization: Bearer rbk_<connection id>_<64 lowercase hex characters>
Content-Type: application/json
```

- **The URL.** Settings → Backups shows it, built from the server's public address (Settings → General → Public
  address). It is always HTTPS in production.
- **The token** has the form `rbk_<connection id>_<secret>`. The page shows it **once**, when the connection is
  created or its token is rotated. Rem0te keeps only the secret's SHA-256 and compares it in constant time, so a
  lost token cannot be read back from Rem0te. Make a new one instead.
- **Store it as a secret** in St0r, encrypted at rest. Never log it, put it in a URL, or show it in St0r's UI after
  it is saved.
- **Rotation has no overlap.** When an admin rotates the token, the old one stops working at once. The pushes refused
  until St0r has the new token are simply sent again (see [Idempotency](#idempotency)). An overlap would leave a
  possibly leaked token working.
- **Revocation** stops the token for good. What St0r already reported stays in Rem0te.
- **Every refusal looks the same.** A missing, malformed, wrong, rotated or revoked token, and an unknown or revoked
  connection, all get `401 BACKUP_PUSH_UNAUTHORIZED`. Rem0te does not say which.

## The body

<!-- example: valid -->
```json
{
  "v": 1,
  "assets": [
    {
      "externalId": "urb-client-17",
      "name": "FS01",
      "type": "server",
      "computer": { "hostname": "fs01.corp.example.com" },
      "jobs": [
        { "externalId": "urb-17-img-2041", "startedAt": "2026-11-20T01:00:00Z", "finishedAt": "2026-11-20T01:42:10Z",
          "completion": "succeeded", "integrity": "passed", "integrityCheckedAt": "2026-11-20T02:05:00Z", "bytes": 48318382080 }
      ],
      "recoveryPoints": [
        { "externalId": "urb-17-img-2041", "pointAt": "2026-11-20T01:00:00Z", "location": "offsite", "jobExternalId": "urb-17-img-2041" }
      ],
      "drills": []
    }
  ]
}
```

### Top level

| Field | Type | Required | Meaning |
|---|---|---|---|
| `v` | `1` | yes | The contract version. Always `1` for this contract. |
| `assets` | array of [assets](#asset) | yes | At most **500**. A push is a **delta**: an asset left out is kept exactly as it was. It is not deleted. To report more than 500 assets, send several pushes. |

**No other field is allowed** at any level. Every object is strict, so a field Rem0te does not know is refused, and
so is a field naming a business, tenant or connection. This is on purpose: a typo is caught, instead of being
silently dropped.

### Asset

| Field | Type | Required | Meaning |
|---|---|---|---|
| `externalId` | string, `^[A-Za-z0-9._:-]{1,128}$` | yes | St0r's own stable id for the asset. The same id in a later push updates the same asset. Unique within one push. |
| `name` | string, 1–200 characters | yes | What people see. Letters (including Latin accents), digits, space and `. , : ; ( ) / & + ' # _ @ -` only. |
| `type` | `computer` `server` `virtual_machine` `database` `files` `mailbox` `other` | yes | What is protected. |
| `computer` | object | no | Which Rem0te computer this is, if St0r knows. See [Linking to computers](#linking-to-computers). |
| `computer.rem0teId` | string, `^[A-Za-z0-9_-]{8,64}$` | no | The computer's Rem0te id. Tried first. |
| `computer.hostname` | string, `^[A-Za-z0-9.-]{1,253}$` | no | The hostname. Links only when exactly one active computer of the business has it (case-insensitive). |
| `jobs` | array of [jobs](#job) | no (default `[]`) | Recent jobs, at most **50**. |
| `recoveryPoints` | array of [recovery points](#recovery-point) | no (default `[]`) | Restorable points, at most **50**. |
| `drills` | array of [drills](#drill) | no (default `[]`) | Restore drills, at most **20**. |

### Job

| Field | Type | Required | Meaning |
|---|---|---|---|
| `externalId` | string, `^[A-Za-z0-9._:-]{1,128}$` | yes | St0r's id for the job. Unique within the asset's `jobs`. |
| `startedAt` | date-time | yes | When the job started. |
| `finishedAt` | date-time or `null` | no | When it finished. Absent or `null` while `running`; a running job with `finishedAt` is refused. |
| `completion` | `running` `succeeded` `partial` `failed` `cancelled` `unknown` | yes | **Completion only**: did the job finish, and how. It says nothing about integrity or restore. |
| `integrity` | `not_checked` `passed` `failed` | no (default `not_checked`) | **Integrity only**: did St0r verify the stored data. |
| `integrityCheckedAt` | date-time or `null` | no | When that check ran. |
| `bytes` | integer ≥ 0, or `null` | no | Bytes transferred or stored, if known. |
| `errorCode` | string, `^[A-Za-z0-9_.-]{1,64}$`, or `null` | no | A short machine code for a failure, such as `CLIENT_OFFLINE`. Not a message, so no free text. |

There is **no** `restoreTest`, `verified` or `status` field, and sending one is refused. Rem0te works out whether a
job's restore was verified, from drills.

### Recovery point

| Field | Type | Required | Meaning |
|---|---|---|---|
| `externalId` | string, `^[A-Za-z0-9._:-]{1,128}$` | yes | St0r's id for the point. Drills name it. Unique within the asset's `recoveryPoints`. |
| `pointAt` | date-time | yes | The moment the point restores to. RPO is measured from the newest one. |
| `location` | `local` `offsite` `cloud` `unknown` | no (default `unknown`) | Where it is kept. |
| `jobExternalId` | string or `null` | no | The job that made it. **Needed for a drill of this point to verify that job.** It may name a job in this push or one sent earlier. |

### Drill

| Field | Type | Required | Meaning |
|---|---|---|---|
| `externalId` | string, `^[A-Za-z0-9._:-]{1,128}$` | yes | St0r's id for the drill. Unique within the asset's `drills`. |
| `recoveryPointExternalId` | string, `^[A-Za-z0-9._:-]{1,128}$` | **yes** | **The recovery point this drill restored.** A drill without it is refused. If it names a point Rem0te does not hold (in this push or an earlier one), the drill is kept and shown, but verifies nothing. |
| `recoveryPointAt` | date-time or `null` | no | The restored point's time, for a point St0r does not send. Ignored when the named point is stored. |
| `target` | `isolated_vm` `isolated_path` `sandbox` `other` | yes | Where it was restored. A drill restores somewhere isolated, never over production. |
| `scope` | `file` `volume` `full_image` `application` | yes | What was restored. |
| `result` | `running` `passed` `failed` `partial` `unknown` | yes | The outcome. |
| `simulated` | boolean | **yes** | `true` for a simulated drill. It is stored and shown as *simulated*, and **never** counts as a verified restore. No default: leaving it out is refused. |
| `validation` | `sha256` `file_compare` `service_running` `boot` `manual` `none` | yes | How the restored data was checked. A drill with `none` cannot pass: `passed` with `none` is refused. |
| `startedAt` | date-time | yes | When it started. |
| `finishedAt` | date-time or `null` | when finished | Required once `result` is `passed`, `failed` or `partial`. |
| `elapsedSeconds` | integer 0–2,592,000, or `null` | no | How long the restore took. **The only source of Rem0te's measured RTO.** |
| `failureCode` | string, `^[A-Za-z0-9_.-]{1,64}$`, or `null` | no | A short machine code, such as `SERVICE_DID_NOT_START`. |

## Three facts, never one

A job carries three separate facts, and nothing collapses them into one status:

| Fact | Who says | From |
|---|---|---|
| **Completion** | St0r | `job.completion` |
| **Integrity** | St0r | `job.integrity` |
| **Verified restore** | **Rem0te decides** | A drill that has all of these: <ul><li>it restored a recovery point whose `jobExternalId` is that job;</li><li>`simulated` is `false`;</li><li>`result` is `passed`;</li><li>`validation` is not `none`.</li></ul> |

So a job that succeeded with its integrity check passed is **not** verified. A simulated drill that passed is not
verified either. The newest finished, non-simulated drill of a job's points decides the job's restore test:
`passed` makes it verified, and `failed` or `partial` makes it failed. Rem0te's database refuses anything else
(migration 0097).

## Linking to computers

An asset links to a computer of the token's business, never another's. The rules are tried in this order:

1. **By id.** `computer.rem0teId` names an active computer of that business.
2. **By hostname.** `computer.hostname` matches exactly one active computer of that business. The match ignores
   case.
3. **Not linked.** Otherwise the asset appears as *Not linked*. Mailboxes and shares usually are.

When St0r's name for a machine does not match, someone in Rem0te can link the asset by hand on the Backups page.
They can also mark it as *no computer*. A person's choice wins over every later push. The dry run's `link` field
tells you which rule applies: `rem0te_id`, `hostname`, `manual`, `not_a_computer` or `none`.

An alert is raised only on a linked asset, on its computer.

## Limits

| Limit | Value | Over it |
|---|---|---|
| Body size | **1 MB** of JSON | `413 PAYLOAD_TOO_LARGE`. Nothing is written. |
| Assets per push | **500** | `400 BAD_FEED` |
| Jobs per asset | **50** | `400 BAD_FEED` |
| Recovery points per asset | **50** | `400 BAD_FEED` |
| Drills per asset | **20** | `400 BAD_FEED` |
| Requests per source address | **30 a minute**, and 20 a second for bursts. Dry runs count | `429 TOO_MANY_REQUESTS` |

**A push over a limit is refused whole, never cut.** To stay well inside the limits, send only recent history: the
last few jobs and points, and drills from the last 30 days. Then split by asset.

## Idempotency

Re-sending is always safe, in any order.

- **Keys.** An asset is keyed by its `externalId` within the connection. A job, point or drill is keyed by its
  `externalId` within its asset. The same id never makes a second row.
- **The newest report replaces the stored fields.** St0r is the source of truth for its own items, so a finished job
  can still be corrected, for example from `failed` to `succeeded`.
- **A fact never moves backwards.** This protects against an older push that is retried late:
  - a job that is `succeeded`, `partial`, `failed` or `cancelled` is never put back to `running` or `unknown`. Its
    completion and `finishedAt` are kept, and the rest of the report is applied;
  - a job's `integrity` of `passed` or `failed` is never put back to `not_checked`;
  - a drill that is `passed`, `failed` or `partial` is never put back to `running` or `unknown`. That report of the
    drill is skipped whole.

  The answer's `kept` counts the items held back this way.
- **Nothing is deleted by leaving it out.** An asset, job, point or drill missing from a push stays as it was.
- **The same push sent twice** writes the same rows. The only difference is the time of the last report.

## Dry run

`POST <url>?dryRun=1` is the same request with the same token. It checks the token, then parses the body against
the same schema, and then:

- **It writes nothing** except one audit row in Rem0te. That row holds the counts and never the body. It writes no
  asset, job, point or drill, and not the connection's last report or result.
- **It answers `200`** whenever the token is good. `valid` says whether a real push would be accepted.
- **It tells you** what would be written, how each asset would link, and warnings you can act on:
  - a drill whose recovery point Rem0te does not hold;
  - a simulated drill;
  - a point whose job is unknown;
  - an asset naming a computer that matches nothing.
- **It counts towards the rate limit.**

Admins see the newest dry run on Settings → Backups. `dryRun=0` or no parameter is a real push. Any other value
is `400`.

<!-- example: response -->
```json
{
  "success": true,
  "data": {
    "dryRun": true, "contractVersion": 1, "valid": true, "issues": [],
    "wouldWrite": { "assets": 1, "jobs": 1, "points": 1, "drills": 1 },
    "assets": [{ "externalId": "urb-client-17", "known": false, "link": "hostname" }],
    "warnings": ["asset urb-client-17 drill drill-88: simulated, so it is shown and never counts as a verified restore"]
  }
}
```

An invalid body gives `"valid": false`, `"wouldWrite": null` and up to 20 `issues`. Each issue names a path into
the body and a rule:

<!-- example: response -->
```json
{ "success": true, "data": { "dryRun": true, "contractVersion": 1, "valid": false, "wouldWrite": null, "assets": [], "warnings": [],
  "issues": [{ "path": "assets.0.drills.0.recoveryPointExternalId", "message": "Invalid input: expected string, received undefined" }] } }
```

## Responses and errors

A real push that is accepted answers `200`:

<!-- example: response -->
```json
{ "success": true, "data": { "contractVersion": 1, "assets": 1, "jobs": 1, "points": 1, "drills": 0, "kept": 0 } }
```

An error is always JSON with a stable `code`:

```json
{ "success": false, "statusCode": 400, "code": "BAD_FEED", "message": "assets.0.jobs.0.completion: Invalid option: …" }
```

| Status | `code` | Meaning | What St0r does |
|---|---|---|---|
| 200 | — | Accepted (or, for a dry run, checked) | Nothing more |
| 400 | `BAD_FEED` | The body breaks the schema. `message` gives the first five problems. Nothing was written. Admins see the reason on Settings → Backups | Fix it. Do not retry unchanged. Use a dry run to see every problem |
| 400 | `BAD_REQUEST` | The body is not JSON | Fix it |
| 400 | `INVALID_REQUEST` | `dryRun` is not `1`, `true`, `0` or `false` | Fix it |
| 401 | `BACKUP_PUSH_UNAUTHORIZED` | The token is missing, wrong, rotated or revoked | Stop pushing to this connection and tell the St0r admin to enter a new token. Do not retry in a loop |
| 413 | `PAYLOAD_TOO_LARGE` | Over 1 MB | Split the push by asset |
| 429 | `TOO_MANY_REQUESTS` | Over the rate limit | Wait for the number of seconds in `Retry-After-main` (60 for the per-minute limit), then retry |
| 5xx | any | Rem0te could not take it | Retry with backoff |

**Retries:**

- **Retry only 429, 5xx and network errors** (a timeout, or a connection refused or reset).
- **Back off exponentially with jitter.** Start at 5 seconds and double each time, up to 15 minutes. Add a random
  0–20% to each wait. Honour `Retry-After-main` when it is present.
- **A retry is always safe**, because of [idempotency](#idempotency). If the state changed while waiting, send the
  current state rather than the old body.
- **Give up after about 24 hours** and show the error in St0r. Rem0te's *Backup stale* alert covers the gap on the
  Rem0te side.
- **Use a 30-second request timeout.** A push of 500 assets is written one asset at a time, so a large push can take
  several seconds.

## Clocks and time zones

- **Every date is RFC 3339 with an offset.** `2026-11-20T01:00:00Z` and `2026-11-20T02:00:00+01:00` are the same
  moment. A date without an offset, such as `2026-11-20T01:00:00`, is refused, because Rem0te will not guess the
  time zone. Send UTC (`Z`) where you can. Fractional seconds are allowed.
- **The date range is checked.** A date before 2000-01-01 is refused. So is one more than **24 hours** after
  Rem0te's clock, which is the tolerance for a skewed clock.
- **Keep St0r's clock synchronised** with NTP. A St0r clock that runs ahead makes backups look newer than they are,
  so RPO and *Backup stale* would be wrong.
- **Rem0te stores UTC.** It shows every time in the viewer's own time zone.
- **Send the moment each thing happened,** not the moment you sent it. `pointAt` is what a restore would return
  to, not when the point was copied offsite.

## Worked examples

### A database with a verified restore

The job succeeded, its integrity check passed, and a real drill of its recovery point passed: the job is verified,
and RTO is measured as 1,140 seconds.

<!-- example: valid -->
```json
{
  "v": 1,
  "assets": [
    {
      "externalId": "urb-client-22-sql",
      "name": "SQL01 Finance DB",
      "type": "database",
      "computer": { "hostname": "sql01.corp.example.com" },
      "jobs": [
        { "externalId": "job-22-0931", "startedAt": "2026-11-20T00:30:00Z", "finishedAt": "2026-11-20T00:51:00Z",
          "completion": "succeeded", "integrity": "passed", "integrityCheckedAt": "2026-11-20T01:10:00Z" }
      ],
      "recoveryPoints": [
        { "externalId": "rp-22-0931", "pointAt": "2026-11-20T00:30:00Z", "location": "local", "jobExternalId": "job-22-0931" },
        { "externalId": "rp-22-0931-off", "pointAt": "2026-11-20T00:30:00Z", "location": "offsite", "jobExternalId": "job-22-0931" }
      ],
      "drills": [
        { "externalId": "drill-77", "recoveryPointExternalId": "rp-22-0931", "target": "isolated_vm", "scope": "application",
          "result": "passed", "simulated": false, "validation": "service_running",
          "startedAt": "2026-11-20T03:00:00Z", "finishedAt": "2026-11-20T03:19:00Z", "elapsedSeconds": 1140 }
      ]
    }
  ]
}
```

### A simulated drill is shown, never counted

<!-- example: valid -->
```json
{
  "v": 1,
  "assets": [
    {
      "externalId": "urb-client-17",
      "name": "FS01",
      "type": "server",
      "drills": [
        { "externalId": "drill-88", "recoveryPointExternalId": "urb-17-img-2041", "target": "sandbox", "scope": "full_image",
          "result": "passed", "simulated": true, "validation": "boot",
          "startedAt": "2026-11-20T04:00:00Z", "finishedAt": "2026-11-20T04:12:00Z", "elapsedSeconds": 720 }
      ]
    }
  ]
}
```

### A job reported while it runs, then when it finishes

Send it running:

<!-- example: valid -->
```json
{ "v": 1, "assets": [ { "externalId": "urb-client-31", "name": "LAPTOP-0042", "type": "computer",
  "computer": { "rem0teId": "cmabc123def456ghi789" },
  "jobs": [ { "externalId": "job-31-5520", "startedAt": "2026-11-20T12:00:00+01:00", "completion": "running" } ] } ] }
```

Then, with the same `externalId`, finished. If the first push is retried after this one, the job stays failed:

<!-- example: valid -->
```json
{ "v": 1, "assets": [ { "externalId": "urb-client-31", "name": "LAPTOP-0042", "type": "computer",
  "jobs": [ { "externalId": "job-31-5520", "startedAt": "2026-11-20T12:00:00+01:00", "finishedAt": "2026-11-20T12:20:00+01:00",
              "completion": "failed", "errorCode": "CLIENT_OFFLINE" } ] } ] }
```

### A mailbox, a failed drill, and a point kept elsewhere

<!-- example: valid -->
```json
{
  "v": 1,
  "assets": [
    { "externalId": "m365-ceo", "name": "CEO mailbox", "type": "mailbox",
      "jobs": [ { "externalId": "m365-ceo-1120", "startedAt": "2026-11-20T02:00:00Z", "finishedAt": "2026-11-20T02:03:00Z", "completion": "partial", "errorCode": "ITEMS_SKIPPED" } ],
      "recoveryPoints": [ { "externalId": "m365-ceo-1120", "pointAt": "2026-11-20T02:00:00Z", "location": "cloud", "jobExternalId": "m365-ceo-1120" } ] },
    { "externalId": "urb-client-40", "name": "NAS share (Finance)", "type": "files",
      "drills": [ { "externalId": "drill-91", "recoveryPointExternalId": "rp-40-1119", "recoveryPointAt": "2026-11-19T22:00:00Z",
                    "target": "isolated_path", "scope": "file", "result": "failed", "simulated": false, "validation": "sha256",
                    "startedAt": "2026-11-20T05:00:00Z", "finishedAt": "2026-11-20T05:04:00Z", "failureCode": "HASH_MISMATCH" } ] }
  ]
}
```

### Refused bodies

Each of these is refused with `400 BAD_FEED` (or `"valid": false` in a dry run), and nothing in it is written.

A drill that does not name its recovery point:

<!-- example: invalid -->
```json
{ "v": 1, "assets": [ { "externalId": "a1", "name": "FS01", "type": "server",
  "drills": [ { "externalId": "d1", "target": "isolated_vm", "scope": "full_image", "result": "passed", "simulated": false,
                "validation": "boot", "startedAt": "2026-11-20T03:00:00Z", "finishedAt": "2026-11-20T03:10:00Z" } ] } ] }
```

St0r saying a job is verified:

<!-- example: invalid -->
```json
{ "v": 1, "assets": [ { "externalId": "a1", "name": "FS01", "type": "server",
  "jobs": [ { "externalId": "j1", "startedAt": "2026-11-20T01:00:00Z", "finishedAt": "2026-11-20T01:30:00Z", "completion": "succeeded", "restoreTest": "verified" } ] } ] }
```

A drill that leaves out `simulated`:

<!-- example: invalid -->
```json
{ "v": 1, "assets": [ { "externalId": "a1", "name": "FS01", "type": "server",
  "drills": [ { "externalId": "d1", "recoveryPointExternalId": "p1", "target": "sandbox", "scope": "file", "result": "passed",
                "validation": "sha256", "startedAt": "2026-11-20T03:00:00Z", "finishedAt": "2026-11-20T03:10:00Z" } ] } ] }
```

A pass that checked nothing:

<!-- example: invalid -->
```json
{ "v": 1, "assets": [ { "externalId": "a1", "name": "FS01", "type": "server",
  "drills": [ { "externalId": "d1", "recoveryPointExternalId": "p1", "target": "sandbox", "scope": "file", "result": "passed",
                "simulated": false, "validation": "none", "startedAt": "2026-11-20T03:00:00Z", "finishedAt": "2026-11-20T03:10:00Z" } ] } ] }
```

A body that names a business:

<!-- example: invalid -->
```json
{ "v": 1, "businessId": "cmabc123def456ghi789", "assets": [] }
```

A date without an offset:

<!-- example: invalid -->
```json
{ "v": 1, "assets": [ { "externalId": "a1", "name": "FS01", "type": "server",
  "jobs": [ { "externalId": "j1", "startedAt": "2026-11-20T01:00:00", "completion": "running" } ] } ] }
```

A running job with an end time:

<!-- example: invalid -->
```json
{ "v": 1, "assets": [ { "externalId": "a1", "name": "FS01", "type": "server",
  "jobs": [ { "externalId": "j1", "startedAt": "2026-11-20T01:00:00Z", "finishedAt": "2026-11-20T01:30:00Z", "completion": "running" } ] } ] }
```

The same job twice in one asset:

<!-- example: invalid -->
```json
{ "v": 1, "assets": [ { "externalId": "a1", "name": "FS01", "type": "server",
  "jobs": [ { "externalId": "j1", "startedAt": "2026-11-20T01:00:00Z", "completion": "running" },
            { "externalId": "j1", "startedAt": "2026-11-20T02:00:00Z", "completion": "running" } ] } ] }
```

A future contract version:

<!-- example: invalid -->
```json
{ "v": 2, "assets": [] }
```

### From the command line

```bash
TOKEN='rbk_…'                     # from Settings → Backups, shown once
URL='https://rmm.example.com/api/v1/backups/push'
curl -sS -X POST "$URL?dryRun=1" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data @push.json
```

Drop `?dryRun=1` to push for real. Keep the token out of shell history in production, for example by reading it
from a file.

## Versions

- **The version is the `v` field.** This document describes version `1`.
- **Additions that keep version 1.** These are made only in a way a version-1 sender can ignore:
  - a new optional field in a response;
  - a new warning in a dry run;
  - a higher limit.

  A new value in one of the closed lists is not one of them: it is refused by older Rem0te servers.
- **What makes a new version:** a new body field, a new value in a closed list, a stricter rule, or a changed
  meaning. A new version gets a new `v`, and this page gets a new changelog entry. Rem0te then accepts both
  versions for a transition period, and this page will say how long it lasts.

## Changelog

### Version 1: Rem0te 0.82.0, 2026-11-21

The first published contract. It changes what 0.81.0 accepted in three places:

1. **`drills[].recoveryPointExternalId` is required.** 0.81 accepted a drill that named no point, and such a drill
   could never verify anything.
2. **Re-sending is defined.** A fact never moves backwards, and the answer counts what was kept back (`kept`). In
   0.81 the last write won, so an old push retried late could put a finished job back to `running`.
3. **`?dryRun=1` is new.** Error codes are fixed for an oversized body (`413`, was `500`), a body that is not JSON
   (`400`, was `500`) and the rate limit (`429 TOO_MANY_REQUESTS`, was coded `INTERNAL_ERROR`).

No St0r build had sent a push before this version.
