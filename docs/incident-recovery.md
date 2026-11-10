# Incident recovery

What to do, in order, when something has gone wrong. Each section starts with **stop the bleeding**, then
**preserve evidence**, then **recover**. The tools are described in [Containment](containment.md).

Keep this page, the release-machine instructions and the audit checkpoint **public key** somewhere that doesn't
depend on the portal being up.

## First five minutes, whatever it is

1. **Pause.** Settings → Security → Containment → *Every business*, or the affected business, with every kind
   ticked. If you can't sign in, use the host CLI or the signer CLI (below).
2. **Write down the time** and what you saw. That note is evidence too.
3. **Don't restore, rebuild or delete anything yet.** A restore overwrites the evidence you are about to need.

## A technician account may be compromised

- Suspend the businesses that technician can reach, or set a global pause covering **remote connections** and
  **approved actions**.
- Remove the technician's assignments (Technicians), and end their sessions (Access review → sign out).
- Look at the audit log for that user since the suspected time. Then run `rem0te-audit verify`, so you know the
  record you are reading is intact.
- Lift the pause from a **second** account once access is removed and reviewed.

## The portal or its database may be compromised

Assume the portal will ignore its own pause and may lie on screen.

1. **The signer.** On the approval-signer host, as its operator:
   ```bash
   sudo -u rem0te-approver env APPROVAL_SIGNER_DIR=/var/lib/rem0te-approver node /opt/rem0te-approver/dist/approval-signer/main.js pause set --global --reason 'portal compromise suspected'
   ```
   Nothing new is approved or signed from then on.
2. **The agents.** On the release machine, publish a signed pause and sync the repository:
   ```bash
   rem0te-release pause-file -out pause.json -reason 'Incident: portal compromise suspected' -actions -updates
   rem0te-release release -repo repo -targets-key … -snapshot-key … -timestamp-key … -add control/pause.json=pause.json
   ```
   Agents now refuse approved actions and the update command, whatever the portal delivers. If the portal
   withholds the new metadata, agents fall back to refusing everything once the signed timestamp expires.
3. **Remote access.** RustDesk connections don't go through the approval signer. If you need to stop them
   independently of the portal, stop `hbbs`/`hbbr` on the relay host. That stops all remote connections,
   good and bad.
4. **Evidence.** Before touching the database:
   ```bash
   sudo rem0te-backup /var/backups/rem0te/incident-$(date +%Y%m%d-%H%M).tar.gz
   sudo bash -c 'set -a; . /etc/reboot-remote/api.env; set +a; cd /opt/reboot-remote/api && \
     node dist/cli/rem0te-audit.js verify --export /path/to/offhost/export.ndjson --pub /path/to/audit-checkpoint.pub' | tee verify.txt
   ```
   Use the **off-host** copy of the export, and a public key that was never on the portal host. Differences tell
   you which entries were changed or removed, and from which sequence number.
5. **Recover** onto a clean host (below), rotate secrets, then lift the layers in reverse: the portal, then the
   signer, then publish `pause-file -none`.

## Rotating secrets after a compromise

| Secret | Where | Effect of rotating |
|---|---|---|
| `JWT_SECRET`, `LAUNCHER_TOKEN_SECRET` | `/etc/reboot-remote/api.env` | Everyone is signed out; outstanding launcher links stop working |
| `ENCRYPTION_KEY` | `api.env` | Stored RustDesk passwords become unreadable. Re-key them (rotate the endpoint passwords), don't just change it |
| `HEALTH_TOKEN`, `AUDIT_EXPORT_TOKEN` | `api.env`, and the monitor / sink | Update both ends |
| Audit checkpoint key | `AUDIT_CHECKPOINT_KEY_FILE` | `rem0te-audit keygen` a new one and keep its public key. Old checkpoints stay verifiable with the old public key |
| Integration keys | `INTEGRATION_PEERS_FILE` and ClientSt0r | See [ClientSt0r integration](integration-clientst0r.md) |
| Release keys | Release machine | Only if the release machine itself is suspected: [Update signing → Rotating keys](update-signing.md#rotating-keys) |
| Approval signer key | Signer host | Only if the signer host is suspected: generate a new key and publish a new `approval/keys.json` |

The portal holds neither the release keys nor the approval key, so a portal compromise alone does not require
rotating them.

## Restoring from backup

```bash
sudo rem0te-restore /var/backups/rem0te/rem0te-YYYYMMDD-HHMMSS.tar.gz --i-mean-it
```

Then, **before** reopening:

1. Run `rem0te-audit verify --export <off-host export> --pub <public key>`. A restore always rolls the chain back
   to the backup's time. Everything up to that point must match the export exactly. The export then holds
   entries the database no longer has (reported as `deleted`), and they are the record of what happened between
   the backup and the restore. Keep that export.
2. The sealer carries on from the restored head. New entries extend the restored chain, so the export sink sees a
   second branch from that sequence number on. Start a new export file at restore time, and keep the old one.
3. Re-sync the signed update repository from the release machine. Repository state is never restored from a portal
   backup ([Update signing → Recovery](update-signing.md#recovery)).
4. Reapply migrations if the backup is from an older version, then regenerate the Prisma client at the deploy
   target (see `CLAUDE.md` → Deploying).

## The portal is down (not compromised)

- RustDesk connections that are already open keep working. New ones need the portal.
- Agents keep running, and they don't update while they can't reach the signed repository.
- `/api/v1/healthz` and `rem0te-external-check.py` tell you which part is down: the API, the database, the signer
  or hbbs.
- Approved plans already delivered still finish. Nothing new is approved until the portal and signer are both up.

## The audit chain reports a break

`AUDIT CHAIN BROKEN … at seq N` in the API log, an `AUDIT_CHAIN_ALERT` entry, or Containment → Audit log integrity
shows **Broken**.

1. Don't "fix" it. There is nothing to repair, and the break is the evidence.
2. Run `rem0te-audit verify --export …` and keep the output.
3. `deleted` means entries are missing. `altered` means an entry no longer matches its hash. `reference_changed`
   means a business or user id was changed rather than cleared. Treat any of them as a database compromise
   (above), unless you can show it was a restore. On a test database, test clean-ups that delete audit rows
   produce exactly this. Never run them against production.

## See also

[Containment](containment.md) · [Update signing](update-signing.md) · [Approved actions](approved-actions.md) ·
[Setup](setup.md) · [Troubleshooting](troubleshooting.md)
