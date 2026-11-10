# What each agent can do

Rem0te started as a RustDesk portal and now does part of an RMM's job: monitoring, inventory, read-only patch
reporting, approved patch deployment and ClientSt0r ticket integration. Which of it works on a computer depends on
**what is installed there**, and some of it needs configuration on the server first. This page says which, and how
far each part has been tested. "Tested" here means one of three things, and they are not the same:

| Level | Meaning |
|---|---|
| **Real Windows** | Ran on a real Windows machine, against the real Windows service it uses |
| **Simulated** | The agent's real code ran against fakes of Windows (Windows Update, registry, service manager), driven through the real API, in CI |
| **Fixture-tested** | The server side ran against a stand-in for the device or peer; the device code did not run |

## The agent types

| | **Standard agent** | **Signed agent** (0.27+) | **Linux / macOS** | **Quick Connect** |
|---|---|---|---|---|
| What it is | The Windows install script's scheduled tasks (update channel `legacy`) | The signed `rem0te-agent.exe`, installed from the signed update channel (`signed`) | RustDesk plus a one-time registration at install | A one-off RustDesk session, nothing installed |
| Remote access (RustDesk, launch policy, audit) | Yes | Yes | Yes | Yes, for that session |
| Heartbeat, online/offline | Yes | Yes | At install only | No |
| Inventory (hardware, OS, disks, last boot) | Yes | Yes | No | No |
| Installed software and change history (0.29) | Yes | Yes | No | No |
| Windows event log reading | Yes | Yes | No | No |
| Monitoring (offline, disk, CPU, memory, services, events, restart pending) | Yes | Yes | Offline only (it stops heartbeating) | No |
| **Patches: pending updates, restart pending** | **Yes — read-only**, every 12 h or on *Scan now* | Yes | No | No |
| Patches: update identities, history, restart sources | No | Yes | No | No |
| Patches: who manages patching (WSUS, Intune, WUfB, ConfigMgr) | **No — shown as Unknown** | Yes | No | No |
| Patches: confirmed by a later scan | No | Yes | No | No |
| **Deploying updates** (canary, rings, two approvals) | **No** | Yes, when approvals are configured | No | No |
| Approved actions (start the Print Spooler) | No | Yes, when approvals are configured | No | No |
| Containment honoured on the device | Server side only | Server side, and the agent checks the signed pause | Server side only | Server side only |

The standard agent never deploys anything. The Patches tab shows what it reports, labelled
*Standard agent scan (read-only)*, and says that deploying needs the signed agent.

## Patch status on the Patches tab (0.30)

Every computer's Patches tab now leads with **Patch status**: the evidence first, then what follows from it.

| Field | Where it comes from |
|---|---|
| Evidence | *Signed agent scan*, *Standard agent scan (read-only)* or *No scan received*, with its time, its age and **fresh / stale / unknown**. Stale means older than 36 hours: three missed 12-hour scans |
| Last successful scan | A signed scan that came back with an error is not a successful scan |
| Last boot | The inventory's last boot time |
| Connection | Online, or offline since when |
| Restart pending | From the scan; **unknown** when nothing was received, never "no" |
| Who manages patching | **WSUS**, **MDM (Intune) update policy**, **Windows Update for Business policy** or **Configuration Manager**, with what that means, when the signed agent finds them. **Unknown** from the standard agent, which does not read update policy. *Windows Update (rem0te can deploy)* when the signed agent found none |
| Relevant KBs | The KB numbers offered, critical and important first |
| Installed by an approved plan | Each update from a recent plan, and whether a **later scan confirmed** it. Only a scan taken after the install, which no longer offers the update, shows no restart pending and has Windows Update's history recording it, counts |
| Deploy from rem0te | Available, or why not: no signed agent, managed elsewhere, no signed scan yet, or the scan is stale |

**WSUS and Intune ownership.** When a computer takes its updates from WSUS (Group Policy `WUServer` with
`UseWUServer=1`) or from an Intune update ring (the `PolicyManager\current\device\Update` policy), approvals and
timing belong to that system. Rem0te shows what the computer reports and will not deploy there. The signed agent
refuses too, so the two never fight over a computer.

**In a linked ticket.** When a *restart pending* alert is offered to ClientSt0r, it carries a redacted summary
(contract revision 2, `alert.patch_summary`): evidence source and age, freshness, last boot, who manages patching
(as a label), restart pending, the pending KB numbers, and which KBs were confirmed, failed or are awaiting
confirmation. It never carries update titles, error text, computer identifiers, user names, addresses or registry
values.

## What needs configuring

| To use | You need |
|---|---|
| Monitoring and notifications | Nothing to start: global monitors are seeded. Webhooks: a notification policy ([monitoring.md](monitoring.md)) |
| The signed agent | The signed update channel ([update-signing.md](update-signing.md)), and endpoints moved to it |
| Approved actions, update deployment | The approval signer, installed separately, with roster approvers who have passkeys ([approved-actions.md](approved-actions.md), [staged-patching.md](staged-patching.md)) |
| ClientSt0r ticket analysis and alert tickets | A peers file, the integration worker, organization and technician mappings ([integration-clientst0r.md](integration-clientst0r.md)). **ClientSt0r cannot pair yet**: see the contract's [CLIENTST0R.md](contracts/ticket-rmm-v1/CLIENTST0R.md) |

## What has been tested, and how

| Capability | Real Windows | Simulated | Fixture-tested |
|---|---|---|---|
| Remote access, launch policy | **Yes** (production fleet) | — | Yes |
| Standard agent: heartbeat, inventory, update scan | **In production use**, standard channel: observed, not a controlled test | — | Yes |
| Monitoring collection (services, events, software) | **No** | Under pwsh against stubs (`unit-monitoring.mjs`) | Yes (`e2e-monitoring.mjs`) |
| Signed agent: patch scan, install, restart detection | **No** | Yes: `e2e-staged-patching.mjs` runs the agent's real `internal/patch` code through `rem0te-action-sim` | — |
| Patch status: restart required | **No** | Yes | Yes (`unit-patch-summary.mjs`) |
| Patch status: restart completed, confirmed by a later scan | **No** | Yes | Yes |
| Patch status: failed update (Windows' HRESULT) | **No** | Yes | Yes |
| Patch status: offline, stale evidence | **No** | Yes (scan time moved back 80 hours in the database) | Yes |
| Patch status: externally managed (WSUS, Intune) | **No** | Yes (the agent's registry detection against a simulated registry) | Yes |
| Approved actions (Print Spooler) | **No** | Yes (`e2e-approved-action.mjs`) | Yes |
| ClientSt0r workflow | — | — | Against a contract-conformant reference peer (`e2e-ticket-workflow.mjs`). **Against the real ClientSt0r: does not interoperate yet** (`interop-clientst0r.mjs`, four measured gaps) |

### Still needs a lab

These are the remaining steps that need hardware or accounts this repository's CI does not have:

1. **A disposable Windows 11 client and a Windows Server 2022** on the signed channel, enrolled to a scratch
   rem0te, each with the five cases set up for real:
   - an update that needs a restart;
   - the same after the restart;
   - an update made to fail (for example, a blocked download host);
   - the machine powered off for 40 hours;
   - one joined to WSUS and one enrolled in Intune with an update ring.
2. A real **authenticator** on the approval roster, to approve a ring.
3. **ClientSt0r**, after it adopts ticket-rmm-v1 ([CLIENTST0R.md](contracts/ticket-rmm-v1/CLIENTST0R.md)), paired
   with a scratch rem0te: `e2e-ticket-workflow.mjs`'s scenarios repeated with ClientSt0r in place of the
   reference peer.

Until those have been run, the "Real Windows" column above stays **No**.
