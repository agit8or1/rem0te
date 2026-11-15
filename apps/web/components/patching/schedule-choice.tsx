'use client';

/**
 * Install now, or at a time (0.52). The time is a wall-clock date and time in
 * a named zone, and the page says which zone: the computer's site's, the
 * viewer's profile zone, or this browser's. The API turns it into the signed
 * plan's `notBefore` (apps/api/src/patching/patching.service.ts,
 * scheduledStart): nothing is handed to a computer before it, and the agent
 * refuses a plan whose notBefore has not arrived. Until it starts it can be
 * canceled, because it has reached no computer.
 */
import { useEffect, useMemo } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { browserTimeZone, describeOccurrence, localAt, localIn } from '@/lib/tasks';

export type ScheduleValue = { mode: 'now' | 'schedule'; local: string; timeZone: string };
export type Zones = { site?: string | null; viewer?: string | null };

export function zoneOptions(z: Zones): { tz: string; label: string }[] {
  const out: { tz: string; label: string }[] = [];
  const add = (tz: string | null | undefined, label: string) => { if (tz && !out.some((o) => o.tz === tz)) out.push({ tz, label: `${tz} (${label})` }); };
  add(z.site, 'the computer’s site');
  add(z.viewer, 'your profile');
  add(browserTimeZone(), 'this browser');
  add('UTC', 'UTC');
  return out;
}

export function defaultSchedule(z: Zones): ScheduleValue {
  const tz = zoneOptions(z)[0]!.tz;
  return { mode: 'now', local: localIn(tz, 60), timeZone: tz };
}

/** 0.53: the next opening of the computer's patch policy window, offered as a start time. */
export type PolicyOpening = { start: string; end: string; timezone: string };

export function ScheduleChoice({ id, value, onChange, zones, maxDays = 14, nowLabel = 'Install now', policyWindow, onUsePolicyWindow }: {
  id: string; value: ScheduleValue; onChange: (v: ScheduleValue) => void; zones: Zones; maxDays?: number; nowLabel?: string;
  policyWindow?: PolicyOpening | null; onUsePolicyWindow?: (hours: number) => void;
}) {
  const opts = useMemo(() => zoneOptions(zones), [zones]);
  // 0.53: start at the policy window's next opening, as a wall-clock time in the zone chosen here (the same instant).
  const opening = policyWindow ? { at: Date.parse(policyWindow.start), hours: (Date.parse(policyWindow.end) - Date.parse(policyWindow.start)) / 3_600_000 } : null;
  const openingWhy = !opening ? null : opening.at <= Date.now() + 60_000 ? 'it is open now — install now instead'
    : opening.at > Date.now() + maxDays * 86_400_000 ? `it is more than ${maxDays} days ahead` : null;
  // Keep the chosen zone one of the offered ones if the zones arrive later.
  useEffect(() => {
    if (!opts.some((o) => o.tz === value.timeZone)) onChange({ ...value, timeZone: opts[0]!.tz, local: localIn(opts[0]!.tz, 60) });
  }, [opts, value, onChange]);
  return (
    <fieldset className="space-y-2" data-testid="schedule-choice">
      <legend className="text-xs font-medium">When</legend>
      <div className="flex flex-wrap gap-4 text-xs">
        <label className="flex items-center gap-1.5">
          <input type="radio" name={`${id}-when`} checked={value.mode === 'now'} onChange={() => onChange({ ...value, mode: 'now' })} data-testid="schedule-now" />
          {nowLabel}
        </label>
        <label className="flex items-center gap-1.5">
          <input type="radio" name={`${id}-when`} checked={value.mode === 'schedule'} onChange={() => onChange({ ...value, mode: 'schedule' })} data-testid="schedule-later" />
          Schedule
        </label>
      </div>
      {policyWindow && opening && (
        <p className="text-xs" data-testid="schedule-policy-window">
          <button type="button" className="underline disabled:no-underline disabled:text-muted-foreground" disabled={!!openingWhy} data-testid="schedule-use-policy-window"
            onClick={() => { onChange({ ...value, mode: 'schedule', local: localAt(value.timeZone, new Date(opening.at)) }); onUsePolicyWindow?.(Math.max(1, Math.min(24, Math.floor(opening.hours)))); }}>
            Start at the next opening of this computer&apos;s patch policy window
          </button>{' '}
          <span className="text-muted-foreground">({describeOccurrence(policyWindow, policyWindow.timezone)}{openingWhy ? `; ${openingWhy}` : ''})</span>
        </p>
      )}
      {value.mode === 'schedule' && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={`${id}-at`} className="text-xs">Date and time</Label>
            <Input id={`${id}-at`} type="datetime-local" value={value.local} data-testid="schedule-at"
              onChange={(e) => onChange({ ...value, local: e.target.value.slice(0, 16) })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-tz`} className="text-xs">Time zone</Label>
            <select id={`${id}-tz`} value={value.timeZone} data-testid="schedule-tz"
              onChange={(e) => onChange({ ...value, timeZone: e.target.value })}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm">
              {opts.map((o) => <option key={o.tz} value={o.tz}>{o.label}</option>)}
            </select>
          </div>
          <p className="text-xs text-muted-foreground sm:col-span-2">
            {value.local.replace('T', ' ')} in <strong>{value.timeZone}</strong>. Nothing is handed to the computer before then; it starts at the
            computer’s first check-in after it (about every 3 minutes) and runs within the window. Up to {maxDays} days ahead. Until it starts you can
            cancel it. Scheduling has been tested against a simulated agent, not yet on a real Windows computer.
          </p>
        </div>
      )}
    </fieldset>
  );
}

export const scheduleBody = (v: ScheduleValue) => (v.mode === 'schedule' ? { schedule: { local: v.local, timeZone: v.timeZone } } : {});
