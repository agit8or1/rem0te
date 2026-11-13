# Updates

Rem0te has three independent things that can be out of date. They are updated
separately, from different places, and confusing them wastes time.

| What | Where | Restart blast radius |
|---|---|---|
| **Rem0te itself** | Updates page → *Check for updates* | API + web restart; sessions in flight are unaffected |
| **RustDesk clients on endpoints** | Updates → *RustDesk Clients*, or automatically in a window: Settings → *Client updates* | Per-endpoint, applied on its next heartbeat (automatic ones only inside the business's update window) |
| **RustDesk server (hbbs/hbbr)** | Updates → *RustDesk Server* | **Every endpoint reads offline for ~30s** |

All three live at **/about** in the UI, reachable from the sidebar as
**Settings → Updates** (Platform Admin only). Automatic client updates are set
per business at **Settings → Client updates**, by that business's owner, a
technician with `computers:edit` over the whole business, or the MSP. The running version is also in the sidebar
footer and on the About page, for everyone signed in — "which version are you
on?" is the first question asked about every problem.

Two more things can be out of date and are **not** on that page. The **Rem0te
agent** on a managed computer keeps itself up to date (0.36, on by default — see
[The Rem0te agent: automatic updates](#the-rem0te-agent-automatic-updates-036)),
and can still be updated by hand from the computer's Agent card with *Update
agent* — staging a client upgrade will not do it, because that skips any
endpoint already on the latest client, which is usually most of them.
And **Windows updates pending on an endpoint**. Those belong to the machine, not to this
platform, and Rem0te reports them without installing them — see
[inventory.md](inventory.md).

![Updates](screenshots/updates-light.png)

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

### Automatic updates in a window (0.32)

Staging by hand applies on the next heartbeat, whatever the time. A business
can instead let the server do it, outside working hours:
**Settings → Client updates** (`/settings/client-updates`).

| Setting | Default | Meaning |
|---|---|---|
| On / off | **Off** | Nothing is queued automatically until it is turned on |
| Update window | — | Days of the week, a start and an end, in a stated IANA time zone (e.g. `Europe/London`). Up to 7 windows, each at least 30 minutes |
| Skip a computer with an open session | **On** | The install restarts RustDesk, which ends the session |
| Skip a computer with someone logged on | Off | When on, an agent that does not report who is logged on is skipped too — unknown is not "nobody" |

A **site** can have its own policy. It replaces the business policy for that
site's computers entirely, including being off when the business is on.

A **device group** (0.35) can have one too, with a **priority** (1 first). A
group policy beats a site override, which beats the business policy; a
computer in several groups with a policy follows the lowest number, and two
group policies of a business cannot share one. Membership is evaluated at each
decision — a computer that leaves a rule group follows its site or business
policy at the next sweep and heartbeat. Turning a group policy on, and
removing one, need fresh authentication, and a group that carries a policy
cannot be deleted. The **Device groups** card lists them in precedence order
with their current member counts; the **Policy** column of the Computers table
and the computer's own page say which policy governs each computer and why.
See [Device-group policies](group-policies.md).

![Settings → Client updates for one business: its policy, a site's override, a device-group policy and each computer's state](screenshots/guide/client-updates.png)

1. **Business** — the policy is per business.
2. **The sweep notice** — shown when this server has `CLIENT_UPDATE_SWEEP=off`: policies are saved, nothing is queued.
3. **The business policy** — on or off, the windows and their zone, the two skip rules.
4. **A site override** — replaces the business policy for that site's computers.
5. **A device-group policy** (0.35) — here Harbor's *Remote depots*, priority 10, updating nightly; it beats the site
   override and the business policy for its members (see [group-policies.md](group-policies.md)).
6. **Auto, waiting** — a computer the policy will update in its next window, with the reason it is held if one applies.
7. **Not automatic** — a computer no policy covers, or one whose policy is off.

**The window.** Same rules as every other weekly window in Rem0te
(`rbac/schedule.ts`): days are 0 = Sunday … 6 = Saturday, times are wall-clock
in the policy's zone, and an end earlier than the start crosses midnight and
belongs to the day it starts on (22:00–05:00 on Friday is Friday night into
Saturday). Daylight saving is never computed with local-time arithmetic, so
on a spring-forward night a window starting in the missing hour opens when
the clock reaches the next real time (02:30–05:00 in New York on 8 March opens
at 03:00 EDT), and on a fall-back night 01:00–02:00 covers both hours that
read 01:xx. The page shows when the window next opens and closes.

**The sweep** (`client-updates/client-update-sweep.service.ts`) runs every
`CLIENT_UPDATE_SWEEP_SECONDS` (default 120). For each enabled policy whose
window is open *now*, it queues that scope's computers through the same
`updateRequestedAt` path a click on Update uses, marked **POLICY**. A computer
is queued only if it is Windows, not archived, online, has a device secret,
has reported a RustDesk version older than the target (the version pin, else
the latest release), has nothing queued already, has no staged-rollout job
and — per the policy — no open session and nobody logged on. At most
`CLIENT_UPDATE_SWEEP_BATCH` (default 25) computers are queued per sweep, across
every business, so a fleet is spread over successive sweeps. Outside the
window it queues nothing. `CLIENT_UPDATE_SWEEP=off` turns it off in that
process; run scratch and capture APIs with it off, because it acts on every
enabled policy in the database.

**The heartbeat** hands a POLICY request out only inside the window, and,
when the policy says so, not during an open session (the endpoint's own
session count, a confirmed session, or a launch in the last two hours never
confirmed or closed — the same evidence staged rollouts use) or with someone
logged on. Otherwise it is withheld and the reason recorded, so the console
can say *auto, waiting for the window* or *waiting: a remote session is open*.

**A request made by hand still goes immediately.** Clicking Update marks it
**MANUAL**, with who clicked, and the next heartbeat carries it as before.
Clicking Update on a computer the policy queued turns it into a manual
request. The Updates page, the computer's page and Settings → Client updates
all say which kind each queued update is, and who queued a manual one.
Requests staged before 0.32 are recorded as manual.

**Turning a policy off withdraws** the POLICY requests it queued that have not
completed; manual requests are left alone. So does removing a site override
or a group policy when what governs those computers next is off.

**Every sweep re-checks what is queued (0.36).** Each POLICY request records
the policy that queued it. On every tick, before queuing anything, the sweep
works out which policy governs each queued computer *now* — group membership
as it is this tick — in every business, including one with no policy on and
one under an `updates` pause (withdrawing installs nothing):

| Now | What happens | Audit |
|---|---|---|
| the policy that queued it still governs it, and is on | nothing | — |
| another policy governs it, and is on (it left the group; its site's override applies; a higher-priority group policy now does) | the request stays, under that policy's window and conditions | `CLIENT_UPDATE_AUTO_REPLANNED` |
| nothing that is on governs it | the request is withdrawn | `CLIENT_UPDATE_AUTO_WITHDRAWN` |
| queued before 0.36 (no policy recorded) and a policy that is on governs it | that policy is recorded; nothing else changes | — |

Each entry records the reason — `no_longer_applies` (the policy is still
there and on, but no longer governs the computer), `policy_off`,
`policy_removed`, or `no_policy_recorded` — with the policy it came from and
the one it moved to. Before 0.36 only a policy save re-checked queued requests,
so a computer that left a group kept its request queued, held by the heartbeat
as *the update policy that queued it is now off*, until someone next saved a
policy in its business.

**Containment.** An `updates` pause (global, or for the business) stops the
sweep queuing anything there and the heartbeat handing anything out, as it
already did for manual requests and rollouts.

**Who can change a policy.** It makes the server re-run an installer on every
computer in the business without anyone clicking Update, so:

- a **Business Owner**, for their own business only;
- a **technician** whose assignment grants `computers:edit` over the *whole*
  business — an assignment limited to named computers cannot set a policy that
  reaches all of them;
- the **MSP** (Platform Admin, or `technicians:manage` when not acting as a
  technician).

A Business User cannot, whatever they hold: they may see only some of the
business's computers and the policy reaches all of them. Turning a policy on,
saving one that stays on, or removing a site override needs fresh
authentication (`STEP_UP_REQUIRED`, action `updates.schedule`); turning one
off never does. Anyone with `computers:view` can read the policy and the
computer list, for the computers they can see.

**Audit.** Every change is `CLIENT_UPDATE_POLICY_CHANGED` with the policy
before and after, the window in words, and how many requests it withdrew. Every
computer the sweep queues is `CLIENT_UPDATE_AUTO_QUEUED`, with no actor, the
policy, and the from/to versions.

**Computers that will never update automatically** are listed with the reason:
not Windows, never authenticated with a device secret (re-run the installer on
the machine once), or never reported a RustDesk version (an agent older than
0.8.2 — see below). An offline computer is not "never": it is queued when it
is next online inside the window.

### The pre-v0.8.2 trap

Only installers from v0.8.2 onward report a RustDesk version, *and* only those
understand the staged-upgrade instruction in the heartbeat response. An older
endpoint can therefore be staged for an upgrade it will never apply, and the
staging will never clear.

Those machines need the installer re-run — which they need anyway, for the
service-config fix in v0.8.2. From v0.15.0 that can be done from the console
with *Reinstall agent* on the computer's Overview tab, provided the machine has
authenticated with a device secret; one that never has needs a single local
run first. See [inventory.md](inventory.md). See [clients.md](clients.md#managed-installer-rem0te-devices-add-device).

Archived computers are skipped when an update is staged.

> **Before 0.19.0 an update could lock a Windows machine out.** Re-running
> the installer on a computer first enrolled before 0.18.22 lost its device
> secret, so every heartbeat after that was refused and the machine showed
> offline. The installer no longer does this. Machines it already happened to
> can be recovered from the console. See
> [troubleshooting.md](troubleshooting.md#a-computer-went-offline-right-after-update-or-reinstall-agent).

---

## The Rem0te agent: automatic updates (0.36)

**On by default.** When a Windows computer's agent is older than what this
server serves, the server asks it to update itself at a check-in — paced across
the platform, inside the business's policy, a bounded number of times. Nobody
has to click *Update agent*. Code: `apps/api/src/agent-auto-update/`
(`schedule.ts` holds every decision, unit-tested on its own).

**What "older" means.** A standard agent reports the platform version of the
installer that wrote it; it is outdated when that is older than this server's
`version.json` (compared as numbers: 0.9 is older than 0.35). A signed agent is
outdated when the build it reports is not the one the signed repository
publishes. Because the standard agent's version is the platform version, **every
release counts as an agent update**, whether or not the heartbeat script
changed in it — the price of an exact answer to "is this the agent this server
would install?". Each attempt downloads the RustDesk client again (≈ 40 MB),
which is what the pace below is for.

**How it is asked.** The heartbeat response carries the flag that agent already
acts on — nothing new has to be installed first:

| Agent | Flag | Since | What runs |
|---|---|---|---|
| Standard, 0.15.0 and later | `reinstallAgent` | 0.15.0 | the current `windows.ps1`, as *Update agent* does |
| Standard, 0.13.x–0.14.x (no version reported, but a device secret) | `updateRustdesk` | 0.11.0 | the same installer: those heartbeats re-run it on that flag alone |
| Signed | `reinstallAgent` | 0.24 | `rem0te-agent.exe update`, which installs only what signed metadata lists |
| Standard, older than 0.13.0 (no device secret) | — | — | **update manually**: nothing such a computer says is believed and nothing is handed to it; re-run the installer with an enrolment token from *Add device* (the Agent card gives the command) |
| Linux, macOS | — | — | **update manually**: those agents are read-only by design and act on no flag (invariants §24, §32); the Agent card gives the `curl … \| sudo bash` command |

Production's 0.30.1 and 0.18.25 agents are both in the first row. The table was
worked out from every tagged `heartbeat.ps1` (`git show <tag>:…`): `reinstallAgent`
is honoured from v0.15.0, `updateRustdesk` from v0.11.0, and device secrets
arrived in v0.13.0. Every version since v0.11.0 keeps the same 30-minute floor
between installer runs.

**Bounded, so a release never becomes a download loop:**

- **One attempt hands the flag out for 20 minutes** — shorter than the agent's
  own 30-minute floor, so an attempt is at most one installer run.
- **Then it waits an hour** for the computer to report the new version, and
  backs off: attempt 2 no sooner than 2 hours after attempt 1, attempt 3 no
  sooner than 8 hours after attempt 2.
- **After the last attempt (3 by default, 1–10) it stops** and the computer is
  shown **Auto-update failing** on its Agent card and in the settings card's
  failing list. It is not asked again until the next release (a new target
  starts from zero) or someone clicks *Update agent* (which also resets it).
- **A global pace**: at most *N* attempts start per hour across the whole
  platform (default 120, 1–2,000), counted from the history table under a
  database lock, so it holds across API processes. 5,000 outdated computers
  take about 42 hours at the default.

**Holds** — nothing goes out, and the Agent card says which: an *updates*
containment pause (business or global); a staged rollout owning the computer;
another request that re-runs the installer already queued (a RustDesk client
update, *Update agent*, a move to the signed agent — each updates the agent
too); a remote session open (the install restarts RustDesk); outside the
policy's window when the policy says *only inside the window*; someone logged on
when that policy also skips computers with a user; and the pace.

**Settings.**

- **Platform:** Settings → Client updates → *Keep agents up to date
  automatically — every business* (Platform Admin): on/off, starts per hour,
  attempts per computer per release. `GET`/`PUT /admin/agent-auto-update`.
  A change needs fresh authentication and is audited as
  `AGENT_AUTO_UPDATE_SETTINGS_CHANGED` (before and after).
- **Per business, site or device group:** the client-update policy's *Keep
  agents up to date automatically*: *Any time, paced* (the default), *Only
  inside this policy's window*, *Off*, or (site and group) *Inherit*. The most
  specific policy that sets one decides — group, then site, then business — and
  one left on *Inherit* passes to the next. It is independent of the RustDesk
  checkbox. Changing it to anything but *Off* needs fresh authentication;
  opting out never does. Audited as `CLIENT_UPDATE_POLICY_CHANGED`, with
  `agentMode` in before and after.
- **Per process:** `AGENT_AUTO_UPDATE=off` stops it in this API process
  (`scripts/run-e2e.sh` and the browser suite set it).
- **Canary first is not built.** The client-update machinery has no canary
  notion to reuse cheaply; a cautious business can set *Off* on its business
  policy and *Any time* on a pilot device group's policy, which has the same
  effect by hand.

**Records.** Each attempt is an `AgentAutoUpdateAttempt` row with no requester —
the computer's *Automatic update history* on its Agent card — and is **not** an
audit entry: one per computer per release would bury a log that can never be
pruned. The settings and the policies that cause them are audited.

**The signed agent's own check.** Before 0.36 a signed agent updated only when
the portal set a flag. Its heartbeat now also runs `rem0te-agent.exe update`
by itself about once a day (every 20 hours plus up to 8 hours of jitter), on a
heartbeat where the portal says it may (`agentSelfCheck`: not opted out, inside
a *window* policy's window, no updates pause, no rollout, no session). The
signed pause still stops it inside the agent. This is part of the signed
`windows/install.ps1`, so **it takes effect only once a signed release built
from 0.36 is published with the owner's keys**; until then signed agents update
when the portal asks them to (the `reinstallAgent` row above), which works
today wherever a signed build is published.

**The device list** has *Agent: Agent outdated* (`agent=outdated`): standard
Windows agents reporting an older version, and signed agents not on the
published build. An agent that reports no version is under *No agent report*,
not here — it cannot be told from a RustDesk-only computer.

**Evidence: I** (`e2e-agent-auto-update.mjs` through the real heartbeat route,
`unit-agent-auto-update.mjs`, the generated PowerShell parsed and the signed
self-check run under pwsh against a stub agent). It has not run on a real
Windows computer.

## The Rem0te agent: moving to the signed agent automatically (0.37)

**On by default** once a signed agent is published: standard Windows agents are
moved to the signed agent without anyone pressing *Upgrade to full agent* —
one computer first (the canary), the rest only after it has reported the
published build for a soak (default 60 minutes) with no failed update, paced by
the same per-hour number as automatic updates above. The same opt-out applies:
a business, site or device-group policy whose agent mode is *Off* opts its
computers out of this too, and *Window* holds them to the window. A failure
halts it, with its reason, until a Platform Admin resumes or restarts it. In
**Signed only** it does nothing.

Every move is an ordinary per-computer migration request (the same nonce and
the same fixed script); nothing new runs on a computer. The whole process —
signing set up, a signed agent published, the timestamp kept fresh, computers
moved — is on **Devices → Full agent**, with the command for each step that is
not done. Details: [update-signing.md](update-signing.md#moving-computers-automatically-037).
`AUTO_MIGRATION_SWEEP=off` stops it in one API process.

## Signed updates (v0.24)

Windows agents that run `rem0te-agent.exe` update only through the offline-signed repository this portal mirrors:
- *Update* and *Reinstall agent* still trigger them.
- What they install is decided by signed metadata, not by the portal.
- Older agents keep updating the legacy way until they migrate, or until the platform is set to *signed only*.

All of this is described in [update-signing.md](update-signing.md).

## Staged rollouts (v0.20)

**Settings → Client rollouts** controls **which** version, **when**, to
**whom**, and what counts as done. One-click staging above is still there for
a single machine. While a computer has a rollout job, the rollout owns its
updates and one-click staging does not also fire.

### Supported version pin

*Supported version pin* makes every installer, Connect script and Quick
Connect download install exactly that RustDesk version instead of the latest
release. An exact `x.y.z` only. Clear it to go back to latest. Endpoints
running an agent older than 0.20.0 ignore the pin, and a rollout that sees one
install something newer marks that job failed (see below) rather than retrying.

### A rollout

Creating one resolves, up front:

- **The exact version and artifact.** The target and the SHA-256 of
  `rustdesk-<v>-x86_64.exe` are fetched from GitHub and stored. The installer
  an endpoint fetches for its job installs that version with that digest,
  never "latest". If GitHub publishes no digest, the rollout is refused unless
  you allow **signature-only**, in which case the installer requires a valid
  Authenticode signature instead. That is weaker: any signature Windows
  reports as valid is accepted, and the signer is logged but not pinned.
- **The targets.** Specific computers, whole businesses, or both. Both means
  only the listed computers that are in the listed businesses. Neither means
  **every** managed computer. A computer is
  **skipped** with a reason if it is not Windows (staged updates are
  Windows-only), has no device secret, is already on the target, would need a
  downgrade, or is already in another rollout for the same component.
- **Batches.** A pilot group goes first (batch 0), then the rest in batches of
  the size you set.

Agent rollouts can only target this server's own version: the server can only
serve its own agent.

### What happens

| Job state | Moved there by |
|---|---|
| Requested | created; waiting for its batch, window, backoff or an idle session |
| Dispatched | handed out in one heartbeat response; a concurrent heartbeat cannot dispatch it twice |
| Installing | the endpoint fetched the installer for this job's nonce |
| Awaiting verification | an **authenticated** heartbeat reports the approved version |
| Succeeded | version reported, plus hbbs registration, or registration recorded as *unavailable* (not independently verified) |
| Failed | attempts exhausted, or an outcome retrying cannot fix |
| Canceled / Skipped | operator, or nothing to do |

- **Deferral.** A job waits while the endpoint reports an incoming RustDesk
  session, while a session on it is confirmed, outside the maintenance window,
  and (by default) while a recent launch on it has not been confirmed or
  closed.
- **Retries are bounded.** An install that ran but left the old version, or a
  job with no evidence before the verify timeout, retries with exponential
  backoff up to *max attempts*, then fails. Nothing re-runs an installer on
  every heartbeat.
- **Newer than approved fails at once**, without retrying. It means the
  endpoint's agent predates the pin.
- **The failure threshold pauses the rollout.** It is checked on every failure
  and again before each new batch, so a failed pilot stops the fleet.
- **Cancel** stops jobs that have not been dispatched. A dispatched job cannot
  be recalled, because the installer may already be running. It is marked
  canceled and no longer tracked, so check that computer's reported version
  afterwards.

Each computer's page shows its update history with the evidence for every step.

### Recovery (there is no rollback)

RustDesk's installer has no tested downgrade, so Rem0te does not offer a
rollback. If a version misbehaves:

1. **Pause** the rollout (or cancel it). Nothing further is dispatched.
2. **Set the version pin** to the last good version, so nothing newly installed
   or re-run picks up the bad one.
3. For an affected computer: **uninstall RustDesk on it first**, then re-run
   the Rem0te installer, which installs the pinned version and keeps the
   enrolment. The installer only ever upgrades. With a newer RustDesk present
   it leaves it alone, so *Reinstall agent* by itself does not downgrade. The
   uninstall needs someone at the machine, or a tool other than RustDesk:
   uninstalling RustDesk over a RustDesk session ends that session.
4. Check the computer's **Test connection** panel (Diagnostics tab): registration, version and
   heartbeat.

**Agents on the signed chain (0.24)** work differently:
- The installer refuses an older RustDesk build unless the release signer signed that build with
  `allowDowngrade`. There, a rollback is the signer's decision and needs no uninstall.
- A pin or rollout can only name a build that the signed metadata lists.

See [update-signing.md](update-signing.md).

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
- [inventory.md](inventory.md) — pending Windows updates on an endpoint, and
  the rest of what the agent collects
- [connecting.md](connecting.md) — the connect paths and their failure modes
- [setup.md](setup.md) — installation and operations
