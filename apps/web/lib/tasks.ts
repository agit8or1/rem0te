/**
 * Task progress (0.52): the shape the API's tasks/lifecycle.ts builds, and
 * how the console words it. The API decides the stage, state, overdue flag
 * and sentence; this file only labels them.
 */
export type TaskStage = 'scheduled' | 'awaiting_approval' | 'queued' | 'handed_out' | 'running' | 'done';
export type TaskState =
  | 'scheduled' | 'awaiting_approval' | 'queued' | 'held' | 'handed_out' | 'running'
  | 'succeeded' | 'restart_required' | 'failed' | 'refused' | 'not_executed' | 'uncertain' | 'canceled' | 'expired';

export interface TaskItem { label: string; state: string; detail: string | null }
export interface TaskView {
  id: string; kind: string; type: string; title: string;
  endpointId: string; computerName: string | null; businessId: string | null;
  requestedById: string | null; requestedAt: string;
  stage: TaskStage; state: TaskState; inFlight: boolean; text: string;
  waitingFor: 'schedule' | 'approval' | 'check_in' | 'containment' | 'window' | null;
  scheduledFor: string | null; windowEnds: string | null;
  handedOutAt: string | null; lastDeliveredAt: string | null; deliveries: number;
  startedAt: string | null; finishedAt: string | null;
  overdue: boolean; overdueText: string | null;
  items: TaskItem[]; restartPending: boolean | null; outcome: string | null; reason: string | null;
  link: { href: string; label: string };
  cancelJobId: string | null;
}
export interface TaskList { inFlight: number; scheduled: number; overdue: number; checkedAt: string; pollMs: number; tasks: TaskView[]; total?: number }

export const STATE_LABEL: Record<TaskState, string> = {
  scheduled: 'Scheduled', awaiting_approval: 'Pending approval', queued: 'Queued', held: 'Held', handed_out: 'Handed to the device', running: 'Running',
  succeeded: 'Succeeded', restart_required: 'Restart required', failed: 'Failed', refused: 'Refused', not_executed: 'Not executed', uncertain: 'Uncertain',
  canceled: 'Canceled', expired: 'Expired',
};
export const STATE_VARIANT: Record<TaskState, 'success' | 'destructive' | 'warning' | 'outline' | 'secondary'> = {
  scheduled: 'secondary', awaiting_approval: 'outline', queued: 'outline', held: 'warning', handed_out: 'secondary', running: 'secondary',
  succeeded: 'success', restart_required: 'warning', failed: 'destructive', refused: 'destructive', not_executed: 'outline', uncertain: 'destructive',
  canceled: 'outline', expired: 'outline',
};
export const TYPE_LABEL: Record<string, string> = {
  update_install: 'Update install', restart: 'Restart', software: 'Software', service_process: 'Service / process', script: 'Script', logs: 'Log collection', action: 'Action',
  snapshot: 'Snapshot', diagnostic: 'Diagnostic', scan: 'Update scan', inventory: 'Inventory', event_log: 'Event log', agent: 'Agent',
};
export const ITEM_LABEL: Record<string, string> = {
  installed: 'installed', restart_required: 'installed, restart required', already_installed: 'already installed', superseded: 'superseded',
  not_offered: 'no longer offered', excluded: 'excluded', failed: 'failed', not_attempted: 'not attempted', unknown: 'unknown',
};
export const ITEM_VARIANT = (s: string): 'success' | 'destructive' | 'warning' | 'outline' =>
  s === 'installed' ? 'success' : s === 'restart_required' ? 'warning' : s === 'failed' || s === 'unknown' ? 'destructive' : 'outline';

/** The steps drawn for every task, in order. Scheduled and approval appear only when they applied. */
export const STEPS: { stage: TaskStage; label: string }[] = [
  { stage: 'scheduled', label: 'Scheduled' },
  { stage: 'awaiting_approval', label: 'Approval' },
  { stage: 'queued', label: 'Queued' },
  { stage: 'handed_out', label: 'Handed out' },
  { stage: 'running', label: 'Running' },
  { stage: 'done', label: 'Done' },
];

/** The browser's own zone, for "your time zone". */
export function browserTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/** A wall-clock "YYYY-MM-DDTHH:MM" in `tz`, `minutes` from now (for a sensible default). */
export function localIn(tz: string, minutes = 60): string {
  return localAt(tz, new Date(Date.now() + minutes * 60_000));
}

/** 0.53: the wall-clock "YYYY-MM-DDTHH:MM" in `tz` at instant `t` (a policy window's opening, for the schedule picker). */
export function localAt(tz: string, t: Date): string {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(t).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  } catch { return t.toISOString().slice(0, 16); }
}

/** "Tue 14 Nov, 02:00–04:00" in the window's own zone. */
export function describeOccurrence(o: { start: string; end: string }, tz: string): string {
  try {
    const d = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(o.start));
    const t = (x: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(x));
    return `${d}, ${t(o.start)}–${t(o.end)} (${tz})`;
  } catch { return `${o.start} – ${o.end}`; }
}
