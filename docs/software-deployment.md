# Software deployment

From 0.34 rem0te can install and uninstall software on Windows computers, from a **software catalog** of
allowlisted [winget](https://learn.microsoft.com/windows/package-manager/) packages. Each catalog entry pins one
package id, one exact version and one installer SHA-256. Installing or uninstalling it is a signed
[approved action](approved-actions.md) that two people approve with a passkey on the approval signer, or, in
[direct mode](approved-actions.md) (0.40), that the signer signs as soon as it is asked. Each computer downloads
the installer itself with winget, hashes it, and installs only if the hash is the pinned one.

From 0.41 you don't have to build the catalog by hand: [search the winget catalog](#searching-the-winget-catalog-041)
and click **Install**, and [uninstall anything](#uninstalling-any-installed-program-041) the computer lists in
Programs and Features.

Nothing is uploaded to the portal. It never holds an installer, so it can't hand a computer one.

> **Not run on real Windows.** Everything on this page is fixture-tested. The agent's real decision code runs
> against a stub winget, a simulated uninstall registry and simulated file versions. winget itself, App Installer
> under the SYSTEM account, the Windows registry and file-version calls, and (0.41) msiexec and the uninstallers
> programs register have **not** run on a Windows computer under test. Treat it as unproven on Windows until the paired lab in
> [Approved actions](approved-actions.md#what-has-been-proven-and-what-hasnt) is done.

## What is in the catalog

**Automation → Software catalog** lists the entries you can use:

- **global** entries, which a Platform Admin maintains for every business;
- entries of **your business**, which its Business Owner maintains. Another business's entries are never shown;
  asking for one by id answers 404.

Each entry has:

| Field | What it is | Checked |
|---|---|---|
| Package id | The winget id, e.g. `7zip.7zip`, `Notepad++.Notepad++` | Dot-separated segments of letters, digits, `+`, `_` and `-`, at most 128 characters. It can't start with `-`, so winget can never read it as an option. No spaces, quotes, slashes or shell characters |
| Version | One exact version, e.g. `24.08` | Letters, digits, `.`, `+`, `_` and `-`, not starting with `-` |
| Installer SHA-256 | The hash of the one installer a computer may run | 64 lower-case hex characters |
| Where the hash came from | **winget-pkgs**, read from the package's manifest; or **pasted** by whoever added the entry | The approval page shows which |
| Scope | Always **machine**: installed for every user of the computer | Per-user installs are not offered |
| Detection rule | How a computer tells whether the package is there, and at what version | One of three closed forms (below) |

### Pinning the hash from winget-pkgs

**Read the manifest** fetches the package's installer manifest from the public
[winget-pkgs](https://github.com/microsoft/winget-pkgs) repository at
`raw.githubusercontent.com/microsoft/winget-pkgs/master/manifests/<letter>/<Publisher>/<Package>/<version>/<id>.installer.yaml`.
It is one GET, sent with no credentials or cookies. It follows no redirects, times out after 10 seconds, reads at
most 256 KB, and builds the URL only from a package id and version that passed the charset check. The page lists
the manifest's installers by architecture, scope and type. **Pin this installer** records:

- the installer's SHA-256;
- the manifest's URL and its own SHA-256, so the entry says exactly which manifest the hash came from;
- the installer URL and architecture, for reference.

When a manifest has more than one machine-scope installer for the architecture with different hashes, the server
refuses with `AMBIGUOUS_INSTALLER` and lists them; choose one by its hash. A package with only per-user installers is
`NO_MACHINE_INSTALLER`. A manifest that names a different package or version is `MANIFEST_MISMATCH`, and is never
used.

**Pasting a hash** is for a package whose manifest you checked yourself, or one winget-pkgs can't be reached for. The
entry, the audit log and the approval page all say *typed in by the catalog's editor*.

The manifest read is a record of what winget-pkgs said. It is not what makes an install safe. The computer's own
check, below, does that.

### Detection rules

A detection rule is data, not a script. There are exactly three forms:

| Kind | Fields | What the computer reads |
|---|---|---|
| **Display name** | name, match `exact` or `prefix` (case-insensitive), compare `gte` or `eq`, version | The Programs and Features entries in both registry views. When several match, the highest `DisplayVersion` decides |
| **Uninstall key** | key (one subkey name, no backslash), compare, version | Whether `HKLM\…\Uninstall\<key>` exists in either view, and its `DisplayVersion` |
| **File version** | base `ProgramFiles` or `ProgramFilesX86`, a file under it (plain segments, ending `.exe` or `.dll`, no `..`, no drive), compare, version | The file's version resource. Nothing is run |

A rule gives one of three states. **Installed** means found, and the version meets the rule. **Outdated** means found,
at a version the rule doesn't accept. **Absent** means not found. Versions are compared segment by segment, split on
`.`, `-`, `+` and `_`. Numbers compare as numbers, anything else as case-insensitive text, and a missing segment is
`0`. The portal and the agent compare the same way, and `unit-software.mjs` and the Go tests share the cases.

### Who can change the catalog

| Change | Who | Also needs |
|---|---|---|
| A business's entries: add, change, archive | That business's **Business Owner**, signed in as themselves (not through a technician assignment), or a **Platform Admin** | A **fresh sign-in** (step-up) |
| Global entries | A **Platform Admin** | A fresh sign-in |
| Read the catalog | Anyone with **View computers** in the business | — |

Technicians, including L3, read the catalog and deploy from it, but never change it. Which software a business runs
is the business's own decision.

Each change is audited:

- **`SOFTWARE_CATALOG_CREATED`** records the pinned hash, where it came from, and the manifest digest.
- **`SOFTWARE_CATALOG_UPDATED`** records the version, hash, source and rule before and after.
- **`SOFTWARE_CATALOG_ARCHIVED`** records the reason.

A change names the revision it was made against, and a stale one is refused with `ENTRY_CHANGED`. The package id,
scope and business of an entry never change. To change them, archive the entry and add a new one.

## Installing or uninstalling

### On one computer

On the computer's **Software** tab, **Managed software** lists the catalog entries with what the computer is known to
have (see [Compliance](#version-compliance)), the last plan, and **Install** / **Uninstall**. Either one makes a
one-computer deployment and requests it at once.

- The dialog shows the action's warnings, the reason you give, and an approval window of 1 to 24 hours (8 by default).
- The plan is **high impact**, so **two different approvers** must approve it on the signer, whatever the computer.
  In direct mode it is signed when you ask (after a fresh sign-in) and the dialog says so instead.
- The **Approve** link opens the signer's page. There is no approve button in the portal.

When a button is missing, the tab says why:

| Shown | Why |
|---|---|
| *not available on macOS / Linux* | Those agents only report |
| *does not report support for this action* | The agent is older than 0.34. Update it |
| *legacy agent* | The computer is on the standard channel. See [Patching setup](patching-setup.md) |
| *managed by Configuration Manager* | Its patch posture shows ConfigMgr, which also manages applications |
| *managed by intune* (after a plan was refused) | The agent found the Intune Management Extension service and refused with `managed_elsewhere` |
| *offline* | A plan is delivered only while the computer checks in |
| *the approval signer is not set up* | Nothing can be approved on this server |
| *higher-risk requests* | Your access doesn't include high-risk actions. An L2 technician is refused; L3, a Business Owner or a Business User with **Request actions** can ask |
| *already awaiting approval / an uncertain outcome* | One software plan at a time per computer. Reconcile an uncertain one first |
| warning: *winget not available last time* | The last software plan here answered `winget_unavailable`. It can be requested again, but will not run until App Installer is provisioned |

### On many computers: a canary, then rings

From a catalog entry, **Deploy to computers** makes a deployment. It works like [staged patching](staged-patching.md):

- **Ring 0 is the canary, exactly one computer.** Up to four more rings follow, each of at most 25 computers, all in
  one business.
- Making the deployment requests nothing. Each ring is requested separately, becomes **one signed plan** naming its
  computers, and is approved on the signer by two approvers.
- Every computer is checked as if requested alone (scope, business, access, readiness, not managed elsewhere). A
  ring including one that can't take it is refused, naming the computer.
- **The canary is judged by its own detection rule.** "winget said it worked" isn't enough: the agent must find the
  package afterwards (`effective`). A canary that already had it proves nothing (`canary_proved_nothing`), so choose
  another.
- More failed computers in a ring than the **failure threshold** (0 by default) **pause** the deployment. A person
  resumes it, and the failed ring is retried; it is never promoted past.
- After a ring passes it **soaks** (24 hours by default, 0 to 168) before the next may be requested.
- An unreconciled uncertain computer holds the gate.
- **The catalog entry is frozen into the deployment.** If the entry is changed or archived afterwards, no further ring
  can be requested (`ENTRY_CHANGED`, `ENTRY_ARCHIVED`). Make a new deployment from the current entry.

There is no way to install from the computer's Actions tab or by `POST /endpoints/:id/actions`. That route answers
`ACTION_NOT_DIRECT`.

### Archiving an entry revokes it

From 0.36, **Archive** first revokes the entry on the approval signer, for good (by entry id, write-once; nothing
un-revokes it). The signer then refuses any install from it that isn't signed yet (`software_revoked`), and its signed
revocation statement names the entry, so a 0.36 signed agent refuses an install from it that was signed **before** the
archive and is still inside its window (`revoked`, final, before anything runs). An install not yet delivered is
canceled by the portal with the reason *revoked*. **Uninstalls are not refused**: removing a withdrawn package is
usually why it was archived.

If a signer is configured and doesn't confirm the revocation, nothing is archived (`APPROVAL_SIGNER_REFUSED`): archiving
in the portal alone would leave delivered plans runnable. Every software plan now names its entry
(`display.software.entryId`); the signer refuses one that doesn't (`software_entry_missing`), and so does the agent.

The statement, its freshness rule (a plan runs only with a statement at least as new as its signature; otherwise it
waits, `revocations_stale`) and why it fails closed are in
[Script library → Revocation](script-library.md#revocation). It takes effect only on computers running a 0.36 signed
agent build published with the owner's keys.

**Entries archived before 0.36 were never revoked on the signer.** Revoke them there once after upgrading:

```bash
$S software list                                     # revoked entries on the signer
$S software revoke --entry <entry id> --reason "why"  # one-way
```

(`$S` as in [Script library → Revocation](script-library.md#revocation).)

## Searching the winget catalog (0.41)

The server keeps a read-only copy of the winget community source's own package index, the file winget itself
downloads: `https://cdn.winget.microsoft.com/cache/source2.msix`, an MSIX (a zip) of about 4 MB whose
`Public/index.db` is a SQLite database with one row per package and its latest version.

- It is read **at most once a day** (a failed read is retried after an hour), by one bounded GET of that fixed URL:
  no credentials or cookies, **no redirects followed**, 60 seconds, at most 32 MB downloaded and 128 MB unpacked,
  the database's CRC checked. The database is written to a private temporary directory, read with the `sqlite3`
  tool (read-only, two fixed queries, an argument array) and deleted. The server needs `sqlite3` installed
  (`apt install sqlite3`); without it the read fails and says so.
- The rows replace the stored copy in one transaction, so a failed read leaves the previous copy searchable, with
  the reason on the catalog page. Package ids that could not be a plan's `packageId` are skipped and counted; a
  version the agent would refuse is listed but **not installable from here**.
- Nothing in the index is installed or trusted. It is only what you search.
- A Platform Admin can read it now with **Read the index now** on Automation → Software catalog (refused within an
  hour of the last read, `INDEX_FRESH`, and audited). `WINGET_INDEX_SWEEP=off` stops the daily read in that
  process; the test suites set it, so a test stack never fetches the public index.

Search is on the computer's Software tab (**Managed software**) and on Automation → Software catalog. It needs
View computers, and takes letters, digits, spaces and `. + _ -`.

### One click: Install

**Install** on a search result does, in one request:

1. **Reads the version's installer manifest** from winget-pkgs, as [Pinning](#pinning-the-hash-from-winget-pkgs) does.
2. **Chooses the installer winget would choose** for `--scope machine` on this computer's architecture (from its
   inventory; x64 when unknown): the best architecture that has one (x64, then neutral, then x86; arm64 computers
   also take x64), an explicit machine scope over an unstated one, en-US over another locale, and then **the first in
   the manifest**, which is what winget picks when two are equally good. Per-user, portable and Store installers are
   never chosen (`NO_MACHINE_INSTALLER`). If winget on the computer picks a different one anyway, its hash is not the
   pinned one and the agent refuses before installing (`hash_mismatch`).
3. **Derives the detection rule** from what the manifest says the installer registers: its `ProductCode` (from
   `AppsAndFeaturesEntries`, the installer, or the manifest root) as an uninstall-key rule at the entry's
   `DisplayVersion` or the package version; for an MSI product code with no `DisplayVersion`, presence alone (an MSI's
   product code changes with its version). With no product code, an exact display-name rule. With neither, it is
   refused (`NO_DETECTION`): add it by hand with a rule you write.
4. **Uses or makes the catalog entry.** An entry already pinned to exactly that version and installer (global or the
   business's own) is used as it is. Otherwise the business's own entry is created, or moved to that version, with
   the hash source **winget-pkgs**. That is a catalog change: only the business's Business Owner or a Platform Admin,
   with a fresh sign-in, audited as `SOFTWARE_CATALOG_CREATED` / `_UPDATED` with `via: one_click`. A technician can
   one-click a package the catalog already has, not add one. The business's entry for the **same version** is never
   repinned to another installer (another architecture, or over a pasted hash): `ENTRY_PINS_ANOTHER_INSTALLER`.
5. **Requests the install** exactly as **Install** on the entry does: a one-computer deployment, high risk, approved
   on the signer (or signed at once in direct mode, after a fresh sign-in).

The agent's side is unchanged: it downloads with winget, hashes the installer itself and refuses a mismatch.

**Add to catalog** on Automation → Software catalog does steps 1 to 4 for the x64 installer, without installing.

## Uninstalling any installed program (0.41)

The **Installed software** list on a computer's Software tab (what Programs and Features shows) has **Uninstall** on
each program that can be removed without someone at the computer:

- A program a **catalog entry describes** (its detection rule names the program's display name or uninstall key) is
  uninstalled through that entry: `windows.software.uninstall@1`, winget.
- Anything else is removed with **`windows.software.remove@1`**. The plan names three things and never a command: the
  uninstall key's name, its registry view (`64` or `32`) and the DisplayName the inventory showed. On the computer
  the agent reads that key itself, after the signed pause and before it journals *executing*, and decides:

| What the key says | What runs |
|---|---|
| It is gone | Nothing: `no_change` |
| Its DisplayName is not the one in the plan | Nothing: refused, `program_changed` (the key now names another program) |
| A Windows Installer product (`{GUID}` key, `WindowsInstaller = 1`) | `System32\msiexec.exe /x {GUID} /qn /norestart` |
| A `QuietUninstallString` | That program with the arguments the installer registered, as one process with no shell. It must be an absolute path to an `.exe`, with no environment variables or shell characters, and not an interpreter or system tool (`cmd`, PowerShell, `mshta`, `rundll32`, `msiexec` other than `/x` of this key's own product…): otherwise refused, `uninstall_command_refused` |
| Only an interactive `UninstallString` | Nothing: refused, `no_silent_uninstall`. It would wait for someone to click |

  The result is **succeeded only if the key is gone afterwards** (an NSIS uninstaller returns at once, so the agent
  waits up to two minutes for the key to go). msiexec's 3010 / 1641 is `restart_required`; the computer is not
  restarted. A key that stays is `not_effective`, a non-zero exit with the key still there `uninstall_failed`, and an
  uninstaller still running after 30 minutes is stopped and reported `uncertain` (`timeout`).
- It is **high impact**, one computer per plan, never from the Actions tab (`ACTION_NOT_DIRECT`) and never offered to
  ClientSt0r. Two approvers, or direct mode, as for any software plan. Computers whose applications ConfigMgr or Intune
  manage refuse it (`managed_elsewhere`).
- What the program's own uninstaller does is the program's. rem0te did not write it and cannot vouch for it; the
  dialog says so. It may remove settings and data for every user.

The inventory reports each program's key, view, and whether it registers a silent uninstall or is an MSI from agents
built from 0.41. Until a computer sends its next full inventory (about every six hours), programs show *cannot
uninstall from here* with the reason. The console only offers; the computer reads the key again and decides.

## What the computer does

The plan carries exactly five parameters: `packageId`, `version`, `installerSha256`, `scope` (`machine`) and
`detection`. The agent ([`internal/action/software.go`](../tools/windows-installer/internal/action/software.go))
verifies the signed plan as for every action: signature, approvals, targets, window, signed pause and journal. It then
checks every parameter against the same charsets again, before using any of them:

1. **Is something else managing applications?** The ConfigMgr client (`CcmExec`) or the Intune Management Extension
   means **refused, `managed_elsewhere`**. winget is not asked anything.
2. **Find winget for SYSTEM.** App Installer is an MSIX package, so SYSTEM has no `winget` on its PATH. The agent
   looks for the provisioned `Microsoft.DesktopAppInstaller_*_8wekyb3d8bbwe` folder under
   `%ProgramFiles%\WindowsApps`, takes the newest, refuses a reparse point, and runs that `winget.exe` by its absolute
   path. If it isn't there, the answer is **not executed, `winget_unavailable`**: the agent installs nothing to get
   it. winget older than 1.7 (no `winget download`) is `winget_too_old`.
3. **Detect before.** If the package is already installed at an accepted version, the outcome is **`no_change`** and
   nothing else runs. For an uninstall, the same happens when it is absent.
4. **Download** into `…\actions\software\<job>` under the agent's SYSTEM-only state directory:
   `winget download --id <id> --version <v> --exact --source winget --scope machine --skip-dependencies --download-directory <dir> --accept-package-agreements --accept-source-agreements --disable-interactivity`.
5. **Verify.** The directory must hold exactly one installer (plus winget's manifest YAML), regular files only. The
   agent computes the installer's SHA-256 itself:
   - if it isn't the pinned hash, the outcome is **refused, `hash_mismatch`**, with the hash it found;
   - if the downloaded manifest doesn't list the pinned hash, the outcome is **refused, `manifest_hash_mismatch`**.

   Nothing has been installed at this point.
6. **Install:**
   `winget install --id <id> --version <v> --exact --source winget --silent --scope machine --skip-dependencies --accept-package-agreements --accept-source-agreements --disable-interactivity`.
7. **Detect after.** Installed means **`succeeded`**, `effective: true`. Not installed means **failed, `not_effective`**.
   If winget asked for a restart (`0x8A150109` / `0x8A15010A`), the outcome is **`restart_required`** instead. A
   later inventory that finds it then confirms it for the ring gate. The plan never restarts the computer.

Uninstall runs `winget uninstall --id <id> --exact --source winget --silent --scope machine --accept-source-agreements --disable-interactivity`
and then detection. It succeeds only when the rule no longer finds the package. It has no `--version`: it removes
whatever version winget finds installed, and the warning says so.

**How winget is run.** Each argument list is a fixed array built from checked values. One package
([`internal/winget`](../tools/windows-installer/internal/winget/winget.go)) starts the process,
`exec.CommandContext(ctx, path, args...)`, and that is the only exec site in the software path. No `cmd.exe`, no
PowerShell, no joined command line. The agent never passes `--override`, `--custom`, `--location`, `--force`,
`--manifest`, `--header` or `--ignore-security-hash`, and `check-security-invariants.mjs` §40 fails the build if one
appears.

**Timeouts.** `--version` 30 s, download 20 min, install 30 min, uninstall 20 min.

- An install or uninstall that times out is killed and reported **uncertain, `timeout`**, with what detection sees
  then. The installer may have changed the computer, so a person checks it and **reconciles** before anything more is
  requested there.
- A download that times out is **failed, `download_failed`**: nothing was installed.

The journal records each step (`downloading`, `verifying`, `installing`, `detecting`), and a re-delivered plan is
answered from the journal. A [containment](containment.md) pause holds an approved plan at the portal. The agent
refuses with `paused` under a signed pause, before winget is asked anything.

### Who verifies what

| What | Checked by | How |
|---|---|---|
| The hash an entry pins | The **catalog editor**, and the **approvers**, who see it with its source and the manifest digest | Read from the winget-pkgs manifest, or pasted |
| That the plan is exactly that package, version and hash | The **signer** (admission, closed params) and the **agent** (signature, same charsets) | Ed25519 signature over the canonical plan |
| That the downloaded installer is the pinned one | The **agent** | SHA-256 of the file `winget download` wrote |
| That the source's manifest still declares it | The **agent** | The pinned hash must be among the downloaded manifest's `InstallerSha256` values |
| That the bytes `winget install` runs match the source manifest | **winget** | Its own hash check, which the agent never overrides |
| That the package is installed afterwards | The **agent** | The detection rule |

**The residual gap.** `winget install` downloads the installer again from the source. The agent hashed the copy that
`winget download` fetched moments earlier; winget checks the copy it installs against the source's manifest. Between
those two steps, an edit to the source manifest pointing at different bytes, with a matching hash, would be installed
by winget, and the agent would not have hashed those bytes. Installing the agent's own verified copy
(`winget install --manifest`) would close the window. It needs winget's `LocalManifestFiles` admin setting turned on
machine-wide, which lets anyone with admin rights install from any local manifest, so it wasn't used. The window is
seconds long and needs a change to the winget community repository. The detection rule still has to confirm the
result. **This gap is accepted as documented (0.36.1 decision)**, and `LocalManifestFiles` stays off: turning it on
would trade a seconds-long window that needs a repository compromise for a standing, machine-wide way for any local
administrator to install from an arbitrary manifest.

**Dependencies are not installed** (`--skip-dependencies`). A package that needs another one needs that one as its
own catalog entry, installed first.

**Agreements.** The plan passes `--accept-package-agreements --accept-source-agreements`: the approvers accept them on
the business's behalf, and the acknowledgement says so.

## Version compliance

**Reports → Software compliance** shows each catalog entry against the Windows computers it applies to: a business's
entries against that business's computers, global entries against every computer. It counts each computer as
**compliant**, **outdated**, **missing** or **unknown**, from the newest of:

- the inventory's installed-software list (0.29), only for a **display name** rule (the inventory doesn't carry
  uninstall key names or file versions);
- the detection the computer reported when a software plan ran there (before, after, or at a timeout), for any rule.
  Only a plan for the same package under the same rule counts.

No evidence, or none newer than **14 days**, is **unknown**. Nothing is guessed: an uninstall-key rule on a computer
that never ran a plan is unknown, even if the inventory lists the program. The report also gives the computers that
need attention, a non-Windows count, and an audited CSV export ([Reports](reports.md#software-compliance)).

The computer's Software tab shows the same state per entry, with its evidence and age.

## Refusals and results

| Code | Where | Meaning |
|---|---|---|
| `STEP_UP_REQUIRED` | Catalog change | Sign in again first |
| `ENTRY_EXISTS` | Catalog | That package is already a live entry in this catalog |
| `ENTRY_CHANGED` | Catalog change, ring request | The entry changed since you (or the deployment) read it |
| `ENTRY_ARCHIVED` | Deployment, ring request | The entry is archived |
| `MANIFEST_NOT_FOUND`, `MANIFEST_UNREACHABLE`, `MANIFEST_TOO_LARGE`, `MANIFEST_UNREADABLE`, `MANIFEST_MISMATCH` | Reading the manifest | As named. Paste the hash instead, or check the id and version |
| `NO_MACHINE_INSTALLER`, `AMBIGUOUS_INSTALLER`, `HASH_NOT_IN_MANIFEST` | Pinning from the manifest | See [Pinning](#pinning-the-hash-from-winget-pkgs) |
| `SOFTWARE_NOT_POSSIBLE` | Install, uninstall, deployment | The computer can't take a software plan now; the message says why and what to do |
| `BAD_RINGS`, `BAD_TARGETS` | Deployment | The canary isn't one computer, a computer is in two rings, or the computers are in different businesses |
| `RING_GATE` | Ring request | Not this ring now: the previous one hasn't passed, is soaking, or the deployment is paused |
| `ACTION_NOT_DIRECT` | `POST /endpoints/:id/actions` | Software is deployed from the catalog only |
| `APPROVAL_SIGNER_REFUSED` | Archive | The approval signer didn't revoke the entry, so it wasn't archived (0.36) |
| `INDEX_NOT_READ`, `INDEX_FRESH`, `INDEX_REFRESHING` | Reading the winget index (0.41) | The read failed (the reason is shown; the previous copy stays), was done less than an hour ago, or is running |
| `PACKAGE_NOT_IN_INDEX`, `VERSION_NOT_INSTALLABLE` | One-click install (0.41) | The id is not in the index (name a version to use it anyway), or its latest version has characters the agent refuses |
| `NO_DETECTION` | One-click install (0.41) | The manifest doesn't say what the installer registers; add the entry by hand |
| `ENTRY_PINS_ANOTHER_INSTALLER` | One-click install (0.41) | The business's entry for that version pins another installer (architecture or pasted hash) |
| `NOT_ALLOWED` | One-click install (0.41) | The package isn't in the catalog, and adding it is the Business Owner's or a Platform Admin's |
| `PROGRAM_NOT_IN_INVENTORY`, `NO_SILENT_UNINSTALL` | Uninstall a program (0.41) | The last inventory doesn't list that key, or it registers only an interactive uninstaller |

Agent outcomes:

| Outcome | Reason | Meaning |
|---|---|---|
| refused | `managed_elsewhere` | ConfigMgr or Intune manages applications here |
| refused | `revoked` | The entry was archived after the install was signed (0.36). Nothing installed |
| refused | `software_entry_missing` | The plan names no catalog entry (0.36) |
| waiting | `revocations_stale` | No revocation statement as new as the plan yet (0.36); retried on the next delivery, not reported |
| refused | `hash_mismatch`, `manifest_hash_mismatch` | The installer is not the pinned one. Nothing installed |
| not executed | `winget_unavailable`, `winget_too_old`, `detection_failed` | Nothing ran |
| no change | — | Already installed (install) or already absent (uninstall). Only `winget --version` ran |
| failed | `download_failed`, `installer_not_found`, `install_failed`, `uninstall_failed` | winget's exit code is in `exitCode` |
| failed | `not_effective` | winget reported success, the detection rule disagrees |
| restart required | — | winget asked for a restart and the rule doesn't confirm the change yet |
| uncertain | `timeout` | Killed at the timeout. Check and reconcile |
| succeeded | — | Installed (or removed) and confirmed by the rule |

`windows.software.remove@1` (0.41) outcomes: `no_change` (the key was not there), refused `program_changed`,
`no_silent_uninstall`, `uninstall_command_refused` or `managed_elsewhere`, not executed `registry_unreadable`,
failed `uninstall_failed` or `not_effective`, `restart_required`, uncertain `timeout`, and succeeded (the key is
gone). Its observed fields: `key`, `view`, `presentBefore`, `versionBefore`, `method` (`msi` or `quiet`),
`program` (the uninstaller's file name), `exitCode`, `presentAfter`, `effective`, `rebootRequired`, `displayNameNow`.

Observed fields (strings): `wingetVersion`, `detectedBefore`, `versionBefore`, `detectedAfter`, `versionAfter`,
`detectedNow`, `versionNow`, `installerSha256`, `exitCode`, `effective`, `rebootRequired`, `managers`, `packageId`.

## Not done

- **Running on real Windows.** See the note at the top.
- **Upload of your own installers.** There is deliberately no upload route. Only packages in the winget community
  source can be deployed.
- **The winget `msstore` source**, per-user installs, install switches or locations: not offered.
- **Dependencies.** See above.
- **Automatic remediation** (installing on whatever the compliance report shows missing): every install is a person's
  request through rings and approvals.
- **Updating an entry in place on the computers.** A new version is a changed entry and a new deployment.
- **ClientSt0r** is not offered the software actions. Offering them is a change to the ticket-rmm contract.
- **Other sources** (Chocolatey, the `msstore` source, a private winget source): the search is the community source only.
- **Removing per-user programs** (HKCU uninstall keys) and programs without a silent uninstall: not offered.
- **A mixed-architecture business from one entry**: an entry pins one installer. One-click refuses to repin it for a
  computer of another architecture rather than change what the others are told to install.

## API

All under `/api/v1`, all with a session:

| Route | Capability |
|---|---|
| `GET software/catalog`, `GET software/catalog/:id` | View computers |
| `POST software/catalog`, `POST software/catalog/:id`, `POST software/catalog/:id/archive`, `POST software/manifest-preview` | Edit computers, and then Business Owner / Platform Admin and a fresh sign-in |
| `GET software/deployments`, `GET software/deployments/:id`, `POST software/deployments` | View computers, then the high-risk action check per computer |
| `POST software/deployments/:id/rings/:ring/request`, `…/pause`, `…/resume`, `…/cancel` | View computers, then as above; pausing, resuming and canceling need the deployment's creator, the Business Owner or a Platform Admin |
| `GET endpoints/:id/software/catalog`, `POST endpoints/:id/software/:entryId/install\|uninstall` | View computers, then as above |
| `GET software/winget/packages?q=` (0.41) | View computers |
| `POST software/winget/refresh` (0.41) | Edit computers, then Platform Admin |
| `POST software/winget/catalog` (0.41) | Edit computers, then Business Owner / Platform Admin and a fresh sign-in |
| `POST endpoints/:id/software/winget-install` (0.41) | View computers, then the high-risk action check; a catalog write needs Business Owner / Platform Admin and a fresh sign-in |
| `POST endpoints/:id/software/remove-program` (0.41) | View computers, then the high-risk action check |
| `GET reports/software-compliance`, `…/export.csv` | View computers |

See the [API reference](API-REFERENCE.md).
