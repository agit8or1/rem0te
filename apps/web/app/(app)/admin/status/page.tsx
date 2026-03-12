'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Cpu, HardDrive, MemoryStick, Activity, RefreshCw, Server } from 'lucide-react';
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
    </div>
  );
}
