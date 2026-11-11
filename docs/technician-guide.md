# Technician Guide

Day-to-day use of Rem0te: finding a computer, connecting to it, helping someone
who is not enrolled, and keeping the remote-control client current.

Screenshots are captured from a seeded demo instance. Every business, person and
computer in them is fictional.

> **Terminology.** A **Business** is a customer organisation and is the security
> boundary — a Business User only ever sees computers belonging to their
> business. A **Computer** (also called an endpoint or enrolled client) is a
> machine with the Rem0te agent permanently installed. See
> [access-control.md](access-control.md) for who can do what.

---

## 1. Sign in

![Sign in](screenshots/guide/tech-01-signin.png)

1. Your email address.
2. Your password.
3. Sign in.

If your account has two-factor authentication enabled you are asked for a code
next. Recovery codes work here too, and each one is single-use.

### The dashboard: what to work on (0.31)

Signing in lands you on the **Dashboard**. It answers, from stored data, what is
broken, which businesses it affects, which devices need attention, what is
already being worked on, and what to do next. It covers only what you can see:
a Business User sees the devices granted to them, a technician sees their
assignment's business and computers, a Platform Admin sees every business. A
section you have no permission for is not shown at all — it is never shown as a
zero.

| Part | What it is built from |
|---|---|
| **Site outage** strip | An open site-outage alert: several devices at one site stopped reporting together |
| **Devices** | Active devices (archived and not-yet-enrolled ones excluded): online, offline, and *agent silent* — reachable through RustDesk but the agent has not checked in for 30 minutes, so nothing it reports is current |
| **Critical alerts** | Open critical alerts. Alerts in a maintenance window are counted apart, not as critical |
| **Failed actions** | Approved-action and patch targets that failed, were refused or did not run in the last 7 days, plus any whose outcome is unknown (those block new requests until someone records what they found) |
| **Awaiting approval** | Plans waiting for the approval roster. Approval happens on the signer, never here; expired requests are not counted |
| **Restart pending** | Devices whose latest update scan says Windows is waiting for a restart, or that have a *restart pending* alert. A scan older than 36 hours is flagged stale |
| **Patch compliance** | Of the devices with an update scan under 36 hours old, the share that list no pending updates. Coverage (how many devices have such a scan) and the scan ages are shown beside it; with no fresh scan at all it says *No data* |
| **Active sessions** | Sessions connected now, and ones still launching. A session row that has not moved for 12 hours is not shown as live |
| **Work on next** | A ranked list, each item with the reason it is there (below) |
| **Customers affected** | Businesses with an outage, an open alert, an offline device or a failed action |
| **Devices needing attention** | Devices with critical or warning alerts, failed actions, offline, agent silent or restart pending, most serious first |
| **Being worked on** | Live sessions, acknowledged alerts (and who acknowledged them), actions in flight, patch deployments in progress |
| **Your recent devices** | The devices of your own most recent sessions |
| **Recent activity** | Alert, action, patch, session, device and support-request events from the audit log, last 7 days. Needs *View business audit log* |

**How "Work on next" is ordered.** A fixed ladder, then oldest first: site
outages, critical alerts, actions with an unknown outcome, failed actions,
warning alerts, failed client rollouts (Platform Admins), approval requests,
restarts pending from a fresh scan, then info alerts. Acknowledged alerts are
not in it (someone has them), nor are alerts in a maintenance window or offline
alerts grouped under a site outage. Nothing is ranked by anything the dashboard
cannot see, such as a customer's contract.

Every item and figure links to where you act on it — the device's Monitoring,
Patches or Actions tab, the patch deployment, the alerts list. The page polls
every 30 seconds and says how old its data is. Server health (CPU, memory, disk,
relay) is not on the dashboard: Platform Admins find it under **Settings →
System status**. Device locations (the map) are under *Show device locations*
at the bottom.

---

## 2. Find a computer

**Devices** lists every machine enrolled in the businesses you can see.

![Computers list](screenshots/guide/tech-02-computers.png)

1. **Search** — filters by name or hostname as you type.
2. **The table** — Business tells you who the machine belongs to, RustDesk ID is
   its remote-control identity, Last Seen is the most recent agent check-in, and
   Status is Online or Offline.
3. **Enroll Client** — install the agent on a new machine (§5).
4. **Generate Enrollment Link** — a one-time link you can send to someone else to
   run themselves.

**Online means the agent checked in within the last 30 minutes.** The agent
heartbeats every 3 minutes, so a machine that has genuinely dropped shows Offline
a few minutes later, not instantly.

### The device workspace (0.31)

Opening a computer gives you one page for it.

**The header** says who it is and whether it is reachable: name, status
(*Online*, *Offline since …*, or *Online (RustDesk only)* when RustDesk can reach
it but its agent has stopped checking in), business, site and **last seen**,
marked *stale* when the agent has missed its check-ins. Under it, the
**attention strip** lists what needs looking at, each one a link to the tab that
explains it: open alerts with the worst severity (→ Monitoring), *Restart
pending* and pending updates with the age of the scan (→ Patches), a refused
heartbeat or an out-of-date agent (→ Overview), and which agent the computer runs
— *Standard agent*, *Signed agent* or *RustDesk only* (see
[What each agent can do](capabilities.md)).

**The actions:** **Connect**, **Diagnose** (opens Diagnostics), **Run action**
(opens Actions; disabled, with the reason printed underneath, when the computer
lacks the signed agent or no approval signer is configured), **Patch** (opens
Patches) and **More**: view-only connect (technicians), the diagnostics report,
*Reinstall agent* and *Archive computer*, each behind a confirmation that says
what it does.

**The tabs**, each linkable with `?tab=`:

| Tab | What is on it |
|---|---|
| Overview | Assignment, key alerts, patch status, recent activity, then the hardware, utilisation, storage, network and update cards, each with its age |
| Monitoring | Alerts first (acknowledge and resolve here), then what is watched on this computer in words, the agent's last report, and what changed |
| Software | Installed software with a filter, and recent software changes (Windows agents only) |
| Patches | Patch status, updates offered, Windows Update history |
| Event logs | A page of one Windows event log, on request (Windows agents only) |
| Diagnostics | Test connection: server, computer and your own RustDesk |
| Actions | Request an approved action and see past requests |
| History | Remote sessions, technician notes, the AI-written summary (labelled as such) and who can connect |

There are no Services or Processes tabs: no agent collects them. The agent reads
only the services a monitor names, and those appear on Monitoring. Old links
(`?tab=notes`, `?tab=timeline`, `?tab=access-review`) open History.

---

## 3. Connect to a computer

Open a computer from the list, then use **Connect**.

![Computer detail with Connect](screenshots/guide/tech-03-connect.png)

1. **Connect** — hands the machine's ID and password to your local RustDesk
   client and starts the session.

You do not need to type a password. Rem0te holds the credential for each machine
and passes it to RustDesk for you; if you are prompted for one, something is
wrong — see Troubleshooting below.

Requirements on your own workstation:

- RustDesk must be installed.
- Your RustDesk must be configured for **this** server. If it is pointed at the
  public RustDesk network it will look up the ID there and either fail to find it
  or reach a completely unrelated machine.

Every connection is written to the audit log with who connected, to what, and
when.

---

## 4. Help someone who is not enrolled

Use **Remote Support → Quick Connect** for one-off help where nothing should be installed
permanently — a machine you do not manage, or a person you are helping once.

![Quick Connect](screenshots/guide/tech-04-quick-connect.png)

1. **Remote ID** — the 9-digit number their Quick Connect client shows.
2. **Password** — the short code shown next to it.
3. **Who are you helping** — optional label for the session record.

Send them to the public download page (shown on the right of that screen), they
run the client, and they read you the two values. Nothing is installed as a
service and no managed computer is created — closing the client ends their
availability.

Rem0te does not store the Quick Connect password and never displays it again.

---

## 5. Enrol a new computer

From **Devices → Enroll Client** you get a one-line PowerShell command to run
on the target machine as Administrator. It installs RustDesk, points it at this
server, sets a managed password, and registers the machine.

The installer is safe to re-run; it reconfigures an existing install rather than
duplicating it.

**It will refuse to report success if the machine never reaches the server.** If
you see an error instead of a summary, read it — it prints the service state,
whether ports 443 and 21116 are reachable, and RustDesk's own log. Those are the
facts that distinguish a firewall problem from a service that is not running.

---

## 6. Review sessions

![Sessions](screenshots/guide/tech-05-sessions.png)

1. **Connected** — enrolled clients currently online, each with a direct Connect
   button.
2. **Session History** — past sessions with duration and disposition.
3. **Connect** — start a session with that machine.
4. **Ad-hoc Session** — record a session against a machine that is not enrolled.

Each session's status says what is actually known about it. *Client opened*
means RustDesk started on your computer, not that you connected. *Connection
confirmed* comes from the remote computer's agent, or from you. A launch that
gets no further signal reads **Status unknown** after 30 minutes rather than
pretending it failed or succeeded, and duration is shown only when it was
measured. See [connecting.md](connecting.md#what-the-session-status-means-v020).

---

## 7. Keep RustDesk current

**Updates** covers two separate things: Rem0te itself, and the RustDesk client
installed on each managed computer.

![Updates](screenshots/guide/tech-06-updates.png)

1. **Update all outdated** — queues every machine that is behind.
2. **Check** — re-reads the latest RustDesk release.

Per-machine status reads:

| Status | Meaning |
| --- | --- |
| **Current** | On the latest release. |
| **Outdated** | Behind; an update can be queued. |
| **Unknown** | The machine has not reported a version yet. Endpoints enrolled before v0.8.2 only start reporting after their next installer run. |
| **Queued** | An update is staged and applies on the next check-in. |

Queued updates apply on the machine's next heartbeat, within about 3 minutes. An
offline machine applies it whenever it next checks in — nothing is lost. A queued
update clears only once the machine reports the target version, so a failed
install retries instead of silently disappearing.

---

## 8. Support requests

Customers can ask for help through their business's support link, without an
account. Requests appear under **Remote Support → Support requests** if you hold
`support:requests`.

1. **Claim** a request to take it. If someone beat you to it, you are told who.
2. Check **Matched computers**: computers in the business that match what the
   customer wrote, limited to ones you can connect to.
3. **Connect** through the computer's Connect button or Quick Connect.
4. **Complete** it, or **Hand off** to a colleague, or **Release** it back.

The customer's status page shows your first name and the status, nothing else.
See [support-requests.md](support-requests.md).

## 9. Working for several businesses

If you have technician assignments, the sidebar shows a **business switcher**.
Pick the business you are working in; everything you see is then that
business, limited to what your assignment allows. **All assigned** gives an
overview across all of them, and lists access that is not active right now and
why (expired, outside its hours, awaiting approval). Ask for access to another
business from there. See [technicians.md](technicians.md).

---

## Troubleshooting

**Start with Test connection.** Every computer's page has it, on the
**Diagnostics** tab (the **Diagnose** button opens it). It checks the
server, the computer and, with *Check my computer*, your own RustDesk, and says
which one is wrong. See [connecting.md](connecting.md#test-connection-v020).

**A computer shows Offline but the person says it is on.**
Online is driven by the agent's 3-minute heartbeat, not by RustDesk. A machine
can be running fine while the heartbeat task is broken. Re-running the installer
reinstalls the task and will now tell you if the machine cannot reach the server.

**Connect says "wrong password".**
The credential Rem0te holds and the one the machine has are out of step, or your
own RustDesk resolved the ID on the public network and reached a different
machine. Check that your workstation's RustDesk points at this server first —
that is the more common cause and the more serious one.

**Connect says "ID does not exist".**
The machine is not registered with this server's rendezvous service. It is either
genuinely offline, or its RustDesk cannot reach the server even though the agent
can. Re-run the installer on it; the verification step now reports exactly which.

**A machine was reported "installed successfully" but never appears.**
That was possible before v0.8.2 and is not any more — the installer now refuses
to claim success unless the server confirms it has seen the machine.
