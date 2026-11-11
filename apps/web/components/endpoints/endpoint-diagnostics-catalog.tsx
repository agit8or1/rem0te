'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/utils';
import {
  Stethoscope, Play, Loader2, CheckCircle2, XCircle, Clock, AlertTriangle, ShieldCheck, Lock,
} from 'lucide-react';

/**
 * One-click read-only diagnostics (0.31).
 *
 * Each button asks the server to stage a catalog KEY for this computer. The
 * computer collects it on its next heartbeat (up to about three minutes),
 * runs the fixed read-only check its agent has for that key, and posts the
 * result back. Nothing typed here reaches the computer: there is no free
 * text, and the server and the agent both refuse keys outside the catalog.
 *
 * Results are rendered as text, never markup — every field came from a
 * managed computer and is attacker-influenced on a compromised one.
 */

type RunStatus = 'REQUESTED' | 'DELIVERED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'EXPIRED';
const OPEN: RunStatus[] = ['REQUESTED', 'DELIVERED', 'RUNNING'];

interface CatalogItem {
  key: string;
  label: string;
  description: string;
  capability: string;
  capabilityReason: string;
  supportedOs: string[];
  duration: 'seconds' | 'minute' | 'minutes';
  risk: 'read_only';
  expectedImpact: 'none';
  approvals: string;
  allowed: boolean;
  /** 0.33: shown as a snapshot on that workspace tab instead of in this list. */
  tab?: 'processes' | 'services' | 'network';
}
interface CatalogResponse { supported: boolean; agentBound: boolean; isOnline: boolean; lastSeenAt: string | null; items: CatalogItem[] }
interface Run {
  id: string; key: string; label: string; status: RunStatus;
  requestedAt: string; deliveredAt: string | null; startedAt: string | null; completedAt: string | null; expiresAt: string;
  requestedBy: { id: string; name: string | null };
  error: string | null; truncated: boolean; resultBytes: number | null;
  result: Record<string, unknown> | null; resultWithheld: boolean;
  /** A snapshot run (0.33): its result is on the workspace tab, not in the history. */
  resultOnTab?: boolean;
}

const TAB_NAME: Record<string, string> = { process_list: 'Processes', service_list: 'Services', network_adapters: 'Network' };

const DURATION: Record<CatalogItem['duration'], string> = { seconds: 'seconds', minute: 'about a minute', minutes: 'several minutes' };

function ago(at: string | null | undefined, now: number): string {
  if (!at) return '—';
  const s = Math.max(0, Math.round((now - new Date(at).getTime()) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
function bytes(n: unknown): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}
const s = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));
const arr = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
const errText = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback;

function StatusPill({ status }: { status: RunStatus }) {
  const map: Record<RunStatus, { label: string; cls: string; icon: React.ReactNode }> = {
    REQUESTED: { label: 'Waiting for the computer', cls: 'bg-muted text-muted-foreground', icon: <Clock className="h-3 w-3" /> },
    DELIVERED: { label: 'Delivered', cls: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200', icon: <Loader2 className="h-3 w-3 animate-spin" /> },
    RUNNING: { label: 'Running', cls: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200', icon: <Loader2 className="h-3 w-3 animate-spin" /> },
    COMPLETED: { label: 'Completed', cls: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200', icon: <CheckCircle2 className="h-3 w-3" /> },
    FAILED: { label: 'Failed', cls: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300', icon: <XCircle className="h-3 w-3" /> },
    EXPIRED: { label: 'Expired', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200', icon: <AlertTriangle className="h-3 w-3" /> },
  };
  const m = map[status];
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${m.cls}`}>{m.icon}{m.label}</span>;
}

/** Requested → delivered → running → done, with the time of each step reached. */
function Steps({ run }: { run: Run }) {
  const end = run.status === 'COMPLETED' ? 'Completed' : run.status === 'FAILED' ? 'Failed' : run.status === 'EXPIRED' ? 'Expired' : 'Done';
  const steps: [string, string | null][] = [
    ['Requested', run.requestedAt], ['Delivered', run.deliveredAt], ['Running', run.startedAt], [end, run.completedAt],
  ];
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
      {steps.map(([label, at], i) => (
        <li key={label} className="flex items-center gap-1">
          <span className={`h-1.5 w-1.5 rounded-full ${at ? (i === 3 && run.status !== 'COMPLETED' ? 'bg-red-500' : 'bg-green-600') : 'bg-muted-foreground/30'}`} />
          <span className={at ? 'text-foreground' : ''}>{label}</span>
          {at && <span className="font-mono">{new Date(at).toLocaleTimeString()}</span>}
          {i < 3 && <span className="text-muted-foreground/50">›</span>}
        </li>
      ))}
    </ol>
  );
}

function Table({ head, rows }: { head: string[]; rows: (string | React.ReactNode)[][] }) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">Nothing to report.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead><tr className="text-left text-muted-foreground">{head.map((h) => <th key={h} className="py-1 pr-3 font-medium">{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i} className="border-t align-top">{r.map((c, j) => <td key={j} className="py-1 pr-3 break-words">{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

const REBOOT_LABEL: Record<string, string> = {
  component_servicing: 'Component servicing (an update or feature install)',
  windows_update: 'Windows Update',
  pending_file_rename: 'Files waiting to be replaced at restart',
  update_agent: 'The Windows Update agent',
};

/** Each catalog key, rendered for a person. Unknown shapes fall back to nothing rather than raw markup. */
function Result({ run }: { run: Run }) {
  const r = run.result ?? {};
  switch (run.key) {
    case 'disk_space':
      return <Table head={['Drive', 'Label', 'File system', 'Size', 'Free', '% free']} rows={arr(r.disks).map((d) => {
        const pct = typeof d.percentFree === 'number' ? d.percentFree : null;
        return [s(d.drive), s(d.label), s(d.fsType), bytes(d.totalBytes), bytes(d.freeBytes),
          pct === null ? '—' : <span className={pct < 10 ? 'text-red-600 font-medium' : pct < 20 ? 'text-amber-600' : ''}>{pct}%</span>];
      })} />;
    case 'service_health':
      return (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">{s(r.totalServices)} services installed.</p>
          <div><h4 className="text-xs font-medium mb-1">Set to start automatically but not running</h4>
            <Table head={['Service', 'Name', 'State', 'Start']} rows={arr(r.stoppedAutomatic).map((v) => [s(v.displayName), <span key="n" className="font-mono">{s(v.name)}</span>, s(v.status), s(v.startType)])} /></div>
          <div><h4 className="text-xs font-medium mb-1">Watched by a monitor</h4>
            <Table head={['Service', 'Name', 'State', 'Start']} rows={arr(r.monitored).map((v) => [s(v.displayName), <span key="n" className="font-mono">{s(v.name)}</span>, s(v.status), s(v.startType)])} /></div>
        </div>
      );
    case 'recent_system_errors':
      return (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Critical and Error events, last 24 hours: {s(r.scanned)} read{r.capped ? ' (capped at 2000 per log)' : ''}, grouped by source and event id.</p>
          <Table head={['Count', 'Log', 'Source', 'Id', 'Last seen', 'Message']} rows={arr(r.groups).map((g) => [
            <span key="c" className="font-mono">{s(g.count)}</span>, s(g.log), s(g.provider), <span key="i" className="font-mono">{s(g.eventId)}</span>,
            <span key="t" title={`First ${formatDate(g.firstAt as string)}`}>{formatDate(g.lastAt as string)}</span>,
            <span key="m" className="whitespace-pre-wrap">{s(g.message)}</span>,
          ])} />
        </div>
      );
    case 'top_processes': {
      const rows = (l: unknown) => arr(l).map((p) => [s(p.name), <span key="p" className="font-mono">{s(p.pid)}</span>, typeof p.cpuSeconds === 'number' ? `${p.cpuSeconds.toFixed(1)} s` : '—', bytes(p.workingSetBytes)]);
      return (
        <div className="grid gap-4 md:grid-cols-2">
          <div><h4 className="text-xs font-medium mb-1">By processor time</h4><Table head={['Process', 'PID', 'CPU', 'Memory']} rows={rows(r.byCpu)} /></div>
          <div><h4 className="text-xs font-medium mb-1">By memory</h4><Table head={['Process', 'PID', 'CPU', 'Memory']} rows={rows(r.byMemory)} /></div>
          <p className="text-xs text-muted-foreground md:col-span-2">{s(r.processCount)} processes running. CPU is total processor time since each process started.</p>
        </div>
      );
    }
    case 'network_connectivity': {
      const t = (r.target ?? {}) as Record<string, unknown>;
      return (
        <div className="space-y-3">
          <p className="text-sm flex items-center gap-2">
            {t.reachable ? <CheckCircle2 className="h-4 w-4 text-green-600" /> : <XCircle className="h-4 w-4 text-red-600" />}
            {t.reachable ? `Reached ${s(t.host)}:${s(t.port)} in ${s(t.latencyMs)} ms` : `Could not reach ${s(t.host)}:${s(t.port)} — ${s(t.error)}`}
          </p>
          <Table head={['Adapter', 'Connection', 'State', 'IPv4', 'IPv6', 'Gateway']} rows={arr(r.adapters).map((a) => [
            s(a.name), s(a.connectionId), <span key="s" className={a.up ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground'}>{s(a.status)}</span>,
            <span key="4" className="font-mono">{arr(a.ipv4).join(', ') || '—'}</span>, <span key="6" className="font-mono">{arr(a.ipv6).join(', ') || '—'}</span>, <span key="g" className="font-mono">{arr(a.gateway).join(', ') || '—'}</span>,
          ])} />
        </div>
      );
    }
    case 'dns_resolution':
      return (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">DNS servers: <span className="font-mono">{arr(r.resolvers).join(', ') || 'none reported'}</span>. Answers may come from the computer&apos;s cache.</p>
          <Table head={['Name', 'Result', 'Addresses', 'Time']} rows={arr(r.lookups).map((l) => [
            <span key="n" className="font-mono">{s(l.name)}</span>, l.ok ? <span key="r" className="text-green-700 dark:text-green-400">Resolved</span> : <span key="r" className="text-red-600">{s(l.error) === '—' ? 'Failed' : s(l.error)}</span>,
            <span key="a" className="font-mono">{arr(l.addresses).join(', ') || '—'}</span>, `${s(l.latencyMs)} ms`,
          ])} />
        </div>
      );
    case 'pending_updates':
      return (
        <div className="space-y-2">
          <p className="text-sm">{s(r.count)} update(s) available{r.rebootRequired ? '; a restart is required' : ''}. The Patches tab has been updated.</p>
          <Table head={['Update', 'KB', 'Severity', 'Size']} rows={arr(r.pending).map((u) => [s(u.title), <span key="k" className="font-mono">{s(u.kb)}</span>, s(u.severity), bytes(u.sizeBytes)])} />
        </div>
      );
    case 'reboot_status':
      return (
        <div className="space-y-1 text-sm">
          <p className="font-medium">{r.pending ? 'A restart is pending.' : 'No restart is pending.'}</p>
          {arr(r.sources).length > 0 && <ul className="list-disc pl-5 text-xs">{(r.sources as string[]).map((x) => <li key={x}>{REBOOT_LABEL[x] ?? x}</li>)}</ul>}
          <p className="text-xs text-muted-foreground">Last boot {formatDate(r.lastBootAt as string)}{typeof r.uptimeSeconds === 'number' ? ` (up ${Math.round(r.uptimeSeconds / 3600)} h)` : ''}.</p>
        </div>
      );
    case 'refresh_inventory':
      return <p className="text-sm">Inventory collected: {s(r.osCaption)} build {s(r.osBuild)}, {s(r.disks)} disk(s), {s(r.networks)} network adapter(s), {s(r.software)} installed program(s). The Specs tab has been updated.</p>;
    default:
      return <p className="text-sm text-muted-foreground">No viewer for this diagnostic.</p>;
  }
}

function RunDetail({ run, now }: { run: Run; now: number }) {
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{run.label}</span>
          <StatusPill status={run.status} />
        </div>
        <span className="text-xs text-muted-foreground">
          Asked by {run.requestedBy.name ?? 'a former user'} {ago(run.requestedAt, now)}
          {run.completedAt && run.status === 'COMPLETED' ? ` · result ${ago(run.completedAt, now)}` : ''}
        </span>
      </div>
      <Steps run={run} />
      {run.status === 'REQUESTED' && <p className="text-xs text-muted-foreground">The computer collects this on its next check-in, normally within three minutes. If it does not check in within fifteen, the request expires.</p>}
      {run.error && <p className="text-xs text-red-600 dark:text-red-400">{run.error}</p>}
      {run.status === 'COMPLETED' && run.resultOnTab && <p className="text-xs text-muted-foreground">The result is on the {TAB_NAME[run.key] ?? 'device'} tab.</p>}
      {run.status === 'COMPLETED' && !run.resultOnTab && (run.resultWithheld
        ? <p className="text-xs text-muted-foreground flex items-center gap-1"><Lock className="h-3 w-3" />The result contains event-log text, which needs the &ldquo;Read event logs&rdquo; permission.</p>
        : <Result run={run} />)}
      {run.truncated && <p className="text-[11px] text-amber-700 dark:text-amber-400">Some lists were shortened to fit the result size limit.</p>}
    </div>
  );
}

export function EndpointDiagnosticsCatalog({ endpointId }: { endpointId: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t); }, []);

  const catalog = useQuery({
    queryKey: ['diagnostics-catalog', endpointId],
    queryFn: () => api.get(`/endpoints/${endpointId}/diagnostics/catalog`).then((r) => r.data?.data as CatalogResponse),
    staleTime: 60_000,
  });
  const runs = useQuery({
    queryKey: ['diagnostics-runs', endpointId],
    queryFn: () => api.get(`/endpoints/${endpointId}/diagnostics/runs`, { params: { limit: 25 } }).then((r) => (r.data?.data ?? []) as Run[]),
    // Polled only while something is still on its way; `false` stops it.
    refetchInterval: (q) => ((q.state.data ?? []).some((r) => OPEN.includes(r.status)) ? 4000 : false),
  });

  const run = useMutation({
    mutationFn: (key: string) => api.post(`/endpoints/${endpointId}/diagnostics/runs`, { key }).then((r) => r.data?.data as { run: Run; deduplicated: boolean }),
    onSuccess: (d) => {
      setSelected(d.run.id);
      if (d.deduplicated) toast({ title: 'Already queued', description: `${d.run.label} is already waiting for this computer.` });
      qc.invalidateQueries({ queryKey: ['diagnostics-runs', endpointId] });
    },
    onError: (e) => toast({ title: 'Could not run the diagnostic', description: errText(e, 'The request was refused.'), variant: 'destructive' }),
  });

  const c = catalog.data;
  const history = runs.data ?? [];
  const latestByKey = new Map<string, Run>();
  for (const r of history) if (!latestByKey.has(r.key)) latestByKey.set(r.key, r);
  const shown = (selected && history.find((r) => r.id === selected)) || null;

  if (catalog.isLoading) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading diagnostics…</div>;
  if (catalog.isError || !c) return <p className="text-sm text-red-600">{errText(catalog.error, 'Diagnostics are not available for this computer.')}</p>;

  const blocked = !c.supported
    ? 'These diagnostics run on Windows computers with the standard agent.'
    : !c.agentBound
      ? 'This computer has never authenticated with a device secret, so it cannot be asked to run anything. Re-run the installer on it once.'
      : null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Stethoscope className="h-4 w-4 text-muted-foreground" />
            Diagnostics
            <Badge variant="outline" className="ml-1 gap-1 font-normal"><ShieldCheck className="h-3 w-3" />Read-only</Badge>
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Fixed checks the agent already carries. Nothing is changed on the computer and no approval is needed; every run is recorded in the audit log.
            {!c.isOnline && c.supported && ` This computer looks offline (last seen ${ago(c.lastSeenAt, now)}); a request waits fifteen minutes for it.`}
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          {blocked && <p className="text-sm text-amber-700 dark:text-amber-400 flex items-center gap-2"><AlertTriangle className="h-4 w-4" />{blocked}</p>}
          <ul className="divide-y">
            {/* Snapshot keys have their own tabs (Processes, Services, Network). */}
            {c.items.filter((item) => !item.tab).map((item) => {
              const last = latestByKey.get(item.key);
              const busy = !!last && OPEN.includes(last.status);
              return (
                <li key={item.key} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{item.label}</span>
                      <span className="text-[11px] text-muted-foreground">takes {DURATION[item.duration]}</span>
                      {item.capability !== 'computers:view' && <span className="text-[11px] text-muted-foreground" title={item.capabilityReason}>needs &ldquo;Read event logs&rdquo;</span>}
                    </div>
                    <p className="text-xs text-muted-foreground">{item.description}</p>
                    {last && (
                      <button type="button" onClick={() => setSelected(last.id)} className="flex items-center gap-2 text-xs hover:underline">
                        <StatusPill status={last.status} />
                        <span className="text-muted-foreground">{last.status === 'COMPLETED' ? `result ${ago(last.completedAt, now)}` : ago(last.requestedAt, now)}</span>
                      </button>
                    )}
                  </div>
                  <Button
                    size="sm" variant="outline" className="shrink-0"
                    disabled={!item.allowed || !!blocked || busy || (run.isPending && run.variables === item.key)}
                    title={!item.allowed ? `Needs ${item.capability}` : undefined}
                    onClick={() => run.mutate(item.key)}
                  >
                    {busy || (run.isPending && run.variables === item.key) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : !item.allowed ? <Lock className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                    <span className="ml-1.5">{busy ? 'Waiting' : 'Run'}</span>
                  </Button>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      {shown && <RunDetail run={shown} now={now} />}

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm">Recent runs</CardTitle></CardHeader>
        <CardContent>
          {history.length === 0
            ? <p className="text-sm text-muted-foreground">No diagnostics have been run on this computer yet.</p>
            : (
              <Table head={['Requested', 'Diagnostic', 'By', 'Status', '']} rows={history.map((r) => [
                <span key="t" title={formatDate(r.requestedAt)}>{ago(r.requestedAt, now)}</span>,
                r.label, r.requestedBy.name ?? '—', <StatusPill key="s" status={r.status} />,
                <button key="v" type="button" className="text-xs text-primary hover:underline" onClick={() => setSelected(r.id)}>{selected === r.id ? 'Shown above' : 'View'}</button>,
              ])} />
            )}
        </CardContent>
      </Card>
    </div>
  );
}
