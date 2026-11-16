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
- a Platform Admin switched on an automatic lookup for **Dell**, **Lenovo**, **HP** or **Apple** (HP and Apple from
  0.61). Each lookup is off by default.

Every computer with no date says **why** (0.61): see [Why is there no date?](#why-is-there-no-date).

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

## Automatic lookup (Dell, Lenovo, HP, Apple)

**Settings → Warranty** is for Platform Admins only. Saving there asks you to confirm it is you, under the catalog
key *Warranty lookups* in Settings → Confirm it is you. A lookup can be switched on for each vendor:

| Vendor | What you need | Where it comes from |
|---|---|---|
| Dell | A TechDirect **client id** and **client secret** for the Warranty API | Dell TechDirect → APIs → request Warranty API access |
| Lenovo | A Lenovo **ClientID** token for the warranty API (v2.5) | Lenovo partner / PSREF API access |
| HP (0.61) | An HP Developer Portal app's **API key** and **API secret**, with the Warranty API enabled | See [Getting HP credentials](#getting-hp-credentials) |
| Apple (0.61) | An Apple Business Manager API account's **client id**, **key id** and **private key** (`.pem`) | Apple Business Manager → Preferences → API (an Administrator creates it and downloads the key once) |

**When it is on, the computer's serial number is sent to that vendor.** Only the serial is sent: the Dell service
tag, the Lenovo `Serial`, HP's `sn`, or the serial in Apple's device path. Nothing else goes with it: no computer
name, hostname, user, business or model. HP's API also accepts an optional product number (SKU); the agent's
inventory does not collect one, so none is sent. The settings page says this beside the switch.

The key is stored encrypted, sealed with its own purpose (`rem0te-warranty-key-v1`). It never appears in a response,
an audit row or a log. The page shows only its last four characters, and you cannot read it back. Changing the Dell
client id, the HP API key, or Apple's client id or key id drops the old secret. `WARRANTY_SETTINGS_CHANGED` records
whether a key was set, kept or cleared, never the key itself. Apple's private key is checked to be an EC P-256
private key before it is saved (PKCS#8 or `EC PRIVATE KEY` PEM), and stored as PKCS#8.

### Getting HP credentials

HP Inc.'s Warranty API is free, but HP approves each account:

1. Create an account (or sign in) at **developers.hp.com**.
2. Submit the **CSS API enrolment** form at **developers.hp.com/css-enroll**. Say you want the **Warranty API** for
   the HP computers you manage.
3. **Wait for HP** to tell you the Warranty API is enabled on your account. HP's customer advocacy team reviews the
   request, sometimes with your HP account manager (warrantyapi.customers@hp.com is the contact some vendors give).
   Third-party reports say HP has refused some IT-service companies; there is nothing this server can do about that.
4. In the portal, **create an app** with the Warranty API and copy its **API key** and **API secret**.
5. In Rem0te, **Settings → Warranty → HP**: paste the API key and the secret, tick *Look up HP warranties*, save
   (you will be asked to confirm it is you).
6. Open one HP computer and press **Check now with HP**. Read the result before leaving the sweep to do the rest.

How the HP lookup works: an OAuth client-credentials token from `warranty.api.hp.com/oauth/v1/token` (the key and
secret as HTTP Basic), then HP's batch-job API with one serial per job: `POST /productwarranty/v2/jobs` with
`[{"sn":"<serial>"}]`, `GET /productwarranty/v2/jobs/<id>` until the status is *completed* (at most six polls, about
30 seconds), then `GET /productwarranty/v2/jobs/<id>/results`. The latest-ending `offers[]` entry
(`serviceObligationLineItemEndDate`) gives the end date and its `offerDescription` the coverage; the earliest start
is the start. A job that has not finished is `VENDOR_PENDING` and is asked again within a day. HP's synchronous
`/queries` endpoint is reported as deprecated in favour of jobs, so it is not used. The token is kept in memory for
its lifetime (about an hour) so a sweep does not ask for one per computer.

**HP rate limits are not published.** Each HP lookup is several requests (a job, one to six status polls, the
results). If HP answers `429`, the computer's result is *rate limited* and it is asked again within a day; lower
`WARRANTY_LOOKUPS_PER_HOUR` if that keeps happening.

**HP is not HPE.** HP workstations and PCs (Z440, Z840, EliteDesk, EliteBook…) are HP Inc.'s and are looked up
here. ProLiant, Synergy, Apollo and the other servers, including old ones whose firmware says *Hewlett-Packard*, are
HPE's: HP's API does not cover them.

### Apple

The Apple lookup uses the **Apple Business Manager API** (*Get AppleCare coverage for a device*). Each token request
carries a client assertion signed here with the API account's private key (ES256, valid for five minutes, the key id
in its header), exchanged at `account.apple.com/auth/oauth2/token` for a token with the `business.api` scope; then
`GET api-business.apple.com/v1/orgDevices/<serial>/appleCareCoverage`. Cancelled plans are ignored; the latest end
date wins. **Only devices in your organisation's Apple Business Manager are known to it** — a Mac bought elsewhere
is *no record*.

### Vendors with no lookup

There is no automatic lookup for these, and the console says so on the computer's card, in the report and in
Settings → Warranty. Enter their dates by hand.

- **HPE.** HPE publishes no warranty API a customer can sign up for. Its Support Center *Warranty Check API*
  (`api-gw.support.hpe.com/…/warrantyCheck`) was a pilot that closed to new applicants, with no published request or
  response format. HPE GreenLake's Compute Ops Management has a documented `server-warranty` API, but it covers only
  servers already onboarded to a Compute Ops Management subscription, by GreenLake device id, through regional
  GreenLake hosts and a GreenLake workspace credential — not a serial lookup this server can make.
- **Microsoft Surface.** No public warranty API: coverage is shown in the Surface Management Portal (in Intune) and
  on mybusinessservice.surface.com.
- **ASUS** and **Acer.** No public warranty API: their pages take one serial at a time.

### The sweep

Once a lookup is on, a background sweep runs every 10 minutes (`WARRANTY_SWEEP_SECONDS`). It asks about computers
that meet all of these:

- the computer is active, has reported a manufacturer whose lookup is switched on and a usable serial, and has no
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

- uses fixed public HTTPS hosts (`apigtwb2c.us.dell.com`, `supportapi.lenovo.com`, `warranty.api.hp.com`,
  `account.apple.com`, `api-business.apple.com`), and nothing else;
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
- a list of every computer that has expired or ends within 90 days;
- (0.61) **No warranty date: why** — every computer with no date except virtual machines, with the reason, the
  ones a Platform Admin can fix in Settings → Warranty first, and the counts by reason.

The CSV export (audited) lists every computer with its manufacturer, model, serial, state, days left, dates, source,
coverage and (0.61) *Why no date*. The report cannot be scheduled by email.

## Why is there no date?

From 0.61, a computer with no warranty date says why — on its Warranty & support card, in the report and its CSV —
worked out from what is stored, never by asking a vendor:

| Reason | What it means | What to do |
|---|---|---|
| No hardware inventory yet | The agent has not reported the maker and serial | Wait for the inventory |
| Virtual machine | No hardware warranty | Nothing |
| Manufacturer not recognised | Not one of the vendors above | Enter the dates by hand |
| Vendor has no lookup | HPE, Microsoft Surface, ASUS or Acer (the card says why) | Enter the dates by hand |
| Serial missing | No serial, or a placeholder such as *To be filled by O.E.M.* | Enter the dates by hand |
| Lookup not switched on | The vendor has a lookup, but it is off in Settings → Warranty | A Platform Admin switches it on |
| Waiting for the lookup | It is on, and this computer has not been asked yet | Wait for the sweep, or press *Check now* |
| Vendor had no record | The vendor was asked and knows nothing of this serial | Enter the dates by hand |
| Lookup failed | The last lookup failed; the reason is shown (credential refused, rate limited, timed out…) | A refused credential is fixed in Settings → Warranty; the rest are asked again within a day |

The dashboard tile adds *N no date* to its line, and says how many of those a lookup that is not switched on could
answer.

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

- **No real Dell, Lenovo, HP or Apple API has been called from this server.** Every lookup is built from the
  vendors' published documentation and examples:
  - Dell: TechDirect OAuth client credentials, then `GET /PROD/sbil/eapi/v5/asset-entitlements?servicetags=`;
  - Lenovo: `GET /v2.5/warranty?Serial=` with a `ClientID` header;
  - HP (0.61): token, then the v2 batch-job API. HP's reference pages sit behind a sign-in, so the request and
    response shapes come from HP's published sample scripts and from open-source integrations that call it; the
    offer fields (`serviceObligationLineItemStartDate`, `…EndDate`, `offerDescription`) match a captured response
    published with one of them;
  - Apple (0.61): the client-assertion token and *Get AppleCare coverage for a device*, from Apple's developer
    documentation and its example response.

  All four are tested only against a stand-in on loopback that mimics those responses (including token refusal, no
  record, rate limits, unfinished and failed HP jobs). Expect to adjust the parsing the first time a real answer
  comes back: use *Check now* on one computer first. When an answer cannot be read, the computer's last result is
  `RESPONSE_INVALID` and nothing is stored.
- The HP product number (SKU) is not collected by the agent, so HP is asked by serial alone. HP's API takes the
  product number as optional; a recycled or ambiguous serial may come back as *no record* where the SKU would have
  found it. Collecting it (`Win32_ComputerSystem.SystemSKUNumber`) would be an agent and inventory change.
- The vendors' support URLs were taken from their public sites in November 2026, and vendors move pages. Only
  Dell's takes the serial.
