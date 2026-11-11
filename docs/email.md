# Email and scheduled reports

From 0.34 rem0te can send email: alert notifications, scheduled reports, and the confirmation and test messages
those need. It sends through one SMTP relay that a Platform Admin configures. **Nothing is sent until the relay is
configured and switched on.**

## The relay (Settings → Email)

Platform Admin only. Saving asks you to confirm it is you, and every change is recorded in the audit log as
`SMTP_SETTINGS_CHANGED` — the host, port, encryption, username and from address before and after, and whether the
password was set, kept or cleared. **The password itself is never in the audit log, a response or a log line.**

| Setting | Notes |
|---|---|
| Host | A DNS name. See *Which hosts are allowed* below. |
| Port | Usually 465 (implicit TLS) or 587 (STARTTLS). |
| Encryption | **Implicit TLS**, **STARTTLS (required)** — refused if the relay does not offer it, never downgraded — or **None**, which is accepted only for a relay on this server (loopback). Certificates are always checked (TLS 1.2 or later). |
| Username / password | Optional. The password is write-only: leave it blank to keep the saved one. It is stored encrypted (AES-256-GCM under `ENCRYPTION_KEY`). |
| From address / name | One plain address; the name is optional. |

**Changing the host, port, username or encryption clears the saved password** unless you enter it again in the
same save. Otherwise someone with your session could point the relay at their own server and have rem0te log in to
it with your real password.

**Send test email** goes to your own account address, or to a confirmed global recipient — never to a typed
address. The result (`sent`, or a short code such as `EAUTH 535` or `ECONNECTION`) is shown and audited as
`EMAIL_TEST_SENT`. The relay's own error text is not shown: it can echo what was sent.

### Which hosts are allowed

rem0te connects to the host you type and speaks SMTP to it, so the host is checked the way a business's webhook
destination is (it must be a public DNS name), and checked twice:

- **When you save**, the name: no IP addresses, no `localhost`, no single-label names, no internal suffixes
  (`.local`, `.internal`, `.lan`, `.corp`, `.home`, …).
- **Every time mail is sent**, the name is resolved and **every** address it returns must be allowed; rem0te then
  connects to that checked address (keeping the name for the TLS certificate). A name that resolved to a public
  address when it was saved and resolves to `127.0.0.1` or `169.254.169.254` now is refused.

A relay on the same server or the local network is a normal install (Postfix on localhost, an on-premises Exchange).
It is allowed only from the API's environment, never from the portal — a stolen admin session cannot switch it on:

| `SMTP_ALLOW_LOCAL_RELAY` | Also allowed |
|---|---|
| unset | nothing: public names that resolve to public addresses only |
| `loopback` | `localhost`, `127.0.0.0/8`, `::1` |
| `private` | the above, plus RFC 1918, `100.64.0.0/10`, `fc00::/7` and internal names |

Never allowed, whatever the setting: link-local (`169.254.0.0/16`, the cloud metadata address, and `fe80::/10`),
unspecified, multicast, broadcast and documentation ranges. An IPv4-mapped IPv6 address (`::ffff:127.0.0.1`) is
judged as the IPv4 address it carries. Unencrypted SMTP goes only to a loopback address.

## Who mail can go to: confirmed addresses

Mail goes only to **confirmed recipients**. An address is added to a list — one per business, plus a global list for
the MSP — and rem0te sends it a link. It can be used only after whoever reads that mailbox opens the link and
presses **Confirm** (opening the page alone confirms nothing, because mail scanners follow links). The link works
once, for 7 days; **Send link again** issues a new one (at most every five minutes).

- A business's list is managed by a **Business Owner** of that business or the MSP; the global list by the MSP —
  the same people who decide who is notified.
- Adding, re-sending and removing **ask you to confirm it is you**, and are audited (`EMAIL_RECIPIENT_ADDED`,
  `EMAIL_RECIPIENT_VERIFIED`, `EMAIL_RECIPIENT_REMOVED`).
- A business's notification policy and scheduled reports may name only that business's confirmed addresses; the
  global policy and platform-wide reports only the global ones. At most 25 addresses per list.
- Removing an address stops mail to it at once, wherever it was named.

**Why confirmed addresses, and not "the users of the business"?** A stolen session that can edit a policy could
otherwise type any address and send alert text — or a CSV of the fleet — to it. A user's account address is not
proof either: accounts are created by administrators and carry whatever was typed. The confirmation link proves the
mailbox's owner asked for the mail; fresh authentication on adding an address proves the person adding it had more
than a cookie.

Where to manage them: **Settings → Monitoring → Notifications** (a business, or global for the MSP), and
**Settings → Email** (global).

## Alert emails

A notification level's destination can be a webhook (as before) or an **email recipient**, picked from the confirmed
addresses — never typed. Saving the policy still asks you to confirm it is you.

An alert email says as little as is useful, in plain text:

```
Subject: [rem0te] CRITICAL: Disk C: below 10% free on PC-12

Alert:     Disk C: below 10% free on PC-12
Severity:  critical
Computer:  PC-12
Business:  Acme
Raised:    2026-11-11T09:00:00.000Z

Open it in rem0te: https://rmm.example.com/alerts?alert=…
```

No alert detail, inventory, hostname, address or other id is included; a site outage names the site instead of a
computer. Names that come from devices are reduced to one printable line first, so a computer name cannot add a
header or a line of its own. When an alert resolves, every email destination that was told is told again.

## Scheduled reports (Reports → Scheduled reports)

Any of the four [reports](reports.md) can be emailed **weekly** (a day of the week) or **monthly** (a day from 1 to
28 — every month has those days), at a time in an IANA time zone. A weekly schedule reports on the last 7 days, a
monthly one on the last 30 (this is the period for alert frequency and offline time; patch compliance and agent
coverage are the current state).

- Set up by a **Business Owner** of the business, or by a **Platform Admin** (a platform-wide schedule is a Platform
  Admin's alone). You need the report's own permission (View computers, or monitoring:alerts). Creating or changing
  a schedule asks you to confirm it is you; deleting or switching one off does not. Changes are audited as
  `REPORT_SCHEDULE_CHANGED`. **Whoever saves a schedule becomes its owner.**
- The email names the report, the business (and site), the period and links to the report. Recipients sign in to see
  it.
- **Attach the report as CSV** sends the same file **Export CSV** gives — the same export, the same 10,000-row limit
  (a larger report is not sent, and the recipients are told why), the same formula-cell neutralising, and the same
  `REPORT_EXPORTED` audit row, which names the schedule.

### Evaluated as the owner, when it is sent

At every send, the owner's access is rebuilt from the database. The report is computed with what they can see
**now**. If the owner is suspended, is no longer a Business Owner of that business (or no longer a Platform Admin),
or no longer has the report's permission, **it fails closed**: nothing of the report is sent, each recipient gets a
short message saying the report was not sent and why (with nothing from the report), the schedule switches itself
off with the reason shown, and `REPORT_SCHEDULE_FAILED` is audited. Someone who may set up schedules saves it again to
take it over.

### Exactly once per period

Each period — the local date of a weekly occurrence, the local month of a monthly one — is claimed in the database
(`ReportDelivery`, unique on schedule and period) **before** anything is sent. A restart, a second API process, or a
sweep that runs twice finds the claim and sends nothing. If the server stops between claiming and sending, that
period stays *sending* and is not retried: a missed report can be fixed by a person; a duplicate CSV in someone's
mailbox cannot be taken back.

If the server was not running when a report fell due, it is still sent when the server comes back **within a day**.
After that the period is recorded as **missed** rather than sent days late as if it were on time.

### Time zones and daylight saving

The update-window rules (0.32) apply, so a schedule and an update window never disagree about a clock:

- A time that does not exist that night (02:30 when clocks jump from 02:00 to 03:00) is sent **at the jump**.
- A time that happens twice (01:30 when clocks fall back) is sent **the first time** only — the period key is the
  date, so there is no second delivery an hour later.

### Each delivery's result

The schedule shows its last deliveries: **sent**, **partly sent** (some recipients failed), **failed** (with the
reason), **blocked by containment**, **missed**, or **sending**. Each send is audited as `REPORT_SCHEDULE_SENT` or
`REPORT_SCHEDULE_FAILED`.

### The sweep

The API checks for due schedules every 60 seconds (`REPORT_SCHEDULE_SWEEP_SECONDS`, minimum 2), at most 20 per pass,
each to at most 10 recipients. `REPORT_SCHEDULE_SWEEP=off` stops it in a process — use it for any scratch API pointed
at a database with schedules in it.

## Containment: stopping all mail

The **Outbound email** (`notifications`) containment kind stops every email: alert emails, scheduled reports,
confirmation links and test messages, for one business or for everything. A scheduled report that falls due during
a pause is recorded as *blocked* and is not sent later. See [Containment](containment.md).

It is its own kind, not part of *ClientSt0r jobs*, because they answer different incidents. **Alert webhooks are not
covered**: they go to systems the MSP or business configured as its own, and monitoring keeps telling people during
a pause by design.

## Upgrading

0.34 adds the `nodemailer` production dependency and migration `0054_outbound_email`. Regenerate the API's deploy
manifest and run `npm install --omit=dev` at the target, and apply the migration (see `CLAUDE.md`, *Deploying*).
Email stays off until a Platform Admin configures it.

## Not done

- No HTML email, no per-person digest, no "send now" button for a schedule.
- No DKIM signing by rem0te itself: sign at the relay.
- No bounce handling: an address that bounces stays confirmed until someone removes it.
