import {
  type AccessSchedule, describeSchedule, isOpenAtClock, isValidTimeZone, isWithinSchedule, parseSchedule,
} from '../rbac/schedule';

/**
 * The update window of a client-update policy (0.32): when a business's
 * RustDesk clients may be updated without anyone clicking Update.
 *
 * Same shape and rules as every other weekly window here (rbac/schedule.ts):
 * days 0 = Sunday … 6 = Saturday and HH:MM wall-clock times, both in an
 * explicit IANA time zone; an end earlier than the start crosses midnight and
 * belongs to the day it starts on. "Is it open now?" is exactly
 * `isWithinSchedule`, so a technician access window and an update window can
 * never disagree about what 22:00–05:00 means.
 *
 * What this adds:
 *   - stricter validation: at most 7 windows, none shorter than 30 minutes
 *     (an install that is handed out in the last minute of a window is still
 *     running when the window closes — a window that short is a mistake);
 *   - `windowState`: open now?, when does it close, when does it next open.
 *
 * Daylight saving is never computed with local-time arithmetic. The scan walks
 * real instants a minute at a time and reads each one's wall clock; the zone's
 * UTC offset is sampled every 15 minutes and, wherever two samples differ (a
 * transition falls between them), every minute in between is converted with
 * Intl directly. So a window at 02:30 on a spring-forward night opens when the
 * clock reaches 03:00 (02:30 does not exist; 03:00 is inside 02:30–05:00), and
 * on a fall-back night 01:00–02:00 covers both real hours that read 01:xx —
 * the same answers `isWithinSchedule` gives, by construction.
 *
 * Pure: unit-tested without a database (scripts/unit-update-window.mjs).
 */

export const MIN_WINDOW_MINUTES = 30;
export const MAX_WINDOWS = 7;
/** How far ahead `windowState` looks. A weekly schedule repeats within 7 days; 8 covers a DST week. */
export const HORIZON_DAYS = 8;

const MINUTE = 60_000;
const SAMPLE_MINUTES = 15;

export type UpdateWindow = AccessSchedule;

const toMinutes = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

/** Length of one window in minutes; one that crosses midnight wraps. */
export function windowLengthMinutes(w: { start: string; end: string }): number {
  return (toMinutes(w.end) - toMinutes(w.start) + 1440) % 1440;
}

/**
 * Validate untrusted input into an update window, or throw an Error whose
 * message is fit for a 400.
 */
export function parseUpdateWindow(timeZone: unknown, windows: unknown): UpdateWindow {
  if (!isValidTimeZone(timeZone)) throw new Error('timeZone must be a valid IANA time zone, e.g. "Europe/London"');
  if (Array.isArray(windows) && windows.length > MAX_WINDOWS) throw new Error(`At most ${MAX_WINDOWS} update windows`);
  const s = parseSchedule({ timeZone, windows });
  if (!s) throw new Error('An update window is required');
  s.windows.forEach((w, i) => {
    if (windowLengthMinutes(w) < MIN_WINDOW_MINUTES) {
      throw new Error(`Window ${i + 1}: ${w.start}–${w.end} is shorter than ${MIN_WINDOW_MINUTES} minutes`);
    }
  });
  return s;
}

/** Read a stored window; a malformed one is treated as never open (fails closed). */
export function storedWindow(timeZone: unknown, windows: unknown): UpdateWindow | null {
  try { return parseUpdateWindow(timeZone, windows); } catch { return null; }
}

/** Is the window open at `at`? A missing or malformed window is closed. */
export function isWindowOpen(w: UpdateWindow | null, at: Date = new Date()): boolean {
  return !!w && isWithinSchedule(w, at);
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(timeZone: string) {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    fmtCache.set(timeZone, f);
  }
  return f;
}

/** The zone's offset from UTC at instant `t` (ms), in whole minutes: local wall clock − UTC. */
export function utcOffsetMinutes(t: number, timeZone: string): number {
  const parts = fmt(timeZone).formatToParts(new Date(t));
  const g = (k: string) => Number(parts.find((p) => p.type === k)?.value);
  const local = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'));
  return Math.round((local - Math.floor(t / MINUTE) * MINUTE) / MINUTE);
}

function openWithOffset(w: UpdateWindow, t: number, offset: number): boolean {
  const local = new Date(t + offset * MINUTE);
  return isOpenAtClock(w, local.getUTCDay(), local.getUTCHours() * 60 + local.getUTCMinutes());
}

/**
 * The first whole minute at or after `from` (ms, minute-aligned) whose
 * open/closed state differs from `current`, or null within the horizon.
 */
function nextChange(w: UpdateWindow, from: number, current: boolean, horizonMs: number): number | null {
  const end = from + horizonMs;
  let t = from;
  let off = utcOffsetMinutes(t, w.timeZone);
  while (t < end) {
    const blockEnd = t + SAMPLE_MINUTES * MINUTE;
    const offEnd = utcOffsetMinutes(blockEnd, w.timeZone);
    const uniform = offEnd === off;
    for (let m = t; m < blockEnd && m < end; m += MINUTE) {
      const open = uniform ? openWithOffset(w, m, off) : isWithinSchedule(w, new Date(m));
      if (open !== current) return m;
    }
    t = blockEnd;
    off = offEnd;
  }
  return null;
}

export interface WindowState {
  /** Inside the window at `now`. */
  open: boolean;
  /** When the current window closes (open), or when the next one closes (closed). Null if it never does within the horizon. */
  closesAt: Date | null;
  /** When the next window opens — after the current one closes, if open now. Null if never within the horizon. */
  opensAt: Date | null;
}

/** Open now, and the next transitions, looking `HORIZON_DAYS` ahead. A null window is never open. */
export function windowState(w: UpdateWindow | null, now: Date = new Date()): WindowState {
  if (!w) return { open: false, closesAt: null, opensAt: null };
  const horizon = HORIZON_DAYS * 86_400_000;
  const open = isWithinSchedule(w, now);
  const start = Math.floor(now.getTime() / MINUTE) * MINUTE + MINUTE;
  const first = nextChange(w, start, open, horizon);
  if (first === null) return { open, closesAt: null, opensAt: null };
  const second = nextChange(w, first + MINUTE, !open, horizon);
  return open
    ? { open, closesAt: new Date(first), opensAt: second === null ? null : new Date(second) }
    : { open, opensAt: new Date(first), closesAt: second === null ? null : new Date(second) };
}

export function describeWindow(w: UpdateWindow | null): string | null {
  return describeSchedule(w);
}
