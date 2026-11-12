# Containment

rem0te 0.28 can **stop writes** while an incident is looked at, for every business or for one. It also keeps a
**tamper-evident audit log** that can be checked against a copy kept off the host. Viewing, reports and the audit
log keep working during a pause.

Settings → Security → **Containment** is where pauses are set and lifted. While one applies to you, a red strip at
the top of every page says what is stopped and why. (The dashboard, which is sized to fit the window, takes the
strip's height off its own from 0.36, so the strip never makes it scroll.)

## What a pause stops

| Kind | Stops | Checked at |
|---|---|---|
| **Approved actions** | New action requests and patch deployments; delivery of plans **already approved** (they are held, not canceled) | Request, dispatch recheck, every heartbeat delivery |
| **Remote connections** | Connect, launcher links, Quick Connect; starting a [chat](chat.md) and sending in one (0.34) | Every launch decision; chat start and send |
| **Agent updates** | RustDesk and agent update or reinstall instructions on the heartbeat, and update-rollout dispatch (deferred as `contained`) | Every heartbeat, before anything is recorded as sent |
| **ClientSt0r jobs** | New ticket-analysis jobs (`423 CONTAINED`), and queued ones (ended `CONTAINED`) | Submit and the worker |
| **Outbound email** (`notifications`, 0.34) | Every email: alert emails, scheduled reports (the period is recorded *blocked*, not sent later), confirmation links (`403 CONTAINED`) and test emails. **Not** alert webhooks | The one send path every email goes through ([email.md](email.md)) |

A refusal in the portal is `403` with code `CONTAINED` and the pause's reason. It is checked **after** access, so
nobody outside a business learns that it is suspended.

What a pause does not do: it doesn't end a remote session already running, or stop an agent that has already
started an action, and it doesn't hide anything. It also doesn't touch **monitoring**: alerts keep being raised and
notified during a pause, because that is when you most want them — except by email when the pause covers outbound
email (0.34).

The reverse holds too. A **maintenance window** ([monitoring](monitoring.md#maintenance-windows)) only holds
*notifications* — who is told about an alert. It never pauses writes and never stops anything reaching a computer.
The two are separate on purpose: one is planned quiet, the other is an incident brake, and neither can be used as
the other.

## Who can set and lift

| Pause | Set by | Lifted by |
|---|---|---|
| **Global** (every business) | A Platform Admin or a technician manager | One of them **who did not set it**, with fresh authentication |
| **Business, by the MSP** | A Platform Admin or a technician manager | One of them who did not set it, with fresh authentication. The business cannot lift it |
| **Business, by the business itself** | A Business Owner of that business | **Only** a Business Owner of that business, with fresh authentication. The MSP cannot lift it |

Setting needs no re-authentication: stopping should be one click. Lifting widens what can happen, so it does.
Technicians cannot see or change containment.

If nobody who may lift a pause can sign in, lift it on the server (audited, dry run without `--yes`):

```bash
sudo bash -c 'set -a; . /etc/reboot-remote/api.env; set +a; cd /opt/reboot-remote/api && node dist/cli/rem0te-audit.js containment list'
sudo bash -c 'set -a; . /etc/reboot-remote/api.env; set +a; cd /opt/reboot-remote/api && node dist/cli/rem0te-audit.js containment clear --id <id> --reason "<why>" --yes'
```

## Three layers

A portal pause is only as trustworthy as the portal. If the portal or its database may be compromised, the
other two layers are what hold.

| Layer | Who can set it | Who can lift it | Holds if the portal is compromised? |
|---|---|---|---|
| **Portal** | As above | As above | No. A compromised portal can ignore its own pause |
| **Approval signer** | The portal (automatically, for any pause covering actions), or the signer operator | **Only the signer operator**, with the signer CLI | Yes, for new approvals. The portal can add a pause there but has no route that lifts one |
| **Agent: signed pause** | The release operator, with the offline targets key | The release operator, by publishing a pause that pauses nothing | Yes. Agents refuse whatever the portal delivers |

### The approval signer

While it holds a pause for a business, or a global one, the signer refuses new plans for it (`paused`) and refuses
every approval decision, including one already in progress. Lifting the portal's pause does **not** lift the
signer's copy. Check it, then lift it on the signer host:

```bash
sudo -u rem0te-approver env APPROVAL_SIGNER_DIR=/var/lib/rem0te-approver node /opt/rem0te-approver/dist/approval-signer/main.js pause list
sudo -u rem0te-approver env APPROVAL_SIGNER_DIR=/var/lib/rem0te-approver node /opt/rem0te-approver/dist/approval-signer/main.js pause clear --id <id> --reason '<why>'
# or set one directly, without the portal:
sudo -u rem0te-approver env APPROVAL_SIGNER_DIR=/var/lib/rem0te-approver node /opt/rem0te-approver/dist/approval-signer/main.js pause set --global --reason '<why>'
```

This needs the 0.28 signer build (`apps/api/scripts/build-approval-signer.mjs`). An older signer answers the portal's
pause request with 404; the portal records that as `refused` and its own pause still holds.

### The signed pause

`control/pause.json` is published through the signed update repository (see
[Update signing → Publishing a signed pause](update-signing.md#publishing-a-signed-pause)). An agent on a 0.28+ signed
build that finds itself covered:

- refuses an approved action with `paused`, after verifying the plan and before journaling it. The refusal is
  final, so lifting the pause doesn't revive that job;
- with `updates` paused, refuses the update command before downloading anything.

A pause that is listed but can't be read counts as paused. A compromised portal can withhold a newer pause.json
only until the signed timestamp expires, after which agents refuse the repository.

## The tamper-evident audit log

Every audit entry is hashed onto the one before it within a few seconds of being written:

```
hash(n) = sha256( hash(n-1) + "\n" + canonical(entry n) )        hash(0) = 64 zeros
```

The entry covers its sequence number, id, time, action, IP address, user agent, resource, metadata, and the
tenant, business and user it named. A sequence number that never committed (a failed insert) is declared in
the next entry, so any **other** gap is a deletion.

- **Guarded.** A database trigger refuses any change to a sealed entry. The one exception is clearing a reference
  when a user or business is deleted. The original ids are sealed into the entry.
- **Verified.** The chain is recomputed at start-up and hourly, and on demand from Containment → Audit log
  integrity. A break logs `AUDIT CHAIN BROKEN` and writes an `AUDIT_CHAIN_ALERT` entry.
- **Exported.** Sealed entries stream off the host as NDJSON (`rem0te-audit-export/1`) to a file and/or an HTTPS
  endpoint. A failed delivery is retried, so a sink must accept a line it already has.
- **Checkpointed.** Every 15 minutes the head is recorded, Ed25519-signed if a key is configured, and exported with
  the entries.

What it proves: a sealed entry that was later changed or deleted is detected. An attacker who rewrites every hash
in the database is caught only by comparing with the **export**:

```bash
# on the server, against the database, with the export and the public key copied from elsewhere
sudo bash -c 'set -a; . /etc/reboot-remote/api.env; set +a; cd /opt/reboot-remote/api && \
  node dist/cli/rem0te-audit.js verify --export /path/to/export.ndjson --pub /path/to/audit-checkpoint.pub'
# anywhere, no database: check an export on its own
node dist/cli/rem0te-audit.js verify-export export.ndjson --pub audit-checkpoint.pub
```

Exit status 0 means intact, 1 means a problem was found, 2 means usage. What it does **not** do: it detects, it
doesn't prevent. A database superuser can still delete rows or drop the trigger, and is caught afterwards, not
stopped. It cannot prove an event was ever logged. A checkpoint key on the host signs whatever the host says;
its value is that the **public** key, kept elsewhere, pins checkpoints made before a compromise.

### Turning on off-host export and signed checkpoints

Neither is on until configured, and without them the chain detects tampering only as long as the host itself is
trusted. To turn both on:

1. **Make the checkpoint key** on the host, and copy the public key it prints somewhere the host cannot change
   (your password manager, a ticket, the off-host log store):

   ```bash
   sudo -u reboot node /opt/reboot-remote/api/dist/cli/rem0te-audit.js keygen --out /etc/reboot-remote/audit-checkpoint.pem
   sudo chmod 600 /etc/reboot-remote/audit-checkpoint.pem
   ```
2. **Choose a sink the portal host cannot rewrite**: an append-only mount or a log shipper's spool for
   `AUDIT_EXPORT_FILE`, or an HTTPS collector for `AUDIT_EXPORT_URL` (with `AUDIT_EXPORT_TOKEN`).
3. **Set them** in `/etc/reboot-remote/api.env`:

   ```bash
   AUDIT_CHECKPOINT_KEY_FILE=/etc/reboot-remote/audit-checkpoint.pem
   AUDIT_EXPORT_FILE=/var/log/rem0te-audit/export.ndjson     # and/or AUDIT_EXPORT_URL=https://…
   ```
4. **Restart** the API (`sudo systemctl restart reboot-remote-api`). Within one checkpoint interval
   (`AUDIT_CHECKPOINT_INTERVAL_SECONDS`, 15 minutes by default) **Settings → Security → Containment** (audit integrity) shows
   checkpoints as signed, and the sink starts receiving entries.
5. **Verify from elsewhere**, with the public key from step 1 saved as `audit-checkpoint.pub`:
   `node dist/cli/rem0te-audit.js verify-export export.ndjson --pub audit-checkpoint.pub` (below).
   Checkpoints written before the key was configured carry no signature; they are counted on the summary line
   ("N unsigned, from before a checkpoint key was configured") and are not problems. A checkpoint that *has* a
   signature which does not verify under the key is.

Entries are insert-only from the moment they are written (0.30.1): the database refuses any change to an entry's
content, sealed or not, except setting its business, tenant or actor to nothing when those are deleted.

### Configuration

| Variable | Meaning |
|---|---|
| `AUDIT_EXPORT_FILE` | Append the export here. Put it on storage the portal host cannot rewrite (an append-only mount, a log shipper's spool) |
| `AUDIT_EXPORT_URL` | POST each batch here (`application/x-ndjson`). HTTPS, or HTTP to loopback only; redirects refused; 10 s timeout |
| `AUDIT_EXPORT_TOKEN` | Sent as `Authorization: Bearer …` to `AUDIT_EXPORT_URL` |
| `AUDIT_CHECKPOINT_KEY_FILE` | Ed25519 private key (PEM). Create it with `node dist/cli/rem0te-audit.js keygen --out <file>`, which prints the public key. Keep that **off** the host |
| `AUDIT_CHECKPOINT_INTERVAL_SECONDS` | Default 900 |
| `AUDIT_SEALER=off` | Disable sealing in this process. For a second API instance; one sealer runs at a time anyway (advisory lock) |
| `HEALTH_TOKEN` | 24+ characters. Unlocks `/api/v1/healthz` detail (below) |

## Watching from outside

`GET /api/v1/healthz` answers `{"status":"ok"}` and nothing else, or `503` if the database is down. With the header
`x-rem0te-health-token: $HEALTH_TOKEN` it adds:
- the version and the database;
- whether the approval signer answers;
- seal, export and verify state and lags;
- the number of active pauses.

It carries no names, ids or addresses. It answers in maintenance mode too.

`deploy/scripts/rem0te-external-check.py` is meant to run on **another machine** (cron, or any monitor that reads
an exit status). It checks:
- the portal's health;
- the audit lags;
- the verify result;
- that the signer and hbbs answer.

```bash
REM0TE_HEALTH_TOKEN=… python3 rem0te-external-check.py --portal https://remote.example.com \
  --signer https://approve.example.com --hbbs remote.example.com:21116
```

A compromised portal can lie to it. It is for the failures that aren't attacks: a stuck sealer, a dead export,
a stopped signer. It also notices the portal stopping altogether.

## What has been proven, and what hasn't

| Level | State |
|---|---|
| **Fixture-tested** | Yes. `e2e-containment.mjs` (70 checks): every rule above, every write path, the signer's copy, the agent's signed-pause refusal through `rem0te-action-sim`, sealing, the trigger, a deletion detected in the database and against the export, signed checkpoints, `/healthz`. `unit-audit-chain.mjs` (33 checks). Go: `internal/action/pause_test.go`, `internal/agent` signed-pause tests |
| **Paired lab** | **Not done.** No real Windows agent has refused under a signed pause, and no export sink outside the host has been exercised |
| **Production-ready** | The portal pause and the audit chain are on as soon as 0.28 is installed. The signer layer needs the 0.28 signer build; the agent layer needs a 0.28 signed agent build published. Export and signed checkpoints need configuring |

## See also

- [Incident recovery](incident-recovery.md): the runbook.
- [Monitoring and alerts](monitoring.md): maintenance windows, which are not containment.
- [Approved actions](approved-actions.md), [Staged patching](staged-patching.md), [Update signing](update-signing.md).
