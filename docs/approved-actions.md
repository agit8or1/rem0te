# Approved actions

rem0te 0.26 can make one change on a customer computer outside a remote session: **start the Windows Print Spooler,
once**. It happens only after people on an approval roster have authorized that exact plan with a passkey, on a page
the portal does not serve, and only on a computer whose agent checks all of it again before anything runs.

From 0.27 the catalog has a second action, **installing named Windows updates**, which is requested only through a
staged deployment of a canary and rings. See [Staged patching](staged-patching.md).

From 0.32 it has four **maintenance actions**, each on one computer: restart one service from a fixed list, schedule
a warned restart, cancel a pending restart, and collect a fixed set of logs. See
[Maintenance actions (0.32)](#maintenance-actions-032). The rest of this page describes the Print Spooler action, and
the machinery every action shares.

From 0.34 it has two **software actions**: install and uninstall one allowlisted winget package, pinned by version and
installer SHA-256, requested only from the software catalog (one computer, or a canary and rings). See
[Software deployment](software-deployment.md).

Those eight are the whole catalog. You can't request a command, a script, a path, a URL, a service off the list, a
restart message of your own, a log file or time range of your own, or a change to any service's startup type. Credential extraction, removing backups, disabling defenses, granting admin rights and wiping
disks aren't in the catalog and never will be. Nor can you request a package outside the catalog, an installer of
your own, installer switches, or a per-user install. They aren't switched off; nothing exists to request them.

> **Warning.** Documents already waiting in the print queue may print as soon as the spooler starts. They can't be
> recalled once they reach the printer. The requester confirms this, and the approval page shows it.

## Who does what

| Step | Who | Where | What it can and cannot do |
|---|---|---|---|
| **Request** | A technician whose access level allows it, a Business Owner, a Business User granted `actions:request`, a Platform Admin. Or ClientSt0r, as a mapped technician | The computer's **Actions** tab, or `POST /api/integration/v1/action-proposals` | Proposes a plan. Authorizes nothing |
| **Approve** | People on the **approval signer's roster**, each with a user-verified passkey | The signer's own origin (e.g. `https://approve.example.com/approve/<job>`) | Signs the exact plan. Never the requester |
| **Customer sign-off** | A Business Owner on the roster for *that* business, where its policy requires it | The same page | Must be a different person from every approver |
| **Deliver** | The portal | Heartbeat | A courier only. It rechecks access and device first, and cannot alter or forge a plan |
| **Execute** | `rem0te-agent.exe` on the computer | The endpoint | Verifies everything itself, runs the job at most once, reports what it saw |

**How many approvals:**

| Computer | Approvals | Who decides the risk |
|---|---|---|
| A standard workstation (`deviceClass` WORKSTATION, and Windows reports a workstation product type) | 1 | The catalog, at the portal, the signer *and* the agent |
| Anything else: server, unknown class, a "workstation" whose Windows says it's a server | 2, from different people | The agent recomputes it from its own product type, so a plan that understates risk is refused |
| Protected device classes (domain controllers, hypervisors, backup servers, RMM hosts) | Not possible in this release | Refused at request time |

**An AI suggestion gets no shortcut.** A ClientSt0r proposal with `origin: ai_suggestion` needs exactly the approvals
a person's request needs. The approval page labels it as an AI suggestion and names the ticket.

## Why a compromised portal can't do this

The portal and its database are what an attacker is most likely to get. So neither of them holds anything that can
make a computer act:

- **The signing key isn't the portal's.** Job approvals are signed by the **approval signer**. It's a separate process
  under its own Unix user (`rem0te-approver`), with its own state directory, key, roster and policy. It runs from a
  root-owned install the portal's user cannot write. It loads no Nest, no Prisma and no portal module, and
  `build-approval-signer.mjs` and the security invariants check that.
- **Approval is a passkey assertion the signer verifies itself.** The roster holds each approver's passkey public
  key, added by an operator after a fingerprint read-back. The signer never reads the roster from the portal. Every
  decision needs a fresh, single-use challenge, user verification, the signer's own origin and RP ID, and a counter
  that has moved forward. The challenge is derived from the plan's digest, the decision and the role, so the
  passkey's signature itself covers the exact plan the approver was shown.
- **The agent trusts approval keys only from the offline-rooted update chain.** `approval/keys.json` is a signed
  target, like the agent binary ([update-signing.md](update-signing.md)). The portal mirrors it but can't change it.
- **Three key holders, kept apart.** Release signing keys sit offline with the release machine. The job-approval key
  sits with the approval signer. Portal administration is a role in the portal. None of them can act as another.

The end-to-end test proves this by planting envelopes straight into the database. One is signed by an attacker's key.
The other is a real envelope with an altered plan. The portal delivers both, as a courier would, and the agent
refuses both (`unknown_key`, `bad_signature`).

What a compromised portal *can* still do is deny service. It can refuse to deliver, cancel plans awaiting approval,
or withhold results. It can also re-deliver an envelope the agent has already consumed, which the agent answers from
its journal without running anything.

## What is signed

The plan an approver sees, and the signature covers:

- the catalog action and its version (`windows.service.start@1`) and parameters (`{"service":"Spooler"}`);
- the **agent build** that may run it (the sha256 of the signed `windows/rem0te-agent.exe` target);
- the **target**: business, hostname, device class, RustDesk ID and the sha256 of the device secret. These are the
  identifiers the computer was enrolled with, not a hostname alone;
- the requester and where the request came from (portal or ClientSt0r; technician or AI suggestion; ticket);
- the **policy**: risk, approvals required and customer sign-off, re-derived by the signer and refused if the portal
  claims otherwise;
- every approver: user, role, passkey credential hash and time;
- the **window** (`notBefore`–`notAfter`, at most 24 hours) and a **single-use job id**.

The signed bytes are canonical JSON, prefixed `rem0te-action-plan-v1\n`, signed with Ed25519.

## What the computer checks

Before it touches anything, `rem0te-agent.exe action --job <id> --envelope <file>` checks, in order:

1. **Its journal.** A job id runs at most once, ever. A re-delivered envelope gets the recorded result. A job the
   journal shows as *executing* (the agent died mid-action) is reported **uncertain**, with the service state seen
   now, and is never run again.
2. The envelope's signature, against `approval/keys.json` fetched through the signed update chain.
3. A strict parse of the plan. Any field it doesn't know is a refusal.
4. The action and parameters, against the catalog compiled into this agent.
5. That it is the target: its own RustDesk ID and the sha256 of the secret in `heartbeat.dat`.
6. The window, by its own clock. A plan that isn't valid yet isn't consumed, so clocks that disagree only delay it.
7. That it is the named agent build.
8. The approvals: enough distinct approvers for the risk *it* computes from its own Windows product type, none of
   them the requester, plus a distinct customer sign-off when the plan's policy requires one.

Only then does it write *executing* to the journal (fsync, then rename), start the service, and check it again
10 seconds and 30 seconds later. The startup type isn't changed, so a disabled spooler stays disabled and the start
fails.

## What the result means, and what it doesn't

| Outcome | Meaning |
|---|---|
| **Succeeded** | The spooler was started and was still running at both checks |
| **Succeeded** (*already running*) | It was already running; nothing was changed |
| **Failed** | It wouldn't start, or it didn't stay running |
| **Refused by the computer** | A check above failed, and the reason is given. Nothing ran |
| **Not executed** | The window closed before the computer saw the plan |
| **Outcome uncertain** | No result within 30 minutes, or the agent was interrupted mid-action |

A result is the service state the agent saw. **It isn't evidence that any document printed**, that the printer works,
or why the spooler had stopped. rem0te never claims any of those.

**Uncertain outcomes are reconciled before any retry.** While a job is uncertain, no new request for that action on
that computer is accepted. The requester, a Business Owner of that business or a Platform Admin checks the computer
and records what they found under **Reconcile** on the Actions tab. That's possible only once the computer can no
longer run the job: either it answered from its journal, or the signed window has closed. A reconciled job can never
run alongside a retry.

## Rechecked at dispatch

Between approval and the first delivery, the portal rechecks everything that may have changed:

- the computer is still in that business, with the same device identity and device class;
- the requester still has access to it, and their access level still allows the request;
- the requester isn't paused by a fleet limit, and a write is admitted.

If any check fails, the plan is canceled with the reason, and the cancellation is audited (`ACTION_DISPATCH_BLOCKED`).
A plan whose window has closed expires undelivered.

## Evidence

Each step is in the activity log, against the job:

`ACTION_REQUESTED` (with the digest) → `ACTION_APPROVAL_UPDATED` → `ACTION_DISPATCHED` → `ACTION_RESULT` (with the
outcome and what was observed). Refusals and blocks are recorded as `ACTION_DISPATCH_BLOCKED`, cancellations as
`ACTION_CANCELED`, reconciliations as `ACTION_RECONCILED`.

The signer keeps its own record of every decision in its state directory, outside the portal's database: who, with
which credential, when, and over which digest.

## Maintenance actions (0.32)

Four more catalog actions, each requested from the computer's **Actions** tab (**Run action** at the top of its page
opens it), each naming one computer. They use everything above unchanged: the separate signer, passkey approvals,
the agent's own checks, the journal, the dispatch rechecks, containment and the audit trail. What is different:

- **Two different approvers, always.** All four are high impact on any computer, workstation or not. The portal, the
  signer and the agent each derive that independently; a plan that claims `low` is refused (`risk_mismatch` at the
  signer, `risk_understated` at the agent).
- **Closed parameters.** One allowlisted service name, one whole number of minutes, or nothing at all.
- **Not offered to ClientSt0r.** `capabilities` lists only the Print Spooler start and update install, and a
  proposal naming a maintenance action is `ACTION_NOT_IN_CATALOG`. Offering them is a change to the ticket-rmm
  contract that ClientSt0r has not agreed to.

| Action | Parameters | What the agent does |
|---|---|---|
| `windows.service.restart@1` | `{"service": <one of the list below>}` | Re-checks the name against a charset (`^[A-Za-z0-9_]{1,64}$`) and its own allowlist. Journals *executing*, then *stopping*, asks the service manager to stop it and waits up to 60 s, journals *starting*, starts it, and checks it 10 and 30 seconds later. A stopped service is only started. A service with running dependents is refused by Windows, and nothing else is stopped. The startup type is never changed |
| `windows.reboot.schedule@1` | `{"delayMinutes": 5…1440}` (the page offers 5, 15, 30 min; 1, 2, 4, 8, 24 h) | Runs `%SystemRoot%\System32\shutdown.exe /r /t <seconds> /d p:4:1 /c <fixed warning>`. Never immediate. If Windows already has a restart or shutdown pending, it changes nothing (`restart_already_scheduled`) |
| `windows.reboot.cancel@1` | none | Runs `shutdown.exe /a`. Reports `no_change` when nothing was pending |
| `windows.logs.collect@1` | none | Collects the fixed sources below, redacts them, and returns them in its result. Also needs `computers:event_logs` |

**The service list** is `Spooler`, `wuauserv` (Windows Update), `BITS`, `W32Time` (Windows Time), `WinRM` and
`RustDesk`. Each is an ordinary service whose restart is a routine repair and whose absence for a few seconds harms
nothing permanent. Left off deliberately:

- security products and the security subsystem: Defender (`WinDefend`, `WdNisSvc`, `Sense`), the firewall
  (`mpssvc`, `BFE`), Security Center, `lsass`, `SamSs`, `KeyIso`, `VaultSvc`, `Netlogon`. Restarting them is what
  an intruder wants, and a failed restart leaves the computer unprotected;
- `EventLog`: restarting the event log is how activity is hidden;
- `RpcSs`, `DcomLaunch`, `RpcEptMapper`: Windows will not stop them, or stops everything with them;
- `Dnscache` (DNS Client): Windows 10 and later refuse to stop it, so the action could only fail;
- `LanmanWorkstation` (Workstation): stopping it drops every open file and mapped drive, and Netlogon depends on it
  on a domain member.

The list is compiled into the agent and repeated in the portal's catalog; the security invariants check the two
agree and that no security or core service is on it. Changing it is a new agent release and a review.

**The restart warning** is fixed text. Its only inputs are the time and delay the agent computed itself and the job id
it verified:

> Your IT support provider has scheduled a restart of this computer for 14:30 on Tue 10 Nov (in 30 minutes). Please
> save your work and close your programs before then: programs still open will be closed without saving. Approved
> maintenance, reference 1a2b3c4d.

The delay counts from when the computer receives the approved plan, at its first check-in after approval. So a
restart plan's signed window is at most **2 hours** (the portal refuses longer with `WINDOW_TOO_LONG`, and the signer
and the agent refuse it too): a restart must not land many hours after the time its approvers had in mind.

**Canceling** is a second action with its own two approvals. If you may need to cancel, request and approve the
cancel early; a restart whose delay ends first is not stopped. It cancels whatever is pending on the computer,
including a restart someone else scheduled there.

**Open sessions.** Before scheduling a restart, and before restarting the RustDesk service, the agent counts
incoming RustDesk sessions (the `rustdesk.exe --cm` connection-manager processes, the same signal the heartbeat
reports). If one is open, the job ends `not_executed` (`remote_session_open`); if the agent cannot tell, it ends
`not_executed` (`session_state_unknown`). Either way nothing changed and it is final: request it again. The check runs
after the signed pause and before the job is journaled *executing*. It is made **once, when the restart is
scheduled**: someone who connects during the warning period sees the Windows warning on screen but does not stop the
restart. Console and Remote Desktop sessions are not checked; the warning is shown to them, and that is the
safeguard.

**Collected logs.** Fixed sources, in this order, at most 12 KB from each and 40 KB in all:

| Source | What |
|---|---|
| `system_errors`, `application_errors` | Critical and Error events from the System and Application logs in the last 24 hours, at most 50 each, newest first (`wevtutil qe … /f:text`), with the computer, user, task, opcode and keyword lines dropped |
| `agent_journal` | One line per recent approved action on this computer, from the agent's journal |
| `agent_log` | The end of the agent's own log |
| `rustdesk_log` | The end of the newest `.log` under the RustDesk service profiles' log directories. A person's own profile is never read; links are not followed |

The agent redacts before anything leaves the computer: control characters, user-profile paths (`C:\Users\<name>`
becomes `%USERPROFILE%`), opaque tokens of 40 characters or more, and anything written as `password=`, `secret:`,
`token=`, `api_key=`, `Authorization: Bearer …`. The portal does not trust that copy: it applies the diagnostics
catalog's redaction and the same credential rule again, and the size caps, before storing it. Names of people,
computers, files and network addresses can remain; the requester confirms that before asking.

Who sees it: requesting a log collection needs `computers:event_logs` as well as permission to request actions (for a
technician, from the same grant as the computer, as for the Event Log tab). Anyone viewing the job without it sees
that text was collected and withheld, never the text. A requester who loses that permission between approval and
delivery has the plan canceled at dispatch (`requester_lost_capability`). The activity log records each source's size,
not its text.

**Results.** The service restart reports the state before, after the stop and at both checks. The restart schedule
reports the time it scheduled the restart for; **it cannot report the restart itself**, which shows afterwards as a
new boot time in the inventory. An interrupted job (the agent stopped mid-action) is reported uncertain with how far
it got (`stopping`, `starting`, `scheduling`, `canceling`, `collecting`) and, for a service restart, the service's
state now; reconcile it as for the spooler (`running`, `stopped`, `restart_scheduled`, `no_restart_scheduled`,
`other`).

**Where it is inert.** Like the first two actions, these need an approval signer installed and a computer on a 0.32+
signed agent build. Production has no signer installed, so the Actions tab says "no approval signer is configured"
and requests nothing; a computer whose agent does not report an action shows that action as not available on it.

## Patch policies: approved once, signed by the signer

From 0.32, a person can approve a bounded **patch policy** instead of each update ring
([Staged patching → Patch policies](staged-patching.md#patch-policies)). It is the one case where a plan is signed
without its own two approvals, so the design keeps the decision on the signer:

- **The policy is approved like a plan**, on the signer's own origin at `/approve/policy/<id>`, by two people on the
  roster other than its author, with their passkeys. Customer sign-off applies if the business requires it. On
  quorum the signer signs `rem0te-patch-policy-approved-v1` over the policy's digest and the approvals.
- **Each ring plan is evaluated by the signer** against the stored, signature-checked policy. The check is
  `evaluatePolicyPlan`, a pure function in `apps/api/src/actions/patch-policy.ts` that loads no Nest, Prisma or
  portal module. It checks:
  - every target's enrolled identity;
  - the ring order, against the signer's own ledger;
  - classes, severities and KBs;
  - the window, the expiry and the requester;
  - the previous ring's gate, including canary-effective.

  Only then is the plan signed, carrying the policy's approvers.
- **The portal can propose a policy and ask for it to be revoked.** It can't approve a policy, un-revoke one, or sign
  under one. `POST /internal/v1/policies/:id/plans` is a request for the signer to decide; a refusal comes back as
  `409` with the code, and the signer keeps the last 50 with the policy.
- **Revocation** is a write-once file on the signer (`revocations/<id>.json`), merged into the policy on every read.
  Neither the portal nor the signer's own server rewrites it.
- A containment pause on the signer refuses new policies, policy decisions and every plan under a policy.

The signer operator's CLI:

```bash
$S patch-policy list                                   # status, signature check, approvals, plans signed, last refusals
$S patch-policy revoke --id <policyId> --reason 'why'  # one-way
```

## Setting it up

For the full production order, including patching, see [Patching setup](patching-setup.md).

You need a working signed update chain first ([update-signing.md](update-signing.md)). That's how computers learn
the approval key.

**1. Install the signer (root, once).**

```bash
cd apps/api && npx nest build
node scripts/build-approval-signer.mjs --out /tmp/rem0te-approver
(cd /tmp/rem0te-approver && npm install --omit=dev) && echo ok     # must print ok
sudo useradd --system --home /var/lib/rem0te-approver --shell /usr/sbin/nologin rem0te-approver
sudo rsync -a --delete /tmp/rem0te-approver/ /opt/rem0te-approver/
sudo chown -R root:root /opt/rem0te-approver && sudo chmod -R go-w /opt/rem0te-approver
sudo install -d -m 0750 -o root -g rem0te-approver /etc/rem0te-approver
sudo tee /etc/rem0te-approver/signer.env >/dev/null <<'ENV'
APPROVAL_SIGNER_DIR=/var/lib/rem0te-approver
APPROVAL_ORIGIN=https://approve.example.com
APPROVAL_RP_ID=approve.example.com
APPROVAL_PUBLIC_PORT=3201
APPROVAL_INTERNAL_PORT=3202
ENV
sudo cp deploy/systemd/rem0te-approval-signer.service /etc/systemd/system/
```

Give it its **own hostname**, not a path on the portal's. Uncomment the `approve.` site at the end of
`deploy/caddy/Caddyfile`. On the same origin as the portal, any script the portal served could drive the approval
page.

**2. Generate the key, and publish its public half through the release chain.**

```bash
S="sudo -u rem0te-approver env APPROVAL_SIGNER_DIR=/var/lib/rem0te-approver node /opt/rem0te-approver/dist/approval-signer/main.js"
sudo systemctl start rem0te-approval-signer   # creates the state directory
$S keygen > approval-keys.json                # refuses to overwrite an existing key
```

Take `approval-keys.json` (public keys only) to the release machine, and sign it in with the next release:

```bash
rem0te-release release -repo DIR ... -add approval/keys.json=./approval-keys.json
```

`rem0te-release` refuses a key list the agent would reject.

**3. Enrol the approvers.** Each approver adds a passkey to their account (**Account → Passkeys**). Under it they
see an **approval fingerprint** and an export. They send the export to the operator, then read the fingerprint
aloud **from their own screen**:

```bash
$S roster add --export '<export>' --approve '*' --confirm-fingerprint 1a2b-3c4d-5e6f-7a8b   # MSP approvers: every business, or a list of business ids
$S roster add --export '<export>' --customer <businessId> --confirm-fingerprint ...      # a customer's own sign-off
$S roster list
$S roster disable --user <userId>                                                          # takes effect on the next decision
```

A mismatched fingerprint is refused. That step is what stops a tampered export: the export travels through the
portal, but the fingerprint is read from the approver's own screen.

**4. Set customer sign-off, per business.** This lives on the signer, not in the portal:

```bash
$S policy set --business <businessId> --customer-signoff required
$S policy set --business default --customer-signoff not_required
```

**5. Point the portal at it.** In `/etc/reboot-remote/api.env`, set
`APPROVAL_SIGNER_INTERNAL_URL=http://127.0.0.1:3202`, then restart the API. The portal accepts only a loopback URL
here.

**6. Update the agents** to a 0.26+ signed build. The heartbeat then reports `windows.service.start@1` and the
build's digest. A computer isn't offered the action until it runs the currently published build, because any other
build would refuse the plan.

## Requesting one

On the computer's page, open **Actions**. Read the warning, give a reason (the approvers see it), tick the
confirmation, and choose **Request approval**. The page shows the status and an **Open approval page** link while the
plan awaits approval. Send that link to the approvers. Nobody can approve from the portal; there is no approve route.

The approval page shows the business, the computer (hostname, class, RustDesk ID), the action and its parameters, the
warning, who asked and why, the window, the agent build and the plan digest. **Approve** and **Reject** each ask for
a passkey. A rejection is final.

## Refusal codes

| Code | Meaning |
|---|---|
| `ACTION_NOT_IN_CATALOG` | Not a catalog action. Commands, scripts and the blocked categories are always this |
| `ACTION_NOT_DIRECT` | Requested through its own workflow, not the Actions tab: update install (a patch deployment) and, from 0.34, software install and uninstall (the software catalog) |
| `PARAMS_NOT_ALLOWED` | The parameters aren't the catalog's (another service, an extra field) |
| `ACTION_NOT_GRANTED` | Your role or access level doesn't include requesting this, on this computer |
| `PROTECTED_DEVICE_CLASS` | The computer is a protected class |
| `ENDPOINT_NOT_READY` | No enrolled identity, a legacy agent, an agent that doesn't report the action, or a build other than the published one |
| `WINDOW_TOO_LONG` | 0.32: the requested window is longer than the action allows (a restart schedule: 2 hours) |
| `ACTION_PENDING` | An earlier request for this action on this computer is still unresolved |
| `ACTION_UNRECONCILED` | An earlier outcome is uncertain. Reconcile it first |
| `APPROVAL_SIGNER_ERROR`, `APPROVAL_SIGNER_REFUSED`, `APPROVAL_SIGNER_UNREACHABLE` | The signer didn't answer, or refused the plan (e.g. `policy_mismatch` after a policy change, or `paused` while the signer holds a pause) |
| `CONTAINED` | Actions are paused for this business, or globally ([Containment](containment.md)). An approved plan is held, not canceled, and is delivered when the pause is lifted |

Agent refusal reasons: `bad_signature`, `unknown_key`, `bad_plan`, `job_mismatch`, `not_signed`, `unknown_action`,
`params_not_allowed`, `bad_targets`, `wrong_target`, `not_yet_valid`, `expired`, `artifact_mismatch`,
`risk_understated`, `too_few_approvals`, `requester_approved`, `no_customer_signoff`, `paused` (0.28: a signed
`control/pause.json` covers this business or computer. Like every refusal it is final: lifting the pause doesn't revive
the job; request it again), `bad_window` (from 0.32 also a restart plan whose window is over 2 hours).

0.32 maintenance results that are not refusals: `remote_session_open` and `session_state_unknown` (not executed,
nothing changed), `restart_already_scheduled`, `stop_failed`, `start_failed`, `did_not_remain_running`,
`schedule_failed`, `cancel_failed`, `no_maintenance` (an agent built without the maintenance surface).

0.34 software results: `managed_elsewhere`, `hash_mismatch` and `manifest_hash_mismatch` (refused, nothing installed),
`winget_unavailable`, `winget_too_old` and `detection_failed` (not executed), `download_failed`,
`installer_not_found`, `install_failed`, `uninstall_failed` and `not_effective` (failed), `timeout` (uncertain),
`no_software` (an agent built without the software surface). See
[Software deployment](software-deployment.md#refusals-and-results).

## What has been proven, and what hasn't

| Level | State |
|---|---|
| **Fixture-tested** | Yes. `internal/action` Go tests cover every refusal, replay, crash and verification path. `unit-approval-signer.mjs` (79 checks from 0.32) covers synthetic passkeys through the real WebAuthn verification: forged origin and RP ID, missing user verification, reused and cross-decision challenges, counter regression, the requester approving, quorum, customer sign-off and restart. `e2e-approved-action.mjs` (76 checks) runs the portal, the signer and the agent's real decision code against a simulated Windows, including the compromised-database envelopes |
| **Fixture-tested, 0.32** | `internal/action` Go tests for the maintenance actions (allowlist, charset, delay bounds, session check, journal steps, interruption, redaction and size caps); `unit-approval-signer.mjs` adds the maintenance admission and two-approver cases; `e2e-maintenance-actions.mjs` runs all four through the portal, the signer and the agent's real decision code against a simulated Windows (service manager, `shutdown.exe`, `wevtutil` and the session count are simulated) |
| **Fixture-tested, 0.34** | `internal/action` Go tests for the software actions against a stub winget run through the agent's real exec path (success, already installed, hash and manifest mismatch, winget missing or too old, managed elsewhere, timeout, not effective, restart required, argument injection in every field); `unit-approval-signer.mjs` adds the software admission, two-approver and 25-computer cases; `e2e-software-deploy.mjs` runs the catalog, single installs and uninstalls, rings, compliance and isolation through the portal, the signer and the agent's real decision code. winget, App Installer under SYSTEM, the uninstall registry and file versions are simulated |
| **Paired lab** (real Windows workstation, real authenticator, real ClientSt0r) | **Not done.** The Windows calls (service control manager, registry product type, `rustdesk --get-id`, and from 0.32 `shutdown.exe`, `wevtutil.exe` and the RustDesk process count) are compiled and vetted for Windows but haven't run on a lab machine |
| **Production-ready** | **No.** It needs the paired lab first, and an operator who has done the key and roster ceremonies |

## Known limits

- Eight actions, on Windows only. Every action but update install and the two software actions names one computer per plan; an update or software ring names up to 25.
- The RustDesk session check is made once, when a restart is scheduled, and sees RustDesk sessions only.
- A scheduled restart is reported as scheduled. Whether it happened is seen only from the next boot time.
- A compromised portal can delay, cancel or withhold delivery. It can't sign or alter a plan.
- Under a patch policy, the portal relays ring results to the signer. Results aren't signed by the agents yet, so
  forged results could start the next ring early. That ring still holds only what the policy allows.
- The signer is a single process with file state. Back up `/var/lib/rem0te-approver`; losing the key means
  generating a new one and publishing a new `approval/keys.json`. Plans signed by the old key are then refused.
- Roster membership is managed by the operator CLI. The portal neither shows nor changes it.
- The first agent download is trusted as downloaded, as for signed updates; there's no Authenticode signature yet.
