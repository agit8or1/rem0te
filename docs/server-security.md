# Server security (Admin → Security)

**Admin → Security** is a Platform Admin's view of the server Rem0te runs on and of
Rem0te's own safeguards. It reads this server as the API's service user (`reboot`),
reports what it found, and makes a small number of audited changes through the
commands the installer's sudoers already grants. Nobody else can open it: every
route answers 403 to anyone who is not a Platform Admin.

It was rewritten in 0.74. The page before it showed failures as healthy, so if you
remember it, read [What changed in 0.74](#what-changed-in-074) first.

## The rule: unknown is never OK

Every check ends in one of four states:

| State | Meaning |
|---|---|
| **OK** (green) | Read, and fine. |
| **Needs attention** (red) | Read, and not fine. Each one has a severity and a fix. |
| **Unknown** (grey, ?) | Could not be read: a file the service user cannot open, a command that failed, a source that is not there. Each one says why. |
| **Info** (blue) | Read, and worth knowing, but not a problem (for example, no approval signer is configured). |
| **Accepted** / **Accepted (unknown)** (slate) | Failing or unknown, and a Platform Admin decided to accept it, with a reason. See [Accepted risks](#accepted-risks). |

A check that could not be read is never shown as OK, and neither is an accepted one. A page that is still loading,
or that could not load, says so and shows no state at all.

## Overview: the score

The Overview tab lists every check, grouped as *This server*, *Network*, *Web and
TLS*, *Rem0te* and *API process*, with failures first. Each finding shows its
evidence, when it was read, a fix, and a link to the setting where one exists.

The score is out of 100 and counts **only the checks that could be read**. Each
failing check costs its weight (critical 25, high 12, medium 6, low 2), scaled
over what was decided. The coverage figure beside it is the share of checks that
could be read; a high score with low coverage means little. The posture is *poor*
when any critical check fails or the score is under 60, *fair* under 85 or with a
high check failing, else *good*. With nothing readable there is no score.
An [accepted](#accepted-risks) finding costs nothing and is counted as
*accepted*, not as OK; it does not change the coverage.

Readings are cached for a few minutes; the refresh button reads again.

### What is checked

**This server**

- **SSH**: root login, password authentication, empty passwords and X11
  forwarding, from `/etc/ssh/sshd_config` and its `Include`d files, first value
  wins as sshd reads them. `sshd -T` needs root, so the files are parsed instead.
  sshd keeps the **first** value it reads, reading `sshd_config` from the top and
  each `Include`d drop-in in lexical order where the `Include` stands (on Ubuntu,
  at the top). If an included file cannot be read (`50-cloud-init.conf` is 0600),
  a setting is **Unknown** only when that file comes before the first readable
  value: it may set the directive first. A readable drop-in that sorts earlier
  decides it for certain — `40-rem0te.conf` with `PermitRootLogin no` is read
  before `50-cloud-init.conf`, so root login is known to be off. The finding names
  the unreadable file. To decide an Unknown one, run `sudo sshd -T | grep -Ei
  'permitrootlogin|passwordauthentication'`, or set the directive in a drop-in
  that sorts first (for example `01-rem0te.conf`).
- **Firewall**: whether ufw is enabled and active. Its rules need root to list;
  run `sudo ufw status verbose`.
- **Updates**: pending packages, how many are security updates, and how old the
  package lists are (over two days is a finding).
- **Unattended upgrades**: configured in `20auto-upgrades` and the service running.
- **Restart pending**: `/var/run/reboot-required`, and the packages that asked.
- **fail2ban**: running, and whether its `sshd` jail watches the right unit. On
  Ubuntu 24.04 the SSH service is `ssh.service`, while fail2ban's default journal
  match is `_SYSTEMD_UNIT=sshd.service`, so the jail sees no failures at all. The
  fix is in `/etc/fail2ban/jail.local`: under `[sshd]`, `journalmatch =
  _SYSTEMD_UNIT=ssh.service + _COMM=sshd`, then `sudo systemctl restart fail2ban`.

**Network**

- **Listening ports** that are reachable from outside (not loopback), compared with
  what a Rem0te server is expected to listen on: TCP 22, 80, 443 and 21115–21119,
  UDP 443 and 21116. Anything else is listed with its process when `ss -p` shows
  it, which it does only for the service user's own processes (never root's; the
  page does not ask for root to find out).
- **Ephemeral client sockets** (0.75.1, information): an unconnected UDP socket on
  a port inside the kernel's ephemeral range
  (`/proc/sys/net/ipv4/ip_local_port_range`, usually 32768–60999) is a client
  that let the kernel pick its port, not a service. The RustDesk server (`hbbs`)
  keeps one, which 0.74 reported as an unexpected public listener (`udp/33344`).
  These are listed on their own line and are not a finding. A TCP listener is
  judged as before whatever its port, and so is a UDP socket outside the range. If
  the range cannot be read, nothing is excused and the finding says so.

**Web and TLS**

- **Certificates** Caddy serves for each site in the Caddyfile, read over loopback
  with the site's name. Caddy renews about 30 days before expiry, so under 20 days
  left means renewal has been failing (high), under 7 is urgent and expired is
  critical. There is no renew button: see [Certificates](#certificates).
- **The public URL** is https.
- **Security headers** on the console's sign-in page: HSTS (at least 180 days),
  Content-Security-Policy, framing (X-Frame-Options or `frame-ancestors`),
  `nosniff`, Referrer-Policy and Permissions-Policy, and whether `Server` or
  `X-Powered-By` disclose software.
- **Plain HTTP** redirects to https.

**Rem0te**

- **MFA for Platform Admins** (names them, since there are few) and for everyone
  else (counts only).
- **Platform Admins and break-glass accounts**: how many, and whether each
  break-glass account has both an authenticator and a passkey. Managed at
  [Admin → SSO](/admin/sso).
- **API keys**: active keys with no expiry, or unused for 90 days.
- **Audit chain**: the same verifier as *Settings → Security → Containment*, and
  whether the off-host export is configured and working.
- **Sign-in lockout** is on.
- **Stored but never enforced access rules** (below).
- **Signed releases**: whether the signed repository's metadata is current
  ([Update signing](update-signing.md)).
- **Release root keys**: always **Unknown** here. The keys live in a directory the
  portal is deliberately unable to read (§56); run `sudo rem0te-signed-status` on
  the server instead.
- **Approval signer**: configured and answering.

**API process**

- **`MSA_GRANTS`**: shown as information while it is off, as it ships.
- **`NODE_ENV=test`** is critical: it lets test-only loopback endpoints through.
- **Off switches**: any `*_SWEEP`, `*_SEALER` or other test switch set to `off` in
  the API's environment. `STALE_SWEEP=off`, `SSO_SESSION_SWEEP=off` and
  `AUDIT_SEALER=off` are critical in production; each says what it stops.

**Dependencies**

- `npm audit` of the API's production dependencies. Fixing one is a dependency
  bump in the repository and a deploy with the manifest regenerated (see
  `CLAUDE.md`), never `npm audit fix` on the server.

## Accepted risks

Some findings are deliberate. SSH may be reachable only behind a hardware
firewall; a single-disk server has nowhere to export the audit log to yet. A
Platform Admin can **accept** such a finding so it stops showing as a warning:

- **Accept…** on the finding asks for a **reason** (3 to 300 characters) and an
  optional **expiry** (none by default, at most a year). It may ask you to
  [confirm it is you](sign-in.md) (*Server security changes*), because it hides a
  warning. It is audited as `SECURITY_FINDING_ACCEPTED` with the finding, its
  status, the reason, the expiry and the evidence fingerprint.
- The finding moves to **Accepted risks**, a collapsed section at the end of the
  Overview showing who accepted it, when, why and until when. It keeps its status
  underneath (*Accepted* for a failing check, *Accepted (unknown)* for one that
  could not be read) and is never shown as OK. It costs nothing in the score and
  is counted as *accepted* in the summary.
- **It re-opens on its own** when the evidence changes, when the check passes or
  disappears, or when the expiry passes. An acceptance is bound to a fingerprint
  of the facts the check decided on — the offending ports, the effective sshd
  value and the file it came from, the pending package versions — not to the
  wording or the time it was read. Accept the listener finding for `udp/5353`,
  and a new public `tcp/9000` re-opens it. Each automatic re-open is audited as
  `SECURITY_FINDING_UNACCEPTED` with its cause (`evidence_changed`, `resolved`,
  `expired`); a re-opened acceptance never comes back, even if the evidence
  returns to what it was.
- **Re-open** puts it back by hand. It never asks you to confirm it is you, since
  it only shows a warning again. Audited as `SECURITY_FINDING_UNACCEPTED`
  (`unaccepted`).

Every acceptance is kept, open or closed (`GET
/api/v1/admin/security/findings/acceptances` lists the last 200).

**Some findings cannot be accepted** — they must be fixed. The row says why:

| Finding | Why it cannot be accepted |
|---|---|
| A Platform Admin without MFA | One stolen password is everything Rem0te can do. |
| A break-glass account without both an authenticator and a passkey | It breaks the rule break-glass exists under. |
| The audit chain does not verify | Entries were changed or lost: an incident, not a risk. |
| SSH accepts empty passwords | Never deliberate on a server. |
| `NODE_ENV` is not `production` | Test-only endpoints and a host fixture are admitted. |
| A `*_SWEEP` / `*_SEALER` / test switch is `off` | Each silently stops a safety job; they exist for test stacks. |
| A TLS certificate (each site) | Expired, untrusted or failing renewal breaks every agent and browser. |

Only a closed list of checks can be accepted; the database refuses any other
(`0093`'s CHECK), and refuses a reason outside 3–300 characters or an expiry
over 365 days.

## Access rules

Only the **sign-in lockout** is here: failed attempts before an account locks and
for how long. It is enforced by the API for every account, in the database.
Allowing more attempts, a shorter lockout or turning it off may ask you to
[confirm it is you](sign-in.md) (*Sign-in lockout policy*); tightening never does.
Each change is audited as `LOGIN_POLICY_CHANGED` with the values before and after.

Earlier versions also offered **GeoIP blocking** and **IP allow and block lists**.
Nothing in Rem0te ever read them, so they never blocked anything. They cannot be
set any more; if values are still stored, the page lists them and offers to clear
them, and the Overview flags them. Block addresses in ufw, in Caddy, or with a
fail2ban ban, where they are actually refused.

## fail2ban

Shows each jail: banned now, banned in total, failures seen, what it reads, and
the banned addresses. You can ban and unban an address, keep addresses or ranges
from ever being banned, change a jail's ban time, find time and retry count, and
install, enable and start fail2ban when it is missing or stopped.

- Every change goes through the root-owned `rem0te-f2b` wrapper (or, for the
  install, the `apt-get install -y fail2ban` and `systemctl enable|start fail2ban`
  lines the installer grants), may ask you to confirm it is you (*Server security
  changes*), and is audited as `HOST_SECURITY_CHANGED` with its outcome. A command
  that fails is reported as an error, with its message, never as success.
- You cannot ban the address you are connected from.
- Changes apply to the **running** fail2ban and last until it restarts. To keep
  one, put it in `/etc/fail2ban/jail.local` as well.
- If the page says fail2ban is **Unknown**, the wrapper is missing or sudo refused
  it; the reason is shown. Install the wrapper with the installer
  (`deploy/scripts/install.sh`).

## Certificates

Caddy obtains and renews certificates itself. A renew button cannot help: posting
the same configuration back to Caddy changes nothing, which is all the old one did.
When a certificate has under 20 days left, renewal has been failing; find out why
with `journalctl -u caddy | grep -i acme` (usually DNS or port 80 not reaching the
server). Caddy retries on its own once the cause is fixed.

## OS updates

Lists upgradable packages, marks security updates, shows when the package lists
were last refreshed, whether a restart is pending and for which packages, the
running kernel and whether unattended upgrades are on. When nothing could be read
it says Unknown, never "up to date".

**Run apt-get update and upgrade** runs `apt-get update`, then `apt-get upgrade -y`
keeping existing configuration files, and streams the output. It is audited when
it starts and when it finishes, with the exit code. A new kernel needs a server
restart afterwards, which this page does not do.

## Security features

The catalog of Rem0te's safeguards, with what enforces each one and the test that
proves it. See [Technician access](technician-access.md).

## What changed in 0.74

| Before | Now |
|---|---|
| Code audit ran ESLint on the deployed `dist/`, which linted nothing and reported "no issues"; semgrep could not start under the service and also reported nothing. | Removed. Source scanning runs in CI. The Dependencies tab runs `npm audit` on production dependencies and says when it could not. |
| *Fix* ran `npm audit fix` in production's `node_modules`, outside the generated manifest. | Removed. |
| *Renew* posted Caddy's unchanged configuration back to it, which does nothing. | Removed; the page explains renewal. |
| A failed or loading fail2ban read showed *Stopped*; an apt error showed *up to date*; no certificates showed a green dot. | Each is Unknown with its reason. |
| fail2ban changes and the install were not audited and asked for no confirmation; a failed install reported success. | Audited with the outcome, confirmed, and failures are errors. |
| GeoIP and IP list settings were saved and never enforced. | Cannot be set; stored values are flagged and can be cleared. |

## For operators

- **Deploy**: migration `0091_server_security_audit` adds two audit actions, and
  `0093_security_risk_acceptance` (0.75.1) the accepted-risks table and two more;
  apply them and regenerate the Prisma client at the target (`CLAUDE.md`, *A
  schema change needs two more steps*).
- **Nothing in sudoers changed.** The page uses only the lines the installer
  already grants.
- **Tests**: `apps/api/scripts/unit-host-security.mjs` (every parser, the command
  list against the sudoers lines, the score) and
  `apps/api/scripts/e2e-host-security.mjs` (scratch API on 3991–3994, the host a
  fixture; 3994 is the same host after its evidence changed, for re-opening). Under `NODE_ENV=test` a fixture (`SECURITY_HOST_FIXTURE`) stands in
  for the host, and without one no change is made. The browser suite opens every
  tab. Security invariant §84 keeps the command list closed and every change
  confirmed and audited.
