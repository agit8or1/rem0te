import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { validTimezone, zonedToUtc } from '../actions/patch-policy';

/**
 * 0.52: a scheduled install (and, from 0.54, a scheduled restart). A wall-clock time in a named zone; the portal
 * turns it into the plan's signed notBefore (and notAfter = notBefore + the
 * window). The heartbeat hands nothing out before notBefore, and the agent
 * refuses a plan whose window has not opened by its own clock
 * (not_yet_valid, not consumed), so the schedule holds on both sides.
 */
export const MAX_SCHEDULE_DAYS = 14;
export const Schedule = z.object({
  local: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'local is YYYY-MM-DDTHH:MM'),
  timeZone: z.string().min(1).max(64),
}).strict();
export type Schedule = z.infer<typeof Schedule>;

/** The instant a schedule names, checked: a known zone, not in the past (5 minutes' grace), at most MAX_SCHEDULE_DAYS ahead. */
export function scheduledStart(s: Schedule, now = new Date(), what = 'An install'): Date {
  if (!validTimezone(s.timeZone)) throw new BadRequestException({ code: 'INVALID_TIMEZONE', message: `${s.timeZone} is not a time zone this server knows (an IANA name, e.g. Europe/London).` });
  const [d, t] = s.local.split('T');
  const [y, m, day] = d.split('-').map(Number), [hh, mm] = t.split(':').map(Number);
  if (m < 1 || m > 12 || day < 1 || new Date(Date.UTC(y, m - 1, day)).getUTCDate() !== day || hh > 23 || mm > 59) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'That date or time does not exist.' });
  const at = zonedToUtc(y, m, day, hh, mm, s.timeZone);
  if (Number.isNaN(at.getTime())) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'That date or time does not exist.' });
  if (at.getTime() < now.getTime() - 5 * 60_000) throw new BadRequestException({ code: 'SCHEDULE_IN_PAST', message: `${s.local} in ${s.timeZone} has already passed.` });
  if (at.getTime() > now.getTime() + MAX_SCHEDULE_DAYS * 86_400_000) throw new BadRequestException({ code: 'SCHEDULE_TOO_FAR', message: `${what} can be scheduled at most ${MAX_SCHEDULE_DAYS} days ahead. For a regular schedule, use a patch policy's ${what === 'An install' ? 'maintenance' : 'restart'} window.` });
  return new Date(Math.max(at.getTime(), now.getTime()));
}

