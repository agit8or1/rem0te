# Rem0te as its own MDM (design, 0.81.1; M1–M4 built in 0.83.0–0.86.0)

*Mostly design.* **M1, Settings → Mobile devices, is built in 0.83.0 *Beacon*** ([below](#m1-as-built-0830)):
the wizard, the Apple push key, CSR, vendor signing and push certificate, and the Google service-account key,
all offline. M2 (Apple enrollment and inventory, 0.84.0), M3 (Android, 0.85.0) and **M4, lost-device commands
(0.86.0 *Lighthouse*, [below](#m4-as-built-0860))** are built too. M5 onwards is still a plan. Decisions 21–24 were **decided** by the owner on
2026-11-21 ([below](#owner-decisions-this-raises)). On **2026-11-21** the owner decided: *"I don't have an MDM, I want
our OWN."* Rem0te itself becomes the mobile-device-management server for iPhones and iPads and the EMM for
Android, instead of a reader of a third-party MDM. That **supersedes decision 18** of the
[session, maintenance, MDM and backup audit](session-maintenance-mdm-backup-audit.md#owner-decisions), which had
put "the owner's existing provider, read-only" first and native Apple MDM "last, if ever". The owner also wants
provider setup in **Settings, with step-by-step instructions**.

This page is the plan: what each platform needs, what Rem0te would run, what the owner has to obtain from Apple
and Google, the Settings wizard, the security model, an invariant sketch, and the order of pull requests. It
builds on the data model, driver interface and stand-in of 0.80.0 *Tablet* ([mobile-devices.md](mobile-devices.md),
CLAUDE.md §90), and says how the own MDM becomes that interface's first real driver.

Every fact about Apple or Google below cites the vendor's own documentation. Where a fact could not be confirmed
from a primary source it says **unconfirmed**, and the PR that needs it must confirm it first. Nothing here has
called an Apple or Google API, and no phone or tablet has been used.

## Summary

| | Apple (iOS, iPadOS) | Android |
|---|---|---|
| What Rem0te is | **The MDM server.** Devices check in to Rem0te and fetch commands from it; Apple's push service only wakes them | **The EMM console.** Google's Android Management API (AMAPI) holds the device channel; Google's *Android Device Policy* is the on-device agent. Rem0te holds policies, enrollment tokens and the device list |
| Recommended approach | Build the MDM protocol core in the Nest API (check-in, command queue, APNs push), modelled on NanoMDM (MIT). Run **step-ca** (Apache-2.0) as a separate loopback service for device identity through ACME | AMAPI, called from the Nest API through `safe-https`. Poll the device list first; Pub/Sub (pull, outbound only) later. No own on-device app |
| Inbound from devices | Yes: check-in and command endpoints (under `/api/`, already routed), and an ACME directory (one new Caddy route) | **None.** Google talks to the device. The sign-up callback is an ordinary browser redirect |
| Outbound | `api.push.apple.com` (HTTP/2, the push certificate as TLS client certificate); later `mdmenrollment.apple.com` for Automated Device Enrollment | `oauth2.googleapis.com`, `androidmanagement.googleapis.com`; later `pubsub.googleapis.com` |
| The owner must obtain | An **APNs MDM push certificate** (free, yearly), which needs a CSR signed with an **MDM Vendor CSR Signing Certificate**: an Apple Developer Program organization membership (99 USD a year, D-U-N-S number) plus Apple granting the "MDM CSR" permission on request. Optional: **Apple Business Manager** for supervised, automated enrollment | A **Google account** to bind the enterprise (a work-domain account recommended), a **Google Cloud project** with a service account, and **device quota** granted by Google on a business justification. **Google's permitted-use policy is the main risk** (see [below](#the-permitted-use-question)) |
| What this host can prove | Profile and plist handling, CSR and certificate checks, the check-in and command loop against the **mdmb** device simulator (MIT), push against a loopback HTTP/2 stub | The REST calls against a loopback stand-in in AMAPI's shape |
| What needs real accounts and devices | Any real push, any real enrollment, attestation, ADE | Enterprise sign-up, quota, any enrollment |

## Architecture

```
                         ┌──────────────────────── Apple ────────────────────────┐
                         │  identity.apple.com     api.push.apple.com     ABM    │
                         │  (push cert, by hand)   (APNs, HTTP/2)   mdmenrollment│
                         └──────────▲─────────────────────▲──────────────▲──────┘
            owner uploads the       │                     │ push          │ ADE sync (later)
            signed request by hand  │                     │ {"mdm":magic} │ OAuth 1.0a session
                                    │                     │               │
 iPhone / iPad ──HTTPS──▶ Caddy (remote.agit8or.net :443) │               │
   │  check-in, PUT ServerURL ─▶ /api/v1/mdm/apple/* ─────┼──▶ Nest API :3001 ──────────────────────┐
   │  ACME (device identity) ──▶ /acme/rem0te-mdm/*  (NEW)│      mdm/apple/   protocol, queue,      │
   │                                │                     │                   profiles, APNs client  │
   │                                ▼                     │      mdm/drivers/apple.ts  (MdmDriver)   │
   │                      step-ca :127.0.0.1 (rem0te-mdm-ca user,              mdm/drivers/android.ts│
   │                      CA key unreadable by the portal)                     mdm-sync (MDM_SWEEP)  │
   │                                                                           secret-box, audit,   │
   ◀── wakes on APNs push (device keeps its own connection to Apple, 5223/443)  containment, approvals│
                                                                                         │         │
 Android phone ◀──── Android Device Policy ◀──── Google (AMAPI) ◀──── safe-https ────────┘         │
   (QR / afw#setup / link enrollment;            androidmanagement.googleapis.com                   │
    no Rem0te app on the phone)                  oauth2.googleapis.com (JWT bearer)                 │
                                                 pubsub.googleapis.com (pull, later)                │
                                                                                                    │
 Admin's browser ── Settings → Mobile devices (wizard) ── /api/v1/mdm/setup/* ──────────────────────┘
                     └─ Android sign-up: Rem0te → signupUrls.create → browser to Google →
                        Google redirects back to /api/v1/mdm/android/signup/callback?enterpriseToken=…
```

### Components

| Component | Where | What it does | New? |
|---|---|---|---|
| `mdm/setup/` | Nest API | The Settings wizard's state: push CSR and key, vendor signing, push certificate, ABM token, Google service account, enterprise binding. Every secret through secret-box | New |
| `mdm/apple/protocol/` | Nest API | Pure: plist parse and build, the check-in message types, command builders for a closed list, result parsers | New |
| `mdm/apple/` service and controller | Nest API, `/api/v1/mdm/apple/checkin` and `/api/v1/mdm/apple/server` | Answers check-ins (`Authenticate`, `TokenUpdate`, `CheckOut`), runs the command loop, verifies `Mdm-Signature` | New |
| `mdm/apple/apns.ts` | Nest API | The one APNs client: HTTP/2 to the fixed host, the push certificate as client certificate. A sibling of `safe-https` with the same rules ([below](#outbound-calls-and-safe-https)) | New |
| `mdm/apple/profile.ts` | Nest API | Builds and signs the enrollment `.mobileconfig` for a one-time enrollment link | New |
| step-ca | Separate service, `127.0.0.1` only, its own system user | The device-identity CA: ACME with Apple's `device-attest-01`. The portal never holds the CA key | New service |
| `mdm/drivers/apple.ts` | Nest API | The `apple` `MdmDriver`: `ready()` from the push certificate's state, listings from Rem0te's own Apple store (no network) | First real driver |
| `mdm/drivers/android.ts` | Nest API | The `android` `MdmDriver`: `enterprises.devices.list` through `safe-https` | Second real driver |
| `MobileDevice`, `MdmCommand`, `MdmConnector` | Postgres (0096) | Unchanged in shape. `PROVIDERS` gains `apple` and `android` | Extended |
| Caddy | Host | Already routes `/api/*` to the API. Needs **one** new route for ACME | One route, documented, not applied |

### How the own MDM becomes the first real driver

0.80's `MdmDriver` ([mobile-devices.md](mobile-devices.md)) is a reader: `ready`, `listDevices`, `listCommands`.
The own MDM keeps that shape, so the sync, the `not_reported` rule, the scope checks and the console pages are
reused unchanged.

- **Android is a natural fit.** `listDevices` pages `enterprises.devices.list`, and `listCommands` reads the
  Operations Rem0te issued. Both are network reads through `safe-https`, like any provider.
- **Apple is different, because the devices talk to Rem0te.** The check-in and command handlers write what
  devices report into Rem0te's own Apple tables (`AppleEnrollment`, `AppleCommand`, raw reports). The `apple`
  driver's listings read those tables, with no network, and return the same provider-neutral records that
  `schemas.ts` parses. Device data then enters `MobileDevice` through exactly one path, the sync, with the same
  charset checks and the same "not kept" rule (no IMEI, phone number or MAC; serial only on corporate devices).
  The check-in handler never writes `MobileDevice` itself.
- **`ready()`** for Apple is "a push certificate is installed, unexpired, and its topic matches"; for Android, "a
  service account key is sealed and the business has an enterprise". It never calls out (§90).
- **Sending** is added to the interface in the lost-device PR (audit 3.3), as 0.80 planned: `send(row, command)`.
  For Apple it enqueues a command and pushes; for Android it calls `devices.issueCommand`. The command state
  machine (`command-state.ts`) is used as it is: *accepted* is Rem0te's queue (Apple) or Google's Operation
  (Android); *completed* is only what the device itself reports.
- **One connector per business per platform.** `MdmConnector.provider` is `apple` or `android`; the external
  tenant id is the push topic (Apple) or the enterprise name (Android).

## Apple: Rem0te as the MDM server

### The protocol

- **Two endpoints.** The device sends *check-in* messages to `CheckInURL` (or to `ServerURL` if there is no
  `CheckInURL`): `Authenticate`, `TokenUpdate`, `CheckOut`, and on newer systems `UserAuthenticate`,
  `DeclarativeManagement`, `GetBootstrapToken`, `SetBootstrapToken`, `GetToken` and `ReturnToService`
  ([Apple: Check-in](https://developer.apple.com/documentation/devicemanagement/check-in)). Rem0te starts with
  the first three and answers the rest with an error.
- **`TokenUpdate`** carries the push `Token`, `PushMagic`, `Topic`, the `UDID` (or `EnrollmentID` under user
  enrollment) and an `UnlockToken`
  ([Apple: TokenUpdate](https://developer.apple.com/documentation/devicemanagement/tokenupdaterequest)).
- **The command loop.** The device sends an HTTP `PUT` to `ServerURL` with `Status` `Idle` or the result of the
  last command (`Acknowledged`, `Error` with an `ErrorChain`, `CommandFormatError`, `NotNow`). The server answers
  with a plist holding `Command` (with its `RequestType`) and a `CommandUUID`, or ends the session with a 200 and
  an empty body. A command stays queued until `Acknowledged` or `Error` arrives with its UUID, and a device may
  send the same status twice
  ([Apple: Sending MDM commands](https://developer.apple.com/documentation/devicemanagement/sending-mdm-commands-to-a-device)).
- **Waking a device.** The push body is exactly `{"mdm":"<PushMagic>"}`, with no `aps` key, and APNs keeps only
  the last of several pushes (same page). A push carries no command: it only makes the device connect.
- **The MDM payload** (`com.apple.mdm`) names `ServerURL`, `CheckInURL`, `Topic` (must start with
  `com.apple.mgmt.` and match the push certificate), `IdentityCertificateUUID`, `AccessRights`, `SignMessage` and
  `CheckOutWhenRemoved`. `ServerURL`, `CheckInURL` and `Topic` **must not change** when the payload is updated
  ([Apple: MDM payload](https://developer.apple.com/documentation/devicemanagement/mdm)). So the public URLs
  chosen in the first Apple PR are permanent for every enrolled device: they must be on the portal's own name
  (`remote.agit8or.net`), never a test host.
- **`AccessRights`** is a bit field (1 inspect profiles, 2 install and remove profiles, 4 lock and passcode
  removal, 8 erase, 16 device information, 32 network information, 256 apps, 1024 security, and so on). Rem0te
  asks for what its closed command list needs and no more: **1 + 4 + 8 + 16 + 256 + 1024** (1309) for corporate
  devices (`ProfileList`, lock, erase, information, apps, security). Adding a right later means re-enrolling, so
  **decision 25 (2026-11-23)** grants erase from the first enrollment; it stays unsendable until M5's gating.
- **Device authentication behind Caddy.** By default the device presents its identity certificate over mutual
  TLS. With `SignMessage` true every message also carries an `Mdm-Signature` header, a detached CMS signature,
  for servers behind a proxy that does not pass the client certificate on
  ([Apple: Managing certificates](https://developer.apple.com/documentation/devicemanagement/managing-certificates-for-device-management-services-and-devices)).
  Caddy terminates TLS here, so Rem0te sets **`SignMessage` true** and verifies the signature in the API: the
  certificate chains to Rem0te's device CA, is unexpired and not revoked, and its subject matches the `UDID` in
  the body. Apple notes it adds about 2 KB per message; at this fleet's size that is nothing. The alternative,
  Caddy verifying client certificates and forwarding them (RFC 9440), is a host TLS change and is not proposed.

### Device identity: ACME, through step-ca

The enrollment profile must carry the trust certificates, one client identity and the MDM payload. For the
identity Apple says **ACME is recommended**, then SCEP, then a PKCS#12 identity in the profile; with ACME and SCEP
the private key exists only on the device
([Apple: Deploying enrollment profiles](https://developer.apple.com/documentation/devicemanagement/deploying-device-management-enrollment-profiles)).

| | ACME (`com.apple.security.acme`) | SCEP (`com.apple.security.scep`) | PKCS#12 in the profile |
|---|---|---|---|
| Apple's ranking | Recommended | Second | Third |
| Key | On the device; `HardwareBound` puts it in the Secure Enclave (EC P-256 or P-384) | On the device | Made by the server and sent in the profile |
| Attestation | `Attest` (needs `HardwareBound`): Apple attests the device, on iPhone and iPad with A11 Bionic or later; A10X and earlier ignore it | None | None |
| Systems | iOS and iPadOS 16 and later | iOS 4 and later | All |
| Sources | [ACME payload](https://developer.apple.com/documentation/devicemanagement/acmecertificate), [Managed Device Attestation](https://support.apple.com/guide/deployment/dep28afbde6a/web) | [SCEP payload](https://developer.apple.com/documentation/devicemanagement/scep) | [PKCS#12 payload](https://developer.apple.com/documentation/devicemanagement/certificatepkcs12) |

**Recommendation: ACME with `HardwareBound` and `Attest`, issued by step-ca**
([smallstep/certificates](https://github.com/smallstep/certificates), Apache-2.0, which supports Apple's
`device-attest-01` per [Smallstep](https://smallstep.com/blog/managed-device-attestation/); its provisioner
documentation has not been read yet, **to confirm in the Apple enrollment PR**).

- It is Apple's recommendation, the key never leaves the device, and attestation binds the certificate to real
  Apple hardware and its serial, so a stolen enrollment link cannot be replayed from a laptop.
- step-ca runs as its own system user (`rem0te-mdm-ca`) on `127.0.0.1`. **The portal (`reboot`) cannot read the
  CA key**, the same separation the release keys have (§56). The portal asks step-ca for nothing and never signs
  a certificate itself. (The plan had the portal make a one-time ACME authorization per link; step-ca offers no
  such hook, so **decision 27** accepts ACME open to attested Apple devices, with enrollment needing a claimed
  link and the certificate bound at `Authenticate`.)
- iOS 16 is the floor. Devices that cannot run iOS 16 (or iPadOS 16) are **unsupported**, said on the
  enrollment page. iPads below A11 enroll with a hardware-bound key but no attestation; whether step-ca's
  `device-attest-01` accepts a request with no attestation statement is **unconfirmed** and decides whether those
  iPads are supported.
- SCEP (for example [micromdm/scep](https://github.com/micromdm/scep), MIT) is the fallback if step-ca's ACME
  path does not work for MDM identities. PKCS#12 is used **only by the test suites** (the device simulator below
  cannot do ACME attestation), and only under `NODE_ENV=test`, so a production profile never carries a private
  key.

The enrollment profile itself is signed (an over-the-air profile "stays eligible for updates even after
expiration of the profile's signing certificate", same deploying page). Apple's signing procedure was **not
found** in the primary pages; the Apple enrollment PR confirms it. The intended signer is a profile-signing
certificate issued by Rem0te's own CA, with the key sealed (`rem0te-mdm-profile-sign-v1`).

### The APNs push certificate

This is the one thing Rem0te cannot make for itself.

- **No `.p8` tokens.** "Device management doesn't support the token based push process"
  ([Apple: Setting up push notifications for your device management customers](https://developer.apple.com/documentation/devicemanagement/setting-up-push-notifications-for-your-device-management-customers)).
  It must be a certificate.
- **The flow** (same page):
  1. The MDM server (here, Rem0te) generates the private key and a CSR. **The key must not be available to the
     vendor.**
  2. A holder of an **MDM Vendor CSR Signing Certificate** signs the DER-encoded CSR with SHA256withRSA, and
     builds a Base64 `PushCertRequest` plist with the chain: vendor certificate, Apple WWDR G3, Apple root.
  3. Someone uploads that file at [identity.apple.com/pushcert](https://identity.apple.com/pushcert) with a
     **Managed Apple Account (recommended) or a verified Apple Account**, and downloads the push certificate.
  4. The MDM server installs it. Apple says to use a separate push certificate per customer.
- **Getting the vendor certificate.** The Account Holder of an **Apple Developer Program or Apple Developer
  Enterprise Program** account "contacts" Apple to request it
  ([Apple: MDM Vendor CSR Signing Certificate](https://developer.apple.com/help/account/certificates/mdm-vendor-csr-signing-certificate)).
  It is granted on request; Apple publishes no criteria or lead time (**unconfirmed**). Once granted it appears
  as "MDM CSR" under Certificates
  ([MicroMDM quickstart](https://github.com/micromdm/micromdm/blob/main/docs/user-guide/quickstart.md)).
- **Can an organization sign its own CSR?** Yes. Apple's help page says the vendor certificate signs "your own
  Certificate Signing Requests (CSRs) or the CSRs of MDM solution customers" (same help page), and MicroMDM
  documents in-house use as doing both halves yourself. Whether Apple's agreement limits signing to one's own
  organization and one's customers is a legal question Apple staff declined to answer
  ([Apple Developer Forums 804050](https://developer.apple.com/forums/thread/804050)): **unconfirmed**. For
  Rem0te the case is the simple one: the owner's organization signs the CSR of its own Rem0te server.
- **Renewal.** Apple says to renew the push certificate **annually** and to record which account was used
  ([Apple Platform Deployment: push certificates](https://support.apple.com/guide/deployment/dep2de55389a/web)).
  That a renewal with a *different* Apple Account produces a new topic, so every device must re-enroll, is stated
  by vendors ([Meraki](https://documentation.meraki.com/SM/Device_Enrollment/Renewing_an_Apple_MDM_Push_Certificate))
  rather than by Apple, so it is **unconfirmed by Apple**, but it follows from Apple's rule that an installed
  profile's `Topic` cannot change. Rem0te treats it as true: it refuses a renewed certificate whose topic differs.
- **The community route: mdmcert.download.** A service that signs your CSR with its own vendor certificate and
  returns the request encrypted to you; you decrypt it locally and upload it to Apple. MicroMDM's guide calls it
  "for testing and development scenarios only" (quickstart, above). Its own terms could not be read
  (**unconfirmed**). The trade-off: a third party's vendor certificate stands behind every enrolled device, and
  Apple has said that when it finds MDM abuse it may revoke the push certificate, **the vendor certificate behind
  it**, and the MDM CSR permission (forum thread above), so someone else's conduct could orphan this fleet.
  **Recommendation:** acceptable to prove the wizard and a first test device while the owner's own vendor
  permission is pending; **not** for the fleet. Moving from a community-signed certificate to the owner's own is a
  new push certificate, which may mean a new topic and re-enrolling every device (**unconfirmed**; test it with
  one device before enrolling more).
- **Transport.** HTTP/2 and TLS 1.2 or later to `api.push.apple.com:443` (or 2197)
  ([Apple: Sending notification requests to APNs](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)).
  Push certificates from identity.apple.com are production only, so `UseDevelopmentAPNS` is false (MDM payload
  page). Devices reach APNs themselves on 5223, with 443 as a fallback (deployment page above).

**One push certificate per Rem0te install, first.** Apple's per-customer advice is for vendors whose customers
run their own servers. Here one MSP runs one server for many businesses, so one certificate owned by the MSP's
Managed Apple Account is the simple start. The model allows a topic per connector, so a business that wants its
own certificate (and to be able to leave the MSP without re-enrolling) can have one later.

### Enrollment types

| Type | For | How | Ownership in 0096 | When |
|---|---|---|---|---|
| **Profile-based device enrollment** | Corporate devices without ABM | The user opens a one-time enrollment link and installs the profile | `corporate`, scope `device`, unsupervised | First (the Apple enrollment PR) |
| **Automated Device Enrollment (ADE)** | Corporate devices in Apple Business Manager | The device enrolls during activation and is **supervised**; the profile can be made non-removable ([Apple: Deploying enrollment profiles](https://developer.apple.com/documentation/devicemanagement/deploying-device-management-enrollment-profiles)) | `corporate`, `device`, supervised | After the lost-device and destructive PRs |
| **Account-driven User Enrollment** | Personal devices (BYOD) | The user signs in with a Managed Apple Account; the device discovers the server at `/.well-known/com.apple.remotemanagement` on **the account's domain**, then authenticates (iOS 15+; account-driven device enrollment from iOS 16) ([Apple: Account-driven enrollment](https://developer.apple.com/documentation/devicemanagement/onboarding-users-with-account-driven-enrollment)) | `byod`, `user_enrollment` | Later. It needs Managed Apple Accounts and each customer's own domain to serve the `.well-known` file |

The older profile-based user enrollment key (`ManagedAppleID`) was removed in iOS 18 (MDM payload page), so BYOD
on Apple means account-driven enrollment or nothing.

**Automated Device Enrollment.** The organization generates a key pair, uploads the certificate to Apple Business
Manager when adding an MDM server, and gets back an S/MIME-encrypted server token holding an OAuth consumer key
and secret and an access token and secret. The server opens a session at `https://mdmenrollment.apple.com/session`
with an OAuth 1.0a HMAC-SHA1 request and uses the `X-ADM-Auth-Session` it gets back
([Apple: Authenticating for ADE](https://developer.apple.com/documentation/devicemanagement/authenticating-for-automated-device-enrollment);
[Device assignment](https://developer.apple.com/documentation/devicemanagement/device-assignment)). Apple Business
Manager sign-up needs a D-U-N-S number matching the legal name and address and a verification contact
([Apple: ABM sign-up](https://support.apple.com/guide/apple-business-manager-m/axm402206497/web)). Apple's newer
pages call it "Apple Business"; no fee is stated for the portal (**unconfirmed**), and its verification lead
time is **unconfirmed**.

### The first commands

The closed list, by phase. "Supervised" and "user enrollment" are from each command's own page
(`developer.apple.com/documentation/devicemanagement/<name>-command`).

| Command | Phase | Supervised only (iOS) | Under user enrollment | 0096 kind |
|---|---|---|---|---|
| `DeviceInformation` (a closed list of queries) | Inventory | No | Allowed (fewer fields) | `sync` |
| `SecurityInfo` | Inventory | No | Allowed | `sync` |
| `InstalledApplicationList` | Inventory | No | Allowed (managed apps) | `sync` |
| `ProfileList`, `CertificateList` | Inventory | No | Allowed | `sync` |
| `DeviceLock` (with a message and phone number) | Lost device (3.3) | No | Allowed | `lock` |
| `EnableLostMode` / `DisableLostMode` | Lost device (3.3) | **Yes** | **Not available** | `lost_mode_start` / `_stop` |
| `EraseDevice` | Destructive (3.4) | No | **Not available** | `wipe` |
| `RemoveProfile` (Rem0te's own MDM profile, which unenrolls) | Destructive (3.4) | No | Allowed | `retire` |

So on an **unsupervised** iPhone, lost mode is unsupported and is shown as such; lock and erase work. Locate is
lost-mode only, so it is supervised-only too (`locate` stays unsupported on unsupervised devices).
Declarative device management, once turned on, cannot be turned off
([Apple: Integrating declarative management](https://developer.apple.com/documentation/devicemanagement/integrating-declarative-management));
Rem0te does not turn it on until a later PR decides to.

The `UnlockToken` from `TokenUpdate` exists only to clear a passcode. Rem0te **does not keep it** until a
command that needs it is decided; if one is, it is sealed under its own purpose.

### Build or embed: NanoMDM and friends

| Project | Licence | Language | What it does | Status |
|---|---|---|---|---|
| [NanoMDM](https://github.com/micromdm/nanomdm) | MIT | Go | Check-in and command handlers, raw-plist queue, APNs push, multiple topics, webhook. **Does not** do SCEP, TLS, the ADE API, enrollment profiles or a JSON command API | Maintained |
| [MicroMDM v1](https://github.com/micromdm/micromdm) | MIT | Go | The older all-in-one server | "Deprecated and unsupported … as of the end of 2025" |
| [micromdm/scep](https://github.com/micromdm/scep) | MIT | Go | SCEP server | Maintained |
| [NanoDEP](https://github.com/micromdm/nanodep) | MIT | Go | ADE API client and tools | Maintained |
| [NanoCMD](https://github.com/micromdm/nanocmd), [NanoHUB](https://github.com/micromdm/nanohub), [KMFDDM](https://github.com/jessepeterson/kmfddm) | MIT | Go | Command workflows; a bundle; declarative management | Maintained |
| [step-ca](https://github.com/smallstep/certificates) | Apache-2.0 | Go | A CA with ACME, including Apple `device-attest-01` | Maintained |
| [mdmb](https://github.com/jessepeterson/mdmb) | MIT | Go | A device simulator: enrolls, keeps a keychain and profiles, answers commands | Test tool |

Licences are from each project's GitHub metadata; the PR that adopts one reads its `LICENSE` file and records it.

**Recommendation: build the protocol core in the Nest API; embed only the CA.**

Embedding NanoMDM as a separate Go service would save the check-in handlers, the queue and the push client. It
would cost more than that:

- **Secrets outside secret-box.** NanoMDM keeps the push certificate and key in its own storage (file, MySQL or
  PostgreSQL). Rem0te's rule is that a credential is sealed under its own purpose and never readable in plain
  form at rest.
- **Two sources of truth.** Its queue would duplicate `MdmCommand`, so "accepted" and "completed" would be
  reconstructed from webhooks instead of being Rem0te's own rows, and §90's lifecycle CHECKs would guard a copy.
- **Containment, audit and approvals** (decision 16) would have to sit in front of someone else's queue API.
- **What it would save is the small part.** NanoMDM does no profiles, no ADE and no device identity; Rem0te
  builds those either way. The check-in and command loop is a few plist message types.
- **Invariants.** `check-security-invariants.mjs` reads Rem0te's TypeScript. A third-party binary can be pinned
  and hashed, but not held to §-checks.

NanoMDM stays valuable as the reference: its MIT licence allows reading and porting with the notice kept, and
its handling of duplicate statuses, `NotNow` and token updates is what the Nest code should match.

**The CA is different**, and is embedded. Certificate issuance with Apple attestation is the part most worth not
writing, and running it as a separate user is *better* isolation than a sealed key in the portal: a compromised
portal can request at most what its one-time authorizations allow, and can never sign a device certificate
itself. This follows the approval signer and release-key model (§14, §56): a separate install, its own user, a
pinned version, built or downloaded with a published SHA-256.

## Android: Rem0te as the EMM

### The model

- AMAPI "is intended for enterprise mobility management providers (EMMs)"
  ([Google: Introduction](https://developers.google.com/android/management/introduction)), and "Android Device
  Policy is the **only** device policy controller compatible with Android Management API" (same page). Every
  managed device installs Android Device Policy during setup
  ([Android Enterprise overview](https://developers.google.com/android/work/overview)). **Rem0te ships no Android
  app.**
- **Setup.** A Google Cloud project with the API enabled; a service account with the role *Android Management
  User* (`roles/androidmanagement.user`) and a key
  ([Google: Service account](https://developers.google.com/android/management/service-account)). Rem0te signs a
  JWT with that key and exchanges it at `https://oauth2.googleapis.com/token`
  (`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`, `exp` at most an hour after `iat`) for the scope
  `https://www.googleapis.com/auth/androidmanagement`
  ([Google: OAuth for service accounts](https://developers.google.com/identity/protocols/oauth2/service-account)).
  Calls go to `https://androidmanagement.googleapis.com/v1/…`. Default limits: 1,000 queries per 100 seconds per
  project and 60 a minute against one resource
  ([Google: Permissible usage](https://developers.google.com/android/management/permissible-usage)).
- **The enterprise (one per business).** `signupUrls.create` with the `projectId` and an https `callbackUrl`;
  the admin signs up at Google; Google appends an `enterpriseToken` to the callback; Rem0te calls
  `enterprises.create` with the `signupUrlName` and the token
  ([signupUrls.create](https://developers.google.com/android/management/reference/rest/v1/signupUrls/create),
  [Create an enterprise](https://developers.google.com/android/management/create-enterprise)).
  - Two enterprise types: `MANAGED_GOOGLE_DOMAIN` and `MANAGED_GOOGLE_PLAY_ACCOUNTS_ENTERPRISE`
    ([enterprises](https://developers.google.com/android/management/reference/rest/v1/enterprises)). The
    Gmail-based sign-up is "deprecated in favor of the managed Google domain sign-up method"
    ([Play EMM: Create an enterprise](https://developers.google.com/android/work/play/emm-api/create-enterprise)).
  - A Gmail account can still be the admin; one Gmail account binds one enterprise
    ([Quickstart](https://developers.google.com/android/management/quickstart)). A managed Google Play Accounts
    enterprise can later be upgraded to a managed Google domain
    ([Upgrade an enterprise](https://developers.google.com/android/management/upgrade-an-enterprise)).
  - **Recommendation:** each customer business signs up with a work-domain account (managed Google domain), not a
    person's Gmail.
- **Enrollment.** `enrollmentTokens.create` returns a token and a `qrCode` JSON string; `duration` defaults to an
  hour; `oneTimeOnly`, `policyName` and `allowPersonalUsage` are set per token
  ([enrollmentTokens](https://developers.google.com/android/management/reference/rest/v1/enterprises.enrollmentTokens)).
  `PERSONAL_USAGE_ALLOWED` gives a work profile (required on a personal device), `PERSONAL_USAGE_DISALLOWED` a
  fully managed device, `PERSONAL_USAGE_DISALLOWED_USERLESS` a dedicated device. Methods: QR (Android 7+, tap the
  welcome screen six times), NFC, `afw#setup`, zero-touch (Android 8+, reseller devices), an enrollment link, or
  Settings for a work profile ([Provision a device](https://developers.google.com/android/management/provision-device)).
  Rem0te issues **one-time, short-lived** tokens only (an hour, the default), shown as a QR code and a link.
- **Inventory.** The Device resource gives `hardwareInfo` (brand, model, manufacturer, serial), `softwareInfo`,
  `applicationReports`, `securityPosture`, `nonComplianceDetails`, `ownership`, `managementMode` and
  `lastStatusReportTime`; software and app reports need `statusReportingSettings` flags in the policy
  ([enterprises.devices](https://developers.google.com/android/management/reference/rest/v1/enterprises.devices)).
  Rem0te's default policy turns on `softwareInfoEnabled` and `applicationReportsEnabled` only, and **not**
  `networkInfoEnabled` (which carries the IMEI and MACs that 0096 does not keep).
- **Commands.** `devices.issueCommand` returns an Operation, read with `operations.get`
  ([issueCommand](https://developers.google.com/android/management/reference/rest/v1/enterprises.devices/issueCommand)):

  | Command | Scope | 0096 kind | Phase |
  |---|---|---|---|
  | `LOCK` | All (on a work profile with its own lock, only the profile) | `lock` | 3.3 |
  | `START_LOST_MODE` / `STOP_LOST_MODE` | Fully managed, or company-owned with a work profile | `lost_mode_start` / `_stop` | 3.3 |
  | `RESET_PASSWORD` | Not restricted on the page | — (new kind, treated as destructive: it locks the user out) | 3.4 |
  | `RELINQUISH_OWNERSHIP` | Company-owned with a work profile, Android 8+: removes the profile, keeps personal data | `retire` | 3.4 |
  | `WIPE` | Company-owned: factory reset. Personal: deletes the work profile | `wipe` / `remove_managed_data` | 3.4 |
  | `REBOOT`, `CLEAR_APP_DATA`, eSIM | Not planned | — | — |

  `devices.delete` "attempts to wipe the device" and takes `wipeDataFlags`
  ([devices.delete](https://developers.google.com/android/management/reference/rest/v1/enterprises.devices/delete),
  [WipeDataFlag](https://developers.google.com/android/management/reference/rest/v1/WipeDataFlag)). Rem0te uses
  `issueCommand` `WIPE` for both and never `devices.delete` as a wipe, so the Operation records acceptance and
  the device report records completion, the two fields 0096 keeps apart.

### Notifications: polling first, Pub/Sub later

Pub/Sub needs a topic in the same project, the Pub/Sub Publisher role for
`android-cloud-policy@system.gserviceaccount.com`, and `enterprises.patch` setting `pubsubTopic` and
`enabledNotificationTypes` (`ENROLLMENT`, `STATUS_REPORT`, `COMMAND`, `USAGE_LOGS`); pull and push subscriptions
both work ([Google: Notifications](https://developers.google.com/android/management/notifications)).

**Recommendation:** poll `devices.list` inside the existing `MDM_SWEEP` first (bounded as 0.80's sync is). It
needs nothing more from the owner and no inbound endpoint. Add Pub/Sub later with a **pull** subscription, which
is still only outbound calls from Rem0te (to `pubsub.googleapis.com`), never a push subscription to a public
Rem0te URL. Pub/Sub's pricing page could not be read (**unconfirmed**); at this fleet's volume it is expected to
be within any free allowance.

### Own DPC instead?

Google "is no longer accepting new registrations for custom device policy controller (DPC) using the Google Play
EMM API. All new EMM solutions should now use Android Management API"
([Google: Register as an EMM](https://developers.google.com/android/work/play/emm-api/register)), and the Play EMM
API's methods are closed to new integrations
([Play EMM API](https://developers.google.com/android/work/play/emm-api/v1)). An own DPC would mean writing and
maintaining an Android app, a push channel of its own, and no managed Google Play. **Recommendation: AMAPI.** A
DPC is considered only if Google refuses the permitted-use question below, and then as its own design.

### The permitted-use question

This is the deciding risk for Android, and an owner decision (decision 21 below).

- AMAPI is "restricted solely to commercial Enterprise Mobility Management (EMM) developers", device-trust
  providers and OEMs. Providers must "offer their solutions to their end customers through commercial sales to
  entities outside of their immediate company", with a direct agreement with each customer. **Prohibited:**
  "Solutions developed and used exclusively for first party in-house applications"
  ([Google: Permissible usage](https://developers.google.com/android/management/permissible-usage)).
- **Quota.** "To request an initial quota of up to 500 devices, you will need to provide a full business
  justification." Beyond 500, an application to Android Enterprise. At most two projects per developer (for
  development and production). Whether a project has any quota before the request is **unconfirmed**; the
  quickstart requires the request before the first device. The 0.76.1 audit recorded community reports of
  reviews taking weeks.
- **How Rem0te fits.** Rem0te is operated by an MSP for its client businesses, under agreements with each of
  them, which is closer to "commercial sales to entities outside the company" than to an in-house tool. Whether
  Google agrees is Google's decision, made on the justification. The owner should describe it exactly as it is:
  an MSP's management platform used for its customers' devices. If the owner only wanted the MSP's own staff
  phones, AMAPI would not be permitted.

## Prerequisites the owner must obtain

Costs are Apple's and Google's published prices; lead times are theirs where published.

| # | What | For | Cost | Lead time | Needed before |
|---|---|---|---|---|---|
| A1 | **D-U-N-S number** for the organization | Apple Developer Program (organization), Apple Business Manager | Free | Up to 5 business days, then up to 2 more for Apple to receive it ([Apple: D-U-N-S](https://developer.apple.com/support/D-U-N-S/)) | A2, A5 |
| A2 | **Apple Developer Program, organization membership** (the Account Holder must have authority to sign for the organization) | The MDM vendor permission | **99 USD a year** ([Apple: Enroll](https://developer.apple.com/programs/enroll/)) | Apple's verification: **unconfirmed** | A3 |
| A3 | **"MDM CSR" permission** (the MDM Vendor CSR Signing Certificate), requested by the Account Holder | Signing Rem0te's push CSR | Included | Granted on request; **no published criteria or lead time**. Ask as soon as A2 exists | A4 (own route) |
| A4 | **APNs MDM push certificate** at identity.apple.com, with a **Managed Apple Account or shared company Apple Account**, never a person's, recorded in Rem0te | Any Apple enrollment | Free | Minutes once the signed request exists. **Renew every year with the same account** | Any real Apple device |
| A4′ | *Interim:* the push request signed by mdmcert.download | A first test device while A3 is pending | Free | Minutes to days (**unconfirmed**) | — (testing only) |
| A5 | **Apple Business Manager** (optional), per business that buys its own devices, with a verification contact | Supervision, Automated Device Enrollment, lost mode | No fee stated (**unconfirmed**) | Apple's verification: **unconfirmed** | ADE PR |
| A6 | One **test iPhone or iPad** on iOS/iPadOS 16+ (A11 or later for attestation) | The only real proof | — | — | First real enrollment |
| G1 | A **Google account** to bind each business's enterprise: a work-domain account (managed Google domain, recommended; Google Workspace is optional and paid) or a Gmail that is bound to no other enterprise | Enterprise sign-up | Free (Workspace: paid) | Minutes | G4 |
| G2 | A **Google Cloud project** with AMAPI enabled, and a **service account** with *Android Management User* and a key | Every AMAPI call | No charge stated for AMAPI (**unconfirmed**); a billing account is not required for AMAPI itself (**unconfirmed**) | Minutes | G3 |
| G3 | **Device quota**: the business justification for up to 500 devices; an Android Enterprise application beyond | Any enrollment | Free | **Weeks reported; not published.** Ask early | First real Android device |
| G4 | **The permitted-use answer** (decision 21): that Rem0te is an MSP platform for its customers | G3 | — | With G3 | G3 |
| G5 | One **test Android phone** (Android 7+ for QR) with Google Play | The only real proof | — | — | First real enrollment |

**Start now, in parallel:** A1 → A2 → A3 (the longest unknowns), and G2 → G3 with G4 written carefully. None of
the first two pull requests waits for them.

## Settings → Mobile devices: the wizard

One page in Settings with a card per platform. Each card shows a status in the four capability states and a
numbered list of steps. Each step has plain instructions, **what Rem0te checks automatically**, and **what it
cannot check**. Every step is resumable: leaving and coming back keeps what was done. Every write is a Platform
Admin's, `assertFresh` naming `mdm.setup` (a §62 key, default off like the others), and audited without secrets.

| Status | Means |
|---|---|
| **available** | Configured and proven: Apple, a valid push certificate and at least one device checked in; Android, the connection test passed and an enterprise is bound |
| **requires setup** | A step is not done, or something expired (the reason is named: "push certificate expires in 6 days") |
| **unsupported** | Not possible here (for example lost mode on an unsupervised iPhone; ACME on iOS 15) |
| **planned** | Not built yet in this release (for example ADE before its PR) |

### Apple

| Step | What you do | What Rem0te checks | What Rem0te cannot check |
|---|---|---|---|
| 0. Before you start | Read what is needed (A1–A4). Decide which **company** Apple Account will own the push certificate | — | That the account is a company one |
| 1. How will the request be signed? | Choose: **your own MDM vendor certificate** (A2–A3), **mdmcert.download** (testing only; the page says why), or **another vendor** | — | — |
| 2. Generate the push request | Click *Generate*. Rem0te makes an RSA key and a CSR | The key is generated in the API and **sealed** (`rem0te-apns-push-key-v1`) before anything is shown; the CSR verifies against it. The key is never downloadable | — |
| 3a. Your own vendor certificate | In the Apple Developer site, create the MDM CSR certificate; upload it and its key | The certificate is issued by Apple WWDR, is unexpired and matches the key; the key is sealed (`rem0te-mdm-vendor-key-v1`). Rem0te builds and downloads the signed `PushCertRequest` (SHA256withRSA, the chain in Apple's order) | That Apple will accept it |
| 3b. mdmcert.download | Follow the shown steps; upload the encrypted reply | The reply decrypts with Rem0te's key and holds a request for Rem0te's own CSR | The service's trustworthiness, said in red |
| 4. Upload to Apple | Sign in at identity.apple.com with the company account, upload the request, download the certificate. **Type the account's name into Rem0te** | — | Which account you used: Rem0te records what you type and shows it at every renewal |
| 5. Upload the push certificate | Upload the `.pem` | Its public key matches the sealed key; it is an Apple push certificate; its topic starts `com.apple.mgmt.External.`; its expiry. The topic and expiry are shown | That APNs accepts it, until the first push to a real device succeeds (shown as "not yet proven") |
| 6. Enroll a test device | Open the one-time link on an iPhone or iPad and install the profile | The device's ACME certificate, its first `Authenticate` and `TokenUpdate`, the topic, the first push and the first `DeviceInformation` reply. Status becomes **available** | — |
| 7. Renewal | Reminders 30, 14, 7 and 1 days before expiry (notification policies; a `notifications` pause holds them). Renew at identity.apple.com with **the same account** and upload the new certificate | A renewed certificate must have **the same topic** and the same key; a different topic is refused, because every device would have to re-enroll | That you used the same account, except through the topic |
| 8. Apple Business Manager (optional, per business) | Download Rem0te's ADE public certificate, add an MDM server in ABM, upload the server token | The token decrypts with the sealed key (`rem0te-ade-key-v1`) and is sealed (`rem0te-ade-token-v1`); its expiry is shown and reminded like the push certificate. *Test* opens a session at `mdmenrollment.apple.com` | Which devices ABM assigned, until the first sync |

Replacing the push certificate with a different topic is possible only as its own action, which names how many
devices would have to re-enroll, needs a fresh confirmation, and is audited.

### Android

| Step | What you do | What Rem0te checks | What Rem0te cannot check |
|---|---|---|---|
| 0. Before you start | Read the permitted-use note and what is needed (G1–G5) | — | Google's decision |
| 1. Google Cloud project | Create a project, enable the Android Management API, create a service account with *Android Management User*, create a key | — | Any of it, until step 3 |
| 2. Upload the key | Upload the key file | It parses as a service-account key, names a project and a client e-mail, the private key loads; it is **sealed** (`rem0te-amapi-sa-key-v1`) and never shown again (the key id's last four characters are) | That the role is granted, until step 3 |
| 3. Test the connection | Click *Test* | A token from `oauth2.googleapis.com` and one read call. A permission error names the missing role | Quota |
| 4. Device quota | Submit Google's form with the shown justification text; record the granted quota when Google answers | Shows what you recorded; a quota error on enrollment turns the status back to **requires setup** with that reason | The quota itself: no quota read was found in the API (**unconfirmed**) |
| 5. Bind a business | On the business's page, *Connect Android*: Rem0te asks Google for a sign-up link; the customer's admin signs in with the work account and finishes | The callback carries a one-time state Rem0te issued for that business, used once; `enterprises.create` succeeds; the enterprise name is stored on the connector | Which account the admin used |
| 6. Default policy and enrollment | Rem0te creates the business's policy (status reports for software and apps only). *Enroll a device* shows a one-time QR code and link | The token is one-time and an hour long | — |

## Outbound calls and `safe-https`

Decision 17 (public DNS and verified TLS only) holds for every call. Every host is a **fixed constant** in one
driver file, never typed by a person, and §90 is amended to allow exactly those hosts in exactly those files.

| Host | From | Through |
|---|---|---|
| `oauth2.googleapis.com`, `androidmanagement.googleapis.com` | `mdm/drivers/android/` | `safe-https`, extended from GET and POST to also PATCH and DELETE (its internal `safeRequest` already takes a method) |
| `pubsub.googleapis.com` (later) | `mdm/drivers/android/` | `safe-https` |
| `mdmenrollment.apple.com` (ADE) | `mdm/apple/ade.ts` | `safe-https` |
| `api.push.apple.com` | `mdm/apple/apns.ts` | **A new sibling, `common/safe-h2.ts`**: `safe-https` speaks HTTP/1.1 and presents no client certificate, and APNs needs HTTP/2 with the push certificate as the TLS client certificate |

`safe-h2` keeps every `safe-https` rule: the name resolved and every address judged on each connect, the
connection made to the checked address with the name kept for SNI and verification, TLS 1.2 or later, certificates
verified, no redirects, bounded time and size. Two differences, both stated in its header: it presents a client
certificate (the push key opened from secret-box in memory for that connection only), and it **keeps one
connection open per sweep pass** instead of one per request, because Apple asks providers to keep APNs
connections open across notifications rather than opening and closing them
([Apple: Sending notification requests](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns);
the exact wording is to be quoted in the PR). Its test mode is a loopback HTTP/2 stub under `NODE_ENV=test` only,
like `testLoopbackAllowed`.

## Inbound endpoints and Caddy

Apple devices need a public HTTPS URL; Android devices do not. **Nothing on the host is changed by this page.**

| Path | Goes to | Caddy today | Change needed |
|---|---|---|---|
| `/api/v1/mdm/apple/checkin`, `/api/v1/mdm/apple/server` | Nest API :3001 | Covered by `handle /api/*` | **None.** The API admits only `application/x-apple-aspen-mdm-checkin` and the MDM content type on these two routes, with a raw-body limit and its own rate limit |
| `/api/v1/mdm/apple/enroll/<token>` | Nest API (the one-time profile download) | Covered | None |
| `/api/v1/mdm/android/signup/callback` | Nest API (browser redirect from Google) | Covered | None |
| `/acme/rem0te-mdm/*` (0.84; the plan said `/mdm/acme/*`, see [M2 as built](#m2-as-built-0840)) | step-ca on `127.0.0.1:9451` | **Not routed** | **One new route**, in `deploy/caddy/Caddyfile` commented out: `handle /acme/rem0te-mdm/* { reverse_proxy https://127.0.0.1:9451 { header_up Host {host} … tls_trust_pool file /etc/caddy/rem0te-mdm-ca-root.crt } }` (`header_up Host {host}` from 0.84.1: without it Caddy sends the upstream's own address and step-ca's directory links name `127.0.0.1:9451`), nothing else of step-ca exposed (no admin API, no other provisioner). On the host only at deploy, with the owner's approval |
| `/.well-known/com.apple.remotemanagement` | — | — | Not on this host: account-driven enrollment discovers the server on the **user's e-mail domain**, so each customer serves it (later PR) |

The public name `remote.agit8or.net` is in every enrolled device's profile for good (Apple's rule that
`ServerURL` and `CheckInURL` cannot change), so moving the portal to another name later means re-enrolling every
Apple device.

## Security model

- **Who.** Setup is a Platform Admin's. Reading devices is 0.80's `mobile:view`. Sending a lost-device command
  is a new capability, `mobile:act`. Destructive commands need `mobile:act` **and a second person's approval and
  an always-ask confirmation** (decision 16): the request is made by one person, approved by another (the
  temporary-access pattern), and executed only after the approver passes a check in the always-ask set
  (`mdm.destructive` joins `ALWAYS_ASK`). The requester can never approve their own.
- **Personal devices.** On `byod`, the only removal is of the work data (`remove_managed_data`: Android `WIPE`
  of the work profile, Apple `RemoveProfile` under user enrollment). A full wipe of a personal device is refused
  by the portal and by a CHECK, whatever the provider would allow.
- **Secrets**, each under its own secret-box purpose, never in a response, audit row, log line or error:
  the APNs push key, the vendor signing key, the profile-signing key, the ADE decryption key and server token,
  the Google service-account key, and Google access tokens (memory only, keyed by a hash of the credential, as
  the warranty client does). The device CA key is not in the portal at all.
- **Device authentication.** Every Apple message is verified (`Mdm-Signature` against Rem0te's CA, subject
  bound to the `UDID`) before anything is read from it; an unknown or checked-out device gets a 401 and nothing
  else. Enrollment links are one-time, short-lived, per business, and their use is a conditional update (the
  claim-token rule, §34/§70).
- **What is kept.** 0096's rule holds: no IMEI, MEID, phone number, MACs or signed-in user; serial only on
  corporate devices. `DeviceInformation` asks only for the fields Rem0te keeps. The push token and `PushMagic`
  are stored (they can only wake a device, with the push key). `UnlockToken` is not stored.
- **Containment** ([containment](containment.md) kinds):

  | Pause | Effect |
  |---|---|
  | `actions` | No lock, lost-mode, wipe or retire is queued, pushed or issued; queued ones stay queued. Inventory queries continue |
  | `integration` | No outbound call to Google or to `mdmenrollment.apple.com` (the sync is skipped, as in 0.80) |
  | `remote` | No effect on MDM: it is not a remote session |
  | `notifications` | Renewal and quota reminders are held |
  | `updates` | No effect |

  Apple check-ins are always answered (the device will check in whatever Rem0te does); under `actions` the queue
  simply hands out nothing that acts.
- **Accepted is not completed.** For Apple, *accepted* is "queued and pushed"; only the device's `Acknowledged`
  completes it. For Android, the Operation is acceptance and the device report completion. 0096's CHECKs and the
  state machine already enforce this.
- **Audit.** Every setup change, enrollment, unenrollment (`CheckOut`), command request, approval, push and
  result is an `ActivityLog` row with ids, kinds and outcomes, never a secret or a lock message's text.

## Invariant sketch (a future §)

A sketch for the section the first implementation PR adds, extending §90:

1. **Fixed hosts.** Apple's and Google's hosts appear only as constants in `mdm/apple/apns.ts`,
   `mdm/apple/ade.ts` and `mdm/drivers/android/`, and nowhere else in `apps/api/src`. §90's "no provider host"
   check is amended to exactly that list.
2. **One push site.** `apns.ts` is the only caller of `safe-h2`, and `safe-h2` the only module that presents a
   client certificate. The push body is exactly `{"mdm": <PushMagic>}`.
3. **Sealed.** The six purposes above exist in `SecretPurpose`, each used only by its own module, and none of
   their plaintexts reaches a view, audit meta or log.
4. **The CA is not the portal's.** Nothing in `apps/api/src` names the step-ca key directory or spawns step-ca;
   the portal never calls it (decision 27: no per-order authorization; enrollment needs a claimed link).
5. **Closed commands.** The Apple `RequestType`s and Android command types Rem0te can send are exact, ordered
   lists, the same in the module and in a CHECK. `AccessRights` is one constant.
6. **Device messages verified first.** The check-in and server handlers call the signature check before any
   parse beyond the envelope; a failure is a 401 with no body.
7. **Destructive needs two.** `retire`, `remove_managed_data` and `wipe` (and Android `RESET_PASSWORD`) are sent
   only after an approval by a different person and an always-ask check (`mdm.destructive` in `ALWAYS_ASK`).
   A `byod` device can never be sent `wipe` (portal and CHECK).
8. **Containment.** `send()` consults the `actions` pause; every outbound sync consults `integration`.
9. **Production profile carries no key.** A PKCS#12 payload is built only under `NODE_ENV=test`.
10. **One path into `MobileDevice`.** Only the sync writes it; the Apple handlers write only their own tables.
11. **Topic is permanent.** A push certificate with a different topic replaces the current one only through the
    replace action (fresh confirmation, audited, device count shown).
12. **Off switches.** Any new sweep (`MDM_PUSH_SWEEP`, renewal reminders) is exact `=off`, in `run-e2e.sh`,
    `e2e-ui.mjs` and §84's `OFF_SWITCHES`.

## What this host can verify, and what it cannot

| Can be verified here | Needs real accounts or devices |
|---|---|
| CSR generation, vendor signing of a CSR with a **test** vendor certificate, `PushCertRequest` structure, push-certificate parsing (topic, expiry, key match) with self-made fixtures | Apple accepting the request; a real push certificate |
| Plist parsing and building; every check-in message and command result, from Apple's documented shapes | Real devices' replies, which are richer than the documentation |
| The full enrollment and command loop against **[mdmb](https://github.com/jessepeterson/mdmb)** (MIT) on a scratch API: enroll from a profile (PKCS#12 test variant), check in, take commands, answer them. mdmb invents push tokens and connections are triggered by hand | Real APNs delivery; OTA and ADE enrollment, which need Apple's device CA |
| APNs client behaviour against a loopback HTTP/2 stub (status codes, the body, connection reuse) | APNs accepting the certificate |
| step-ca's ACME flow on loopback, without attestation | Apple attestation (only a real device can produce one) |
| ADE: OAuth 1.0a signing and session handling against a stand-in in Apple's documented shape | A real ABM token and assigned devices |
| AMAPI calls against a loopback stand-in in AMAPI's REST shape (sign-up callback, enterprise, policy, enrollment token, device pages, Operations) | Enterprise sign-up, quota, any enrollment |
| — | The iOS Simulator enrolling in MDM: **unconfirmed** either way; plan on a real device. An Android emulator with Google Play enrolling: **unconfirmed** ([codelab](https://developer.android.com/codelabs/work-profile-apps) mentions emulator setup for a work profile only) |

Every PR says "not run on a real device" until it has been, as the Windows work does.

## Roadmap

Each line is one reviewable pull request, ordered so the **Settings wizard and Apple enrollment and inventory
come first** and **nothing blocks on an account the owner does not have yet**: each one is complete and proven
against simulators and stand-ins, and becomes real when the account arrives. None is deployed without the owner's
explicit approval.

| # | Pull request | Scope | Tests | Blocked on (to be real, not to merge) |
|---|---|---|---|---|
| **M1** ✅ 0.83.0 | **Settings → Mobile devices: the wizard, and Apple push certificates** | The Settings page with both cards and the four states. Apple steps 0–5 and 7: push CSR generation (key sealed), signing with an uploaded vendor certificate (sealed), the mdmcert.download path, push-certificate upload and checks (key, issuer, topic, expiry), the recorded account, renewal reminders, the same-topic rule. Android steps 0–2 and 4: instructions, key upload and offline checks (sealed), quota recorded by hand. **No outbound call.** `mdm.setup` in §62 | Unit (CSR, signing with a test vendor certificate, certificate parsing); e2e on a scratch API; browser suite | Nothing to merge. A3 (or A4′) to produce a real certificate |
| **M2** ✅ 0.84.0 | **Apple enrollment, check-in and inventory: the first real driver** | `apple` in `PROVIDERS` and 0096's CHECK; one-time enrollment links and signed profiles; check-in and server endpoints with `Mdm-Signature` verification; the queue for the inventory commands (`DeviceInformation`, `SecurityInfo`, `InstalledApplicationList`, `ProfileList`, `CertificateList`); `safe-h2` and the APNs client; step-ca as `rem0te-mdm-ca` with its install script and the one Caddy route (documented); the `apple` driver feeding the existing sync; wizard step 6 | Unit; e2e with **mdmb** and a loopback APNs stub; step-ca ACME on loopback | A4 and A6 for a real device |
| **M3** ✅ 0.85.0 | **Android: enterprise sign-up and read-only inventory** | `android` in `PROVIDERS`; wizard steps 3, 5 and 6: connection test, sign-up from inside Rem0te (one-time state), the default policy, one-time enrollment tokens with QR; the `android` driver (devices and Operations, polling in `MDM_SWEEP`); `safe-https` PATCH/DELETE | Unit; e2e against an AMAPI-shaped loopback stand-in | G1–G4 (and decision 21), G5 |
| **M4** ✅ 0.86.0 | **Lost-device actions** (audit 3.3) | `send()` on the driver interface; `mobile:act`; Apple `DeviceLock`, `EnableLostMode`/`DisableLostMode` (supervised only; unsupported otherwise); Android `LOCK`, `START_LOST_MODE`/`STOP_LOST_MODE`; `actions` pause; accepted vs completed shown ([as built](#m4-as-built-0860)) | e2e (mdmb, stand-in) | M2 or M3 |
| M5 | **Destructive actions** (audit 3.4) | Apple `EraseDevice`, `RemoveProfile`; Android `WIPE` (device or work profile), `RELINQUISH_OWNERSHIP`, `RESET_PASSWORD`; second-person approval; `mdm.destructive` always asks; `byod` never wiped | e2e | M4 (decision 16 decided) |
| M6 | **Apple Business Manager and Automated Device Enrollment** | Wizard step 8; ADE token (sealed); the session, device sync and profile assignment through `safe-https`; supervised devices, so lost mode | e2e against an ADE-shaped stand-in | A5 |
| M7 | **Android Pub/Sub (pull)** | Topic and subscription set-up instructions, `enterprises.patch`, a pull consumer in the sweep | e2e against a stand-in | G2 |
| M8 | **Apple account-driven User Enrollment (BYOD)** | `.well-known` instructions per customer domain, the authentication step, managed-data-only scope | e2e (mdmb if it supports it; otherwise a stand-in) | Managed Apple Accounts, a customer domain |
| M9 | **Per-business push certificates** (optional) | A topic per connector, so a business can leave without re-enrolling | e2e | Owner decision |

**The first three are M1, M2 and M3.** M1 needs nothing from Apple or Google at all; M2 is complete against mdmb
and needs the push certificate only to touch a real iPhone; M3 is complete against a stand-in and needs Google's
quota only to enroll a real phone.

## Owner decisions this raises

**All four decided on 2026-11-21** ("accept recs"): the owner accepted every recommendation.

| # | Decision | Options | Decided (2026-11-21) |
|---|---|---|---|
| 21 | **Android permitted use** | (a) apply for quota describing Rem0te as an MSP platform for its customers; (b) Apple only for now | **(a): Android is for customers' devices (the MSP model)**, described to Google exactly as it is. If Google refuses, (b), and an own DPC only as a separate design |
| 22 | **Push signing route** | (a) own MDM vendor certificate; (b) mdmcert.download for the fleet | **(a): the owner's own Apple Developer organization with the MDM CSR permission.** mdmcert.download only for a first test device while the permission is pending |
| 23 | **One push certificate or one per business** | (a) one per install, owned by the MSP; (b) one per business | **(a): one APNs certificate per install.** (b) stays M9, if a customer asks |
| 24 | **Minimum Apple OS** | (a) iOS/iPadOS 16 (ACME); (b) also older, with SCEP | **(a): iOS/iPadOS 16 minimum.** Revisit if a fleet device cannot run it |

## M1 as built (0.83.0)

Settings → Mobile devices (`/settings/mobile-devices`), Platform Admin only, one card per platform, every step with
what Rem0te checks and what it cannot, and every capability in the four states. **No outbound call to Apple, Google
or mdmcert.download** (§92). Where the build differs from the plan above, it says why.

| Step | What is built |
|---|---|
| Prerequisites | Apple A1–A4 and Google G1–G4 with cost, lead time and links. The owner's ticks are stored (`appleChecklist`, `androidChecklist`) so the page is resumable; **they are never treated as verification** |
| Signing route | `own_vendor` (decision 22), `mdmcert` (test device only, with the trust caveats above) or `other_vendor` |
| Push request | RSA 2048 key made in the API and sealed (`rem0te-apns-push-key-v1`) before anything is shown; the CSR (PKCS#10, SHA256withRSA) is self-verified and downloadable; the key is never returned. A new key is refused while a certificate is installed, so renewal keeps the key and the topic |
| Vendor signing | The vendor certificate (Apple's DER `.cer` or PEM), its RSA key (sealed, `rem0te-mdm-vendor-key-v1`; an encrypted key's passphrase is used once) and the chain (WWDR intermediate, Apple root) **uploaded by the owner** — Rem0te downloads nothing. Checked: key match, expiry, the chain connects. The root's SHA-256 is shown to compare with Apple's, **not pinned**. Rem0te builds the Base64 `PushCertRequest` plist |
| mdmcert.download | Shown only as a test-device path with its caveats; the owner submits Rem0te's CSR and decrypts the reply on their own computer. **Rem0te does not decrypt it** (the design's step 3b decryption is not built) |
| Push certificate | Checked offline: one certificate; subject UID `com.apple.mgmt.External.<uuid>`; its public key is the sealed key's; unexpired and already valid. Sealed (`rem0te-apns-push-cert-v1`); topic, expiry, serial and issuer plain. "Issued by Apple" is shown, never decided on. Always "not yet proven" until M2's first push. The Apple Account is typed and recorded, never verified |
| Same topic | A renewal must keep the topic (`APNS_TOPIC_CHANGED` otherwise, naming the devices that would re-enroll). A different topic only through `POST …/push-certificate/replace`, naming the current topic and acknowledging re-enrollment. Deleting the certificate keeps the topic, so the next one must match it |
| Renewal reminders | **30, 14 and 3 days** and once on expiry (the owner's M1 brief; the plan above said 30, 14, 7 and 1). Raised as **security alerts** through `SecurityAlertService`, from the MDM sweep, held by a global `notifications` pause, claimed once per certificate |
| ABM | Planned (M6) |
| Google key | Validated offline (type, project id, that project's service-account e-mail, key id, an RSA private key), rebuilt from those fields only and sealed (`rem0te-amapi-sa-key-v1`). Only the project, e-mail and key id's last four are shown |
| Google calls, quota, enterprise | **Planned (M3)**: the connection test, recording the granted quota (the plan put this in M1; it needs the M3 connection to mean anything) and enterprise sign-up |

**Why security alerts for reminders.** The monitoring alerts (`MonitorRule` / `MonitorAlert`) are per computer
and per business; the push certificate is one per install and belongs to no business. `SecurityAlert` is the
platform-level alert a Platform Admin already watches: recorded, audited, delivered to the configured alert
destinations unless suppressed, and already used for the same kind of platform fact (an SSO provider that cannot
be reached). The Settings page shows the expiry and the next reminder as well.

Every write is Platform Admin, `assertFresh` naming **`mdm.setup`** (§62, default `off` like the others), audited
with no secret in meta (`logOrFail` before a credential changes) and conditional on the row's revision. Deleting a
credential never asks for a fresh confirmation, is audited, and the page warns that deleting the push certificate
orphans every enrolled device. Migration 0100 holds one row (`MdmPlatformSetup`, never deleted) with CHECKs on
every list, the sealed shape and the topic.

## M2 as built (0.84.0)

Rem0te is the MDM server for iPhones and iPads: one-time enrollment links, a signed enrollment profile, the
check-in and command endpoints, an inventory-only command queue, the APNs push and the `apple` driver feeding the
0.80 sync. §93 holds it. **Nothing has run on a real iPhone or iPad, and no call has been made to Apple's push
service.** The proof is [mdmb](https://github.com/jessepeterson/mdmb) (a simulated device, MIT, pinned by commit),
a scratch step-ca on loopback and a loopback HTTP/2 stub standing in for APNs. Where the build differs from the
plan above, it says why.

### What runs where

| Piece | Built |
|---|---|
| Device CA | step-ca v0.30.2 as **`rem0te-mdm-ca`**, installed by `deploy/mdm-ca/rem0te-mdm-ca-setup.sh` (pinned by the release tarball's SHA-256). Its own system user; keys in `/var/lib/rem0te-mdm-ca` (0700), never readable by the portal. Listens on **`127.0.0.1:9451` only**, with one ACME provisioner, `rem0te-mdm`, offering only `device-attest-01` with Apple attestation. The script makes the root (EC P-384), the intermediate (RSA 3072, path length 0) and the profile-signing certificate (EC P-256), and never overwrites a key. **Not installed on this host** |
| Caddy | One route, `/acme/rem0te-mdm/*`, to `https://127.0.0.1:9451`, verified against the device CA's root copied to `/etc/caddy/rem0te-mdm-ca-root.crt`. It is in `deploy/caddy/Caddyfile` **commented out**; nothing else of step-ca is reachable |
| Wizard step 6 | Settings → Mobile devices: upload the device CA's root and intermediate (public certificates only, `checkDeviceCa`), upload the profile-signing certificate and key (`checkProfileSigner`; the key sealed under **`rem0te-mdm-profile-sign-v1`**), create and revoke one-time links, see enrolled devices. Renewal moved to step 7 and ABM to step 8, as in the design's table |
| Links | `POST /mdm/apple/links` (Platform Admin, `assertFresh` naming **`mdm.enroll`**, a §62 key, default `off`); 32 random bytes shown once, only the SHA-256 stored; per business, corporate only, 15 minutes to 24 hours (an hour by default). Revoking never asks |
| Profile | `GET /mdm/apple/enroll/<token>` claims the link with one conditional update (`open → claimed`) and returns a CMS-signed `.mobileconfig`: an ACME identity payload (`HardwareBound`, `Attest`, P-384) and the MDM payload with `SignMessage`, `CheckOutWhenRemoved`, production APNs and `AccessRights` 1309 (erase granted, never sent; decision 25). Any link that cannot be claimed is the same 404 |
| Check-in | `PUT /mdm/apple/checkin` (`Authenticate`, `TokenUpdate`, `CheckOut`). `Authenticate` must name a claimed link (`?enroll=`) within an hour of the claim, carry the push certificate's topic and run iOS/iPadOS 16 or later (decision 24); it consumes the link (`claimed → used`) in the same transaction that creates the device |
| Commands | `PUT /mdm/apple/server`. The queue holds only the five inventory commands, in this order: `DeviceInformation`, `SecurityInfo`, `InstalledApplicationList`, `ProfileList`, `CertificateList`. They are queued at the first `TokenUpdate` and again every 24 hours; `NotNow` puts a command back in the queue |
| Push | The MDM sweep pushes `{"mdm": PushMagic}` to every device with queued work (at most 100 a pass, not more often than hourly per device) through `common/safe-h2.ts`, one HTTP/2 connection per pass, with the push certificate as the TLS client certificate. `410` / `BadDeviceToken` stops pushing to that token; a refused certificate or topic stops the pass |
| Driver | `apple` in `PROVIDERS` and in the provider CHECKs (0101). It reads Rem0te's own Apple tables, through a reader the sync hands it, and calls nothing. The sync creates one `apple` connector per business with an enrolled device (`ensureAppleConnectors`, the only place a connector is created) and writes `MobileDevice` and `MdmCommand` as for any provider |

### Device authentication

Every request to `checkin` and `server` is verified before its body is parsed. The `Mdm-Signature` header must be
a detached CMS SignedData over the exact bytes, by one signer, whose certificate chains to the uploaded device CA,
is unexpired, is not a CA and allows client authentication. Anything else gets **401 with no body**. The device's
identity is the pair (UDID, certificate SHA-256), bound at `Authenticate`. Every later message must match both, so
a certificate from the same CA cannot speak for another device. A device that checks out is final (a trigger
refuses its return); it enrolls again with a new link. Bodies are bounded before they are read: 64 KB for a
check-in, 2 MB for a command result.

### Differences from the plan, and why

- **The ACME path is `/acme/rem0te-mdm/*`, not `/mdm/acme/*`.** step-ca builds the links in its ACME directory
  from the request's host and its own `/acme/<provisioner>/` prefix, which cannot be changed. Under `/mdm/acme/` a
  device would follow links Caddy does not route. This was checked against step-ca v0.30.2 on loopback.
- **The portal does not authorize each ACME order.** The plan said "the portal reaches it only on loopback for
  one-time authorizations". step-ca's `device-attest-01` has no per-order hook that calls back to Rem0te, so any
  genuine Apple device that reaches the route can get a certificate. That certificate does nothing by itself: a
  device can enroll only by naming a claimed, unexpired link at `Authenticate`, and the certificate is bound
  there. **Decided (27)**, below.
- **No PKCS#12, anywhere, not even in tests.** The plan allowed a PKCS#12 test identity because mdmb needed one.
  mdmb also speaks SCEP, so the suite gives it a SCEP identity from the scratch step-ca. That path exists only
  under `NODE_ENV=test` on `127.0.0.1` (`scepTestIdentity` refuses otherwise), and the install script refuses
  the SCEP provisioner without `--prefix`.
- **SHA-1 is accepted in `Mdm-Signature`**, with SHA-256/384/512. mdmb signs with SHA-1 (its CMS library's
  default), and that every Apple device uses SHA-256 is not confirmed. The authority is the device's own key and
  the chain to Rem0te's CA. **Decided (28)**: accepted for now, and the digest each device used is recorded
  (`AppleDevice.signatureDigest`, a closed CHECK) and shown in step 6, **to revisit once real devices have checked
  in**.
- **`AccessRights` is 1309, with erase (8)**, as the plan asked (decision 25). The first build had 1301, since M2
  sends no destructive command; but rights are fixed at enrollment, and nothing is enrolled yet, so erase is granted
  now to spare every device a re-enrollment at M5. It is **granted, never sendable**: no erase or wipe request type
  exists in the closed queue list or 0101's CHECK, and M5 brings the second person and the always-ask
  `mdm.destructive` check before one can.
- **No new sweep.** Pushes, re-queues and expiry run inside `MDM_SWEEP` (`AppleMdmService.pass`, called only by
  the sync), so `MDM_SWEEP=off` stops them and there is no new off switch.
- **Containment.** As the design's table: check-ins are always answered and inventory is not held by any pause.
  There is no lost-device or destructive command to hold (M4, M5).

### What is kept

0096's rule holds and 0101 adds to it. There is no IMEI, MEID, phone number, MAC address or signed-in user. A link
and a device are corporate only. The serial is kept on corporate devices. The push token and `PushMagic` are kept;
they can only wake a device, and only with the push certificate. They are in no audit row, log line or admin view.
`UnlockToken` is never read. `DeviceInformation` asks only for the fields Rem0te keeps. The other four commands keep
counts and two passcode booleans, never the lists themselves. Error results keep `apple:<domain>:<code>`, never
Apple's description text.

### Owner decisions (decided 2026-11-23, "accept recs")

| # | Decision | Decided | What 0.84 does |
|---|---|---|---|
| 25 | **`AccessRights`** | **Grant erase now**: nothing is enrolled yet, and adding it at M5 would mean every device enrolling again | 1309 = inspect profiles (1) + lock and passcode removal (4) + erase (8) + device information (16) + inspect installed apps (256) + security queries (1024). No profile or app installation. Erase is **granted, never sendable**: no erase or wipe request type in `REQUEST_TYPES` or 0101's CHECK (§93); the second person and the always-ask `mdm.destructive` arrive with M5 |
| 26 | **ACME path** | **`/acme/rem0te-mdm/*`** | As above; in every enrolled device's profile for good |
| 27 | **ACME with no per-order authorization** | **Accepted** | Any attested Apple device reaching the route can get a certificate; enrollment still needs a claimed, unexpired link, and the certificate is bound at `Authenticate`. A step-ca webhook provisioner could close it later |
| 28 | **SHA-1 in `Mdm-Signature`** | **Accepted for now; record and revisit** | SHA-1, SHA-256, SHA-384 and SHA-512 are accepted. Each device's newest verified digest is `AppleDevice.signatureDigest` (0101 CHECK, `SIGNATURE_DIGESTS`), shown in step 6's device list. **Revisit once real devices have checked in**: if they all use SHA-256, refuse SHA-1 |

### Host changes at deploy (none made)

1. Run `deploy/mdm-ca/rem0te-mdm-ca-setup.sh --dns-name <portal name>` as root. It installs and starts step-ca as
   `rem0te-mdm-ca` and writes the public certificates and the profile signer's handoff key.
2. Copy the CA's `root_ca.crt` to `/etc/caddy/rem0te-mdm-ca-root.crt`, uncomment the one route in the Caddyfile,
   and reload Caddy.
3. In Settings → Mobile devices step 6, upload the root and intermediate, then the profile-signing certificate and
   key, and delete the handoff key.
4. Migration 0101 (`prisma migrate deploy`, then `prisma generate` at the target, as for any schema change).

### What has been tested

| Proof | What |
|---|---|
| Unit (`unit-mdm-apple.mjs`, in CI) | plist parsing and its refusals (DTD subset, entities, depth, size, duplicate keys, binary plists). Detached signatures made by openssl: accepted, and refused when the body changed, the CA differs, the certificate is expired, not yet valid or a CA, the signature is attached, there are two signers, or the input is not CMS; BER is converted. The signed profile verifies with openssl and has no PKCS#12. Check-in and report reading (no UnlockToken, no IMEI, no user channel). The APNs body and status mapping. The driver's records through the sync's own parsers. The step 6 certificate checks. 0101's lists |
| API (`e2e-mdm-apple.mjs`, ports 4061–4064, in `run-e2e.sh`) | A scratch step-ca installed by the real setup script under `--prefix`. ACME on loopback: a directory whose links follow the host, and an order offering only `device-attest-01` (no attestation: only a real device makes one). Steps 1–6 through the API with stand-in Apple certificates. Links, the one-time profile, refusals (no signature, a wrong signer, a wrong topic, iOS 15, a used link). mdmb enrolling through SCEP, checking in and answering commands: `DeviceInformation` and `ProfileList` are answered; the other three are refused by mdmb (`12021`) and recorded as errors. The push to the HTTP/2 stub, with the exact body and headers. The sync writing `MobileDevice` and `MdmCommand`. `CheckOut`, revoke and an expired claim. No secret in any answer or audit row |
| Browser (`e2e-ui.mjs`) | Step 6 asks for the device CA and the profile signer before any link, and says nothing is proven |
| Not tested | **A real iPhone or iPad; real APNs; Apple attestation; OTA enrollment on a device.** The iOS Simulator is not known to enroll in MDM |

## M3 as built (0.85.0)

Rem0te is the EMM for Android on Google's Android Management API (AMAPI). M3 adds:

- the connection test;
- each business's enterprise sign-up, started from inside Rem0te;
- the default policy;
- one-time enrollment tokens;
- the `android` driver, which feeds the 0.80 sync.

§94 holds it. **No real Google API has been called from this server, no enterprise has been created and no device
has enrolled.** The proof is a loopback stand-in in AMAPI's shape. It serves the token endpoint, `signupUrls`,
`enterprises`, `policies`, `enrollmentTokens`, a paged `devices.list` and `operations`. The API reaches it only
under `NODE_ENV=test`, through `AMAPI_TEST_BASE_URL` on `127.0.0.1`. Where the build differs from the plan above,
it says why.

### What runs where

| Piece | Built |
|---|---|
| Client | `mdm/drivers/android/amapi.ts` is the only place Google's hosts appear. They are two constants, `GOOGLE_TOKEN_URL` (`oauth2.googleapis.com/token`) and `AMAPI_ORIGIN` (`androidmanagement.googleapis.com`), plus the scope identifier, each once (§90's allowed list). Every call goes through `safe-https`: `safeGet`, `safePost` and the new `safePatch`. `safeDelete` also exists, but nothing calls it. Each call is bounded at 20 s and 4 MB. Errors are short codes, never Google's text |
| Token | Rem0te signs an RS256 JWT with the sealed service-account key, which `MdmSetupService.openAndroidCredential` opens in memory. The JWT asks for one scope and lives an hour; it is exchanged at the token endpoint. The access token lives **only in memory**, in one unexported map keyed by a SHA-256 of the credential. It is kept until five minutes before it expires; a 401 drops it and retries once |
| Step 3: test | `POST /mdm/android/test` gets a token, then makes one read: `enterprises.list` for the key's project, one item. The outcome is recorded for the key tested: `ok`, `bad_key`, `permission_denied`, `quota`, `unreachable` or `bad_response` (0102 CHECK). It is reset whenever the key changes. The test cannot check quota |
| Step 4: quota | `PUT /mdm/setup/android/quota` records the number Google granted, as the Platform Admin types it. It is never read from Google, and Rem0te does not enforce it: Google does |
| Step 5: sign-up | `POST /mdm/android/signup {businessId}`, allowed only after a passed test. Rem0te makes 32 random bytes of state and stores only their SHA-256 in `AndroidSignup`. The row is bound to the business and the Platform Admin and lasts 30 minutes (0102 caps it at an hour). `signupUrls.create` gets the callback `https://<public API>/api/v1/mdm/android/signup/callback?state=…`. The page shows Google's link, to open or to send to the business's admin |
| Callback | `GET /mdm/android/signup/callback`, `@Public`, `@RateLimit(10)`. The session cookie is `SameSite=Strict`, so Google's cross-site redirect carries none, and the state is the only credential. In order: (1) **one conditional update** claims the state (`open → claimed`, unexpired) before anything is read; (2) the Platform Admin must still be one, the business unbound, no `integration` pause in effect, and the `enterpriseToken` well formed; (3) `enterprises.create`; (4) `MDM_ANDROID_ENTERPRISE_BOUND` with `logOrFail`; (5) the enterprise row and `claimed → bound`, in one transaction. Every outcome is a 303 to the settings page with a code, never Google's text |
| Step 6: policy | `rem0te-default` is patched as exactly `{statusReportingSettings: {softwareInfoEnabled: true, applicationReportsEnabled: true}}`. There is no update mask, so nothing else is on. **It never enables network info**, which carries the IMEI and MAC addresses. It is applied after binding, and again on request |
| Step 6: tokens | `POST /mdm/android/enrollment-tokens` makes a one-time token for 15–60 minutes (an hour by default). Each token is *work profile* (`PERSONAL_USAGE_ALLOWED`) or *fully managed* (`PERSONAL_USAGE_DISALLOWED`). The value and a QR code are returned once and never stored; the QR is a PNG data URL the API makes from Google's `qrCode`. The audit row (`logOrFail`, before the answer) carries ids. Only the web page builds the link `https://enterprise.google.com/android/enroll?et=…` |
| Driver | `android` is in `PROVIDERS` and in both provider CHECKs (0102). `devices.list` is paged at 100 and asks, through `fields=`, only for the fields Rem0te keeps. Operations are read per device: 25 devices a command page, at most 250 a pass. A `404` or `501` is read as no Operations. The sync creates one enabled `android` connector per bound enterprise (`ensureAndroidConnectors`, named by its enterprise id). It remains the only writer of `MobileDevice` and `MdmCommand` |

### Differences from the plan, and why

- **Sign-up is on Settings → Mobile devices, not on the business's page.** Every Android step is Platform Admin
  only, and one page keeps the order visible: test, then sign-up, then policy.
- **The link can be sent.** The plan had the Platform Admin's own browser go to Google. The callback needs no
  session, so the business's own admin may open the link instead (decision 29). Either way, the enterprise is
  bound in the name of the Platform Admin who asked for the link.
- **Operations are bounded at 250 devices a pass.** Each device's Operations are a separate call. An enterprise
  with more devices syncs as `partial`: every device is read, but Operations only for the first 250 by id
  (decision 30). In M3 Rem0te issues no command, and Operations come only from commands an EMM issued, so a real
  enterprise will list none.
- **`policyCompliant` is the compliance state.** The default policy requires nothing, so a device reports
  compliant. A non-compliance reason is kept as Google's reason code, in words.
- **A personal device is `byod`.** Only `COMPANY_OWNED` is corporate. `PERSONALLY_OWNED` and unspecified ownership
  are both `byod`, so the stricter keep-rule applies.
- **A WIPE depends on the scope.** On a work profile it is shown as `remove_managed_data`, because it removes only
  the work data. On a fully managed device it is shown as `wipe`. Nothing sends either.

### What is kept

0096's rule holds:

- **No IMEI, MEID, phone number, MAC address or user.** `networkInfo`, telephony and `userName` are never asked
  for, and never read if a server sends them.
- **The serial only on corporate devices.**
- **Kept:** the state (as its SHA-256), the enterprise id, the policy version, the test result and the recorded
  quota.
- **Never kept:** Google's `enterpriseToken` (used once, in memory), an enrollment token's value, any access token.

There is no new secret-box purpose. The only secret is the 0.83 service-account key (`rem0te-amapi-sa-key-v1`).

### Containment, who and the record

- **Containment.** Every outbound call checks the `integration` pause first:
  - the connection test checks the global pause;
  - sign-up, the callback, the policy and tokens check the business's;
  - the sync checks per connector (0.80), before `devices.list`.
- **Who.** Every write is Platform Admin (class guard) with `assertFresh`. The test, the quota, a sign-up and the
  policy name **`mdm.setup`**. A token names **`mdm.enroll`**, now labelled *Mobile enrollment links and tokens*.
  Both default to `off`.
- **The record.** Six audit actions: `MDM_ANDROID_TESTED`, `_SIGNUP_STARTED`, `_SIGNUP_FAILED`,
  `_ENTERPRISE_BOUND`, `_POLICY_SET` and `_TOKEN_CREATED`. They carry ids, kinds and codes, never a key, a state, a
  token or a URL.
- **No command.** There is no `issueCommand`, no `devices.delete` and no enterprise deletion. Those are M4 and M5.
  (0.86 adds `issueCommand` for the three lost-device commands only; see [M4 as built](#m4-as-built-0860).)
- **No new sweep.** `AndroidEmmService.pass` (sign-up expiry) and `ensureAndroidConnectors` run inside
  `MDM_SWEEP`. `MDM_SWEEP=off` stops them, as it stops the sync.

Migration 0102:

- adds `android` to the provider CHECKs;
- adds the test and quota columns;
- adds `AndroidSignup`: closed states, the state as a SHA-256, at most an hour, a shape per state. A finished
  sign-up stays final and is never reopened;
- adds `AndroidEnterprise`: one per business, one business per enterprise, the one policy id;
- adds same-business triggers on both tables.

### Owner decisions (decided 2026-11-24, "accept recs")

| # | Decision | Decided | What 0.85 does |
|---|---|---|---|
| 29 | **Who opens Google's sign-up page** | **The customer's own admin, sent the link**: they hold the managed Google domain, and the link is one-time, lasts 30 minutes and is bound to that business | Both: *Open at Google* and *Copy link* |
| 30 | **Operations on large enterprises** | **At M4, read Operations only for commands Rem0te issued**: Operations only come from EMM-issued commands, so reading each by the command's own name bounds the calls by the number of open commands | Until M4, the 250-device bound, documented; a sync above 250 devices is `partial` |
| 31 | **Unbinding a business** | **None until M5**: deleting an enterprise unenrolls every device, so it belongs with M5's second person and always-ask check | Nothing unbinds. Deleting a business removes only Rem0te's rows; the enterprise stays at Google |

### Host changes at deploy (none made)

1. Migration 0102: `prisma migrate deploy`, then `prisma generate` at the target.
2. The server's public address (Settings → General) must be https, because it is Google's callback.
3. Nothing else. Caddy already sends `/api/*` to the API. There is no unit, sudoers or dependency change.

Before a real enterprise:

1. Google grants quota (G3) and accepts the permitted-use review (decision 21).
2. Then one test phone (G5).

### What has been tested

| Proof | What |
|---|---|
| Unit (`unit-mdm-android.mjs`, in CI) | **The policy and token body**: both exactly as specified. **The JWT**: RS256, one scope, an hour, verifying under the key. **Device mapping**: states, ownership, scope and compliance; a personal device's serial dropped by `parseDevice`; IMEI, network info and users never read; unknown states skipped. **Operation mapping**: accepted at creation; completed only when `done` without an error; a work-profile WIPE as `remove_managed_data`. **Also**: query escaping, 0102's lists and the capability states. **The client**, against an in-process loopback stand-in: the token exchange, caching keyed by the credential, a 401 retried once, `fields`, error codes. Under `NODE_ENV=test` without a stand-in, `not_ready` and no request |
| API (`e2e-mdm-android.mjs`, ports 4081–4083, in `run-e2e.sh`) | **Access**: Platform Admin only, and every step's fresh confirmation. **The test**: a refused key, the JWT checked against the uploaded key, exactly one read, a global pause. **The quota.** **Sign-up**: the stored SHA-256 and the callback URL. Google's redirect, simulated without a cookie, then refused for a replay, for four of five racing callbacks (one enterprise is bound), for an unknown, expired or malformed state, with no token, for an admin who is no longer one, and under a pause. **0102** refuses a reopen and a two-hour sign-up. **The policy body.** **Tokens**: work profile and fully managed, the QR, the value stored nowhere. **The sync**, with `MDM_SWEEP` on: one connector per enterprise; 130 devices over two pages; a personal device's serial dropped; an unknown state skipped; Operations as commands; a missing device marked not reported; a business pause making no call; an unfinished sign-up expired. **Secrets**: none in an answer, an audit row or the log |
| Browser (`e2e-ui.mjs`) | Steps 3–6 shown from seeded rows, with no call made: the per-token choice, the "nothing proven" note, and the note after Google's redirect |
| Not tested | **Google's real API, a real enterprise sign-up, a managed Google domain, quota, and a real Android device.** Whether `devices.operations.list` is served for AMAPI is unconfirmed; a `501` is read as no Operations |

## M4 as built (0.86.0)

Rem0te sends its first commands to phones and tablets. There are exactly three, on both platforms:

| Rem0te kind | Apple (own MDM) | Android (AMAPI) | Takes a message |
|---|---|---|---|
| `lock` | `DeviceLock` | `LOCK` | Apple only: a lock-screen message and phone number |
| `lost_mode_start` | `EnableLostMode` | `START_LOST_MODE` | Yes, and needs a message or a phone number |
| `lost_mode_stop` | `DisableLostMode` | `STOP_LOST_MODE` | No |

Erase, wipe, retire and removing work data are still M5's. They are in no list, CHECK or command table, so
nothing can send one. §95 holds M4.

**No real iPhone, iPad or Android device has received a command, and no call has been made to Apple or Google.**
The Apple proof is mdmb and hand-signed device messages through a scratch step-ca, with a loopback APNs stub. The
Android proof is the AMAPI-shaped loopback stand-in, which now also serves `devices.issueCommand` and
`operations.get`.

### What runs where

| Piece | Built |
|---|---|
| Route | `POST /mobile-devices/:id/commands` `{kind, message?, phoneNumber?}`. It needs `mobile:act` (`@RequireCapability`) and `@RateLimit(10)`. `GET /mobile-devices/:id/commands` now also returns `canSend` and `actions`: each kind, whether this device can take it, and why not |
| The rules | `mdm/lost-device.ts`, pure, imports only `./model`. It holds the three kinds, the request's checks (at most 160 printable characters; no control characters or bidi overrides; the phone number `^[+0-9][0-9 ().-]{2,30}$`; refused, never trimmed) and the device's refusals. The console's buttons are drawn from the same function the send path calls |
| The sender | `MdmActionService` is the only caller of a driver's `send()`. In order: (1) scope with `mobile:view`, then `mobile:act`, and the device read through that scope (another business's is a 404); (2) the request; (3) `assertFresh` naming **`mdm.act`**; (4) the device's refusals; (5) the `actions` containment pause (business or global), and for Android also `integration`; (6) one open command of the same kind per device; (7) `MDM_COMMAND_REQUESTED` with `logOrFail`; (8) the `MdmCommand` row, `origin: portal`, queued, carrying Rem0te's own id; (9) `send()`; (10) the row moved once, through the 0.80 state machine, then `MDM_COMMAND_SENT` or `MDM_COMMAND_SEND_FAILED` |
| Apple | `send()` puts one `AppleCommand` in Rem0te's own queue under Rem0te's id (`queueLostDevice`) and pushes the device at once. The queue re-checks everything: the device enrolled in that business, lost mode only when it reported `IsSupervised` true, the text checked again. The device fetches the command on its next connection. That is the **provider's acceptance**; the device's `Acknowledged` is **completion**, and its `Error` is a failure with Apple's code. The 0.84 sync records both, as it does inventory |
| Android | `send()` makes one `devices.issueCommand` with exactly `{type, duration}`. `STOP_LOST_MODE` adds `stopLostModeParams: {}`. `START_LOST_MODE` adds `startLostModeParams` with the message and phone number as `defaultMessage`s. `duration` is the command's seven days. The Operation Google returns is **acceptance**, and its name becomes the command's id (`<device>:<operation>`). The Operation `done` without an error is **completion** |
| Decision 30 | The sync no longer lists each device's Operations. It reads, by name (`operations.get`), only the Operations of commands Rem0te issued that are still open: 25 a page, 10 pages a pass. A command another EMM made never appears, and the 250-device bound is gone |
| The sync | A connector with an open command from Rem0te is read again after a minute (`OPEN_COMMAND_RESYNC_MS`), not after `MDM_SYNC_MINUTES`. That way accepted and completed show up within a sweep or two. It is still bounded by `CONNECTORS_PER_PASS` |
| The console | The mobile device page has a *Lost or stolen* card, shown only to someone who may send (`canSend`). Its three buttons are the server's `actions`, and an unavailable one is disabled with the server's reason. A confirmation dialog explains each command, takes the lock-screen message and phone number where the platform shows them, and asks for re-authentication when `mdm.act` asks. The history says who asked, with *accepted by the provider* and *completed on the device* side by side |

### Who may send

- **`mobile:act`** is a new business capability: *Lock mobile devices and use lost mode*. It is not a Business User
  default, a legacy role's or a preset's, so it is granted by hand. A Business Owner holds every business
  capability, so an owner holds it too (decision 35). A technician needs it on an assignment covering the whole
  business, as with `mobile:view`. A Platform Admin may send to any business's device.
- **`mdm.act`** is the new §62 key, *Mobile device lock and lost mode*. Like every key it defaults to `off`, so with
  no saved choice only sign-in is asked (decision 36).
- **Personal devices.** On a personal Android device lost mode is refused (`LOST_MODE_NOT_ON_PERSONAL`), because
  Google offers it only on company-owned devices. A lock is allowed (decision 33). Every Apple enrollment in Rem0te
  is corporate (0.84). On Apple, lost mode needs supervision (`LOST_MODE_NEEDS_SUPERVISION`), and a device that has
  not reported is treated as unsupervised. It is never sent "to find out".

### What is kept

- **The lock-screen message and phone number are not kept on `MdmCommand`** and never reach an audit row or a log
  line. The audit meta says only `hasMessage` and `hasPhoneNumber`. Android's are sent once and stored nowhere.
- **Apple's queue must hold them** until the device fetches the command. `AppleCommand.lockMessage` and `lockPhone`
  exist only on an open `DeviceLock` or `EnableLostMode`. 0103's CHECK bounds them, and its trigger clears them the
  moment the command is final (acknowledged, error, cancelled or expired). Decision 32 asks whether that is right.
- **Who asked** (`requestedById`) is on every Rem0te command. 0103 refuses a portal command without it.

### Containment and the record

- **`actions`** (its label is now *approved actions, patch rings and mobile lost-device commands*) refuses every
  kind at the send. On Apple it also **holds** commands already queued: `next()` hands the device only inventory,
  and the push skips a device whose only work is held. Lifting the pause releases them.
- **`integration`** also refuses an Android send, because the send is a call to Google. An Apple send is not a call
  out: the device fetches the command, so `integration` is not consulted.
- **Three audit actions**: `MDM_COMMAND_REQUESTED` (with `logOrFail`, before anything is sent),
  `MDM_COMMAND_SENT` and `MDM_COMMAND_SEND_FAILED`. They carry the command, the device, the kind, the provider and
  a code, never text.

Migration 0103:

- adds the three audit actions;
- re-makes the Apple request-type CHECK with the three lost-device types, still without `EraseDevice`;
- adds `lockMessage` and `lockPhone`, with a CHECK and the clearing trigger;
- adds a CHECK that a portal command names who asked, carries an id and is one of the three kinds;
- adds a partial unique index allowing one portal command of a kind per device while it waits for the provider.

### Differences from the plan, and why

- **Accepted means different things on each platform, and the page says which.** On Apple, acceptance is the
  device fetching the command: Rem0te *is* the provider, so "queued in Rem0te" is not acceptance. On Android it is
  Google's Operation.
- **No `locate`.** Apple's `DeviceLocation` and `PlayLostModeSound` need lost mode and send a location to the
  server. They are not in M4's scope, and a location is personal data the design has not decided to keep.
- **The 160-character message.** Apple and Google document no limit that fits every lock screen. 160 fits one on
  every device we found described.
- **The UI suite never confirms a command.** It opens the lock dialog on an Apple device and cancels it. The API
  suites send.

### Owner decisions this raises (proposed, not yet decided)

| # | Decision | Options | Recommendation |
|---|---|---|---|
| 32 | **The lock-screen text in Apple's queue** | (a) keep it on the open `AppleCommand` until it is final, then clear it (as built); (b) seal it under its own secret-box purpose while it waits; (c) send no message on Apple | **(a)**: the device must be handed the text, it is shown on a lock screen to whoever holds the device, and it is cleared the moment the command is final. Sealing it protects nothing the queue row does not already protect |
| 33 | **Lock on a personal Android device** | (a) allow it (as built); (b) refuse it like lost mode | **(a)**: a lost work phone with company data is the main case. With a separate work challenge Google locks only the profile, and the page says that without one the whole phone locks |
| 34 | **How long a lost-device command waits** | (a) seven days (as built); (b) one day; (c) thirty days, Google's maximum | **(a)**: a lost phone may be off for days, and after a week the situation has usually moved on to M5's erase |
| 35 | **Business Owners and `mobile:act`** | (a) an owner holds it, as every business capability (as built); (b) Platform Admin only until M5 | **(a)**: locking a business's own lost phone is the owner's call, the command is not destructive, and every one is audited with who asked |
| 36 | **`mdm.act` default** | (a) `off`, like every key since 0.64 (as built); (b) `ask` | **(a)**, as the owner asked in 0.64 ("just on login"); Settings → Confirm it is you can turn it on |

### Host changes at deploy (none made)

1. Migration 0103: `prisma migrate deploy`, then `prisma generate` at the target.
2. Nothing else: no unit, sudoers, Caddy or dependency change. `mobile:act` is granted to no one by the migration.

Before a real command reaches a device, the M2 and M3 prerequisites still hold: a real push certificate (A3) and a
test iPhone (A6), and Google's quota (G3) and a test phone (G5). Lost mode on an iPhone also needs supervision,
which in practice means Apple Business Manager (M6).

### What has been tested

| Proof | What |
|---|---|
| Unit (`unit-mdm-lost-device.mjs`, in CI) | **The kinds and the request**: refusals for long, control, bidi and wrong-typed text, bad phone numbers, text on stop, lost mode without text. **The refusals matrix**: supervision, enrollment type, ownership, enrollment state, a disabled connector, the stand-in. **Apple**: the eight request types; `commandFor` carrying only checked text. **Android**: the `issueCommand` bodies, no body for anything else, and the Operation id both ways. **Both drivers' `send()`**: Apple's queue refusals as codes; Android against an in-process stand-in, with Google's errors as short codes. **Also**: the state machine (accepted is not completed) and 0103's lists. `unit-mdm-apple.mjs` and `unit-mdm-android.mjs` are updated |
| API, Android (`e2e-mdm-android.mjs`, ports 4081–4083, in `run-e2e.sh`) | The sync no longer lists Operations: the stand-in's LOCK, WIPE and lost mode, as if from another EMM, never appear. The fresh confirmation names `mdm.act`; another business's device is a 404; eight bad requests are refused; lost mode on a personal device is refused; the `actions` and global `integration` pauses refuse with nothing sent. The exact `issueCommand` bodies. Accepted at issue, completed only when the Operation is done, read by name, never asked again. A refused issue is a 502 and a failed command with a code. The history says who asked. No message or phone number in any audit row, command row or log |
| API, Apple (`e2e-mdm-apple.mjs`, ports 4061–4064, in `run-e2e.sh`, with mdmb and step-ca) | Lost mode is refused on a device that never reported supervision. A lock is queued under Rem0te's id with its text; a second lock is refused. Under an `actions` pause the device is handed its five inventory commands and never the lock; lifted, it fetches `DeviceLock` with its `Message` and `PhoneNumber`. Fetched is accepted; `Acknowledged` is completed, and 0103's trigger cleared the text. Once supervised, lost mode carries only what was given, and the device's `Error` is a failure. 0103 refuses `EraseDevice`. mdmb, which implements no lock, answers `Error 12021`, a failed command |
| Browser (`e2e-ui.mjs`) | A stand-in device: all three buttons disabled with the reason. An Apple device: Lock offered, lost mode not ("supervised"), the dialog's fields and a bad phone number refused, then cancelled with nothing sent |
| Not tested | **A real iPhone, iPad or Android device, APNs, and Google's real `issueCommand` and `operations.get`.** Whether a real device shows a 160-character message whole is unconfirmed |
