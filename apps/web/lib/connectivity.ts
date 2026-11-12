/**
 * Reachable is not reporting (0.35).
 *
 * `isOnline` is true while the agent heartbeats AND while the RustDesk
 * server (hbbs) can reach the computer with its agent silent — the stale
 * sweep keeps it true on purpose, because the machine can still be
 * remote-controlled. Drawn as one green "Online", a computer whose agent
 * died twelve days ago looked healthy while everything it reports was
 * twelve days old. So the console shows three states:
 *
 *   online        green  — the agent is checking in
 *   agent_silent  amber  — reachable through RustDesk; the agent is silent
 *   offline       grey   — not reachable
 *
 * The API sends `connectivity` on the device list, the device page, search
 * and the dashboard (apps/api/src/common/connectivity.ts); `connectivityOf`
 * here is for payloads that carry only isOnline and lastSeenAt, with the same
 * window — §49 of the security invariants checks the two constants agree.
 */
export const HEARTBEAT_STALE_MS = 30 * 60_000;

export type Connectivity = 'online' | 'agent_silent' | 'offline';

export function connectivityOf(isOnline: unknown, lastSeenAt: unknown, now: number = Date.now()): Connectivity {
  if (!isOnline) return 'offline';
  const at = typeof lastSeenAt === 'string' || lastSeenAt instanceof Date ? new Date(lastSeenAt).getTime() : NaN;
  return Number.isFinite(at) && now - at <= HEARTBEAT_STALE_MS ? 'online' : 'agent_silent';
}

/** The server's value when the payload has one, else derived. */
export function connectivityFrom(x: { connectivity?: unknown; isOnline?: unknown; lastSeenAt?: unknown }, now?: number): Connectivity {
  const c = x.connectivity;
  return c === 'online' || c === 'agent_silent' || c === 'offline' ? c : connectivityOf(x.isOnline, x.lastSeenAt, now);
}

export const CONNECTIVITY_DOT: Record<Connectivity, string> = {
  online: 'bg-green-500',
  agent_silent: 'bg-amber-500',
  offline: 'bg-gray-400',
};

export const CONNECTIVITY_TEXT: Record<Connectivity, string> = {
  online: 'text-green-700 dark:text-green-400',
  agent_silent: 'text-amber-700 dark:text-amber-400',
  offline: 'text-muted-foreground',
};

function silentFor(lastSeenAt: unknown, now: number): string {
  if (typeof lastSeenAt !== 'string' && !(lastSeenAt instanceof Date)) return 'never reported';
  const ms = now - new Date(lastSeenAt).getTime();
  if (!Number.isFinite(ms)) return 'never reported';
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} d`;
}

/** "Online", "Reachable (RustDesk) · agent silent 12 d", "Offline". */
export function connectivityLabel(c: Connectivity, lastSeenAt?: unknown, now: number = Date.now()): string {
  if (c === 'online') return 'Online';
  if (c === 'offline') return 'Offline';
  const s = silentFor(lastSeenAt, now);
  return s === 'never reported' ? 'Reachable (RustDesk) · no agent report' : `Reachable (RustDesk) · agent silent ${s}`;
}

/** The tooltip: what still works and what does not, and what to do about it. */
export function connectivityHint(c: Connectivity): string {
  if (c === 'online') return 'The agent is checking in: what it reports is current.';
  if (c === 'offline') return 'Not reachable: no heartbeat, and the RustDesk server cannot see it.';
  return 'The RustDesk server can reach this computer, so remote control should work. Its agent has not checked in, so monitoring, patching and actions are not reporting. Try Update agent on the Agent card of its Overview.';
}
