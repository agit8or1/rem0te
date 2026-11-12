'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/utils';
import { AlertTriangle, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { ago } from './device-model';

/**
 * Processes, Services and Network (0.33): full read-only snapshots.
 *
 * Each tab shows the newest result of one diagnostics-catalog key
 * (process_list, service_list, network_adapters) with when it was taken and
 * how old it is. Refresh asks for a new one exactly as the Diagnostics tab's
 * Run does — POST /diagnostics/runs with the key and nothing else — and the
 * computer collects it on its next check-in.
 *
 * 0.35: the server also asks for each snapshot on its own — every few hours,
 * and every few minutes while this tab is open (snapshot-schedule.ts). The
 * tab re-reads every 30 s while it is visible (4 s while a refresh is on its
 * way), so a new snapshot appears without a reload, and when nothing can
 * arrive it says why (`automatic.reason`) rather than inviting a Refresh
 * that would only expire.
 *
 * There is deliberately nothing here that acts on the computer: no end
 * process, stop, start or restart. Changing a computer is a signed
 * maintenance action (Actions tab, signed agent), never a button on a list.
 *
 * Every value came from a managed computer and is rendered as text.
 */

type SnapshotKey = 'process_list' | 'service_list' | 'network_adapters';
type RunStatus = 'REQUESTED' | 'DELIVERED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'EXPIRED';
interface Run {
  id: string; key: string; status: RunStatus;
  requestedAt: string; completedAt: string | null;
  requestedBy: { id: string | null; name: string | null };
  /** 0.35: the server asked on its own (no requester). */
  automatic?: boolean;
  error: string | null; truncated: boolean; resultBytes: number | null;
  result: Record<string, unknown> | null;
}
type AutoReason =
  | 'not_active' | 'unsupported_platform' | 'not_bound' | 'agent_unknown' | 'agent_too_old' | 'agent_silent'
  | 'disabled' | 'key_off' | 'process_off';
interface Automatic {
  state: 'on' | 'off' | 'blocked';
  reason: AutoReason | null;
  /** Roughly when the next automatic snapshot is asked for (it goes on the first check-in after). */
  nextAt: string | null;
  intervalMinutes: number | null;
  basis: 'schedule' | 'watch' | null;
}
interface Snapshot {
  key: SnapshotKey; label: string;
  supported: boolean; agentBound: boolean; isOnline: boolean; lastSeenAt: string | null;
  agentVersion?: string | null; agentSilent?: boolean; automatic?: Automatic;
  takenAt: string | null; latest: Run | null; pending: Run | null; lastFailure: Run | null;
}

/** While the tab is open and visible: re-read this often (the server also treats a read as "someone is looking"). */
export const SNAPSHOT_REFETCH_MS = 30_000;
/** While a refresh is on its way. */
export const SNAPSHOT_PENDING_REFETCH_MS = 4_000;

function every(min: number | null): string {
  if (!min) return '';
  if (min < 60) return `every ${min} minutes`;
  const h = min / 60;
  return h === 1 ? 'every hour' : Number.isInteger(h) ? `every ${h} hours` : `every ${min} minutes`;
}
function inAbout(at: string): string {
  const ms = new Date(at).getTime() - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 60_000) return 'within a few minutes';
  const m = Math.round(ms / 60_000);
  if (m < 90) return `in about ${m} minutes`;
  return `in about ${Math.round(m / 60)} hours`;
}

/**
 * Why nothing will arrive on its own, said exactly. Null when automatic
 * collection is on and the computer can be asked. The wording for a silent
 * agent matches the header's ("its agent has not checked in since …").
 */
export function automaticBlocker(s: Snapshot): string | null {
  const a = s.automatic;
  if (!a) return null;
  switch (a.reason) {
    case 'unsupported_platform': return 'Collected by the Windows agents only. The Linux and macOS agents report inventory and pending updates, and run nothing the console asks for.';
    case 'not_bound': return 'This computer has never authenticated with a device secret, so it cannot be asked for anything. Re-run the installer on it once.';
    case 'not_active': return 'This computer is not active (archived or not enrolled yet), so nothing is collected from it.';
    case 'agent_unknown': return 'This computer’s agent has never reported its version, so it is not asked automatically: it probably predates 0.33, which first collected this. Reinstall the agent from the Specs tab.';
    case 'agent_too_old': return `This computer’s agent (${s.agentVersion ?? 'unknown'}) predates 0.33, which first collected this, so it is not asked automatically and a Refresh would expire unanswered. Reinstall the agent from the Specs tab.`;
    case 'agent_silent': return `Its agent has not checked in since ${ago(s.lastSeenAt)}${s.isOnline ? ' (it is still reachable through RustDesk)' : ''}, so nothing can be collected until it does.`;
    case 'disabled': return 'Automatic snapshots are turned off on this server (Settings → Monitoring & API). Refresh still asks for one.';
    case 'process_off': return 'Automatic snapshots are switched off where this server runs (SNAPSHOT_SWEEP=off). Refresh still asks for one.';
    case 'key_off': return 'This snapshot is not on an automatic schedule (Settings → Monitoring & API). Refresh asks for one.';
    default: return null;
  }
}


/** A snapshot older than this is called out: it is a picture, not a live view. */
const OLD_MS = 24 * 3600_000;

const arr = <T = Record<string, unknown>>(v: unknown) => (Array.isArray(v) ? (v as T[]) : []);
const txt = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));
const errText = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback;
function bytes(n: unknown): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}
function cpu(n: unknown): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (n < 60) return `${n.toFixed(1)} s`;
  const m = Math.floor(n / 60);
  return m < 60 ? `${m} min ${Math.round(n % 60)} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
function speed(n: unknown): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '—';
  return n >= 1e9 ? `${+(n / 1e9).toFixed(1)} Gbps` : n >= 1e6 ? `${Math.round(n / 1e6)} Mbps` : `${Math.round(n / 1e3)} kbps`;
}

function useSnapshot(endpointId: string, key: SnapshotKey) {
  return useQuery({
    queryKey: ['diagnostics-snapshot', endpointId, key],
    queryFn: () => api.get(`/endpoints/${endpointId}/diagnostics/snapshots/${key}`).then((r) => r.data?.data as Snapshot),
    // Fast while a refresh is on its way, then every 30 s while the tab is
    // visible (react-query stops when the browser tab is hidden), so an
    // automatic snapshot shows up without a reload.
    refetchInterval: (q) => (q.state.data?.pending ? SNAPSHOT_PENDING_REFETCH_MS : SNAPSHOT_REFETCH_MS),
  });
}

/** The frame every snapshot tab shares: when, how old, Refresh, and why it might not work. */
function SnapshotFrame({ endpointId, snapKey, title, note, children }: {
  endpointId: string; snapKey: SnapshotKey; title: string; note: string;
  children: (result: Record<string, unknown>) => React.ReactNode;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const q = useSnapshot(endpointId, snapKey);
  const refresh = useMutation({
    mutationFn: () => api.post(`/endpoints/${endpointId}/diagnostics/runs`, { key: snapKey }).then((r) => r.data?.data as { deduplicated: boolean }),
    onSuccess: (d) => {
      if (d?.deduplicated) toast({ title: 'Already requested', description: 'A refresh is already waiting for this computer.' });
      qc.invalidateQueries({ queryKey: ['diagnostics-snapshot', endpointId, snapKey] });
      qc.invalidateQueries({ queryKey: ['diagnostics-runs', endpointId] });
    },
    onError: (e) => toast({ title: 'Could not refresh', description: errText(e, 'The request was refused.'), variant: 'destructive' }),
  });

  if (q.isLoading) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>;
  if (q.isError || !q.data) return <p className="text-sm text-red-600">{errText(q.error, 'Not available for this computer.')}</p>;
  const s = q.data;
  // Refresh cannot work at all on these: the button is disabled and the reason shown.
  const blocked = !s.supported
    ? 'Collected by the Windows agents only. The Linux and macOS agents report inventory and pending updates, and run nothing the console asks for.'
    : !s.agentBound
      ? 'This computer has never authenticated with a device secret, so it cannot be asked for anything. Re-run the installer on it once.'
      : null;
  const auto = s.automatic;
  const why = blocked ? null : automaticBlocker(s);
  const old = !!s.takenAt && Date.now() - new Date(s.takenAt).getTime() > OLD_MS;
  const waiting = !!s.pending || refresh.isPending;
  const by = s.latest?.automatic ? ', automatically' : s.latest?.requestedBy.name ? `, asked for by ${s.latest.requestedBy.name}` : '';
  const schedule = auto?.state === 'on' && auto.intervalMinutes
    ? auto.basis === 'watch' ? `${every(auto.intervalMinutes)} while this tab is open` : every(auto.intervalMinutes)
    : null;

  return (
    <Card data-testid={`snapshot-${snapKey}`}>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0 pb-3">
        <div className="min-w-0 space-y-1">
          <CardTitle className="text-sm flex items-center gap-2">
            {title}
            <Badge variant="outline" className="gap-1 font-normal"><ShieldCheck className="h-3 w-3" />Read-only snapshot</Badge>
          </CardTitle>
          <p className="text-xs text-muted-foreground" data-testid="snapshot-age" data-taken-at={s.takenAt ?? ''}>
            {s.takenAt
              ? <>Taken <span title={formatDate(s.takenAt)}>{ago(s.takenAt)}</span> ({formatDate(s.takenAt)}){by}. This is a picture of that moment, not a live view.</>
              : blocked || why
                ? 'Never taken on this computer.'
                : auto?.state === 'on'
                  ? 'Not taken yet. It is asked for automatically on this computer’s next check-in; Refresh asks now.'
                  : 'Never taken on this computer. Refresh asks for one.'}
          </p>
          {auto?.state === 'on' && !s.pending && (
            <p className="text-xs text-muted-foreground" data-testid="snapshot-next">
              Refreshed automatically {schedule}.{auto.nextAt && <> Next automatic refresh around <span title={formatDate(auto.nextAt)}>{formatDate(auto.nextAt)}</span> ({inAbout(auto.nextAt)}).</>}
            </p>
          )}
          {why && <p className="text-xs text-amber-700 dark:text-amber-400 flex items-start gap-1" data-testid="snapshot-blocked" data-reason={auto?.reason ?? ''}><AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" />{why}</p>}
          {old && <p className="text-xs text-amber-700 dark:text-amber-400 flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5" />Over a day old — refresh before relying on it.</p>}
          {s.pending && (
            <p className="text-xs text-muted-foreground" data-testid="snapshot-pending">
              {s.pending.automatic ? 'Automatic refresh' : 'Refresh'} requested {ago(s.pending.requestedAt)} — {s.pending.status === 'REQUESTED' ? 'waiting for the computer’s next check-in (normally within three minutes; it expires after fifteen).' : 'the computer is collecting it.'} This page updates when it arrives.
            </p>
          )}
          {s.lastFailure?.error && <p className="text-xs text-red-600 dark:text-red-400">Last refresh {s.lastFailure.status === 'EXPIRED' ? 'expired' : 'failed'} {ago(s.lastFailure.completedAt ?? s.lastFailure.requestedAt)}: {s.lastFailure.error}</p>}
          {!s.isOnline && s.supported && !why && <p className="text-xs text-muted-foreground">This computer looks offline (last seen {ago(s.lastSeenAt)}).</p>}
        </div>
        <Button size="sm" variant="outline" disabled={!!blocked || waiting} onClick={() => refresh.mutate()} data-testid="snapshot-refresh">
          {waiting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          <span className="ml-1.5">{waiting ? 'Waiting' : 'Refresh'}</span>
        </Button>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {blocked && <p className="text-sm text-amber-700 dark:text-amber-400 flex items-center gap-2"><AlertTriangle className="h-4 w-4" />{blocked}</p>}
        {s.latest?.result && children(s.latest.result)}
        {s.latest?.truncated && <p className="text-[11px] text-amber-700 dark:text-amber-400">The list was shortened to fit the stored size limit (128 KB); the smallest entries were left out.</p>}
        <p className="text-[11px] text-muted-foreground">{note}</p>
      </CardContent>
    </Card>
  );
}

type Col<T> = { label: string; sort?: (r: T) => string | number; cell: (r: T) => React.ReactNode; className?: string };

function SortTable<T>({ rows, cols, initial, empty }: { rows: T[]; cols: Col<T>[]; initial: { col: number; desc: boolean }; empty: string }) {
  const [sort, setSort] = useState(initial);
  const sorted = useMemo(() => {
    const f = cols[sort.col]?.sort;
    if (!f) return rows;
    return [...rows].sort((a, b) => {
      const x = f(a), y = f(b);
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return sort.desc ? -c : c;
    });
  }, [rows, cols, sort]);
  return (
    <div className="max-h-[36rem] overflow-auto rounded-md border">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-card text-muted-foreground">
          <tr>
            {cols.map((c, i) => (
              <th key={c.label} className="px-3 py-1.5 font-medium whitespace-nowrap">
                {c.sort ? (
                  <button type="button" className="hover:text-foreground" onClick={() => setSort((s) => ({ col: i, desc: s.col === i ? !s.desc : i !== 0 }))}>
                    {c.label}{sort.col === i ? (sort.desc ? ' ↓' : ' ↑') : ''}
                  </button>
                ) : c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={i} className="border-t align-top">
              {cols.map((c) => <td key={c.label} className={`px-3 py-1 ${c.className ?? ''}`}>{c.cell(r)}</td>)}
            </tr>
          ))}
          {sorted.length === 0 && <tr><td colSpan={cols.length} className="px-3 py-3 text-muted-foreground">{empty}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// ── Processes ───────────────────────────────────────────────────────────────

interface Proc { name: string; pid: number | null; cpuSeconds: number | null; workingSetBytes: number | null; user: string | null; startedAt: string | null }

export function DeviceProcessesTab({ endpointId }: { endpointId: string }) {
  const [filter, setFilter] = useState('');
  return (
    <SnapshotFrame endpointId={endpointId} snapKey="process_list" title="Processes"
      note="Name, process id, total processor time since start, working set, user and start time. Command lines, paths, modules and environment are never collected. Nothing here ends a process.">
      {(r) => {
        const all = arr<Proc>(r.processes);
        const q = filter.trim().toLowerCase();
        const rows = all.filter((p) => !q || `${p.name} ${p.pid ?? ''} ${p.user ?? ''}`.toLowerCase().includes(q));
        return (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {txt(r.processCount)} processes running; {all.length} listed.
                {r.userNamesRead === false && ' The agent could not read which user each process runs as (it was not elevated).'}
              </p>
              <Input className="h-8 w-full sm:w-56" placeholder="Filter by name, PID or user" aria-label="Filter processes" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            <SortTable<Proc> rows={rows} initial={{ col: 3, desc: true }} empty={q ? `Nothing matches “${filter}”.` : 'No processes reported.'} cols={[
              { label: 'Name', sort: (p) => p.name.toLowerCase(), cell: (p) => p.name },
              { label: 'PID', sort: (p) => p.pid ?? -1, cell: (p) => <span className="font-mono">{txt(p.pid)}</span> },
              { label: 'CPU time', sort: (p) => p.cpuSeconds ?? -1, cell: (p) => cpu(p.cpuSeconds), className: 'whitespace-nowrap' },
              { label: 'Memory', sort: (p) => p.workingSetBytes ?? -1, cell: (p) => bytes(p.workingSetBytes), className: 'whitespace-nowrap' },
              { label: 'User', sort: (p) => (p.user ?? '').toLowerCase(), cell: (p) => txt(p.user), className: 'break-all' },
              { label: 'Started', sort: (p) => (p.startedAt ? new Date(p.startedAt).getTime() : 0), cell: (p) => (p.startedAt ? <span title={formatDate(p.startedAt)}>{ago(p.startedAt)}</span> : '—'), className: 'whitespace-nowrap' },
            ]} />
          </>
        );
      }}
    </SnapshotFrame>
  );
}

// ── Services ────────────────────────────────────────────────────────────────

interface Svc { name: string; displayName: string | null; state: string; startMode: string; account: string | null }
const START_LABEL: Record<string, string> = { Automatic: 'Automatic', AutomaticDelayedStart: 'Automatic (delayed)', Manual: 'Manual', Disabled: 'Disabled', Boot: 'Boot', System: 'System', Unknown: '—' };
const STATE_LABEL: Record<string, string> = { StartPending: 'Starting', StopPending: 'Stopping', ContinuePending: 'Resuming', PausePending: 'Pausing' };

export function DeviceServicesTab({ endpointId }: { endpointId: string }) {
  const [filter, setFilter] = useState('');
  const [onlyProblems, setOnlyProblems] = useState(false);
  return (
    <SnapshotFrame endpointId={endpointId} snapKey="service_list" title="Services"
      note="Name, display name, state, start mode and the account each service runs as. Binary paths and arguments are never collected. Nothing here starts or stops a service: restarting one is a signed maintenance action on the Actions tab.">
      {(r) => {
        const all = arr<Svc>(r.services);
        const auto = (v: Svc) => v.startMode === 'Automatic' || v.startMode === 'AutomaticDelayedStart';
        const q = filter.trim().toLowerCase();
        const rows = all.filter((v) => (!onlyProblems || (auto(v) && v.state !== 'Running')) && (!q || `${v.name} ${v.displayName ?? ''} ${v.account ?? ''}`.toLowerCase().includes(q)));
        const problems = all.filter((v) => auto(v) && v.state !== 'Running').length;
        return (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">{txt(r.serviceCount)} services installed; {all.length} listed; {problems} set to start automatically but not running.</p>
              <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto">
                <label className="flex items-center gap-1.5 text-xs">
                  <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
                  Automatic, not running
                </label>
                <Input className="h-8 w-full sm:w-56" placeholder="Filter by name or account" aria-label="Filter services" value={filter} onChange={(e) => setFilter(e.target.value)} />
              </div>
            </div>
            <SortTable<Svc> rows={rows} initial={{ col: 0, desc: false }} empty={q || onlyProblems ? 'Nothing matches.' : 'No services reported.'} cols={[
              { label: 'Service', sort: (v) => (v.displayName ?? v.name).toLowerCase(), cell: (v) => txt(v.displayName) },
              { label: 'Name', sort: (v) => v.name.toLowerCase(), cell: (v) => <span className="font-mono">{v.name}</span> },
              { label: 'State', sort: (v) => v.state, cell: (v) => <span className={v.state === 'Running' ? 'text-green-700 dark:text-green-400' : auto(v) ? 'text-red-600 dark:text-red-400 font-medium' : 'text-muted-foreground'}>{STATE_LABEL[v.state] ?? v.state}</span> },
              { label: 'Start mode', sort: (v) => v.startMode, cell: (v) => START_LABEL[v.startMode] ?? v.startMode, className: 'whitespace-nowrap' },
              { label: 'Runs as', sort: (v) => (v.account ?? '').toLowerCase(), cell: (v) => txt(v.account), className: 'break-all' },
            ]} />
          </>
        );
      }}
    </SnapshotFrame>
  );
}

// ── Network ─────────────────────────────────────────────────────────────────

interface Adapter {
  name: string; connectionId: string | null; status: string | null; up: boolean; mac: string | null; speedBps: number | null;
  ipv4: string[]; ipv6: string[]; gateway: string[]; dnsServers: string[]; dnsSuffix: string | null;
  dhcpEnabled: boolean | null; dhcpServer: string | null; dhcpLeaseObtainedAt: string | null; dhcpLeaseExpiresAt: string | null;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="break-all font-mono text-xs">{children}</dd>
    </div>
  );
}

export function DeviceNetworkTab({ endpointId }: { endpointId: string }) {
  return (
    <SnapshotFrame endpointId={endpointId} snapKey="network_adapters" title="Network adapters"
      note="Every connection Windows lists under Network Connections, with its addresses, gateways, DNS and DHCP. The MAC address is shown in full, as on the Specs tab. Nothing here changes an adapter.">
      {(r) => {
        const ads = arr<Adapter>(r.adapters);
        if (!ads.length) return <p className="text-sm text-muted-foreground">No network connections reported.</p>;
        return (
          <div className="grid gap-3 lg:grid-cols-2">
            {ads.map((a, i) => (
              <div key={`${a.connectionId}-${i}`} className="space-y-2 rounded-md border p-3" data-testid="adapter">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium break-words">{txt(a.connectionId)}</p>
                    <p className="text-xs text-muted-foreground break-words">{txt(a.name)}</p>
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${a.up ? 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200' : 'bg-muted text-muted-foreground'}`}>{txt(a.status)}</span>
                </div>
                <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
                  <Field label="IPv4">{a.ipv4?.join(', ') || '—'}</Field>
                  <Field label="IPv6">{a.ipv6?.join(', ') || '—'}</Field>
                  <Field label="Gateway">{a.gateway?.join(', ') || '—'}</Field>
                  <Field label="DNS servers">{a.dnsServers?.join(', ') || '—'}</Field>
                  <Field label="DNS suffix">{txt(a.dnsSuffix)}</Field>
                  <Field label="MAC">{txt(a.mac)}</Field>
                  <Field label="Speed">{speed(a.speedBps)}</Field>
                  <Field label="DHCP">
                    {a.dhcpEnabled === null ? '—' : a.dhcpEnabled ? `On${a.dhcpServer ? ` (server ${a.dhcpServer})` : ''}` : 'Off (static)'}
                  </Field>
                  {a.dhcpEnabled && (a.dhcpLeaseObtainedAt || a.dhcpLeaseExpiresAt) && (
                    <Field label="Lease">{a.dhcpLeaseObtainedAt ? formatDate(a.dhcpLeaseObtainedAt) : '—'} → {a.dhcpLeaseExpiresAt ? formatDate(a.dhcpLeaseExpiresAt) : '—'}</Field>
                  )}
                </dl>
              </div>
            ))}
          </div>
        );
      }}
    </SnapshotFrame>
  );
}
