/**
 * Automatic snapshots (0.35): when the server asks a computer for its
 * process list, service list and network adapters without anyone pressing
 * Refresh.
 *
 * Pure: no Nest, no Prisma. The heartbeat (diagnostics-catalog.service.ts
 * scheduleAutomatic) and the snapshot read both call these, the unit test
 * (scripts/unit-snapshot-schedule.mjs) runs them, and the static invariant
 * check (§50) reads them.
 *
 * **Piggy-backed on the heartbeat, not a sweep over the fleet.** A key is
 * asked for while the computer is checking in — in the heartbeat that
 * finds it stale — so a computer whose agent is silent is never asked
 * (nothing would collect it) and no row is written per computer per tick.
 * The run that results is an ordinary DiagnosticRun with no requester
 * (`requestedById` null), delivered, sanitised, capped and stored exactly
 * like one a person asked for; the database refuses a requester-less run of
 * any key that is not a snapshot key (migration 0059), so nothing else can
 * be scheduled this way.
 *
 * **Cadence** (defaults; a Platform Admin changes them in Settings →
 * Monitoring & API, audited). Every snapshot key every 6 hours — the same
 * cadence as the inventory pass (endpoint-inventory.service.ts
 * INVENTORY_STALE_HOURS) — and, while somebody has the key's tab open,
 * every 5 minutes. Why, against docs/server-sizing.md at 5,000 computers:
 *
 *   payload (computed by unit-snapshot-schedule.mjs from the sanitiser, for
 *   a typical desktop): process list ≈ 250 rows ≈ 35 KB; service list
 *   ≈ 280 rows ≈ 41 KB; adapters ≈ 4 ≈ 2 KB. Capped at 128 KB each.
 *
 *   every 6 h: 3 keys × 4 a day × 5,000 = 60,000 uploads a day — 0.7 a
 *   second beside the 27.8 heartbeats a second the fleet already sends —
 *   and ≈ 1.6 GB a day uploaded. Stored, it levels off at one completed
 *   automatic run per key per computer (older ones are deleted when a newer
 *   one completes): ≈ 78 KB × 5,000 ≈ 400 MB.
 *
 *   every 1 h for processes (the other choice considered): 120,000 uploads
 *   and ≈ 4 GB a day for processes alone, to keep a list that is out of
 *   date within minutes of being taken. A process list is worth having
 *   *now* while someone is looking, and as a rough picture otherwise — so
 *   it gets the watched cadence while its tab is open, and 6 h otherwise.
 *
 *   watched (5 min): one computer's tab open for an hour costs ≈ 12 uploads
 *   of one key. The heartbeat is every 3 minutes, so 5 minutes means "on the
 *   next check-in after the last one aged out" (≈ every 6 minutes).
 *
 * **Who is asked.** Only a computer that is ACTIVE, Windows, bound to a
 * device secret, on an agent from 0.33 or later (older agents do not know
 * the snapshot keys: 0.31–0.32 refuse them, older ones never start), and
 * checking in. Containment does not apply: a pause stops writes, and
 * reading a process list is viewing (docs/containment.md: "Viewing,
 * reports and the audit log keep working during a pause"), the same as the
 * automatic inventory pass and a manual Refresh.
 */
import { HEARTBEAT_STALE_MS } from '../common/connectivity';
import { compareVersions } from '../common/agent-contract';
import { SNAPSHOT_KEYS, type SnapshotKey } from './catalog';

/** The agent release that first knew the snapshot keys. */
export const SNAPSHOT_MIN_AGENT = '0.33.0';

/**
 * A heartbeat older than this is a missed check-in. It is the console's one
 * window, HEARTBEAT_STALE_MS (30 minutes, common/connectivity.ts), so the tab
 * calls a computer "agent silent" exactly when its header does. (Written
 * against 10 minutes, which the old method default said; the sweep has always
 * run with 30.)
 */
export const AGENT_SILENT_MS = HEARTBEAT_STALE_MS;

/** The agent's heartbeat cadence, for "next automatic refresh around …". */
export const HEARTBEAT_EVERY_MS = 3 * 60_000;

/** A snapshot read within this long counts as "the tab is open". The page re-reads every 30 s. */
export const WATCH_WINDOW_MS = 90_000;

/** After a failed or expired automatic run, wait at most this long before the next. */
export const RETRY_AFTER_FAILURE_MINUTES = 60;

export interface SnapshotSchedule {
  /** The platform-wide switch. Off: nothing is asked for automatically; Refresh still works. */
  enabled: boolean;
  /** Per key, minutes between automatic snapshots. 0 = not on a schedule. */
  minutes: Record<SnapshotKey, number>;
  /** While the key's tab is open, minutes between snapshots. 0 = not while watched. */
  watchMinutes: number;
}

export const SCHEDULE_DEFAULTS: SnapshotSchedule = {
  enabled: true,
  minutes: { process_list: 360, service_list: 360, network_adapters: 360 },
  watchMinutes: 5,
};

/**
 * Bounds. An interval is 0 (off) or 60 minutes to 7 days; the watched one is
 * 0 or 3 to 60 minutes (3 is the heartbeat: anything less is the same as 3).
 * The database CHECKs in migration 0059 hold the same bounds.
 */
export const INTERVAL_MIN = 60;
export const INTERVAL_MAX = 10_080;
export const WATCH_MIN = 3;
export const WATCH_MAX = 60;

/** The column each key's interval lives in on PlatformSettings. */
export const SCHEDULE_COLUMN: Record<SnapshotKey, 'snapshotProcessMinutes' | 'snapshotServiceMinutes' | 'snapshotNetworkMinutes'> = {
  process_list: 'snapshotProcessMinutes',
  service_list: 'snapshotServiceMinutes',
  network_adapters: 'snapshotNetworkMinutes',
};

/** Whether this process schedules anything. Anything but the exact word "off" leaves it on. */
export const sweepEnabled = (env: Record<string, string | undefined>) => env.SNAPSHOT_SWEEP !== 'off';

/** The stored row (or nothing yet) as a schedule. Out-of-range values fall back to the default. */
export function scheduleFrom(row: Partial<Record<string, unknown>> | null | undefined): SnapshotSchedule {
  const okInterval = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && (v === 0 || (v >= INTERVAL_MIN && v <= INTERVAL_MAX));
  const okWatch = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && (v === 0 || (v >= WATCH_MIN && v <= WATCH_MAX));
  const minutes = {} as Record<SnapshotKey, number>;
  for (const k of SNAPSHOT_KEYS) {
    const v = row?.[SCHEDULE_COLUMN[k]];
    minutes[k] = okInterval(v) ? (v as number) : SCHEDULE_DEFAULTS.minutes[k];
  }
  return {
    enabled: typeof row?.snapshotAutoEnabled === 'boolean' ? row.snapshotAutoEnabled : SCHEDULE_DEFAULTS.enabled,
    minutes,
    watchMinutes: okWatch(row?.snapshotWatchMinutes) ? (row!.snapshotWatchMinutes as number) : SCHEDULE_DEFAULTS.watchMinutes,
  };
}

export type ScheduleUpdate = Partial<{ enabled: boolean; minutes: Partial<Record<SnapshotKey, number>>; watchMinutes: number }>;

/**
 * Validate a Settings change. Returns the column values to write, or an
 * error naming the field. Unknown fields and keys are refused, not ignored:
 * a typo should not look like a saved setting.
 */
export function parseScheduleUpdate(body: unknown): { ok: true; data: Record<string, number | boolean> } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Expected an object.' };
  const b = body as Record<string, unknown>;
  const data: Record<string, number | boolean> = {};
  for (const f of Object.keys(b)) if (!['enabled', 'minutes', 'watchMinutes'].includes(f)) return { ok: false, error: `Unknown field: ${f}` };
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') return { ok: false, error: 'enabled must be true or false.' };
    data.snapshotAutoEnabled = b.enabled;
  }
  if (b.minutes !== undefined) {
    if (!b.minutes || typeof b.minutes !== 'object' || Array.isArray(b.minutes)) return { ok: false, error: 'minutes must be an object keyed by snapshot.' };
    for (const [k, v] of Object.entries(b.minutes as Record<string, unknown>)) {
      if (!(SNAPSHOT_KEYS as readonly string[]).includes(k)) return { ok: false, error: `Not a snapshot: ${k}` };
      if (typeof v !== 'number' || !Number.isInteger(v) || !(v === 0 || (v >= INTERVAL_MIN && v <= INTERVAL_MAX))) {
        return { ok: false, error: `${k}: 0 (off) or ${INTERVAL_MIN}–${INTERVAL_MAX} minutes.` };
      }
      data[SCHEDULE_COLUMN[k as SnapshotKey]] = v;
    }
  }
  if (b.watchMinutes !== undefined) {
    const v = b.watchMinutes;
    if (typeof v !== 'number' || !Number.isInteger(v) || !(v === 0 || (v >= WATCH_MIN && v <= WATCH_MAX))) {
      return { ok: false, error: `watchMinutes: 0 (off) or ${WATCH_MIN}–${WATCH_MAX} minutes.` };
    }
    data.snapshotWatchMinutes = v;
  }
  if (!Object.keys(data).length) return { ok: false, error: 'Nothing to change.' };
  return { ok: true, data };
}

// ── Who can be asked ─────────────────────────────────────────────────────────

export type Ineligible =
  | 'not_active'           // pending enrolment or archived
  | 'unsupported_platform' // the snapshots are collected by the Windows agents only
  | 'not_bound'            // never authenticated with a device secret
  | 'agent_unknown'        // never reported an agent version
  | 'agent_too_old'        // reported one older than SNAPSHOT_MIN_AGENT
  | 'agent_silent';        // has not checked in for AGENT_SILENT_MS (it may still be reachable through RustDesk)

export interface ComputerFacts {
  status: string | null | undefined;
  platform: string | null | undefined;
  agentBound: boolean;
  agentVersion: string | null | undefined;
  lastSeenAt: Date | string | null | undefined;
}

// Two to four dot-separated numbers, each at most 6 digits (no nested quantifier).
const isVersion = (v: string) => /^v?[0-9.]{3,32}$/.test(v) && v.replace(/^v/, '').split('.').every((p) => /^[0-9]{1,6}$/.test(p)) && v.split('.').length >= 2 && v.split('.').length <= 4;
export const isWindows = (platform: string | null | undefined) => !!platform && /windows/i.test(platform);

/** Why this computer cannot be asked for a snapshot automatically, or null if it can. Order matters: the first reason is the one shown. */
export function ineligible(c: ComputerFacts, now: number): Ineligible | null {
  if (c.status !== 'ACTIVE') return 'not_active';
  if (!isWindows(c.platform)) return 'unsupported_platform';
  if (!c.agentBound) return 'not_bound';
  if (!c.agentVersion || !isVersion(c.agentVersion)) return 'agent_unknown';
  if (compareVersions(c.agentVersion, SNAPSHOT_MIN_AGENT) < 0) return 'agent_too_old';
  const seen = c.lastSeenAt ? new Date(c.lastSeenAt).getTime() : NaN;
  if (!Number.isFinite(seen) || now - seen > AGENT_SILENT_MS) return 'agent_silent';
  return null;
}

// ── When a key is due ────────────────────────────────────────────────────────

export interface KeyHistory {
  /** The newest COMPLETED run of this key, by anyone. */
  lastCompletedAt: Date | null;
  /** The newest automatic run of this key, whatever became of it. */
  lastAutoRequestedAt: Date | null;
  /** Whether that automatic run failed or expired. */
  lastAutoFailed: boolean;
  /** A run of this key (by anyone) is still open. */
  open: boolean;
}

/** The interval that applies to a key now, in minutes, and why; null when nothing applies. */
export function effectiveInterval(s: SnapshotSchedule, key: SnapshotKey, watched: boolean): { minutes: number; basis: 'schedule' | 'watch' } | null {
  const base = s.minutes[key];
  const watch = watched && s.watchMinutes > 0 ? s.watchMinutes : 0;
  if (!base && !watch) return null;
  if (watch && (!base || watch < base)) return { minutes: watch, basis: 'watch' };
  return { minutes: base, basis: 'schedule' };
}

/**
 * When the next automatic run of a key may be asked for (epoch ms), or null
 * when none will be. `now` or earlier means "at the next check-in".
 */
export function nextDueAt(s: SnapshotSchedule, key: SnapshotKey, h: KeyHistory, watched: boolean): { at: number; basis: 'schedule' | 'watch' } | null {
  if (!s.enabled) return null;
  const iv = effectiveInterval(s, key, watched);
  if (!iv) return null;
  const ms = iv.minutes * 60_000;
  let at = h.lastCompletedAt ? h.lastCompletedAt.getTime() + ms : 0;
  // A failed automatic attempt is retried after the interval or an hour,
  // whichever is sooner — never on the next heartbeat. Without this a
  // computer that cannot answer (a broken WMI repository) would be asked
  // every three minutes, the trap the inventory pass fell into in 0.32.
  if (h.lastAutoRequestedAt) {
    const wait = h.lastAutoFailed ? Math.min(ms, RETRY_AFTER_FAILURE_MINUTES * 60_000) : ms;
    at = Math.max(at, h.lastAutoRequestedAt.getTime() + wait);
  }
  return { at, basis: iv.basis };
}

/** The keys to ask this computer for on this heartbeat. The caller has checked `ineligible` and the off switches. */
export function dueKeys(s: SnapshotSchedule, now: number, history: Record<SnapshotKey, KeyHistory>, watched: (k: SnapshotKey) => boolean): { key: SnapshotKey; basis: 'schedule' | 'watch' }[] {
  if (!s.enabled) return [];
  const out: { key: SnapshotKey; basis: 'schedule' | 'watch' }[] = [];
  for (const key of SNAPSHOT_KEYS) {
    const h = history[key];
    if (!h || h.open) continue;
    const next = nextDueAt(s, key, h, watched(key));
    if (next && next.at <= now) out.push({ key, basis: next.basis });
  }
  return out;
}

/**
 * What the snapshot tab says about automatic collection, for one key on one
 * computer. `state` is one of:
 *   on        — will be asked for; `nextAt` is roughly when (it is asked on
 *               the first check-in at or after that time);
 *   off       — the platform switch or this key's interval is off, or this
 *               process runs with SNAPSHOT_SWEEP=off;
 *   blocked   — the computer cannot be asked (`reason`).
 */
export function automaticState(args: {
  schedule: SnapshotSchedule; processEnabled: boolean; key: SnapshotKey; computer: ComputerFacts;
  history: KeyHistory; watched: boolean; now: number;
}): { state: 'on' | 'off' | 'blocked'; reason: Ineligible | 'disabled' | 'key_off' | 'process_off' | null; nextAt: string | null; intervalMinutes: number | null; basis: 'schedule' | 'watch' | null } {
  const { schedule: s, key, now } = args;
  const why = ineligible(args.computer, now);
  // Unsupported, not bound, too old: no schedule could help, so say that first.
  if (why && why !== 'agent_silent') return { state: 'blocked', reason: why, nextAt: null, intervalMinutes: null, basis: null };
  if (!args.processEnabled) return { state: 'off', reason: 'process_off', nextAt: null, intervalMinutes: null, basis: null };
  if (!s.enabled) return { state: 'off', reason: 'disabled', nextAt: null, intervalMinutes: null, basis: null };
  const iv = effectiveInterval(s, key, args.watched);
  if (!iv) return { state: 'off', reason: 'key_off', nextAt: null, intervalMinutes: null, basis: null };
  if (why) return { state: 'blocked', reason: why, nextAt: null, intervalMinutes: iv.minutes, basis: iv.basis };
  const next = nextDueAt(s, key, args.history, args.watched);
  if (!next) return { state: 'off', reason: 'key_off', nextAt: null, intervalMinutes: null, basis: null };
  // Due already: it goes out on the next check-in, about three minutes after the last.
  const seen = args.computer.lastSeenAt ? new Date(args.computer.lastSeenAt).getTime() : now;
  const at = args.history.open ? null : next.at <= now ? Math.max(now, seen + HEARTBEAT_EVERY_MS) : next.at;
  return { state: 'on', reason: null, nextAt: at === null ? null : new Date(at).toISOString(), intervalMinutes: iv.minutes, basis: next.basis };
}

// ── Fleet-wide pacing ────────────────────────────────────────────────────────

/**
 * Scheduled (not watched) runs this API process starts per minute, at most.
 * The first heartbeat after an upgrade finds every computer's snapshots
 * missing, and so does the first one after an outage: without a cap, 5,000
 * computers would each be asked for three snapshots within the same three
 * minutes (≈ 80 uploads a second of up to 128 KB). At 120 a minute the
 * backlog drains in about two hours and steady state (≈ 42 a minute at
 * 5,000 computers) never reaches the cap. A key held back stays due and is
 * asked for on a later check-in. A watched key — someone has the tab open —
 * is not held back.
 */
export const PER_MINUTE_DEFAULT = 120;
export function perMinuteFrom(env: Record<string, string | undefined>): number {
  const n = Number(env.SNAPSHOT_MAX_PER_MINUTE);
  if (env.SNAPSHOT_MAX_PER_MINUTE === undefined || env.SNAPSHOT_MAX_PER_MINUTE.trim() === '' || !Number.isFinite(n)) return PER_MINUTE_DEFAULT;
  return Math.min(10_000, Math.max(1, Math.round(n)));
}

/** A token bucket refilled continuously at `perMinute`, holding at most `perMinute`. */
export class Pacer {
  private tokens: number;
  private at: number;
  constructor(private readonly perMinute: number, now = Date.now()) { this.tokens = perMinute; this.at = now; }
  take(now = Date.now()): boolean {
    this.tokens = Math.min(this.perMinute, this.tokens + ((now - this.at) / 60_000) * this.perMinute);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
