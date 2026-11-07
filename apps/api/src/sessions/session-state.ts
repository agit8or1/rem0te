/**
 * Support-session state, as evidence allows — and no further.
 *
 * Rem0te hands out a credential and RustDesk carries the connection. Nothing
 * in that handoff proves a remote desktop connection happened, so the states
 * below are each tied to the specific signal that can move a session into
 * them, and nothing else may:
 *
 *   status (enum)          shown as               moved there by
 *   ─────────────────────  ─────────────────────  ──────────────────────────────────────
 *   LAUNCH_REQUESTED       Launch requested       server: credential released / session created
 *   LAUNCHER_ACKNOWLEDGED  Launcher acknowledged  server: launcher token redeemed; Connect script
 *                                                 authenticated with its session token
 *   CLIENT_OPENED          Client opened          Connect script / launcher: RustDesk process started
 *   SESSION_STARTED        Connection confirmed   endpoint agent: a RustDesk connection-manager
 *                                                 process is running on the remote computer, and
 *                                                 this is the only launch it can belong to; or the
 *                                                 technician says so (recorded as theirs)
 *   SESSION_COMPLETED      Disconnected / ended   endpoint agent: no connection any more (measured);
 *                                                 technician: completed (reported); timeout (inferred)
 *   FAILED                 Failed                 a reported failure before any confirmation
 *   CANCELED               Canceled               technician
 *   STATUS_UNKNOWN         Status unknown         timeout: no confirming or failing signal arrived
 *
 * Truths this encodes, because each was once violated:
 *   • A client process starting is not a connection. CLIENT_OPENED never
 *     implies SESSION_STARTED.
 *   • A client process exiting is not the end of a particular session — a
 *     technician's RustDesk is shared across sessions — so there is no
 *     "client closed ⇒ completed" rule.
 *   • A failure can never become a success: terminal states are final, and a
 *     late event is recorded (applied=false) but changes nothing.
 *   • Duration is measured only from a confirmed start to an observed end,
 *     both from the endpoint. Anything else leaves `duration` null and says
 *     how the times it does have were obtained (`timingQuality`).
 *
 * Pure: no I/O. sessions/session-events.service.ts persists the result
 * atomically; scripts/unit-schedule-and-session-state.mjs tests it directly.
 */

export type SessionStatusValue =
  | 'PENDING'
  | 'LAUNCH_REQUESTED'
  | 'LAUNCHER_ACKNOWLEDGED'
  | 'CLIENT_OPENED'
  | 'SESSION_STARTED'
  | 'SESSION_COMPLETED'
  | 'FAILED'
  | 'CANCELED'
  | 'STATUS_UNKNOWN';

export type SessionEventType =
  | 'launch_requested'
  | 'launcher_acknowledged'
  | 'client_opened'
  | 'client_launch_failed'
  | 'connection_confirmed'
  | 'disconnected'
  | 'technician_completed'
  | 'technician_canceled'
  | 'technician_failed'
  | 'timeout_unknown'
  | 'timeout_ended';

export type EventSource =
  | 'server'
  | 'launcher'
  | 'connect_script'
  | 'endpoint_agent'
  | 'technician'
  | 'timeout';

/** Which sources may emit which events. Anything else is refused. */
export const ALLOWED_SOURCES: Record<SessionEventType, EventSource[]> = {
  launch_requested: ['server'],
  launcher_acknowledged: ['server', 'launcher', 'connect_script'],
  client_opened: ['launcher', 'connect_script'],
  client_launch_failed: ['launcher', 'connect_script'],
  connection_confirmed: ['endpoint_agent', 'technician'],
  disconnected: ['endpoint_agent'],
  technician_completed: ['technician'],
  technician_canceled: ['technician'],
  technician_failed: ['technician'],
  timeout_unknown: ['timeout'],
  timeout_ended: ['timeout'],
};

export const TERMINAL: SessionStatusValue[] = ['SESSION_COMPLETED', 'FAILED', 'CANCELED', 'STATUS_UNKNOWN'];

const RANK: Record<SessionStatusValue, number> = {
  PENDING: 0,
  LAUNCH_REQUESTED: 1,
  LAUNCHER_ACKNOWLEDGED: 2,
  CLIENT_OPENED: 3,
  SESSION_STARTED: 4,
  SESSION_COMPLETED: 9,
  FAILED: 9,
  CANCELED: 9,
  STATUS_UNKNOWN: 9,
};

export type TimingQuality = 'MEASURED' | 'REPORTED' | 'INFERRED' | 'UNKNOWN' | 'LEGACY';

export interface SessionSnapshot {
  status: SessionStatusValue;
  createdAt: Date;
  launchRequestedAt: Date | null;
  launcherAckAt: Date | null;
  clientOpenedAt: Date | null;
  connectionConfirmedAt: Date | null;
  endedAt: Date | null;
  statusSource: string | null;
  lastSignalAt: Date | null;
  timingQuality: string;
}

export interface SessionEventInput {
  type: SessionEventType;
  source: EventSource;
  /** When the reporter says it happened. Clamped to [createdAt, receivedAt]. */
  occurredAt?: Date | null;
  receivedAt: Date;
}

export interface TransitionResult {
  applied: boolean;
  /** Why nothing changed, when nothing did. */
  reason?: 'session_closed' | 'not_a_forward_step' | 'source_not_allowed' | 'not_confirmed' | 'already_confirmed';
  /** Column updates to persist (empty when not applied, except evidence back-fill). */
  patch: Record<string, unknown>;
}

function clamp(at: Date | null | undefined, lo: Date, hi: Date): Date {
  const t = at && !isNaN(at.getTime()) ? at : hi;
  if (t < lo) return lo;
  if (t > hi) return hi;
  return t;
}

/**
 * Decide what an event does to a session. Deterministic: the same snapshot
 * and event always give the same answer, so duplicates and replays are safe.
 */
export function applySessionEvent(s: SessionSnapshot, ev: SessionEventInput): TransitionResult {
  if (!ALLOWED_SOURCES[ev.type]?.includes(ev.source)) {
    return { applied: false, reason: 'source_not_allowed', patch: {} };
  }
  const at = clamp(ev.occurredAt ?? null, s.createdAt, ev.receivedAt);
  const isTerminal = TERMINAL.includes(s.status);
  const signal = { lastSignalAt: !s.lastSignalAt || at > s.lastSignalAt ? at : s.lastSignalAt };

  if (isTerminal) {
    // Recorded by the caller, never applied: an old "connected" arriving
    // after a session was closed must not reopen it.
    return { applied: false, reason: 'session_closed', patch: {} };
  }

  const confirmed = s.status === 'SESSION_STARTED';
  const forward = (target: SessionStatusValue, extra: Record<string, unknown>): TransitionResult => {
    if (RANK[target] <= RANK[s.status]) {
      // Out of order or repeated (e.g. client_opened after confirmation):
      // back-fill the evidence timestamp if we never had it, change nothing else.
      return { applied: false, reason: 'not_a_forward_step', patch: backfill(s, ev.type, at) };
    }
    return {
      applied: true,
      patch: { status: target, statusSource: ev.source, statusChangedAt: ev.receivedAt, ...signal, ...extra },
    };
  };

  switch (ev.type) {
    case 'launch_requested':
      return forward('LAUNCH_REQUESTED', { launchRequestedAt: s.launchRequestedAt ?? at });
    case 'launcher_acknowledged':
      return forward('LAUNCHER_ACKNOWLEDGED', { launcherAckAt: s.launcherAckAt ?? at });
    case 'client_opened':
      return forward('CLIENT_OPENED', { clientOpenedAt: s.clientOpenedAt ?? at });
    case 'connection_confirmed':
      if (confirmed) return { applied: false, reason: 'already_confirmed', patch: signal };
      return forward('SESSION_STARTED', {
        connectionConfirmedAt: at,
        // Kept in step for older readers of the legacy column.
        startedAt: at,
        timingQuality: ev.source === 'endpoint_agent' ? 'UNKNOWN' : 'REPORTED',
      });

    case 'client_launch_failed':
    case 'technician_failed':
      if (confirmed) {
        // A connection was confirmed; "failed" afterwards is an end, not a
        // failed launch, and never erases the confirmation.
        return end(s, ev, at, 'failed_after_connect', ev.source === 'technician' ? 'REPORTED' : 'UNKNOWN');
      }
      return {
        applied: true,
        patch: {
          status: 'FAILED', statusSource: ev.source, statusChangedAt: ev.receivedAt, ...signal,
          endedAt: at, completedAt: at, endReason: ev.type, endInferred: false, duration: null,
          timingQuality: 'UNKNOWN',
        },
      };

    case 'disconnected':
      if (!confirmed) return { applied: false, reason: 'not_confirmed', patch: {} };
      return end(s, ev, at, 'endpoint_reported_disconnect', 'MEASURED');

    case 'technician_completed':
      if (confirmed) return end(s, ev, at, 'technician_completed', 'REPORTED');
      // Completed without any confirmation: the technician closed it out, but
      // nothing proves a connection happened. Ended, with no timing claimed.
      return {
        applied: true,
        patch: {
          status: 'SESSION_COMPLETED', statusSource: 'technician', statusChangedAt: ev.receivedAt, ...signal,
          endedAt: at, completedAt: at, endReason: 'technician_completed_unconfirmed', endInferred: false,
          duration: null, timingQuality: 'UNKNOWN',
        },
      };

    case 'technician_canceled':
      return {
        applied: true,
        patch: {
          status: 'CANCELED', statusSource: 'technician', statusChangedAt: ev.receivedAt, ...signal,
          endedAt: at, completedAt: at, endReason: 'canceled', endInferred: false, duration: null,
          timingQuality: confirmed ? 'REPORTED' : 'UNKNOWN',
        },
      };

    case 'timeout_unknown':
      if (confirmed) return { applied: false, reason: 'already_confirmed', patch: {} };
      return {
        applied: true,
        patch: {
          status: 'STATUS_UNKNOWN', statusSource: 'timeout', statusChangedAt: ev.receivedAt,
          endedAt: null, completedAt: ev.receivedAt, endReason: 'no_signal_timeout', endInferred: true,
          duration: null, timingQuality: 'UNKNOWN',
        },
      };

    case 'timeout_ended':
      if (!confirmed) return { applied: false, reason: 'not_confirmed', patch: {} };
      // The end is inferred: we record the LAST time anything reported the
      // session alive, flagged as inferred, and claim no duration.
      return {
        applied: true,
        patch: {
          status: 'SESSION_COMPLETED', statusSource: 'timeout', statusChangedAt: ev.receivedAt,
          endedAt: s.lastSignalAt ?? s.connectionConfirmedAt, completedAt: ev.receivedAt,
          endReason: 'no_end_signal_timeout', endInferred: true, duration: null, timingQuality: 'INFERRED',
        },
      };
  }
  return { applied: false, reason: 'not_a_forward_step', patch: {} };
}

function end(
  s: SessionSnapshot, ev: SessionEventInput, at: Date, reason: string, quality: TimingQuality,
): TransitionResult {
  const start = s.connectionConfirmedAt;
  const endAt = start && at < start ? start : at;
  // Measured only when BOTH ends came from the endpoint agent.
  const measured = quality === 'MEASURED' && s.statusSource === 'endpoint_agent' && !!start;
  return {
    applied: true,
    patch: {
      status: 'SESSION_COMPLETED', statusSource: ev.source, statusChangedAt: ev.receivedAt,
      lastSignalAt: endAt, endedAt: endAt, completedAt: endAt, endReason: reason, endInferred: false,
      duration: measured && start ? Math.max(0, Math.round((endAt.getTime() - start.getTime()) / 1000)) : null,
      timingQuality: measured ? 'MEASURED' : (quality === 'MEASURED' ? 'REPORTED' : quality),
    },
  };
}

function backfill(s: SessionSnapshot, type: SessionEventType, at: Date): Record<string, unknown> {
  if (type === 'launch_requested' && !s.launchRequestedAt) return { launchRequestedAt: at };
  if (type === 'launcher_acknowledged' && !s.launcherAckAt) return { launcherAckAt: at };
  if (type === 'client_opened' && !s.clientOpenedAt) return { clientOpenedAt: at };
  return {};
}

/** Statuses that count as "still open" for queues, sweepers and update deferral. */
export const OPEN_STATUSES: SessionStatusValue[] = [
  'PENDING', 'LAUNCH_REQUESTED', 'LAUNCHER_ACKNOWLEDGED', 'CLIENT_OPENED', 'SESSION_STARTED',
];

/** Launched, but nothing has opened a client yet. A launcher token may only be bound to one of these. */
export const PRE_CLIENT_STATUSES: SessionStatusValue[] = ['PENDING', 'LAUNCH_REQUESTED', 'LAUNCHER_ACKNOWLEDGED'];

/** Human label for a status, shared vocabulary with the web badge. */
export const STATUS_LABEL: Record<SessionStatusValue, string> = {
  PENDING: 'Recorded',
  LAUNCH_REQUESTED: 'Launch requested',
  LAUNCHER_ACKNOWLEDGED: 'Launcher acknowledged',
  CLIENT_OPENED: 'Client opened',
  SESSION_STARTED: 'Connection confirmed',
  SESSION_COMPLETED: 'Disconnected',
  FAILED: 'Failed',
  CANCELED: 'Canceled',
  STATUS_UNKNOWN: 'Status unknown',
};
