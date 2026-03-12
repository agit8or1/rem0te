'use client';

import { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { adminApi, updateApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  Shield, Server, Package, Cpu, HardDrive, MemoryStick,
  ExternalLink, CheckCircle2, XCircle, RefreshCw, ArrowUpCircle,
  GitBranch, Loader2, Dog,
} from 'lucide-react';

function bytes(n: number) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function uptime(seconds: number) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, `${m}m`].filter(Boolean).join(' ');
}

interface ServiceStatus { name: string; unit: string; status: string; pid?: number; }
interface StatusData {
  platform?: string; nodeVersion?: string; uptime?: number;
  cpu?: { count: number; loadAvg: [number, number, number] };
  memory?: { total: number; used: number; free: number; percent: number };
  disk?: { total: number; used: number; free: number; percent: number };
  services?: ServiceStatus[];
}
interface UpdateInfo {
  currentVersion: string; latestVersion: string; hasUpdate: boolean;
  releaseUrl: string | null; releaseNotes: string | null; publishedAt: string | null;
}
interface UpdateProgress { step: string; message: string; percent: number; done?: boolean; error?: string; }
interface ChangelogEntry { version: string; notes: string; publishedAt: string; }

// ─── Update Panel ─────────────────────────────────────────────────────────────

function UpdatePanel({ isPlatformAdmin }: { isPlatformAdmin: boolean }) {
  const [checking, setChecking] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updating, setUpdating] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress[]>([]);
  const [done, setDone] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const { data: versionData } = useQuery({
    queryKey: ['app-version'],
    queryFn: () => updateApi.version().then((r) => r.data?.data as { version: string }),
    enabled: isPlatformAdmin,
  });

  async function checkForUpdate() {
    setChecking(true);
    setUpdateInfo(null);
    try {
      const res = await updateApi.check();
      setUpdateInfo(res.data?.data as UpdateInfo);
    } finally {
      setChecking(false);
    }
  }

  function startUpdate() {
    if (updating) return;
    setUpdating(true);
    setDone(false);
    setProgress([]);

    const url = updateApi.progressUrl();
    const es = new EventSource(url + `?t=${Date.now()}`);
    es.onmessage = (e) => {
      try {
        const p = JSON.parse(e.data) as UpdateProgress;
        setProgress((prev) => [...prev, p]);
        if (p.done) {
          es.close();
          setUpdating(false);
          setDone(true);
        }
      } catch { /* ignore */ }
    };
    es.onerror = () => {
      es.close();
      setUpdating(false);
      setProgress((prev) => [...prev, { step: 'error', message: 'Connection lost', percent: 0, error: 'Connection lost', done: true }]);
    };
  }

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [progress]);

  if (!isPlatformAdmin) return null;

  const lastProgress = progress[progress.length - 1];
  const currentPct = lastProgress?.percent ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <ArrowUpCircle className="h-4 w-4" />
          Software Update
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="text-sm">
            <span className="text-muted-foreground">Current version: </span>
            <span className="font-mono font-semibold">v{versionData?.version ?? '…'}</span>
            {updateInfo && (
              <>
                {updateInfo.hasUpdate ? (
                  <Badge variant="default" className="ml-2 text-xs">Update available: v{updateInfo.latestVersion}</Badge>
                ) : (
                  <Badge variant="secondary" className="ml-2 text-xs">Up to date</Badge>
                )}
              </>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={checkForUpdate}
            disabled={checking || updating}
          >
            {checking
              ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
              : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
            Check for update
          </Button>
        </div>

        {updateInfo?.hasUpdate && !updating && !done && (
          <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium">v{updateInfo.latestVersion} is available</p>
                {updateInfo.publishedAt && (
                  <p className="text-xs text-muted-foreground">
                    Released {new Date(updateInfo.publishedAt).toLocaleDateString()}
                  </p>
                )}
              </div>
              {updateInfo.releaseUrl && (
                <a href={updateInfo.releaseUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
                  <ExternalLink className="h-3 w-3" /> Release notes
                </a>
              )}
            </div>
            {updateInfo.releaseNotes && (
              <pre className="text-xs text-muted-foreground bg-muted rounded p-2 whitespace-pre-wrap max-h-32 overflow-y-auto">
                {updateInfo.releaseNotes.slice(0, 600)}
              </pre>
            )}
            <Button onClick={startUpdate} size="sm">
              <ArrowUpCircle className="h-3.5 w-3.5 mr-1.5" />
              Apply Update
            </Button>
          </div>
        )}

        {updating && (
          <div className="space-y-2">
            <Progress value={currentPct} className="h-2" />
            <p className="text-xs text-muted-foreground">
              {lastProgress?.message ?? 'Starting…'} ({currentPct}%)
            </p>
          </div>
        )}

        {progress.length > 0 && (
          <div
            ref={logRef}
            className="rounded bg-black/90 p-3 text-xs font-mono text-green-400 max-h-48 overflow-y-auto space-y-0.5"
          >
            {progress.map((p, i) => (
              <div key={i} className={p.error ? 'text-red-400' : p.done ? 'text-green-300 font-semibold' : ''}>
                [{p.step}] {p.message}
              </div>
            ))}
          </div>
        )}

        {done && !lastProgress?.error && (
          <div className="rounded-lg border border-green-300 bg-green-50 dark:border-green-800 dark:bg-green-950/30 p-3 text-sm text-green-800 dark:text-green-200">
            Update applied successfully. The page will reload in 5 seconds…
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Changelog Panel ──────────────────────────────────────────────────────────

function ChangelogPanel({ isPlatformAdmin }: { isPlatformAdmin: boolean }) {
  const { data, isLoading } = useQuery({
    queryKey: ['changelog'],
    queryFn: () => updateApi.changelog().then((r) => r.data?.data as ChangelogEntry[]),
    enabled: isPlatformAdmin,
  });

  if (!isPlatformAdmin) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <GitBranch className="h-4 w-4" />
          Release History
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !data?.length ? (
          <p className="text-sm text-muted-foreground">No releases found on GitHub yet.</p>
        ) : (
          <div className="space-y-4">
            {data.map((release) => (
              <div key={release.version} className="border-l-2 border-primary/30 pl-4 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono font-semibold text-sm">v{release.version}</span>
                  {release.publishedAt && (
                    <span className="text-xs text-muted-foreground">
                      {new Date(release.publishedAt).toLocaleDateString()}
                    </span>
                  )}
                </div>
                {release.notes && (
                  <pre className="text-xs text-muted-foreground whitespace-pre-wrap">{release.notes.slice(0, 400)}</pre>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── About Page ───────────────────────────────────────────────────────────────

export default function AboutPage() {
  const { data: meData } = useQuery({
    queryKey: ['me'],
    queryFn: () => import('@/lib/api-client').then((m) => m.authApi.me().then((r) => r.data?.data)),
  });
  const isPlatformAdmin = !!(meData as Record<string, unknown> | undefined)?.isPlatformAdmin;

  const { data } = useQuery({
    queryKey: ['admin-status'],
    queryFn: () => adminApi.status().then((r) => r.data?.data as StatusData | undefined),
    refetchInterval: 60_000,
  });

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <PageHeader title="About" description="System information, versions, and updates" />

      {/* App identity */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Shield className="h-4 w-4 text-primary" />
            Rem0te
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-y-3 text-sm">
            <span className="text-muted-foreground">Platform</span>
            <span className="font-mono text-xs">{data?.platform ?? '…'}</span>

            <span className="text-muted-foreground">Node.js</span>
            <span className="font-mono text-xs">{data?.nodeVersion ?? '…'}</span>

            <span className="text-muted-foreground">Server Uptime</span>
            <span className="font-mono text-xs">{data?.uptime ? uptime(data.uptime) : '…'}</span>
          </div>

          <div className="pt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
            <a href="https://mspreboot.com" target="_blank" rel="noopener noreferrer"
               className="flex items-center gap-1 underline hover:text-foreground">
              <ExternalLink className="h-3 w-3" /> mspreboot.com
            </a>
            <a href="https://github.com/agit8or1/rem0te" target="_blank" rel="noopener noreferrer"
               className="flex items-center gap-1 underline hover:text-foreground">
              <ExternalLink className="h-3 w-3" /> GitHub
            </a>
            <a href="https://github.com/agit8or1/rem0te/discussions" target="_blank" rel="noopener noreferrer"
               className="flex items-center gap-1 underline hover:text-foreground">
              <ExternalLink className="h-3 w-3" /> Discussions
            </a>
            <a href="https://github.com/agit8or1/rem0te/issues" target="_blank" rel="noopener noreferrer"
               className="flex items-center gap-1 underline hover:text-foreground">
              <ExternalLink className="h-3 w-3" /> Issues
            </a>
            <a href="https://github.com/rustdesk/rustdesk" target="_blank" rel="noopener noreferrer"
               className="flex items-center gap-1 underline hover:text-foreground">
              <ExternalLink className="h-3 w-3" /> RustDesk
            </a>
          </div>

        </CardContent>
      </Card>

      {/* Update panel — platform admin only */}
      <UpdatePanel isPlatformAdmin={isPlatformAdmin} />

      {/* System resources */}
      {data && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs text-muted-foreground flex items-center gap-1">
                <Cpu className="h-3 w-3" /> CPU
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              <p className="text-sm font-semibold">{data.cpu ? `${data.cpu.count} core(s)` : '—'}</p>
              {data.cpu && <p className="text-xs text-muted-foreground">Load: {data.cpu.loadAvg.map((v) => v.toFixed(2)).join(' / ')}</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs text-muted-foreground flex items-center gap-1">
                <MemoryStick className="h-3 w-3" /> Memory
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {data.memory ? (
                <>
                  <p className="text-sm font-semibold">{data.memory.percent}% used</p>
                  <p className="text-xs text-muted-foreground">{bytes(data.memory.used)} / {bytes(data.memory.total)}</p>
                </>
              ) : <p className="text-sm text-muted-foreground">—</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs text-muted-foreground flex items-center gap-1">
                <HardDrive className="h-3 w-3" /> Disk (/)
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {data.disk ? (
                <>
                  <p className="text-sm font-semibold">{data.disk.percent}% used</p>
                  <p className="text-xs text-muted-foreground">{bytes(data.disk.used)} / {bytes(data.disk.total)}</p>
                </>
              ) : <p className="text-sm text-muted-foreground">—</p>}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Services */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Server className="h-4 w-4" /> Services
          </CardTitle>
        </CardHeader>
        <CardContent>
          {data?.services ? (
            <div className="divide-y">
              {data.services.map((svc) => (
                <div key={svc.unit} className="py-2.5 flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium">{svc.name}</p>
                    <p className="text-xs text-muted-foreground font-mono">{svc.unit}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {svc.status === 'active'
                      ? <CheckCircle2 className="h-4 w-4 text-green-500" />
                      : <XCircle className="h-4 w-4 text-red-500" />}
                    <Badge variant={svc.status === 'active' ? 'default' : 'destructive'} className="text-xs">
                      {svc.status}
                    </Badge>
                    {svc.pid && <span className="text-xs text-muted-foreground font-mono">PID {svc.pid}</span>}
                  </div>
                </div>
              ))}
            </div>
          ) : <p className="text-sm text-muted-foreground">Loading…</p>}
        </CardContent>
      </Card>

      {/* Tech stack */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Package className="h-4 w-4" /> Technology Stack
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
            {[
              { label: 'Frontend', value: 'Next.js 14' },
              { label: 'Backend', value: 'NestJS' },
              { label: 'Database', value: 'PostgreSQL + Prisma' },
              { label: 'Cache', value: 'Redis' },
              { label: 'Remote Desktop', value: 'RustDesk' },
              { label: 'Proxy', value: 'Caddy (HTTPS)' },
            ].map(({ label, value }) => (
              <div key={label} className="rounded border bg-muted/30 p-2.5 space-y-0.5">
                <p className="text-muted-foreground">{label}</p>
                <p className="font-medium">{value}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Changelog */}
      <ChangelogPanel isPlatformAdmin={isPlatformAdmin} />

      {/* Luna */}
      <p className="text-center text-xs text-muted-foreground flex items-center justify-center gap-1.5">
        <Dog className="h-3.5 w-3.5" />
        Rem0te — managed by Luna 🐾 a very good German Shepherd Dog
      </p>
    </div>
  );
}
