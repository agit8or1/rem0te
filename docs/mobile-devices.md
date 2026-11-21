# Mobile devices (MDM)

*0.80.0 "Tablet".* Rem0te can show iPhones, iPads and Android devices as a
mobile-device-management (MDM) provider reports them: model, OS, ownership,
enrollment, compliance and the commands the provider has run. It is
**read-only**, and in this release **no real provider can be connected**: the
page says **Requires setup** and lists what each kind of provider needs.

What 0.80 builds is the part that does not need an account: the data model,
a provider-neutral driver interface, a sync, the read-only routes and the
console pages, all proven against a loopback stand-in that only the test
suites can reach.

> **Changed on 2026-11-21: Rem0te becomes its own MDM.** The owner decided
> against connecting a third-party provider: Rem0te will be the MDM server for
> iPhones and iPads and the EMM for Android (through Google's Android
> Management API), set up in **Settings → Mobile devices**. That supersedes
> decision 18 and roadmap 3.2 below. The design, what has to be obtained from
> Apple and Google, and the new order of work are in [own-mdm.md](own-mdm.md).
> The data model and driver interface on this page stay: the own MDM is their
> first real driver.

## Settings → Mobile devices (0.83)

A Platform Admin sets the own MDM up in **Settings → Mobile devices**. It is
platform-wide: one Apple push certificate for the whole install (decision 23).
Nothing on the page calls Apple or Google; their pages open in a new tab and
you upload what they give you. Each step says what Rem0te checks and what it
cannot, and shows one of the four capability states.

**Apple** (iPhone and iPad, iOS/iPadOS 16 or later, decision 24):

1. **Before you start.** A D-U-N-S number, an Apple Developer Program
   membership as an organization (99 USD a year), Apple's "MDM CSR"
   permission (asked for by the Account Holder; no published lead time), and a
   company Apple Account to own the push certificate. Tick them as you go: the
   ticks are your notes, never checks.
2. **Generate the push request.** Rem0te makes the key and the CSR. The key is
   sealed in Rem0te and never leaves it. Download the CSR if another party
   signs it.
3. **Sign the request** — with your own MDM vendor certificate (decision 22):
   upload the certificate from your developer account, its private key, and
   Apple's WWDR intermediate and root (from Apple PKI). Rem0te checks they
   belong together and are unexpired, seals the key, and gives you the signed
   request. It shows the root's SHA-256 for you to compare with Apple's; it
   cannot tell from here that the root is Apple's. *mdmcert.download* is shown
   only as a way to try one test device while Apple's permission is pending,
   with why it must not be used for the fleet.
4. **Upload the request to Apple** at identity.apple.com with the company
   account, and download the push certificate.
5. **Upload the push certificate**, and type which Apple Account made it.
   Rem0te refuses a certificate that is not for its key, has no push topic,
   has expired or is not yet valid. It shows the topic
   (`com.apple.mgmt.External.<uuid>`) and the expiry, and says "not yet
   proven" until a real device has been pushed to (M2).
6. **Renew every year with the same Apple Account.** A certificate with a
   different topic is refused on renewal, because every enrolled device would
   have to enroll again; replacing the topic is a separate action that says
   so. Reminders are raised as security alerts 30, 14 and 3 days before
   expiry, and once on expiry (held by a global `notifications` pause).
7. **Apple Business Manager** — planned (M6).

**Android:** the prerequisites, with Google's permitted-use rule (decision
21: Rem0te is an MSP platform for customers' devices), then the
service-account key file. Rem0te checks its shape offline, seals it, and shows
only the project, the service-account e-mail and the key id's last four.
Testing it against Google, enterprise sign-up and quota are planned (M3).

Every change asks you to confirm it is you when **Mobile device management
setup** (`mdm.setup`) asks in Settings → Confirm it is you (off by default).
Deleting a credential never asks, and is audited; deleting the push
certificate orphans every enrolled device, and the page says so.

Rem0te never installs anything on a phone or tablet. The Rem0te agent is for
Windows, Linux and macOS computers only. A mobile device is enrolled in the
provider, and the provider manages it.

## What a provider needs

These are the prerequisites from the [session, maintenance, MDM and backup
audit](session-maintenance-mdm-backup-audit.md#phase-3-mdm-iosipados-and-android).
They are the provider's, not Rem0te's, and every one of them has to exist
before a connector can read anything.

| | Third-party MDM (for example Microsoft Intune) | Android Management API | Native Apple MDM |
|---|---|---|---|
| What Rem0te would be | A reader of the customer's existing MDM (and later a command relay) | An EMM: Google holds the device channel; Rem0te holds policies and reads state | The MDM server itself: check-in and command endpoints, device certificates |
| What has to exist first | The customer's provider tenant; an app registration or API account with **read-only** scopes; a provider licence per device | A **Google Cloud project** with the API on, a service account, Pub/Sub for notifications, and an **enterprise** per customer. Since October 2025 a new project has **no device quota**: up to 500 devices needs a business justification, more needs a separate application, at most two projects per developer. Reviews have taken weeks, so ask early | An **MDM Vendor CSR Signing Certificate** from Apple (requested by the Account Holder of an Apple Developer Program or Enterprise Program account). Per customer, an **APNs MDM push certificate**, renewed **every year with the same Apple Account** or every enrolled device is orphaned. **Apple Business Manager** (or School Manager) for automated enrollment and supervision. Managed Apple Accounts for User Enrollment |
| Ownership | As the provider reports it (Intune: company or personal) | Fully managed (corporate) or work profile (personal) | Supervised (corporate) or User Enrollment (personal) |
| Accepted vs completed | Action results: pending, done, failed | Long-running Operations; `done` and the device's report are separate | APNs push is fire-and-forget; completion is the device's next check-in |
| Effort | Lowest: one connector | Medium | Highest |
| Planned | **3.2**, first | After 3.2; quota requested early | Last, if ever |

The owner accepted this order on 2026-11-21 (decision 18): the interface and a
stand-in first, then the existing provider read-only. **Superseded the same
day** by the owner's own MDM ([own-mdm.md](own-mdm.md)), which builds the
Native Apple and Android Management API columns itself and drops the
third-party one. Providers must be on
public DNS with verified TLS (decision 17): a connector goes through the same
outbound HTTPS client as AI and PSA connectors, which refuses private
addresses, redirects and unverified certificates.

## Who can see mobile devices

A new permission, **View mobile devices** (`mobile:view`).

| | Sees mobile devices |
|---|---|
| Platform Admin | Every business's (or one, chosen) |
| Business Owner | Their business's |
| Business User | Only if the Business Owner grants *View mobile devices*. Off by default |
| MSP technician | Only with *View mobile devices* on an assignment covering the **whole** business. No preset grants it |

It is separate from *View computers* because a phone list (names, models, and
whether it is somebody's own phone) is a different disclosure from the
computer inventory, and the people who look after desktops are not always the
ones who should see staff phones. A technician assignment that names
particular computers cannot name a phone, so only a whole-business assignment
counts.

Everyone is held to their own business. Naming another business is refused
(403), and asking for a device or its commands by the id of one in another
business, or another tenant, is "not found" (404).

## What is kept

| Kept | Why |
|---|---|
| Name, platform (iOS, iPadOS, Android), model, manufacturer, OS version | To find and recognise the device |
| Ownership (corporate or personal) and what is managed (the whole device, an Android work profile, or Apple User Enrollment's managed apps and data) | Decides what can ever be done to it: a personal device's management can only remove the work data |
| Enrollment state and date, last check-in | Whether the provider still reaches it |
| Compliance state and the provider's reason | The provider evaluates; Rem0te shows |
| Storage total and free | Inventory |
| Serial number, **corporate devices only** | Asset records and, later, warranty. A personal device's serial is dropped before it is stored, and the database refuses one |
| Command history | What the provider ran, and how far each command got |

**Not kept**, even if a provider sends it: the IMEI or MEID, phone number,
Wi-Fi and Bluetooth MAC addresses, and the signed-in user. They are not in the
record Rem0te parses, so they are stripped on arrival. The IMEI identifies a
phone line as much as a device, and nothing planned needs it: commands address
the provider's own device id.

A device the provider stops returning, in a complete listing, is marked
**No longer reported** and hidden from the list unless you ask for it. Nothing
is deleted.

## Commands: accepted is not completed

Every command moves through six states:

| State | Means |
|---|---|
| Queued | Rem0te has it and has not sent it (from 3.3; nothing is queued in 0.80) |
| Sent to provider | Sent, or issued in the provider's own console |
| **Accepted by provider** | The provider took it. **The device has not necessarily done anything** |
| **Completed on device** | The device itself reported it done |
| Failed | The provider refused it, or the device reported a failure (with the code) |
| Expired | Not finished by its deadline (the provider's, or seven days) |

*Accepted by the provider* and *Completed on the device* are two timestamps,
`providerAcceptedAt` and `deviceCompletedAt`, shown side by side on the
device's page and never merged into one "done". A lock the provider accepted
an hour ago and the phone has not picked up is shown as exactly that.

The rules (`apps/api/src/mdm/command-state.ts`, and the same shape as CHECKs in
migration 0096):

- A device completion is recorded only after a provider acceptance. A report
  that says "completed" with no acceptance is refused and counted, never
  back-filled: the command stays *Sent*.
- Once accepted, only the device can fail a command; the provider can no
  longer reject it.
- Completed, failed and expired are final. A later report never moves them,
  and the database refuses to.

In 0.80 every command shown came from the provider's own console. *Wipe*,
*Retire* and *Remove work data* are marked **Destructive**; when they can be
sent from Rem0te (3.4) they will need a second person to approve (decision
16).

## The sync

The API reads each enabled connector at most once an hour
(`MDM_SYNC_MINUTES`, with a 15-minute floor outside the test suites), from a
sweep that looks every five minutes (`MDM_SWEEP_SECONDS`). It is bounded:

- at most 20 connectors a pass;
- at most 20 pages of 100 devices and 10 pages of 100 commands per connector
  per pass. A listing cut off by the bound is recorded as **partial**, and
  only a complete listing marks devices *No longer reported*;
- every page and record is parsed strictly. A page that is not one is
  **bad response**; a single malformed device or command is skipped and
  counted;
- a business under an *integration* containment pause is skipped
  (**paused**), and its provider is not asked;
- a connector is claimed with a conditional write before it is read, so two
  API processes never read the same one at once.

`MDM_SWEEP=off` stops it. *Admin → Security* reports the switch as off. It is
off in every test suite except the one that proves it.

## The stand-in

The only connector in 0.80 is a **stand-in**: a small HTTP server the test
suite runs on `127.0.0.1`, answering in the provider-neutral shape the sync
parses. The API reaches it only when `NODE_ENV` is `test` and
`MDM_TEST_BASE_URL` is exactly `http://127.0.0.1:<port>`. Under any other
setting it is **not ready**, the sync records that, and no request is made. No
real provider's host name appears anywhere in the MDM module, and nothing in
the console or the API creates a connector.

## What has been tested

| | Evidence |
|---|---|
| The command state machine, the provider record schemas, the closed lists against 0096 | Unit (`apps/api/scripts/unit-mdm.mjs`, in CI) |
| Sync, scope, default deny, cross-tenant refusal, accepted vs completed, bounds, pause, the database's refusals | API, against the stand-in only (`apps/api/scripts/e2e-mdm.mjs`) |
| The pages at desktop and phone width, light and dark | Browser (`apps/web/scripts/e2e-ui.mjs`) |
| A real provider, a real phone or tablet | **None.** No provider has been called from this server |
| Settings → Mobile devices (0.83): the CSR, vendor signing, certificate checks, the topic rule, the Google key, reminders | Unit (`unit-mdm-setup.mjs`, in CI) and API (`e2e-mdm-setup.mjs`), with stand-in keys and certificates made at run time; Browser (`e2e-ui.mjs`). **No real Apple or Google credential, and no call to either** |

## Planned

The order is now [own-mdm.md](own-mdm.md#roadmap)'s (2026-11-21):

- **M1** — Settings → Mobile devices: the setup wizard and Apple push
  certificates. **Built in 0.83.0**, above.
- **M2** — Apple enrollment, check-in and inventory, the first real driver.
- **M3** — Android enterprise sign-up and read-only inventory.
- **M4** (was 3.3) — lock, lost mode and locate, with their own permission,
  audited, accepted and completed shown separately.
- **M5** (was 3.4) — wipe, retire and work-data removal, approved by a second
  person.
