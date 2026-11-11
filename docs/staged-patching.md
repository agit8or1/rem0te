# Staged patching

rem0te 0.27 can install **Windows updates** on customer computers in stages. 0.32 adds
[installing from one computer's Patches tab](#installing-from-one-computers-patches-tab) and
[patch policies](#patch-policies), which are approved once and then run inside a maintenance window. For production
setup, see [Patching setup](patching-setup.md). A **canary** computer goes first, then
one or more **rings**. Each ring is a single signed plan that two people on the approval roster authorize with a
passkey. The next ring can't be requested until the canary reports that the updates took effect.

The plan is approved, delivered and executed exactly like the [approved Print Spooler action](approved-actions.md):
the same approval signer, roster, signature and agent checks. This page covers only what is different for updates.

> **Warning.** An installed update may not stay installable *out*. Some can't be uninstalled, and uninstalling is not
> built here. rem0te never restarts a computer, so an update that needs a restart is reported as **restart required**
> until someone restarts it.

## What can be installed

| Installed by a plan | Never installed by a plan |
|---|---|
| Security Updates, Critical Updates, Update Rollups, Updates | Drivers, Upgrades (feature updates), Feature Packs, Service Packs, Tools, Definition Updates |
| Only updates Windows Update **itself offers** that computer at install time | Optional / preview updates (`BrowseOnly`) |
| | Anything that needs a licence accepted, or someone at the keyboard |
| | Third-party software, scripts, files, URLs. A plan names updates only by Windows Update ID and revision |
| | Computers whose updates are managed by **WSUS**, **Windows Update for Business policy**, **MDM (Intune)** or **Configuration Manager** |

These rules are enforced twice: by the portal, when you build a deployment, and again by **the computer**, which
asks Windows Update for each named update and decides from that answer. The KBs and titles in a plan are what the
approvers *see*, and they are signed, but the agent never consults them. A misleading title can mislabel an update. It
can't widen what gets installed.

At most 20 updates per plan; ring 0 is exactly one computer; later rings have up to 25 computers; at most five rings.

## How a deployment runs

```
create ──▶ request canary ──▶ 2 approvals ──▶ canary installs ──▶ (restart, scan) ──▶ effective?
                                                                                      │ yes
               ┌──────────────────────────────────────────────────────────────────────┘
               ▼
        request ring 1 ──▶ 2 approvals ──▶ ring installs ──▶ within threshold? reconciled? soaked? ──▶ ring 2 …
                                                                │ no
                                                                ▼
                                                     deployment PAUSES itself
```

1. **Create** (Patching → New deployment). Pick updates from what the business's computers report being offered,
   assign computers to rings, and set the soak time, the failures allowed per ring and the window each ring may run in.
   The portal refuses a computer that's managed elsewhere, isn't ready (legacy agent, unpublished build, protected
   class) or hasn't reported a scan, and refuses an update nobody is offered or that isn't installable.
2. **Request the canary.** This creates a signed plan **awaiting approval** and opens its approval page. Updates are
   always **high impact**, so they always need **two** approvers, even on a single workstation, and never the requester.
3. **The canary installs.** It downloads and installs the updates, and never restarts. It reports a state for each
   update (below).
4. **Confirm.** After a restart, if one is needed, the computer's next scan shows whether each update took effect.
5. **Request ring 1** once the gate passes, and so on. Each ring is a new plan with new approvals.

### The gate

A ring can be requested only when the ring before it passes:

| Gate reason | Meaning |
|---|---|
| `in_progress` | The previous ring is awaiting approval, approved or delivered |
| `ring_not_run` | Its plan was rejected, canceled or expired, or reached no computer; request it again |
| `unreconciled` | A computer's outcome is uncertain. Someone has to reconcile it first (below) |
| `too_many_failures` | More computers failed than the threshold allows. **The deployment pauses itself** |
| `canary_not_effective` | The canary hasn't confirmed every update effective. Usually it needs a restart and a scan |
| `canary_proved_nothing` | No update applied to the canary, so it proves nothing. Choose a canary that's offered them |
| `soaking` | The ring passed; the soak time hasn't elapsed |
| `passed` | The next ring may be requested |

A ring over its threshold isn't promoted past. **Resume** the deployment, then request the *same* ring again, leaving
out computers with a reason if you need to. The retry is a new plan and needs new approvals. When the last ring passes,
the deployment is **completed**.

## What each state means

These are the states shown for each update on each computer on the deployment page:

| State | Meaning |
|---|---|
| **awaiting approval** / **scheduled** / **delivered** | The plan isn't approved, is approved but not yet taken, or the computer has it and hasn't answered |
| **installed** | Windows reported the install succeeded. **Not yet confirmed:** a later scan must show it took effect |
| **restart required** | Installed. It takes effect after a restart, which rem0te never does |
| **effective** | A scan taken *after* the result no longer offers the update, Windows' own history records it installed (or the computer said it already was), and no restart is pending |
| **superseded** | Windows Update replaced it with a newer update before install. Nothing was installed for it |
| **not offered** | Windows Update didn't offer it to this computer at install time (e.g. it doesn't apply) |
| **excluded** | Windows Update offered it, but the agent refused it (a driver, optional, needs a licence or input) |
| **failed** | Windows reported a failure, with its own HRESULT. Or a later scan offers it again, which means it didn't stay installed |
| **refused** | The computer refused the whole plan (a signature, target, window or `managed_elsewhere` reason) |
| **unknown** | Nobody knows. The installer died, or the computer didn't answer within six hours. Never reported as failed |
| **canceled** | That computer was taken out before delivery (`device_identity_changed`, `requester_no_longer_authorized`, …) |

**Effective is what the computer reports.** It doesn't prove a vulnerability is fixed, and it doesn't cover a
computer that was restored from a backup afterwards.

A computer counts as **failed** for the threshold if it reported failed, partial, refused or not executed, if any of
its updates is failed or unknown, or if its outcome is uncertain, even after it has been reconciled.

### Uncertain outcomes

If the installer stops part-way (a crash, a power cut, a reboot by someone else), the agent can't say what happened.
It reports **uncertain** and never runs that plan again on that computer. The deployment page shows **Reconcile** for
that computer. Check **Settings → Windows Update → Update history** on it, then record what you found. The gate
doesn't move until you do.

## On the computer

- **Every agent shows updates (0.29.1).** The standard agent, on either channel, answers the inventory's update scan
  every 12 hours and on **Scan now**. A computer without the signed agent shows that list on its **Patches** tab:
  offered updates with KB, severity and size, and whether a restart is pending. It is read-only. It never feeds a
  deployment, because installing needs the signed agent and its fuller scan below.
- **Patch status (0.30).** The Patches tab leads with a summary for every agent: the evidence (signed scan,
  standard read-only scan, or none) with its age and **fresh / stale / unknown** (stale is older than 36 hours), last
  successful scan, last boot, who manages patching (WSUS, Intune, WUfB, ConfigMgr, or *unknown* from the standard
  agent), relevant KBs, whether each update from a recent plan was **confirmed by a later scan**, and why deploying
  is or isn't available. Fields and test status: [What each agent can do](capabilities.md).
- **Posture.** The signed agent scans Windows Update (`rem0te-agent.exe patch-scan`) at most every 12 hours, when the
  portal asks (**Scan now** on the computer's **Patches** tab, or **Refresh inventory**), and no more than once every 30
  minutes. The scan reports offered updates, the last 50 history entries, pending-restart signals (component servicing,
  Windows Update, pending file renames, the update agent) and which update manager, if any, owns the computer. It
  installs nothing.
- **Install.** The heartbeat hands the signed envelope to `rem0te-agent.exe action`. That runs **detached**, so a
  download of several hundred megabytes doesn't hold up the heartbeat. A per-job lock means a re-delivery while it runs is
  answered `in_progress`; a lock on Windows Update means a scan and an install never run at once. The job is journaled
  before anything is installed. A re-delivered plan is answered from the journal, and Windows Update is not asked again.
- **What it runs.** A fixed script compiled into the signed agent, run with Windows PowerShell 5.1
  (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass`),
  using the Windows Update Agent COM API: search, download, install with `ForceQuiet`. It never calls
  `AcceptEula`, never restarts, and runs nothing it downloads. Scans time out after 15 minutes, installs after 4 hours.

## Refusal codes

Portal, when creating a deployment or requesting a ring:

| Code | Meaning |
|---|---|
| `ACTION_NOT_DIRECT` | Updates can't be requested from a computer's Actions tab. Use a deployment |
| `BAD_RINGS` | Ring 0 isn't exactly one computer, a computer is in two rings, or a ring is empty or too large |
| `NO_PATCH_POSTURE` | A computer hasn't reported a Windows Update scan yet |
| `MANAGED_ELSEWHERE` | A computer's updates are managed by WSUS, WUfB policy, MDM or ConfigMgr |
| `UPDATE_NOT_OFFERED` | No computer in the deployment is offered that update |
| `UPDATE_NOT_INSTALLABLE` | A driver, upgrade, optional update, or one that needs a licence or input |
| `RING_GATE` | That ring can't be requested now. The message says why (the gate reasons above) |
| `ACTION_NOT_GRANTED` | Your access level doesn't include high-impact requests (an L2 technician, for example) |

The agent adds `managed_elsewhere`, `update_agent_busy` (a scan held Windows Update for 20 minutes) and
`lookup_failed` to the refusal reasons listed in [Approved actions](approved-actions.md#refusal-codes).

## Installing from one computer's Patches tab

Since 0.32, a computer's **Patches** tab has an **Install updates** button when the computer can be patched. You
pick from its installable updates, the restart rule (only *never* exists) and a window, and give a reason.

- The request becomes a **one-computer deployment**: a single canary ring, marked *one computer* in the list. Its plan
  awaits **two approvals** on the approval signer, like any ring.
- It isn't a direct request. `POST /endpoints/:id/actions` still refuses updates with `ACTION_NOT_DIRECT`.
- When the computer can't be patched, the tab shows no button. It says why and what to do instead:

| Why | What to do |
|---|---|
| It runs the standard agent | Switch it to the signed channel ([Patching setup](patching-setup.md), step 2) |
| No signed build published, or it isn't on it | Publish a release, or let it update itself |
| No device identity | Re-enrol it |
| No signed scan yet | **Scan now** and wait |
| Managed by WSUS, WUfB, MDM or ConfigMgr | Patch it there |
| Offline | Wait until it checks in |
| No approval signer configured | [Patching setup](patching-setup.md), steps 3 to 5 |
| Your access doesn't include high-impact requests | Ask someone whose access does |
| An earlier install is pending or uncertain | Wait, cancel it, or reconcile it |
| Nothing installable is offered | Nothing to do |

The same checks run again when the request arrives, and once more when the deployment is built.

## Patch policies

A **patch policy** (0.32) approves a bounded kind of patching once, so the nightly canary doesn't need two people
every time. Two approvers other than its author approve the policy on the approval signer. After that, **the signer
itself**, not the portal, signs each ring plan, but only if the plan falls inside the policy.

**What the policy binds** (the signer checks each one):

| Bound | Checked against |
|---|---|
| The business and its computers, by enrolled identity (endpoint, RustDesk ID, device-secret hash) | Every target in every plan. A re-enrolled computer is a different computer and is refused |
| The rings, in order. Ring 0 is one canary; later rings hold at most 25 | The signer's own ledger of what it signed. Ring *n* needs ring *n − 1* of the same deployment signed first |
| Classes, severities, excluded KBs | Each update shown in the plan. The plan also carries the filter as `params.allow`, and **each computer applies it** to Windows Update's own answer, so a mislabelled update can't slip past |
| The maintenance window: days, local start and end, IANA time zone | The plan's window must lie inside one occurrence. DST is honoured |
| Soak and failure threshold | The ring gate, re-run by the signer (below) |
| Reboot: never | The plan's params |
| Expiry, at most 90 days | Every plan, and the plan's window end |

**The canary must be effective.** For every ring after the canary, the portal hands the signer the previous ring's
results and scans. The signer re-runs the same gate the portal uses (`evaluateRingGate`): every computer answered,
nothing uncertain left unreconciled, failures within the threshold, the soak passed, and **for the canary, every
update effective in a later scan**.

**What a compromised portal still can't do:** widen the computers, classes or window, change the ring order, skip
the canary, or keep using a revoked or expired policy. It also can't approve a policy: there's no approve route, and
the passkeys are checked on the signer's own origin.

**What it can do** is lie about results. Agents don't sign their results yet, so a portal that forges a whole canary
result could have the next ring start early. That ring still holds only the computers and updates the policy names,
inside its window, with the agent applying the filter.

**The sweep.** Every 60 seconds (`PATCH_POLICY_SWEEP_SECONDS`), the API looks at each active policy whose window is
open:

- If a deployment from the policy is still active, the sweep moves it on by one ring when the gate allows.
- Otherwise it proposes one new deployment for this window: the canary's offered, installable, policy-allowed updates,
  at most 20.

It runs once per window. `(policy, window)` is unique in the database, so a restart or a second process can't propose
twice. Each attempt is recorded on the policy and audited (`PATCH_POLICY_PROPOSED`, `PATCH_POLICY_REFUSED`).

- A paused deployment is left alone, and nothing new is proposed while it exists.
- A containment pause stops it on both sides.
- Computers in a later ring that aren't ready are left out of that ring's plan, each with the reason.
- `PATCH_POLICY_SWEEP=off` disables the sweep.

**Revoking** is one-way and lives on the signer. **Revoke** on the policy's page (fresh sign-in) marks it revoked in
the portal at once, cancels what hasn't been delivered, and asks the signer to revoke. The sweep keeps asking until
the signer confirms. The signer's operator can also revoke with `patch-policy revoke`. Either way the signer writes
`revocations/<id>.json` once and never rewrites it, and refuses every later plan.

Policy refusal codes, from the signer: `policy_revoked`, `policy_expired`, `policy_not_active`, `policy_not_approved`,
`policy_digest_mismatch`, `policy_signature_invalid`, `computer_not_in_policy`, `class_not_allowed`,
`severity_not_allowed`, `kb_excluded`, `filter_mismatch`, `outside_window`, `ring_out_of_order`,
`ring_already_signed`, `ring_retry_limit` (three signings of one ring), `canary_not_effective`,
`canary_proved_nothing`, `gate_not_passed`, `evidence_mismatch`, `updates_not_proven`, `requester_mismatch`,
`reboot_not_allowed`, `paused`.

## Setting it up

Staged patching needs [approved actions](approved-actions.md#setting-it-up) to be set up already: the approval signer,
its roster, and `approval/keys.json` in the signed repository. [Patching setup](patching-setup.md) is the
production order, with a live pre-flight. On top of that:

1. Build and publish the **0.27 signed agent** (`windows/rem0te-agent.exe`) through the offline-signed update chain.
   Agents report `windows.update.install@1` in their heartbeat once they run it.
2. Give the computers time to scan, or press **Scan now** on a computer's **Patches** tab.
3. Choose a canary that's representative, is offered the updates, and that someone can restart.

There are no new server settings.

## What has been proven, and what hasn't

| Level | State |
|---|---|
| **Fixture-tested** | Yes. The Go packages `internal/patch` and `internal/action` test eligibility, manager detection, the parsers' refusal of answers for unrequested updates, every per-update state, crash → unknown, the Windows Update lock, replay, and a second process seeing `in_progress`. `wua.ps1` is parsed by PowerShell in the tests and checked for banned cmdlets. `e2e-staged-patching.mjs` (59 checks) runs the portal, the signer and the agent's real decision code against a simulated Windows Update and registry: posture, deployment refusals, the canary, restart → effective, a three-computer ring with a crash and a failure, auto-pause, resume and retry, identity change, a tampered ring plan, and cancel |
| **Fixture-tested (0.32)** | Yes. `unit-patch-policy.mjs` (114 checks) covers every policy refusal, the window arithmetic across DST in several zones, and the signer's policy records. `e2e-patch-policies.mjs` (75 checks) covers: a one-computer install through two approvals to effective; no button on a standard-agent computer; a policy approved by passkey; the sweep proposing the canary inside the window; the agent installing only the policy's class; ring 1 signed automatically only after the canary was effective; the signer refusing widened rings, a disallowed class, a wider filter, out-of-window plans, a skipped canary, an altered digest, a non-author requester, expired and revoked policies, and a containment pause; and no duplicate after an API restart. Go tests cover the agent's `allow` filter |
| **Paired lab** (real Windows, real Windows Update, real authenticator) | **Not done.** The script hasn't run against a real Windows Update service. Classification IDs, result codes and pending-restart keys are as Microsoft documents them, not yet as observed |
| **Production-ready** | **No.** It needs the paired lab first: a canary, a WSUS-managed computer, an update that needs a restart, and one that fails |

## Known limits

- Windows only, and Microsoft updates only. No third-party patching, drivers or feature upgrades.
- No restarts, no maintenance-window restarts, no user notification. "Restart required" waits for a person.
- No uninstall or rollback.
- Rings are chosen by hand, for a deployment and for a policy. There is no automatic grouping by model, site or role.
- A policy can't restart computers. A restart rule needs a change to the agent's closed parameters.
- Under a policy, the portal relays ring results to the signer. Agents don't sign results, so a compromised portal can
  start the next ring early by forging them. It can't widen the ring.
- A computer managed by WSUS or Intune is refused rather than coordinated with.
- Posture is device-reported, so a compromised computer can misreport its own posture. It can't widen another
  computer's plan, and it can't get anything installed that Windows Update doesn't offer it.
- A compromised portal can delay, cancel or withhold a ring, or misreport the gate *to you*. It can't sign a plan,
  add a computer to a signed ring, or make a computer install an update the plan doesn't name.
