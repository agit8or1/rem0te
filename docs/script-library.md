# Script library

rem0te has a **script library**: PowerShell scripts that are written, versioned and reviewed in the portal. From
0.34, an **approved version can be run** on Windows computers, but only as a signed approved action
(`windows.script.run@1`) after three separate approvals: the library review, two approvers adding the version's
exact hash to the approval signer's own allowlist, and two approvers approving each run.

> **Not yet run on a real Windows computer.** The run path is tested end to end with the agent's real decision code
> and real PowerShell, but that is **PowerShell 7 on Linux**, not Windows PowerShell 5.1, through the simulator. The
> Windows job object, the SYSTEM context and Windows PowerShell's own behaviour haven't been run on a lab machine.
> See [What has been proven](#what-has-been-proven-and-what-hasnt).

## What this release does

| | |
|---|---|
| **Scripts** | Name, scope (**global**, set by a Platform Admin, or **one business**), and a list of versions |
| **Versions** | Immutable. Each holds the content, its SHA-256, description, language (PowerShell), target OS (Windows), risk level and declared parameters. Editing makes a new version; nothing changes a version once it is written, and the database refuses to change it too |
| **Review** | Draft → In review → Approved or Rejected. Approved and Rejected are final. The approver must be someone other than everyone who wrote the content, and must hold the review permission. Approving needs a fresh sign-in. The approval records the hash the reviewer saw |
| **Static checks** | Shown to the reviewer as warnings: `Invoke-Expression`, download-and-run, `-EncodedCommand`, credential material, disabling Defender, `Set-ExecutionPolicy`, restarts, hidden Unicode and more. They **flag**; they never block and never mean a script is safe |
| **Diff** | Any two versions of a script, line by line |
| **Running (0.34)** | An approved version's page has a **Run this version** panel: propose it to the approval signer's allowlist, then request runs on up to 25 Windows computers with typed arguments and a timeout. Results, with the exit code and redacted output, appear on each computer's **Actions** tab |
| **Audit** | Every create, submit, withdraw, approval, rejection and refused review attempt, every allowlist proposal and revocation, and every run (requested, approved, dispatched, result), with the hashes |

It doesn't schedule a script, run one on Linux or macOS, run one outside a plan, or collect more than 64 KB of output
per stream.

![The script library: the not-yet notice, the scope filter, a script and New script](screenshots/guide/script-library.png)

1. **The notice** — captured on 0.33, when it said running scripts was not available yet. From 0.34 the same
   notice says how an approved version runs, and that it has not run on a real Windows computer.
2. **Scope** — global scripts, or one business's.
3. **A script** — its latest version and review state.
4. **New script** — writes version 1 as a draft.

![A version in review: its card, its hash, the static checks, the content and Approve](screenshots/guide/script-review.png)

1. **Version 2** — in review, written by someone other than the reviewer, edited from v1. *Compare* below it shows
   any two versions line by line.
2. **Content SHA-256** — the hash an approval records. (Shown as a placeholder here: the capture masks every long
   hex string. The Review box repeats it in short form.)
3. **Static checks** — warnings for the reviewer; they flag, never block.
4. **The content** — exactly the bytes the hash is of.
5. **Approve** — offered only to someone who did not write the content, and it asks for a fresh sign-in.

## How a script runs

Only one way: as the catalog action `windows.script.run@1`, through the same chain that starts the Print Spooler,
installs Windows updates and runs the maintenance actions ([approved-actions.md](approved-actions.md)). There is no
second path. The portal holds no key the agent accepts.

1. **Library review.** An author writes a version; someone else with the review permission approves it with a fresh
   sign-in, over the hash they saw.
2. **Proposal to the signer's allowlist.** A reviewer (for a global script, a Platform Admin or independent reviewer)
   chooses **Propose to the approval signer**. The portal sends the signer the content, its declared parameters, its
   contributors and who reviewed it. The signer **hashes the content itself** and refuses the proposal if it isn't
   the SHA-256 the portal named.
3. **Allowlist approval, on the signer.** Two different people on the approval roster open the signer's page for the
   entry (`/approve/script/<id>` on the signer's origin). It shows **the content as the signer holds it**, the hash
   the signer computed, the arguments it accepts and who wrote it. Each approves with a passkey. Neither may be the
   person who proposed it, nor anyone who wrote or edited the content. After the second approval the entry is
   **ACTIVE**. The entry lives on the signer's disk, not in the portal's database.
4. **Run request.** A technician with `actions:request` on every computer named, who can also see the script in the
   library, picks up to 25 computers of one business, fills in the arguments, picks a timeout (1, 5, 10, 15 or 30
   minutes), gives a reason and confirms. The portal checks the version is approved, the entry is ACTIVE, the
   arguments match the declared parameters, a business's script names only that business's computers, and
   everything it checks for any action: scope, access level, containment, readiness, one open run per computer.
5. **Plan.** `windows.script.run@1` with closed parameters `{scriptVersionId, sha256, parameters, timeoutMinutes}`,
   and a `script` block the signer checks is **exactly** its allowlist entry (ids, hashes, declared parameters,
   contributors, reviewer). The content isn't in the plan; its SHA-256 is.

**Without an approval signer** (`APPROVAL_SIGNER_INTERNAL_URL` unset) the Run panel on an approved version says
scripts cannot be run on this server and offers no **Propose**, **Request a run** or **Revoke**: all three go through
the signer. That holds even when the portal's mirror last recorded the entry as ACTIVE — the panel still shows the
entry's state, but before 0.35 it also offered Request a run and Revoke beside the "cannot be run here" notice, and
both failed when used.
6. **Run approval, on the signer.** Always high risk: two different approvers, never the requester and **never a
   contributor** to the script (`contributor_cannot_approve`). The signer refuses the plan unless its allowlist entry
   is ACTIVE (`script_not_allowlisted`), not revoked (`script_revoked`), matches the plan's block (`script_mismatch`)
   and the arguments fit (`arguments_not_allowed`), and checks the entry again before it signs. The approval page
   shows the script from the signer's own copy.
7. **Delivery.** On its heartbeat the agent receives the envelope and, beside it, the content (base64). The portal is
   only a courier: the bytes come from the immutable version row, and the agent decides whether they are the right
   ones.
8. **Verification on the computer.** The agent checks the envelope as it checks every plan (key, signature, strict
   parse, target, window, build, approvals, journal, the signed pause), then:
   - the parameters are the closed four, the timeout is on the list, the plan's block names the same hash and
     version;
   - the declared parameters are well formed and **every argument fits them** (the same rule as the portal and the
     signer);
   - **no approver is a contributor**;
   - the delivered content is **exactly the signed length and SHA-256** (`content_mismatch` otherwise; nothing runs).
9. **Run.** The agent journals *executing*, then:
   - makes a fresh temporary folder, writes the script (`script.ps1`), the arguments as JSON (`params.json`) and a
     fixed wrapper (`run.ps1`);
   - starts `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy
     Bypass -File run.ps1`, as SYSTEM, in that folder, with `TEMP`/`TMP` pointing at it. The command line is constant:
     nothing from a plan is on it. The wrapper reads `params.json` with `ConvertFrom-Json` and calls the script with
     the values splatted (`& script.ps1 @bound`), so an argument is a value, never PowerShell;
   - on Windows the process runs inside a **job object** (started suspended, assigned, then resumed) with a 1 GiB
     memory limit for the whole job, so everything it starts is stopped with it;
   - at the timeout the agent terminates the job, the whole process tree, and reports **timed out**;
   - stdout and stderr: the first **64 KB** of each are kept and the rest counted, invalid UTF-8 is replaced, and both
     are **redacted** (user-profile paths, long tokens, `key=value` credentials, as for collected logs) before they
     leave the computer;
   - the exit code is recorded, the temporary folder is removed (and whether that worked is reported), and the result
     is journaled and reported once, like every action.
10. **Receipt.** The portal decodes the output, **redacts it again** with its own copy of the rules, caps it again,
    and stores it apart from the job (`ScriptRunOutput`). The job's own record keeps only a summary: exit code,
    whether it timed out, duration and byte counts.

**Full PowerShell, not Constrained Language Mode.** Many admin scripts need .NET and COM, so the script runs with
the full language, as SYSTEM. The timeout, the output caps, the temporary folder and the job object limit
accidents. They don't stop a script that means harm. The real control is the people who read the exact bytes before
anything is signed: one library reviewer, two allowlist approvers, two run approvers, none of them the author.

## Revocation

A reviewer chooses **Revoke from the allowlist** with a reason. The signer records the revocation **by content
SHA-256, write-once**: those exact bytes can never be allowlisted again, under any entry, even if the portal forgets
it revoked them. From then on the signer refuses every new run and every run not yet signed. A run already signed
can still be delivered inside its window; cancel it from the computer's Actions tab. To run a fix, edit it into a new
version and have that reviewed and allowlisted.

The signer's operator can do the same on the signer host:

```bash
S="sudo -u rem0te-approver env APPROVAL_SIGNER_DIR=/var/lib/rem0te-approver node /opt/rem0te-approver/dist/approval-signer/main.js"
$S script list                                   # every entry: id, status, content SHA-256, name and version
$S script revoke --id <entry id> --reason "why"  # one-way, by content SHA-256
```

There is no command, and no route, that adds or re-activates an entry. Entries are added only by two passkey
approvals on the signer's page.

## Output and retention

Each computer's **Actions** tab shows the run: the script's name and version, the exit code (or that it was stopped
at its timeout), how long it ran, and its output and errors, each the first 64 KB, redacted twice. Whoever can see
the job on that computer sees the output.

Output is kept **90 days**, then deleted by the script-output sweep (every six hours; `SCRIPT_OUTPUT_SWEEP=off`
stops it). The run itself, its status and its exit code stay; the page then says the output was pruned.

Redaction is pattern matching. A script that prints personal details in a form it doesn't recognise has them kept
for 90 days. Write scripts that print what the technician needs, not everything they can find.

## Why the portal can never run one directly

- **The portal holds no key the agent accepts.** The agent runs only plans signed by the approval signer's key,
  which it learns through the offline-rooted update chain. A portal, or someone holding its database, can mark a
  library version *Approved* or write an *ACTIVE* allowlist row. That gets them rows in tables, not a signature: the
  signer decides from its own entry, and refuses (`script_not_allowlisted`) a plan for an entry it doesn't hold.
- **The portal can't write the allowlist.** The signer's internal listener takes a proposal (always born *awaiting
  approval*), answers status, and takes a revocation. It has no route that approves, activates or edits an entry; a
  proposal under an existing id with different content is refused (`script_id_reused`).
- **The standard agent never executes.** The heartbeat agent (`heartbeat.ps1`) reports and reads. It only hands a
  delivered envelope and its content to the signed agent, which decides.
- **There's no other route for it.** The script-library module creates no `ActionJob` and reaches no dispatcher,
  signer or heartbeat. The only routes that touch running are the four of `/script-runs`, and a run is requested
  nowhere else: `POST /endpoints/:id/actions` with `windows.script.run` is `ACTION_NOT_DIRECT`. The security
  invariants (§14, §23, §39) check all of this in CI.

## Threat model

| Threat | What stops it | What doesn't |
|---|---|---|
| **A compromised portal or database** marks a malicious version *Approved*, writes an ACTIVE allowlist row, or swaps content after approval | The signer decides from its own allowlist, shows its approvers the content it holds and hashes it itself. The agent refuses bytes that don't match the signed hash and length. In the database, a trigger refuses any change to a version's content, hash, parameters, risk or author | The library's *Approved* flag and the portal's allowlist mirror. They're evidence, not a boundary against someone who owns the database |
| **Argument injection** (`x"; Remove-Item …`, `$(…)`) | Arguments are typed and checked against closed charsets by the portal, the signer and the agent. None admits a quote, `$`, a backtick, `;`, `|`, `&`, parentheses or a newline. They reach the script as JSON values splatted into parameters, never as command-line text | A script that itself passes an argument to `Invoke-Expression`. The static checks flag that; the reviewers decide |
| **A malicious author** hides harmful code in a useful script | A different person approves the version after reading it and the warnings; two more add it to the signer's allowlist after reading the signer's copy; two more approve each run. None of them may be a contributor | Static checks are pattern matches. Obfuscated code passes them. Approvers who don't read the script approve whatever is in it |
| **Self-approval** | Approval compares user ids. Contributors (the author of the version and of any unapproved version it was edited from) can't review it in the library, can't approve its allowlist entry, and can't approve a run of it. The agent checks the last again from the signed plan (`contributor_approved`) | Two separate accounts held by one human |
| **A runaway script** | The timeout kills the whole job object; the job's memory limit is 1 GiB; output is capped at 64 KB per stream; it runs in a fresh temporary folder that is removed afterwards | Anything a script does before the timeout. Full PowerShell as SYSTEM can do anything an administrator can |
| **Retracting a bad script** | Revocation is one-way and keyed by content hash on the signer | A run already signed and delivered before the revocation |
| **Cross-business access** | Every route resolves the business from the actor. Another business's script, run or computer is a 404. A business's script runs only on that business's computers | — |

## Who can do what

| | Business script | Global script |
|---|---|---|
| **See** | `scripts:author` or `scripts:review` in that business, a Business Owner, a Platform Admin | Platform Admins and independent reviewers (`approvals:review`) see every version; a business's authors and reviewers see approved versions only |
| **Write, edit, submit, withdraw** | `scripts:author` (a Business Owner holds it) | A Platform Admin |
| **Approve, reject** | `scripts:review`, and not a contributor | A Platform Admin or an independent reviewer, not a contributor |
| **Propose to the signer, revoke** | `scripts:review` | A Platform Admin or an independent reviewer |
| **Request a run** | Library visibility **and** `actions:request` (higher risk) on every computer named, of that business | Library visibility and `actions:request` on every computer named, of one business |
| **Add to the allowlist, approve a run** | Two people on the approval signer's roster for that business, not the proposer or requester, not a contributor | Two roster approvers for every business (`*`) |

A technician working in a business through an assignment needs the capability on a grant that covers the **whole
business**. A grant for named computers doesn't confer library rights, because a script isn't scoped to a computer.
A preset-backed grant takes its capabilities from the preset, and no preset grants library rights.

## Parameters

A version declares up to 10 parameters, each with a name, a type and limits:

| Type | Limits |
|---|---|
| `string` | A **charset** (`alphanumeric`, `identifier` `[A-Za-z0-9_.-]`, `hostname` `[A-Za-z0-9.-]`, `safe_text` letters, digits, space and `_.,:@-`) and a maximum length (1–256) |
| `integer` | Minimum and maximum (32-bit) |
| `boolean` | — |
| `choice` | 1–20 fixed values, each an identifier |

Charsets are a closed list, not author-supplied regular expressions, so the portal, the signer and the agent
(TypeScript and Go) apply exactly the same rule. Every argument key must be declared (exact name), every required
parameter present, and nothing is coerced: `"5"` is not an integer.

## Hashes

- **Content SHA-256**: SHA-256 of the exact UTF-8 bytes of the script. What the agent verifies before running. Line
  endings aren't normalised, so what's hashed is what's shown and what runs. Content is 1 byte to 64 KiB; a NUL or
  other control character (except tab, CR and LF) is refused.
- **Definition SHA-256**: SHA-256 of `rem0te-script-definition-v1\n` followed by canonical JSON of the language,
  target OS, risk, parameters and content SHA-256. What the allowlist approvers' passkeys sign over, and what the
  plan's script block carries.

## Static checks

Each rule is a pattern with a severity (`caution` or `danger`) and a reason, reported per line. They catch the
obvious and help a reviewer find the lines worth reading. **No warnings doesn't mean safe.** The list:

| Rule | Severity |
|---|---|
| `Invoke-Expression` / `iex` | danger |
| Download (`Invoke-WebRequest`, `Invoke-RestMethod`, `Net.WebClient`, `DownloadString`, BITS, `certutil -urlcache`) | danger |
| `-EncodedCommand` / `FromBase64String` | danger |
| Credential material (plaintext `SecureString`, password literals, private-key blocks, LSASS, `mimikatz`, `cmdkey`) | danger |
| Disabling Defender (`Set-MpPreference -Disable…`, exclusions, stopping `WinDefend`) | danger |
| `Set-ExecutionPolicy`, `-ExecutionPolicy Bypass` | danger |
| Restart or shutdown (`Restart-Computer`, `Stop-Computer`, `shutdown /r`) | caution, or danger when forced |
| Clearing event logs or audit policy | danger |
| Deleting shadow copies or backups | danger |
| Adding local administrators | danger |
| Loading code at runtime (`Add-Type`, `[Reflection.Assembly]::Load`, `Invoke-Command`, `Start-Process`) | caution |
| Hidden Unicode (bidirectional overrides, zero-width characters, BOM inside the text) | danger |
| Declared risk *low* with a danger finding | caution |

The signer doesn't run its own static checks; its approvers read the content on the signer's page.

## Refusals

| Where | Code | Meaning |
|---|---|---|
| Portal | `NOT_APPROVED` | The version isn't approved in the library |
| Portal | `NOT_A_REVIEWER` | Proposing or revoking needs the review permission (global: Platform Admin or independent reviewer) |
| Portal | `SCRIPT_NOT_ALLOWLISTED` | The version has no ACTIVE entry on the signer's allowlist |
| Portal | `SCRIPT_REVOKED` | The version's content was revoked; propose a new version |
| Portal | `PARAMS_NOT_ALLOWED` | The arguments don't fit the declared parameters, or the timeout isn't on the list |
| Portal | `SCRIPT_WRONG_BUSINESS` | A business's script named another business's computer |
| Portal | `ACTION_NOT_DIRECT` | A script run was requested from the Actions tab route |
| Portal | `ENDPOINT_NOT_READY` | The computer's agent doesn't report `windows.script.run@1` (a signed agent from 0.34 on) |
| Signer | `hash_mismatch`, `script_id_reused`, `script_revoked` | On a proposal |
| Signer | `contributor_cannot_approve`, `requester_cannot_approve`, `already_decided`, `not_authorized` | On an allowlist or run decision |
| Signer | `script_not_allowlisted`, `script_revoked`, `script_mismatch`, `arguments_not_allowed` | On a run plan (admission and signing) |
| Agent | `script_missing`, `script_mismatch`, `bad_declarations`, `arguments_not_allowed`, `contributor_approved`, `no_content`, `content_mismatch` | Refused before anything runs |
| Agent | `no_script_host` | An agent built without the script runner |
| Agent result | `succeeded` (exit 0), `failed` / `exit_code`, `timed_out`, `failed` / `start_failed`, `failed` / `workdir_failed` | After it ran |

An agent that stops while a script is running reports the run **uncertain** on its next start and never runs it
again. Reconcile it on the computer's Actions tab before requesting another run there.

## Upgrading to 0.34

- Migration `0050_script_run` adds the allowlist mirror and run output tables.
- **Signer:** rebuild and redeploy the approval signer (`apps/api/scripts/build-approval-signer.mjs`); it creates
  `scripts/` and `script-revocations/` in its directory. Its roster is unchanged; allowlist approvers are the roster's
  approvers.
- **Agents:** a computer is offered script runs only once it runs a 0.34 signed agent build that reports
  `windows.script.run@1`.
- Nothing runs until a reviewer proposes a version and two approvers add it on the signer.

## What has been proven, and what hasn't

| Level | State |
|---|---|
| **Fixture-tested** | Go tests in `internal/action` cover every refusal (hash mismatch, wrong length, injection, undeclared or mistyped arguments, author as approver, missing content, no host, the signed pause), at-most-once, interruption, exit codes, the timeout and the output cap. `unit-script-run.mjs` covers the argument rule against the same table as the Go tests, the shared plan rule and the portal's second redaction. `unit-approval-signer.mjs` covers the allowlist: the signer's own hash, two distinct approvals, proposer and contributors refused, global scripts, revocation by content hash, runs refused unless ACTIVE and exact |
| **Real PowerShell, not Windows** | The Go tests and `e2e-script-run.mjs` run scripts under **PowerShell 7 on Linux** through the agent's real decision code: arguments arrive as data (a hostile `$(...)` is never evaluated), the timeout kills the whole process group, output is capped and redacted. The e2e runs the full path: library review, proposal, two passkey approvals on the signer, a run on two computers, delivery, verification, execution, double redaction, the device history, revocation, business isolation and the 90-day prune |
| **Real Windows** | **Not done.** Windows PowerShell 5.1, the SYSTEM context, the job object (suspended start, memory limit, kill on timeout) and `%SystemRoot%` paths are compiled and vetted for Windows but have not run on a Windows computer |
| **Production-ready** | **No.** It needs a paired lab run on real Windows first |
