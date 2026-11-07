/**
 * Weekly access / maintenance windows in an explicit IANA time zone.
 *
 *   { timeZone: 'America/New_York',
 *     windows: [{ days: [1,2,3,4,5], start: '08:00', end: '18:00' }] }
 *
 * `days` uses 0 = Sunday … 6 = Saturday, evaluated in `timeZone`. `start` and
 * `end` are local wall-clock times. A window whose end is earlier than its
 * start crosses midnight and belongs to the day it starts on (22:00–02:00 on
 * Friday covers Friday 22:00 to Saturday 02:00).
 *
 * Daylight saving is handled by never doing arithmetic on local times: the
 * instant being checked is converted into the zone's wall clock with
 * Intl.DateTimeFormat (which reads the platform tz database) and compared as
 * minutes-since-midnight. So on a spring-forward day a 02:00–03:00 window
 * simply never matches (that wall-clock hour does not exist), and on a
 * fall-back day 01:00–02:00 matches both real hours that read 01:xx. Both are
 * the behaviour someone writing "01:00–02:00 local" expects.
 *
 * Everything here is pure, so it is unit-tested without a database
 * (scripts/unit-schedule-and-session-state.mjs).
 */

export interface ScheduleWindow {
  days: number[];
  start: string;
  end: string;
}

export interface AccessSchedule {
  timeZone: string;
  windows: ScheduleWindow[];
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate and normalise untrusted input into a schedule, or throw with a
 * message fit for a 400. `null`/`undefined` mean "no schedule" and pass through.
 */
export function parseSchedule(input: unknown): AccessSchedule | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'object') throw new Error('Schedule must be an object');
  const raw = input as { timeZone?: unknown; windows?: unknown };
  if (!isValidTimeZone(raw.timeZone)) {
    throw new Error('Schedule needs a valid IANA time zone, e.g. "Europe/London"');
  }
  if (!Array.isArray(raw.windows) || raw.windows.length === 0 || raw.windows.length > 14) {
    throw new Error('Schedule needs between 1 and 14 windows');
  }
  const windows: ScheduleWindow[] = raw.windows.map((w, i) => {
    const win = w as { days?: unknown; start?: unknown; end?: unknown };
    if (!Array.isArray(win.days) || win.days.length === 0 ||
        !win.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
      throw new Error(`Window ${i + 1}: days must be integers 0 (Sunday) to 6 (Saturday)`);
    }
    if (typeof win.start !== 'string' || !HHMM.test(win.start) ||
        typeof win.end !== 'string' || !HHMM.test(win.end)) {
      throw new Error(`Window ${i + 1}: start and end must be HH:MM (24-hour)`);
    }
    if (win.start === win.end) throw new Error(`Window ${i + 1}: start and end are the same`);
    return { days: [...new Set(win.days as number[])].sort(), start: win.start, end: win.end };
  });
  return { timeZone: raw.timeZone, windows };
}

const DAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock weekday and minutes-since-midnight of `at` in `timeZone`. */
export function localClock(at: Date, timeZone: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const hour = parseInt(get('hour'), 10) % 24;
  const minute = parseInt(get('minute'), 10);
  return { day: DAY_INDEX[get('weekday')] ?? 0, minutes: hour * 60 + minute };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((x) => parseInt(x, 10));
  return h * 60 + m;
}

/** Is `at` inside any window of the schedule? A null schedule is always open. */
export function isWithinSchedule(schedule: AccessSchedule | null | undefined, at: Date = new Date()): boolean {
  if (!schedule) return true;
  const { day, minutes } = localClock(at, schedule.timeZone);
  const yesterday = (day + 6) % 7;
  return schedule.windows.some((w) => {
    const s = toMinutes(w.start);
    const e = toMinutes(w.end);
    if (s < e) return w.days.includes(day) && minutes >= s && minutes < e;
    // Crosses midnight: the evening part on the listed day, the early part on
    // the day after it.
    return (w.days.includes(day) && minutes >= s) || (w.days.includes(yesterday) && minutes < e);
  });
}

/** Safe read of a schedule column; a malformed stored value fails CLOSED. */
export function storedScheduleAllows(stored: unknown, at: Date = new Date()): boolean {
  if (stored === null || stored === undefined) return true;
  try {
    return isWithinSchedule(parseSchedule(stored), at);
  } catch {
    return false;
  }
}

/** Is a [startsAt, expiresAt) window open at `at`? Either bound may be null. */
export function isWithinDates(
  startsAt: Date | null | undefined,
  expiresAt: Date | null | undefined,
  at: Date = new Date(),
): boolean {
  if (startsAt && at < startsAt) return false;
  if (expiresAt && at >= expiresAt) return false;
  return true;
}

/** Human description, e.g. "Mon–Fri 08:00–18:00 (America/New_York)". */
export function describeSchedule(schedule: AccessSchedule | null | undefined): string | null {
  if (!schedule) return null;
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const parts = schedule.windows.map((w) => `${w.days.map((d) => names[d]).join(',')} ${w.start}–${w.end}`);
  return `${parts.join('; ')} (${schedule.timeZone})`;
}
