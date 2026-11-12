/**
 * Two facts about a computer that the console used to show as one (0.35).
 *
 * `Endpoint.isOnline` is true while the agent heartbeats, AND while hbbs
 * reports the computer's RustDesk peer online even though the heartbeat has
 * stopped — EnrollmentService.markStaleEndpointsOffline keeps it true on
 * purpose, because the machine can still be remote-controlled. So
 * `isOnline` alone means "reachable", not "reporting": a computer whose
 * agent died twelve days ago, with RustDesk still running, was drawn
 * "Online" with a green dot while every monitoring, patching and action
 * value on it was twelve days old.
 *
 *   online        isOnline, and a heartbeat inside HEARTBEAT_STALE_MS
 *   agent_silent  isOnline (RustDesk reachable), but no heartbeat inside it
 *   offline       not isOnline
 *
 * HEARTBEAT_STALE_MS is the sweep's own window: the sweep runs with it
 * (enrollment.controller.ts, every minute), so a computer is "agent silent"
 * from exactly the moment the sweep would have taken it offline had hbbs not
 * been keeping it reachable. It is 30 minutes — what the sweep has always
 * been called with (older installers heartbeat rarely; current ones every 3
 * minutes) — not the 10 the method's old default and the web app's old
 * constant said. The web app
 * mirrors it in apps/web/lib/connectivity.ts; §47 of the security
 * invariants checks the two agree.
 */
export const HEARTBEAT_STALE_MS = 30 * 60_000;

export type Connectivity = 'online' | 'agent_silent' | 'offline';

export function connectivityOf(isOnline: boolean, lastSeenAt: Date | string | null | undefined, now: number = Date.now()): Connectivity {
  if (!isOnline) return 'offline';
  const at = lastSeenAt ? new Date(lastSeenAt).getTime() : NaN;
  return Number.isFinite(at) && now - at <= HEARTBEAT_STALE_MS ? 'online' : 'agent_silent';
}

/** The heartbeat cutoff as a Date, for queries: a heartbeat at or after it is current. */
export const heartbeatCutoff = (now: number = Date.now()) => new Date(now - HEARTBEAT_STALE_MS);
