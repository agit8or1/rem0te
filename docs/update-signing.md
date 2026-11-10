# Update signing

From 0.24, a Windows agent runs only code that was signed **offline**, by keys this portal never holds. The portal
becomes a mirror: it serves the signed files, and each agent checks them against a root of trust compiled into
the agent itself. If someone takes over the portal or its database, they can delay updates. They can't make an
agent install a replacement, roll it back to an older build, or point it at a different relay.

This page covers what that does and doesn't protect, how to set it up, how to ship a release, how to move existing
agents onto it, and what to do when something goes wrong.

> **Status.** The chain is **fixture-tested**: Go tests drive the real release tool and the real
> [go-tuf](https://github.com/theupdateframework/go-tuf) client through each attack, and an end-to-end suite runs the
> portal's mirror and containment against a scratch API. The signed installer script is checked with real
> PowerShell, but only for parsing and for its parameter block. **It hasn't been run end to end on Windows, in a lab
> or in production.** Treat the first rollout as a pilot: one lab machine, then a canary group.

## The short version

| Before 0.24 | With the signed chain |
|---|---|
| The heartbeat runs `irm https://<portal>/…/windows.ps1 \| iex` as SYSTEM whenever the portal asks. | The heartbeat runs `rem0te-agent.exe update`. It runs only files listed in signed metadata. |
| The installer script is generated per request, with the portal's values baked in. | One static `windows/install.ps1` per release, signed. The portal supplies only a parameters file of data, and every field in it is validated. |
| The RustDesk digest comes from the portal, in the same response as the code that checks it. | The digest comes from signed metadata. The build itself is a signed target. |
| A lower pinned version reinstalls an older client. | A downgrade is refused unless the release signer marked that build `allowDowngrade`. |
| The portal can change the relay host and key on any reinstall. | An installed agent keeps the relay it pinned at install. A request to change it is reported, never applied. |

## What it protects, and what it doesn't

**A compromised portal or database alone can't:**
- install a replacement agent, installer or RustDesk build on a signed agent;
- roll a signed agent back to older metadata or an older RustDesk build;
- mix files from different releases;
- repoint an installed agent at another relay;
- re-enable the legacy path without a second person approving it (see *Containment*).

**It still can:**
- **Withhold updates.** It can stop serving the repository, or serve stale copies until they expire: the timestamp
  lasts 7 days, the snapshot 30, targets 90 and root 365. After that, every agent refuses rather than keeps going.
- **Tamper with a first download.** The portal serves the installer `.exe`, and nothing outside the binary vouches
  for it yet: no Authenticode signature. For an independent first install, use the official release binary through
  GPO or Intune (see *Moving existing agents*).
- **Control legacy agents.** Agents that haven't migrated still trust the portal completely, as they always have.
  Signed-only mode stops the portal handing them code, but a compromised portal can loosen that mode only if a second
  person approves.
- **Change customer policy in the database.** Policy isn't signed. This chain covers executable code only.

**Not covered yet:**
- Linux and macOS installers;
- the technician-side Connect script;
- Authenticode signing;
- CI provenance for release artifacts;
- hardware-backed keys.

## Roles and keys

The chain is a standard [TUF](https://theupdateframework.io) repository with consistent snapshots and four roles:

| Role | Signs | Where its key lives | If the key is stolen |
|---|---|---|---|
| **root** (2 of 3) | Which keys may sign everything, itself included | Offline: three separate media, three separate people | One key is useless. With two, rotate root at once. |
| **targets** | Which files exist, and their digests. This is the release-signing key | Offline release machine | The thief can sign releases. Rotate it through root, which needs 2 of 3. |
| **snapshot** | A consistent set of targets versions | Release machine | On its own it can't add a file |
| **timestamp** | Freshness only | A small signer host, run on a schedule. Not the portal | Can freeze agents on metadata they've already accepted. Can't install anything. |

Every role must have its own key, and the tool refuses a key reused across roles.

**Signing that approves a job,** such as a fix that changes something on an endpoint, is a different key hierarchy. It
belongs to a later milestone and never appears in this repository. **Portal administration,** meaning sessions and
passkeys, can't sign anything at all.

## Setting up (once)

Build the release tool on the release machine:

```bash
cd tools/windows-installer
go build -trimpath -o rem0te-release ./cmd/rem0te-release
```

1. Generate the keys. Write each one straight onto the medium it will live on. Files are created with mode 0600 and
   are never overwritten.

   ```bash
   ./rem0te-release keygen -out /media/root-a/root1.pem
   ./rem0te-release keygen -out /media/root-b/root2.pem
   ./rem0te-release keygen -out /media/root-c/root3.pem
   ./rem0te-release keygen -out ~/keys/targets.pem
   ./rem0te-release keygen -out ~/keys/snapshot.pem
   ./rem0te-release keygen -out ~/keys/timestamp.pem
   ```

2. Create the repository:

   ```bash
   ./rem0te-release init -repo ~/rem0te-repo \
     -root-key /media/root-a/root1.pem -root-key /media/root-b/root2.pem -root-key /media/root-c/root3.pem \
     -root-threshold 2 -targets-key ~/keys/targets.pem \
     -snapshot-key ~/keys/snapshot.pem -timestamp-key ~/keys/timestamp.pem
   ```

3. **Pin the root in the agent.** Copy `~/rem0te-repo/metadata/1.root.json` to
   `tools/windows-installer/trustroot/root.json` and commit it.
   - That file is the root of trust: every agent built from then on trusts only this chain.
   - The placeholder `{}` in the repository marks a CI or development build. Those keep today's legacy behaviour and
     say so when they run.

## Shipping a release

Run these on the release machine, from the release tag.

1. **Build the agent and the installer script:**

   ```bash
   cd tools/windows-installer
   GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o ~/release/rem0te-agent.exe .
   cd ../../apps/api && npx nest build
   node scripts/build-signed-installer.mjs --out ~/release/install.ps1   # prints its SHA-256
   ```

   The script is deterministic. Anyone can rebuild it from the tag and compare its digest with the one in the signed
   metadata.

2. **Add a RustDesk build.** Download it from RustDesk's GitHub release, check it against the digest GitHub publishes,
   and add it under its exact name.

3. **Sign the release.** This command handles both steps:

   ```bash
   ./rem0te-release release -repo ~/rem0te-repo \
     -targets-key ~/keys/targets.pem -snapshot-key ~/keys/snapshot.pem -timestamp-key ~/keys/timestamp.pem \
     -add windows/rem0te-agent.exe=$HOME/release/rem0te-agent.exe \
     -add windows/install.ps1=$HOME/release/install.ps1 \
     -add windows/rustdesk/rustdesk-1.4.6-x86_64.exe=$HOME/release/rustdesk-1.4.6-x86_64.exe \
     -custom 'windows/rustdesk/rustdesk-1.4.6-x86_64.exe={"version":"1.4.6"}'
   ```

   - To withdraw a build, use `-remove <name>`. Agents can't install a target that isn't listed.
   - To allow rolling back to a build, sign it with `-custom '<name>={"allowDowngrade":true}'`.

4. **Check and publish:**

   ```bash
   ./rem0te-release verify -repo ~/rem0te-repo -trusted-root ~/rem0te-repo/metadata/1.root.json
   rsync -a --delete ~/rem0te-repo/metadata ~/rem0te-repo/targets portal:/var/lib/rem0te-updates/
   ./rem0te-release verify -trusted-root ~/rem0te-repo/metadata/1.root.json \
     -mirror https://remote.example.com/api/v1/public/updates
   ```

   `verify` runs the same client the agents run. The `-mirror` form checks what the portal actually serves.

**Keep the timestamp fresh.** It expires after 7 days. Run `rem0te-release refresh -repo … -timestamp-key …` at least
every 3 days on the signer host, then sync. If it lapses, every agent refuses updates, which is the intended failure
mode. Settings → Security → Update Signing warns 48 hours before any role expires.

## Portal configuration

Add the repository location to `/etc/reboot-remote/api.env`, then restart the API:

```bash
UPDATE_REPO_DIR=/var/lib/rem0te-updates     # contains metadata/ and targets/
```

The portal then:
- serves the repository at `/api/v1/public/updates/metadata/*` and `/api/v1/public/updates/targets/*`;
- refuses any path that leaves the directory, symlinks included;
- serves `timestamp.json` with `Cache-Control: no-store`;
- serves the signed agent as the Windows download;
- answers `/api/v1/public/install/windows-params.json`, which is data only and offers only RustDesk builds the
  release signer published.

It never signs anything; there is no key on the host for it to use.

## Containment of the legacy path

Settings → Security → Update Signing has two settings:

| Setting | Legacy agents | `windows.ps1` | Changing it |
|---|---|---|---|
| **Legacy allowed** (default) | Behave as before | The legacy installer | Moving here from *signed only* needs review |
| **Signed only** | Get no reinstall or update trigger from the heartbeat | A refusal that runs nothing | Takes effect at once |
| **Signed only + portal migration** | Get the reinstall trigger only | A short script that downloads the signed agent, checks it against the digest the portal pins, and runs `migrate` | Turning portal migration on needs review |

Notes on these settings:
- Review means the same independent review as Technician Access: someone other than the requester approves, and both
  need a fresh sign-in.
- *Signed only* is refused while no repository is configured.
- While legacy agents are contained, staged rollouts aimed at them don't progress.
- The **Windows agents** table on the same page lists every legacy agent, and every signed agent still behind the
  current root. The channel is self-reported, and it only ever reduces what the portal hands an agent.

## Moving existing agents

Each method below keeps the machine's enrollment, its device secret (`heartbeat.dat`), the RustDesk configuration
and password, and the scheduled tasks. Migration re-runs the same installer body that every legacy update already
runs. The difference is that this copy is signed and receives its values as a parameters file.

**GPO or Intune (independent of the portal).** Distribute the official `rem0te-agent.exe` from the GitHub release,
after checking its SHA-256 against the release notes, and run it elevated:

```powershell
& "\\fileserver\rem0te\rem0te-agent.exe" migrate --portal remote.example.com
```

- It pins the relay the machine already uses, read from `heartbeat.dat` and the RustDesk service profile. Migration
  can't be used to repoint a machine.
- For a new machine, use `install --portal <host> --token <claim token>` instead.

**Locally:** run the same command from an elevated prompt.

**Through the portal:** use *Signed only + portal migration*.
- That one run trusts the portal, exactly as every legacy run already does.
- Use it when GPO or Intune isn't available, and only while you trust the portal.

To check a machine afterwards, run `rem0te-agent.exe status`. It prints the pin, the trust-root version and the
result of the last update.

## Rotating keys

**Root or another role's key** is rotated with `rotate-root`. It needs a threshold of the current root keys, and
writes root version N+1 signed by both the old and the new key sets. Agents follow the rotation at their next
refresh.

```bash
# replace the targets key (the root holders never touch the targets private key)
./rem0te-release pubkey -key ~/keys/targets2.pem -out targets2.pub.pem
./rem0te-release rotate-root -repo ~/rem0te-repo -old-root-key /media/root-a/root1.pem -old-root-key /media/root-b/root2.pem \
  -replace targets=targets2.pub.pem
./rem0te-release release -repo ~/rem0te-repo -targets-key ~/keys/targets2.pem -snapshot-key … -timestamp-key …
```

**New root keys:** pass every one with `-new-root-key`, and optionally a new `-threshold`.

**A compromised targets or timestamp key:** rotate it as above, then release.

**One root key lost:** rotate it out using the other two.

**Two root keys lost or stolen:** the chain can't be rotated. Build agents with a new root and migrate every machine
through GPO, Intune or locally.

The Go tests rehearse:
- two rotations in a row, including a targets-key replacement;
- an agent that ships with root v1 and walks to v3;
- an under-signed rotation, refused by both the tool and the client;
- a replaced binary carrying an older embedded root, which doesn't make the machine forget a rotation it already
  followed.

## Publishing a signed pause

From 0.28 the repository can carry `control/pause.json`, a pause signed with the same targets key as everything
else. Agents on a 0.28+ signed build read it from the signed targets and **refuse approved actions** for the businesses
or computers it names, and optionally **refuse the update command** everywhere. The portal mirrors it like any
target, so it cannot forge, alter or quietly drop it. It is the containment layer that holds when the portal itself
may be compromised. See [Containment](containment.md).

```bash
# pause approved actions for one business (repeat -business / -computer as needed), or -actions for all
rem0te-release pause-file -out pause.json -reason 'Incident 7: approvals under review' -business <businessId>
# stop the update command on every computer too
rem0te-release pause-file -out pause.json -reason 'Incident 7' -actions -updates
rem0te-release release -repo repo -targets-key targets.pem -snapshot-key snapshot.pem -timestamp-key timestamp.pem \
  -add control/pause.json=pause.json
# lift it: publish one that pauses nothing
rem0te-release pause-file -out pause.json -none
```

`release` refuses a `control/pause.json` that does not parse as `rem0te-pause/1`. An agent that sees it listed but
can't fetch or parse it treats every action and the update command as paused. Withholding a *newer* pause only works
until the signed timestamp expires (7 days by default), after which agents refuse the repository altogether. An
update pause can't be narrowed to a business: the update command runs before the agent knows which business it serves.

## Recovery

| Symptom | Cause | Fix |
|---|---|---|
| Every signed agent logs `signed metadata refused … expired` | The timestamp (or another role) expired | Run `refresh` (add `-snapshot-key` if the snapshot expired too), or a `release`, then sync |
| `… bad version number … must be >= N` | The mirror serves older metadata than agents have already seen: a restored backup, or a rollback attempt | Sync the current repository. Never restore old metadata over new |
| `RustDesk X is not a signed release` | The pin or rollout names a build that isn't in targets | Sign that build, or change the pin |
| `… older than installed … not signed as a permitted rollback` | A downgrade was requested | Sign the build with `allowDowngrade`, or don't downgrade |
| `no relay pin on this machine` | `update` ran on a machine that never migrated | Run `migrate` locally or through GPO/Intune |
| Agent `status` shows `relayChangeRequested: true` | The portal's relay settings differ from the machine's pin | Expected after a deliberate relay move: re-pin with `migrate` locally. Otherwise investigate |

After restoring the **portal** from backup, re-sync the repository from the release machine. Repository state is
never restored from a portal backup.

## See also

- [updates.md](updates.md): staged rollouts and the RustDesk pin
- [architecture.md](architecture.md)
- [troubleshooting.md](troubleshooting.md)
