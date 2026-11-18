# Automation schedules

From 0.58 an approved library script or a software catalog package can run **on a schedule**: every few hours,
daily, weekly, or monthly, on named computers or on a device group. The schedule is an **automation policy**.
Two people approve it once, with passkeys, on the [approval signer](approved-actions.md). After that the signer
signs each run under it and checks every run against what was approved: the same task, the same computers, inside
the schedule's window, one run at a time. Nothing in the portal can approve a schedule or run anything itself.

A single run at a chosen time doesn't need a schedule. The script **Run** panel, a computer's **Software** tab and a
software deployment's rings all offer **Schedule** for one start time, up to 14 days ahead. That time becomes the
signed plan's `notBefore` (see [Tasks](#one-time-scheduling) below).

Everything here has been tested against a simulated agent (the agent's real verifier and executor, running
PowerShell 7 and a simulated winget on Linux). **None of it has run on a real Windows computer yet.**

## What a schedule names

| Part | What it is |
|---|---|
| Task | One approved library script version, by its exact SHA-256, with typed arguments and a timeout. Or one software catalog entry at its current revision, to install or uninstall. |
| Where | Up to 25 named computers, each bound to its enrolled identity (RustDesk ID and device-secret hash). Or a device group with a cap of at most 25 computers per run. |
| When | **Every N hours** (1, 2, 3, 4, 6, 8 or 12), at a minute past, open for 15 minutes up to the gap between runs, counted from local midnight in a time zone. Or a **daily, weekly or monthly window**, the same shapes as a patch policy's maintenance window. For daily, tick every day. |
| If offline | *Run it when it comes online* while the window is open. Or *skip it*: only computers online at the start are named, and the plan expires after 15 minutes. Or *run it for up to N hours* (1–24) from the start of the window, even after the window closes. |
| Plans per window | 1 to 3. Runs never overlap: a new plan is not signed while an earlier plan of the schedule is still open. A later plan in the same window names only computers no earlier plan named. More than one only helps when a plan closes before the window does. |
| Expires | Never (0.63): a schedule runs until it is paused or revoked. One made before 0.63 keeps its expiry of at most 90 days; a revision of it never expires. |

The offline rule is not a portal setting. It becomes each run's **signed expiry** (`notAfter`), and the signer
refuses a plan that lasts longer than the rule allows. A computer that checks in late has the plan refused by its
own agent. No plan is ever valid for more than 24 hours or, for a schedule made before 0.63, past its expiry.
A schedule's document carries either its `expiresAt` or a signed `expiry: "never"`, never both; see
[Staged patching → Policies that never expire](staged-patching.md#policies-that-never-expire-063).

## How it runs

1. **Propose.** *Automation → Schedules → New schedule.* The portal checks everything as you, now. You must be
   able to run the script, or request the package, on every computer (or on every current member of the group).
   It then sends the document to the signer. This step asks you to confirm it is you (*Settings → Confirm it is
   you*, key `automation.policy`).
2. **Approve on the signer.** The signer checks the document against its own rules, for example that the script is
   ACTIVE on *its* allowlist and the package has not been revoked there. Two approvers then approve it on the
   signer's own page with passkeys.
   - The author cannot approve.
   - Nor can anyone who wrote or edited the script, the same rule as a single run.
   - The page shows the script itself with its hash, or the package, version and installer hash. It also shows the
     computers, the schedule in words, the offline rule, and that the approvers are not asked again for each run.
3. **Each window.** The portal's sweep (`AUTOMATION_SWEEP`, every 60 s) finds the window that is open now, then
   checks, in order:
   - no earlier plan is still open;
   - containment doesn't pause actions for the business;
   - the author is still active;
   - the script is still on the allowlist, or the catalog entry is unarchived and unchanged.

   It works out which computers are ready, leaving out any that cannot run it and saying why. Then it asks the
   signer for one plan, on the author's behalf, through the ordinary action path.
4. **The signer signs or refuses.** It runs its ordinary admission: the script allowlist, software revocation,
   pauses. Then it checks the plan against the approved policy, signs it, and records it in the policy's ledger.
   The agent verifies it exactly as it verifies any other signed plan.

If something stops a window, the history shows why: a refusal, containment, a revoked script, or no computer ready.
The sweep tries again in that window only after ten minutes.

## Device groups

A group's members are worked out at **every run**, as the author would see them then, through the same rules a
device-group policy uses. A computer added to the group later is picked up, and one removed is not.

**The approval signer cannot see the group.** For a group schedule it holds each run to the schedule's business and
cap only. The approval page says so in those words. If that is not enough for a business, name the computers.

## Direct mode

In [direct mode](approved-actions.md), which only the signer's operator can turn on for a business, a schedule is
ACTIVE as soon as you create it, with no approvers. Creating it therefore also asks you to confirm it is you under
`actions.direct`. Its runs are signed with `approval: "direct"`. A direct schedule stops counting the moment its
business leaves direct mode: the signer then refuses its runs (`policy_not_approved`).

## Pause, resume, revoke, revise

- **Pause** stops it at once. Runs not yet handed to a computer are canceled, and nothing is asked for until it is
  resumed. Pausing never asks you to confirm it is you, because it only stops things.
- **Resume** asks you to confirm it is you (`automation.policy`).
- **Revoke** is one-way, and also asks you to confirm it is you. The portal stops at once and tells the signer, which
  writes a write-once revocation file. The portal keeps telling the signer until it confirms. The signer operator
  can also revoke a schedule on the signer host: `automation revoke --id <id> --reason "…"`.
- **Revise** makes a new schedule that replaces this one once the new one is ACTIVE. Changing what runs, where or
  when, including widening the computers, is always a revision, approved again from the start. Until then the old
  one keeps running.

Each of these is audited: `AUTOMATION_POLICY_CREATED`, `_PAUSED`, `_RESUMED`, `_REVOKED` and `_SUPERSEDED`, plus
`AUTOMATION_RUN_PROPOSED` / `_REFUSED`. Each run's job is audited as any action is (`ACTION_REQUESTED` carries
`automation: true`).

These stop every later run without touching the schedule:

- revoking the script on the allowlist;
- archiving the catalog entry (which revokes it on the signer);
- an `actions` containment pause, in the portal or on the signer.

## History

A schedule's page shows each window, its plans, and how each computer did. It also shows the last and next runs,
the next five windows, the success and failure counts across every run, the approvals, how many plans the signer
has signed under it, and what the signer refused. Each run is also on the computer's Actions history and in
*Automation → Tasks*.

## One-time scheduling

The script **Run** panel and a computer's **Software** tab (install or uninstall of a catalog entry) offer *Run now*
or *Schedule*, the same picker as an update install or a restart. The date and time are a wall-clock time in a named
zone, up to 14 days ahead. They become the signed plan's `notBefore`, and the window starts there. Nothing is handed
to a computer before then. Until it starts, the run can be canceled from *Automation → Tasks*. A deployment ring
takes a time too (*Schedule* on the ring).

## What the agent sees

Nothing new. A run is an ordinary `windows.script.run@1` or `windows.software.install@1` / `uninstall@1` plan
carrying the policy's name and digest in its display block, signed with the policy's approvers. **The agent needs no
change, and no agent release is needed.** The signer does change: it has a new document type, its own routes and
checks, and an `automation` CLI. It must be reinstalled from 0.58 (`apps/api/scripts/build-approval-signer.mjs`)
before schedules can be made. Until then the portal says *the approval signer is older than 0.58*.

## Refusals

| Code | Where | Meaning |
|---|---|---|
| `STEP_UP_REQUIRED` | portal | Create, resume and revoke ask you to confirm it is you. |
| `PARAMS_NOT_ALLOWED` | portal | The arguments don't match the script's declarations. |
| `SCRIPT_NOT_ALLOWLISTED` / `ENTRY_ARCHIVED` | portal | The task can't be scheduled. |
| `GROUP_NOT_REACHABLE` | portal | The group holds a computer you can't act on. |
| `SIGNER_TOO_OLD` | portal | The signer answering is older than 0.58. |
| `script_not_allowlisted`, `script_revoked`, `software_revoked` | signer | Refused at admission and at every run. |
| `requester_cannot_approve`, `contributor_cannot_approve` | signer | The author, or a script's contributor, tried to approve. |
| `policy_not_active`, `policy_revoked`, `policy_expired`, `policy_not_approved`, `expiry_unknown` | signer | Nothing is signed. |
| `computer_not_in_policy`, `too_many_targets` | signer | A computer not named (or re-enrolled since), another business's, or over a group's cap. |
| `outside_schedule`, `offline_rule_mismatch` | signer | The plan starts outside the window, or lasts longer than the offline rule. |
| `previous_run_open`, `occurrence_run_limit`, `already_ran_this_occurrence` | signer | No overlap, the per-window limit, one plan per computer per window. |

## Settings for test stacks

`AUTOMATION_SWEEP=off` stops the sweep. Nothing is proposed and the pages say so. `scripts/run-e2e.sh` exports it,
and the browser suite sets it. `AUTOMATION_SWEEP_SECONDS` changes the interval, with a floor of 2 seconds.

## What has been proven, and what hasn't

- `apps/api/scripts/unit-automation-schedule.mjs` covers:
  - the recurrence, including a skipped DST hour;
  - the offline rule as the expiry;
  - the document and its quorum;
  - every refusal of the signer's plan check;
  - the signer in-process: approval, occurrence plans, overlap, revocation, pause, direct mode, the CLI.
- `apps/api/scripts/e2e-automation-schedule.mjs` drives the real portal, the real signer and the agent's verifier and
  executor through a script schedule and two software schedules, one in direct mode on a device group. It covers:
  - approval, signing, running and reporting;
  - pause and resume;
  - a revoked script and an archived package stopping the next window;
  - a containment pause;
  - revocation;
  - isolation between businesses.
- Not proven: anything on real Windows, or a schedule over days of real time. The e2e moves a window's portal records
  back an hour to stand in for "the next window".
