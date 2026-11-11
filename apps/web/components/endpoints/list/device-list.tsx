'use client';

import * as React from 'react';
import Link from 'next/link';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  ArrowDown, ArrowUp, ArrowUpDown, Bookmark, Check, ChevronLeft, ChevronRight, Columns3, Download,
  Loader2, MoreHorizontal, Rows3, Search, Trash2, X,
} from 'lucide-react';
import { endpointsApi } from '@/lib/api-client';
import { usePermissions } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { COLUMNS, DEFAULT_COLUMNS, ago, type CellContext } from './columns';
import { deviceListApi, refusalMessage, toParams } from './api';
import { loadPrefs, loadViews, savePrefs, saveViews, type SavedView } from './prefs';
import { EMPTY_FILTERS, type Density, type DeviceFilters, type DeviceRow, type SortKey } from './types';

const PAGE_SIZES = [25, 50, 100, 200];
const ALL = '__all__'; // Radix Select cannot carry an empty value.
const DEFAULT_DIR: Partial<Record<SortKey, 'asc' | 'desc'>> = { online: 'asc', name: 'asc', business: 'asc', site: 'asc', os: 'asc', user: 'asc' };

/** Filters, sort and page in the address bar, so a view can be bookmarked or shared (the server scopes it for whoever opens it). */
function readUrl(): { filters: DeviceFilters; sort: SortKey; dir: 'asc' | 'desc'; page: number } | null {
  try {
    const q = new URLSearchParams(window.location.search);
    if (![...q.keys()].length) return null;
    const pick = <T extends string>(k: string, ok: readonly T[], d: T): T => (ok as readonly string[]).includes(q.get(k) ?? '') ? (q.get(k) as T) : d;
    const sort = pick<SortKey>('sort', ['online', 'name', 'business', 'site', 'os', 'lastSeen', 'agent', 'user', 'cpu', 'memory', 'disk', 'patches', 'alerts', 'health'], 'online');
    return {
      filters: {
        search: q.get('search') ?? '', businessId: q.get('businessId') ?? '', siteId: q.get('siteId') ?? '',
        online: pick('online', ['', 'online', 'offline'] as const, ''),
        alerts: pick('alerts', ['', 'any', 'critical'] as const, ''),
        restartPending: q.get('restartPending') === 'true',
        agent: pick('agent', ['', 'signed', 'standard', 'none'] as const, ''),
        status: pick('status', ['current', 'archived', 'all'] as const, 'current'),
      },
      sort, dir: pick('dir', ['asc', 'desc'] as const, DEFAULT_DIR[sort] ?? 'desc'),
      page: Math.max(1, parseInt(q.get('page') ?? '1', 10) || 1),
    };
  } catch {
    return null;
  }
}

function apiMessage(e: unknown, fallback: string) {
  return (e as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message?.toString() ?? fallback;
}

export function DeviceList() {
  const { toast } = useToast();
  const { can, isPlatformAdmin, technician } = usePermissions();
  const [filters, setFilters] = React.useState<DeviceFilters>(EMPTY_FILTERS);
  const [searchInput, setSearchInput] = React.useState('');
  const [sort, setSort] = React.useState<SortKey>('online');
  const [dir, setDir] = React.useState<'asc' | 'desc'>('asc');
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(50);
  const [columns, setColumns] = React.useState<string[]>(DEFAULT_COLUMNS);
  const [density, setDensity] = React.useState<Density>('comfortable');
  const [views, setViews] = React.useState<SavedView[]>([]);
  const [saveOpen, setSaveOpen] = React.useState(false);
  const [viewName, setViewName] = React.useState('');
  const [exporting, setExporting] = React.useState(false);
  const [now, setNow] = React.useState(() => Date.now());
  const [ready, setReady] = React.useState(false);

  // Per-viewer state from this browser, after mount (localStorage is not there during SSR).
  React.useEffect(() => {
    const p = loadPrefs();
    if (p.columns?.length) setColumns(p.columns.filter((c) => COLUMNS.some((d) => d.id === c)));
    setDensity(p.density);
    setViews(loadViews());
    const u = readUrl();
    if (u) { setFilters(u.filters); setSearchInput(u.filters.search); setSort(u.sort); setDir(u.dir); setPage(u.page); }
    setReady(true);
  }, []);

  // Debounced search: the server does the matching.
  React.useEffect(() => {
    if (searchInput === filters.search) return;
    const t = setTimeout(() => { setFilters((f) => ({ ...f, search: searchInput })); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [searchInput, filters.search]);

  // Ages keep counting while the page sits open, so a sample goes grey on time.
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  const params = React.useMemo(() => toParams(filters, sort, dir, page, pageSize), [filters, sort, dir, page, pageSize]);

  React.useEffect(() => {
    if (!ready) return;
    try {
      const { pageSize: _s, ...rest } = params;
      const q = new URLSearchParams(rest);
      if (q.get('sort') === 'online' && q.get('dir') === 'asc') { q.delete('sort'); q.delete('dir'); }
      if (q.get('page') === '1') q.delete('page');
      const s = q.toString();
      window.history.replaceState(null, '', s ? `?${s}` : window.location.pathname);
    } catch { /* history unavailable: the view still works */ }
  }, [params, ready]);

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['device-list', params],
    queryFn: () => deviceListApi.list(params),
    enabled: ready,
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
    retry: (n, e) => (e as { response?: { status?: number } })?.response?.status !== 403 && n < 2,
  });

  const alertsVisible = data?.alertsVisible ?? false;
  const offered = COLUMNS.filter((c) => !c.needsAlerts || alertsVisible);
  const shown = offered.filter((c) => c.fixed || columns.includes(c.id));
  const ctx: CellContext = {
    now, alertsVisible,
    liveStaleMs: data?.thresholds.liveStaleMs ?? 15 * 60_000,
    patchStaleMs: data?.thresholds.patchStaleMs ?? 36 * 3600_000,
  };
  const canConnect = !!technician || can('computers:connect');
  const pad = density === 'compact' ? 'px-2.5 py-1.5' : 'px-3 py-3';

  function setFilter<K extends keyof DeviceFilters>(k: K, v: DeviceFilters[K]) {
    setFilters((f) => ({ ...f, [k]: v, ...(k === 'businessId' ? { siteId: '' } : {}) }));
    setPage(1);
  }
  function toggleSort(k: SortKey) {
    if (sort === k) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSort(k); setDir(DEFAULT_DIR[k] ?? 'desc'); }
    setPage(1);
  }
  function persist(cols: string[], dens: Density) {
    if (!savePrefs({ columns: cols, density: dens })) {
      toast({ title: 'Not remembered', description: 'This browser is not letting the page store preferences; they apply until you leave.' });
    }
  }
  function toggleColumn(id: string) {
    const next = columns.includes(id) ? columns.filter((c) => c !== id) : [...columns, id];
    setColumns(next); persist(next, density);
  }
  function setDens(d: Density) { setDensity(d); persist(columns, d); }

  function saveView() {
    const name = viewName.trim().slice(0, 60);
    if (!name) return;
    const next = [...views.filter((v) => v.name !== name), { name, filters, columns, sort, dir }];
    setViews(next);
    if (!saveViews(next)) toast({ title: 'View not saved', description: 'This browser is not letting the page store data.', variant: 'destructive' });
    setSaveOpen(false); setViewName('');
  }
  function applyView(v: SavedView) {
    setFilters(v.filters); setSearchInput(v.filters.search); setColumns(v.columns); setSort(v.sort); setDir(v.dir); setPage(1);
  }
  function deleteView(name: string) {
    const next = views.filter((v) => v.name !== name);
    setViews(next); saveViews(next);
  }

  async function exportCsv() {
    setExporting(true);
    try {
      const { blob, filename, rows } = await deviceListApi.exportCsv(params);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast({ title: `Exported ${rows} device${rows === 1 ? '' : 's'}`, description: 'The export is recorded in the audit log.' });
    } catch (e) {
      toast({ title: 'Export refused', description: await refusalMessage(e, 'The export failed.'), variant: 'destructive' });
    } finally {
      setExporting(false);
    }
  }

  async function connect(r: DeviceRow) {
    try {
      // Same flow as the device page: POST :id/connect decides and records
      // the session (and asks for a step-up when the launch carries the
      // password), then the Connect script does the rest.
      const res = await endpointsApi.connect(r.id);
      const info = res.data?.data as { rustdeskId?: string; sessionId?: string | null } | undefined;
      if (!info?.rustdeskId) {
        toast({ title: 'Device not ready', description: 'This device has not finished enrollment.', variant: 'destructive' });
        return;
      }
      const url = endpointsApi.connectScriptUrl(r.id);
      window.location.href = info.sessionId ? `${url}?session=${encodeURIComponent(info.sessionId)}` : url;
    } catch (e) {
      const res = (e as { response?: { status?: number; data?: { code?: string } } })?.response;
      toast({
        title: res?.status === 403 ? 'Connection refused' : 'Error',
        description: res?.data?.code === 'TEMPORARY_GRANT_REQUIRED'
          ? `${apiMessage(e, 'Interactive control needs a temporary grant.')} Request one from the device page.`
          : apiMessage(e, 'Failed to start connection'),
        variant: 'destructive',
      });
    }
  }

  const sites = (data?.facets.sites ?? []).filter((s) => !filters.businessId || s.businessId === filters.businessId);
  const businesses = data?.facets.businesses ?? [];
  const active = Object.entries(filters).filter(([k, v]) => k !== 'status' ? !!v : v !== 'current').length;
  const refused = (error as { response?: { status?: number } } | null)?.response?.status;
  const from = data && data.total ? (data.page - 1) * data.pageSize + 1 : 0;
  const to = data ? Math.min(data.total, data.page * data.pageSize) : 0;

  const sel = (value: string, onChange: (v: string) => void, label: string, items: [string, string][], width = 'w-[150px]') => (
    <Select value={value || ALL} onValueChange={(v) => onChange(v === ALL ? '' : v)}>
      <SelectTrigger className={cn('h-9', width, value && 'border-primary')} aria-label={label}><SelectValue placeholder={label} /></SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{label}: all</SelectItem>
        {items.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
      </SelectContent>
    </Select>
  );

  return (
    <div className="space-y-3">
      {/* Toolbar: search and filters on the left, view controls on the right. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search name, host, IP, user, business…" className="pl-9 h-9" value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)} aria-label="Search devices" />
        </div>
        {(isPlatformAdmin || businesses.length > 1) && sel(filters.businessId, (v) => setFilter('businessId', v), 'Business', businesses.map((b) => [b.id, `${b.name} (${b.count})`]), 'w-[180px]')}
        {sites.length > 0 && sel(filters.siteId, (v) => setFilter('siteId', v), 'Site', sites.map((s) => [s.id, `${s.name} (${s.count})`]))}
        {sel(filters.online, (v) => setFilter('online', v as DeviceFilters['online']), 'Online', [['online', 'Online'], ['offline', 'Offline']], 'w-[130px]')}
        {alertsVisible && sel(filters.alerts, (v) => setFilter('alerts', v as DeviceFilters['alerts']), 'Alerts', [['any', 'Has open alerts'], ['critical', 'Has critical alerts']])}
        {sel(filters.agent, (v) => setFilter('agent', v as DeviceFilters['agent']), 'Agent', [['signed', 'Signed agent'], ['standard', 'Standard agent'], ['none', 'No agent report']])}
        <Button variant={filters.restartPending ? 'default' : 'outline'} size="sm" className="h-9" onClick={() => setFilter('restartPending', !filters.restartPending)} aria-pressed={filters.restartPending}>
          Restart pending
        </Button>
        {sel(filters.status === 'current' ? '' : filters.status, (v) => setFilter('status', (v || 'current') as DeviceFilters['status']), 'Archived', [['archived', 'Archived only'], ['all', 'Include archived']], 'w-[150px]')}
        {active > 0 && (
          <Button variant="ghost" size="sm" className="h-9" onClick={() => { setFilters(EMPTY_FILTERS); setSearchInput(''); setPage(1); }}>
            <X className="h-4 w-4 mr-1" />Clear ({active})
          </Button>
        )}

        <div className="flex items-center gap-2 sm:ml-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-9"><Bookmark className="h-4 w-4 mr-1.5" />Views</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Saved in this browser only</DropdownMenuLabel>
              {views.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">No saved views yet.</p>}
              {views.map((v) => (
                <DropdownMenuItem key={v.name} onSelect={() => applyView(v)} className="justify-between">
                  <span className="truncate">{v.name}</span>
                  <button type="button" aria-label={`Delete view ${v.name}`} className="ml-2 text-muted-foreground hover:text-destructive"
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); deleteView(v.name); }}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setSaveOpen(true)}>Save current view…</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-9"><Columns3 className="h-4 w-4 mr-1.5" />Columns</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Remembered in this browser</DropdownMenuLabel>
              {offered.filter((c) => !c.fixed).map((c) => (
                <DropdownMenuItem key={c.id} onSelect={(e) => { e.preventDefault(); toggleColumn(c.id); }}>
                  <Check className={cn('h-4 w-4 mr-2', columns.includes(c.id) ? 'opacity-100' : 'opacity-0')} />{c.label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => { setColumns(DEFAULT_COLUMNS); persist(DEFAULT_COLUMNS, density); }}>Reset to default</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="outline" size="sm" className="h-9" onClick={() => setDens(density === 'compact' ? 'comfortable' : 'compact')}
            title={density === 'compact' ? 'Switch to comfortable rows' : 'Switch to compact rows'}>
            <Rows3 className="h-4 w-4 mr-1.5" />{density === 'compact' ? 'Compact' : 'Comfortable'}
          </Button>
          <Button variant="outline" size="sm" className="h-9" onClick={exportCsv} disabled={exporting || !data?.total}
            title="Download every device in the current filtered view as CSV. Recorded in the audit log.">
            {exporting ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Download className="h-4 w-4 mr-1.5" />}Export CSV
          </Button>
        </div>
      </div>

      {refused ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
          {refused === 403 ? 'This view is not available to you: ' : 'The device list could not be loaded: '}
          {apiMessage(error, 'try again shortly.')}
          {active > 0 && <Button variant="link" size="sm" onClick={() => { setFilters(EMPTY_FILTERS); setSearchInput(''); setPage(1); }}>Clear filters</Button>}
        </div>
      ) : null}

      <div className="rounded-md border bg-background overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              {shown.map((c) => (
                <th key={c.id} className={cn('text-left font-medium whitespace-nowrap', pad, c.className)} aria-sort={c.sort && sort === c.sort ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                  {c.sort ? (
                    <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => toggleSort(c.sort!)}>
                      {c.label}
                      {sort === c.sort ? (dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : <ArrowUpDown className="h-3 w-3 opacity-30" />}
                    </button>
                  ) : c.label}
                </th>
              ))}
              {/* The actions column stays in view when the table scrolls sideways. */}
              <th className={cn('text-right font-medium sticky right-0 bg-muted', pad)}>
                <button type="button" className={cn('inline-flex items-center gap-1 text-xs font-normal', sort === 'online' ? 'text-foreground' : 'text-muted-foreground')}
                  onClick={() => { setSort('online'); setDir('asc'); setPage(1); }} title="Online first, then by name">
                  {isFetching ? <Loader2 className="h-3 w-3 animate-spin" /> : null}Online first
                </button>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading || !ready ? (
              <tr><td colSpan={shown.length + 1} className="text-center py-8 text-muted-foreground">Loading…</td></tr>
            ) : !data?.rows.length ? (
              <tr><td colSpan={shown.length + 1} className="text-center py-8 text-muted-foreground">
                {active ? 'No devices match these filters.' : 'No devices yet. Enroll one to see it here.'}
              </td></tr>
            ) : data.rows.map((r) => (
              <tr key={r.id} className={cn('group hover:bg-muted/30', !r.isOnline && 'bg-muted/10')}>
                {shown.map((c) => <td key={c.id} className={cn(pad, 'align-top', c.className)}>{c.cell?.(r, ctx)}</td>)}
                <td className={cn(pad, 'align-top text-right whitespace-nowrap sticky right-0 bg-background shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.15)]')}>
                  <div className="flex justify-end items-center gap-1">
                    {canConnect && (
                      <Button size="sm" variant={r.isOnline ? 'default' : 'outline'} className={density === 'compact' ? 'h-7' : 'h-8'}
                        disabled={!r.isOnline || r.status !== 'ACTIVE'} onClick={() => connect(r)}
                        title={r.isOnline ? 'Connect (the server checks your access first)' : 'Offline — nothing to connect to'}>
                        Connect
                      </Button>
                    )}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="sm" variant="ghost" className={density === 'compact' ? 'h-7 w-7 p-0' : 'h-8 w-8 p-0'} aria-label={`More for ${r.name}`}>
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem asChild><Link href={`/endpoints/${r.id}`}>Open</Link></DropdownMenuItem>
                        <DropdownMenuItem asChild><Link href={`/endpoints/${r.id}?tab=patches`}>Patches</Link></DropdownMenuItem>
                        {r.alerts && <DropdownMenuItem asChild><Link href={`/endpoints/${r.id}?tab=monitoring`}>Monitoring</Link></DropdownMenuItem>}
                        <DropdownMenuItem asChild><Link href={`/endpoints/${r.id}?tab=diagnostics`}>Test connection</Link></DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => {
                          navigator.clipboard?.writeText(r.hostname ?? r.name).then(
                            () => toast({ title: 'Copied', description: r.hostname ?? r.name }),
                            () => toast({ title: 'Could not copy', variant: 'destructive' }),
                          );
                        }}>Copy hostname</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {data ? `${from}–${to} of ${data.total} device${data.total === 1 ? '' : 's'}` : ''}
          {data ? ` · updated ${ago(data.generatedAt, now)}` : ''}
          {data && !alertsVisible ? ' · health and alerts need the monitoring:alerts permission' : ''}
        </span>
        <div className="flex items-center gap-2">
          <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); setPage(1); }}>
            <SelectTrigger className="h-8 w-[130px]" aria-label="Rows per page"><SelectValue /></SelectTrigger>
            <SelectContent>{PAGE_SIZES.map((n) => <SelectItem key={n} value={String(n)}>{n} per page</SelectItem>)}</SelectContent>
          </Select>
          <Button variant="outline" size="sm" className="h-8" disabled={!data || data.page <= 1} onClick={() => setPage((data?.page ?? 2) - 1)} aria-label="Previous page">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span>Page {data?.page ?? page} of {data?.pages ?? 1}</span>
          <Button variant="outline" size="sm" className="h-8" disabled={!data || data.page >= data.pages} onClick={() => setPage((data?.page ?? 0) + 1)} aria-label="Next page">
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save this view</DialogTitle>
            <DialogDescription>
              Saves the current filters, sort and columns under a name, in this browser only. It is not shared with
              anyone and does not follow you to another device. Opening it always shows only devices you can see.
            </DialogDescription>
          </DialogHeader>
          <Input autoFocus placeholder="e.g. Offline servers at HQ" value={viewName} maxLength={60}
            onChange={(e) => setViewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') saveView(); }} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveOpen(false)}>Cancel</Button>
            <Button onClick={saveView} disabled={!viewName.trim()}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
