# Deploying agents and adopting computers

Rolling the agent out to many computers at once — from Group Policy, Intune,
another RMM, or a Linux or macOS script — and assigning the computers that
arrive to the right business (0.57).

Everything on this page is **Platform Admin only**. A Business Owner adds
computers one at a time from **Devices → Add device**, with a single-use code,
exactly as before; nothing about that changed.

---

## The pieces

| | What it is | Where |
|---|---|---|
| **Deployment key** | A multi-use enrolment key for one business, with a use limit and an expiry of at most 90 days | **Devices → Deploy agents** |
| **Unassigned computers** | Computers that enrolled through an authorised route but belong to no business yet | **Devices → Unassigned** |
| **Assignment rules** | Explicit rules that *suggest* a business and site for an unassigned computer | **Devices → Unassigned → Assignment rules** |

A computer reaches the unassigned list in one of three ways, shown as
*Arrived* on the list:

- **Deployment key** — it enrolled with a key in *review* mode;
- **Install script** — the installer checked in (with a device secret) before
  any claim succeeded, for example a signed install run without a code;
- **Agent check-in** — an agent's heartbeat arrived for a computer the server
  did not know, with a device secret.

A heartbeat without a device secret creates nothing, as before.

---

## Deployment keys

**Devices → Deploy agents → New deployment key.** Choose the business, and
optionally a site and one static group; give it a name; set how many computers
it may enrol (1 to 10,000) and how many days it lasts (1 to 90).

Then choose what happens when a computer uses it:

- **Hold it in Unassigned for review** (the default, and the recommendation).
  The computer appears under **Devices → Unassigned**, tagged with the key, with
  the key's business and site suggested. Nobody in the business sees it, and
  nothing can connect to it, until a Platform Admin assigns it.
- **Put it straight into this business.** The computer goes into the key's
  business, site and group, active, with the key's access mode. Anyone holding
  the key can add a computer to that business until the key expires, is used up
  or is revoked — choose this only for a rollout you control end to end.

Creating a key asks you to confirm it is you when *Settings → Confirm it is you*
has **Deployment keys** set to *Ask* (from 0.64 every function there starts at
*Don't ask*). The key is shown **once**: copy it then. The
server keeps only its SHA-256 and the last four characters (shown as `…ab12`
so you can tell keys apart), and it appears in no list, audit entry or log.

A key is 96 hexadecimal characters. Every installer already accepts it in the
place it takes a single-use code, so there is no new installer and no new
option: the Windows script, `windows.exe`, the signed agent's
`rem0te-agent.exe install --token`, `linux.sh` and `macos.sh` all work with it,
and so does the `.msi` (0.65) as `TOKEN=`.

**Uses are counted exactly.** Each computer that enrols takes one use, counted
in one conditional database update, so twenty computers enrolling at the same
moment on a key with ten uses left produce ten enrolments and ten refusals,
never eleven. A computer that is already enrolled — a Group Policy startup
script running on every boot, an Intune retry — changes nothing and uses
nothing.

**A key never moves a computer between businesses.** A computer that already
belongs to a different business is refused, and so is one whose Remote ID is
known with a different device secret. A key for business A cannot enrol, move
or reveal anything of business B.

**Revoke** a key when the rollout is done (no confirmation is asked; making
things safer never asks). Computers it already enrolled are not affected; new
installs using it are refused, and the install scripts stop carrying it.

---

## Instructions for each method

The **Instructions** card on **Deploy agents** generates the commands for each
method below. They are built **in your browser**: paste a key (or create one —
it is filled in automatically) and the commands show it; otherwise they show
`<DEPLOYMENT-KEY>`. The key is not sent anywhere by this, and this page you are
reading never contains one.

Every method runs the same installer as **Add device**. On Windows that
installs the signed agent when this server publishes one, and the standard
agent otherwise.

The Windows Installer package (`.msi`, 0.65) is a fourth way, below; it takes
the key as `TOKEN`.

### Group Policy (Active Directory)

A computer **startup script**, which runs as SYSTEM before anyone signs in:

```powershell
# install-rem0te.ps1 - runs as SYSTEM. Exits at once on a computer that already has the agent.
if (Get-ScheduledTask -TaskName 'Rem0teHeartbeat' -ErrorAction SilentlyContinue) { exit 0 }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$log = Join-Path $env:ProgramData 'Rem0te-deploy.log'
try { Invoke-RestMethod -UseBasicParsing 'https://<portal>/api/v1/public/install/win/<DEPLOYMENT-KEY>' | Invoke-Expression *>> $log } catch { "$(Get-Date -Format o) $_" | Out-File -Append $log; exit 1 }
```

Group Policy Management → a new GPO → *Computer Configuration → Policies →
Windows Settings → Scripts (Startup/Shutdown) → Startup → PowerShell Scripts*
→ add the file, and link the GPO to the OU. Computers install on their next
restart.

The script lives in SYSVOL, which every computer and user in the domain can
read. Give the key a use limit near the number of computers and an expiry near
the end of the rollout, and revoke it afterwards.

### Intune

- **Platform script** (simplest): *Devices → Scripts and remediations →
  Platform scripts → Add → Windows 10 and later*, the same file, *run as the
  logged-on user: No*, *64-bit PowerShell: Yes*.
- **Win32 app** (for a detection rule and retries): package the file with
  `IntuneWinAppUtil.exe`, install command
  `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install-rem0te.ps1`,
  install behaviour *System*, and a custom detection script:
  `if (Get-ScheduledTask -TaskName 'Rem0teHeartbeat' -ErrorAction SilentlyContinue) { 'Installed' }`.
- **Line-of-business app** (the .msi, below): upload `rem0te.msi` and put
  `TOKEN=<DEPLOYMENT-KEY>` in *Command-line arguments*.

### Windows Installer package (.msi, 0.65)

**It has never been run on real Windows.** It was built and read back on Linux
(`msiinfo`, `msiextract`) and its parts are tested there; try it on one
computer before a rollout, and tell us what happened.

```text
https://<portal>/api/v1/public/install/windows.msi                       the package, no key inside
msiexec /i rem0te.msi TOKEN=<DEPLOYMENT-KEY> /qn /l*v "%ProgramData%\Rem0te-msi.log"
```

What it is:

- **A per-machine package that carries the signed agent**, byte for byte the
  published `windows/rem0te-agent.exe`, in its Binary table, and one custom
  action. On a first install it runs that agent, deferred, as SYSTEM:
  `rem0te-agent.exe install --token <TOKEN> --portal <portal>`. That is the
  same command the `.exe` download runs when it is double-clicked, so nothing
  about enrolment changes: the agent verifies the installer, RustDesk and the
  tray against signed metadata, and the claim decides where the computer lands.
  A failed install fails the `msiexec` (exit 1603), so Intune and the RMM see it.
- **It needs a signed agent.** Only the signed agent takes a token on its
  command line. A server that does not publish one answers
  `503 MSI_NEEDS_SIGNED_AGENT`; use the startup script or the `.exe`.
- **`TOKEN` is required on install**, and must be hexadecimal: a missing one,
  or one with a space or a quote, stops the install at its launch condition
  with a message saying so. `TOKEN` is hidden from the installer's log. A
  deployment key (96 hex) and an Add device code (64 hex) both work.
- **Uninstalling it removes only its own entry** in *Programs and Features* (and
  the `HKLM\SOFTWARE\Rem0te\Installer` marker it writes). It installs no files
  and never removes the agent. The agent updates itself from signed releases,
  which a Windows Installer repair would roll back, and a computer leaves
  through the console (see [offboarding.md](offboarding.md)), not through
  Programs and Features. A newer package replaces an older one's entry.
- **Downloading it consumes nothing.** The computer's first check-in uses the
  key, exactly as with every other method; a computer already enrolled uses
  nothing.

**Group Policy Software Installation** cannot pass `TOKEN` on a command line.
Use the startup script above, or download a package with the key already in it
(`windows.msi?token=<DEPLOYMENT-KEY>`) and assign that. That copy carries the
key in the share, like the script does, and Windows keeps a copy of every
installed package in its installer cache on each computer: give the key a use
limit and an expiry, and revoke it when the rollout is done.

The server builds each package when it is downloaded, with `wixl` and
`msibuild` from the `msitools` package (`apt-get install wixl msitools`). A
server without them answers `503 MSI_BUILDER_UNAVAILABLE`, and **Add device**
says so. Each build happens in its own private temporary directory, removed
before the download is sent; nothing is cached.

### An existing RMM

Anything that can run a command as SYSTEM or root (Automate, NinjaOne, Datto,
Tactical RMM, PDQ, SCCM…):

```text
Windows: powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "if (Get-ScheduledTask -TaskName 'Rem0teHeartbeat' -ErrorAction SilentlyContinue) { exit 0 }; irm 'https://<portal>/api/v1/public/install/win/<DEPLOYMENT-KEY>' | iex"
Linux:   curl -fsSL 'https://<portal>/api/v1/public/install/linux/<DEPLOYMENT-KEY>' | bash
macOS:   curl -fsSL 'https://<portal>/api/v1/public/install/mac/<DEPLOYMENT-KEY>' | bash
```

The other RMM's job history keeps the command, and so the key.

### Manual

`irm 'https://<portal>/api/v1/public/install/win/<DEPLOYMENT-KEY>' | iex` in an
elevated PowerShell, the `windows.exe?token=` download with the key built
in, or the `.msi` above. For a single computer, **Add device**'s single-use code is the better tool.

### Linux

```bash
curl -fsSL 'https://<portal>/api/v1/public/install/linux/<DEPLOYMENT-KEY>' | sudo bash
```

Or, checked: download it, read it, record its checksum, then run the file you
read:

```bash
curl -fsSLo rem0te-install.sh 'https://<portal>/api/v1/public/install/linux/<DEPLOYMENT-KEY>'
sha256sum rem0te-install.sh
less rem0te-install.sh
sudo bash rem0te-install.sh
```

There is no fixed published checksum: the script is generated for the key and
for this server's RustDesk version and relay, so it changes when they do.
**Deploy agents** can compute the SHA-256 of the script as served right now;
record it on the day you roll out and compare the copy your configuration
management distributes against that.

### macOS

```bash
curl -fsSL 'https://<portal>/api/v1/public/install/mac/<DEPLOYMENT-KEY>' | sudo bash
```

In an MDM (Jamf Pro, Kandji, Mosyle, Intune for macOS), the same as a script
payload, which runs as root. Grant RustDesk's Screen Recording and
Accessibility permissions with a PPPC profile.

**There is no `.pkg`.** Building, signing and notarising a macOS installer
package needs Apple's tools (`pkgbuild`, `productsign`, `notarytool`) and an
Apple Developer ID, which this Linux server does not have. The script is the
supported route.

---

## Unassigned computers

**Devices → Unassigned** lists every computer in the pool with what identifies
it: hostname, Remote ID, platform, how it arrived and with which key, the
address the server saw it connect from, first and last seen, and — once its
first inventory arrives — manufacturer, model, serial number, operating system,
domain, processor, memory and disk. Expand a row for the full list.

**Who is signed in to the computer is never shown here and never used.** It
says who is sitting at a machine, not whose machine it is.

Filter by text (name, Remote ID, address, domain, serial, key), by how it
arrived, by platform, or by whether it has a suggestion or its rules disagree.

### What an unassigned computer can and cannot do

Its heartbeat records it as online and receives the automatic inventory and
update scan — so you can see what it is — and **nothing else**: no password
rotation, no RustDesk or agent update, no reinstall, no migration, monitoring,
diagnostic, action, patch scan, chat or tray pairing, whatever is queued.

Every remote and action route refuses it with `ENDPOINT_UNASSIGNED`, for a
Platform Admin too: a remote session, Connect and the Connect script, the
launcher (by computer and by Remote ID), Quick Connect to its Remote ID, the
password, rotation and reinstall, agent update and migration, actions, scripts,
diagnostics, service and process control, software install and removal, patch
installs, RustDesk update staging, and the tray's pairing, self-help tools and
support requests. Chat refuses it as *not assigned to a business*.

Only a Platform Admin can see it — not a Business Owner of any business, a
Business User, a technician or an API key, in the device list, a device page,
search, the audit log or the API.

### Assigning

Tick computers, choose a business, optionally a site and up to ten static
groups, and **Assign**; or press **Accept** on a row's suggestion. You are asked
to confirm it is you (**Adopting unassigned computers** in *Settings → Confirm it is you*).

Each computer moves only if it is still unassigned at that moment — two people
assigning the same computer, or a computer assigned elsewhere meanwhile, gives
*not changed* for it rather than a second move. Each one is recorded in the
audit log as `ENDPOINT_ADOPTED`, with who approved it, before and after
(business, site, status), the deployment key it came with, the rule that
suggested it (if you accepted one), the groups and your step-up method.

The device's own edit form can no longer move an unassigned computer into a
business (`USE_ADOPTION`); it goes through here, so every adoption is audited
the same way.

### Forgetting

**Forget** deletes an unassigned computer's record — for a test machine, a
duplicate, or something that should not have enrolled. It asks you to confirm
it is you and is audited (`ENDPOINT_FORGOTTEN`). A computer whose agent keeps
running checks in again as a new unassigned entry: uninstall the agent, or
revoke the key it used, first.

---

## Assignment rules

A rule names a business (and optionally a site) for unassigned computers that
match **one** explicit fact:

| Kind | Matches | Example |
|---|---|---|
| Deployment key | Computers that enrolled with that key | *Acme GPO rollout* |
| AD / DNS domain | The domain the computer's inventory reports, exactly, ignoring case | `acme.local`, `ACME` |
| Address range | The address the server saw the computer connect from | `203.0.113.0/24` |
| Hostname prefix | The start of its hostname, ignoring case | `ACME-` |

There is deliberately **no** rule on who is signed in, a user name or an e-mail
address, and the code that evaluates rules cannot read them. `WORKGROUP`,
`local` and `localdomain` are refused as domains (every computer outside a
domain reports one of them), an address range must be at least /8 (IPv4) or
/32 (IPv6), and a hostname prefix at least two characters.

**A rule is a suggestion, never an assignment.** The list shows the suggested
business and site and the rule that made it; a Platform Admin accepts it. No
rule, and nothing else, assigns a computer by itself. The only automatic
placement in the system is a deployment key created in *straight into this
business* mode, and that business is the key's own.

When several rules match, the order is: a rule on the deployment key; then the
key's own business (a review key suggests its business even with no rule);
then domain, hostname prefix and address. Within a kind, the lower priority
number wins, then the narrower range or longer prefix. When the matching rules
name **different businesses**, the row says *Rules disagree*, lists them, and
has no Accept button: assign it by hand.

Adding a rule asks you to confirm it is you (**Assignment rules**), and
is audited (`ADOPTION_MAPPING_CREATED`); removing one does not ask, and is
audited (`ADOPTION_MAPPING_DELETED`).

---

## What is recorded

| Audit action | When | Business it is filed under |
|---|---|---|
| `DEPLOYMENT_KEY_CREATED` | A key is made (never the key itself) | Platform |
| `DEPLOYMENT_KEY_REVOKED` | A key is revoked | Platform |
| `DEPLOYMENT_KEY_USED` | A computer enrols with a key | Platform for a review key; the business for a straight-in key |
| `ENDPOINT_ADOPTED` | A computer is assigned | The business it joined |
| `ENDPOINT_FORGOTTEN` | An unassigned computer is forgotten | Platform |
| `ADOPTION_MAPPING_CREATED` / `_DELETED` | A rule is added or removed | Platform |

"Platform" entries are visible only to Platform Admins; nothing about a computer
in the pool is visible to any business until it is adopted into one.

---

## What has and has not been tested

The server side — keys, the pool, rules, adoption, and every refusal above — is
proved by `apps/api/scripts/e2e-adoption.mjs` and `unit-adoption.mjs`, which
post exactly what the installers post. **None of the deployment methods above
has been run end to end on a real Group Policy, Intune tenant, RMM or Mac from
this release**; they run the existing installers, unchanged, with the key in
the place a single-use code goes.

See also: [clients.md](clients.md) (the installers), [access-control.md](access-control.md),
[sign-in.md](sign-in.md) (which functions ask you to confirm it is you).
