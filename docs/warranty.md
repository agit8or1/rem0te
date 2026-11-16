# Hardware warranty and support links

From 0.56, every computer's page has a **Warranty & support** card next to its Hardware card. The card has links to
the manufacturer's support, warranty and driver pages for that machine, and it shows the computer's warranty end
date: where it came from, how many days are left, and whether it is ending soon. The dates appear in four other
places too:

- a **Warranty** column and filter in the device list;
- a **Reports → Warranty** report with a CSV export;
- a tile on the dashboard;
- an opt-in **Warranty expiring** monitor.

Nothing on the card or in the list asks a vendor anything. The links are built in the browser from what the
computer's firmware reported. A warranty date comes from one of two places:

- a person entered it by hand;
- a Platform Admin switched on an automatic lookup for **Dell** or **Lenovo**. These are the only two vendors with a
  lookup, and it is off by default.

## Support links

The card recognises the manufacturer string the computer reports, so `Dell Inc.`, `DELL` and
`Dell Computer Corporation` are all Dell. It recognises these vendors:

| Vendor | Links | Serial in the link? |
|---|---|---|
| Dell | Product support (overview), drivers and downloads | **Yes**, the 7-character service tag, after a charset check, URL-encoded |
| Lenovo | Warranty lookup, support and drivers | No: copy the serial and paste it on the page |
| HP | Warranty check, drivers and software | No |
| HPE (ProLiant, Synergy and the rest, including those reporting as "HP") | Warranty check, support center | No |
| Microsoft Surface | Surface warranty, drivers and firmware | No |
| Apple | Check coverage, support | No |
| ASUS | Warranty status, download center | No |
| Acer | Warranty lookup, drivers and manuals | No |

Only Dell has a stable URL that takes the serial. For every other vendor, the card links to the vendor's fixed page
and shows a **Copy serial** button. The serial is never placed in that vendor's URL.

A serial goes into a link only when it is 4 to 40 letters, digits and hyphens. The card rejects placeholders such as
`To be filled by O.E.M.`, `Default string`, `0000000000`, `None` and `System Serial Number`. Every link opens in a
new tab with `rel="noopener noreferrer"`, so the vendor's page cannot reach back into the console.

**Virtual machines.** VMware, Hyper-V (Microsoft, "Virtual Machine"), QEMU/KVM, VirtualBox, Xen, Parallels, Amazon
EC2 and Google Compute Engine guests show *Virtual machine — no hardware warranty*, with no links. They are never
looked up. The report counts them separately among the unknowns.

An unknown manufacturer gets no links. Enter its dates by hand.

## Entering dates by hand

Anyone with **Edit computers** on the computer can choose **Enter dates by hand** and fill in:

- the end date (required);
- the start date (optional);
- a short coverage note (optional), for example *ProSupport Plus, next business day*. It allows up to 200 letters,
  digits, spaces and `. , : ; ( ) / & + ' # -`.

**Clear** removes the entry. Every save is audited as `WARRANTY_SET`, recording the dates and coverage before and
after. The save is conditional on the dates you loaded. If someone else changed them while you were editing, the
save is refused (`WARRANTY_CHANGED`) and you reload.

An entry made by hand is **never overwritten by a vendor lookup**. Clear it if you want the lookup to fill it.

## Automatic lookup (Dell and Lenovo)

**Settings → Warranty** is for Platform Admins only. Saving there asks you to confirm it is you, under the catalog
key *Warranty lookups* in Settings → Confirm it is you. A lookup can be switched on for each vendor:

| Vendor | What you need | Where it comes from |
|---|---|---|
| Dell | A TechDirect **client id** and **client secret** for the Warranty API | Dell TechDirect → APIs → request Warranty API access |
| Lenovo | A Lenovo **ClientID** token for the warranty API (v2.5) | Lenovo partner / PSREF API access |

**When it is on, the computer's serial number is sent to that vendor.** Only the serial is sent, as the Dell service
tag or the Lenovo `Serial`. Nothing else goes with it: no computer name, hostname, user, business or model. The
settings page says this beside the switch.

The key is stored encrypted, sealed with its own purpose (`rem0te-warranty-key-v1`). It never appears in a response,
an audit row or a log. The page shows only its last four characters, and you cannot read it back. Changing the Dell
client id drops the old secret. `WARRANTY_SETTINGS_CHANGED` records whether a key was set, kept or cleared, never
the key itself.

There is no automatic lookup for HP, HPE, Microsoft Surface, Apple, ASUS or Acer:

- HP's warranty API is a batch-job service with a separate onboarding. It is a documented TODO in
  `apps/api/src/warranty/client.ts`.
- The others have no public warranty API.

Enter their dates by hand.

### The sweep

Once a lookup is on, a background sweep runs every 10 minutes (`WARRANTY_SWEEP_SECONDS`). It asks about computers
that meet all of these:

- the computer is active, has reported a recognised Dell or Lenovo manufacturer and a usable serial, and has no
  manual entry;
- it has not been asked about in the last **30 days**. After a failure that may pass, such as a timeout or a
  vendor 5xx, it is asked again after a day;
- its business is not under an `integration` containment pause. A global pause stops every lookup. *Check now*
  honours the same pause.

There are two limits:

- at most `WARRANTY_LOOKUPS_PER_HOUR` computers an hour (default 60, at most 500);
- at most 25 in any one pass.

Each computer is claimed with a conditional write before it is asked about, so two API processes never ask twice.
The sweep's lookups are not audited one by one. Each computer records when it was last asked and the result, and
the card shows that.

`WARRANTY_SWEEP=off` stops the sweep. The test runners set it.

**Check now** on the card asks the vendor about one computer straight away. It needs **Edit computers**. It is
audited as `WARRANTY_LOOKUP_REQUESTED`, which names only the vendor.

Every request goes through the same outbound client as the AI provider (`common/safe-https.ts`), which:

- uses fixed public HTTPS hosts (`apigtwb2c.us.dell.com`, `supportapi.lenovo.com`);
- resolves the address and checks it on every call;
- verifies certificates;
- refuses redirects;
- times out after 20 seconds and refuses an answer over 256 KB.

When the vendor returns several entitlements, the latest end date wins, together with that entitlement's coverage
text. The coverage text is reduced to the same inert charset as a manual entry.

## The device list

The device list has a **Warranty** column. It is off by default: turn it on from *Columns*. It shows the state, and
for a known vendor, a link to the vendor's page.

The Warranty filter is under *More filters*. Its values:

- **Expired**;
- **Ends within 30 / 60 / 90 days**. These do not include warranties that have already ended;
- **More than 90 days left**;
- **Unknown**: no date stored.

Sorting by warranty puts the soonest end date first and unknown dates last. The CSV export includes the state and
the end date. A rule-based device group can select on the warranty filter too.

## Reports → Warranty

Reports → Warranty needs **View computers** and covers only the computers you can see, by the same visibility rule
as the device list. It shows:

- figures for expired, within 30 days, within 90 days and unknown;
- a table by business;
- a list of every computer that has expired or ends within 90 days.

The CSV export (audited) lists every computer with its manufacturer, model, serial, state, days left, dates, source
and coverage. The report cannot be scheduled by email.

## The dashboard

The dashboard's **Warranty** tile counts computers that have expired or end within 30 days, among those you can see.
Hover over it for the 90-day and unknown counts. It links to the report.

## The Warranty expiring monitor

**Warranty expiring** (`WARRANTY_EXPIRING`) is a monitor kind you add yourself, in Settings → Monitoring, for
everyone, a business, a site, a group or one computer. It is **not** one of the recommended monitors, and nothing
creates it for you.

Its one setting is **days before** (1 to 365, default 30). The monitor raises **one alert per computer** when the
stored end date is within that many days, or has passed. The alert names the date. If the date moves while the alert
is open, for example after a renewal you enter by hand or a vendor answer, the old alert closes as *the warranty end
date changed* and a new one names the new date. If the date moves out of the window, the alert resolves. A computer
with no date never raises one.

The monitor is evaluated by the monitoring sweep (every 60 seconds) from stored dates only. It never asks a vendor.

## What is not proven

- **No real Dell or Lenovo API has been called from this server.** Both lookups are built from the vendors'
  published documentation:
  - Dell: TechDirect OAuth client credentials, then `GET /PROD/sbil/eapi/v5/asset-entitlements?servicetags=`;
  - Lenovo: `GET /v2.5/warranty?Serial=` with a `ClientID` header.

  Both are tested only against a loopback stand-in. Expect to adjust the response parsing the first time a real
  answer comes back. When an answer cannot be read, the computer's last result is `RESPONSE_INVALID` and nothing
  is stored.
- The vendors' support URLs were taken from their public sites in November 2026, and vendors move pages. Only
  Dell's takes the serial.
