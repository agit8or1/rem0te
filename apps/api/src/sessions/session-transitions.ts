/**
 * Support session state transitions — the single list of which status may
 * follow which.
 *
 * Every write that changes `SupportSession.status` takes its allowed
 * from-states from here and puts them in the WHERE clause of a conditional
 * update (`updateMany({ where: { id, status: { in: from } } })`). The check
 * and the write are the same statement, so two events racing each other
 * cannot both pass a read and then both write. A count of 0 means the session
 * was no longer in a state the transition applies to, and nothing changes.
 *
 * Before 0.19.12 the writers each decided for themselves:
 *   - POST /sessions/:id/events with `client_opened` set CLIENT_OPENED and a
 *     new startedAt on any session, including a completed one. A late,
 *     duplicated or forged event reopened it and reset its duration.
 *   - launcher redemption refused only SESSION_COMPLETED, so a CANCELED or
 *     FAILED session could be reopened by redeeming its token.
 *   - complete/cancel read the status, tested it, then wrote without a
 *     condition, so a concurrent close could still be overwritten.
 */
import { SessionStatus } from '@prisma/client';

/** Closed for good. No transition leaves these. */
export const TERMINAL_STATUSES: readonly SessionStatus[] = [
  SessionStatus.SESSION_COMPLETED,
  SessionStatus.FAILED,
  SessionStatus.CANCELED,
];

/** Launched, but no client has opened yet. */
export const PRE_CLIENT_STATUSES: readonly SessionStatus[] = [
  SessionStatus.PENDING,
  SessionStatus.LAUNCH_REQUESTED,
  SessionStatus.LAUNCHER_ACKNOWLEDGED,
];

/** A client has opened. */
export const CLIENT_STATUSES: readonly SessionStatus[] = [
  SessionStatus.CLIENT_OPENED,
  SessionStatus.SESSION_STARTED,
];

export const OPEN_STATUSES: readonly SessionStatus[] = [...PRE_CLIENT_STATUSES, ...CLIENT_STATUSES];

export function isTerminal(status: SessionStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Events a technician may post to /sessions/:id/events.
 *
 *   client_opened  forward to CLIENT_OPENED, and only from a pre-client state.
 *                  A repeat once CLIENT_OPENED is not a step forward and is
 *                  refused, so it cannot move startedAt (and the duration).
 *   client_closed  forward to SESSION_COMPLETED, only once a client opened.
 *   anything else  an annotation on the timeline: stored, changes no status,
 *                  and only accepted while the session is still open.
 */
export const EVENT_TRANSITIONS: Record<string, { to: SessionStatus; from: readonly SessionStatus[] }> = {
  client_opened: { to: SessionStatus.CLIENT_OPENED, from: PRE_CLIENT_STATUSES },
  client_closed: { to: SessionStatus.SESSION_COMPLETED, from: CLIENT_STATUSES },
};

/** Manual close by a person: from any open state. */
export const CLOSE_FROM: readonly SessionStatus[] = OPEN_STATUSES;

/** Event names: plain identifiers, so they render inertly in the timeline. */
export const EVENT_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** Allowed from-states for moving to `to`, or null if it is never allowed. */
export function allowedFrom(to: SessionStatus): readonly SessionStatus[] | null {
  switch (to) {
    case SessionStatus.LAUNCH_REQUESTED: return [SessionStatus.PENDING];
    case SessionStatus.LAUNCHER_ACKNOWLEDGED: return [SessionStatus.PENDING, SessionStatus.LAUNCH_REQUESTED];
    case SessionStatus.CLIENT_OPENED: return PRE_CLIENT_STATUSES;
    case SessionStatus.SESSION_STARTED: return [...PRE_CLIENT_STATUSES, SessionStatus.CLIENT_OPENED];
    case SessionStatus.SESSION_COMPLETED:
    case SessionStatus.FAILED:
    case SessionStatus.CANCELED: return OPEN_STATUSES;
    default: return null;
  }
}

export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return allowedFrom(to)?.includes(from) ?? false;
}
