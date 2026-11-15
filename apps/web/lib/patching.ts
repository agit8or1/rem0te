/** Badge variants for a patch deployment's status (v0.27). */
export const DEPLOYMENT_STATUS: Record<string, 'success' | 'warning' | 'outline' | 'secondary'> = {
  ACTIVE: 'secondary', PAUSED: 'warning', COMPLETED: 'success', CANCELED: 'outline',
};

/** Badge variants for a patch policy's status (0.32). */
export const POLICY_STATUS: Record<string, 'success' | 'warning' | 'outline' | 'secondary' | 'destructive'> = {
  AWAITING_APPROVAL: 'warning', ACTIVE: 'success', REJECTED: 'destructive', REVOKED: 'outline', EXPIRED: 'outline',
};

/** The classes a plan may install, as Windows Update names them (apps/api/src/patching/posture.ts). */
export const CLASS_NAMES: Record<string, string> = {
  '0fa1201d-4330-4fa8-8ae9-b877473b6441': 'Security Updates',
  'e6cf1350-c01b-414d-a61f-263d14d133b4': 'Critical Updates',
  '28bc880e-0592-4cbf-8f95-c79b17911d5f': 'Update Rollups',
  'cd5ffd1e-e932-4e3a-bf74-18bf0b1bbd83': 'Updates',
  // 0.42. Never ticked by default: a policy installs drivers only if someone chose to.
  'ebfc1fc5-71a4-4f7b-9aca-3b9a503104a0': 'Drivers',
  'e0789628-ce08-4437-be74-2495b842f43b': 'Definition Updates',
};
/** Classes a new policy starts with (Security Updates only); drivers are never pre-selected. */
export const DEFAULT_POLICY_CLASSES = ['0fa1201d-4330-4fa8-8ae9-b877473b6441'];
export const DRIVERS_CLASS = 'ebfc1fc5-71a4-4f7b-9aca-3b9a503104a0';

export const SEVERITIES = ['Critical', 'Important', 'Moderate', 'Low', 'Unrated'] as const;

export const WEEKDAYS = [
  { id: 'mon', label: 'Mon' }, { id: 'tue', label: 'Tue' }, { id: 'wed', label: 'Wed' }, { id: 'thu', label: 'Thu' },
  { id: 'fri', label: 'Fri' }, { id: 'sat', label: 'Sat' }, { id: 'sun', label: 'Sun' },
] as const;

/**
 * A patch policy's maintenance window, as the policy document carries it
 * (apps/api/src/actions/patch-policy.ts, PolicyWindow). Weekly has no `kind`
 * — its shape has not changed since 0.32. Monthly (0.53) is the nth or last
 * weekday of each month plus an offset, or one day of the month, 1–28.
 */
export type WeeklyWindowInput = { days: string[]; start: string; end: string; timezone: string };
export type MonthlyWeekdayWindowInput = { kind: 'monthly'; week: MonthWeek; weekday: string; offsetDays: number; start: string; end: string; timezone: string };
export type MonthlyDayWindowInput = { kind: 'monthly'; day: number; start: string; end: string; timezone: string };
export type PolicyWindowInput = WeeklyWindowInput | MonthlyWeekdayWindowInput | MonthlyDayWindowInput;

export const MONTH_WEEKS = [
  { id: 'first', label: 'first' }, { id: 'second', label: 'second' }, { id: 'third', label: 'third' },
  { id: 'fourth', label: 'fourth' }, { id: 'last', label: 'last' },
] as const;
export type MonthWeek = (typeof MONTH_WEEKS)[number]['id'];
/** The same bounds as the policy document: an offset of 0–14 days, a day of the month 1–28. */
export const MAX_MONTHLY_OFFSET_DAYS = 14;
export const MAX_MONTH_DAY = 28;

const WEEKDAY_LONG: Record<string, string> = { sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday' };
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

/** "Sat 22:00–04:00 (next day) America/Chicago", or (0.53) "2 days after the second Tuesday of each month, 22:00–04:00 (next day) America/Chicago". */
export function describeWindow(w: PolicyWindowInput) {
  const times = `${w.start}–${w.end}${w.end <= w.start ? ' (next day)' : ''} ${w.timezone}`;
  if ('days' in w && !('kind' in w)) {
    const days = w.days.length === 7 ? 'every day' : WEEKDAYS.filter((d) => w.days.includes(d.id)).map((d) => d.label).join(', ');
    return `${days} ${times}`;
  }
  if ('kind' in w && w.kind === 'monthly') {
    if ('day' in w) return `the ${ordinal(w.day)} of each month, ${times}`;
    const m = w as MonthlyWeekdayWindowInput;
    const base = `the ${m.week} ${WEEKDAY_LONG[m.weekday] ?? m.weekday} of each month`;
    return `${m.offsetDays ? `${m.offsetDays} day${m.offsetDays === 1 ? '' : 's'} after ${base}` : base}, ${times}`;
  }
  return `an unrecognised window ${times}`;
}
