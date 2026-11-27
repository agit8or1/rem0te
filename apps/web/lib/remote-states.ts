/**
 * The eight remote-support states (0.91, UX P1-5; directive §12 "Clearly
 * distinguish").
 *
 * A support session moves through enum statuses, each set by one signal
 * (apps/api/src/sessions/session-state.ts). This module says what a session
 * shows the technician, in the directive's eight stages, from the evidence the
 * row already carries and nothing else:
 *
 *   Launch requested             recorded; no credential released yet
 *   Authorization granted        the portal released a credential (or the
 *                                launcher picked it up); no client has opened
 *   Client opened                RustDesk started on the technician's computer;
 *                                not a connection
 *   Device connection confirmed  the computer's agent saw the connection once,
 *                                or the technician said so, and nothing has
 *                                seen it since ACTIVE_WINDOW_MS
 *   Session active               the computer's agent still sees it: confirmed
 *                                by the agent and a signal within ACTIVE_WINDOW_MS
 *   Session ended                disconnected, finished or canceled
 *   Session failed               a reported failure before any confirmation
 *   Connection state unknown     closed with no confirming or failing signal
 *
 * Portal authorization never reads as a session. "Active" needs the agent's
 * own, recent signal; a technician's "I'm connected" is a confirmation, never
 * "active". Pure: no imports. unit-remote-states.mjs checks every enum status
 * the API has maps to exactly one stage.
 */

export type RemoteStage =
  | 'launch_requested' | 'authorized' | 'client_opened' | 'connection_confirmed'
  | 'active' | 'ended' | 'failed' | 'unknown';

export const STAGES: readonly { id: RemoteStage; label: string; meaning: string }[] = [
  { id: 'launch_requested', label: 'Launch requested', meaning: 'Recorded. No credential has been released yet.' },
  { id: 'authorized', label: 'Authorization granted', meaning: 'The portal released a credential. Nothing has opened a client yet, so no session has happened.' },
  { id: 'client_opened', label: 'Client opened', meaning: 'RustDesk started on your own computer. That is not a connection.' },
  { id: 'connection_confirmed', label: 'Device connection confirmed', meaning: 'A connection was confirmed, but nothing has seen it recently.' },
  { id: 'active', label: 'Session active', meaning: 'The device’s agent still sees the connection.' },
  { id: 'ended', label: 'Session ended', meaning: 'The session is over.' },
  { id: 'failed', label: 'Session failed', meaning: 'A failure was reported before any connection was confirmed.' },
  { id: 'unknown', label: 'Connection state unknown', meaning: 'Closed with no confirming or failing signal. It may have connected; nothing says either way.' },
];

/**
 * How recent the agent's signal must be for "Session active": a little over
 * three heartbeats (the agent reports about every 3 minutes, and re-stamps
 * lastSignalAt while a connection is running).
 */
export const ACTIVE_WINDOW_MS = 10 * 60_000;

/** The API's statuses (SessionStatus), each with its stage. */
export const STATUS_STAGE: Record<string, RemoteStage> = {
  PENDING: 'launch_requested',
  LAUNCH_REQUESTED: 'authorized',
  LAUNCHER_ACKNOWLEDGED: 'authorized',
  CLIENT_OPENED: 'client_opened',
  SESSION_STARTED: 'connection_confirmed',
  SESSION_COMPLETED: 'ended',
  CANCELED: 'ended',
  FAILED: 'failed',
  STATUS_UNKNOWN: 'unknown',
};

export interface SessionEvidence {
  status: string;
  statusSource?: string | null;
  lastSignalAt?: string | Date | null;
  connectionConfirmedAt?: string | Date | null;
  endInferred?: boolean | null;
  endReason?: string | null;
}

export interface StageView {
  stage: RemoteStage;
  label: string;
  /** One sentence on what the evidence shows, and what it does not. */
  detail: string;
}

function since(at: string | Date | null | undefined, now: number): number | null {
  if (!at) return null;
  const t = new Date(at).getTime();
  return Number.isFinite(t) ? now - t : null;
}

function agoText(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

const labelOf = (s: RemoteStage) => STAGES.find((x) => x.id === s)?.label ?? s;

/** What a session shows, from its evidence. An unknown status is "Connection state unknown", never success. */
export function stageOf(s: SessionEvidence, now: number = Date.now()): StageView {
  const status = (s.status ?? '').toUpperCase();
  const base = STATUS_STAGE[status] ?? 'unknown';
  const view = (stage: RemoteStage, detail: string, label = labelOf(stage)): StageView => ({ stage, label, detail });

  switch (status) {
    case 'PENDING':
      return view(base, 'Recorded. No credential has been released yet.');
    case 'LAUNCH_REQUESTED':
      return view(base, 'The portal released a credential. Nothing has opened a client yet.');
    case 'LAUNCHER_ACKNOWLEDGED':
      return view(base, 'The launcher picked up the credential. RustDesk has not reported opening yet.');
    case 'CLIENT_OPENED':
      return view(base, 'RustDesk opened on your own computer. The remote device has not confirmed a connection.');
    case 'SESSION_STARTED': {
      const age = since(s.lastSignalAt, now);
      if (s.statusSource === 'endpoint_agent' && age !== null && age <= ACTIVE_WINDOW_MS) {
        return view('active', `The device’s agent saw the connection ${agoText(age)}.`);
      }
      if (s.statusSource === 'technician') {
        return view('connection_confirmed', 'You reported the connection. The device’s agent has not seen it.', 'Connection confirmed by you');
      }
      return view('connection_confirmed', age !== null
        ? `The device’s agent last saw the connection ${agoText(age)}; nothing has seen it since.`
        : 'Confirmed, but nothing has reported on it since.');
    }
    case 'SESSION_COMPLETED':
      if (s.endInferred) return view(base, 'Ended: no signal for a long time, so the end is inferred, not observed.');
      if (s.endReason === 'technician_completed' || s.endReason === 'technician_completed_unconfirmed') return view(base, 'Marked finished by the technician.');
      return view(base, 'The device’s agent saw the connection end.');
    case 'CANCELED':
      return view(base, 'Canceled by the technician.');
    case 'FAILED':
      return view(base, 'A failure was reported before any connection was confirmed.');
    default:
      return view('unknown', 'No confirming or failing signal arrived. It may have connected; nothing says either way.');
  }
}

/** Open (not yet ended, failed or unknown) stages: the ones that can still change. */
export const OPEN_STAGES: readonly RemoteStage[] = ['launch_requested', 'authorized', 'client_opened', 'connection_confirmed', 'active'];

/**
 * A Managed Secure Access grant's timeline step (apps/api/src/msa/session-timeline.ts)
 * in the same eight stages. Launched is the one-time password handed to the
 * technician's launcher: still authorization, never a connection. Connected
 * is what the computer's signed agent saw while the grant was applied.
 */
export const MSA_STEP_STAGE: Record<string, RemoteStage> = {
  requested: 'launch_requested',
  authorized: 'authorized', received: 'authorized', applied: 'authorized', launched: 'authorized',
  connected: 'active',
  disconnected: 'ended', expired: 'ended', revoked: 'ended',
  failed: 'failed',
};
export function msaStageOf(current: string): StageView {
  const stage = MSA_STEP_STAGE[current] ?? 'unknown';
  const meaning = STAGES.find((x) => x.id === stage)?.meaning ?? '';
  return { stage, label: labelOf(stage), detail: stage === 'active' ? 'The device’s signed agent saw RustDesk accept a connection while the grant was applied.' : meaning };
}
