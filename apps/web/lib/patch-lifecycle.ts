/**
 * Patching, guided (0.94, UX P1-8; directive §14).
 *
 * Pure: no imports, no fetch, no clock. It only words what the server and the
 * device already reported:
 *
 * - the eleven lifecycle stages of an update, each with a distinct label and
 *   the evidence that proves it, and where Rem0te has no evidence, saying so
 *   instead of guessing (a download during an install, the start of an
 *   install, and a restart are never reported as events);
 * - who owns updates on a device (WSUS, Intune or another MDM, Windows Update
 *   for Business, Configuration Manager) in plain English, and that Rem0te
 *   never overrides them;
 * - optional workstation and server templates that fill in a policy form and
 *   never pick devices, never turn on a restart and never create anything.
 *
 * Nothing here approves, schedules, installs or restarts. The approval
 * signer, the device's own refusals and the staged-rollout gate are unchanged
 * (§14, §15, §37, §38, §75); the server stays the authority.
 */

// ---------------------------------------------------------------------------
// The eleven stages.

export type StageId =
  | 'scan_requested' | 'scan_completed' | 'approved' | 'downloaded' | 'install_started' | 'install_succeeded'
  | 'restart_required' | 'restart_completed' | 'verified' | 'failed' | 'unknown';

export interface Stage {
  id: StageId;
  label: string;
  /** What it means, in one sentence. */
  means: string;
  /** What Rem0te reads to say so. */
  evidence: string;
}

/** In lifecycle order; `failed` and `unknown` are outcomes that can end it at any point. */
export const PATCH_STAGES: readonly Stage[] = [
  { id: 'scan_requested', label: 'Scan requested', means: 'Rem0te asked the device to check Windows Update. Nothing has been checked yet.', evidence: 'The scan request on the device record, waiting for its next check-in.' },
  { id: 'scan_completed', label: 'Scan completed', means: 'The device checked Windows Update and reported what it offers.', evidence: 'The time of the last scan the agent sent, and no scan error.' },
  { id: 'approved', label: 'Approved', means: 'An install plan was approved: by two approvers on the approval signer, or at once in direct mode.', evidence: 'The plan\'s approval on the approval signer. Nothing installs before it.' },
  { id: 'downloaded', label: 'Downloaded', means: 'Windows Update already holds the files for an update.', evidence: 'Windows Update\'s own flag, as of the last scan. Rem0te does not see downloads while an install runs.' },
  { id: 'install_started', label: 'Installation started', means: 'The approved plan was handed to the device to run.', evidence: 'The plan being handed out. The agent does not report progress between taking a plan and its result, so this is the last point Rem0te can see before the result.' },
  { id: 'install_succeeded', label: 'Installation succeeded', means: 'Windows reported the update installed.', evidence: 'The agent\'s signed result for the plan.' },
  { id: 'restart_required', label: 'Restart required', means: 'Installed, but it takes effect only after a restart.', evidence: 'The result, or a later scan, saying Windows waits for a restart.' },
  { id: 'restart_completed', label: 'Restart completed', means: 'The device has started up again since the install.', evidence: 'The device\'s last boot time being after the install result. Rem0te never sees the restart itself.' },
  { id: 'verified', label: 'Verified after install', means: 'A later scan, after the install, no longer offers the update, records it as installed and has no restart pending.', evidence: 'A later scan. An install result alone never counts as verified.' },
  { id: 'failed', label: 'Failed', means: 'Windows reported the install failed, or a later scan offers the update again.', evidence: 'The result\'s failure, with Windows\' own error code, or a later scan.' },
  { id: 'unknown', label: 'Unknown', means: 'Rem0te cannot tell what happened.', evidence: 'No result, an uncertain result, or no scan. Unknown is never shown as healthy.' },
];

export const stageById = (id: StageId): Stage => PATCH_STAGES.find((s) => s.id === id)!;

/**
 * Every per-update state the API's `updateState` (apps/api/src/patching/posture.ts)
 * returns, as words and the lifecycle stage it is. A state that ends the update
 * without installing it (superseded, excluded, refused…) belongs to no stage.
 */
export const UPDATE_STATE: Record<string, { label: string; stage: StageId | null; variant: 'success' | 'destructive' | 'warning' | 'outline' | 'secondary' }> = {
  not_planned: { label: 'Not in this plan', stage: null, variant: 'outline' },
  awaiting_approval: { label: 'Pending approval', stage: null, variant: 'outline' },
  scheduled: { label: 'Approved, not yet handed out', stage: 'approved', variant: 'secondary' },
  delivered: { label: 'Installation started', stage: 'install_started', variant: 'secondary' },
  installed: { label: 'Installation succeeded', stage: 'install_succeeded', variant: 'secondary' },
  restart_required: { label: 'Restart required', stage: 'restart_required', variant: 'warning' },
  effective: { label: 'Verified after install', stage: 'verified', variant: 'success' },
  superseded: { label: 'Superseded', stage: null, variant: 'outline' },
  not_applicable: { label: 'No longer offered', stage: null, variant: 'outline' },
  excluded: { label: 'Excluded', stage: null, variant: 'outline' },
  failed: { label: 'Failed', stage: 'failed', variant: 'destructive' },
  refused: { label: 'Refused by the device', stage: null, variant: 'destructive' },
  not_executed: { label: 'Not executed', stage: null, variant: 'outline' },
  unknown: { label: 'Unknown', stage: 'unknown', variant: 'destructive' },
  canceled: { label: 'Canceled', stage: null, variant: 'outline' },
};

export const updateStateOf = (s: string) => UPDATE_STATE[s] ?? { label: 'Unknown', stage: 'unknown' as StageId, variant: 'destructive' as const };

// ---------------------------------------------------------------------------
// One device's lifecycle, from what the Patches tab already has.

export type StageStatus = 'done' | 'now' | 'failed' | 'not_seen' | 'not_reported';

export interface DeviceFacts {
  /** The signed agent's scan; the standard agent reports no lifecycle. */
  signed: boolean;
  scanRequestedAt: string | null;
  scanPending: boolean;
  scannedAt: string | null;
  scanError: string | null;
  /** Offered updates and how many Windows Update says are downloaded. */
  offered: number;
  downloaded: number;
  /** The latest install task's state (lib/tasks.ts TaskState), or null without one. */
  installState: string | null;
  installed: number;
  installFailed: number;
  restartRequired: boolean;
  /** Last boot after the install result (summary.restartedSinceLastInstall). */
  restartedSinceInstall: boolean | null;
  /** A scan after the install settled it (summary.confirmations[].confirmedByLaterScan). */
  verified: number;
  rebootPendingNow: boolean | null;
}

export interface StageRow { stage: Stage; status: StageStatus; note: string }

const APPROVED_STATES = new Set(['queued', 'held', 'handed_out', 'running', 'succeeded', 'restart_required', 'failed', 'refused', 'not_executed', 'uncertain', 'expired']);
const STARTED_STATES = new Set(['handed_out', 'running', 'succeeded', 'restart_required', 'failed', 'uncertain']);
const FINISHED_OK = new Set(['succeeded', 'restart_required']);

/**
 * Each of the eleven stages for one device, marked from evidence only:
 * `done` and `now` need a fact, `not_seen` means it has not happened (or
 * there is no install yet), and `not_reported` means Rem0te cannot see it.
 */
export function deviceLifecycle(f: DeviceFacts): StageRow[] {
  const row = (id: StageId, status: StageStatus, note: string): StageRow => ({ stage: stageById(id), status, note });
  if (!f.signed) {
    return PATCH_STAGES.map((s) => row(s.id, s.id === 'unknown' ? 'now' : 'not_reported', s.id === 'unknown'
      ? 'This device runs the standard agent, which lists pending updates but reports no install lifecycle.'
      : 'Not reported by the standard agent.'));
  }
  const inst = f.installState;
  const hasInstall = inst != null;
  const okFinish = inst != null && FINISHED_OK.has(inst);
  return [
    row('scan_requested', f.scanPending ? 'now' : f.scanRequestedAt ? 'done' : 'not_seen', f.scanPending ? 'Waiting for the device\'s next check-in.' : f.scanRequestedAt ? 'Asked for, and answered.' : 'No scan has been asked for; the device also scans on its own schedule.'),
    row('scan_completed', f.scanError ? 'failed' : f.scannedAt ? 'done' : 'not_seen', f.scanError ? `The last scan failed: ${f.scanError}` : f.scannedAt ? `${f.offered} update${f.offered === 1 ? '' : 's'} offered at the last scan.` : 'No scan received yet.'),
    row('approved', !hasInstall ? 'not_seen' : inst === 'awaiting_approval' ? 'now' : APPROVED_STATES.has(inst) ? 'done' : 'not_seen', !hasInstall ? 'No install has been requested.' : inst === 'awaiting_approval' ? 'Waiting for approval.' : inst === 'canceled' ? 'Canceled before it ran.' : APPROVED_STATES.has(inst) ? 'Approved.' : 'Not approved.'),
    row('downloaded', f.scannedAt && f.downloaded > 0 ? 'done' : 'not_reported', f.scannedAt ? `${f.downloaded} of ${f.offered} offered update${f.offered === 1 ? '' : 's'} already downloaded at the last scan. Downloads during an install are not reported.` : 'Known only from a scan.'),
    row('install_started', !hasInstall ? 'not_seen' : inst === 'handed_out' || inst === 'running' ? 'now' : STARTED_STATES.has(inst) ? 'done' : 'not_seen', inst === 'handed_out' || inst === 'running' ? 'Handed to the device. The agent reports nothing more until the result.' : STARTED_STATES.has(inst ?? '') ? 'Handed to the device.' : 'Not handed to the device.'),
    row('install_succeeded', okFinish && f.installed > 0 ? 'done' : 'not_seen', okFinish && f.installed > 0 ? `${f.installed} installed${f.installFailed ? `, ${f.installFailed} failed` : ''}.` : 'No successful install result.'),
    row('restart_required', f.restartRequired || (okFinish && f.rebootPendingNow) ? (f.restartedSinceInstall ? 'done' : 'now') : 'not_seen', f.restartRequired || (okFinish && f.rebootPendingNow) ? 'Windows waits for a restart to finish installing.' : 'No restart asked for.'),
    row('restart_completed', okFinish && f.restartedSinceInstall === true ? 'done' : okFinish && f.restartedSinceInstall == null ? 'not_reported' : 'not_seen', okFinish && f.restartedSinceInstall === true ? 'The device has booted since the install.' : okFinish && f.restartedSinceInstall == null ? 'The device has not reported a boot time.' : 'No boot since the install.'),
    row('verified', f.verified > 0 ? 'done' : okFinish ? 'now' : 'not_seen', f.verified > 0 ? `${f.verified} confirmed by a later scan.` : okFinish ? 'Waiting for a scan after the install.' : 'Nothing to verify yet.'),
    row('failed', f.installFailed > 0 || inst === 'failed' || f.scanError ? 'failed' : 'not_seen', f.installFailed > 0 ? `${f.installFailed} update${f.installFailed === 1 ? '' : 's'} failed.` : inst === 'failed' ? 'The install failed.' : f.scanError ? 'The last scan failed.' : 'Nothing failed.'),
    row('unknown', inst === 'uncertain' || (!f.scannedAt && !hasInstall) ? 'now' : 'not_seen', inst === 'uncertain' ? 'The install\'s outcome is not known; reconcile it on its deployment.' : !f.scannedAt && !hasInstall ? 'No scan and no install: nothing is known yet.' : 'Nothing unknown.'),
  ];
}

// ---------------------------------------------------------------------------
// Who owns updates.

export interface Ownership { id: string; title: string; whatItIs: string; whatRem0teDoes: string; whereToChange: string }

/** The managers the signed agent detects (apps/api/src/patching/posture.ts MANAGERS), in plain English. */
export const OWNERSHIP: Record<string, Ownership> = {
  wsus: {
    id: 'wsus', title: 'WSUS',
    whatItIs: 'A Windows Server Update Services server decides which updates this device may install. Group Policy points the device at it.',
    whatRem0teDoes: 'Shows what the device reports. It never installs updates here and never changes the WSUS setting; the device itself refuses a Rem0te install.',
    whereToChange: 'Approve updates on the WSUS server, or remove the WSUS Group Policy to let Rem0te patch this device.',
  },
  mdm_policy: {
    id: 'mdm_policy', title: 'Intune or another MDM',
    whatItIs: 'An MDM update policy (usually an Intune update ring) decides when updates install: deferrals, deadlines or a pause.',
    whatRem0teDoes: 'Shows what the device reports. It never installs updates here and never changes the MDM policy.',
    whereToChange: 'Change the update ring in Intune (or your MDM), or unassign it to let Rem0te patch this device.',
  },
  wufb_policy: {
    id: 'wufb_policy', title: 'Windows Update for Business',
    whatItIs: 'A Windows Update for Business policy (a deferral, pause or target release, set by Group Policy) decides when updates install.',
    whatRem0teDoes: 'Shows what the device reports. It never installs updates here and never changes the policy.',
    whereToChange: 'Change or remove the Windows Update for Business Group Policy.',
  },
  configmgr: {
    id: 'configmgr', title: 'Configuration Manager',
    whatItIs: 'The Configuration Manager client deploys updates to this device.',
    whatRem0teDoes: 'Shows what the device reports. It never installs updates here.',
    whereToChange: 'Use Configuration Manager\'s software-update deployments.',
  },
};

/** The three answers to "who manages updates here", never a guess. */
export function ownershipSummary(state: 'rem0te_or_windows_update' | 'external' | 'unknown', managers: { id: string; label?: string }[]): { headline: string; detail: string; owners: Ownership[] } {
  if (state === 'external') {
    const owners = managers.map((m) => OWNERSHIP[m.id] ?? { id: m.id, title: m.label ?? m.id, whatItIs: 'Another update manager controls this device.', whatRem0teDoes: 'Shows what the device reports and never installs updates here.', whereToChange: 'Change it in that manager.' });
    return { headline: `Managed by ${owners.map((o) => o.title).join(' and ')}`, detail: 'Rem0te leaves this device\'s updates to that manager: no deployment, policy or template installs here.', owners };
  }
  if (state === 'rem0te_or_windows_update') {
    return { headline: 'Windows Update, with Rem0te able to deploy', detail: 'No WSUS, MDM, Windows Update for Business or Configuration Manager policy was found. Updates come from Windows Update, and an approved Rem0te plan may install them.', owners: [] };
  }
  return { headline: 'Not known', detail: 'The device has not reported its update policy (the standard agent does not read it). Rem0te does not assume it is free to patch: the signed agent reports it.', owners: [] };
}

// ---------------------------------------------------------------------------
// Templates.

/**
 * What a template may fill in. Deliberately absent: devices, the reboot rule,
 * the restart rule and window, the RustDesk exception and the reason. A
 * template never makes a policy install, restart or exist; the person picks
 * devices and restarts and then proposes (or, in direct mode, creates) it.
 */
export interface PolicyTemplate {
  id: 'workstations' | 'servers';
  label: string;
  why: string;
  name: string;
  classes: string[];
  severities: string[];
  testFirst: boolean;
  soakHours: number;
  failureThreshold: number;
  window:
    | { kind: 'weekly'; days: string[]; start: string; end: string }
    | { kind: 'monthly'; week: 'first' | 'second' | 'third' | 'fourth' | 'last'; weekday: string; offsetDays: number; start: string; end: string };
}

export const TEMPLATE_FIELDS = ['id', 'label', 'why', 'name', 'classes', 'severities', 'testFirst', 'soakHours', 'failureThreshold', 'window'] as const;
/** Never in a template, and never changed by applying one. */
export const NEVER_FROM_TEMPLATE = ['devices', 'rings', 'reboot', 'restart', 'ignoreRemoteSession', 'reason', 'expiresInDays'] as const;

const SECURITY = '0fa1201d-4330-4fa8-8ae9-b877473b6441';
const CRITICAL = 'e6cf1350-c01b-414d-a61f-263d14d133b4';
const DEFINITIONS = 'e0789628-ce08-4437-be74-2495b842f43b';

export const POLICY_TEMPLATES: readonly PolicyTemplate[] = [
  {
    id: 'workstations', label: 'Workstations',
    why: 'Security, critical and definition updates every weekday lunchtime, all devices together. No restart is set: choose one yourself, or leave restarts to the people using the devices.',
    name: 'Workstations: security updates',
    classes: [SECURITY, CRITICAL, DEFINITIONS], severities: [], testFirst: false, soakHours: 0, failureThreshold: 0,
    window: { kind: 'weekly', days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '12:00', end: '14:00' },
  },
  {
    id: 'servers', label: 'Servers',
    why: 'Security and critical updates on the Sunday after Patch Tuesday, early morning, one server first and the rest a day later. No restart is set: choose a restart rule and window yourself.',
    name: 'Servers: monthly security updates',
    classes: [SECURITY, CRITICAL], severities: [], testFirst: true, soakHours: 24, failureThreshold: 0,
    window: { kind: 'monthly', week: 'second', weekday: 'tue', offsetDays: 5, start: '02:00', end: '05:00' },
  },
];

/** The settings a template fills in, as lines for its preview. */
export function templatePreview(t: PolicyTemplate, className: (id: string) => string): string[] {
  const w = t.window;
  const when = w.kind === 'weekly'
    ? `${w.days.length === 5 && !w.days.includes('sat') && !w.days.includes('sun') ? 'Weekdays' : w.days.join(', ')} ${w.start}–${w.end}`
    : `${w.offsetDays ? `${w.offsetDays} days after ` : ''}the ${w.week} ${w.weekday === 'tue' ? 'Tuesday' : w.weekday} of each month, ${w.start}–${w.end}`;
  return [
    `Classes: ${t.classes.map(className).join(', ')}`,
    `Severities: ${t.severities.length ? t.severities.join(', ') : 'any'}`,
    `Install window: ${when}, in your time zone`,
    t.testFirst ? `One device first, then the rest after ${t.soakHours} h, stopping on ${t.failureThreshold === 0 ? 'any failure' : `more than ${t.failureThreshold} failures`}` : 'All devices together',
    'Restarts: not set by the template (it never restarts a device)',
    'Devices: not set by the template (you pick them)',
  ];
}
