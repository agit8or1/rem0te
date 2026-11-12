'use client';

/**
 * Shared pieces of the Reports pages (0.32): the filter bar (business for a
 * Platform Admin or anyone in several, site, period), the audited CSV export
 * button, figures, definitions and empty states.
 *
 * Every number on these pages comes from GET /reports/<report>, which scopes
 * it server side; nothing here computes, fills in or simulates a value. A
 * figure the server returns as null is drawn as "No data", never as zero.
 */
import * as React from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Download, Info, Loader2 } from 'lucide-react';
import { api } from '@/lib/api-client';
import { usePermissions } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { refusalMessage } from '@/components/endpoints/list/api';
import { cn } from '@/lib/utils';

export type Ref = { id: string; name: string };
export interface Facets { businesses: Ref[]; sites: (Ref & { businessId: string })[] }
export interface ReportFilters { businessId: string; siteId: string; days: string; silentDays: string }
export const EMPTY_FILTERS: ReportFilters = { businessId: '', siteId: '', days: '30', silentDays: '7' };

export const PERIODS: [string, string][] = [['1', 'Last 24 hours'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['365', 'Last 365 days']];
export const SILENT: [string, string][] = [['1', '1 day'], ['3', '3 days'], ['7', '7 days'], ['14', '14 days'], ['30', '30 days'], ['90', '90 days']];

/** The filters, kept in the address bar so a report can be bookmarked or shared (the server scopes it for whoever opens it). */
export function useReportFilters(keys: (keyof ReportFilters)[]) {
  const [filters, setFilters] = React.useState<ReportFilters>(EMPTY_FILTERS);
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search);
      setFilters((f) => ({ ...f, ...Object.fromEntries(keys.filter((k) => q.get(k)).map((k) => [k, q.get(k)!])) }));
    } catch { /* no URL state */ }
    setReady(true);
    // Read once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  React.useEffect(() => {
    if (!ready) return;
    const p = new URLSearchParams();
    for (const k of keys) if (filters[k] && filters[k] !== EMPTY_FILTERS[k]) p.set(k, filters[k]);
    const s = p.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${s ? `?${s}` : ''}`);
  }, [filters, keys, ready]);
  const params = React.useMemo(() => {
    const p: Record<string, string> = {};
    for (const k of keys) if (filters[k]) p[k] = filters[k];
    return p;
  }, [filters, keys]);
  const set = (k: keyof ReportFilters, v: string) => setFilters((f) => ({ ...f, [k]: v, ...(k === 'businessId' ? { siteId: '' } : {}) }));
  return { filters, set, params, ready };
}

export function useReport<T>(report: string, params: Record<string, string>, enabled: boolean) {
  return useQuery({
    queryKey: ['report', report, params],
    queryFn: () => api.get(`/reports/${report}`, { params }).then((r) => r.data?.data as T),
    enabled,
    placeholderData: keepPreviousData,
    retry: (n, e) => (e as { response?: { status?: number } })?.response?.status !== 403 && n < 2,
  });
}

export function apiMessage(e: unknown, fallback: string) {
  const m = (e as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  if (typeof m === 'string') return m;
  if (m && typeof (m as { message?: unknown }).message === 'string') return (m as { message: string }).message;
  return fallback;
}

const selectClass = 'h-9 rounded-md border border-input bg-background px-2 text-sm';

export function FilterBar({ facets, filters, set, period, silent, report, params, disabled }: {
  facets: Facets | undefined;
  filters: ReportFilters;
  set: (k: keyof ReportFilters, v: string) => void;
  period?: boolean;
  silent?: boolean;
  report: string;
  params: Record<string, string>;
  disabled?: boolean;
}) {
  const { isPlatformAdmin } = usePermissions();
  const businesses = facets?.businesses ?? [];
  const sites = (facets?.sites ?? []).filter((s) => !filters.businessId || s.businessId === filters.businessId);
  return (
    <div className="flex flex-wrap items-end gap-3">
      {(isPlatformAdmin || businesses.length > 1) && (
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Business
          <select id="rp-business" className={cn(selectClass, 'w-[200px]')} value={filters.businessId} onChange={(e) => set('businessId', e.target.value)}>
            <option value="">All businesses</option>
            {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
      )}
      {sites.length > 0 && (
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Site
          <select id="rp-site" className={cn(selectClass, 'w-[180px]')} value={filters.siteId} onChange={(e) => set('siteId', e.target.value)}>
            <option value="">All sites</option>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
      )}
      {period && (
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Period
          <select id="rp-days" className={cn(selectClass, 'w-[160px]')} value={filters.days} onChange={(e) => set('days', e.target.value)}>
            {PERIODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      )}
      {silent && (
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Not heard from in
          <select id="rp-silent" className={cn(selectClass, 'w-[120px]')} value={filters.silentDays} onChange={(e) => set('silentDays', e.target.value)}>
            {SILENT.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      )}
      <div className="sm:ml-auto">
        <ExportButton report={report} params={params} disabled={disabled} />
      </div>
    </div>
  );
}

/** Download the report as CSV. The server audits every export before sending it, and refuses one it cannot record. */
export function ExportButton({ report, params, disabled }: { report: string; params: Record<string, string>; disabled?: boolean }) {
  const { toast } = useToast();
  const [busy, setBusy] = React.useState(false);
  async function run() {
    setBusy(true);
    try {
      const r = await api.get(`/reports/${report}/export.csv`, { params, responseType: 'blob' });
      const name = /filename="([^"]+)"/.exec(String(r.headers['content-disposition'] ?? ''))?.[1] ?? `${report}.csv`;
      const rows = Number(r.headers['x-rows'] ?? 0);
      const url = URL.createObjectURL(r.data as Blob);
      const a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast({ title: `Exported ${rows} row${rows === 1 ? '' : 's'}`, description: 'The export is recorded in the audit log.' });
    } catch (e) {
      toast({ title: 'Export refused', description: await refusalMessage(e, 'The export failed.'), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button variant="outline" size="sm" className="h-9" onClick={run} disabled={busy || disabled} title="Download this report as CSV. Recorded in the audit log.">
      {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Download className="h-4 w-4 mr-1.5" />}Export CSV
    </Button>
  );
}

export function Figure({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: 'good' | 'warn' | 'bad' }) {
  return (
    <div className="rounded-lg border bg-card p-4 min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn('mt-1 text-2xl font-semibold tabular-nums',
        tone === 'good' && 'text-green-600 dark:text-green-400', tone === 'warn' && 'text-amber-600 dark:text-amber-400', tone === 'bad' && 'text-red-600 dark:text-red-400')}>
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function Definition({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
      <Info className="h-4 w-4 shrink-0 mt-0.5" />
      <div className="space-y-1">{children}</div>
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">{children}</p>;
}

export function Section({ title, note, children }: { title: string; note?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        {note && <span className="text-xs text-muted-foreground">{note}</span>}
      </div>
      {children}
    </section>
  );
}

/** A plain table that scrolls inside its own box rather than widening the page. */
export function Table({ head, rows, empty }: { head: React.ReactNode[]; rows: React.ReactNode[][]; empty: React.ReactNode }) {
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <div className="rounded-md border bg-background overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            {head.map((h, i) => <th key={i} className={cn('px-3 py-2 font-medium whitespace-nowrap', i === 0 ? 'text-left' : 'text-right')}>{h}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => <td key={j} className={cn('px-3 py-2', j === 0 ? 'text-left' : 'text-right tabular-nums whitespace-nowrap')}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Refused({ error }: { error: unknown }) {
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
      {status === 403 ? 'This report is not available to you: ' : 'The report could not be loaded: '}
      {apiMessage(error, 'try again shortly.')}
    </div>
  );
}

export const pct = (n: number | null | undefined) => (n === null || n === undefined ? 'No data' : `${n}%`);
export const where = (b: Ref | null | undefined, s?: Ref | null) => [b?.name ?? 'No business', s === undefined ? null : s?.name ?? 'No site'].filter(Boolean).join(' · ');

export function duration(min: number | null | undefined): string {
  if (min === null || min === undefined) return '—';
  if (min < 1) return '< 1 min';
  if (min < 90) return `${Math.round(min)} min`;
  const h = min / 60;
  if (h < 48) return `${Math.round(h * 10) / 10} h`;
  return `${Math.round((h / 24) * 10) / 10} d`;
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))} min ago`;
  const h = Math.floor(s / 3600);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

export function Generated({ at }: { at: string | undefined }) {
  return at ? <span>Computed {new Date(at).toLocaleString()} from stored data</span> : null;
}

/**
 * What data retention (0.34) leaves an alert report able to see. Resolved
 * alerts are deleted RETENTION_ALERT_DAYS after they were resolved, so every
 * alert first raised inside that many days is still stored, and a longer
 * period is incomplete. Said on the page, never left for the reader to guess.
 */
export interface RetentionCoverage { alertDays: number; periodDays: number; complete: boolean; coversDays: number }
export function RetentionNote({ r }: { r?: RetentionCoverage }) {
  if (!r) return null;
  return (
    <div className={`flex gap-2 rounded-md border p-3 text-xs ${r.complete ? 'bg-muted/40 text-muted-foreground' : 'border-yellow-500/50 bg-yellow-500/10'}`} data-testid="retention-note">
      <Info className="h-4 w-4 shrink-0 mt-0.5" />
      <p>
        {r.complete
          ? <>Resolved alerts are kept for {r.alertDays} days after they are resolved (data retention), so this report can cover the last {r.alertDays} days and this {r.periodDays}-day period is complete.</>
          : <>Resolved alerts are deleted {r.alertDays} days after they are resolved (data retention). This report can cover only the last {r.coversDays} days: for the rest of this {r.periodDays}-day period, alerts that were resolved are no longer stored and are not counted.</>}
      </p>
    </div>
  );
}
