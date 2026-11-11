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

---

## 2. Find a computer

**Devices** lists every machine you can see: in the businesses you can reach,
and — for a Business User — only the machines assigned to you or shared
company-wide; for a technician, only the machines your assignment names.

![Computers list](screenshots/guide/tech-02-computers.png)

1. **Search** — matches name, hostname, IP address, OS, alias, RustDesk ID, business,
   site and the signed-in user. The server does the matching, so it searches every page,
   not just the one on screen.
2. **The table** — one row per device. Online devices come first, then by name;
   click any column heading to sort by it instead (click again to reverse).
3. **Enroll Client** — install the agent on a new machine (§5).
4. **Generate Enrollment Link** — a one-time link you can send to someone else to
   run themselves.

*(The screenshot predates 0.31's columns; the numbered parts are where they were.)*

### What the columns mean

| Column | What it shows |
|---|---|
| **Device** | Name, hostname, and a dot: green online, grey offline. |
| **Business / Site** | Who the machine belongs to and where. |
| **OS** | An icon and the reported Windows edition or platform. |
| **Health** | The worst *open* monitoring alert — Critical, Warning, Info — or *No open alerts*. That is not a promise nothing is wrong, only that no monitor says so. |
| **Agent** | *Signed* (the 0.27+ signed agent), *Standard*, or *No agent report*, with when it last checked in. |
| **Last seen** | *Online now*, or how long ago it was last heard from. |
| **Logged-in user** | Who the last heartbeat said was signed in. |
| **CPU / RAM / disk** | The last resource sample and its age. |
| **Pending patches** | From the last update scan: how many are waiting, and a *restart* tag if Windows wants one. |
| **Alerts** | How many monitoring alerts are open (or acknowledged). Click it for the device's Monitoring tab. |

**Every number says how old it is, and an old one is greyed.** A resource sample
is stale after 15 minutes (five missed heartbeats); an update scan after 36 hours.
A greyed value is what the machine last said, not what it is doing now.

Health and Alerts need the **monitoring:alerts** permission. Without it those
columns are not offered and you cannot filter or sort by them — the list says so
at the bottom.

### Filters, columns and saved views

- **Filters** — business (when you can see more than one), site, online/offline,
  open or critical alerts, *Restart pending*, agent type, and archived devices.
  They combine, and *Clear* resets them. The address bar carries the current view,
  so you can bookmark it; whoever opens the link still sees only their own devices.
- **Columns** — choose which columns show. **Compact / Comfortable** sets the row
  height. Both are remembered in this browser only.
- **Views** — save the current filters, sort and columns under a name. Views are
  stored in this browser only: they are not shared, and do not follow you to
  another computer.
- **Export CSV** — downloads every device in the current filtered view (not just
  this page), up to 10,000; narrow the filters if there are more. It needs
  *computers:view*, contains exactly what you can see, and **each export is
  recorded in the audit log** with its filters and row count.
- **Connect** on a row works exactly as it does on the device page. **⋯** opens the
  device, or its Patches, Monitoring or Test connection tab, or copies its hostname.

There is no RustDesk ID column any more. The ID is still on the device's page,
and search still finds a device by it.

**Online means the agent checked in within the last 30 minutes.** The agent
heartbeats every 3 minutes, so a machine that has genuinely dropped shows Offline
a few minutes later, not instantly.

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

**Start with Test connection.** Every computer's page has it. It checks the
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
