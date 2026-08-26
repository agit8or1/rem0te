# Updates

Rem0te has three independent things that can be out of date. They are updated
separately, from different places, and confusing them wastes time.

| What | Where | Restart blast radius |
|---|---|---|
| **Rem0te itself** | Updates page → *Check for updates* | API + web restart; sessions in flight are unaffected |
| **RustDesk clients on endpoints** | Updates → *RustDesk Clients* | Per-endpoint, applied on its next heartbeat |
| **RustDesk server (hbbs/hbbr)** | Updates → *RustDesk Server* | **Every endpoint reads offline for ~30s** |

All three live at **/about** in the UI, reachable from the sidebar as
**Updates** (Platform Admin only).

---

## Rem0te itself

*Check for updates* compares `version.json` against the latest GitHub release,
shows the changelog, and runs the update: fetch, build, deploy, restart.

This requires `SOURCE_DIR` to point at a git checkout of the repo. The deploy
target (`/opt/reboot-remote`) is deliberately **not** a git repository — the
updater used to run `git fetch` there and fail on its first step with a bare
"not a git repository", which read like a bug rather than missing
configuration. Unset, it now says exactly that instead of failing halfway.

Deploys add hashed client chunks rather than replacing them. Next.js requests
chunks by content hash, so deleting the previous build's files 404s any browser
that already had the app open — which surfaced as random reloads and
mid-login bounces back to `/login`. Old files go unreferenced; prune them in a
maintenance window, not during a deploy.

---

## RustDesk clients on endpoints

**Updates → RustDesk Clients** lists every managed endpoint with its installed
RustDesk version against the latest release, and stages upgrades per machine or
for everything that is behind.

### How staging works

There is no push channel to an endpoint, and inventing one would mean a second
protocol to secure. This reuses the credential-rotation channel already in
place:

1. You stage an upgrade. The endpoint's record gets a target version.
2. On its next heartbeat (~3 minutes) the endpoint is told to re-run the
   installer, which is idempotent and pins the version this server serves.
3. The endpoint reports its version on the following heartbeat. When it matches
   the target, the staging clears.

Consequences worth knowing:

- **A failed install retries rather than being lost** — the target stays set
  until the endpoint actually reports that version.
- **An endpoint will not reinstall more than once every 30 minutes.** Without
  that floor, any install that did not land on exactly the target version
  became a ~40 MB download every three minutes, indefinitely.
- **Endpoints that have never reported a version show as *Unknown*, not
  *Outdated*.** Flagging every pre-v0.8.2 machine as out of date would be pure
  noise.

### The pre-v0.8.2 trap

Only installers from v0.8.2 onward report a RustDesk version, *and* only those
understand the staged-upgrade instruction in the heartbeat response. An older
endpoint can therefore be staged for an upgrade it will never apply, and the
staging will never clear.

Those machines need the installer re-run by hand — which they need anyway, for
the service-config fix in v0.8.2. See [clients.md](clients.md#managed-installer--rem0te--enroll-computer).

---

## RustDesk server — hbbs and hbbr

**Updates → RustDesk Server** shows the installed version of each binary
against the latest `rustdesk-server` release, and upgrades both in place.

### Why this exists

`install.sh` originally installed hbbs only when none was present. Re-running
it reported "already installed" and left whatever version first landed —
forever. A deployment could sit two releases behind with nothing anywhere
surfacing the fact. That is how the WebSocket routes shipped in v0.8.2 came to
be dead on arrival: 1.1.15 accepts the upgrade on `/ws/id` and immediately
drops the connection, and nothing said the server was old.

`install.sh` now converges to the latest release on every run, and the Updates
page can do it without shell access.

### What the upgrade does

1. Downloads the `hbbs` and `hbbr` `.deb` pair for the latest release to
   `/var/lib/reboot-remote/rustdesk-server/`
2. `dpkg -i` both in **one call**, so a half-failed install cannot leave the
   two binaries on different versions
3. Restarts `rustdesk-hbbs` and `rustdesk-hbbr`

Privileges come from two fixed-path rules in `/etc/sudoers.d/reboot-remote` —
no wildcards, so `dpkg` cannot be steered at any other package.

The systemd drop-ins that pass `-k _` are **not** disturbed. They are drop-ins
precisely because the `rustdesk-server` package owns those unit files and an
in-place edit is silently reverted on upgrade, which would reopen registration
and the relay to anyone who found the host.

### The restart window

> hbbs holds its online-peer map **in memory only**. Restarting it empties that
> map, and every endpoint reads as offline until it re-registers — about 30
> seconds. A Connect attempted inside that window fails with *"the target
> device is offline or does not exist"* and looks exactly like a broken
> endpoint.

Do not upgrade mid-session. After upgrading, wait half a minute before
believing anything the online dots tell you, and confirm with:

```bash
sudo deploy/scripts/hbbs-probe.py <rustdesk-id>
```

### Version floor worth knowing

**1.1.16** is the minimum for RustDesk over WebSocket on 443. The Updates page
flags anything older with *No WebSocket support*, because the failure mode is
otherwise invisible — the routes answer, then hang up.

### By hand

```bash
V=1.1.16
ARCH=amd64   # arm64 on ARM hosts
cd /tmp
wget -q "https://github.com/rustdesk/rustdesk-server/releases/download/$V/rustdesk-server-hbbs_${V}_${ARCH}.deb"
wget -q "https://github.com/rustdesk/rustdesk-server/releases/download/$V/rustdesk-server-hbbr_${V}_${ARCH}.deb"
sudo dpkg -i rustdesk-server-hbbs_${V}_${ARCH}.deb rustdesk-server-hbbr_${V}_${ARCH}.deb
sudo systemctl restart rustdesk-hbbs rustdesk-hbbr
hbbs --version && hbbr --version
```

Back up `/var/lib/rustdesk-server/` first — it holds the server keypair and the
peer database. Losing `id_ed25519` invalidates every configured client.

---

## See also

- [clients.md](clients.md) — which client is which
- [connecting.md](connecting.md) — the connect paths and their failure modes
- [setup.md](setup.md) — installation and operations
