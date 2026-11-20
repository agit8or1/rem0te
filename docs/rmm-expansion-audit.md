# RMM expansion audit (0.73.2)

This page audits the owner's *Full RMM Functionality Expansion* directive (2026-11-20) against what Rem0te
does at **0.73.0** (main `3554921`), then puts the work in order. It is a planning record: it adds no
feature, and nothing on it is a promise that something works. Each claim below was checked against source,
migrations, tests and feature flags, not against older planning pages. Where those pages disagreed, this page
follows the code and lists the correction at the end.

Two pull requests are in flight as this is written. They are shown as **In progress** under
[Related work](#related-work-remote-access-and-the-portal-host), and nothing here touches their files:

- **#183, 0.73.1**: wire fixtures for the standard Windows, Linux and macOS agents. Heartbeat and command-result
  bodies per released version are replayed against the new API ([compatibility.md](compatibility.md), *What is
  not covered yet*).
- **#185, 0.74.0 *Bastion***: *Admin → Security* rewritten as a posture page for the **portal host** (SSH, ufw,
  ports, OS updates, fail2ban, TLS and headers, MFA coverage, API keys, audit chain, off switches), where an
  unreadable check is Unknown, never OK. It is not endpoint security posture: the directive's Security group
  for computers is still Missing below.

**0.73.0 *Warden*** (#184, merged) finished Managed Secure Access step 5: Connect through grants, revocation,
session evidence, and cutover runs for a group or a business. All of it is behind `MSA_GRANTS`, which is off
([managed-secure-access.md](managed-secure-access.md)).

## How to read the matrix

**Status**

| Status | Meaning |
|---|---|
| **Existing** | Built end to end (API, UI, permissions, audit, tests). Says nothing about real hardware. |
| **Partial** | Some of it is built. The *Gap* column says what is missing. |
| **Missing** | Nothing is built. |
| **Planned** | Not built, but already decided or designed in an earlier owner decision or design page. |
| **In progress** | On a branch now. |

**Evidence** is the strongest level the feature has, on the ladder in [readiness.md](readiness.md#evidence-levels):

**Lab** > **Fleet** > **Runner** > **Sim** > **pwsh** > **API** > **Unit** > None.

Only **Lab** and **Fleet** count as *tested on real hardware*. Lab here always means GitHub's `windows-latest`
runner, which is **Windows Server 2025**, signed in as an elevated administrator unless the row says SYSTEM. It is
never a Windows 10/11 desktop ([lab-testing.md](lab-testing.md#what-it-cannot-prove)). Fleet means the four
production Windows computers ([readiness.md](readiness.md#the-production-fleet)), seen working, not tested under
control.

## Summary

| Status | P0 | P1 | P2 | All |
|---|---|---|---|---|
| Existing | 26 | 19 | 0 | 45 |
| Partial | 26 | 15 | 0 | 41 |
| Missing | 21 | 20 | 0 | 41 |
| Planned | 3 | 0 | 6 | 9 |
| In progress | 0 | 0 | 0 | 0 |
| **Rows** | 76 | 54 | 6 | 136 |

Many P0 rows are single checks from the built-in library list. Most *Existing* P0 rows exist **outside** a
script library (as a diagnostic, a monitor or a signed action), which is why the library itself is Missing.

No directive row is *In progress*: neither in-flight pull request delivers a directive item. The two are
listed under *Related work*, with Managed Secure Access, which this audit does not count in the totals above.

**P0 in one line each**

- **Remote scripting UI**: Partial. Runs, scheduling, typed arguments and per-computer results exist on the
  signed path. Missing: targets bigger than 25 named computers, concurrency and rate limits, searchable
  history, cancelling a running script, and notifications outside the console.
- **PowerShell 5.1 / 7**: Partial. Only System32 Windows PowerShell 5.1, only as SYSTEM, with a fixed list of
  timeouts. Interpreter reporting and selection, and run-as, are decided (2026-11-16) but not built.
- **Remote PowerShell read-only palette**: Partial. The closed, read-only diagnostics catalog (12 checks, Fleet
  evidence) exists. There is no palette and no parameterised command. No interactive terminal, by design.
  *Update, 0.76.0:* thirteen more read-only checks in Security, Networking and Maintenance groups, typed
  parameters for a DNS lookup and a TCP port test, per-finding states — **Lab (Windows Server) only**; no desktop
  or fleet evidence yet.
- **Built-in reviewed library**: Missing as a library. About half the listed checks exist elsewhere as
  diagnostics, tray self-help, signed actions or monitors. The security posture reads and SFC/DISM, gpupdate,
  time sync and activation are missing.
- **Device Tools / Quick Actions**: Partial. Six of the eight groups exist as device tabs. Security is missing
  and Scripts is not on the device page. Only the Actions tab shows *needs a newer agent*.
- **Alert-based automation**: Missing. The pieces exist: monitor cooldowns, hysteresis, maintenance windows,
  escalation, PSA auto-tickets, and signer-approved automation policies. Nothing connects an alert to an action
  (`apps/api/src/monitoring` imports no `ActionsService`).

## Matrix: P0

### Remote scripting UI

| Item | Status | Evidence | Where | Gap |
|---|---|---|---|---|
| Run an approved script on one computer | Existing | Lab (agent exec under PS 5.1, admin); Sim end to end | `POST /script-runs`, `script-run.service.ts`, Run panel on `/automation/scripts/[id]`; §39 | Never run on the fleet, never as SYSTEM in the lab |
| Targets: named computers | Existing | Sim | `SCRIPT_RUN.maxTargets` = 25, one business per plan | — |
| Targets: device group | Partial | Sim | Automation schedules only (`group_members`, cap 25 per run; §71) | No one-off run on a group |
| Targets: site or business | Missing | — | — | Only §73 restart windows target a whole business |
| Bulk with concurrency and rate limits | Missing | — | One open run per computer; §35 bulk is ≤ 200 for four repeatable actions | No fan-out over 25, no per-business concurrency, no computers-per-minute pace |
| Run now or scheduled | Existing | Sim | `notBefore` ≤ 14 days (`common/schedule.ts`, §65); recurring via §71 | — |
| Per-computer progress | Existing | API, Sim | `ActionTarget` per computer, `GET /tasks`, `/endpoints/:id/tasks`, `tasks/lifecycle.ts` (§65) | — |
| stdout, stderr, exit code, duration | Existing | Lab (capture and cap under PS 5.1); Sim | `ScriptRunOutput`, 64 KB a stream, redacted on the agent and again in the portal, 90-day prune | — |
| Searchable history | Partial | API | *Automation → Tasks* filters state, type and business; the device Actions tab | No text search over script, requester, exit code or output |
| Cancel | Partial | Sim | `POST /actions/:id/cancel`: scheduled or awaiting approval, nothing delivered | No cancel once delivered; only the timeout stops a running script |
| Finish notifications | Partial | API, browser | `TaskWatcher` toast and top-bar count (0.52) | No email, webhook or PSA note when a run finishes |
| Buttons that know what the computer can do | Partial | API, browser | `endpoint-actions.tsx` checks `agentActions`; Run panel hidden without a signer; `ENDPOINT_NOT_READY` | No single per-tool state on the device page |
| On the existing signed action path | Existing | Sim | §14, §39, §52, §58 | — |

### PowerShell

| Item | Status | Evidence | Where | Gap |
|---|---|---|---|---|
| Detect and report PS 5.1 and 7 | Planned | — | Owner decision A1 ([implementation-status.md](implementation-status.md#owner-decisions-2026-11-16)) | No heartbeat field; no agent code reads `$PSVersionTable` or finds `pwsh.exe` |
| Choose the interpreter | Planned | — | A2: `windows.script.run@2` | `scriptexec.go` runs System32 `powershell.exe` only |
| Timeouts bounded by policy | Partial | Unit, Sim, Lab (timeout kill) | `TIMEOUT_MINUTES = [1, 5, 10, 15, 30]` (`actions/script-run.ts`), the same on signer and agent | Fixed list, 30 minutes at most, not set per policy. SFC/DISM need longer |
| Run as SYSTEM or an unprivileged account | Partial | Lab (admin, not SYSTEM); Sim | SYSTEM only | The decided `root` / `unprivileged` declaration per version is not built. The lab never ran a script as SYSTEM |
| Typed parameters | Existing | Unit, Sim, Lab (arguments arrive as data) | 10 parameters, closed charsets, the same in TS and Go (§39) | — |
| Cancellation (stopping the process tree) | Partial | Lab | Job object killed at the timeout (`TestLabPS51TimeoutKillsTheTree`) | No operator cancel of a running script |
| Report that a restart is needed | Missing | — | Only `windows.update.install` reports `restart_required` | No pending-reboot check after a script |
| `windows.script.run@1` stays compatible | Partial | Sim (current agent only) | `scripts/compat/supported-agents.json` | **The compatibility suites leave out `script-run`.** Older agents' script path is untested against new servers |

### Remote PowerShell

| Item | Status | Evidence | Where | Gap |
|---|---|---|---|---|
| Read-only diagnostics command palette | Partial | Fleet (the 12 diagnostics); Lab, Windows Server (the 0.76 palette); pwsh | `diagnostics-catalog/catalog.ts`: 25 closed, read-only checks in groups, typed DNS / TCP parameters (0.76); *Diagnostics* tab | Startup apps; a Windows 10/11 desktop run (Defender, BitLocker and TPM differ from Server); fleet evidence |
| Interactive terminal | Missing | — | — | Deliberately not built. Needs its own threat model first (conflict 6 below) |

### Built-in reviewed script library

| Category | Status | Evidence | What exists today | Gap |
|---|---|---|---|---|
| The library itself (categories, shipped reviewed scripts) | Missing | — | User-written scripts only. `ScriptVersion` has no category, and nothing ships | Seeded global versions, a category field, a browser |
| **Network**: flush DNS | Partial | Sim | Tray self-help *flush DNS* (signed agent, SYSTEM; §55) | Not a technician tool |
| ipconfig | Partial | Fleet | `network_adapters` snapshot; tray `net.details` | — |
| DNS resolution test | Partial | Fleet | `dns_resolution` diagnostic (fixed names) | Name not chosen by the technician |
| TCP test | Partial | Fleet | `network_connectivity` (to the portal only) | Host and port not chosen |
| Adapters, routes, gateway | Partial | Fleet | Network tab: adapters, gateway, DNS, DHCP | No route table |
| Safe DHCP renew | Partial | Sim | Tray self-help *renew IP* | Not a technician tool |
| **Windows maintenance**: gpupdate | Missing | — | — | — |
| Windows Update status and scan | Existing | Fleet (218 scans) | `UPDATE_SCAN`, `pending_updates`, Patches tab | — |
| Pending reboot | Existing | Fleet | `reboot_status`, `REBOOT_PENDING` monitor | — |
| SFC / DISM | Missing | — | — | Needs timeouts above 30 minutes |
| Services | Existing | Fleet | Services tab snapshot | — |
| Scheduled tasks | Missing | — | — | — |
| Restart approved services | Existing | Lab (`windows.service.control`); Sim (`windows.service.restart`) | `RESTARTABLE_SERVICES` allowlist (§32), service control (§61) | — |
| **Security**: Defender status | Missing | — | — | — |
| AV definition age | Missing | — | — | — |
| Firewall profiles | Missing | — | — | — |
| BitLocker | Missing | — | — | — |
| Secure Boot / TPM | Missing | — | — | — |
| Local administrators | Missing | — | Static checks flag *adding* one as danger | No read |
| Unsupported OS | Partial | Fleet | OS and build inventoried | No end-of-support judgement |
| **Troubleshooting**: failed updates | Existing | Fleet (2 alerts) | `UPDATE_FAILED` monitor, signed patch history | — |
| Logs | Existing | Fleet (event log query); Sim (`windows.logs.collect`) | Event Log tab, log collection action | — |
| High-resource processes | Existing | Fleet | `top_processes`, Processes tab | — |
| Unexpected shutdowns / BSOD | Partial | Fleet (EVENT_MATCH in general) | Only an `EVENT_MATCH` rule someone writes by hand | No built-in Kernel-Power 41 / BugCheck rule or view |
| Disk health | Partial | Fleet | `disk_space`, disk-error events (§78) | No SMART or wear data |
| Spooler and print queues | Partial | Sim | `windows.service.start` (Spooler) | No queue view or clear |
| Time sync | Missing | — | — | — |
| Activation | Missing | — | — | — |
| **Software**: installed versions | Existing | Fleet | Inventory, change history | — |
| Outdated approved apps | Existing | API | Version compliance report: compliant, outdated, missing, unknown ([software-deployment.md](software-deployment.md)) | — |
| Verify an install | Existing | Sim | Agent detects before and after (`effective`) | — |
| Catalog install and remove | Existing | Fleet (1 removal); Sim (install) | §40, §59 | winget install never run on a real computer |

### Device Tools / Quick Actions

| Group | Status | Evidence | Where | Gap |
|---|---|---|---|---|
| Diagnostics | Existing | Fleet | Diagnostics tab | — |
| PowerShell / Scripts | Partial | Sim | Run panel on the library page | Not offered from the device page |
| Services & Processes | Existing | Lab (agent); Sim | Services and Processes tabs (§61) | — |
| Software | Existing | Fleet (removal) | Software tab | — |
| Windows Updates | Existing | Fleet | Patches tab | — |
| Networking | Partial | Fleet | Network tab (read-only) | No actions (DNS flush, DHCP renew for technicians) |
| Security | Missing | — | — | No posture data to show (see P1 Health) |
| Maintenance | Existing | Sim | Actions tab: restart schedule and cancel, log collection, service restart | Never run on the fleet |
| Per-tool state: available, needs approval, needs a newer agent, unsupported OS | Partial | API | `agentActions` per catalog action; *Needs a newer agent* on specs | No state per tool across the groups. Pooled (§70), containment and signer-missing reasons are spread across tabs |

### Alert-based automation

| Item | Status | Evidence | Where | Gap |
|---|---|---|---|---|
| Trigger → investigation → approved action → verification | Missing | — | — | No code path from an alert to a plan |
| Cooldowns, hysteresis | Partial | API | Monitor engine (notifications) | Not for actions |
| Retry limits | Partial | Sim | Signer `restart_retry_limit`, `ring_retry_limit`, automation `occurrence_run_limit` | Not for remediation |
| Budgets per computer and business | Partial | API | `PSA_AUTO_TICKETS_PER_HOUR` per business (§68) | Not for actions |
| Maintenance windows | Existing | API | `MonitorSuppression` (holds notifications only, kept apart from containment) | — |
| Auto-stop | Missing | — | — | — |
| Escalation | Existing | API | 4-level escalation; PSA auto-tickets (§68) | — |
| Dry run | Missing | — | — | — |
| History | Missing | — | — | — |
| Only under narrow signer-approved policies | Planned | — | Phase 2b ([implementation-status.md](implementation-status.md#plan)); §71 is the model | Signer document type not designed |
| AI recommends, never authorizes | Existing (as a rule) | Unit, API | §41: AI only explains; ClientSt0r `ai_suggestion` proposals need a person | — |

## Matrix: P1

### Health

| Item | Status | Evidence | Where | Gap |
|---|---|---|---|---|
| SMART / NVMe wear | Partial | Fleet (events) | Disk-error events (§78) | No `Get-StorageReliabilityCounter` |
| Temperatures | Missing | — | — | Windows has no reliable temperature source without vendor tools. Expect *Unsupported* on most computers |
| SSD endurance | Missing | — | — | — |
| Battery | Missing | — | — | macOS `pmset` is outside §32 |
| Secure Boot / TPM / BitLocker | Missing | — | — | — |
| Defender / AV | Missing | — | — | — |
| Firewall | Missing | — | — | — |
| Unexpected reboots / BSOD | Partial | Fleet | Hand-written `EVENT_MATCH` | No built-in rule |
| Expiring certificates | Missing | — | — | — |
| Latency / packet loss | Partial | Fleet | On-demand latency to the portal | No targets, no history |
| DNS / gateway | Partial | Fleet | Network tab, `dns_resolution` | No monitor |
| Disk growth and time to full | Partial | Fleet (history) | `metrics/`: 48 h raw, 90 d hourly | Nothing reads history to predict (`DISK_FREE` judges each reading alone) |
| Backup agent health | Missing | — | `SERVICE_STOPPED` / `EVENT_MATCH` could watch a backup agent's service | No templates |
| States: Healthy, Warning, Critical, Unknown, Stale, Unsupported, with evidence times | Partial | API, browser | 0.68 device-list Health (Healthy, Warning, Issues, Unknown); patch evidence fresh / stale / unknown; MSA readiness *Unsupported* | No one state model with an evidence time per signal |

### Third-party patching

| Item | Status | Evidence | Where | Gap |
|---|---|---|---|---|
| Detect outdated apps | Partial | API | Compliance for catalog entries only; winget index (`winget-index.ts`, §59) | No "everything outdated" view from inventory against the index |
| Vulnerability (CVE) correlation | Missing | — | — | No feed |
| Approved sources | Existing | Sim | winget only, `--source winget` (§40) | — |
| Pinned digests | Existing | Sim | Installer SHA-256 checked by the agent (§40) | — |
| MSI / EXE catalog | Missing | — | Deliberately no upload route (§40) | Conflict 9 below |
| Detection rules | Partial | Sim | winget's own detection | No custom rules (file version, registry) |
| Silent install reporting | Existing | Sim | Agent result per computer | — |
| Restart detection | Existing | Sim | winget exit codes `0x8A150109` / `0x8A15010A` (`software.go`) | — |
| Canary and staged | Existing | Sim | Rings ≤ 25, canary of one (§40, §75) | — |
| Approval and exclusion per business | Existing | Sim | Catalog per business; §58 direct mode per business | — |
| Verification | Existing | Sim | Detection after (`effective`) | — |
| Compliance reports | Existing | API | Software compliance report, CSV | — |
| Retries | Partial | Sim | Re-request by hand | No automatic retry |
| Co-existing with Intune / WSUS / ConfigMgr | Existing | Sim; Lab (WSUS policy read) | `managed_elsewhere` (§40); patch manager detection | — |

### Endpoint administration

| Item | Status | Evidence | Where | Gap |
|---|---|---|---|---|
| Scheduled tasks | Missing | — | Only `retire.go`'s exact-name removal (§64) | — |
| Local users and groups | Missing | — | — | — |
| Startup apps | Missing | — | — | — |
| Signed-in sessions | Partial | Fleet | Console user (`Win32_ComputerSystem.UserName`); RustDesk `--cm` count | No `quser` list of every session |
| Service recovery settings | Missing | — | §61: nothing carries a recovery action | Conflict 8 below |
| Restart | Existing | Sim | `windows.reboot.schedule` / `.cancel`, restart windows (§67, §73) | Never restarted a real computer |
| Shutdown | Missing | — | — | New catalog action |
| Wake-on-LAN relay | Missing | — | — | Needs a peer agent on the same LAN |
| Command history | Existing | API | History and Actions tabs, audit chain | — |

### Operations

| Item | Status | Evidence | Where | Gap |
|---|---|---|---|---|
| Policy inheritance | Existing | API | computer > group > site > business > global (§46, §53, §73) | — |
| Dynamic groups | Existing | API | Rule groups (§35) | — |
| Bulk preview and target count | Partial | API | Automation `POST /automation/schedules/preview`; bulk refuses over 200 | No preview before a bulk action |
| Retry a failed job | Missing | — | — | No *retry* on a task; a person requests again |
| Technician notes | Existing | API | `notes/`, device notes (0.68) | — |
| Maintenance mode | Existing | API | Maintenance windows (`MonitorSuppression`) | — |
| Customer preferences and service windows | Partial | Sim | Restart windows and patch windows per business | No customer-facing preferences |
| Technician task queue | Partial | API | `GET /tasks/mine`, support-request queue | No assigned work queue |

### Backup monitoring

| Item | Status | Evidence | Where | Gap |
|---|---|---|---|---|
| Provider integrations | Missing | — | `PsaDriver` connector pattern, `secret-box`, `safe-https` can be reused | — |
| Backup job monitor kinds | Missing | — | — | — |

### ClientSt0r contract

Everything here is held back by one fact: **Rem0te does not interoperate with the real ClientSt0r**. ClientSt0r
signs with HMAC and the contract uses Ed25519 ([readiness.md](readiness.md#capability-matrix)). The strongest
evidence possible is API, against the reference peer.

| Item | Status | Evidence | Where | Gap |
|---|---|---|---|---|
| Tickets from alerts | Existing | API (reference peer, stub PSA) | `alert.raised`, `POST …/:alert_id/ticket`; native PSA auto-tickets (§68) | Not against real ClientSt0r |
| Ticket ↔ computer links | Existing | API | `PsaTicket`, `MonitorAlertTicket` | — |
| Computer details in tickets | Partial | API | `alert.patch_summary` (revision 2) | P10 `computers/{id}/summary` agreed, not built |
| Actions and results in tickets | Existing | API | `jobs/:job_id/events` | — |
| Request predefined actions from a ticket | Partial | API | `action-proposals`: only Spooler start and update install (`integration: true`) | Ten actions are `integration: false`. Conflict 4 below |
| AI-suggested scripts never bypass the signer | Existing (as a rule) | Unit | `ai_suggestion` proposals need a person; scripts are not proposable | — |
| Interoperate with the real ClientSt0r | Missing | — | — | HMAC vs Ed25519 |

## Matrix: P2

| Item | Status | Evidence | Where | Gap |
|---|---|---|---|---|
| Windows PowerShell | Planned | — | A2 `windows.script.run@2` | — |
| Windows CMD | Planned | — | Not in A1–A5; fits as an interpreter of `@2` | A decision: interpreter or separate action |
| Linux reviewed shell (ported Go agent) | Planned | — | Design A, A3 `linux.script.run@1` | No Linux build of `rem0te-agent` |
| macOS reviewed shell | Planned | — | A4, ad-hoc signed, no Apple Developer account | — |
| Old POSIX agents stay read-only | Planned (kept) | API | §24, §32 unchanged | — |
| Remote file manager | Planned | — | Design B: a time-boxed file-session grant signed by the signer; browser-signed operations; end-to-end encryption to the browser key; delete into a 7-day trash on the computer; a tray notice while a session is open; B1–B4 | `fileTransfer` policy accepts only `off` |

## Related work: remote access and the portal host

These rows are not directive items and are not in the counts. They matter to it in three ways:

- Grants are the pattern the file manager (Design B) and any interactive tool would follow.
- *Session evidence* is what an audited remote PowerShell would need.
- Compatibility testing gates every agent build in the P0 sequence.

| Item | Status | Evidence | Where | Gap |
|---|---|---|---|---|
| MSA readiness: RustDesk preflight, per-computer state | Existing | Lab (Server, as SYSTEM); API | §80, `msa/readiness.ts` | Not seen on the fleet |
| MSA grants and the long-poll channel | Existing, behind `MSA_GRANTS` (off) | Unit, API | §81 (0.71) | Off in production |
| MSA enforcement, the managed test session, one-computer cutover and rollback | Existing, behind `MSA_GRANTS` (off) | Lab (`TestLabRustdeskEnforce`, admin and SYSTEM, RustDesk 1.4.1–1.5.3) | §82 (0.72) | No desktop, no real connection |
| MSA Connect through grants (view-only and consent enforceable on a managed computer) | Existing, behind `MSA_GRANTS` (off) | API; Lab (enforcement only) | §83 (0.73), `POST /msa/sessions/connect/:endpointId` | Never with a real technician connecting through RustDesk |
| MSA revocation (ending a session from the console) | Existing, behind `MSA_GRANTS` (off) | API; Unit (agent) | §83 (0.73) | Never on a real session |
| MSA session evidence (agent-reported start, end, peer) | Existing, behind `MSA_GRANTS` (off) | API | §83 (0.73) | Never on a real session |
| MSA cutover runs for a group or business | Existing, behind `MSA_GRANTS` (off) | API | §83 (0.73) | — |
| Wire-fixture compatibility for standard and POSIX agents | In progress | — | #183 (0.73.1) | — |
| Portal host security posture (*Admin → Security*) | In progress | — | #185 (0.74.0 *Bastion*) | Host, not endpoints |

## Conflicts with existing invariants

Each of these is where the directive's wording assumes something an invariant forbids. *Owner decision* means
an invariant would have to be reversed, as §41, §62, §67, §75 and §76 were. *Design* means it can be built
without relaxing anything.

| # | Directive assumes | Invariant | Resolution |
|---|---|---|---|
| 1 | **One-click** built-in scripts | §39: library review, then two passkey approvals on the signer's allowlist, then two approvers per run, none of them a contributor | **Design** for read-only checks: put them in the diagnostics catalog. It is closed, portal-side and already used on the fleet, so no signer is involved. **Design** for the rest: ship them as reviewed global versions that still go through the allowlist. Under §58 direct mode that is one fresh sign-in, so it is already one click for a single operator. A lighter approval tier for "read-only scripts" would be **owner decision**, and it is hard to prove a script is read-only |
| 2 | Bulk scripts on groups, sites or businesses | §39: ≤ 25 named computers of one business per plan. §71: the signer cannot see a group and holds it only to a business and cap. §35: bulk ≤ 200 | **Design**: resolve the target when the request is made, fan out into ≤ 25-computer plans, and approve once with a one-off automation document (a new closed `once` recurrence). Signer change, agent unchanged |
| 3 | Cancel a running script | Agents run only what the signer signs. The portal has no channel to a running job | **Design**: an agent-side stop for an `executing` job. **Owner decision** on who may stop one: portal-authenticated (a compromised portal can only stop things) or signed like the pause (§16) |
| 4 | ClientSt0r requests predefined actions "under the same approvals" | §32, §39, §40, §59, §61: ten actions are `integration: false`. §58: `DIRECT_MODE_PORTAL_ONLY` | **Owner decision** per action, and an invariant change (§14's count of ten). Blocked anyway until ClientSt0r interoperates |
| 5 | Linux/macOS execution | §24 / §32: POSIX agents act on nothing | **Already decided** (Design A, 2026-11-16): a ported signed Go agent with its own section. The shell agents stay read-only |
| 6 | Remote PowerShell terminal | §39: one constant command line, never built from a plan; everything signed | **Owner decision**, after the separate threat model the directive itself asks for. Not in any release below |
| 7 | Alert-triggered actions run unattended | §17: monitoring never sets or lifts containment. §50: only snapshot keys may run with no requester. AI never authorizes (§41) | **Design**: a signer-approved remediation policy (a new document type, modelled on §71) under which the signer signs each plan. Automatic *investigation* through diagnostics needs a narrow §50 amendment: requester-less runs of named read-only keys, triggered by an alert |
| 8 | Service recovery settings | §61: nothing carries a binary path, account, password, **recovery action** or dependency; the one config write is the start type | **Owner decision** (reverses part of §61). Reading recovery settings is fine |
| 9 | MSI / EXE catalog, other sources | §40: no upload route, `--source winget` only, one exec site | **Owner decision** (reverses §40's no-upload rule). A pinned-URL-and-hash source with no upload is a smaller step that could be argued as design |
| 10 | Run as an unprivileged account | §39: SYSTEM, constant command line | **Already decided** (2026-11-16): each version declares `root` or `unprivileged`, covered by the allowlist approvals. Needs `@2` and a review of how the account is made and its password kept |
| 11 | "Policy-bounded" timeouts | §39: the timeout list is the same on portal, signer and agent | **Design**: a longer closed list in `@2`, bounded by the signer's policy |
| 12 | Interpreter selection | §39: constant command line | **Design**: one constant command line per interpreter in `@2`, the interpreter named in the signed definition |
| 13 | Battery and health on macOS | §32 bans `pmset` and `defaults write` | **Owner decision** to widen §32's read list, or wait for the ported agent (A4) |

## Roadmap

Release numbers follow the in-flight 0.73.1 and 0.74.0, so each P0 step is a **minor** release (new surface). None
is deployed without the owner's explicit approval. Each has its own invariant section, unit and behavioural
tests, and docs. Each says *not run on real hardware* until it has been.

### P0, in order

| # | Release | Contains | Depends on | Agent build | Signer | Real-Windows validation required |
|---|---|---|---|---|---|---|
| 1 | **0.75.0: interpreter and tool capability reporting** | Signed agent reports PS 5.1 and 7 presence and version (an optional strict heartbeat block, dropped when it does not parse, as 0.69 did). `GET /endpoints/:id/tools` gives every tool a state: *available*, *needs approval*, *needs a newer agent*, *unsupported OS*, *not assigned*, *contained*, *no signer*. Add `script-run` to the compatibility suites | — | **Yes** (reporting only) | No | Lab: `windows-latest` with and without `pwsh`, as SYSTEM. Fleet: read the four computers' reports |
| 2 | **0.76.0: Device Tools panel** | The eight groups on the device page from #1's states. Every button opens an existing flow. Nothing new runs | 1 | No | No | None (browser suite) |
| 3 | **0.77.0: diagnostics palette, read-only** (shipped as **0.76.0** *Litmus*, after the Tools panel took 0.75.0: everything but startup apps; sessions from `explorer.exe` owners rather than `quser`, which is not on every edition and prints translated text; Lab on Windows Server only) | Diagnostics catalog gains typed arguments (closed charsets, the §39 rule) and the read-only checks: DNS test by name, TCP host and port, routes, scheduled tasks, startup apps, local administrators, sessions (`quser`), Defender, firewall, BitLocker, Secure Boot / TPM, time sync, activation, pending reboot sources. A palette UI. Read-only, portal-side, no signer | 1 | Script slots only (§12); signed channel at the next publish | No | Lab: every check under PS 5.1 as SYSTEM. **A Windows 10/11 desktop**: Defender, BitLocker and TPM differ from Server |
| 4 | **0.78.0: built-in reviewed library** | Category field (migration). Global, reviewed scripts for the categories that need writes: gpupdate, DHCP renew, flush DNS, WU scan trigger, spooler queue clear, time resync. They still go through the allowlist (§39; one step in direct mode) | 3 | No (`@1`) | No | Lab: each script through `windows.script.run@1` **as SYSTEM** (a scheduled-task harness, as the preflight does) |
| 5 | **0.79.0: bulk runs, history, notifications** | Group, site and business targets resolved at request time with a preview (count, and each computer left out with its reason); ≤ 25-computer plans under one approval (a one-off automation document); per-business concurrency and pace; searchable run history; finish notifications through notification policies | 4 | No | **Yes** (new recurrence kind) | Sim. Fleet: one bulk run on the four computers, with the owner's approval |
| 6 | **0.80.0: `windows.script.run@2`** | Interpreter (5.1, 7, later CMD), run-as (`system` / `unprivileged`), a longer closed timeout list bounded by policy, pending-reboot after the run, operator stop of a running script (conflict 3 decided first). `@1` kept for older agents | 1, 5 | **Yes** | **Yes** | Lab: both interpreters, both accounts, stop in the middle, reboot detection, SFC/DISM length. Desktop VM |
| 7 | **0.81.0: alert automation, recommend and dry run** | Remediation rules: alert kind → read-only investigation → a *proposed* plan for a person to approve. Cooldown, hysteresis, budgets, history. Dry run says what would have run. §50 amendment for alert-triggered read-only keys | 3, 6 | No | No | Sim. Fleet observation only |
| 8 | **0.82.0: alert automation, unattended** | Signer-approved remediation policy: trigger kinds, the exact action or script version, scope, per-computer and per-business budgets, retry limit, cooldown, window, auto-stop after N failures, escalation to PSA, verification by re-evaluating the monitor | 7 | No | **Yes** (new document type) | Lab: a stopped test service restarted by policy and verified. Fleet only after the owner approves it |

### P1, after P0 (order within P1 is the owner's)

1. **Health telemetry, Windows**: security posture (from the #3 reads), SMART / NVMe wear, battery, unexpected
   shutdowns and bug checks, expiring certificates. One state model with evidence times:
   Healthy, Warning, Critical, Unknown, Stale, Unsupported. Monitor kinds over them. New agent build. Needs a
   Windows 10/11 desktop and a laptop.
2. **Trends**: time to full from metric history, wear and definition age. Server-side only.
3. **Network quality**: gateway, DNS, latency and loss to configured targets. Agent build.
4. **Third-party patching, next steps**:
   - an outdated view from inventory against the winget index;
   - automatic retry;
   - custom detection rules;
   - CVE correlation (a new external feed through `safe-https`);
   - non-winget sources only after conflict 9 is decided.
5. **Endpoint admin writes**: a `windows.shutdown` action, a Wake-on-LAN relay through a peer agent on the same
   LAN, then scheduled-task and startup-app changes. Each is a new catalog action and review. Service recovery
   waits on conflict 8.
6. **Operations**: retry on a task (a new request with the same parameters, approved again), a bulk preview
   everywhere, an assigned technician queue, customer preferences, per-site notification policy, quiet hours,
   daily digest.
7. **Backup monitoring**: service and event templates for common backup agents first, then a provider adapter
   interface on the `PsaDriver` pattern.
8. **ClientSt0r**: blocked on HMAC vs Ed25519 and on contract revisions 3 and 5. Proposable actions only after
   conflict 4.

### P2

The A and B series as already decided ([implementation-status.md](implementation-status.md#owner-decisions-2026-11-16)):

- **A3**: Linux signed agent and `linux.script.run@1`.
- **A4**: macOS.
- **A5**: POSIX auto-update.
- **B1–B4**: the file manager.

Each needs the `ubuntu-latest` / `macos-latest` install-as-root jobs ([readiness.md](readiness.md) roadmap 1c)
first.

## Needs real-device validation

Built and Sim-only (or Lab-on-Server-only) today. None of these may be described as working on a real computer
until it has Lab or Fleet evidence.

| Feature | Strongest today | What is missing |
|---|---|---|
| Script runs, automation schedules | Lab (PS 5.1, **administrator**, Server) | As SYSTEM; on a desktop; on the fleet |
| Software install and uninstall (winget) | Sim | Any real run: winget as SYSTEM under WindowsApps, the hash check, detection |
| Maintenance actions: service restart, log collection | Sim | Any real run (the lab covers `windows.service.control`, not `windows.service.restart` or `windows.logs.collect`) |
| Restart scheduling, restart windows, in-window restart after updates | Sim | Has never restarted a real computer |
| Patch rings, canary gate, signed device results | Sim | One direct-mode install on the fleet, restart still pending |
| Program removal: NSIS, Chromium forms | Sim | Lab covers quiet string, MSI and Inno only |
| Containment: the signed pause on the agent | Sim | Never used on a real computer |
| Signed revocation statement on the agent | Sim | — |
| Tray elevated self-help, chat files, support requests | Sim / API | Two read-only tools seen on the fleet |
| Windows Update online scan | Lab (offline, WSUS-pointed) | An online scan returning real updates |
| WSUS / Intune detection | Lab (WSUS policy); Sim | Intune, a real WSUS |
| `.msi` package | Unit | Never run on Windows |
| Managed Secure Access: enforcement, Connect through grants, revocation, session evidence | Lab (enforcement, Server, RustDesk 1.4.1–1.5.3); API | A desktop, a real technician connection, the fleet; `MSA_GRANTS` is off in production |
| Everything Lab-proven | Lab (Server 2025) | **A Windows 10/11 desktop**. This host cannot run VMs; it needs an owner decision on a hypervisor or cloud VMs ([readiness.md](readiness.md) roadmap 1b) |
| Linux and macOS agents | API (Linux userland); recorded output (macOS) | Installed as root under systemd / launchd |

## Stale statements found

Corrected in this release:

- **[capabilities.md](capabilities.md)**:
  - The *tested* table said "No" real Windows for the following, which have Lab or Fleet evidence:
    - signed patch scan and install;
    - monitoring collection;
    - service control and End process;
    - program removal;
    - console migration;
    - chat;
    - the tray.
  - Its closing line, that the Real Windows column "stays No" until a lab, was wrong once the 0.68.3 lab ran.
- **[rmm-gap-analysis.md](rmm-gap-analysis.md)** (a 0.30 record). Marked superseded, and these clearly wrong
  present-tense lines corrected:
  - "the approval signer is not installed in production" and "nothing can be executed in production". The fleet
    ran a direct-mode update install and a program removal.
  - "catalog of exactly two" actions (there are twelve).
  - "no one-click diagnostics" (since 0.31).
  - "rem0te holds no model-provider key" (reversed in 0.48, §41).
  - "the monitor block has never run on real Windows" (the fleet raised a real event alert).
  - script scheduling "not implemented" (0.58).

Found and left for their owners (outside this page's brief):

- **[readiness.md](readiness.md)**:
  - Says Lab evidence is "Nothing has this level yet". Lab results exist since 0.68.3, and its own MSA row cites
    one.
  - Audited at 0.68.0.
- **[script-library.md](script-library.md)** and **[automation.md](automation.md)** say scripts have "not run on
  a lab machine" and "none of it has run on real Windows". The 0.68.3 lab runs `windows.script.run` under
  Windows PowerShell 5.1, as administrator, not SYSTEM.
- **[compatibility.md](compatibility.md)** says the lab jobs are "when merged". They are merged.
