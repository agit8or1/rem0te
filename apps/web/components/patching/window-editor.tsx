'use client';

/**
 * The maintenance window of a patch policy (0.32 weekly; 0.53 monthly), used
 * by the policy editor and the company-wide policy editor.
 *
 * Monthly is the nth or last weekday of each month, optionally some days
 * after it ("2 days after the second Tuesday" — Patch Tuesday plus two), or
 * one day of the month, 1–28. The next three openings are not worked out
 * here: they come from POST /patching/window-preview, which runs the same
 * occurrence functions the approval signer holds every ring plan to, so what
 * this shows is what the signer will sign inside.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { patchingApi } from '@/lib/api-client';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { describeOccurrence } from '@/lib/tasks';
import { MAX_MONTHLY_OFFSET_DAYS, MAX_MONTH_DAY, MONTH_WEEKS, WEEKDAYS, type MonthWeek, type PolicyWindowInput } from '@/lib/patching';

export type WindowDraft = {
  kind: 'weekly' | 'monthly';
  days: Set<string>;
  monthly: 'weekday' | 'day';
  week: MonthWeek; weekday: string; offsetDays: number; day: number;
  start: string; end: string; timezone: string;
};

export function defaultWindowDraft(): WindowDraft {
  let timezone = 'UTC';
  try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { /* keep UTC */ }
  return { kind: 'weekly', days: new Set(['sat']), monthly: 'weekday', week: 'second', weekday: 'tue', offsetDays: 0, day: 15, start: '22:00', end: '04:00', timezone };
}

/** The window as the policy document carries it: exactly one of the three shapes. */
export function windowFromDraft(d: WindowDraft): PolicyWindowInput {
  const t = { start: d.start, end: d.end, timezone: d.timezone.trim() };
  if (d.kind === 'weekly') return { days: WEEKDAYS.filter((x) => d.days.has(x.id)).map((x) => x.id), ...t };
  if (d.monthly === 'day') return { kind: 'monthly', day: d.day, ...t };
  return { kind: 'monthly', week: d.week, weekday: d.weekday, offsetDays: d.offsetDays, ...t };
}

/** Enough to propose; the API (and then the signer) checks the rest. */
export function draftReady(d: WindowDraft): boolean {
  if (d.start === d.end || !d.timezone.trim()) return false;
  if (d.kind === 'weekly') return d.days.size > 0;
  if (d.monthly === 'day') return Number.isInteger(d.day) && d.day >= 1 && d.day <= MAX_MONTH_DAY;
  return Number.isInteger(d.offsetDays) && d.offsetDays >= 0 && d.offsetDays <= MAX_MONTHLY_OFFSET_DAYS;
}

const selectClass = 'h-8 rounded-md border border-input bg-background px-2 text-xs';

export function WindowEditor({ id, value, onChange, expiresInDays: exp, title = 'Maintenance window' }: { id: string; value: WindowDraft; onChange: (d: WindowDraft) => void; expiresInDays?: number; title?: string }) {
  const expiresInDays = exp !== undefined && Number.isInteger(exp) && exp >= 1 && exp <= 90 ? exp : undefined;
  const set = (p: Partial<WindowDraft>) => onChange({ ...value, ...p });
  const toggle = (day: string, on: boolean) => { const n = new Set(value.days); if (on) n.add(day); else n.delete(day); set({ days: n }); };
  const ready = draftReady(value);
  const w = windowFromDraft(value);
  // Typing a time zone should not ask the API on every key.
  const wJson = JSON.stringify(w);
  const [key, setKey] = useState(wJson);
  useEffect(() => { const t = setTimeout(() => setKey(wJson), 300); return () => clearTimeout(t); }, [wJson]);
  const preview = useQuery({
    queryKey: ['window-preview', key, expiresInDays ?? null],
    queryFn: () => patchingApi.windowPreview(JSON.parse(key), expiresInDays).then((r) => r.data.data as {
      valid: boolean; message?: string; description?: string; occurrences: { start: string; end: string }[]; opensBeforeExpiry: boolean | null;
    }),
    enabled: ready,
    staleTime: 60_000,
  });
  const p = preview.data;

  return (
    <div className="space-y-2" data-testid={`${id}-window`}>
      <p className="text-xs font-medium">{title}</p>
      <div className="flex flex-wrap gap-4 text-xs">
        <label className="flex items-center gap-1.5"><input type="radio" name={`${id}-kind`} checked={value.kind === 'weekly'} onChange={() => set({ kind: 'weekly' })} data-testid={`${id}-weekly`} />Weekly</label>
        <label className="flex items-center gap-1.5"><input type="radio" name={`${id}-kind`} checked={value.kind === 'monthly'} onChange={() => set({ kind: 'monthly' })} data-testid={`${id}-monthly`} />Monthly</label>
      </div>

      {value.kind === 'weekly' ? (
        <div className="flex flex-wrap gap-3 text-xs">
          {WEEKDAYS.map((d) => <label key={d.id} className="flex items-center gap-1"><input type="checkbox" checked={value.days.has(d.id)} onChange={(e) => toggle(d.id, e.target.checked)} />{d.label}</label>)}
        </div>
      ) : (
        <div className="space-y-2 text-xs">
          <label className="flex flex-wrap items-center gap-2">
            <input type="radio" name={`${id}-monthly`} checked={value.monthly === 'weekday'} onChange={() => set({ monthly: 'weekday' })} data-testid={`${id}-monthly-weekday`} />
            On the
            <select aria-label="Week of the month" className={selectClass} value={value.week} onChange={(e) => set({ monthly: 'weekday', week: e.target.value as MonthWeek })} data-testid={`${id}-week`}>
              {MONTH_WEEKS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
            <select aria-label="Weekday" className={selectClass} value={value.weekday} onChange={(e) => set({ monthly: 'weekday', weekday: e.target.value })} data-testid={`${id}-weekday`}>
              {WEEKDAYS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
            of each month, plus
            <Input aria-label="Days after" type="number" min={0} max={MAX_MONTHLY_OFFSET_DAYS} className="h-8 w-16 text-xs" value={value.offsetDays}
              onChange={(e) => set({ monthly: 'weekday', offsetDays: Math.min(MAX_MONTHLY_OFFSET_DAYS, Math.max(0, Math.trunc(Number(e.target.value) || 0))) })} data-testid={`${id}-offset`} />
            day(s)
          </label>
          <p className="text-muted-foreground pl-5">Patch Tuesday is the second Tuesday. Plus 0–{MAX_MONTHLY_OFFSET_DAYS} days moves the window after it — &quot;second Tuesday plus 2&quot; is the Thursday after; it may fall in the next month.</p>
          <label className="flex flex-wrap items-center gap-2">
            <input type="radio" name={`${id}-monthly`} checked={value.monthly === 'day'} onChange={() => set({ monthly: 'day' })} data-testid={`${id}-monthly-day`} />
            On day
            <Input aria-label="Day of the month" type="number" min={1} max={MAX_MONTH_DAY} className="h-8 w-16 text-xs" value={value.day}
              onChange={(e) => set({ monthly: 'day', day: Math.min(MAX_MONTH_DAY, Math.max(1, Math.trunc(Number(e.target.value) || 1))) })} data-testid={`${id}-day`} />
            of each month <span className="text-muted-foreground">(1–{MAX_MONTH_DAY}, so it opens in every month, February included)</span>
          </label>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-2xl">
        <div className="space-y-1"><Label className="text-xs" htmlFor={`${id}-start`}>Starts (local)</Label><Input id={`${id}-start`} type="time" value={value.start} onChange={(e) => set({ start: e.target.value })} /></div>
        <div className="space-y-1"><Label className="text-xs" htmlFor={`${id}-end`}>Ends (local; earlier = next day)</Label><Input id={`${id}-end`} type="time" value={value.end} onChange={(e) => set({ end: e.target.value })} /></div>
        <div className="space-y-1"><Label className="text-xs" htmlFor={`${id}-tz`}>Time zone (IANA)</Label><Input id={`${id}-tz`} value={value.timezone} onChange={(e) => set({ timezone: e.target.value })} /></div>
      </div>

      <div className="text-xs" data-testid={`${id}-preview`}>
        {!ready ? <p className="text-muted-foreground">{value.start === value.end ? 'The window must not be empty.' : 'Choose when it opens.'}</p>
          : preview.isLoading ? <p className="text-muted-foreground">Working out the next openings…</p>
          : !p ? null
          : !p.valid ? <p className="text-destructive">{p.message}</p>
          : (
            <>
              <p><span className="text-muted-foreground">Opens</span> {p.description}.</p>
              {p.occurrences.length === 0
                ? <p className="text-destructive" data-testid={`${id}-never-opens`}>It does not open before the policy expires{expiresInDays ? ` (${expiresInDays} days)` : ''}. Lengthen the expiry or choose a window that opens sooner; the signer refuses a policy whose window never opens (window_never_opens).</p>
                : <p><span className="text-muted-foreground">Next {p.occurrences.length === 1 ? 'opening' : `${p.occurrences.length} openings`}{expiresInDays ? ' before it expires' : ''}:</span>{' '}
                    {p.occurrences.map((o, i) => <span key={o.start} data-testid={`${id}-occurrence`}>{i ? '; ' : ''}<strong>{describeOccurrence(o, value.timezone.trim())}</strong></span>)}
                  </p>}
            </>
          )}
      </div>
    </div>
  );
}
