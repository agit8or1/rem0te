# Implementation status — expanded RMM programme

The central tracker for the expanded-RMM directive (2026-11-16). The controller
session updates it as each phase lands; agents read it before starting. A row
is **Done** only with backend, UI, permissions, audit, automated tests and docs
— and "Done" never means "validated on real hardware": that column is separate.

Legend: **E** exists · **P** partial · **M** missing · **F** in flight (branch)

## Current audit — 0.73.2 (main 3554921, 0.73.0)

The *Full RMM Functionality Expansion* directive (2026-11-20) is audited item by item in
**[rmm-expansion-audit.md](rmm-expansion-audit.md)**. That page has:

- the matrix, with a status and the strongest evidence level for each item, on
  [readiness.md](readiness.md#evidence-levels)'s ladder;
- the thirteen places where the directive conflicts with an invariant, and how each would be resolved;
- the P0 release sequence;
- the list of features that still need real-device validation.

It supersedes the Phase 0 audit below, which is kept as the 0.54 record.

| Status | P0 | P1 | P2 |
|---|---|---|---|
| Existing | 26 | 19 | 0 |
| Partial | 26 | 15 | 0 |
| Missing | 21 | 20 | 0 |
| Planned | 3 | 0 | 6 |

**P0 sequence** (minor releases after the in-flight 0.73.1 and 0.74.0; none deployed without approval):

| # | Release | Agent build | Signer |
|---|---|---|---|
| 1 | 0.75.0: PowerShell 5.1 / 7 reporting, per-tool capability states, `script-run` in the compatibility suites | yes | no |
| 2 | 0.76.0: Device Tools panel (eight groups, existing flows only) | no | no |
| 3 | 0.77.0: read-only diagnostics palette with typed arguments (network, security posture, tasks, sessions) | script slots | no |
| 4 | 0.78.0: built-in reviewed library (categories; write scripts still through §39) | no | no |
| 5 | 0.79.0: bulk runs (group / site / business, preview, ≤ 25 per plan, one approval), searchable history, finish notifications | no | yes |
| 6 | 0.80.0: `windows.script.run@2` (interpreter, run-as, policy timeouts, reboot detection, stop) | yes | yes |
| 7 | 0.81.0: alert automation, recommend and dry run | no | no |
| 8 | 0.82.0: alert automation under a signer-approved remediation policy | no | yes |

In flight: **#183, 0.73.1** (wire-fixture compatibility for the standard and POSIX agents) and **#185, 0.74.0
*Bastion*** (*Admin → Security* posture checks for the portal host). Merged: **0.73.0 *Warden*** (Managed Secure
Access step 5: Connect through grants, revocation, session evidence, behind `MSA_GRANTS`, off).

## Phase 0 — audit of v0.54.0 (main 12a8350) — historical

### 1. Endpoint health

| Area | Windows | Linux | macOS | Notes |
|---|---|---|---|---|
| CPU %, memory, uptime, system disk (every 3 min) | E | E | E | `HeartbeatDto`; `windows-script.ts:1137`, `linux-agent.ts`, `macos-agent.ts` |
| Per-volume usage (6 h inventory) | E | E | P | `EndpointInventory.disks` |
| Hardware inventory (make/model/serial/BIOS/CPU/GPU) | E | E | E | diffs into `EndpointChange` |
| CPU / drive temperature, sensors | M | M | M | |
| SMART, SSD/NVMe wear, disk errors | P (event ids 7/11/51/153 via EVENT_MATCH) | M | M | |
| Battery health / design vs full / cycles | M | M | M | `pmset` is banned by §24/§32 on macOS |
| OS version/build | E | E | E | |
| Activation, Secure Boot, TPM, Win11 readiness | M | — | — | |
| Pending updates / reboot required | E | E | P (no reboot flag) | 12 h scan |
| Failed updates, last success | P (signed agent history) → F 0.55 monitor | M | M | |
| Unexpected shutdown / BSOD | P (manual EVENT_MATCH) | M | M | |
| AV / Defender / definitions / last scan | M | M | M | |
| Firewall per profile | M | M | M | |
| BitLocker / FileVault / LUKS | M | M | M | |
| Gateway/DNS/latency/loss/jitter/link/errors | P (adapters, on-demand latency to portal) | M | M | |
| History (CPU/mem/disk, 48 h raw + 90 d hourly, graphs) | E | E | E | `metrics/` — monitoring does not read it |
| Trend / predictive alerts | M | M | M | |
| Health score | P (worst-alert sort only) | | | |
| Monitor kinds | 8 → F 0.55 adds any-drive disk, uptime, outstanding/failed updates; F 0.56 warranty | | | |

Constraints: §17 (monitor block only `Get-Service`/`Get-WinEvent`), §12 (signed/standard
script differ only in slots), §24/§32 (POSIX agents read-only, text-checked), §30 (history only
from authenticated heartbeat / command result), §64 (agent fields only when `heartbeatMayAct`).

### 2. Automation

| Item | Status | Notes |
|---|---|---|
| Script library: immutable versions, SHA-256, typed params, diffs, review, signer allowlist (2 passkeys), output redaction, timeouts, history | E | §39 |
| Interpreters | P | Windows PowerShell 5.1 only; PS 7, Bash, Zsh missing |
| Agent reports available interpreters | M | |
| Privilege / run-as | M | always SYSTEM |
| Built-in reviewed templates | M | |
| One-time schedule | P | patch + restart (calendar, 14 d); scripts/software only `startsInMinutes` |
| Recurring schedules (hourly/daily/weekly/monthly) | P | only patch policies; window union in `patch-policy.ts` shared with signer |
| Alert → action triggers, cooldown, retry, rate limits | M | monitoring never imports ActionsService |
| Offline behaviour | E | handed out on next heartbeat inside signed `notBefore..notAfter` (≤ 24 h), else CANCELED `window_closed` |
| Signed plans, 2-person, direct mode, revocation, containment | E | §14 §38 §52 §58 §16 |
| Visual automation editor | M | `/automation` is scripts/software/tasks pages |
| AI executes | Never | AI only explains; ClientSt0r `ai_suggestion` proposals need human approval |

### 3. Remote file manager — **M** throughout
No browse/transfer outside RustDesk. `windows.logs.collect@1` (fixed sources) and chat attachments
(person-to-person) exist. No `files` capability. `fileTransfer` policy accepts only `off`.

### 4. Discovery & adoption

| Item | Status | Notes |
|---|---|---|
| Unassigned pool (no tenant), Platform Admin screen, single assign | E | `admin/unassigned` |
| Bulk assign, site choice on assign, suggested mappings, approval record | M / P (audited `ENDPOINT_UPDATED`) | |
| Multi-use deployment key (GPO/Intune/RMM), MSI/Intune package | P / M | tokens single-use, 24 h |
| Linux / macOS install scripts | E | remote access + read-only telemetry |
| Actions blocked before assignment | P | blocked: actions, chat, monitors, software, patching…; **remote session not explicitly refused** (Platform Admin only; insert likely fails on null tenant) — make explicit |

### 5. Backup monitoring — **M**
Reusable: `PsaDriver` connector pattern, `secret-box`, `safe-https`, signed integration guard,
monitor engine. Quick win: SERVICE_STOPPED / EVENT_MATCH templates for backup agents.

### 6. Customer health dashboard

| Item | Status | Notes |
|---|---|---|
| Customer scoping (Business User + capabilities + `endpointVisibilityWhere`) | E | |
| `my-computers` page, public support form/status | E | |
| Plain-language health view for customers | M | `Tenant.allowCustomerPortal` stored, read by nothing |
| ClientSt0r health contract | P | P10 `computers/{id}/summary` agreed (rev 3), not built; live ClientSt0r 3.17.659 does not interoperate (HMAC vs Ed25519) |

### 7. Notifications & digest

| Item | Status |
|---|---|
| Global + per-business notify policy, webhook/email, severity, 4-level escalation, dedup, outage grouping, maintenance windows, pause | E |
| Per-site / per-group notify policy | M |
| Quiet hours | M |
| Daily digest | M (scheduled reports are weekly/monthly; `ReportSchedule` is the base) |

### 8. UI
13 device tabs, 7 dashboard tiles + 7 panels, map, shadcn/Radix/Tailwind, theme tokens,
hand-drawn SVG charts (no chart library), no dashboard business/site/OS filter in the UI
(API already takes `businessId`).

## Plan

Each phase ships as one or more minor releases through the normal PR → CI → deploy path, each
with its own invariant section, unit + behavioural e2e, docs and a "not run on real hardware"
statement until it has been.

| Phase | Release(s) | Status | Depends on |
|---|---|---|---|
| — Alerts: more conditions, PSA auto-tickets, dashboard recent alerts | 0.55 | shipped with 0.56 (stack PR) | — |
| — Warranty + hardware support links | 0.56 | shipped (stack PR) | — |
| — Warranty: HP (HP Inc. Warranty API) and Apple (Business Manager) lookups; "why is there no date" per computer | 0.61 | shipped — HP and Apple tested only against a stand-in | 0.56 |
| 4 Discovery & adoption (bulk assign w/ site, mappings, multi-use deployment keys, explicit pre-assignment refusals incl. sessions) | 0.57 | shipped (§70) | — |
| 1a Health telemetry, Windows (security posture: Defender/AV, firewall, BitLocker, Secure Boot, TPM, activation; battery; SMART/wear via `Get-PhysicalDisk`/`Get-StorageReliabilityCounter`; unexpected shutdown/BSOD), unsupported ≠ healthy | after 0.55/0.56 merge | planned | 0.55 engine |
| 1b Health telemetry, Linux/macOS (read-only, within §24/§32 or deliberate amendment) | | planned | 1a |
| 1c History for new metrics, trend alerts (disk fill ETA, wear, shutdowns, battery, stale definitions), health score, Health/Security/Network tabs | | planned | 1a |
| 1d Endpoint network quality (gateway/DNS/latency/loss/jitter to configured targets), opt-in rate-limited throughput test | | planned | 1a |
| 5 Backup monitoring (provider adapter interface, generic authenticated webhook + polling, first adapters, backup monitor kinds) | | planned | 0.55 engine |
| 7 Daily digest (daily frequency on ReportSchedule), quiet hours, per-site notify policy | | planned | 0.55 |
| 6 Customer health dashboard + P10 health contract (feature-flagged until ClientSt0r advertises it) | | planned | 1c |
| 2a Scheduling for scripts/software (calendar one-time, recurring via signer-side pre-approved automation policies, modelled on patch policies) | 0.58 | shipped (§65, §71) | — |
| 2b Alert-triggered automation (proposes plans; executes unattended only under a signer-approved automation policy with cooldown, dedup, max-runs, retry, escalation) | 0.81, 0.82 | planned ([audit](rmm-expansion-audit.md#roadmap) #7–#8) | 2a, 1a |
| 2c Built-in reviewed template library | 0.77, 0.78 | planned (audit #3–#4: read-only checks in the diagnostics catalog, writes through §39) | 2a |
| 2d PowerShell 7 + interpreter reporting on Windows; Linux/macOS execution via the Go agent ported to those platforms (signed, verified), POSIX shell agent stays read-only | 0.75 (A1), 0.80 (A2), then A3–A5 | planned; Design A decided 2026-11-16 (shell agents stay read-only, §24/§32 unchanged) | 2a |
| 3 File manager (signed, time-boxed, path-scoped file-session grant; chunked hashed transfers; `computers:files`) | | planned, design review first | 2d for Linux/macOS |
| 8 UI: device workspace regrouping, dashboard filters + charts, automation editor | woven into each phase, final polish pass | planned | all |

## Validation on real systems

| Capability | Real Windows | Real Linux | Real macOS |
|---|---|---|---|
| Everything since the tray (0.36) and approved actions beyond Spooler | **Lab (Windows Server 2025, 0.68.3+)**: service control, End process, program removal (quiet, MSI, Inno), script runs under PS 5.1 as administrator, offline update scan, RustDesk preflight and MSA enforcement. **Fleet**: one update install, one program removal, migrations, auto-update, two tray tools, chat ([readiness.md](readiness.md#the-production-fleet)). Not on a Windows 10/11 desktop under control | — | — |
| 0.54 restart scheduling | Sim only: has never restarted a real computer | — | — |
| 0.65 Windows Installer package (`windows.msi`) | not yet (built and read back on Linux only) | — | — |

Simulators (`rem0te-action-sim`, pwsh-on-Linux parse/run) are not real-system tests.

## Owner decisions (2026-11-16)

- **POSIX execution (Design A):** port the signed Go agent to Linux and macOS; the shell agents stay read-only (§24/§32 unchanged, new section for the signed POSIX agent). macOS is built without an Apple Developer account: ad-hoc signed, installed by script, with Gatekeeper/.pkg and TCC/Full Disk Access limits documented in the UI and docs.
- **Run-as:** each script version declares `root` (SYSTEM) or `unprivileged` (a `rem0te-run` service account); covered by the two allowlist approvals.
- **CI:** add GitHub-hosted `windows-latest` and `macos-latest` jobs that run the agent's Go tests (no keys, no signing, no release scripts in `.github`, §56).
- **File manager (Design B):** signed time-boxed file-session grant; browser-signed operations (WebCrypto key bound in the grant); long-poll channel; quarantine for uploads. Options chosen: **delete → 7-day Rem0te trash on the computer**, **end-to-end encryption of file contents to the browser key**, **tray notice to the person at the computer while a session is open**. Server read-only sessions stay low risk (one approval) like workstations; read-write is always high (two).
- Release order for these: A1 interpreter reporting + library schema → A2 `windows.script.run@2` (PowerShell 7) → A3 Linux signed agent + `linux.script.run@1` → A4 macOS → A5 POSIX auto-update; then B1 read-only files → B2 search/resume/journal → B3 read-write/quarantine/trash → B4 macOS.
