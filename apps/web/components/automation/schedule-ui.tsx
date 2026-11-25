'use client';

/**
 * Automation schedules (0.58): the pieces the list, editor and detail pages
 * share. Nothing here works out when a schedule runs: the editor asks
 * POST /automation/schedules/preview, which runs the same occurrence
 * functions the approval signer holds every run to.
 */
import { useQuery } from '@tanstack/react-query';
import { automationApi, type AutomationOfflineInput, type AutomationRecurrenceInput } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatDate } from '@/lib/utils';

export const selectClass = 'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm';
export const HOURLY_EVERY = [1, 2, 3, 4, 6, 8, 12] as const;
export const MAX_TARGETS = 25;
export const MAX_RUNS_PER_OCCURRENCE = 3;
export const SKIP_GRACE_MINUTES = 15;

export const STATUS: Record<string, { label: string; variant: 'success' | 'warning' | 'outline' | 'destructive' | 'secondary' }> = {
  AWAITING_APPROVAL: { label: 'Pending approval on the signer', variant: 'warning' },
  ACTIVE: { label: 'Active', variant: 'success' },
  REJECTED: { label: 'Rejected', variant: 'destructive' },
  REVOKED: { label: 'Revoked', variant: 'destructive' },
  EXPIRED: { label: 'Expired', variant: 'outline' },
};

export function StatusBadge({ status, paused }: { status: string; paused?: boolean }) {
  const s = STATUS[status] ?? { label: status.toLowerCase(), variant: 'outline' as const };
  return (
    <span className="inline-flex gap-1" data-testid="schedule-status" data-status={status} data-paused={paused ? '1' : '0'}>
      <Badge variant={s.variant}>{s.label}</Badge>
      {paused && <Badge variant="secondary">Paused</Badge>}
    </span>
  );
}

export type Occurrence = { start: string; end: string };
export const when = (o: Occurrence | null | undefined) => (o ? `${formatDate(o.start)} – ${formatDate(o.end)}` : '—');

export type HourlyDraft = { everyHours: number; minute: number; windowMinutes: number; timezone: string };
export function defaultHourly(): HourlyDraft {
  let timezone = 'UTC';
  try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { /* keep UTC */ }
  return { everyHours: 4, minute: 0, windowMinutes: 60, timezone };
}

/** Every N hours, at a minute past, open for a window no longer than the gap between runs. */
export function HourlyEditor({ value, onChange }: { value: HourlyDraft; onChange: (v: HourlyDraft) => void }) {
  const maxWindow = Math.min(720, value.everyHours * 60);
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="hourly-editor">
      <div className="space-y-1">
        <Label htmlFor="hourly-every" className="text-xs">Every</Label>
        <select id="hourly-every" className={selectClass} value={value.everyHours} data-testid="hourly-every"
          onChange={(e) => { const n = Number(e.target.value); onChange({ ...value, everyHours: n, windowMinutes: Math.min(value.windowMinutes, n * 60) }); }}>
          {HOURLY_EVERY.map((n) => <option key={n} value={n}>{n === 1 ? 'hour' : `${n} hours`}</option>)}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="hourly-minute" className="text-xs">At minute</Label>
        <Input id="hourly-minute" type="number" min={0} max={59} value={value.minute} onChange={(e) => onChange({ ...value, minute: Math.max(0, Math.min(59, Number(e.target.value) || 0)) })} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="hourly-window" className="text-xs">Open for (minutes)</Label>
        <Input id="hourly-window" type="number" min={15} max={maxWindow} value={value.windowMinutes} onChange={(e) => onChange({ ...value, windowMinutes: Number(e.target.value) || 15 })} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="hourly-tz" className="text-xs">Time zone</Label>
        <Input id="hourly-tz" value={value.timezone} onChange={(e) => onChange({ ...value, timezone: e.target.value })} />
      </div>
      <p className="col-span-2 text-xs text-muted-foreground sm:col-span-4">
        Counted from local midnight in that zone. The window is 15 minutes to {maxWindow} minutes: it can never run into the next run.
      </p>
    </div>
  );
}

export function hourlyRecurrence(d: HourlyDraft): AutomationRecurrenceInput {
  return { kind: 'hourly', everyHours: d.everyHours, minute: d.minute, windowMinutes: d.windowMinutes, timezone: d.timezone.trim() };
}

/** The description and next runs, from the server (the signer's functions). */
export function RecurrencePreview({ recurrence }: { recurrence: AutomationRecurrenceInput | null }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['automation-preview', JSON.stringify(recurrence)],
    enabled: !!recurrence,
    queryFn: () => automationApi.preview({ recurrence: recurrence! }).then((r) => r.data.data as { valid: boolean; message?: string; description?: string; occurrences: Occurrence[]; opensBeforeExpiry: boolean | null }),
    retry: false,
  });
  if (!recurrence) return null;
  if (isLoading) return <p className="text-xs text-muted-foreground">Working out the next runs…</p>;
  if (isError || !data) return <p className="text-xs text-destructive">Could not work out the next runs.</p>;
  if (!data.valid) return <p className="text-xs text-destructive" data-testid="schedule-preview-invalid">{data.message}</p>;
  return (
    <div className="text-xs space-y-1" data-testid="schedule-preview">
      <p><strong>{data.description}</strong></p>
      {data.occurrences.length === 0
        ? <p className="text-destructive">It never opens.</p>
        : <ul className="list-disc pl-5 text-muted-foreground">{data.occurrences.map((o) => <li key={o.start}>{when(o)}</li>)}</ul>}
    </div>
  );
}

export function OfflineChoice({ value, onChange }: { value: AutomationOfflineInput; onChange: (v: AutomationOfflineInput) => void }) {
  return (
    <fieldset className="space-y-1.5 text-xs" data-testid="offline-choice">
      <legend className="font-medium">If a device is offline when it is due</legend>
      <label className="flex items-start gap-2">
        <input type="radio" name="offline" className="mt-0.5" checked={value.mode === 'run_when_online'} onChange={() => onChange({ mode: 'run_when_online' })} />
        <span>Run it when it comes online, while the window is still open.</span>
      </label>
      <label className="flex items-start gap-2">
        <input type="radio" name="offline" className="mt-0.5" checked={value.mode === 'skip_if_offline'} onChange={() => onChange({ mode: 'skip_if_offline' })} />
        <span>Skip it: only devices online at the start are named, and the plan expires after {SKIP_GRACE_MINUTES} minutes.</span>
      </label>
      <label className="flex items-start gap-2">
        <input type="radio" name="offline" className="mt-0.5" checked={value.mode === 'expire_after'} onChange={() => onChange({ mode: 'expire_after', hours: 4 })} />
        <span className="flex flex-wrap items-center gap-1">
          Run it when it comes online, for up to
          <Input type="number" min={1} max={24} className="h-7 w-16" disabled={value.mode !== 'expire_after'}
            value={value.mode === 'expire_after' ? value.hours : 4}
            onChange={(e) => onChange({ mode: 'expire_after', hours: Math.max(1, Math.min(24, Number(e.target.value) || 1)) })} />
          hours from the start of the window (even after it closes).
        </span>
      </label>
      <p className="text-muted-foreground">This becomes the expiry signed into each run&apos;s plan: a device that checks in after it is refused by its own agent.</p>
    </fieldset>
  );
}

export function apiMessage(e: unknown, fallback: string): string {
  const d = (e as { response?: { data?: { message?: string | { message?: string }; code?: string } } })?.response?.data;
  const m = typeof d?.message === 'string' ? d.message : d?.message?.message;
  return m || fallback;
}
