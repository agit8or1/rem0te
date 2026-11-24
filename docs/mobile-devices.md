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
The Apple steps call nothing; Apple's pages open in a new tab and you upload
what they give you. From 0.85, Android's steps 3, 5 and 6 call Google's
Android Management API from the server (never from the browser). Each step says what Rem0te checks and what it
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
   proven" until a push is answered and the device connects (step 6).
6. **Enroll a test iPhone or iPad** (0.84). Install Rem0te's device CA on
   the server (`deploy/mdm-ca/rem0te-mdm-ca-setup.sh`) and upload its root
   and intermediate, then the profile-signing certificate and key it issued
   (the key is sealed). Create a **one-time enrollment link** for a business
   (an hour by default, at most a day), open it in Safari on the device and
   install the profile. The device gets its identity certificate from the
   CA over ACME, with Apple's attestation. Rem0te then asks it only for
   inventory, once a day. See [own-mdm.md](own-mdm.md#m2-as-built-0840).
   **No real device has enrolled from this server yet.**
7. **Renew every year with the same Apple Account.** A certificate with a
   different topic is refused on renewal, because every enrolled device would
   have to enroll again; replacing the topic is a separate action that says
   so. Reminders are raised as security alerts 30, 14 and 3 days before
   expiry, and once on expiry (held by a global `notifications` pause).
8. **Apple Business Manager** — planned (M6).

**Android** (0.85 *Mooring*, [own-mdm.md M3](own-mdm.md#m3-as-built-0850)):

1. **Before you start**: the prerequisites, with Google's permitted-use rule
   (decision 21: Rem0te is an MSP platform for customers' devices).
2. **The service-account key file.** Rem0te checks its shape offline, seals
   it, and shows only the project, the service-account e-mail and the key
   id's last four.
3. **Test the connection.** Rem0te signs a token request with the key,
   exchanges it at Google, and makes one read call. A refused key or a
   missing role is named. Quota cannot be checked.
4. **Record the device quota** Google granted. Rem0te cannot read it.
5. **Bind a business** to its own Android enterprise. Rem0te gets a one-time
   sign-up link from Google (30 minutes, for that business), which you open
   or send to the business's admin; they sign in, ideally with a managed
   Google domain. Google sends the browser back to Rem0te, which creates the
   enterprise.
6. **The default policy and enrollment tokens.** The policy turns on only the
   software and app reports, never network info (IMEI, MAC addresses). A
   one-time token, an hour by default, is shown once as a QR code and a link,
   for a **work profile** on a personal phone (kept as BYOD, never with its
   serial) or a **fully managed** company phone.

The MDM sweep then lists each enterprise's devices (model, Android version,
ownership, compliance) and any Operations, here and under Mobile devices.
Rem0te sends no command to an Android device. **No real Google API has been
called, no enterprise has been created and no device has enrolled**: it is
proven against a loopback stand-in in the shape of Google's API.

Every change asks you to confirm it is you when **Mobile device management
setup** (`mdm.setup`) asks in Settings → Confirm it is you (off by default).
Deleting a credential never asks, and is audited; deleting the push
certificate orphans every enrolled device, and the page says so.

Rem0te installs no app on a phone or tablet. The Rem0te agent is for
Windows, Linux and macOS computers only. An iPhone or iPad is enrolled with a
configuration profile from a one-time link, and is then managed by the
operating system's own MDM client, with Rem0te as the server. A device
enrolled with another provider is managed by that provider.

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

## Locking a lost device (0.86)

From 0.86.0 *Lighthouse* a phone or tablet enrolled in Rem0te's own MDM can be
sent three commands from its page, under **Lost or stolen**:

| Command | iPhone and iPad | Android |
|---|---|---|
| **Lock** | Every enrolled device. Shows an optional message and phone number on the lock screen | Every enrolled device. On a personal phone with a work profile it locks the work profile when that has its own passcode, and the whole phone when it does not. No message |
| **Start lost mode** | **Supervised devices only.** A device that has not reported whether it is supervised is treated as unsupervised. Needs a message or a phone number | **Company-owned devices only.** Refused on a personal device. Needs a message or a phone number |
| **Stop lost mode** | Supervised devices only | Company-owned devices only |

Nothing can be erased, wiped or retired from Rem0te. Those come later, behind a
second person ([own-mdm.md](own-mdm.md#roadmap), M5).

Sending needs a second permission, **Lock mobile devices and use lost mode**
(`mobile:act`):

| | May send |
|---|---|
| Platform Admin | To any business's device |
| Business Owner | To their business's devices |
| Business User | Only if the Business Owner grants it. Off by default |
| MSP technician | Only with it on an assignment covering the **whole** business. No preset grants it |

*Settings → Confirm it is you* can ask for re-authentication first, under
**Mobile device lock and lost mode** (`mdm.act`). Like every function, it is off
until turned on. An **approved actions** containment pause refuses every
command, and on an iPhone or iPad it also holds one already waiting. An
**integration** pause also refuses an Android command, because sending is a
call to Google.

A button the device cannot take is shown disabled, with the reason. The
message and phone number go to the device and nowhere else: they are in no
audit entry or log, and Rem0te keeps them only while an iPhone or iPad has
still to fetch the command. Every command is audited when it is asked for and
when it is sent, with who asked.

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
| Queued | Rem0te has it and has not sent it (0.86: only for the moment before a lock or lost mode is handed over) |
| Sent to provider | Sent, or issued in the provider's own console |
| **Accepted by provider** | The provider took it. **The device has not necessarily done anything**. For Rem0te's own Apple MDM, this is the device fetching the command; for Android, Google accepting it |
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

Until 0.86 every command shown came from the provider. From 0.86 a lock or
lost mode sent from Rem0te shows who asked; for Android, Rem0te reads only the
results of the commands it issued (each by its own name), so commands made
elsewhere are not shown. *Wipe*,
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
real provider's host name appears anywhere in the MDM module (0.84: except
Apple's push host, once, in `mdm/apple/apns.ts`), and nothing in the console
or the API creates a stand-in connector. From 0.84 the sync creates one
`apple` connector for each business with an enrolled iPhone or iPad; it reads
Rem0te's own tables and calls nothing.

## What has been tested

| | Evidence |
|---|---|
| The command state machine, the provider record schemas, the closed lists against 0096 | Unit (`apps/api/scripts/unit-mdm.mjs`, in CI) |
| Sync, scope, default deny, cross-tenant refusal, accepted vs completed, bounds, pause, the database's refusals | API, against the stand-in only (`apps/api/scripts/e2e-mdm.mjs`) |
| The pages at desktop and phone width, light and dark | Browser (`apps/web/scripts/e2e-ui.mjs`) |
| A real provider, a real phone or tablet | **None.** No provider has been called from this server |
| Settings → Mobile devices (0.83): the CSR, vendor signing, certificate checks, the topic rule, the Google key, reminders | Unit (`unit-mdm-setup.mjs`, in CI) and API (`e2e-mdm-setup.mjs`), with stand-in keys and certificates made at run time; Browser (`e2e-ui.mjs`). **No real Apple or Google credential, and no call to either** |
| Rem0te as the Apple MDM server (0.84): links, the signed profile, signed check-ins, the inventory queue, the push, the `apple` driver | Unit (`unit-mdm-apple.mjs`, in CI); API (`e2e-mdm-apple.mjs`): **mdmb**, a simulated device, enrolling through a scratch step-ca, and a loopback HTTP/2 stand-in for APNs; Browser (`e2e-ui.mjs`). **No real iPhone or iPad, and no call to Apple's push service** |
| Lock and lost mode (0.86): who may send, the request's checks, which device can take what, the pauses, accepted then completed, nothing kept | Unit (`unit-mdm-lost-device.mjs`, in CI); API (`e2e-mdm-apple.mjs` with mdmb and hand-signed device messages; `e2e-mdm-android.mjs` against the AMAPI stand-in); Browser (`e2e-ui.mjs`, the dialog opened and cancelled). **No real device has received a command** |

## Planned

The order is now [own-mdm.md](own-mdm.md#roadmap)'s (2026-11-21):

- **M1** — Settings → Mobile devices: the setup wizard and Apple push
  certificates. **Built in 0.83.0**, above.
- **M2** — Apple enrollment, check-in and inventory, the first real driver.
  **Built in 0.84.0**, against a simulated device only.
- **M3** — Android enterprise sign-up and read-only inventory. **Built in
  0.85.0**, against a stand-in for Google's API only.
- **M4** (was 3.3) — lock and lost mode, with their own permission, audited,
  accepted and completed shown separately. **Built in 0.86.0**, against a
  simulated device and a stand-in only. Locate is not built (it needs lost mode
  and a decision about keeping a location).
- **M5** (was 3.4) — wipe, retire and work-data removal, approved by a second
  person.
