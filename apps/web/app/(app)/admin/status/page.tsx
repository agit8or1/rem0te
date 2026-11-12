'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Cpu, HardDrive, MemoryStick, Activity, RefreshCw, Server, Archive } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ServiceStatus {
  name: string;
  status: 'active' | 'inactive' | 'failed' | 'unknown';
  pid?: number;
}

interface StatusData {
  uptime: number;
  memory: { total: number; used: number; free: number; percent: number };
  cpu: { loadAvg: [number, number, number]; count: number };
  disk: { total: number; used: number; free: number; percent: number };
  services: ServiceStatus[];
  nodeVersion: string;
  platform: string;
}

interface RetentionTable {
  key: string; table: string; label: string; class: 'evidence' | 'history' | 'transient';
  sweep: 'retention' | 'metrics' | 'support-requests' | 'own-expiry' | 'none';
  rule: string; rows: number; oldest: string | null; oldestNote?: string; windowDays: number | null;
}
interface RetentionData {
  generatedAt: string;
  sweep: {
    enabled: boolean; everySeconds: number; perPassCap: number;
    lastPass: null | { at: string; total: number; counts: Record<string, number>; capped: string[]; ms: number };
    lastError: null | { at: string; message: string };
  };
  metricSweep: boolean;
  tables: RetentionTable[];
}

const CLASS_LABEL: Record<RetentionTable['class'], string> = { evidence: 'Evidence', history: 'History', transient: 'Transient' };
const SWEEP_LABEL: Record<RetentionTable['sweep'], string> = {
  retention: 'Retention sweep', metrics: 'Metric sweep', 'support-requests': 'Support-request sweep', 'own-expiry': 'On expiry', none: 'Never',
};

function windowText(t: RetentionTable) {
  if (t.class === 'evidence') return 'Kept';
  if (t.windowDays === null) return t.sweep === 'own-expiry' ? 'Until it expires' : t.sweep === 'support-requests' ? 'Details erased 30 d after closing' : 'Not pruned';
  return `${t.windowDays} d`;
}

/**
 * Data retention (0.34): what each growing table holds and how long it is
 * kept, from real counts (GET /admin/retention, cached for a minute server
 * side). Platform Admin only, like the rest of this page.
 */
function RetentionCard() {
  const { data, isLoading, refetch, isFetching } = useQuery<RetentionData>({
    queryKey: ['admin-retention'],
    queryFn: () => api.get('/admin/retention').then((r) => r.data?.data),
    refetchInterval: 5 * 60_000,
  });
  const last = data?.sweep.lastPass;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center justify-between gap-2">
          <span className="flex items-center gap-2"><Archive className="h-4 w-4" /> Data retention</span>
          <Button variant="outline" size="sm" onClick={() => api.get('/admin/retention?fresh=1').then(() => refetch())} disabled={isFetching} aria-label="Recount">
            <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading && !data ? <p className="text-sm text-muted-foreground">Counting rows…</p> : !data ? (
          <p className="text-sm text-destructive">Could not load retention status.</p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {data.sweep.enabled
                ? <>The retention sweep runs every {Math.round(data.sweep.everySeconds / 60)} min and removes at most {data.sweep.perPassCap.toLocaleString()} rows per table per pass. </>
                : <>The retention sweep is <strong>off</strong> in this API process (RETENTION_SWEEP=off): nothing below is being pruned. </>}
              {last ? <>Last pass {new Date(last.at).toLocaleString()}: {last.total ? `${last.total.toLocaleString()} rows removed or trimmed` : 'nothing was due'}{last.capped.length ? ` (more due: ${last.capped.join(', ')})` : ''}. </> : data.sweep.enabled ? <>No pass has run since the API started. </> : null}
              {data.sweep.lastError && <span className="text-destructive">Last failure {new Date(data.sweep.lastError.at).toLocaleString()}: {data.sweep.lastError.message}. </span>}
              {!data.metricSweep && <>The metric sweep is off too (METRIC_SWEEP=off). </>}
              The audit log is never pruned. Counted {new Date(data.generatedAt).toLocaleString()}.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b">
                    <th className="py-2 pr-3 font-medium">Data</th><th className="py-2 pr-3 font-medium">Kind</th>
                    <th className="py-2 pr-3 font-medium text-right">Rows</th><th className="py-2 pr-3 font-medium">Oldest</th>
                    <th className="py-2 pr-3 font-medium">Kept</th><th className="py-2 font-medium">Removed by</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {data.tables.map((t) => (
                    <tr key={t.key} data-testid={`retention-${t.key}`} title={t.rule}>
                      <td className="py-2 pr-3"><p className="font-medium">{t.label}</p><p className="text-xs text-muted-foreground font-mono">{t.table}</p></td>
                      <td className="py-2 pr-3"><Badge variant={t.class === 'evidence' ? 'default' : 'secondary'}>{CLASS_LABEL[t.class]}</Badge></td>
                      <td className="py-2 pr-3 text-right tabular-nums">{t.rows.toLocaleString()}</td>
                      <td className="py-2 pr-3 text-xs">{t.oldest ? new Date(t.oldest).toLocaleDateString() : '—'}{t.oldestNote && t.oldest ? <span className="text-muted-foreground"> ({t.oldestNote})</span> : null}</td>
                      <td className="py-2 pr-3 text-xs">{windowText(t)}</td>
                      <td className="py-2 text-xs">{SWEEP_LABEL[t.sweep]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">Hover a row for its rule. Windows are set in the server&apos;s environment (RETENTION_*_DAYS); see the Data retention page in the documentation.</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function fmt(bytes: number) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${(bytes / 1e6).toFixed(0)} MB`;
}

function fmtUptime(seconds: number) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, `${m}m`].filter(Boolean).join(' ');
}

function UsageBar({ percent, color = 'bg-primary' }: { percent: number; color?: string }) {
  const c = percent > 90 ? 'bg-destructive' : percent > 70 ? 'bg-yellow-500' : color;
  return (
    <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
      <div className={`h-full rounded-full transition-all ${c}`} style={{ width: `${Math.min(percent, 100)}%` }} />
    </div>
  );
}

export default function StatusPage() {
  const { data, isLoading, refetch, dataUpdatedAt } = useQuery<StatusData>({
    queryKey: ['admin-status'],
    queryFn: () => api.get('/admin/status').then((r) => r.data?.data),
    refetchInterval: 10000,
  });

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="System Status" description="Server health and service monitoring">
        <div className="flex items-center gap-2">
          {dataUpdatedAt > 0 && (
            <span className="text-xs text-muted-foreground">
              Updated {new Date(dataUpdatedAt).toLocaleTimeString()}
            </span>
          )}
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </PageHeader>

      {isLoading && !data ? (
        <div className="text-muted-foreground text-sm">Loading system stats…</div>
      ) : !data ? (
        <div className="text-destructive text-sm">Failed to load status. Make sure you have platform admin access.</div>
      ) : (
        <div className="space-y-6">
          {/* Overview row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs text-muted-foreground flex items-center gap-1">
                  <Server className="h-3 w-3" /> Uptime
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold">{fmtUptime(data.uptime)}</p>
                <p className="text-xs text-muted-foreground mt-1">{data.platform} · Node {data.nodeVersion}</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs text-muted-foreground flex items-center gap-1">
                  <Cpu className="h-3 w-3" /> CPU Load
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold">{data.cpu.loadAvg[0].toFixed(2)}</p>
                <p className="text-xs text-muted-foreground mt-1">{data.cpu.count} cores · 5m: {data.cpu.loadAvg[1].toFixed(2)}</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs text-muted-foreground flex items-center gap-1">
                  <MemoryStick className="h-3 w-3" /> Memory
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold">{data.memory.percent}%</p>
                <UsageBar percent={data.memory.percent} />
                <p className="text-xs text-muted-foreground mt-1">{fmt(data.memory.used)} / {fmt(data.memory.total)}</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs text-muted-foreground flex items-center gap-1">
                  <HardDrive className="h-3 w-3" /> Disk
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold">{data.disk.percent}%</p>
                <UsageBar percent={data.disk.percent} />
                <p className="text-xs text-muted-foreground mt-1">{fmt(data.disk.used)} / {fmt(data.disk.total)}</p>
              </CardContent>
            </Card>
          </div>

          {/* Services */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <Activity className="h-4 w-4" />
                Services
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="divide-y">
                {data.services.map((svc) => (
                  <div key={svc.name} className="flex items-center justify-between py-3">
                    <div>
                      <p className="text-sm font-medium">{svc.name}</p>
                      {svc.pid && <p className="text-xs text-muted-foreground">PID {svc.pid}</p>}
                    </div>
                    <Badge
                      variant={svc.status === 'active' ? 'default' : svc.status === 'failed' ? 'destructive' : 'secondary'}
                    >
                      {svc.status}
                    </Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      )}
      <RetentionCard />
    </div>
  );
}
