/**
 * Task progress (0.52): one lifecycle for everything the console sends or
 * queues for a computer, built only from what the database already records.
 *
 *   Scheduled ─▶ Waiting for approval ─▶ Queued ─▶ Handed to the computer ─▶ (Running) ─▶ Done
 *
 * Why this exists: on DEWEY-WKS2022 an update install was requested at
 * 23:31:46, handed out at 23:33:05 (four deliveries, the last at 23:42:04) and
 * answered at 23:45:04 — eight updates installed, restart required. The
 * owner, watching the Patches tab, saw nothing change and asked whether it had
 * failed. Every one of those facts was in ActionTarget; nothing showed them.
 *
 * Pure: no Nest, no Prisma client, no clock of its own (every function takes
 * `now`). The rows are the Prisma rows' shapes, narrowed to what is read.
 * Nothing here decides anything: it describes. The agent and the heartbeat
 * still decide what runs and when.
 */

/** The agent checks in about every 3 minutes; a queued task waits for that. */
export const CHECK_IN_MINUTES = 3;
/** Queued this long with no check-in: say the computer may be offline. */
export const QUIET_COMPUTER_MINUTES = 10;

export type TaskKind = 'action' | 'diagnostic' | 'command' | 'migration' | 'reinstall' | 'rustdesk_update' | 'patch_scan';

/** What the Tasks page filters on. */
export const TASK_TYPES = [
  'update_install', 'restart', 'software', 'service_process', 'script', 'logs', 'action',
  'snapshot', 'diagnostic', 'scan', 'inventory', 'event_log', 'agent',
] as const;
export type TaskType = typeof TASK_TYPES[number];

export const TASK_STATES = [
  'scheduled', 'awaiting_approval', 'queued', 'held', 'handed_out', 'running',
  'succeeded', 'restart_required', 'failed', 'refused', 'not_executed', 'uncertain', 'canceled', 'expired',
] as const;
export type TaskState = typeof TASK_STATES[number];
export type TaskStage = 'scheduled' | 'awaiting_approval' | 'queued' | 'handed_out' | 'running' | 'done';

/** The states the Tasks page's "State" filter groups. */
export const STATE_FILTERS = ['in_flight', 'scheduled', 'done', 'problem', 'all'] as const;
export type StateFilter = typeof STATE_FILTERS[number];

export interface TaskItem { label: string; state: string; detail: string | null }

export interface TaskView {
  /** Stable across polls: kind, row id and computer. */
  id: string;
  kind: TaskKind;
  type: TaskType;
  title: string;
  endpointId: string;
  computerName: string | null;
  businessId: string | null;
  requestedById: string | null;
  requestedAt: string;
  stage: TaskStage;
  state: TaskState;
  inFlight: boolean;
  /** One sentence: where it is and what it is waiting for. */
  text: string;
  waitingFor: 'schedule' | 'approval' | 'check_in' | 'containment' | 'window' | null;
  scheduledFor: string | null;
  windowEnds: string | null;
  handedOutAt: string | null;
  lastDeliveredAt: string | null;
  deliveries: number;
  startedAt: string | null;
  finishedAt: string | null;
  overdue: boolean;
  overdueText: string | null;
  /** Per item (an update install's updates). */
  items: TaskItem[];
  /** windows.update.install: what Windows said about a restart afterwards. */
  restartPending: boolean | null;
  /** The outcome as the agent named it (restart_required, partial…). */
  outcome: string | null;
  reason: string | null;
  link: { href: string; label: string };
  /** The job a person may cancel (POST /actions/:id/cancel): scheduled or awaiting approval, nothing delivered. */
  cancelJobId: string | null;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const mins = (ms: number) => Math.max(0, Math.round(ms / 60_000));

/** "25 min", "2 h 5 min", "3 days". */
export function span(ms: number): string {
  if (ms < 60_000) return 'under a minute';
  const m = mins(ms);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 48) return r ? `${h} h ${r} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}

/** UTC clock time, "23:33 UTC": the browser renders the timestamps itself; this is for the sentence. */
const at = (d: Date) => `${d.toISOString().slice(11, 16)} UTC`;

// ── Thresholds ──────────────────────────────────────────────────────────────

/**
 * Minutes after it was handed out with no result before a task is called
 * overdue. Not the deadline that makes an action's outcome uncertain
 * (catalog resultDeadlineMinutes, up to 6 hours for updates): this is only
 * when the console starts saying "no result yet". DEWEY's cumulative update
 * answered in 12 minutes; 30 leaves room for a slow one.
 */
export const OVERDUE_MINUTES: Record<TaskType, number> = {
  update_install: 30, software: 20, script: 15, restart: 10, service_process: 10, logs: 10, action: 10,
  snapshot: 10, diagnostic: 10, scan: 20, inventory: 10, event_log: 10, agent: 30,
};

const ACTION_TYPE: Record<string, TaskType> = {
  'windows.update.install': 'update_install',
  'windows.reboot.schedule': 'restart', 'windows.reboot.cancel': 'restart',
  'windows.software.install': 'software', 'windows.software.uninstall': 'software', 'windows.software.remove': 'software',
  'windows.service.control': 'service_process', 'windows.process.stop': 'service_process', 'windows.service.restart': 'service_process', 'windows.service.start': 'service_process',
  'windows.script.run': 'script',
  'windows.logs.collect': 'logs',
};
export const actionType = (actionId: string): TaskType => ACTION_TYPE[actionId] ?? 'action';

// ── Windows Update result codes ─────────────────────────────────────────────

/** What the common Windows Update HRESULTs mean. Anything else is shown as the code alone. */
export const HRESULT_TEXT: Record<string, string> = {
  '0x00000000': 'success',
  '0x80240022': 'every update in the request failed (WU_E_ALL_UPDATES_FAILED)',
  '0x8024001e': 'the operation was cancelled or the service was shutting down (WU_E_SERVICE_STOP)',
  '0x80240017': 'the update is not applicable to this computer (WU_E_NOT_APPLICABLE)',
  '0x8024000b': 'the operation was cancelled (WU_E_CALL_CANCELLED)',
  '0x80240016': 'another installation was in progress (WU_E_INSTALL_NOT_ALLOWED)',
  '0x8024402c': 'the update server could not be reached: proxy or DNS (WU_E_PT_WINHTTP_NAME_NOT_RESOLVED)',
  '0x80244022': 'the update server was unavailable (HTTP 503)',
  '0x80070005': 'access denied (E_ACCESSDENIED)',
  '0x80070070': 'not enough disk space (ERROR_DISK_FULL)',
  '0x800f0922': 'the update could not be installed: often too little space on the system reserved partition, or a servicing stack problem',
  '0x800f081f': 'source files for the update were not found (CBS_E_SOURCE_MISSING)',
  '0x80073712': 'a file Windows Update needs is missing or damaged (ERROR_SXS_COMPONENT_STORE_CORRUPT)',
  '0x80070bc2': 'a restart is required before more can be installed (ERROR_SUCCESS_REBOOT_REQUIRED)',
  '0x00240006': 'already installed, or superseded (WU_S_ALREADY_INSTALLED)',
};
export function hresultText(h: string | null | undefined): string | null {
  if (!h) return null;
  const k = h.toLowerCase();
  return HRESULT_TEXT[k] ?? null;
}

// ── Approved actions ────────────────────────────────────────────────────────

export interface ActionJobRow {
  id: string; actionId: string; status: string; statusReason: string | null; customerId: string; requestedById: string;
  notBefore: Date; notAfter: Date; createdAt: Date; deploymentId: string | null; softwareDeploymentId: string | null;
  plan: unknown; params: unknown;
}
export interface ActionTargetRow {
  id: string; endpointId: string; status: string; statusReason: string | null; dispatchedAt: Date | null; deliveries: number;
  lastDeliveredAt: Date | null; outcome: string | null; result: unknown; resultAt: Date | null; reconciledAt: Date | null;
}
export interface EndpointRow { id: string; name: string; hostname: string | null; customerId: string | null; lastSeenAt: Date | null }
export interface Context { now: Date; held: boolean; titleOf: (actionId: string) => string; endpoint: EndpointRow | null }

type PlanDisplay = { display?: { updates?: { updateId: string; kb?: string | null; title?: string }[]; deployment?: { name?: string }; software?: { name?: string }; policy?: { name?: string } } };
type UpdateOutcome = { updateId: string; kb?: string; state: string; reason?: string; hresult?: string };
type ActionResult = { outcome?: string; reason?: string; detail?: string; updates?: UpdateOutcome[]; reboot?: { pending: boolean }; restart?: { state: string; reason?: string; scheduledFor?: string }; observed?: Record<string, string> };

/** The per-update rows of an update install's result, labelled with the KB or the title the plan showed. */
export function updateItems(plan: unknown, result: unknown): TaskItem[] {
  const r = (result ?? null) as ActionResult | null;
  if (!r?.updates?.length) return [];
  const shown = new Map(((plan as PlanDisplay | null)?.display?.updates ?? []).map((u) => [u.updateId, u]));
  return r.updates.map((u) => {
    const s = shown.get(u.updateId);
    const label = u.kb ?? s?.kb ?? s?.title ?? u.updateId;
    const h = u.hresult && u.hresult !== '0x00000000' ? `${u.hresult}${hresultText(u.hresult) ? `: ${hresultText(u.hresult)}` : ''}` : null;
    const detail = [u.reason?.replace(/_/g, ' '), h].filter(Boolean).join(' · ') || null;
    return { label: `${label}${s?.title && label !== s.title ? ` — ${s.title}` : ''}`.slice(0, 200), state: u.state, detail };
  });
}

function doneState(t: ActionTargetRow, job: ActionJobRow): TaskState {
  switch (t.status) {
    case 'SUCCEEDED': {
      const r = (t.result ?? null) as ActionResult | null;
      if (t.outcome === 'restart_required' || (job.actionId === 'windows.update.install' && r?.reboot?.pending)) return 'restart_required';
      return 'succeeded';
    }
    case 'FAILED': return 'failed';
    case 'REFUSED_BY_ENDPOINT': return 'refused';
    case 'NOT_EXECUTED': return 'not_executed';
    case 'UNKNOWN': return 'uncertain';
    case 'CANCELED': return t.statusReason === 'window_closed' ? 'expired' : 'canceled';
    default: return 'failed';
  }
}

function linkFor(job: ActionJobRow, endpointId: string): TaskView['link'] {
  if (job.deploymentId) return { href: `/patching/${job.deploymentId}`, label: 'Deployment' };
  if (job.softwareDeploymentId) return { href: `/automation/software/deployments/${job.softwareDeploymentId}`, label: 'Software deployment' };
  const tab = job.actionId === 'windows.service.control' ? 'services' : job.actionId === 'windows.process.stop' ? 'processes' : 'actions';
  return { href: `/endpoints/${endpointId}?tab=${tab}`, label: tab === 'actions' ? 'Actions tab' : tab === 'services' ? 'Services tab' : 'Processes tab' };
}

function quietText(ep: EndpointRow | null, now: Date): string | null {
  if (!ep?.lastSeenAt) return 'The computer has never checked in.';
  const quiet = now.getTime() - ep.lastSeenAt.getTime();
  return quiet > QUIET_COMPUTER_MINUTES * 60_000 ? `The computer last checked in ${span(quiet)} ago: it may be offline or asleep.` : null;
}

function base(kind: TaskKind, id: string, type: TaskType, title: string, endpointId: string, ep: EndpointRow | null, requestedById: string | null, requestedAt: Date): TaskView {
  return {
    id, kind, type, title, endpointId, computerName: ep ? (ep.hostname ?? ep.name) : null, businessId: ep?.customerId ?? null,
    requestedById, requestedAt: requestedAt.toISOString(), stage: 'queued', state: 'queued', inFlight: true, text: '', waitingFor: null,
    scheduledFor: null, windowEnds: null, handedOutAt: null, lastDeliveredAt: null, deliveries: 0, startedAt: null, finishedAt: null,
    overdue: false, overdueText: null, items: [], restartPending: null, outcome: null, reason: null,
    link: { href: `/endpoints/${endpointId}`, label: 'Computer' }, cancelJobId: null,
  };
}

/**
 * 0.54: why a restart did or did not happen, in words. A signed-in Windows
 * user never stops a restart; only a technician's RustDesk session does, and
 * only without the signed exception — so "connected" is always said as
 * "connected through RustDesk", never as "signed in".
 */
export const RESTART_REASON_TEXT: Record<string, string> = {
  remote_session_open: 'a technician was connected through RustDesk',
  session_state_unknown: 'the computer could not tell whether a technician was connected through RustDesk',
  window_closed: 'the plan\'s window closed before the warning could run out',
  restart_already_scheduled: 'Windows already had a restart or shutdown pending',
  install_uncertain: 'the install\'s outcome was not known',
  no_restart_required: 'Windows reported no restart required',
  reboot_state_unknown: 'the computer could not read whether Windows requires a restart',
};
const reasonText = (r: string | null | undefined) => (r ? RESTART_REASON_TEXT[r] ?? r.replace(/_/g, ' ') : 'no reason given');
export const OVERRIDE_TEXT = 'restarted although a technician was connected through RustDesk';

function restartDoneText(t: ActionTargetRow, r: ActionResult | null, policyRestart: boolean): string {
  const o = r?.observed ?? {};
  const override = o.sessionOverride === 'true' ? ` — ${OVERRIDE_TEXT}${o.remoteSessions && o.remoteSessions !== '0' ? ` (${o.remoteSessions === 'unknown' ? 'sessions unknown' : `${o.remoteSessions} session${o.remoteSessions === '1' ? '' : 's'} open`})` : ''}` : '';
  if (r?.outcome === 'succeeded' && o.scheduledFor) return `Restart scheduled for ${at(new Date(o.scheduledFor))}, after the warning on screen${override}.`;
  if (r?.outcome === 'no_change' && r.reason === 'no_restart_required') return 'Not restarted: Windows reported no restart required.';
  if (r?.outcome === 'not_executed' && (r.reason === 'remote_session_open' || r.reason === 'session_state_unknown')) {
    return `Not restarted: ${reasonText(r.reason)}. A signed-in user never stops a restart; a RustDesk session does, unless the exception is ticked.${policyRestart ? ' The policy tries again later in this restart window, and in the next one.' : ''}`;
  }
  return '';
}

/** One computer's row of one signed plan. */
export function actionTask(job: ActionJobRow, t: ActionTargetRow, ctx: Context): TaskView {
  const { now } = ctx;
  const type = actionType(job.actionId);
  const plan = job.plan as PlanDisplay | null;
  const named = plan?.display?.deployment?.name ?? plan?.display?.software?.name ?? (plan?.display?.policy?.name && job.actionId === 'windows.reboot.schedule' ? `policy "${plan.display.policy.name}"` : undefined);
  const title = `${ctx.titleOf(job.actionId)}${named ? ` — ${named}` : ''}`.slice(0, 160);
  const v = base('action', `action:${job.id}:${t.endpointId}`, type, title, t.endpointId, ctx.endpoint, job.requestedById, job.createdAt);
  v.link = linkFor(job, t.endpointId);
  v.scheduledFor = iso(job.notBefore);
  v.windowEnds = iso(job.notAfter);
  v.deliveries = t.deliveries;
  v.handedOutAt = iso(t.dispatchedAt);
  v.lastDeliveredAt = iso(t.lastDeliveredAt);
  v.outcome = t.outcome;
  v.reason = t.statusReason;
  const r = (t.result ?? null) as ActionResult | null;
  if (job.actionId === 'windows.update.install') {
    v.items = updateItems(job.plan, t.result);
    v.restartPending = r?.reboot ? r.reboot.pending : null;
  }

  // Answered: done, whatever the job's roll-up says.
  if (t.result !== null && t.result !== undefined && t.resultAt) {
    v.stage = 'done'; v.inFlight = false; v.finishedAt = iso(t.resultAt);
    v.state = doneState(t, job);
    const n = v.items.filter((i) => i.state === 'installed' || i.state === 'restart_required').length;
    const failed = v.items.filter((i) => i.state === 'failed').length;
    const took = t.dispatchedAt ? ` ${span(t.resultAt.getTime() - t.dispatchedAt.getTime())} after it was handed out` : '';
    if (type === 'update_install') {
      const restart = r?.restart?.state === 'scheduled' && r.restart.scheduledFor ? ` It scheduled the restart for ${at(new Date(r.restart.scheduledFor))}${r.observed?.sessionOverride === 'true' ? ` — ${OVERRIDE_TEXT}` : ''}.`
        : r?.restart?.state === 'restart_deferred' ? ` The restart was deferred (${reasonText(r.restart.reason)}).` : '';
      v.text = `${n ? `Installed ${n} update${n === 1 ? '' : 's'}` : 'Nothing was installed'}${failed ? `, ${failed} failed` : ''}${v.state === 'restart_required' ? ' — restart required' : ''}. Answered at ${at(t.resultAt)},${took}.${restart}`;
    } else if (job.actionId === 'windows.reboot.schedule' && restartDoneText(t, r, !!plan?.display?.policy)) {
      v.text = `${restartDoneText(t, r, !!plan?.display?.policy)} Answered at ${at(t.resultAt)}${took ? `,${took}` : ''}.`;
    } else {
      const what = { succeeded: 'Succeeded', restart_required: 'Succeeded — restart required', failed: 'Failed', refused: 'Refused by the computer', not_executed: 'Not executed', uncertain: 'Outcome uncertain' }[v.state as string] ?? 'Finished';
      v.text = `${what}${t.statusReason ? ` (${t.statusReason.replace(/_/g, ' ')})` : ''}. Answered at ${at(t.resultAt)}${took ? `,${took}` : ''}.`;
    }
    if (v.state === 'uncertain' && !t.reconciledAt) { v.inFlight = false; v.text += ' Check the computer and record what you found (Reconcile).'; }
    return v;
  }

  // Never answered, and will not be.
  if (t.status === 'CANCELED' || ['REJECTED', 'CANCELED', 'EXPIRED'].includes(job.status)) {
    v.stage = 'done'; v.inFlight = false;
    v.state = t.statusReason === 'window_closed' || job.status === 'EXPIRED' ? 'expired' : 'canceled';
    v.finishedAt = null;
    const why = t.statusReason ?? job.statusReason;
    v.text = v.state === 'expired' ? `Expired: its window closed (${at(job.notAfter)}) before the computer picked it up.`
      : job.status === 'REJECTED' ? `Rejected on the approval signer${job.statusReason ? ` (${job.statusReason})` : ''}.`
        : `Canceled${why ? `: ${why.replace(/_/g, ' ')}` : ''}. Nothing reached the computer.`;
    return v;
  }

  if (job.status === 'AWAITING_APPROVAL') {
    v.stage = 'awaiting_approval'; v.state = 'awaiting_approval'; v.waitingFor = 'approval'; v.cancelJobId = job.id;
    v.text = `Waiting for approval on the approval signer.${job.notBefore > now ? ` Scheduled for ${at(job.notBefore)} once approved.` : ''}`;
    return v;
  }

  if (t.status === 'PENDING') {
    v.cancelJobId = job.status === 'APPROVED' ? job.id : null;
    if (now < job.notBefore) {
      v.stage = 'scheduled'; v.state = 'scheduled'; v.waitingFor = 'schedule';
      v.text = `Scheduled for ${at(job.notBefore)} (in ${span(job.notBefore.getTime() - now.getTime())}); it may run until ${at(job.notAfter)}. Nothing is handed to the computer before then.`;
      return v;
    }
    if (ctx.held) {
      v.stage = 'queued'; v.state = 'held'; v.waitingFor = 'containment';
      v.text = 'Held: approved actions are paused for this business (containment). It is handed out when the pause is lifted, if its window is still open.';
      return v;
    }
    v.stage = 'queued'; v.state = 'queued'; v.waitingFor = 'check_in';
    const quiet = quietText(ctx.endpoint, now);
    v.text = `Queued: waiting for the computer's next check-in (about every ${CHECK_IN_MINUTES} minutes). The window closes at ${at(job.notAfter)}.`;
    if (quiet) { v.overdue = true; v.overdueText = quiet; }
    return v;
  }

  // DISPATCHED, or UNKNOWN with no result yet (still offered: the agent answers from its journal).
  v.stage = 'handed_out'; v.state = t.status === 'UNKNOWN' ? 'uncertain' : 'handed_out';
  const out = t.dispatchedAt ?? t.lastDeliveredAt ?? now;
  const since = now.getTime() - out.getTime();
  v.text = `Handed to the computer at ${at(out)} (${t.deliveries} deliver${t.deliveries === 1 ? 'y' : 'ies'}${t.lastDeliveredAt && t.deliveries > 1 ? `, the last at ${at(t.lastDeliveredAt)}` : ''}). The agent runs it and reports when it finishes; it does not report progress in between.`;
  if (t.status === 'UNKNOWN') v.text = `No result within the action's deadline; still offered, and the agent answers from its journal when it next checks in. Handed out at ${at(out)}.`;
  if (since > OVERDUE_MINUTES[type] * 60_000) {
    v.overdue = true;
    const quiet = quietText(ctx.endpoint, now);
    v.overdueText = `Handed out ${span(since)} ago, no result yet: the agent may be busy${type === 'update_install' ? ' (a large update can take a long time)' : ''} or offline.${quiet ? ` ${quiet}` : ''}`;
  }
  return v;
}

// ── Diagnostics and snapshots ───────────────────────────────────────────────

export interface DiagnosticRunRow {
  id: string; endpointId: string; key: string; status: string; requestedById: string | null; requestedAt: Date;
  deliveredAt: Date | null; startedAt: Date | null; completedAt: Date | null; expiresAt: Date; dispatchCount: number; error: string | null;
}

export function diagnosticTask(r: DiagnosticRunRow, ep: EndpointRow | null, label: string, snapshot: boolean, now: Date): TaskView {
  const type: TaskType = snapshot ? 'snapshot' : 'diagnostic';
  const v = base('diagnostic', `diagnostic:${r.id}`, type, label, r.endpointId, ep, r.requestedById, r.requestedAt);
  const tab = snapshot ? ({ process_list: 'processes', service_list: 'services', network_adapters: 'network' } as Record<string, string>)[r.key] ?? 'diagnostics' : 'diagnostics';
  v.link = { href: `/endpoints/${r.endpointId}?tab=${tab}`, label: tab === 'diagnostics' ? 'Diagnostics tab' : `${tab[0].toUpperCase()}${tab.slice(1)} tab` };
  v.handedOutAt = iso(r.deliveredAt); v.lastDeliveredAt = iso(r.deliveredAt); v.deliveries = r.dispatchCount; v.startedAt = iso(r.startedAt);
  if (r.status === 'COMPLETED' || r.status === 'FAILED' || r.status === 'EXPIRED') {
    v.stage = 'done'; v.inFlight = false; v.finishedAt = iso(r.completedAt ?? (r.status === 'EXPIRED' ? r.expiresAt : null));
    v.state = r.status === 'COMPLETED' ? 'succeeded' : r.status === 'FAILED' ? 'failed' : 'expired';
    v.reason = r.error;
    v.text = r.status === 'COMPLETED' ? `Done at ${at(r.completedAt ?? now)}.` : r.status === 'FAILED' ? `Failed${r.error ? `: ${r.error}` : ''}.` : `Expired${r.error ? `: ${r.error}` : ': the computer did not pick it up in time'}.`;
    return v;
  }
  if (r.status === 'RUNNING') {
    v.stage = 'running'; v.state = 'running';
    const s = r.startedAt ?? r.deliveredAt ?? now;
    v.text = `Running on the computer since ${at(s)}.`;
    if (now.getTime() - s.getTime() > OVERDUE_MINUTES[type] * 60_000) { v.overdue = true; v.overdueText = `Running for ${span(now.getTime() - s.getTime())} with no result yet: the computer may be busy or offline.`; }
    return v;
  }
  if (r.status === 'DELIVERED') {
    v.stage = 'handed_out'; v.state = 'handed_out';
    const d = r.deliveredAt ?? now;
    v.text = `Handed to the computer at ${at(d)}; waiting for it to start.`;
    if (now.getTime() - d.getTime() > OVERDUE_MINUTES[type] * 60_000) { v.overdue = true; v.overdueText = `Handed out ${span(now.getTime() - d.getTime())} ago, no result yet: the agent may be busy or offline.`; }
    return v;
  }
  v.stage = 'queued'; v.state = 'queued'; v.waitingFor = 'check_in';
  v.text = `Queued: waiting for the computer's next check-in (about every ${CHECK_IN_MINUTES} minutes). It expires at ${at(r.expiresAt)} if not picked up.`;
  const quiet = quietText(ep, now);
  if (quiet) { v.overdue = true; v.overdueText = quiet; }
  return v;
}

// ── Queued commands (inventory refresh, update scan, event-log query) ───────

export interface CommandRow {
  id: string; endpointId: string; type: string; status: string; requestedById: string | null; createdAt: Date;
  dispatchedAt: Date | null; completedAt: Date | null; expiresAt: Date; dispatchCount: number; error: string | null;
}
const COMMAND: Record<string, { type: TaskType; title: string; tab: string }> = {
  INVENTORY_REFRESH: { type: 'inventory', title: 'Refresh inventory', tab: 'software' },
  UPDATE_SCAN: { type: 'scan', title: 'Update scan', tab: 'patches' },
  EVENT_LOG_QUERY: { type: 'event_log', title: 'Event log query', tab: 'events' },
};

export function commandTask(c: CommandRow, ep: EndpointRow | null, now: Date): TaskView {
  const m = COMMAND[c.type] ?? { type: 'inventory' as TaskType, title: c.type, tab: 'overview' };
  const v = base('command', `command:${c.id}`, m.type, m.title, c.endpointId, ep, c.requestedById, c.createdAt);
  v.link = { href: `/endpoints/${c.endpointId}?tab=${m.tab}`, label: 'Computer' };
  v.handedOutAt = iso(c.dispatchedAt); v.lastDeliveredAt = iso(c.dispatchedAt); v.deliveries = c.dispatchCount;
  if (['SUCCEEDED', 'FAILED', 'EXPIRED'].includes(c.status)) {
    v.stage = 'done'; v.inFlight = false; v.finishedAt = iso(c.completedAt ?? (c.status === 'EXPIRED' ? c.expiresAt : null));
    v.state = c.status === 'SUCCEEDED' ? 'succeeded' : c.status === 'FAILED' ? 'failed' : 'expired';
    v.reason = c.error;
    v.text = c.status === 'SUCCEEDED' ? `Done at ${at(c.completedAt ?? now)}.` : c.status === 'FAILED' ? `Failed${c.error ? `: ${c.error}` : ''}.` : 'Expired: the computer did not answer in time.';
    return v;
  }
  if (c.status === 'DISPATCHED') {
    v.stage = 'handed_out'; v.state = 'handed_out';
    const d = c.dispatchedAt ?? now;
    v.text = `Handed to the computer at ${at(d)} (${c.dispatchCount} deliver${c.dispatchCount === 1 ? 'y' : 'ies'}); waiting for its answer.`;
    if (now.getTime() - d.getTime() > OVERDUE_MINUTES[m.type] * 60_000) { v.overdue = true; v.overdueText = `Handed out ${span(now.getTime() - d.getTime())} ago, no result yet: the agent may be busy or offline.`; }
    return v;
  }
  v.stage = 'queued'; v.state = 'queued'; v.waitingFor = 'check_in';
  v.text = `Queued: waiting for the computer's next check-in (about every ${CHECK_IN_MINUTES} minutes).`;
  const quiet = quietText(ep, now);
  if (quiet) { v.overdue = true; v.overdueText = quiet; }
  return v;
}

// ── A patch scan the signed agent was asked for ─────────────────────────────

/**
 * Endpoint.patchScanRequestedAt newer than the last scan. It may be in the
 * future: after a scheduled restart the portal asks for a scan due just after
 * it (§ 37), and the heartbeat waits for that time.
 */
export function patchScanTask(endpointId: string, ep: EndpointRow | null, requestedAt: Date, scannedAt: Date | null, now: Date): TaskView | null {
  if (scannedAt && scannedAt >= requestedAt) return null;
  const v = base('patch_scan', `patch_scan:${endpointId}:${requestedAt.getTime()}`, 'scan', 'Windows Update scan', endpointId, ep, null, requestedAt);
  v.link = { href: `/endpoints/${endpointId}?tab=patches`, label: 'Patches tab' };
  if (requestedAt > now) {
    v.stage = 'scheduled'; v.state = 'scheduled'; v.waitingFor = 'schedule'; v.scheduledFor = iso(requestedAt);
    v.text = `A scan is due at ${at(requestedAt)}, after the scheduled restart; the update list refreshes then.`;
    return v;
  }
  v.stage = 'queued'; v.state = 'queued'; v.waitingFor = 'check_in';
  v.text = `Requested; the signed agent scans at its next check-in (about every ${CHECK_IN_MINUTES} minutes) and reports the new list.`;
  if (now.getTime() - requestedAt.getTime() > OVERDUE_MINUTES.scan * 60_000) {
    v.overdue = true;
    v.overdueText = `Requested ${span(now.getTime() - requestedAt.getTime())} ago and no scan has arrived: the computer may be offline, or Windows Update slow to answer.${quietText(ep, now) ? ` ${quietText(ep, now)}` : ''}`;
  }
  return v;
}

// ── Agent work: migration, reinstall, RustDesk client update ────────────────

export interface MigrationRow {
  id: string; endpointId: string; requestedById: string | null; requestedAt: Date; dispatchedAt: Date | null; lastDispatchedAt: Date | null;
  dispatchCount: number; fetchedAt: Date | null; holdReason: string | null; holdAt: Date | null; completedAt: Date | null; cancelledAt: Date | null; automatic: boolean;
}

/** `state` and `text` come from agent-migration.ts migrationState, so the Agent card and this agree. */
export function migrationTask(m: MigrationRow, ep: EndpointRow | null, st: { state: string; text: string }, now: Date): TaskView {
  const v = base('migration', `migration:${m.id}`, 'agent', `Upgrade to the full agent${m.automatic ? ' (automatic)' : ''}`, m.endpointId, ep, m.requestedById, m.requestedAt);
  v.link = { href: `/endpoints/${m.endpointId}`, label: 'Agent card' };
  v.handedOutAt = iso(m.dispatchedAt); v.lastDeliveredAt = iso(m.lastDispatchedAt); v.deliveries = m.dispatchCount; v.startedAt = iso(m.fetchedAt);
  v.text = st.text;
  switch (st.state) {
    case 'completed': v.stage = 'done'; v.state = 'succeeded'; v.inFlight = false; v.finishedAt = iso(m.completedAt); return v;
    case 'cancelled': v.stage = 'done'; v.state = 'canceled'; v.inFlight = false; v.finishedAt = iso(m.cancelledAt); return v;
    case 'not_confirmed': v.stage = 'done'; v.state = 'failed'; v.inFlight = false; v.overdue = true; v.overdueText = st.text; return v;
    case 'held': v.stage = 'queued'; v.state = 'held'; v.waitingFor = m.holdReason === 'outside_window' ? 'window' : m.holdReason === 'contained' ? 'containment' : 'check_in'; return v;
    case 'downloaded': v.stage = 'running'; v.state = 'running'; break;
    case 'dispatched': v.stage = 'handed_out'; v.state = 'handed_out'; break;
    default: { v.stage = 'queued'; v.state = 'queued'; v.waitingFor = 'check_in'; const q = quietText(ep, now); if (q) { v.overdue = true; v.overdueText = q; } return v; }
  }
  const out = m.dispatchedAt ?? now;
  if (now.getTime() - out.getTime() > OVERDUE_MINUTES.agent * 60_000) { v.overdue = true; v.overdueText = `Handed out ${span(now.getTime() - out.getTime())} ago and the computer still reports the standard agent.`; }
  return v;
}

export interface NodeRow {
  endpointId: string; reinstallRequestedAt: Date | null; reinstallRequestedBy: string | null; reinstallDispatchedAt: Date | null;
  updateRequestedAt: Date | null; updateRequestedById: string | null; updateRequestSource: string | null; updateTargetVersion: string | null; updateHoldReason: string | null;
}

/**
 * A reinstall, or a RustDesk client update, waiting for or handed to the
 * computer. Both flags clear themselves when the agent reports the result,
 * so only an open one is a task; a finished one is in the audit log.
 */
export function nodeTasks(n: NodeRow, ep: EndpointRow | null, now: Date): TaskView[] {
  const out: TaskView[] = [];
  if (n.reinstallRequestedAt) {
    const v = base('reinstall', `reinstall:${n.endpointId}:${n.reinstallRequestedAt.getTime()}`, 'agent', 'Agent reinstall', n.endpointId, ep, n.reinstallRequestedBy, n.reinstallRequestedAt);
    v.link = { href: `/endpoints/${n.endpointId}`, label: 'Agent card' };
    if (n.reinstallDispatchedAt) {
      v.stage = 'handed_out'; v.state = 'handed_out'; v.handedOutAt = iso(n.reinstallDispatchedAt);
      v.text = `Handed to the computer at ${at(n.reinstallDispatchedAt)}; it clears when the agent reports the reinstalled version.`;
      if (now.getTime() - n.reinstallDispatchedAt.getTime() > OVERDUE_MINUTES.agent * 60_000) { v.overdue = true; v.overdueText = `Handed out ${span(now.getTime() - n.reinstallDispatchedAt.getTime())} ago and the agent has not reported a new version: the installer may have failed, or the computer is offline.`; }
    } else {
      v.stage = 'queued'; v.state = 'queued'; v.waitingFor = 'check_in';
      v.text = `Queued: waiting for the computer's next check-in (about every ${CHECK_IN_MINUTES} minutes).`;
      const q = quietText(ep, now); if (q) { v.overdue = true; v.overdueText = q; }
    }
    out.push(v);
  }
  if (n.updateRequestedAt) {
    const v = base('rustdesk_update', `rustdesk_update:${n.endpointId}:${n.updateRequestedAt.getTime()}`, 'agent', `RustDesk client update${n.updateTargetVersion ? ` to ${n.updateTargetVersion}` : ''}${n.updateRequestSource === 'POLICY' ? ' (policy)' : ''}`, n.endpointId, ep, n.updateRequestedById, n.updateRequestedAt);
    v.link = { href: `/endpoints/${n.endpointId}`, label: 'Agent card' };
    if (n.updateHoldReason) {
      v.stage = 'queued'; v.state = 'held'; v.waitingFor = n.updateHoldReason === 'outside_window' ? 'window' : n.updateHoldReason === 'contained' ? 'containment' : 'check_in';
      v.text = `Held: ${n.updateHoldReason.replace(/_/g, ' ')}. It is handed out when that changes.`;
    } else {
      v.stage = 'queued'; v.state = 'queued'; v.waitingFor = 'check_in';
      v.text = `Queued for the computer's next check-in (about every ${CHECK_IN_MINUTES} minutes); it clears when the computer reports the new version.`;
    }
    out.push(v);
  }
  return out;
}

// ── Filtering and ordering ──────────────────────────────────────────────────

export function matchesState(v: TaskView, f: StateFilter): boolean {
  switch (f) {
    case 'in_flight': return v.inFlight;
    case 'scheduled': return v.state === 'scheduled';
    case 'done': return !v.inFlight;
    case 'problem': return v.overdue || ['failed', 'refused', 'uncertain', 'expired', 'not_executed'].includes(v.state);
    default: return true;
  }
}

/** In flight first (overdue first among them), then newest. */
export function sortTasks(a: TaskView, b: TaskView): number {
  if (a.inFlight !== b.inFlight) return a.inFlight ? -1 : 1;
  if (a.inFlight && a.overdue !== b.overdue) return a.overdue ? -1 : 1;
  const ta = Date.parse(a.finishedAt ?? a.requestedAt), tb = Date.parse(b.finishedAt ?? b.requestedAt);
  return tb - ta;
}

/** How often the console polls: fast while anything is in flight, slow when idle. */
export const POLL_FAST_MS = 5_000;
export const POLL_SLOW_MS = 60_000;
