/**
 * When a scheduled report is due (0.34). Pure: unit-tested in
 * scripts/unit-email.mjs.
 *
 *   weekly   { dayOfWeek: 0 (Sunday) … 6, time: 'HH:MM', timeZone }
 *   monthly  { dayOfMonth: 1 … 28,         time: 'HH:MM', timeZone }
 *
 * Days of the month stop at 28 so that every month has the day: "the 31st"
 * would have to mean something else in February, and any rule for that is a
 * rule someone has to remember.
 *
 * Time zones and daylight saving use the update-window maths (0.32,
 * client-updates/update-window.ts): wall clocks are read with Intl through
 * `utcOffsetMinutes`, never computed with local-time arithmetic, and the
 * answers match the update window's by construction —
 *
 *   spring forward  a time that does not exist that night (02:30 when the
 *                   clock jumps 02:00 → 03:00) is due at the jump, 03:00 —
 *                   when a 02:30–… update window would open;
 *   fall back       a time that happens twice (01:30) is due the FIRST time,
 *                   which is when a 01:30–… window opens; it is not due again
 *                   an hour later, because the period key is the local date.
 *
 * The period key is what ReportDelivery is unique on: the occurrence's local
 * date for weekly (W:2026-11-09), its local month for monthly (M:2026-11).
 * A schedule can be due at most once per key, so one delivery per period
 * holds even if the clock, the zone's rules or the API process misbehave.
 */
import { isValidTimeZone } from '../rbac/schedule';
import { utcOffsetMinutes } from '../client-updates/update-window';

export const FREQUENCIES = ['weekly', 'monthly'] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export interface ReportScheduleSpec {
  frequency: Frequency;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  time: string;
  timeZone: string;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MIN = 60_000;
const DAY = 86_400_000;

/** Validate untrusted input, or throw an Error whose message is fit for a 400. */
export function parseScheduleSpec(raw: unknown): ReportScheduleSpec {
  if (!raw || typeof raw !== 'object') throw new Error('A schedule is required');
  const r = raw as Record<string, unknown>;
  if (r.frequency !== 'weekly' && r.frequency !== 'monthly') throw new Error('frequency must be weekly or monthly');
  if (typeof r.time !== 'string' || !HHMM.test(r.time)) throw new Error('time must be HH:MM (24-hour)');
  if (!isValidTimeZone(r.timeZone)) throw new Error('timeZone must be a valid IANA time zone, e.g. "Europe/London"');
  if (r.frequency === 'weekly') {
    if (!Number.isInteger(r.dayOfWeek) || (r.dayOfWeek as number) < 0 || (r.dayOfWeek as number) > 6) throw new Error('dayOfWeek must be 0 (Sunday) to 6 (Saturday)');
    if (r.dayOfMonth !== undefined && r.dayOfMonth !== null) throw new Error('A weekly schedule has no dayOfMonth');
    return { frequency: 'weekly', dayOfWeek: r.dayOfWeek as number, dayOfMonth: null, time: r.time, timeZone: r.timeZone };
  }
  if (!Number.isInteger(r.dayOfMonth) || (r.dayOfMonth as number) < 1 || (r.dayOfMonth as number) > 28) throw new Error('dayOfMonth must be 1 to 28 (every month has those days)');
  if (r.dayOfWeek !== undefined && r.dayOfWeek !== null) throw new Error('A monthly schedule has no dayOfWeek');
  return { frequency: 'monthly', dayOfWeek: null, dayOfMonth: r.dayOfMonth as number, time: r.time, timeZone: r.timeZone };
}

const toMinutes = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const floorMin = (t: number) => Math.floor(t / MIN) * MIN;

/** The local calendar date (as a UTC-midnight timestamp) of instant `t` in `timeZone`. */
function localDate(t: number, timeZone: string): number {
  const local = floorMin(t) + utcOffsetMinutes(t, timeZone) * MIN;
  return Math.floor(local / DAY) * DAY;
}

/**
 * The instant the wall clock in `timeZone` reads `minutes` past midnight on
 * the local date `date` (a UTC-midnight timestamp). In a fall-back overlap,
 * the earlier of the two; in a spring-forward gap, the moment of the jump.
 */
export function localToInstant(date: number, minutes: number, timeZone: string): number {
  const naive = date + minutes * MIN; // the wall clock, read as if it were UTC
  const offs = [...new Set([-DAY, -6 * 3_600_000, 0, 6 * 3_600_000, DAY].map((d) => utcOffsetMinutes(naive + d, timeZone)))];
  const valid = offs.map((o) => naive - o * MIN).filter((t) => utcOffsetMinutes(t, timeZone) * MIN === naive - t);
  if (valid.length) return Math.min(...valid);
  // A gap: the wall clock skips `minutes`. Walk the gap for the first minute
  // whose wall clock is past it — the transition itself.
  const lo = naive - Math.max(...offs) * MIN, hi = naive - Math.min(...offs) * MIN;
  for (let t = lo; t <= hi; t += MIN) if (t + utcOffsetMinutes(t, timeZone) * MIN >= naive) return t;
  return hi;
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: number) => { const x = new Date(d); return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`; };

export interface Occurrence { at: Date; periodKey: string }

function occurrenceOn(spec: ReportScheduleSpec, date: number): Occurrence {
  const at = new Date(localToInstant(date, toMinutes(spec.time), spec.timeZone));
  return { at, periodKey: spec.frequency === 'weekly' ? `W:${ymd(date)}` : `M:${ymd(date).slice(0, 7)}` };
}

/** Candidate local dates around `t`, newest first (weekly: 9 days back; monthly: 3 months back). */
function candidates(spec: ReportScheduleSpec, t: number, dir: -1 | 1): number[] {
  const today = localDate(t, spec.timeZone);
  const out: number[] = [];
  if (spec.frequency === 'weekly') {
    for (let k = -1; k <= 9; k++) {
      const d = today + dir * k * DAY;
      if (new Date(d).getUTCDay() === spec.dayOfWeek) out.push(d);
    }
  } else {
    const x = new Date(today);
    for (let k = -1; k <= 3; k++) out.push(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + dir * k, spec.dayOfMonth!));
  }
  return out;
}

/** The most recent occurrence at or before `now`. */
export function previousOccurrence(spec: ReportScheduleSpec, now: Date): Occurrence {
  const t = now.getTime();
  const all = candidates(spec, t, -1).map((d) => occurrenceOn(spec, d)).filter((o) => o.at.getTime() <= t);
  return all.reduce((a, b) => (b.at > a.at ? b : a));
}

/** The first occurrence strictly after `after`. */
export function nextOccurrence(spec: ReportScheduleSpec, after: Date): Occurrence {
  const t = after.getTime();
  const all = candidates(spec, t, 1).map((d) => occurrenceOn(spec, d)).filter((o) => o.at.getTime() > t);
  return all.reduce((a, b) => (b.at < a.at ? b : a));
}

/** The period a scheduled report covers: a week's schedule reports on 7 days, a month's on 30 (both are report periods). */
export function periodDaysFor(f: Frequency): 7 | 30 { return f === 'weekly' ? 7 : 30; }

/**
 * How late a delivery may still go out. A process that was down when a
 * report fell due sends it when it comes back within this; after it, the
 * period is recorded as missed rather than sent days late as if on time.
 */
export const CATCH_UP_MS = 24 * 3_600_000;

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export function describeSpec(s: ReportScheduleSpec): string {
  const ord = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;
  return s.frequency === 'weekly' ? `Every ${DAYS[s.dayOfWeek!]} at ${s.time} (${s.timeZone})` : `On the ${ord(s.dayOfMonth!)} of every month at ${s.time} (${s.timeZone})`;
}
