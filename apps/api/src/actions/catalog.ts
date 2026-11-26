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
 * Twelve actions. Starting the Print Spooler on one computer (0.26); installing
 * named Windows updates on a ring of computers (0.27); four maintenance
 * actions (0.32): restarting one service from a fixed allowlist, scheduling a
 * warned restart, canceling it, and collecting a fixed set of logs; (0.34)
 * running one approved script-library version whose exact SHA-256 is on
 * the approval signer's own allowlist; and (0.34) installing or
 * uninstalling one allowlisted winget package, pinned by version and
 * installer SHA-256; and (0.41) removing one installed program named by its
 * uninstall registry key, whose own registered uninstaller the agent runs;
 * and (0.45) controlling one Windows service (start, stop, restart, or its
 * startup type and nothing else) and ending one process named by its id,
 * name and creation time. Nothing here can carry a
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
  /** 0.34: what ACTION_NOT_DIRECT tells someone who tries anyway (direct: false only). */
  indirectVia?: string;
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
  /** 0.79 (§89): how this action is undone, the same kind and action as the agent's catalog. */
  rollback: Rollback;
  /** 0.79 (§89): whether running it again for the same parameters is harmless, the same flag as the agent's Repeatable. */
  repeat: Repeat;
}

/**
 * 0.79 (§89): how a catalog action is undone. `none`: nothing Rem0te can
 * send undoes it (`how` says what a person can do); `inverse`: another
 * catalog action, or the same one with other parameters, named by `via`;
 * `read_only`: it changes nothing. The agent's RollbackKinds, in the same
 * order (tools/windows-installer/internal/action/catalog.go).
 */
export const ROLLBACK_KINDS = ['none', 'inverse', 'read_only'] as const;
export type RollbackKind = (typeof ROLLBACK_KINDS)[number];
export interface Rollback {
  kind: RollbackKind;
  /** The catalog action that undoes it; only for `inverse`. */
  via?: string;
  /** One or two sentences for the console and the docs. */
  how: string;
}
/**
 * 0.79 (§89): safe to repeat means a second run of the same action with the
 * same parameters changes nothing the first did not, so the bounded retry
 * planned next (roadmap 2.2) may run it again. Nothing retries yet; this is
 * data, shown before the request and on the job.
 */
export interface Repeat { safe: boolean; why: string }

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
  rollback: { kind: 'inverse', via: 'windows.service.control', how: 'Stop the spooler again from the Services tab. Anything that printed when it started cannot be recalled.' },
  repeat: { safe: true, why: 'Starting a running spooler changes nothing: the computer reports it was already running.' },
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
/**
 * 0.54, at the owner's request ("no restart while someone is signed in — this
 * shouldn't be a thing as people leave themselves logged in"): a signed-in
 * Windows user never holds a restart back. Only a technician's RustDesk
 * session does, and only without the signed exception. Said wherever a
 * restart is offered.
 */
export const SIGNED_IN_USER_NOTE = `A signed-in user does not stop the restart. They see the ${UPDATE_RESTART_WARNING_MINUTES}-minute warning, and unsaved work is lost.`;
/**
 * 0.54, at the owner's request ("there should be an override exception
 * checkbox"): the explicit, per-request exception to the RustDesk-session
 * rule. A closed boolean, `ignoreRemoteSession: true`, present only when
 * ticked; never ticked by default. The agent still shows the fixed warning.
 */
export const IGNORE_REMOTE_SESSION_LABEL = 'Restart even if a technician is connected through RustDesk (their session is dropped)';
/** 0.54: the restart flags an agent before 0.54 refuses (closed params), and the version that accepts them. */
export const RESTART_FLAGS = ['onlyIfRequired', 'ignoreRemoteSession'] as const;
export const RESTART_FLAGS_MIN_AGENT = '0.54.0';
export const restartFlagsUsed = (params: unknown): string[] => RESTART_FLAGS.filter((k) => (params as Record<string, unknown> | null)?.[k] !== undefined);
/** Said wherever the restart rule is offered or described. */
export const REBOOT_UNPROVEN = 'The in-window restart has been tested against a simulated Windows only; it has not yet run on a real Windows computer.';

export const UPDATE_INSTALL: CatalogAction = {
  id: 'windows.update.install',
  version: 1,
  title: 'Install Windows updates',
  description: 'Downloads and installs the named Windows updates from Windows Update on each named device, then reports each update\'s result. It restarts a device only if the plan\'s restart rule allows it and Windows says a restart is required; by default it never does.',
  params: z.object({
    updates: z.array(UpdateIdentity).min(1).max(MAX_UPDATES_PER_PLAN)
      .refine((u) => new Set(u.map((x) => `${x.updateId}@${x.revision}`)).size === u.length, 'duplicate update'),
    reboot: UpdateReboot,
    // 0.54: the owner's exception to the RustDesk-session rule (see
    // IGNORE_REMOTE_SESSION_LABEL). Present only when true, and only beside
    // if_required_in_window; the agent honours it only from the signed plan.
    ignoreRemoteSession: z.literal(true).optional(),
    // 0.32: a plan signed under a patch policy carries the policy's filter,
    // and the agent applies it to Windows Update's own answer
    // (patch.InstallFiltered). It can only narrow what Eligible allows.
    allow: UpdateFilter.optional(),
  }).strict().refine((p) => !p.ignoreRemoteSession || p.reboot === 'if_required_in_window', 'ignoreRemoteSession only with if_required_in_window'),
  warnings: [
    'Installing updates changes the computer. An update can break a driver or an application, and some cannot be uninstalled.',
    'Many updates need a restart before they take effect. With the restart rule "never", the computer is not restarted: until someone restarts it, it keeps running the old code and reports "restart required".',
    `With the restart rule "restart if required, inside the window", a computer that Windows says needs a restart after the install shows the fixed restart warning and restarts ${UPDATE_RESTART_WARNING_MINUTES} minutes later: programs still open are closed without saving. ${SIGNED_IN_USER_NOTE} It does not restart while a technician is connected through RustDesk (or when it cannot tell) unless the plan carries the RustDesk-session exception, or if the restart would fall after the plan's window closes; it reports the restart deferred and leaves the computer as it is. ${REBOOT_UNPROVEN}`,
    'Updates download from Microsoft. People using the computer may notice it slow down while they install.',
    'Each computer installs only the named updates that Windows Update offers it and that are security, critical, rollup, ordinary, driver or definition updates. Feature upgrades, feature and service packs, tools and optional updates are never installed, and no licence is accepted on anyone\'s behalf.',
  ],
  verification: 'Each computer reports what Windows Update said for every named update, whether a restart is pending, and — under the in-window rule — whether it scheduled a restart and for when, or why it deferred it. A later scan, after any restart, shows whether the update took effect.',
  doesNotProve: ['that the update fixed any problem', 'that applications still work afterwards', 'that a scheduled restart happened (a later scan with no restart pending shows that)'],
  // Software installation is high impact on any computer, at any count.
  risk: () => 'high',
  maxTargets: MAX_RING_TARGETS,
  resultDeadlineMinutes: 6 * 60,
  direct: false,
  indirectVia: 'Windows updates are installed through a patch deployment, ring by ring, not one computer at a time.',
  integration: true,
  acknowledge: 'I understand that these updates change the computers, may need a restart, and that under the in-window rule the computers restart after a fixed warning.',
  rollback: { kind: 'none', how: 'No catalog action uninstalls an update. Remove it on the computer (Settings, Windows Update, Update history, Uninstall updates) where Microsoft allows it; servicing stack updates and some cumulative updates cannot be removed.' },
  repeat: { safe: true, why: 'Windows Update skips an update that is already installed, so a second run installs nothing and so restarts nothing for this plan.' },
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
  rollback: { kind: 'none', how: 'Usually nothing to undo: the service ends running, as it was. If it had been stopped, it can be stopped again from the Services tab (except RustDesk, which is kept running).' },
  repeat: { safe: true, why: 'It always ends with the service running. Each run interrupts the service once more, and a RustDesk restart still waits for no open session.' },
};

/** Restart warning bounds, minutes; the agent enforces the same. */
export const MIN_RESTART_DELAY_MINUTES = 5;
export const MAX_RESTART_DELAY_MINUTES = 24 * 60;
const DELAYS = [5, 15, 30, 60, 120, 240, 480, 1440];

export const REBOOT_SCHEDULE: CatalogAction = {
  id: 'windows.reboot.schedule',
  version: 1,
  title: 'Schedule a restart',
  description: 'Shows a fixed restart warning on the device and restarts it when the chosen delay has passed (5 minutes to 24 hours after the device receives the plan). Never immediately. It can be scheduled for a date and time up to 14 days ahead (0.54), and asked to restart only if Windows reports a restart required.',
  // 0.54: two optional flags, each present only when true (RestartFlags on the agent).
  params: z.object({
    delayMinutes: z.number().int().min(MIN_RESTART_DELAY_MINUTES).max(MAX_RESTART_DELAY_MINUTES),
    onlyIfRequired: z.literal(true).optional(),
    ignoreRemoteSession: z.literal(true).optional(),
  }).strict(),
  warnings: [
    'When the delay ends, Windows closes every program still open without saving. Anything not saved by then is lost.',
    SIGNED_IN_USER_NOTE.replace(`the ${UPDATE_RESTART_WARNING_MINUTES}-minute warning`, 'the warning'),
    'The person at the computer sees this warning, in this wording: "Your IT support provider has scheduled a restart of this computer for <time> (in <N> minutes). Please save your work and close your programs before then: programs still open will be closed without saving. Approved maintenance, reference <job>."',
    'The delay counts from when the computer receives the approved plan, at its next check-in after approval. The plan expires unrun if that is not within 2 hours of its start.',
    'The computer skips the restart if a technician is connected through RustDesk, or if it cannot tell — unless the plan carries the RustDesk-session exception, which restarts anyway and drops the session. It checks once, when it schedules: someone who connects afterwards sees the Windows warning on screen.',
    'With "only if a restart is required", the computer decides when it receives the plan, from Windows\' own pending-restart state; if none is pending it does nothing. That option needs the 0.54 agent.',
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
  rollback: { kind: 'inverse', via: 'windows.reboot.cancel', how: 'Cancel the scheduled restart before its warning runs out. Once the computer has restarted there is nothing to undo, and unsaved work does not come back.' },
  repeat: { safe: false, why: 'Once the first restart has happened, a second run restarts the computer again. While the first is still pending, Windows refuses the second (restart already scheduled).' },
};

export const REBOOT_CANCEL: CatalogAction = {
  id: 'windows.reboot.cancel',
  version: 1,
  title: 'Cancel a scheduled restart',
  description: 'Cancels the restart or shutdown Windows has pending on this device, if there is one.',
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
  rollback: { kind: 'inverse', via: 'windows.reboot.schedule', how: 'Schedule a new restart. It cannot bring back the canceled one at its original time or with its original message.' },
  repeat: { safe: true, why: 'With no restart pending the computer reports no change and does nothing.' },
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
  rollback: { kind: 'read_only', how: 'Nothing to undo: it only reads. Nothing on the computer changes.' },
  repeat: { safe: true, why: 'It only reads; a second run collects a newer copy.' },
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
  indirectVia: 'Scripts are run from an approved version in the script library, which names the script and its allowlist entry.',
  integration: false,
  acknowledge: 'I understand that this runs the script as SYSTEM on every computer named, and that a stopped script may have done part of its work.',
  rollback: { kind: 'none', how: 'What a script changes is its own. Its library version should say how to undo it, and undoing it is another approved script.' },
  repeat: { safe: false, why: 'The catalog cannot know whether a script does the same thing twice, so a run is never treated as safe to repeat.' },
};

// ── Software deployment (0.34) ─────────────────────────────────────────────
// Install or uninstall one allowlisted winget package, pinned by version and
// installer SHA-256. Keep in step with
// tools/windows-installer/internal/action/software.go: the agent re-checks
// every value below, downloads with winget, hashes the installer itself and
// refuses a mismatch before installing (docs/software-deployment.md).

/** A winget package identifier: dot-separated segments; never starts with '-', no spaces, quotes or shell characters. */
// eslint-disable-next-line security/detect-unsafe-regex -- every repetition starts with a literal '.', which the segment class excludes: no overlap to backtrack over
export const PACKAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9+_-]{0,63}(\.[A-Za-z0-9+_-]{1,64}){1,7}$/;
export const PACKAGE_ID_MAX = 128;
/** A package (or detected) version: never starts with '-'. */
export const SOFTWARE_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;
/** An installed program's display name, as Programs and Features shows it. */
export const DISPLAY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._()+&,'-]{0,119}$/;
/** An uninstall registry subkey name (no backslash: one key, never a path). */
export const UNINSTALL_KEY_RE = /^[A-Za-z0-9{}][A-Za-z0-9{}._+ -]{0,127}$/;
const FILE_SEGMENT_RE = /^[A-Za-z0-9 ._()+-]{1,64}$/;
/** A file under Program Files: up to 8 plain segments, the last an .exe or .dll. Read for its version only. */
export function fileUnderBaseOk(f: string): boolean {
  if (typeof f !== 'string' || f.length < 1 || f.length > 200) return false;
  const segs = f.split('\\');
  if (segs.length > 8) return false;
  if (!segs.every((s) => FILE_SEGMENT_RE.test(s) && s !== '.' && s !== '..' && !s.startsWith(' ') && !s.endsWith(' ') && !s.endsWith('.'))) return false;
  return /\.(exe|dll)$/i.test(segs[segs.length - 1]);
}
const SwVersion = z.string().regex(SOFTWARE_VERSION_RE);
const Compare = z.enum(['gte', 'eq']);
/** How a computer tells the package is there: three closed forms, nothing that runs. */
export const Detection = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('display_name'), name: z.string().regex(DISPLAY_NAME_RE), match: z.enum(['exact', 'prefix']), compare: Compare, version: SwVersion }).strict(),
  z.object({ kind: z.literal('uninstall_key'), key: z.string().regex(UNINSTALL_KEY_RE), compare: Compare, version: SwVersion }).strict(),
  z.object({ kind: z.literal('file_version'), base: z.enum(['ProgramFiles', 'ProgramFilesX86']), file: z.string().refine(fileUnderBaseOk, 'a file under the base: plain segments, ending .exe or .dll'), compare: Compare, version: SwVersion }).strict(),
]);
export type Detection = z.infer<typeof Detection>;
/** The closed parameters both software actions sign. */
export const SoftwareParams = z.object({
  packageId: z.string().max(PACKAGE_ID_MAX).regex(PACKAGE_ID_RE),
  version: SwVersion,
  installerSha256: z.string().regex(SHA256_RE),
  scope: z.literal('machine'),
  detection: Detection,
}).strict();
export type SoftwareParams = z.infer<typeof SoftwareParams>;
/** What the approval page shows about a software plan. Signed, never consulted by the agent. */
export const SoftwareDisplay = z.object({
  name: z.string().max(120), publisher: z.string().max(120).nullable(),
  hashSource: z.enum(['winget_pkgs', 'admin_pasted']), manifestSha256: z.string().regex(SHA256_RE).nullable(),
  entryId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/), entryRevision: z.number().int().min(1),
}).strict();

export const SOFTWARE_INSTALL: CatalogAction = {
  id: 'windows.software.install',
  version: 1,
  title: 'Install software (winget)',
  description: 'Installs one allowlisted winget package at one exact version, machine-wide and silently. The device downloads it from winget\'s own source, hashes the installer itself and installs only if the hash is the one pinned here.',
  params: SoftwareParams,
  warnings: [
    'Installing software changes the computer. An installer can replace files, add services or startup items, and change other programs.',
    'The installer comes from the winget community source (winget-pkgs), not from rem0te. Its hash is pinned and checked by each computer before installing; who published the package is the package\'s own claim.',
    'Some installers close running copies of the program, or need a restart before the program works. This plan never restarts a computer.',
    'Dependencies are not installed. A package that needs another one needs it as its own catalog entry, installed first.',
    'Accepting the package and source agreements is part of the plan: winget is told the agreements are accepted on the business\'s behalf.',
  ],
  verification: 'Each computer reports the hash it computed, winget\'s exit code, and what the detection rule saw before and after.',
  doesNotProve: ['that the program works', 'that the publisher is who the package claims', 'that nothing else changed on the computer'],
  // Software installation is high impact on any computer, at any count.
  risk: () => 'high',
  maxTargets: MAX_RING_TARGETS,
  resultDeadlineMinutes: 90,
  direct: false,
  indirectVia: 'Software is installed from the software catalog, as a deployment (one computer, or a canary and rings).',
  integration: false,
  acknowledge: 'I understand that this installs software on the computers, and that I accept the package and source agreements on the business\'s behalf.',
  rollback: { kind: 'inverse', via: 'windows.software.uninstall', how: 'Uninstall the same package from the Software tab. An install that upgraded an older version does not bring that version back.' },
  repeat: { safe: true, why: 'The computer checks the detection rule first: a package already installed is reported as no change and nothing is run.' },
};

export const SOFTWARE_UNINSTALL: CatalogAction = {
  id: 'windows.software.uninstall',
  version: 1,
  title: 'Uninstall software (winget)',
  description: 'Uninstalls one allowlisted winget package, machine-wide and silently, then checks with the detection rule that it is gone.',
  params: SoftwareParams,
  warnings: [
    'Uninstalling removes the program for everyone on the computer. Its settings and data may be removed with it.',
    'Running copies of the program may be closed without saving.',
    'It removes whatever version of the package winget finds installed, not only the version pinned here.',
  ],
  verification: 'Each computer reports winget\'s exit code and whether the detection rule still finds the program afterwards.',
  doesNotProve: ['that every file and setting was removed', 'that nothing depended on the program'],
  risk: () => 'high',
  maxTargets: MAX_RING_TARGETS,
  resultDeadlineMinutes: 60,
  direct: false,
  indirectVia: 'Software is uninstalled from the software catalog, as a deployment (one computer, or a canary and rings).',
  integration: false,
  acknowledge: 'I understand that this removes the program for everyone on the computers.',
  rollback: { kind: 'inverse', via: 'windows.software.install', how: 'Install the catalog\'s pinned version again. That may not be the version removed, and settings or data the uninstaller deleted do not come back.' },
  repeat: { safe: true, why: 'The computer checks the detection rule first: a package not installed is reported as no change and nothing is run.' },
};

// Remove one installed program by its uninstall key (0.41). Keep in step with
// tools/windows-installer/internal/action/remove.go: the plan names the key,
// its registry view and the DisplayName expected there — never a command —
// and the agent reads the key itself, refuses if it names another program,
// and runs only msiexec /x for an MSI product, the key's own
// QuietUninstallString, or (0.42) one of the closed silent forms it
// recognises in the key's UninstallString — Inno Setup, NSIS, Chromium
// (docs/software-deployment.md). RustDesk and Rem0te are never removed.

/** An uninstall subkey name, as Programs and Features lists it (no backslash: one key, never a path). */
export const PROGRAM_KEY_RE = /^[A-Za-z0-9{}][A-Za-z0-9{}()._+ ,&'!-]{0,127}$/;
/** The DisplayName the plan expects to find there. Compared on the computer, never run. */
// eslint-disable-next-line no-control-regex -- refusing control characters is the point
export const PROGRAM_NAME_RE = /^[^\x00-\x1f\x7f"<>\\]{1,200}$/;
export const programNameOk = (s: string) => PROGRAM_NAME_RE.test(s) && s.trim() === s;
/**
 * 0.42: never removed from here — RustDesk is how the computer is reached at
 * all, and Rem0te is the agent and tray. The same expression as the agent's
 * ProtectedProgramPattern (remove.go), case-insensitive, matched against the
 * display name and the key.
 */
export const PROTECTED_PROGRAM_RE = /^(?:rustdesk|rem0te|reboot ?remote)(?:[^a-z0-9]|$)/i;
export const isProtectedProgram = (key: string | null | undefined, name: string | null | undefined) =>
  PROTECTED_PROGRAM_RE.test((name ?? '').trim()) || PROTECTED_PROGRAM_RE.test(key ?? '');
/** The removal kinds the inventory collector reports (0.42); the first five are removable. */
export const REMOVAL_KINDS = ['msi', 'quiet', 'inno', 'nsis', 'chromium', 'office', 'driver', 'none'] as const;
export type RemovalKind = (typeof REMOVAL_KINDS)[number];
export const REMOVABLE_KINDS: ReadonlySet<RemovalKind> = new Set(['msi', 'quiet', 'inno', 'nsis', 'chromium']);
/** The closed parameters windows.software.remove signs. */
export const RemoveParams = z.object({
  key: z.string().regex(PROGRAM_KEY_RE),
  view: z.enum(['64', '32']),
  displayName: z.string().refine(programNameOk, 'a display name without control characters, quotes, angle brackets or backslashes'),
}).strict();
export type RemoveParams = z.infer<typeof RemoveParams>;

export const SOFTWARE_REMOVE: CatalogAction = {
  id: 'windows.software.remove',
  version: 1,
  title: 'Remove an installed program',
  description: 'Removes one program Programs and Features lists, by its uninstall registry key. The device reads the key itself and runs only Windows Installer (msiexec /x, for an MSI product), the program\'s own registered silent uninstall command, or its registered uninstaller in one of the silent forms the agent recognises (Inno Setup, NSIS, Chromium). RustDesk and Rem0te are never removed.',
  params: RemoveParams,
  warnings: [
    'Uninstalling removes the program for everyone on the computer. Its settings and data may be removed with it.',
    'Running copies of the program may be closed without saving.',
    'For a program that is not a Windows Installer product, what runs is the uninstaller the program registered: its QuietUninstallString, or its UninstallString with the silent switch that installer type defines (Inno Setup /VERYSILENT, NSIS /S, Chromium --force-uninstall). rem0te did not write it and cannot vouch for what it does. A program whose uninstaller is of no form the agent recognises is refused rather than left waiting for a click.',
    'This plan never restarts the computer.',
  ],
  verification: 'The computer checks that the uninstall key names the program this plan was made for before running anything, and reports whether the key is gone afterwards.',
  doesNotProve: ['that every file and setting was removed', 'that nothing depended on the program'],
  risk: () => 'high',
  // A key is one computer's.
  maxTargets: 1,
  resultDeadlineMinutes: 60,
  direct: false,
  indirectVia: 'An installed program is removed from the computer\'s Software tab (Installed software, Uninstall).',
  integration: false,
  acknowledge: 'I understand that this removes the program for everyone on the computer, by running its own uninstaller.',
  rollback: { kind: 'none', how: 'The program\'s own uninstaller ran. Reinstall it from its vendor, or install its package if it is in the software catalog. What the uninstaller deleted does not come back.' },
  repeat: { safe: true, why: 'The computer reads the uninstall key first: once it is gone, a second run reports no change and runs nothing, and a key whose name changed is refused.' },
};

// ── Service control and ending a process (0.45) ────────────────────────────
// Keep in step with tools/windows-installer/internal/action/{svcctl,procstop}.go:
// the same charsets, operations, start types and protected lists, which
// § 60 of scripts/check-security-invariants.mjs compares. The agent reads
// the service or process itself and refuses one that changed; the portal
// first refuses anything its own latest snapshot does not list.

/** Said wherever these two actions are offered or described. */
export const SERVICE_PROCESS_UNPROVEN = 'Service control and ending a process have been tested against a simulated Windows only; they have not yet run on a real Windows computer.';

/** A service name: the same charset as windows.service.restart (the agent's ServiceNameRE). */
export const SERVICE_NAME_RE = /^[A-Za-z0-9_]{1,64}$/;
/** The display name the plan expects to find. Compared on the computer, never run. */
// eslint-disable-next-line no-control-regex -- refusing control characters is the point
export const SERVICE_DISPLAY_NAME_RE = /^[^\x00-\x1f\x7f"<>\\]{1,256}$/;
export const serviceDisplayNameOk = (s: string) => SERVICE_DISPLAY_NAME_RE.test(s) && s.trim() === s;
export const SERVICE_OPS = ['start', 'stop', 'restart', 'set_start_type'] as const;
export type ServiceOp = (typeof SERVICE_OPS)[number];
export const SERVICE_START_TYPES = ['automatic', 'automatic_delayed', 'manual', 'disabled'] as const;
export type ServiceStartType = (typeof SERVICE_START_TYPES)[number];

/**
 * Never started, stopped, restarted or reconfigured from here, whatever the
 * operation (the agent's ProtectedServices; svcctl.go says why each group).
 * Security: Defender, Defender for Endpoint, Windows Security, the firewall
 * and its filtering engine, System Guard, web threat defence, the event log,
 * the security accounts manager, key isolation, the credential vault, domain
 * logon, cryptographic services, Group Policy. Core: RPC, DCOM, the session
 * manager, Plug and Play, Power, user profiles, WMI, the Modules Installer,
 * the shell's brokers, elevation. Task Scheduler, which runs the agent's
 * heartbeat. DHCP, DNS Client, Network Store Interface and Workstation, which
 * keep the computer reachable.
 */
export const PROTECTED_SERVICES = [
  // Security
  'WinDefend', 'WdNisSvc', 'MDCoreSvc', 'Sense', 'SecurityHealthService', 'wscsvc', 'mpssvc', 'BFE', 'SgrmBroker', 'webthreatdefsvc',
  'EventLog', 'SamSs', 'KeyIso', 'VaultSvc', 'Netlogon', 'CryptSvc', 'gpsvc',
  // Core
  'RpcSs', 'RpcEptMapper', 'DcomLaunch', 'LSM', 'PlugPlay', 'Power', 'ProfSvc', 'Winmgmt', 'TrustedInstaller',
  'BrokerInfrastructure', 'SystemEventsBroker', 'CoreMessagingRegistrar', 'StateRepository', 'UserManager', 'EventSystem', 'Appinfo',
  // The heartbeat
  'Schedule',
  // Reachability
  'Dhcp', 'Dnscache', 'nsi', 'LanmanWorkstation',
] as const;
/** Any service whose name starts with this is Rem0te's own (the agent's OwnServicePrefix). */
export const OWN_SERVICE_PREFIX = 'Rem0te';
/** Started, restarted or set to start automatically, never stopped or set to Manual or Disabled: how the computer is reached. */
export const KEEP_RUNNING_SERVICES = ['RustDesk'] as const;
/** Never set to Disabled: Windows Update and what it needs to deliver updates. */
export const NO_DISABLE_SERVICES = ['wuauserv', 'UsoSvc', 'WaaSMedicSvc', 'BITS'] as const;

const inFold = (list: readonly string[], s: string) => list.some((x) => x.toLowerCase() === s.toLowerCase());
export type ServiceRefusalCode = 'own' | 'protected' | 'keep_running' | 'no_disable';
/** Why this operation on this service is refused, or null. The same rules as the agent's ServiceRefusal. */
export function serviceRefusal(name: string, op: ServiceOp, startType?: ServiceStartType | null): { code: ServiceRefusalCode; reason: string } | null {
  if (name.slice(0, OWN_SERVICE_PREFIX.length).toLowerCase() === OWN_SERVICE_PREFIX.toLowerCase()) return { code: 'own', reason: 'This is Rem0te\'s own service; it is never changed from here.' };
  if (inFold(PROTECTED_SERVICES, name)) return { code: 'protected', reason: 'A protected security or core Windows service: stopping, restarting or reconfiguring it can leave the device unprotected, unbootable or unreachable.' };
  if (inFold(KEEP_RUNNING_SERVICES, name) && (op === 'stop' || (op === 'set_start_type' && startType !== 'automatic' && startType !== 'automatic_delayed'))) return { code: 'keep_running', reason: 'RustDesk is how this device is reached: it can be started, restarted or set to start automatically, never stopped or set to Manual or Disabled.' };
  if (inFold(NO_DISABLE_SERVICES, name) && op === 'set_start_type' && startType === 'disabled') return { code: 'no_disable', reason: 'A Windows Update service: disabling it stops the device receiving updates.' };
  return null;
}

/**
 * The closed parameters windows.service.control signs: the service, the
 * display name the snapshot showed, the operation, and for set_start_type
 * the start type. Nothing else — never a binary path, account, password,
 * recovery action or dependency, each of which would be code execution as
 * SYSTEM.
 */
export const ServiceControlParams = z.union([
  z.object({ service: z.string().regex(SERVICE_NAME_RE), displayName: z.string().refine(serviceDisplayNameOk), op: z.enum(['start', 'stop', 'restart']) }).strict(),
  z.object({ service: z.string().regex(SERVICE_NAME_RE), displayName: z.string().refine(serviceDisplayNameOk), op: z.literal('set_start_type'), startType: z.enum(SERVICE_START_TYPES) }).strict(),
]);
export type ServiceControlParams = z.infer<typeof ServiceControlParams>;

export const SERVICE_CONTROL: CatalogAction = {
  id: 'windows.service.control',
  version: 1,
  title: 'Control a Windows service',
  description: 'Starts, stops or restarts one Windows service, or changes its startup type (Automatic, Automatic (delayed), Manual, Disabled). Nothing else about the service is ever changed: not its program, the account it runs as, its password, recovery actions or dependencies. The device reads the service itself and refuses if its display name is not the one shown here.',
  params: ServiceControlParams,
  warnings: [
    'Whatever the service was doing stops while it is stopped or restarting. Programs and other services that depend on it may stop working until it is started again.',
    'Windows refuses to stop a service that other running services depend on; the stop then fails and nothing else is stopped.',
    'A startup type change takes effect at the next restart of the computer (or of the service); it does not start or stop the service now. A Disabled service cannot be started until its startup type is changed back.',
    'Security and core Windows services, Rem0te\'s own, stopping or disabling RustDesk, and disabling Windows Update are refused here and again on the computer. Restarting RustDesk waits until no RustDesk session is open (or the computer cannot tell).',
    SERVICE_PROCESS_UNPROVEN,
  ],
  verification: 'The computer reports the service\'s state and startup type before and after; a change that did not take is reported as a failure.',
  doesNotProve: ['that whatever was failing now works', 'that programs depending on the service noticed'],
  risk: () => 'high',
  maxTargets: 1,
  resultDeadlineMinutes: 30,
  direct: false,
  indirectVia: 'Services are controlled from the computer\'s Services tab, which names a service from its latest service list.',
  integration: false,
  acknowledge: 'I understand that this changes a service on the computer, and that anything depending on it may stop working.',
  rollback: { kind: 'inverse', via: 'windows.service.control', how: 'The opposite operation from the Services tab: stop after a start, start after a stop, or the earlier startup type, which the result shows.' },
  repeat: { safe: true, why: 'A start of a running service, a stop of a stopped one and an unchanged startup type are reported as no change. A restart interrupts the service once more.' },
};

/** A process name as the process list shows it (the image name without .exe): a name, never a path. */
export const PROCESS_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.()+-]{0,63}$/;
/** The process's creation time as the portal stores it: UTC, to the millisecond. */
export const PROCESS_STARTED_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
/**
 * Never ended from here (the agent's ProtectedProcesses; procstop.go says
 * why): the kernel's own, the session and logon chain, the security
 * subsystem, every service host (svchost: stop the service instead), the
 * security products, and Rem0te's agent and tray and RustDesk.
 */
export const PROTECTED_PROCESSES = [
  'System', 'Idle', 'Registry', 'Memory Compression', 'Secure System',
  'smss', 'csrss', 'wininit', 'winlogon', 'services', 'fontdrvhost', 'dwm',
  'lsass', 'lsaiso',
  'svchost',
  'MsMpEng', 'NisSrv', 'MpDefenderCoreService', 'MsSense', 'SecurityHealthService', 'SgrmBroker',
  'rem0te-agent', 'rem0te-tray', 'rustdesk',
] as const;
/** The most processes one tree plan ends; the agent enforces the same (MaxTreeProcesses). */
export const MAX_TREE_PROCESSES = 64;
export const imageBase = (n: string) => (n.length > 4 && n.slice(-4).toLowerCase() === '.exe' ? n.slice(0, -4) : n);
/** Why this process is never ended, or null. The same rules as the agent's ProcessRefusal. */
export function processRefusal(name: string, pid: number): { code: 'kernel' | 'svchost' | 'rem0te' | 'protected'; reason: string } | null {
  const base = imageBase(name.trim()).toLowerCase();
  if (pid === 0 || pid === 4) return { code: 'kernel', reason: 'The System and Idle processes are the kernel\'s own; they cannot be ended.' };
  if (base === 'svchost') return { code: 'svchost', reason: 'svchost hosts Windows services: stop the service instead, from the Services tab.' };
  if (base === 'rem0te-agent' || base === 'rem0te-tray' || base === 'rustdesk') return { code: 'rem0te', reason: 'Rem0te and RustDesk are how this device is reached; they are never ended from here.' };
  if (inFold(PROTECTED_PROCESSES, base)) return { code: 'protected', reason: 'A protected Windows or security process: ending it can stop Windows, sign everyone out or leave the device unprotected.' };
  return null;
}
/** The closed parameters windows.process.stop signs: the process id, its name and creation time from the snapshot, and optionally its tree. */
export const ProcessStopParams = z.object({
  pid: z.number().int().min(1).max(4_294_967_295),
  name: z.string().regex(PROCESS_NAME_RE).refine((s) => s.trim() === s),
  startedAt: z.string().regex(PROCESS_STARTED_RE).refine((s) => !Number.isNaN(Date.parse(s))),
  tree: z.boolean().optional(),
}).strict();
export type ProcessStopParams = z.infer<typeof ProcessStopParams>;

export const PROCESS_STOP: CatalogAction = {
  id: 'windows.process.stop',
  version: 1,
  title: 'End a process',
  description: 'Ends one process, as Task Manager\'s End task does, optionally with the processes it started. The plan names the process id, its name and when it started; the device refuses unless all three still match, so a process id Windows has since given to another process is never ended.',
  params: ProcessStopParams,
  warnings: [
    'The process is ended at once, without being asked to close: anything it had not saved is lost.',
    'Ending a program someone is using closes it in front of them.',
    'With "and the processes it started", every process it started (and they started) is ended too, children first. If any of them is protected, nothing is ended.',
    'Windows and security processes, every service host (svchost: stop the service instead), Rem0te and RustDesk are refused here and again on the computer.',
    SERVICE_PROCESS_UNPROVEN,
  ],
  verification: 'The computer reports whether that process (that id, started at that time) is still running afterwards.',
  doesNotProve: ['that the program will not start again', 'that whatever it was doing was undone'],
  risk: () => 'high',
  maxTargets: 1,
  resultDeadlineMinutes: 30,
  direct: false,
  indirectVia: 'A process is ended from the computer\'s Processes tab, which names it from its latest process list.',
  integration: false,
  acknowledge: 'I understand that the process is ended at once and anything it had not saved is lost.',
  rollback: { kind: 'none', how: 'An ended process cannot be resumed, and what it had not saved is lost. Start the program again, or restart its service.' },
  repeat: { safe: true, why: 'The plan names the process id and its start time: once it has ended, a second run reports it is not running and changes nothing, and a new process given the same id is refused.' },
};

export const CATALOG: CatalogAction[] = [SERVICE_START, UPDATE_INSTALL, SERVICE_RESTART, REBOOT_SCHEDULE, REBOOT_CANCEL, LOGS_COLLECT, SCRIPT_RUN, SOFTWARE_INSTALL, SOFTWARE_UNINSTALL, SOFTWARE_REMOVE, SERVICE_CONTROL, PROCESS_STOP];

/** The log sources windows.logs.collect returns, in order; the agent sends the same. */
export const LOG_SOURCES = ['system_errors', 'application_errors', 'agent_journal', 'agent_log', 'rustdesk_log'] as const;
export const MAX_LOG_SECTION_CHARS = 12 * 1024;
export const MAX_LOGS_CHARS = 40 * 1024;
export const catalogEntry = (id: string, version: number) => CATALOG.find((a) => a.id === id && a.version === version) ?? null;

/** Approvals required by risk. The agent enforces the same minimums. */
export const APPROVALS_REQUIRED: Record<Risk, number> = { low: 1, high: 2 };
/**
 * Direct mode (0.40). A business the approval signer's operator set to
 * `--approval direct` has its plans signed at admission, with no approvers:
 * the plan says `policy.approval: 'direct'`, asks for 0 approvals and never
 * for customer sign-off. The agent relaxes its approval rules only on that
 * signed field (internal/action isDirect).
 */
export const DIRECT = 'direct' as const;
export const approvalsRequiredFor = (risk: Risk, direct: boolean) => (direct ? 0 : APPROVALS_REQUIRED[risk]);
/** Whether a stored plan was signed in direct mode. */
export function planDirect(plan: unknown): boolean {
  return (plan as { policy?: { approval?: unknown } } | null)?.policy?.approval === DIRECT;
}
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
    /** 0 only in direct mode (validatePlanAction). */
    approvalsRequired: z.number().int().min(0).max(5),
    customerSignoff: z.boolean(),
    /** 0.40: present only when the signer's operator set the business to direct mode. */
    approval: z.literal(DIRECT).optional(),
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
    /** 0.34: the catalog entry a software plan comes from (name, publisher, where its hash came from). */
    software: SoftwareDisplay.optional(),
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
  if (p.policy.approval === DIRECT) {
    if (p.policy.customerSignoff) return { ok: false, reason: 'direct_with_customer_signoff' };
    if (p.policy.approvalsRequired !== 0) return { ok: false, reason: 'policy_mismatch' };
  } else if (p.policy.approvalsRequired < APPROVALS_REQUIRED[risk]) return { ok: false, reason: 'too_few_approvals_required' };
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
