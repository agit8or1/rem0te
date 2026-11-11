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
  requestedBy: { id: string; name: string | null };
  error: string | null; truncated: boolean; resultBytes: number | null;
  result: Record<string, unknown> | null;
}
interface Snapshot {
  key: SnapshotKey; label: string;
  supported: boolean; agentBound: boolean; isOnline: boolean; lastSeenAt: string | null;
  takenAt: string | null; latest: Run | null; pending: Run | null; lastFailure: Run | null;
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
    // Polled only while a refresh is on its way.
    refetchInterval: (q) => (q.state.data?.pending ? 4000 : false),
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
  const blocked = !s.supported
    ? 'Collected by the standard Windows agent only. The Linux agent reports inventory and pending updates, and runs nothing the console asks for.'
    : !s.agentBound
      ? 'This computer has never authenticated with a device secret, so it cannot be asked for anything. Re-run the installer on it once.'
      : null;
  const old = !!s.takenAt && Date.now() - new Date(s.takenAt).getTime() > OLD_MS;
  const waiting = !!s.pending || refresh.isPending;

  return (
    <Card data-testid={`snapshot-${snapKey}`}>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0 pb-3">
        <div className="min-w-0 space-y-1">
          <CardTitle className="text-sm flex items-center gap-2">
            {title}
            <Badge variant="outline" className="gap-1 font-normal"><ShieldCheck className="h-3 w-3" />Read-only snapshot</Badge>
          </CardTitle>
          <p className="text-xs text-muted-foreground" data-testid="snapshot-age">
            {s.takenAt
              ? <>Taken <span title={formatDate(s.takenAt)}>{ago(s.takenAt)}</span> ({formatDate(s.takenAt)}){s.latest?.requestedBy.name ? `, asked for by ${s.latest.requestedBy.name}` : ''}. This is a picture of that moment, not a live view.</>
              : 'Never taken on this computer. Refresh asks for one.'}
          </p>
          {old && <p className="text-xs text-amber-700 dark:text-amber-400 flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5" />Over a day old — refresh before relying on it.</p>}
          {s.pending && (
            <p className="text-xs text-muted-foreground" data-testid="snapshot-pending">
              Refresh requested {ago(s.pending.requestedAt)} — {s.pending.status === 'REQUESTED' ? 'waiting for the computer’s next check-in (normally within three minutes; it expires after fifteen).' : 'the computer is collecting it.'}
            </p>
          )}
          {s.lastFailure?.error && <p className="text-xs text-red-600 dark:text-red-400">Last refresh {s.lastFailure.status === 'EXPIRED' ? 'expired' : 'failed'} {ago(s.lastFailure.completedAt ?? s.lastFailure.requestedAt)}: {s.lastFailure.error}</p>}
          {!s.isOnline && s.supported && <p className="text-xs text-muted-foreground">This computer looks offline (last seen {ago(s.lastSeenAt)}).</p>}
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
