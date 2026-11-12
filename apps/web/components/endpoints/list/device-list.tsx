'use client';

import * as React from 'react';
import Link from 'next/link';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown, ArrowUp, ArrowUpDown, Bookmark, Check, ChevronLeft, ChevronRight, Columns3, Download, FolderTree,
  Loader2, MoreHorizontal, Rows3, Search, SlidersHorizontal, Trash2, Users, X,
} from 'lucide-react';
import { endpointsApi } from '@/lib/api-client';
import { usePermissions, CAP } from '@/lib/auth';
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
import { BULK_MAX, describeRule, deviceGroupsApi, deviceListApi, deviceViewsApi, refusalMessage, ruleFromFilters, storedFilters, toParams, viewFilters } from './api';
import { clearLegacyViews, loadLegacyViews, loadPrefs, savePrefs, type LegacyView } from './prefs';
import { BulkBar, BulkResultDialog, GroupsDialog } from './bulk';
import { EMPTY_FILTERS, type BulkResponse, type Density, type DeviceFilters, type DeviceRow, type SavedView, type SortKey } from './types';

const PAGE_SIZES = [25, 50, 100, 200];
const ALL = '__all__'; // Radix Select cannot carry an empty value.
const DEFAULT_DIR: Partial<Record<SortKey, 'asc' | 'desc'>> = { online: 'asc', name: 'asc', business: 'asc', site: 'asc', os: 'asc', user: 'asc' };

/** Filters, sort and page in the address bar, so a view can be bookmarked or shared (the server scopes it for whoever opens it). */
function readUrl(): { filters: DeviceFilters; sort: SortKey; dir: 'asc' | 'desc'; page: number } | null {
  try {
    const q = new URLSearchParams(window.location.search);
    if (![...q.keys()].length) return null;
    // An absent key is '' — never null. (Before 0.35 an absent key whose
    // allowed values include '' came back as null, and toParams threw on its
    // .trim(): any /endpoints?… link without a platform crashed the list.)
    const pick = <T extends string>(k: string, ok: readonly T[], d: T): T => { const v = q.get(k) ?? ''; return (ok as readonly string[]).includes(v) ? (v as T) : d; };
    const sort = pick<SortKey>('sort', ['online', 'name', 'business', 'site', 'os', 'lastSeen', 'agent', 'user', 'cpu', 'memory', 'disk', 'patches', 'alerts', 'health'], 'online');
    return {
      filters: {
        search: q.get('search') ?? '', businessId: q.get('businessId') ?? '', siteId: q.get('siteId') ?? '',
        online: pick('online', ['', 'online', 'silent', 'offline'] as const, ''),
        alerts: pick('alerts', ['', 'any', 'critical'] as const, ''),
        restartPending: q.get('restartPending') === 'true',
        agent: pick('agent', ['', 'signed', 'standard', 'none'] as const, ''),
        status: pick('status', ['current', 'archived', 'all'] as const, 'current'),
        groupId: q.get('groupId') ?? '',
        platform: pick('platform', ['', 'windows', 'linux', 'macos', 'other'] as const, ''),
        os: q.get('os') ?? '', tag: q.get('tag') ?? '',
        patches: pick('patches', ['', 'pending', 'current', 'unknown', 'stale'] as const, ''),
        rustdeskMin: q.get('rustdeskMin') ?? '', rustdeskMax: q.get('rustdeskMax') ?? '',
        notSeenDays: q.get('notSeenDays') ?? '', seenWithinDays: q.get('seenWithinDays') ?? '',
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
  const { can, isPlatformAdmin, technician, businessName } = usePermissions();
  const qc = useQueryClient();
  const [filters, setFilters] = React.useState<DeviceFilters>(EMPTY_FILTERS);
  const [searchInput, setSearchInput] = React.useState('');
  const [sort, setSort] = React.useState<SortKey>('online');
  const [dir, setDir] = React.useState<'asc' | 'desc'>('asc');
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(50);
  const [columns, setColumns] = React.useState<string[]>(DEFAULT_COLUMNS);
  const [density, setDensity] = React.useState<Density>('comfortable');
  const [legacy, setLegacy] = React.useState<LegacyView[]>([]);
  const [saveOpen, setSaveOpen] = React.useState(false);
  const [viewName, setViewName] = React.useState('');
  const [shareView, setShareView] = React.useState(false);
  const [activeView, setActiveView] = React.useState<SavedView | null>(null);
  const [groupsOpen, setGroupsOpen] = React.useState(false);
  // 0.34: the less common filters (also what a rule group is made of), edited as a draft and applied together.
  const [moreOpen, setMoreOpen] = React.useState(false);
  // 0.35: the filter sheet at phone width.
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const [moreDraft, setMoreDraft] = React.useState<DeviceFilters>(EMPTY_FILTERS);
  const [ruleOpen, setRuleOpen] = React.useState(false);
  const [ruleName, setRuleName] = React.useState('');
  // Selected rows, kept across pages and filters (id → name). Capped: the server refuses more than BULK_MAX per request.
  const [selected, setSelected] = React.useState<Map<string, string>>(new Map());
  const [bulkResult, setBulkResult] = React.useState<BulkResponse | null>(null);
  const [exporting, setExporting] = React.useState(false);
  const [now, setNow] = React.useState(() => Date.now());
  const [ready, setReady] = React.useState(false);

  // Per-viewer state from this browser, after mount (localStorage is not there during SSR).
  React.useEffect(() => {
    const p = loadPrefs();
    if (p.columns?.length) setColumns(p.columns.filter((c) => COLUMNS.some((d) => d.id === c)));
    setDensity(p.density);
    setLegacy(loadLegacyViews());
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

  // Saved views (0.33): personal, plus the business's shared ones. Opening a
  // view only sets the list's parameters; the server scopes the list for
  // whoever opens it.
  const viewsQ = useQuery({ queryKey: ['device-views'], queryFn: deviceViewsApi.list, enabled: ready, staleTime: 60_000 });
  const views = viewsQ.data?.views ?? [];
  const groupsQ = useQuery({
    queryKey: ['device-groups', filters.businessId],
    queryFn: () => deviceGroupsApi.list(filters.businessId || undefined),
    enabled: ready, staleTime: 60_000,
    retry: false,
  });
  const groups = groupsQ.data?.groups ?? [];
  // A shared view and a new group belong to one business: the viewer's own, or (Platform Admin) the business filter.
  const targetBusinessId = isPlatformAdmin ? (filters.businessId || undefined) : undefined;
  const targetBusinessName = isPlatformAdmin
    ? (filters.businessId ? (data?.facets.businesses.find((b) => b.id === filters.businessId)?.name ?? null) : null)
    : businessName;
  const canShare = !!viewsQ.data?.may.share && (!isPlatformAdmin || !!filters.businessId);

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

  async function saveView() {
    const name = viewName.trim().slice(0, 60);
    if (!name) return;
    try {
      const v = await deviceViewsApi.create({
        name, filters: storedFilters(filters), columns, sort, dir, density,
        shared: shareView, ...(shareView && targetBusinessId ? { businessId: targetBusinessId } : {}),
      });
      setActiveView(v);
      qc.invalidateQueries({ queryKey: ['device-views'] });
      toast({ title: shareView ? 'View shared' : 'View saved', description: shareView ? `Everyone in ${v.business?.name ?? 'this business'} who can see devices now lists it. It shows each of them only the devices they can see.` : 'Only you can see it.' });
      setSaveOpen(false); setViewName(''); setShareView(false);
    } catch (e) {
      toast({ title: 'View not saved', description: await refusalMessage(e, 'The view could not be saved.'), variant: 'destructive' });
    }
  }
  async function updateView(v: SavedView) {
    try {
      const u = await deviceViewsApi.update(v.id, { filters: storedFilters(filters), columns, sort, dir, density });
      setActiveView(u);
      qc.invalidateQueries({ queryKey: ['device-views'] });
      toast({ title: `Updated “${u.name}”`, description: u.shared ? 'The change is recorded in the audit log.' : undefined });
    } catch (e) {
      toast({ title: 'View not updated', description: await refusalMessage(e, 'The view could not be updated.'), variant: 'destructive' });
    }
  }
  function applyView(v: SavedView) {
    const f = viewFilters(v.filters);
    setFilters(f); setSearchInput(f.search); setSort(v.sort); setDir(v.dir); setPage(1);
    if (v.columns.length) setColumns(v.columns.filter((c) => COLUMNS.some((d) => d.id === c)));
    setDensity(v.density);
    setActiveView(v);
  }
  async function deleteView(v: SavedView) {
    if (v.shared && !window.confirm(`Delete the shared view “${v.name}” for everyone in ${v.business?.name ?? 'this business'}?`)) return;
    try {
      await deviceViewsApi.remove(v.id);
      if (activeView?.id === v.id) setActiveView(null);
      qc.invalidateQueries({ queryKey: ['device-views'] });
    } catch (e) {
      toast({ title: 'View not deleted', description: await refusalMessage(e, 'The view could not be deleted.'), variant: 'destructive' });
    }
  }
  /** Views saved in this browser by 0.31/0.32, moved to the server as personal views. */
  async function importLegacy() {
    let ok = 0;
    for (const v of legacy) {
      try {
        await deviceViewsApi.create({ name: v.name.slice(0, 60), filters: storedFilters(v.filters), columns: v.columns, sort: v.sort, dir: v.dir, density, shared: false });
        ok++;
      } catch { /* a view the server refuses (for example a filter it no longer accepts) is left behind */ }
    }
    if (ok === legacy.length) { clearLegacyViews(); setLegacy([]); }
    qc.invalidateQueries({ queryKey: ['device-views'] });
    toast({ title: `Imported ${ok} of ${legacy.length} view${legacy.length === 1 ? '' : 's'}`, description: ok === legacy.length ? 'They are now personal views on your account.' : 'The rest stay in this browser.' });
  }

  function toggleRow(r: DeviceRow) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(r.id)) next.delete(r.id);
      else if (next.size < BULK_MAX) next.set(r.id, r.name);
      else toast({ title: `At most ${BULK_MAX} devices`, description: 'One bulk request acts on at most 200 devices.' });
      return next;
    });
  }
  function togglePage(rows: DeviceRow[]) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (rows.every((r) => next.has(r.id))) rows.forEach((r) => next.delete(r.id));
      else for (const r of rows) { if (next.size >= BULK_MAX) break; next.set(r.id, r.name); }
      return next;
    });
  }
  function bulkDone(r: BulkResponse) {
    setBulkResult(r);
    qc.invalidateQueries({ queryKey: ['device-list'] });
    if (r.action.startsWith('group.')) qc.invalidateQueries({ queryKey: ['device-groups'] });
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

  async function saveRuleGroup() {
    const name = ruleName.trim().slice(0, 60);
    const { rule } = ruleFromFilters(filters);
    if (!name || !Object.keys(rule).length) return;
    try {
      const g = await deviceGroupsApi.create({ name, kind: 'rule', rule, ...(targetBusinessId ? { businessId: targetBusinessId } : {}) });
      qc.invalidateQueries({ queryKey: ['device-groups'] });
      qc.invalidateQueries({ queryKey: ['device-list'] });
      toast({ title: 'Rule group created', description: 'It holds whichever computers match the rule each time it is read; nothing is copied.' });
      setRuleOpen(false); setRuleName('');
      setFilters({ ...EMPTY_FILTERS, ...(filters.businessId ? { businessId: filters.businessId } : {}), groupId: g.id });
      setSearchInput(''); setPage(1);
    } catch (e) {
      toast({ title: 'Rule group not created', description: await refusalMessage(e, 'The group could not be created.'), variant: 'destructive' });
    }
  }
  const MORE_KEYS = ['platform', 'os', 'tag', 'patches', 'rustdeskMin', 'rustdeskMax', 'notSeenDays', 'seenWithinDays'] as const;
  const moreActive = MORE_KEYS.filter((k) => !!filters[k]).length;
  const siteName = (id: string) => data?.facets.sites.find((x) => x.id === id)?.name;

  const sites = (data?.facets.sites ?? []).filter((s) => !filters.businessId || s.businessId === filters.businessId);
  const businesses = data?.facets.businesses ?? [];
  // Groups to filter on: those with devices this viewer can see, plus any the viewer manages (an empty group can still be picked).
  const groupOptions: [string, string][] = (() => {
    const m = new Map<string, string>();
    const label = (name: string, kind: string | undefined, n: number | string) => `${name}${kind === 'rule' ? ' · rule' : ''} (${n})`;
    for (const g of data?.facets.groups ?? []) if (!filters.businessId || g.businessId === filters.businessId) m.set(g.id, label(g.name, g.kind, g.count));
    for (const g of groups) if (!m.has(g.id) && g.may.manage && g.members !== null) m.set(g.id, label(g.name, g.kind, 0));
    if (filters.groupId && !m.has(filters.groupId)) m.set(filters.groupId, 'Selected group');
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  })();
  // The list filtered by a rule group: the bulk bar can act on its current members (resolved by the server).
  const ruleTarget = (() => {
    if (!filters.groupId) return undefined;
    const g = groups.find((x) => x.id === filters.groupId);
    const f = data?.facets.groups.find((x) => x.id === filters.groupId);
    if ((g?.kind ?? f?.kind) !== 'rule') return undefined;
    return { id: filters.groupId, name: g?.name ?? f?.name ?? 'Rule group', count: f ? f.count : g?.members ?? null };
  })();
  const pageRows = data?.rows ?? [];
  const pageAllSelected = pageRows.length > 0 && pageRows.every((r) => selected.has(r.id));
  const active = Object.entries(filters).filter(([k, v]) => k !== 'status' ? !!v : v !== 'current').length;
  // On the phone's Filters button: what the sheet holds (the search box stays outside it).
  const filterCount = active - (filters.search ? 1 : 0);
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

  /**
   * The filter controls (0.35): inline beside the search from `sm` up, as
   * before; below it — a 375 px phone, where they stacked many rows deep
   * above the table — behind a "Filters (n)" button, in a sheet. The same
   * controls and the same state either way: the inline copy is display:none
   * at phone width, and the sheet's content is mounted only while it is open.
   */
  const filterControls = (sheet: boolean) => {
    const w = (desktop: string) => (sheet ? 'w-full' : desktop);
    return (
      <>
        {(isPlatformAdmin || businesses.length > 1) && sel(filters.businessId, (v) => setFilter('businessId', v), 'Business', businesses.map((b) => [b.id, `${b.name} (${b.count})`]), w('w-[180px]'))}
        {sites.length > 0 && sel(filters.siteId, (v) => setFilter('siteId', v), 'Site', sites.map((s) => [s.id, `${s.name} (${s.count})`]), w('w-[150px]'))}
        {groupOptions.length > 0 && sel(filters.groupId, (v) => setFilter('groupId', v), 'Group', groupOptions, w('w-[160px]'))}
        {sel(filters.online, (v) => setFilter('online', v as DeviceFilters['online']), 'Online', [['online', 'Online (agent checking in)'], ['silent', 'Reachable, agent silent'], ['offline', 'Offline']], w('w-[130px]'))}
        {alertsVisible && sel(filters.alerts, (v) => setFilter('alerts', v as DeviceFilters['alerts']), 'Alerts', [['any', 'Has open alerts'], ['critical', 'Has critical alerts']], w('w-[150px]'))}
        {sel(filters.agent, (v) => setFilter('agent', v as DeviceFilters['agent']), 'Agent', [['signed', 'Signed agent'], ['standard', 'Standard agent'], ['none', 'No agent report']], w('w-[150px]'))}
        <Button variant={filters.restartPending ? 'default' : 'outline'} size="sm" className="h-9" onClick={() => setFilter('restartPending', !filters.restartPending)} aria-pressed={filters.restartPending}>
          Restart pending
        </Button>
        <Button variant={moreActive ? 'default' : 'outline'} size="sm" className="h-9" onClick={() => { setMoreDraft(filters); setFiltersOpen(false); setMoreOpen(true); }}>
          More filters{moreActive ? ` (${moreActive})` : ''}
        </Button>
        {sel(filters.status === 'current' ? '' : filters.status, (v) => setFilter('status', (v || 'current') as DeviceFilters['status']), 'Archived', [['archived', 'Archived only'], ['all', 'Include archived']], w('w-[150px]'))}
        {active > 0 && (
          <Button variant="ghost" size="sm" className="h-9" onClick={() => { setFilters(EMPTY_FILTERS); setSearchInput(''); setPage(1); }}>
            <X className="h-4 w-4 mr-1" />Clear ({active})
          </Button>
        )}
      </>
    );
  };

  return (
    <div className="space-y-3">
      {/* Toolbar: search and filters on the left, view controls on the right. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search name, host, IP, user, business…" className="pl-9 h-9" value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)} aria-label="Search devices" />
        </div>
        <div className="hidden sm:contents">{filterControls(false)}</div>
        <Button variant={filterCount ? 'default' : 'outline'} size="sm" className="h-9 sm:hidden" onClick={() => setFiltersOpen(true)}
          aria-haspopup="dialog" data-testid="filters-sheet-trigger">
          <SlidersHorizontal className="h-4 w-4 mr-1.5" />Filters{filterCount ? ` (${filterCount})` : ''}
        </Button>

        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-9" title={activeView ? `View: ${activeView.name}` : 'Saved views'}>
                <Bookmark className="h-4 w-4 mr-1.5" /><span className="max-w-[10rem] truncate">{activeView ? activeView.name : 'Views'}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              {viewsQ.isError && <p className="px-2 py-1.5 text-xs text-destructive">Saved views could not be loaded.</p>}
              {(['personal', 'shared'] as const).map((kind) => {
                const vs = views.filter((v) => (kind === 'shared') === v.shared);
                if (!vs.length && kind === 'shared') return null;
                return (
                  <React.Fragment key={kind}>
                    <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                      {kind === 'personal' ? 'My views (only you see them)' : 'Shared in the business'}
                    </DropdownMenuLabel>
                    {kind === 'personal' && !vs.length && <p className="px-2 py-1.5 text-xs text-muted-foreground">No saved views yet.</p>}
                    {vs.map((v) => (
                      <DropdownMenuItem key={v.id} onSelect={() => applyView(v)} className="justify-between gap-2">
                        <span className="truncate">{v.shared ? <Users className="inline h-3.5 w-3.5 mr-1 text-muted-foreground" aria-label="Shared" /> : null}{v.name}{isPlatformAdmin && v.business?.name ? <span className="text-muted-foreground"> · {v.business.name}</span> : null}</span>
                        {v.may.edit && (
                          <button type="button" aria-label={`Delete view ${v.name}`} className="text-muted-foreground hover:text-destructive"
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); deleteView(v); }}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </DropdownMenuItem>
                    ))}
                  </React.Fragment>
                );
              })}
              <DropdownMenuSeparator />
              {activeView?.may.edit && <DropdownMenuItem onSelect={() => updateView(activeView)}>Update “{activeView.name}” to this view</DropdownMenuItem>}
              <DropdownMenuItem onSelect={() => setSaveOpen(true)}>Save current view…</DropdownMenuItem>
              {legacy.length > 0 && <DropdownMenuItem onSelect={importLegacy}>Import {legacy.length} view{legacy.length === 1 ? '' : 's'} saved in this browser</DropdownMenuItem>}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setRuleOpen(true)}>Save filters as a rule group…</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setGroupsOpen(true)}><FolderTree className="h-4 w-4 mr-2" />Device groups…</DropdownMenuItem>
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

      {selected.size > 0 ? (
        <BulkBar selected={selected} groups={groups} isPlatformAdmin={isPlatformAdmin} canEdit={can(CAP.COMPUTERS_EDIT)} sort={sort} dir={dir}
          onClear={() => setSelected(new Map())} onDone={bulkDone} />
      ) : ruleTarget ? (
        <BulkBar selected={selected} target={ruleTarget} groups={groups} isPlatformAdmin={isPlatformAdmin} canEdit={can(CAP.COMPUTERS_EDIT)} sort={sort} dir={dir}
          onClear={() => setFilter('groupId', '')} onDone={bulkDone} />
      ) : null}

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
              <th className={cn('w-8', pad)}>
                <input type="checkbox" className="h-4 w-4 align-middle" aria-label="Select every device on this page"
                  checked={pageAllSelected} disabled={!pageRows.length} onChange={() => togglePage(pageRows)} />
              </th>
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
              <tr><td colSpan={shown.length + 2} className="text-center py-8 text-muted-foreground">Loading…</td></tr>
            ) : !data?.rows.length ? (
              <tr><td colSpan={shown.length + 2} className="text-center py-8 text-muted-foreground">
                {active ? 'No devices match these filters.' : 'No devices yet. Enroll one to see it here.'}
              </td></tr>
            ) : data.rows.map((r) => (
              <tr key={r.id} className={cn('group hover:bg-muted/30', !r.isOnline && 'bg-muted/10', selected.has(r.id) && 'bg-primary/5')}>
                <td className={cn(pad, 'align-top w-8')}>
                  <input type="checkbox" className="h-4 w-4 mt-0.5" aria-label={`Select ${r.name}`} checked={selected.has(r.id)} onChange={() => toggleRow(r)} />
                </td>
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
              Saves the current filters, sort, columns and density under a name — never the devices themselves. Opening
              a view always shows only the devices whoever opens it can see.
            </DialogDescription>
          </DialogHeader>
          <Input autoFocus placeholder="e.g. Offline servers at HQ" value={viewName} maxLength={60}
            onChange={(e) => setViewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') saveView(); }} />
          <label className={cn('flex items-start gap-2 text-sm', !canShare && 'opacity-60')}>
            <input type="checkbox" className="h-4 w-4 mt-0.5" checked={shareView} disabled={!canShare} onChange={(e) => setShareView(e.target.checked)} />
            <span>
              Share with everyone in {targetBusinessName ?? 'the business'}
              <span className="block text-xs text-muted-foreground">
                {canShare
                  ? 'They see it in their Views menu; it shows each of them only what they can already see. Sharing is recorded in the audit log.'
                  : isPlatformAdmin && !filters.businessId
                    ? 'Pick a business filter first: a shared view belongs to one business.'
                    : 'Sharing is for a Business Owner, a technician with computers:edit over the whole business, or the MSP.'}
              </span>
            </span>
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveOpen(false)}>Cancel</Button>
            <Button onClick={saveView} disabled={!viewName.trim()}>{shareView ? 'Share' : 'Save'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Phone width only (the trigger is sm:hidden): a bottom sheet. Filters apply as they change, as inline. */}
      <Dialog open={filtersOpen} onOpenChange={setFiltersOpen}>
        <DialogContent data-testid="filters-sheet"
          className="top-auto bottom-0 left-0 max-h-[85vh] max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-t-lg p-4 data-[state=open]:slide-in-from-left-0 data-[state=open]:slide-in-from-bottom-1/2 data-[state=closed]:slide-out-to-left-0 data-[state=closed]:slide-out-to-bottom-1/2 data-[state=open]:zoom-in-100 data-[state=closed]:zoom-out-100">
          <DialogHeader className="text-left">
            <DialogTitle>Filters</DialogTitle>
            <DialogDescription>They apply as you choose them. The search box stays above the list.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">{filterControls(true)}</div>
          <DialogFooter>
            <Button className="w-full" onClick={() => setFiltersOpen(false)} data-testid="filters-sheet-done">
              {data ? `Show ${data.total} device${data.total === 1 ? '' : 's'}` : 'Done'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={moreOpen} onOpenChange={setMoreOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>More filters</DialogTitle>
            <DialogDescription>
              Narrow the list further. These are also what a rule group can be made of. A computer with no reported
              RustDesk version, or one that is not plain numbers (a nightly build), never matches a version range.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <label className="space-y-1"><span className="text-xs text-muted-foreground">Platform</span>
              <Select value={moreDraft.platform || ALL} onValueChange={(v) => setMoreDraft((d) => ({ ...d, platform: (v === ALL ? '' : v) as DeviceFilters['platform'] }))}>
                <SelectTrigger className="h-9" aria-label="Platform"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Any</SelectItem>
                  <SelectItem value="windows">Windows</SelectItem><SelectItem value="linux">Linux</SelectItem>
                  <SelectItem value="macos">macOS</SelectItem><SelectItem value="other">Other / unknown</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="space-y-1"><span className="text-xs text-muted-foreground">Updates</span>
              <Select value={moreDraft.patches || ALL} onValueChange={(v) => setMoreDraft((d) => ({ ...d, patches: (v === ALL ? '' : v) as DeviceFilters['patches'] }))}>
                <SelectTrigger className="h-9" aria-label="Updates"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Any</SelectItem>
                  <SelectItem value="pending">Updates pending</SelectItem><SelectItem value="current">No updates pending</SelectItem>
                  <SelectItem value="stale">Scan is stale</SelectItem><SelectItem value="unknown">Never scanned</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="space-y-1"><span className="text-xs text-muted-foreground">OS name contains</span>
              <Input className="h-9" maxLength={60} placeholder="e.g. Server 2022" value={moreDraft.os} onChange={(e) => setMoreDraft((d) => ({ ...d, os: e.target.value }))} />
            </label>
            <label className="space-y-1"><span className="text-xs text-muted-foreground">Tag (exact)</span>
              <Input className="h-9" maxLength={64} placeholder="e.g. kiosk" value={moreDraft.tag} onChange={(e) => setMoreDraft((d) => ({ ...d, tag: e.target.value }))} />
            </label>
            <label className="space-y-1"><span className="text-xs text-muted-foreground">RustDesk version from</span>
              <Input className="h-9" maxLength={30} placeholder="e.g. 1.3" inputMode="decimal" value={moreDraft.rustdeskMin} onChange={(e) => setMoreDraft((d) => ({ ...d, rustdeskMin: e.target.value }))} />
            </label>
            <label className="space-y-1"><span className="text-xs text-muted-foreground">RustDesk version up to</span>
              <Input className="h-9" maxLength={30} placeholder="e.g. 1.4.1" inputMode="decimal" value={moreDraft.rustdeskMax} onChange={(e) => setMoreDraft((d) => ({ ...d, rustdeskMax: e.target.value }))} />
            </label>
            <label className="space-y-1"><span className="text-xs text-muted-foreground">Not seen for at least (days)</span>
              <Input className="h-9" type="number" min={1} max={3650} value={moreDraft.notSeenDays} onChange={(e) => setMoreDraft((d) => ({ ...d, notSeenDays: e.target.value }))} />
            </label>
            <label className="space-y-1"><span className="text-xs text-muted-foreground">Seen within (days)</span>
              <Input className="h-9" type="number" min={1} max={3650} value={moreDraft.seenWithinDays} onChange={(e) => setMoreDraft((d) => ({ ...d, seenWithinDays: e.target.value }))} />
            </label>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setMoreDraft((d) => ({ ...d, ...Object.fromEntries(MORE_KEYS.map((k) => [k, ''])) }))}>Clear these</Button>
            <Button onClick={() => {
              setFilters((f) => ({ ...f, ...Object.fromEntries(MORE_KEYS.map((k) => [k, moreDraft[k]])) }));
              setPage(1); setMoreOpen(false);
            }}>Apply</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={ruleOpen} onOpenChange={setRuleOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save filters as a rule group</DialogTitle>
            <DialogDescription>
              A rule group holds whichever of {targetBusinessName ?? 'the business'}’s computers match these filters each time it is
              read — a computer that goes offline leaves an “online” group at once. Nothing is copied, and nobody adds to it by hand.
              Everyone sees only the members they can already see.
            </DialogDescription>
          </DialogHeader>
          {(() => {
            const { rule, left } = ruleFromFilters(filters);
            const has = Object.keys(rule).length > 0;
            return (
              <>
                <p className="text-sm"><span className="text-muted-foreground">Rule: </span>{has ? describeRule(rule, siteName) : 'set at least one filter first (online, platform, site, updates…)'}</p>
                {left.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Not part of the rule: {left.join(', ')} — search, business, group and the archived filter are never stored in a rule.
                  </p>
                )}
                {isPlatformAdmin && !filters.businessId && <p className="text-xs text-muted-foreground">Pick a business filter first: a group belongs to one business.</p>}
                <Input autoFocus placeholder="e.g. Offline for a week" value={ruleName} maxLength={60}
                  onChange={(e) => setRuleName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') saveRuleGroup(); }} />
                <DialogFooter>
                  <Button variant="outline" onClick={() => setRuleOpen(false)}>Cancel</Button>
                  <Button onClick={saveRuleGroup} disabled={!ruleName.trim() || !has || (isPlatformAdmin && !filters.businessId)}>Create rule group</Button>
                </DialogFooter>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      <BulkResultDialog result={bulkResult} onClose={() => setBulkResult(null)} />
      <GroupsDialog open={groupsOpen} onOpenChange={setGroupsOpen}
        groups={groups.filter((g) => !filters.businessId || g.business?.id === filters.businessId)}
        businessId={targetBusinessId} businessLabel={targetBusinessName}
        canCreate={!!groupsQ.data?.may.manage && (!isPlatformAdmin || !!filters.businessId)}
        onChanged={() => { qc.invalidateQueries({ queryKey: ['device-groups'] }); qc.invalidateQueries({ queryKey: ['device-list'] }); }}
        currentRule={ruleFromFilters(filters).rule} siteName={siteName} onShow={(id) => setFilter('groupId', id)} />
    </div>
  );
}
