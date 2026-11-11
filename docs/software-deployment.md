# Software deployment

From 0.34 rem0te can install and uninstall software on Windows computers, from a **software catalog** of
allowlisted [winget](https://learn.microsoft.com/windows/package-manager/) packages. Each catalog entry pins one
package id, one exact version and one installer SHA-256. Installing or uninstalling it is a signed
[approved action](approved-actions.md) that two people approve with a passkey on the approval signer. Each
computer downloads the installer itself with winget, hashes it, and installs only if the hash is the pinned one.

Nothing is uploaded to the portal. It never holds an installer, so it can't hand a computer one.

> **Not run on real Windows.** Everything on this page is fixture-tested. The agent's real decision code runs
> against a stub winget, a simulated uninstall registry and simulated file versions. winget itself, App Installer
> under the SYSTEM account, and the Windows registry and file-version calls have **not** run on a Windows computer
> under test. Treat it as unproven on Windows until the paired lab in
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
`--manifest`, `--header` or `--ignore-security-hash`, and `check-security-invariants.mjs` §33 fails the build if one
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
result.

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

Agent outcomes:

| Outcome | Reason | Meaning |
|---|---|---|
| refused | `managed_elsewhere` | ConfigMgr or Intune manages applications here |
| refused | `hash_mismatch`, `manifest_hash_mismatch` | The installer is not the pinned one. Nothing installed |
| not executed | `winget_unavailable`, `winget_too_old`, `detection_failed` | Nothing ran |
| no change | — | Already installed (install) or already absent (uninstall). Only `winget --version` ran |
| failed | `download_failed`, `installer_not_found`, `install_failed`, `uninstall_failed` | winget's exit code is in `exitCode` |
| failed | `not_effective` | winget reported success, the detection rule disagrees |
| restart required | — | winget asked for a restart and the rule doesn't confirm the change yet |
| uncertain | `timeout` | Killed at the timeout. Check and reconcile |
| succeeded | — | Installed (or removed) and confirmed by the rule |

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

## API

All under `/api/v1`, all with a session:

| Route | Capability |
|---|---|
| `GET software/catalog`, `GET software/catalog/:id` | View computers |
| `POST software/catalog`, `POST software/catalog/:id`, `POST software/catalog/:id/archive`, `POST software/manifest-preview` | Edit computers, and then Business Owner / Platform Admin and a fresh sign-in |
| `GET software/deployments`, `GET software/deployments/:id`, `POST software/deployments` | View computers, then the high-risk action check per computer |
| `POST software/deployments/:id/rings/:ring/request`, `…/pause`, `…/resume`, `…/cancel` | View computers, then as above; pausing, resuming and canceling need the deployment's creator, the Business Owner or a Platform Admin |
| `GET endpoints/:id/software/catalog`, `POST endpoints/:id/software/:entryId/install\|uninstall` | View computers, then as above |
| `GET reports/software-compliance`, `…/export.csv` | View computers |

See the [API reference](API-REFERENCE.md).
