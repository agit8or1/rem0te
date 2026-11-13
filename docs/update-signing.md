# Update signing

From 0.24, a Windows agent runs only code signed by keys the portal application never holds. The portal
becomes a mirror: it serves the signed files, and each agent checks them against a root of trust compiled into
the agent itself. If someone takes over the portal or its database, they can delay updates. They can't make an
agent install a replacement, roll it back to an older build, or point it at a different relay.

This page covers what that does and doesn't protect, how to set it up, how to ship a release, how to move existing
agents onto it, and what to do when something goes wrong. There are two ways to hold the keys:
- **The easy way (0.37):** on the portal host itself, under a separate system user that the portal can't read. It
  takes one setup command and one publish command per release.
- **The stricter way:** an offline release machine.

> **Status.** The chain is **fixture-tested**: Go tests drive the real release tool and the real
> [go-tuf](https://github.com/theupdateframework/go-tuf) client through each attack, and an end-to-end suite runs the
> portal's mirror and containment against a scratch API. The signed installer script is checked with real
> PowerShell, but only for parsing and for its parameter block. **It hasn't been run end to end on Windows, in a lab
> or in production.** Treat the first rollout as a pilot: one lab machine, then a canary group.

## The easy way (single host, 0.37)

Four commands on the portal host. Run the first from the source checkout you deploy from:

```bash
sudo ./deploy/release/rem0te-signed-setup.sh --apply-env    # once
sudo systemctl restart reboot-remote-api                     # once, to pick up UPDATE_REPO_DIR
sudo rem0te-signed-export-root /media/usb-stick              # once, right after setup
sudo rem0te-signed-publish                                   # every release: the last step of every deploy
sudo rem0te-signed-status                                    # any time
```

Setup runs the first publish itself, but the portal doesn't see the repository until the API restarts with
`UPDATE_REPO_DIR` set (`--apply-env` adds it to `/etc/reboot-remote/api.env`; without it, setup prints the line to
add). **Within a minute of that restart the automatic migration asks its first computer, the canary**, because it is
on by default ([Moving computers automatically](#moving-computers-automatically-037)). To hold it, turn it off on
**Devices → Full agent** before the restart, or put `AUTO_MIGRATION_SWEEP=off` in `api.env`. To move computers by
hand instead, see [Moving existing agents](#moving-existing-agents).

### What each command does

**`rem0te-signed-setup.sh`** (once; safe to run again):
- creates the system user `rem0te-release` (no login shell) and its state directory `/var/lib/rem0te-release`, mode
  0700. That holds `keys/`, the signing repository, a RustDesk download cache and `publish.log`;
- creates the published repository `/var/lib/rem0te-updates`, owned by `rem0te-release` with group `reboot`.
  Directories are 2750 and files 0640: the portal can read it and can't write to it;
- builds `rem0te-release` from `git archive HEAD` and installs it, with the commands below, under `/usr/local`;
- as `rem0te-release`, with umask 077, generates three root keys (threshold 2 of 3) and the targets, snapshot and
  timestamp keys, then creates the repository. It prints key ids, never keys. It never overwrites a key: on a second
  run it sees the keys and generates none, and it refuses to go on if only some of them are there;
- checks that the `reboot` user can't read any key;
- installs `rem0te-timestamp-refresh.timer` (daily);
- prints the `UPDATE_REPO_DIR=/var/lib/rem0te-updates` line for `/etc/reboot-remote/api.env`. With `--apply-env` it
  adds the line itself;
- runs the first publish.

**`rem0te-signed-publish`** (each release):
1. Unpacks `git archive HEAD` of the checkout into a new build directory owned by `rem0te-release`. It never copies
   the working tree, so uncommitted edits are never signed.
2. Writes the owner's root (`metadata/1.root.json`) into **that copy's** `trustroot/root.json`. The checkout keeps its
   `{}` placeholder, and the command refuses to run if the checkout's copy, or the one in `HEAD`, is anything else.
3. Builds `rem0te-agent.exe` and `rem0te-tray.exe` (windows/amd64, `-trimpath`, the tray with `-H=windowsgui`) and
   checks that the agent embeds the root.
4. Builds `windows/install.ps1` with `apps/api/scripts/build-signed-installer.mjs --from-source`, from the archive,
   as the checkout's owner. It produces the same bytes as a build from `dist`.
5. Fetches the RustDesk build the portal pins (Updates page), or the latest release when nothing is pinned. It checks
   the build against the SHA-256 GitHub publishes for it and caches it. A build without a published digest, or one
   that doesn't match, is refused. `--rustdesk-version X.Y.Z` picks one explicitly.
6. Signs a copy of the signing repository. The agent and tray targets carry `{"version","commit"}`: the version from
   `version.json` and the 40-character commit. It then verifies the copy with `rem0te-release verify`, the client the
   agents run.
7. Publishes. The repository is copied to a staging directory beside `/var/lib/rem0te-updates` and verified again
   there, then moved in by renames only, `timestamp.json` last. Until that last rename an agent sees the previous
   release, complete; after it, the new one. A staging copy that fails verification is deleted and nothing is
   replaced. Target files that the two newest targets versions no longer list are removed afterwards.

It refuses to publish:
- a version older than the one published;
- a different commit under the same version (every change bumps the version);
- the same version and commit again, which is a no-op unless you pass `--republish`. Use that, for example, to add a
  newly pinned RustDesk build without a new release.

Everything it prints also goes to `/var/lib/rem0te-release/publish.log`.

**`rem0te-signed-status`**: one screen showing:
- which keys are present, and whether the root keys are still on the host or were exported;
- the published agent version and commit, the tray, the installer and the RustDesk builds;
- when each role expires, with a warning under 48 hours;
- the last publish, whether the timer is active, and whether `api.env` has `UPDATE_REPO_DIR`.

It exits 1 when something needs attention.

**`rem0te-signed-export-root <dir>`** copies `root1.pem` … `root3.pem` to the directory, for example a USB stick, and
checks each copy byte for byte. It deletes them from the host only after you type `yes`. Better: give it three
directories (`DIR1 DIR2 DIR3`) to put one key on each of three sticks, and keep them apart. It refuses a directory
inside the checkout, any git work tree, the state directory or the published repository. Publishing and the daily
timestamp don't need the root keys. You bring two back only to rotate a key, or to re-sign the root before it expires
(365 days; *status* warns 30 days ahead).

**The timer**, `rem0te-timestamp-refresh.timer`, runs `rem0te-signed-refresh` daily as `rem0te-release`, with no
network access and no access to the portal's configuration. It re-signs the timestamp, which lasts 7 days, and
publishes it through the same staged, verified path, so `timestamp.json` is the only file that changes. It also
re-signs the snapshot when it has under 10 days left, and re-signs unchanged targets when they have under 14 days
left. A release normally does that long before.

**After pulling a new version of rem0te**, run `sudo ./deploy/release/rem0te-signed-setup.sh` again to update the
installed commands. It changes no key. `rem0te-signed-publish` always builds the release tool it signs with from the
same commit it publishes.

### The trade-off, stated plainly

This mode keeps the keys **on the portal host**, under a separate user. That is the same compromise these docs already
accept for the [approval signer](approved-actions.md) as a separate local user.

- **What it still protects.** The portal runs as `reboot` and can't read `/var/lib/rem0te-release`. Nothing in the API
  references that directory, loads a key or runs `rem0te-release` (`scripts/check-security-invariants.mjs` §56). So a
  compromise of the portal *application* can't sign anything: its code, its database, its web sessions. Agents still
  run only code signed by the owner's keys, exactly as in *What it protects* above.
- **What it gives up.** **Root on this host can sign.** Anyone who gets root on the portal host, or anyone you let
  `sudo`, can publish a release every signed agent will install. With an offline release machine, root on the portal
  host can only withhold updates.
- **Export the root keys.** Do it right after setup. Root on the host can then still sign releases with the targets
  key, but it can't rewrite the root of trust. After an incident you bring two root keys back, rotate the targets,
  snapshot and timestamp keys away from the host, and agents follow the rotation. If the root keys stayed on the
  host, a compromise could replace the root itself, and the only way back is to reinstall every agent.
- **What gets signed is what is committed.** `publish` builds `HEAD` of the checkout. Whoever can commit to that
  checkout, or to the branch you pull into it, chooses what the agents run. Review what you deploy.
- **Nothing goes to GitHub.** The owner's `root.json` is never committed. The tracked file stays `{}`, and `publish`
  refuses to run otherwise. No CI job builds, signs or publishes anything (§56 checks that nothing under `.github`
  names these scripts). Keys, metadata and builds stay on this host and in the directory you export to.

For the stronger arrangement, move the whole thing to a machine that isn't the portal. That is the stricter way below.

> **Not yet proven on Windows.** The single-host tooling is tested end to end in a temporary directory against a
> scratch API (`apps/api/scripts/e2e-signed-release.mjs`): setup, publish, the refusals, refresh and export. The
> portal then serves what the agents' own client accepts. The agent it builds has still never run on a real Windows
> machine; see *Status* above.

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

That table is the stricter way. With the easy way (0.37), every key starts in `/var/lib/rem0te-release/keys` on the
portal host, readable only by `rem0te-release`. The root keys then move to offline media with
`rem0te-signed-export-root`. The targets, snapshot and timestamp keys stay on the host so publishing and the daily
timestamp can run.

**Signing that approves a job,** such as a fix that changes something on an endpoint, is a different key hierarchy. It
belongs to a later milestone and never appears in this repository. **Portal administration,** meaning sessions and
passkeys, can't sign anything at all.

## The stricter way: an offline release machine

This is the arrangement the chain was designed for, and the one the rest of this page describes. The root keys sit
on separate offline media held by separate people. The targets and snapshot keys live on a release machine that isn't
the portal. The timestamp key lives on a small signer host. The portal only ever receives `metadata/` and `targets/`.

### Setting up (once)

The same steps `rem0te-signed-setup.sh` and `rem0te-signed-publish` automate, done by hand on a separate machine.
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

3. **Pin the root in the agent build.** Copy `~/rem0te-repo/metadata/1.root.json` to
   `tools/windows-installer/trustroot/root.json` **in the release machine's build copy only**.
   - That file is the root of trust: every agent built with it trusts only this chain.
   - **Never commit it.** The tracked file is the `{}` placeholder, which marks a CI or development build. Those keep
     today's legacy behaviour and say so when they run. `rem0te-signed-publish` refuses to run while the checkout's
     copy is anything else, and §56 of the invariant checks fails CI on a committed root.

### Shipping a release

Run these on the release machine, from the release tag.

1. **Build the agent and the installer script:**

   ```bash
   cd tools/windows-installer
   GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o ~/release/rem0te-agent.exe .
   GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-H=windowsgui -s -w" -o ~/release/rem0te-tray.exe ./cmd/rem0te-tray
   cd ../../apps/api && npx nest build
   node scripts/build-signed-installer.mjs --out ~/release/install.ps1   # prints its SHA-256
   ```

   The script is deterministic. Anyone can rebuild it from the tag and compare its digest with the one in the signed
   metadata.

   The tray (0.36, [tray.md](tray.md)) is a separate GUI executable: `-H=windowsgui` stops a console window
   appearing. It is **optional**. A release without it installs no tray, and the agent then reports no tray and no
   chat, so the portal says chat is unavailable instead of pretending.

2. **Add a RustDesk build.** Download it from RustDesk's GitHub release, check it against the digest GitHub publishes,
   and add it under its exact name.

3. **Sign the release.** This command handles both steps:

   ```bash
   ./rem0te-release release -repo ~/rem0te-repo \
     -targets-key ~/keys/targets.pem -snapshot-key ~/keys/snapshot.pem -timestamp-key ~/keys/timestamp.pem \
     -add windows/rem0te-agent.exe=$HOME/release/rem0te-agent.exe \
     -add windows/install.ps1=$HOME/release/install.ps1 \
     -add windows/rem0te-tray.exe=$HOME/release/rem0te-tray.exe \
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
every 3 days on the signer host, then sync. The easy way does this daily with `rem0te-timestamp-refresh.timer`. If it lapses, every agent refuses updates, which is the intended failure
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

It never signs anything, and nothing in the API can read a key. With the stricter way there is no key on the host at
all. With the easy way the keys are on the host but owned by `rem0te-release` in a 0700 directory, and the portal runs
as `reboot` (see *The trade-off* above).

## Containment of the legacy path

Settings → Security → Update Signing has two settings:

| Setting | Legacy agents | `windows.ps1` | Changing it |
|---|---|---|---|
| **Legacy allowed** (default) | Behave as before | The legacy installer | Moving here from *signed only* needs review |
| **Signed only** | Get no reinstall or update trigger from the heartbeat | A refusal that runs nothing | Takes effect at once |
| **Signed only + portal migration** | Get the reinstall trigger only | A short script that downloads the signed agent, checks it against the digest the portal pins, and runs `migrate` | Turning portal migration on needs review |

From 0.34 one computer can also be moved from the console (*Moving existing agents → One computer from the console*).
That is allowed in **Legacy allowed** and **Signed only + portal migration**, and refused in **Signed only**; it never
changes the mode.

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
after checking its SHA-256 against the release notes, and run it elevated. With the easy way (0.37) nothing is
published to GitHub. The file is in the published repository under its digest:
`/var/lib/rem0te-updates/targets/windows/<sha256>.rem0te-agent.exe`. `sudo rem0te-signed-status` prints that path, and
the file's own SHA-256 is its name.

```powershell
& "\\fileserver\rem0te\rem0te-agent.exe" migrate --portal remote.example.com
```

- It pins the relay the machine already uses, read from `heartbeat.dat` and the RustDesk service profile. Migration
  can't be used to repoint a machine.
- For a new machine, use `install --portal <host> --token <claim token>` instead.

**Locally:** run the same command from an elevated prompt.

**Through the portal, every legacy agent:** use *Signed only + portal migration*.
- That one run trusts the portal, exactly as every legacy run already does.
- Use it when GPO or Intune isn't available, and only while you trust the portal.

**Through the portal, one computer from the console (0.34).** Open the computer and press **Upgrade to full agent**
(the full agent is the signed agent), give a reason, and confirm it is you. From 0.37 the button sits at the top of
the computer's page, beside Connect, for anyone with *computers:edit*, as well as on the **Overview → Agent** card; the
**Agent out of date** chip opens it too. Both places use the same request, dialog, fresh sign-in and audit entry. On a
standard Windows agent it is always shown: when the server will not offer it (no signed release published, no device
secret, *Signed only*, updates paused, a rollout running) it is disabled, with the reason beside it, what to do, and a
link to **Devices → Full agent**. While a request is open it reads *Upgrade requested — waiting for check-in*. A signed
agent shows **Full agent** instead; Linux and macOS show the installer command to re-run on the computer. For several at
once, select them on **Devices → All devices** and use **Upgrade to full agent…** (at most 200 per request; each
computer is decided on its own and refused with its reason). Follow them on **Devices → Agent migrations**
(`/endpoints/agent-migrations`).

What happens:
- The request names that computer. Its next authenticated heartbeat — and no other computer's — is handed the
  reinstall flag with a one-off nonce (`mig_…`).
- The standard agent fetches `windows.ps1?updateNonce=<nonce>`. For an open request that serves the same migration
  script as *Signed only + portal migration*, pinned to the digest of `windows/rem0te-agent.exe` in the signed targets
  the portal serves **at that moment**. The script downloads that file, refuses it if the digest differs, and runs
  `migrate`, which keeps the enrolment, device secret and RustDesk configuration. It stages the binary in a new,
  randomly named directory locked to SYSTEM and Administrators.
- The request completes when the computer's heartbeat reports the signed channel. It is **held**, not handed out,
  while an `updates` containment pause applies, while a staged rollout owns the computer, if the portal is moved to
  **Signed only** in the meantime (the nonce then serves a script that runs nothing), or if no signed agent is
  published. A request handed out over two hours ago whose computer still reports the standard agent shows as **Not
  confirmed**: the standard agent doesn't report the script's exit code. From 0.34 its heartbeat does report what
  `rem0te-agent.exe` last wrote to `agent-status.json`, so a failed `migrate` shows its result on the card.
- An agent older than 0.20 ignores the nonce and simply reinstalls the current standard agent; the request stays open
  and the next attempt, 30 minutes later, migrates it.

The preconditions, each refused with its own reason: a signed repository is configured and lists the signed agent
(*No signed release is published …*); the computer is a Windows standard agent with a device secret, not archived;
the portal has an https public address or a relay host; the portal is not in **Signed only**; no `updates` pause
applies; no staged rollout is running on it. It needs **computers:edit** on that computer (the same as **Reinstall
agent**), a fresh sign-in, and a reason, which is audited (`AGENT_MIGRATION_REQUESTED`; also
`AGENT_MIGRATION_COMPLETED`, `AGENT_MIGRATION_CANCELLED`, and `DEVICE_BULK_ACTION` for a selection).

**Why this needs no second person, when turning on portal migration does.** A standard agent already trusts the
portal completely: anyone who can press *Reinstall agent* on it can make the portal run its installer there as
SYSTEM. Migrating that one computer is one more such run, of a fixed script whose only inputs are the portal's address
and the digest the offline-signed repository lists. It gives a compromised portal nothing it didn't already have
over that machine, and leaves the machine where the portal has *less* power: afterwards it runs only code signed by
keys the portal never holds. Turning on portal migration is different: it decides what **every** legacy agent is
handed, including ones nobody asked about, which is why it goes to review.

**Why it is refused in Signed only.** In that mode you have contained the legacy agents: the portal hands them nothing
to run. A per-computer migration is a portal-served script run on a legacy agent — exactly what the mode withholds,
and what turning on portal migration puts to review. Allowing it would let one person reopen, machine by machine, the
path the mode closed. In Signed only, migrate locally or through GPO/Intune, or ask for portal migration. That the
script itself is harmless today doesn't change this: what the mode contains is the legacy agent running whatever the
portal serves.

To check a machine afterwards, run `rem0te-agent.exe status`. It prints the pin, the trust-root version and the
result of the last update. From 0.34 the heartbeat also reports that last result and its time, and the computer's
**Agent** card shows them; signed builds published before 0.34 don't report it.

**Updating an agent that already runs.** The Agent card's **Update agent** re-runs the current standard installer on a
standard agent (the existing reinstall: same permission, same audit, refused under an `updates` pause and in Signed
only). On a signed agent the same button is **Check for update now**: the agent runs `rem0te-agent.exe update`, which
installs only what the signed repository lists. Linux and macOS agents act on nothing the portal sends, so the card
gives the command to re-run on the computer instead.

## Moving computers automatically (0.37)

From 0.37 the portal moves standard Windows agents to the signed agent by itself, once a signed agent is published.
**Devices → Full agent** (`/endpoints/full-agent`) shows the whole process as four steps, each with its live state and,
when it is not done, the command that does it:

1. **Signing set up on this server** — done when the portal has a signed repository (`UPDATE_REPO_DIR`). Otherwise:
   `sudo ./deploy/release/rem0te-signed-setup.sh`, once, from the source checkout (with `--apply-env` to add
   `UPDATE_REPO_DIR` to `api.env`), then restart the API. The step stays *not yet* until that restart.
2. **A signed agent is published** — the published agent's version and commit (from the signed target) against this
   portal's version. When it is behind: `sudo rem0te-signed-publish`.
3. **Timestamp kept fresh** — when the timestamp the portal serves expires, with a warning under 48 hours. The timer
   `rem0te-timestamp-refresh.timer` re-signs it daily, but the portal can't see that timer: the step reads only the
   expiry of what it serves, and says so. `sudo rem0te-signed-status` shows the timer itself.
4. **Computers moved** — how many of the computers you can see are standard, moving, signed, held (and why), or not
   eligible (Linux, macOS), the automatic migration's state, and a list with a link to each.

The page is under **Devices**, for anyone with **View computers**. Each computer's **Agent** card and **Settings →
Security → Update signing** link to it. Its counts come only from computers you can see; the repository, the mode and
the rollout's state are platform-wide. The canary is named only to people who can see it, and the fleet-wide progress
only to Platform Admins.

**How it moves them: canary first.** The automatic migration runs one rollout per published build:

- **One canary.** It picks one eligible computer that is checking in now, the most recently heard from, and makes an
  ordinary per-computer migration request for it. This is the same row, nonce, `windows.ps1?updateNonce=` script and
  heartbeat hand-out as **Upgrade to full agent** (see *Moving existing agents* above), made by the system with no
  requester.
- **Confirmed only on the published build.** The canary must report the signed channel *and* the published build's
  digest within 2 hours of being asked. A failed update result (`installer exit` other than 0, `installer failed`,
  `metadata-refused`), the request cancelled by a person, or no confirmation within 2 hours **halts** the rollout.
  The reason is kept and shown, and the canary's automatic request is stopped so a failing migration isn't re-run
  every 30 minutes.
- **A soak.** After confirmation the canary must keep reporting that build for the soak (default 60 minutes, 15–1440)
  with no failed update result, and check in once more after the soak ends. Anything else halts the rollout. Nothing
  else moves during the soak.
- **Then the rest, paced.** At most the automatic-update pace (Settings → Client updates, *per hour*, default 120)
  automatic requests start in any hour, counting the canary, and at most 50 in one pass. A computer is skipped while
  an `updates` containment pause applies, while a staged rollout owns it, while its update policy opts it out of
  automatic agent updates (agent mode *Off* on the business, site or device-group policy; in *Window* mode, outside
  the window), while it is not checking in, if a person cancelled a move for it, or for any reason **Upgrade to full
  agent** would refuse it. That last check is the same precondition function, run again when the request is written.
- **A new build** starts a new rollout with a new canary for the computers still on the standard agent. Computers
  already on the signed agent are never migrated again: they update themselves (0.36).
- **Halted** stays halted. A Platform Admin can **Resume**, which asks the same canary again with its clocks from now,
  or **Restart with another canary**. The old canary isn't picked again for that build. Neither skips the canary.

**Refused exactly as per-computer migration is.** In **Signed only**, with or without portal migration, the automatic
migration does nothing. Without portal migration, the portal hands standard agents nothing to run, which is what a
per-computer migration is refused for. With it, every standard agent is already handed the migration at each check-in.
Containment holds it at the request and again at the heartbeat. Nothing new runs on a computer, and nothing writes the
update-trust mode.

**Settings.** On the Full agent page, a Platform Admin can set the mode (`canary_then_all`, the default, or `off`) and the soak.
Turning it on, or shortening the soak, needs a fresh sign-in. Turning it off, or lengthening the soak, doesn't: stopping
must always be easy. Every change is audited with before and after (`AGENT_AUTO_MIGRATION_SETTINGS_CHANGED`). So are
the rollout's steps, as the system: `AGENT_AUTO_MIGRATION_CANARY_CHOSEN`, `…_CANARY_CONFIRMED`, `…_ROLLING`,
`…_HALTED`, and `…_RESUMED` / `…_RESTARTED` with the admin. The per-computer requests aren't audit entries. They are
`AgentMigration` rows marked automatic, shown on the Agent card, on **Agent migrations** and on the Full agent page,
like 0.36's automatic-update attempts. `AUTO_MIGRATION_SWEEP=off` stops the sweep in one API process, and every test
stack sets it. `AUTO_MIGRATION_SWEEP_SECONDS` (default 60) sets how often it runs.

**What has not been proven.** The signed agent and the tray have not run on real Windows. The first computer the
automatic migration moves is the first time, which is why the rest wait for it. Watch the canary's **Agent** card. If
the rollout halts, run `rem0te-agent.exe status` on the canary before resuming.

## Automatic update checks (0.36)

Until 0.36 a signed agent ran `rem0te-agent.exe update` only when a heartbeat
response carried `updateRustdesk` or `reinstallAgent` — when someone clicked
*Check for update now*, or a rollout asked. Nothing checked on a schedule,
whatever the Agent card's *Portal update mode* said (that is the portal's
Legacy allowed / Signed only setting: what it hands **standard** agents, not how
often a signed one checks).

From 0.36 two things ask, both through the same `update` code path, so both
are refused by the signed pause and install only what signed metadata lists:

- **The portal**, when the build a signed agent reports is not the one the
  repository publishes: automatic agent updates
  ([updates.md](updates.md#the-rem0te-agent-automatic-updates-036)) hand it
  `reinstallAgent`, paced and capped like a standard agent's. This works with
  signed agents already installed.
- **The agent itself**, about once a day (20 hours plus up to 8 hours of
  jitter, so a fleet does not check in the same minute), on a heartbeat where
  the portal sets `agentSelfCheck` — not opted out, inside a *window* policy's
  window, no updates pause, no rollout, no session. The schedule lives in
  `C:\ProgramData\Rem0te\update-check.next`; the first sighting only
  schedules, and a due time more than two days out (a clock that jumped) is
  rescheduled rather than acted on. This is in the signed `windows/install.ps1`
  that writes the heartbeat, so **it reaches a computer only after a signed
  release built from 0.36 is published with the owner's keys** and installed
  there. A compromised portal can withhold the permission (no worse than
  today) or grant it, which runs only signed code.

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
