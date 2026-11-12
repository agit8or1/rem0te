import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../integration/crypto';
import { MAX_SCRIPT_OUTPUT_BYTES, ScriptBlock, ScriptRunParams, TIMEOUT_MINUTES, scriptPlanProblem } from './script-run';

/**
 * The approved-action catalog (v0.26) and the canonical plan an approver
 * signs. Shared, as code, by the portal and the approval signer; mirrored in
 * the Windows agent (tools/windows-installer/internal/action/catalog.go),
 * which is the copy that decides what actually runs.
 *
 * Seven actions. Starting the Print Spooler on one computer (0.26); installing
 * named Windows updates on a ring of computers (0.27); four maintenance
 * actions (0.32): restarting one service from a fixed allowlist, scheduling a
 * warned restart, canceling it, and collecting a fixed set of logs; and
 * (0.34) running one approved script-library version whose exact SHA-256
 * is on the approval signer's own allowlist. Nothing here can carry a
 * command line, a path or a URL, and the script action names a hash, not
 * text — parameters are closed enums, bounded integers, update identities or
 * typed script arguments checked against a reviewed schema — so an AI
 * suggestion, a ticket or a compromised portal cannot turn a catalog entry
 * into arbitrary execution.
 */

export const PLAN_SCHEMA = 'rem0te-action-plan/1';
export const ENVELOPE_SCHEMA = 'rem0te-action-envelope/1';
/** Domain separation for the approval signature (also in the agent). */
export const PLAN_SIGNING_PREFIX = 'rem0te-action-plan-v1\n';

export type Risk = 'low' | 'high';

export interface CatalogAction {
  id: string;
  version: number;
  title: string;
  description: string;
  params: z.ZodType<Record<string, unknown>>;
  /** Shown on the approval page above the approve button, verbatim. */
  warnings: string[];
  /** What the agent checks afterwards. Nothing else is claimed. */
  verification: string;
  /** What this action can never tell you. */
  doesNotProve: string[];
  /** Risk from the plan alone: target class and count. */
  risk(targets: { deviceClass: string }[]): Risk;
  /** How many computers one signed plan may name. */
  maxTargets: number;
  /** How long after delivery a missing result becomes UNKNOWN. */
  resultDeadlineMinutes: number;
  /** Requestable one computer at a time from its Actions tab (false: only through its own workflow). */
  direct: boolean;
  /**
   * Offered to ClientSt0r as proposable (capabilities and action-proposals).
   * The 0.32 maintenance actions are not: advertising them is a change to the
   * ticket-rmm contract that ClientSt0r has not agreed to.
   */
  integration: boolean;
  /** Longest signed window, hours, when shorter than MAX_WINDOW_HOURS. The agent enforces the same. */
  maxWindowHours?: number;
  /** A capability the requester needs on top of actions:request — and that a reader needs to see the result's content. */
  requiresCapability?: 'computers:event_logs';
  /** What the requester ticks to confirm they read the warnings. */
  acknowledge: string;
  /** The one parameter a requester chooses, if any, and every value it may take. */
  choice?: { field: string; label: string; options: { value: string | number; label: string }[] };
}

export const SERVICE_START: CatalogAction = {
  id: 'windows.service.start',
  version: 1,
  title: 'Start the Windows Print Spooler',
  description: 'Starts the Print Spooler service (Spooler) once. If it is already running, nothing is changed.',
  params: z.object({ service: z.literal('Spooler') }).strict(),
  warnings: [
    'Documents already waiting in the print queue may print immediately when the spooler starts. They cannot be recalled once sent to the printer.',
    'This starts the service once. It does not change its startup type, so it may be stopped again after a restart.',
  ],
  verification: 'The agent confirms the service is running 10 seconds after starting it and again 30 seconds after.',
  doesNotProve: ['that any document printed', 'that the printer works', 'why the spooler had stopped'],
  // Anything but a single standard workstation is high impact: two approvers.
  risk: (targets) => (targets.length !== 1 || targets.some((t) => t.deviceClass !== 'WORKSTATION') ? 'high' : 'low'),
  maxTargets: 1,
  resultDeadlineMinutes: 30,
  direct: true,
  integration: true,
  acknowledge: 'I understand that documents already waiting may print as soon as the spooler starts, and cannot be recalled.',
};

export const UPDATE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Most updates one plan names; the agent enforces the same (patch.MaxPerPlan). */
export const MAX_UPDATES_PER_PLAN = 20;
/** Most computers in one ring plan; the agent enforces the same (action.MaxRingTargets). */
export const MAX_RING_TARGETS = 25;

export const UpdateIdentity = z.object({ updateId: z.string().regex(UPDATE_ID_RE), revision: z.number().int().min(1).max(1_000_000) }).strict();

/** Installable classifications (the agent's patch.Installable). */
export const INSTALLABLE_CLASSES = ['0fa1201d-4330-4fa8-8ae9-b877473b6441', 'e6cf1350-c01b-414d-a61f-263d14d133b4', '28bc880e-0592-4cbf-8f95-c79b17911d5f', 'cd5ffd1e-e932-4e3a-bf74-18bf0b1bbd83'] as const;
const uniq = <T>(a: T[]) => new Set(a).size === a.length;
/** A patch policy's narrowing, as the agent parses it (internal/action/updates.go updateFilter). */
export const UpdateFilter = z.object({
  classifications: z.array(z.enum(INSTALLABLE_CLASSES)).min(1).max(4).refine(uniq, 'duplicate'),
  severities: z.array(z.enum(['Critical', 'Important', 'Moderate', 'Low', 'Unrated'])).min(1).max(5).refine(uniq, 'duplicate').optional(),
  excludeKbs: z.array(z.string().regex(/^KB[0-9]{4,10}$/)).min(1).max(50).refine(uniq, 'duplicate').optional(),
}).strict();

/**
 * An update plan's restart rule (0.34). Two fixed values, nothing to choose
 * beyond them: no delay, time, message or command. The agent has the same
 * two (updates.go RebootNever / RebootInWindow) and refuses anything else.
 *
 *   never                  the computer is never restarted (0.27–0.33).
 *   if_required_in_window  after the install, and only if Windows then says
 *                          a restart is required, the agent schedules one
 *                          through windows.reboot.schedule's own path: the
 *                          fixed warning, UPDATE_RESTART_WARNING_MINUTES
 *                          later, never while a RustDesk session is open (or
 *                          when it cannot tell), never after the plan's
 *                          signed window closes. Otherwise restart_deferred.
 */
export const UPDATE_REBOOT_RULES = ['never', 'if_required_in_window'] as const;
export type UpdateRebootRule = (typeof UPDATE_REBOOT_RULES)[number];
export const UpdateReboot = z.enum(UPDATE_REBOOT_RULES);
/** The fixed warning before an update plan's restart; the agent uses the same (UpdateRestartWarningMinutes). */
export const UPDATE_RESTART_WARNING_MINUTES = 15;
/** Does a plan's rule ask for no more than `allowed`? (never ≤ if_required_in_window) */
export const rebootWithin = (plan: unknown, allowed: UpdateRebootRule) =>
  UpdateReboot.safeParse(plan).success && UPDATE_REBOOT_RULES.indexOf(plan as UpdateRebootRule) <= UPDATE_REBOOT_RULES.indexOf(allowed);
/** Said wherever the restart rule is offered or described. */
export const REBOOT_UNPROVEN = 'The in-window restart has been tested against a simulated Windows only; it has not yet run on a real Windows computer.';

export const UPDATE_INSTALL: CatalogAction = {
  id: 'windows.update.install',
  version: 1,
  title: 'Install Windows updates',
  description: 'Downloads and installs the named Windows updates from Windows Update on each named computer, then reports each update\'s result. It restarts a computer only if the plan\'s restart rule allows it and Windows says a restart is required; by default it never does.',
  params: z.object({
    updates: z.array(UpdateIdentity).min(1).max(MAX_UPDATES_PER_PLAN)
      .refine((u) => new Set(u.map((x) => `${x.updateId}@${x.revision}`)).size === u.length, 'duplicate update'),
    reboot: UpdateReboot,
    // 0.32: a plan signed under a patch policy carries the policy's filter,
    // and the agent applies it to Windows Update's own answer
    // (patch.InstallFiltered). It can only narrow what Eligible allows.
    allow: UpdateFilter.optional(),
  }).strict(),
  warnings: [
    'Installing updates changes the computer. An update can break a driver or an application, and some cannot be uninstalled.',
    'Many updates need a restart before they take effect. With the restart rule "never", the computer is not restarted: until someone restarts it, it keeps running the old code and reports "restart required".',
    `With the restart rule "restart if required, inside the window", a computer that Windows says needs a restart after the install shows the fixed restart warning and restarts ${UPDATE_RESTART_WARNING_MINUTES} minutes later: programs still open are closed without saving. It does not restart while a RustDesk session is open (or when it cannot tell), or if the restart would fall after the plan's window closes; it reports the restart deferred and leaves the computer as it is. ${REBOOT_UNPROVEN}`,
    'Updates download from Microsoft. People using the computer may notice it slow down while they install.',
    'Each computer installs only the named updates that Windows Update offers it and that are security, critical, rollup or ordinary updates. Drivers, feature upgrades and optional updates are never installed, and no licence is accepted on anyone\'s behalf.',
  ],
  verification: 'Each computer reports what Windows Update said for every named update, whether a restart is pending, and — under the in-window rule — whether it scheduled a restart and for when, or why it deferred it. A later scan, after any restart, shows whether the update took effect.',
  doesNotProve: ['that the update fixed any problem', 'that applications still work afterwards', 'that a scheduled restart happened (a later scan with no restart pending shows that)'],
  // Software installation is high impact on any computer, at any count.
  risk: () => 'high',
  maxTargets: MAX_RING_TARGETS,
  resultDeadlineMinutes: 6 * 60,
  direct: false,
  integration: true,
  acknowledge: 'I understand that these updates change the computers, may need a restart, and that under the in-window rule the computers restart after a fixed warning.',
};

// ── Maintenance actions (0.32) ──────────────────────────────────────────────
// Every one is high impact on any computer: two distinct approvers, always,
// and the agent recomputes that itself. Keep in step with
// tools/windows-installer/internal/action/{catalog,maintenance}.go.

/**
 * The only services windows.service.restart may name (the agent has the same
 * list and refuses anything else). Left out on purpose: security products and
 * the security subsystem, RPC, the event log, DNS Client (Windows 10+ will
 * not stop it) and Workstation (stopping it drops open files and mapped
 * drives). See docs/approved-actions.md.
 */
export const RESTARTABLE_SERVICES = [
  { name: 'Spooler', label: 'Print Spooler' },
  { name: 'wuauserv', label: 'Windows Update' },
  { name: 'BITS', label: 'Background Intelligent Transfer Service' },
  { name: 'W32Time', label: 'Windows Time' },
  { name: 'WinRM', label: 'Windows Remote Management' },
  { name: 'RustDesk', label: 'RustDesk (remote support)' },
] as const;
const SERVICE_NAMES = RESTARTABLE_SERVICES.map((s) => s.name) as unknown as [string, ...string[]];

export const SERVICE_RESTART: CatalogAction = {
  id: 'windows.service.restart',
  version: 1,
  title: 'Restart a Windows service',
  description: 'Stops one service from a fixed list and starts it again, then checks it is running. If it was stopped, it is only started.',
  params: z.object({ service: z.enum(SERVICE_NAMES) }).strict(),
  warnings: [
    'Whatever the service was doing stops: print jobs being sent, a download in progress, a Windows Update scan, a WinRM session.',
    'Restarting RustDesk disconnects anyone connected through it. The computer skips it if a RustDesk session is open, or if it cannot tell. If RustDesk does not come back, nobody can connect remotely until someone at the computer fixes it.',
    'Windows refuses to stop a service that other running services depend on; the restart then fails and nothing else is stopped.',
    'The startup type is not changed: a disabled service stays disabled and the start fails.',
  ],
  verification: 'The agent records the state before, after the stop, and 10 and 30 seconds after the start.',
  doesNotProve: ['that whatever was failing now works', 'why the service had stopped or misbehaved'],
  risk: () => 'high',
  maxTargets: 1,
  resultDeadlineMinutes: 30,
  direct: true,
  integration: false,
  acknowledge: 'I understand that the service stops for a moment, and that restarting RustDesk disconnects anyone connected.',
  choice: { field: 'service', label: 'Service', options: RESTARTABLE_SERVICES.map((s) => ({ value: s.name, label: `${s.label} (${s.name})` })) },
};

/** Restart warning bounds, minutes; the agent enforces the same. */
export const MIN_RESTART_DELAY_MINUTES = 5;
export const MAX_RESTART_DELAY_MINUTES = 24 * 60;
const DELAYS = [5, 15, 30, 60, 120, 240, 480, 1440];

export const REBOOT_SCHEDULE: CatalogAction = {
  id: 'windows.reboot.schedule',
  version: 1,
  title: 'Schedule a restart',
  description: 'Shows a fixed restart warning on the computer and restarts it when the chosen delay has passed (5 minutes to 24 hours after the computer receives the plan). Never immediately.',
  params: z.object({ delayMinutes: z.number().int().min(MIN_RESTART_DELAY_MINUTES).max(MAX_RESTART_DELAY_MINUTES) }).strict(),
  warnings: [
    'When the delay ends, Windows closes every program still open without saving. Anything not saved by then is lost.',
    'The person at the computer sees this warning, in this wording: "Your IT support provider has scheduled a restart of this computer for <time> (in <N> minutes). Please save your work and close your programs before then: programs still open will be closed without saving. Approved maintenance, reference <job>."',
    'The delay counts from when the computer receives the approved plan, at its next check-in after approval. The plan expires unrun if that is not within 2 hours of its start.',
    'The computer skips the restart if a RustDesk session is open, or if it cannot tell. It checks once, when it schedules: someone who connects afterwards sees the Windows warning on screen.',
    'It can be canceled with "Cancel a scheduled restart", which needs its own approvals: approve that early if you may need it.',
  ],
  verification: 'The agent reports the time it scheduled the restart for. It cannot report the restart itself: that is seen as a new boot time in the inventory afterwards.',
  doesNotProve: ['that the computer restarted', 'that a restart fixed anything', 'that nobody lost unsaved work'],
  risk: () => 'high',
  maxTargets: 1,
  resultDeadlineMinutes: 30,
  direct: true,
  integration: false,
  maxWindowHours: 2,
  acknowledge: 'I understand that programs still open when the delay ends are closed without saving.',
  choice: { field: 'delayMinutes', label: 'Warning before the restart', options: DELAYS.map((m) => ({ value: m, label: m < 60 ? `${m} minutes` : m === 60 ? '1 hour' : `${m / 60} hours` })) },
};

export const REBOOT_CANCEL: CatalogAction = {
  id: 'windows.reboot.cancel',
  version: 1,
  title: 'Cancel a scheduled restart',
  description: 'Cancels the restart or shutdown Windows has pending on this computer, if there is one.',
  params: z.object({}).strict(),
  warnings: [
    'This cancels whatever restart or shutdown is pending on the computer, including one a person or another tool scheduled there, not only one scheduled from here.',
    'It needs its own two approvals and runs at the computer\'s next check-in after them. A restart whose delay ends first is not stopped.',
  ],
  verification: 'The agent reports whether a pending restart was canceled, or that none was pending.',
  doesNotProve: ['that no restart happens later for another reason'],
  risk: () => 'high',
  maxTargets: 1,
  resultDeadlineMinutes: 30,
  direct: true,
  integration: false,
  acknowledge: 'I understand that this cancels any pending restart on the computer.',
};

export const LOGS_COLLECT: CatalogAction = {
  id: 'windows.logs.collect',
  version: 1,
  title: 'Collect logs',
  description: 'Collects a fixed set of logs: Critical and Error events from the System and Application logs in the last 24 hours (at most 50 each), the agent\'s record of approved actions, the end of the agent\'s own log, and the end of the newest RustDesk service log. At most 12 KB from each and 40 KB in all.',
  params: z.object({}).strict(),
  warnings: [
    'Event and log text can name people, computers, files and network addresses. User-profile paths, long tokens and anything written as a password, secret, token or key are redacted, on the computer and again on receipt; other personal details may remain.',
    'Only people who may read this computer\'s event logs see what is collected.',
  ],
  verification: 'The collected text is shown on this computer\'s Actions tab, source by source, with what was shortened or missing.',
  doesNotProve: ['that the logs are complete', 'that nothing else went wrong outside the collected sources'],
  risk: () => 'high',
  maxTargets: 1,
  resultDeadlineMinutes: 30,
  direct: true,
  integration: false,
  requiresCapability: 'computers:event_logs',
  acknowledge: 'I understand that the collected text may include personal details that redaction does not catch.',
};

// ── Running an approved library script (0.34) ───────────────────────────────
// The one entry whose effect is not fixed by the catalog: it runs a script.
// It can only name a library version whose exact SHA-256 the approval signer
// put on its OWN allowlist after its approvers read the content
// (script-run.ts, docs/script-library.md). Parameters are closed — a
// version, its hash, typed arguments, a timeout from a fixed list — and the
// arguments are checked against the version's declared schema by the
// portal, the signer and the agent. Always high impact; never offered to
// ClientSt0r; requested through the script-run module, not the Actions tab.

export const SCRIPT_RUN: CatalogAction = {
  id: 'windows.script.run', // = SCRIPT_RUN_ACTION; written out so the catalog's ids read as one list (§ 14)
  version: 1,
  title: 'Run an approved script',
  description: `Runs one approved script-library version, whose exact SHA-256 the approval signer has on its own allowlist, as SYSTEM in Windows PowerShell (no profile, not interactive) in a fresh temporary folder, with the declared arguments. Stopped at the timeout (${TIMEOUT_MINUTES.join(', ')} minutes); the first ${MAX_SCRIPT_OUTPUT_BYTES / 1024} KB of each of its output and error streams are kept, redacted.`,
  params: ScriptRunParams,
  warnings: [
    'The script runs as SYSTEM with full PowerShell: it can do anything an administrator can on each computer. The timeout, the output limits and the temporary folder limit accidents; they do not stop a script that means harm. Read the script before you approve.',
    'The agent runs exactly the bytes whose SHA-256 is shown here and refuses any others. Approving this plan approves those bytes, with these arguments, on these computers.',
    'A script stopped at its timeout may have done part of its work. Everything it started is stopped with it.',
    'Its output can contain personal details redaction does not catch. Output is kept for 90 days and shown on each computer\'s Actions tab.',
  ],
  verification: 'Each computer reports the script\'s exit code, whether it was stopped at the timeout, how long it ran, and its output and errors (bounded and redacted, on the computer and again on receipt).',
  doesNotProve: ['that the script did what its description says', 'that a zero exit code means success, unless the script makes it so', 'that nothing else changed'],
  risk: () => 'high',
  maxTargets: MAX_RING_TARGETS,
  // The longest timeout, plus a heartbeat or two either side.
  resultDeadlineMinutes: 90,
  direct: false,
  integration: false,
  acknowledge: 'I understand that this runs the script as SYSTEM on every computer named, and that a stopped script may have done part of its work.',
};

export const CATALOG: CatalogAction[] = [SERVICE_START, UPDATE_INSTALL, SERVICE_RESTART, REBOOT_SCHEDULE, REBOOT_CANCEL, LOGS_COLLECT, SCRIPT_RUN];

/** The log sources windows.logs.collect returns, in order; the agent sends the same. */
export const LOG_SOURCES = ['system_errors', 'application_errors', 'agent_journal', 'agent_log', 'rustdesk_log'] as const;
export const MAX_LOG_SECTION_CHARS = 12 * 1024;
export const MAX_LOGS_CHARS = 40 * 1024;
export const catalogEntry = (id: string, version: number) => CATALOG.find((a) => a.id === id && a.version === version) ?? null;

/** Approvals required by risk. The agent enforces the same minimums. */
export const APPROVALS_REQUIRED: Record<Risk, number> = { low: 1, high: 2 };
/** The most any action allows; each action sets its own (maxTargets). */
export const MAX_TARGETS = MAX_RING_TARGETS;
/** Longest window a requester may ask for. */
export const MAX_WINDOW_HOURS = 24;

const Id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const Iso = z.string().datetime();

export const Target = z.object({
  endpointId: Id,
  businessId: Id,
  businessName: z.string().max(120),
  hostname: z.string().max(64),
  deviceClass: z.string().max(32),
  rustdeskId: z.string().regex(/^[0-9]{6,15}$/),
  /** sha256(device secret) — the agent recomputes it from its own state. */
  deviceSecretSha256: Hex64,
}).strict();

export const Approver = z.object({
  userId: Id,
  name: z.string().max(120),
  role: z.enum(['approver', 'customer']),
  credentialSha256: Hex64,
  at: Iso,
}).strict();

/** What the approver sees and signs. Every field is bound by the signature. */
export const Plan = z.object({
  schema: z.literal(PLAN_SCHEMA),
  jobId: z.string().regex(/^[a-f0-9]{32}$/),
  action: z.object({ id: z.string(), version: z.number().int().positive() }).strict(),
  /** The signed agent build that may execute it (TUF target windows/rem0te-agent.exe). */
  artifact: z.object({ target: z.literal('windows/rem0te-agent.exe'), sha256: Hex64 }).strict(),
  params: z.record(z.string(), z.unknown()),
  targets: z.array(Target).min(1).max(MAX_TARGETS),
  requestedBy: z.object({ userId: Id, name: z.string().max(120), via: z.enum(['portal', 'clientst0r']) }).strict(),
  /** Where the suggestion came from; an AI suggestion still needs every approval. */
  origin: z.object({ kind: z.enum(['technician', 'ai_suggestion']), ticketRef: z.string().max(200).nullable() }).strict(),
  reason: z.string().min(3).max(500),
  policy: z.object({
    risk: z.enum(['low', 'high']),
    approvalsRequired: z.number().int().min(1).max(5),
    customerSignoff: z.boolean(),
  }).strict(),
  window: z.object({ notBefore: Iso, notAfter: Iso }).strict(),
  /**
   * What the approver is shown about the parameters (v0.27): an update's KB
   * and title, as the computers reported them. Signed with everything else,
   * but never consulted by the agent, which decides from Windows Update's own
   * answer — so a misleading title can mislabel an update, never widen what
   * is installed.
   */
  display: z.object({
    updates: z.array(z.object({
      updateId: z.string().regex(UPDATE_ID_RE), revision: z.number().int(), kb: z.string().max(16).nullable(),
      title: z.string().max(300), className: z.string().max(64).nullable(), severity: z.string().max(32).nullable(),
    }).strict()).max(MAX_UPDATES_PER_PLAN),
    deployment: z.object({ id: Id, name: z.string().max(120), ring: z.number().int().min(0).max(9), rings: z.number().int().min(1).max(10) }).strict().nullable(),
    /** 0.32: the patch policy this plan was signed under, if any (the signer checks it is the one it holds). */
    policy: z.object({ id: z.string().regex(/^[a-f0-9]{32}$/), name: z.string().max(120), digest: Hex64 }).strict().optional(),
  }).strict().optional(),
  /**
   * 0.34, windows.script.run only: the signer's allowlist entry for the
   * version it runs (script-run.ts ScriptBlock). Bound by the signature; the
   * signer refuses a plan whose block is not exactly its entry.
   */
  script: ScriptBlock.optional(),
  createdAt: Iso,
  /** Filled in by the signer when the quorum is met. */
  approvers: z.array(Approver).max(6),
  signedAt: Iso.nullable(),
}).strict();
export type Plan = z.infer<typeof Plan>;

export const Envelope = z.object({
  schema: z.literal(ENVELOPE_SCHEMA),
  kid: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/),
  /** base64 of the exact canonical plan bytes that were signed. */
  plan: z.string().max(65536),
  /** base64 Ed25519 signature over PLAN_SIGNING_PREFIX + plan bytes. */
  sig: z.string().max(200),
}).strict();
export type Envelope = z.infer<typeof Envelope>;

/** Validate the action-specific parts of a plan against the catalog. */
export function validatePlanAction(p: Plan): { ok: true; action: CatalogAction } | { ok: false; reason: string } {
  const a = catalogEntry(p.action.id, p.action.version);
  if (!a) return { ok: false, reason: 'unknown_action' };
  if (!a.params.safeParse(p.params).success) return { ok: false, reason: 'params_not_allowed' };
  const sp = scriptPlanProblem(p);
  if (sp) return { ok: false, reason: sp };
  if (p.targets.length > a.maxTargets) return { ok: false, reason: 'too_many_targets' };
  const eps = new Set(p.targets.map((t) => t.endpointId)), rids = new Set(p.targets.map((t) => t.rustdeskId));
  if (eps.size !== p.targets.length || rids.size !== p.targets.length) return { ok: false, reason: 'duplicate_target' };
  const risk = a.risk(p.targets);
  if (p.policy.risk !== risk) return { ok: false, reason: 'risk_mismatch' };
  if (p.policy.approvalsRequired < APPROVALS_REQUIRED[risk]) return { ok: false, reason: 'too_few_approvals_required' };
  const nb = Date.parse(p.window.notBefore), na = Date.parse(p.window.notAfter);
  if (!(na > nb) || na - nb > (a.maxWindowHours ?? MAX_WINDOW_HOURS) * 3600_000) return { ok: false, reason: 'bad_window' };
  return { ok: true, action: a };
}

/**
 * Suggestions that can never become a plan, whatever the catalog grows into.
 * Used to label ClientSt0r proposals that name something outside the catalog.
 */
export const BLOCKED_CATEGORIES = ['arbitrary_command', 'credential_extraction', 'backup_removal', 'defense_disable', 'admin_grant', 'disk_wipe'] as const;

/** The digest an approver is shown and assents to: the plan before anyone approved it. */
export function planDigest(p: Plan): string {
  return createHash('sha256').update(canonicalJson({ ...p, approvers: [], signedAt: null })).digest('hex');
}
