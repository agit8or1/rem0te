# Approved actions

rem0te 0.26 can make one change on a customer computer outside a remote session: **start the Windows Print Spooler,
once**. It happens only after people on an approval roster have authorized that exact plan with a passkey, on a page
the portal does not serve, and only on a computer whose agent checks all of it again before anything runs.

From 0.27 the catalog has a second action, **installing named Windows updates**, which is requested only through a
staged deployment of a canary and rings. See [Staged patching](staged-patching.md). The rest of this page describes
the Print Spooler action, and the machinery both actions share.

That is the whole catalog. You can't request a command, a script, a path, a URL, another service, or a change to the
spooler's startup type. Credential extraction, removing backups, disabling defenses, granting admin rights and wiping
disks aren't in the catalog and never will be. They aren't switched off; nothing exists to request them.

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

## Setting it up

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
| `PARAMS_NOT_ALLOWED` | The parameters aren't the catalog's (another service, an extra field) |
| `ACTION_NOT_GRANTED` | Your role or access level doesn't include requesting this, on this computer |
| `PROTECTED_DEVICE_CLASS` | The computer is a protected class |
| `ENDPOINT_NOT_READY` | No enrolled identity, a legacy agent, an agent that doesn't report the action, or a build other than the published one |
| `ACTION_PENDING` | An earlier request on this computer is still unresolved |
| `ACTION_UNRECONCILED` | An earlier outcome is uncertain. Reconcile it first |
| `APPROVAL_SIGNER_ERROR`, `APPROVAL_SIGNER_REFUSED`, `APPROVAL_SIGNER_UNREACHABLE` | The signer didn't answer, or refused the plan (e.g. `policy_mismatch` after a policy change) |

Agent refusal reasons: `bad_signature`, `unknown_key`, `bad_plan`, `job_mismatch`, `not_signed`, `unknown_action`,
`params_not_allowed`, `bad_targets`, `wrong_target`, `not_yet_valid`, `expired`, `artifact_mismatch`,
`risk_understated`, `too_few_approvals`, `requester_approved`, `no_customer_signoff`.

## What has been proven, and what hasn't

| Level | State |
|---|---|
| **Fixture-tested** | Yes. `internal/action` Go tests cover every refusal, replay, crash and verification path. `unit-approval-signer.mjs` (64 checks) covers synthetic passkeys through the real WebAuthn verification: forged origin and RP ID, missing user verification, reused and cross-decision challenges, counter regression, the requester approving, quorum, customer sign-off and restart. `e2e-approved-action.mjs` (76 checks) runs the portal, the signer and the agent's real decision code against a simulated Windows, including the compromised-database envelopes |
| **Paired lab** (real Windows workstation, real authenticator, real ClientSt0r) | **Not done.** The Windows calls (service control manager, registry product type, `rustdesk --get-id`) are compiled and vetted for Windows but haven't run on a lab machine |
| **Production-ready** | **No.** It needs the paired lab first, and an operator who has done the key and roster ceremonies |

## Known limits

- Two actions, on Windows only. The Print Spooler start names one computer per plan; an update ring names up to 25.
- A compromised portal can delay, cancel or withhold delivery. It can't sign or alter a plan.
- The signer is a single process with file state. Back up `/var/lib/rem0te-approver`; losing the key means
  generating a new one and publishing a new `approval/keys.json`. Plans signed by the old key are then refused.
- Roster membership is managed by the operator CLI. The portal neither shows nor changes it.
- The first agent download is trusted as downloaded, as for signed updates; there's no Authenticode signature yet.
