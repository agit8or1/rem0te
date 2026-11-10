'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { endpointsApi, patchingApi } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/utils';
import { AlertTriangle, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';

/**
 * Windows Update posture of one computer (v0.27), as its signed agent's
 * `patch-scan` last reported it. Read-only: updates are installed through a
 * staged deployment (canary, then rings), each ring a signed plan approved by
 * people on the approval roster — never from this tab.
 *
 * Everything here is device-reported. It describes what Windows Update told
 * the agent; it does not prove a vulnerability is fixed.
 */

interface PatchUpdate {
  updateId: string; revision: number; kb?: string; title: string; className?: string; severity?: string;
  downloaded: boolean; rebootBehavior: number; sizeBytes: number; installable: boolean; notInstallableBecause: string | null;
}
interface History { updateId: string; revision: number; kb?: string; title: string; result: string; hresult?: string; operation: string; date: string }
/** Built by apps/api/src/patching/summary.ts (0.30). */
interface Summary {
  evidence: { source: 'signed_agent_scan' | 'standard_agent_scan' | 'none'; at: string | null; ageHours: number | null; freshness: 'fresh' | 'stale' | 'none'; lastSuccessfulScanAt: string | null };
  lastBootAt: string | null; restartedSinceLastInstall: boolean | null;
  online: { isOnline: boolean; lastSeenAt: string | null };
  managedBy: { state: 'rem0te_or_windows_update' | 'external' | 'unknown'; managers: { id: string; label: string; explanation: string }[]; explanation: string | null };
  rebootRequired: boolean | null; pendingCount: number; relevantKbs: string[];
  confirmations: { kb: string | null; title: string; state: string; detail: string | null; confirmedByLaterScan: boolean; resultAt: string | null }[];
  deploy: { possible: boolean; reason: string | null };
  warnings: string[];
}
interface Patches {
  summary: Summary;
  supported: boolean; scannedAt: string | null; scanRequestedAt: string | null; scanPending: boolean; error: string | null;
  managers: { id: string; label: string }[]; autoUpdate: string | null;
  reboot: { pending: boolean; sources: string[] } | null;
  updates: PatchUpdate[]; history: History[];
  basic: { checkedAt: string | null; rebootRequired: boolean | null; updates: { title: string; kb: string | null; severity: string | null; sizeBytes: number | null }[] } | null;
}

const REBOOT_SOURCE: Record<string, string> = {
  component_servicing: 'Windows servicing', windows_update: 'Windows Update', pending_file_rename: 'pending file replacement', update_agent: 'the update agent',
};
const RESULT: Record<string, 'success' | 'destructive' | 'warning' | 'outline'> = { succeeded: 'success', succeeded_with_errors: 'warning', failed: 'destructive', aborted: 'destructive', in_progress: 'outline', unknown: 'outline' };
const size = (b: number) => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} GB` : `${Math.max(1, Math.round(b / (1 << 20)))} MB`);

const SOURCE: Record<Summary['evidence']['source'], string> = { signed_agent_scan: 'Signed agent scan', standard_agent_scan: 'Standard agent scan (read-only)', none: 'No scan received' };
const FRESH: Record<Summary['evidence']['freshness'], 'success' | 'warning' | 'outline'> = { fresh: 'success', stale: 'warning', none: 'outline' };
const MANAGED: Record<Summary['managedBy']['state'], string> = { rem0te_or_windows_update: 'Windows Update (rem0te can deploy)', external: 'Managed elsewhere', unknown: 'Unknown' };
const age = (h: number | null) => (h == null ? '' : h < 1 ? 'under an hour old' : h < 48 ? `${Math.round(h)} h old` : `${Math.round(h / 24)} days old`);

/** The evidence first: where it came from, how old it is, and who manages updates here. */
function PatchSummaryCard({ s }: { s: Summary }) {
  const row = (k: string, v: React.ReactNode) => (<div className="flex flex-wrap gap-x-2"><dt className="text-muted-foreground w-44 shrink-0">{k}</dt><dd className="min-w-0">{v}</dd></div>);
  return (
    <Card data-testid="patch-summary">
      <CardHeader className="pb-3"><CardTitle className="text-sm">Patch status</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-xs">
        <dl className="space-y-1.5">
          {row('Evidence', <span className="flex flex-wrap items-center gap-2">{SOURCE[s.evidence.source]}<Badge variant={FRESH[s.evidence.freshness]} className="text-[10px]">{s.evidence.freshness === 'none' ? 'unknown' : s.evidence.freshness}</Badge>{s.evidence.at && <span className="text-muted-foreground">{formatDate(s.evidence.at)} · {age(s.evidence.ageHours)}</span>}</span>)}
          {row('Last successful scan', s.evidence.lastSuccessfulScanAt ? formatDate(s.evidence.lastSuccessfulScanAt) : 'none')}
          {row('Last boot', s.lastBootAt ? formatDate(s.lastBootAt) : 'unknown')}
          {row('Connection', s.online.isOnline ? 'online' : `offline${s.online.lastSeenAt ? ` since ${formatDate(s.online.lastSeenAt)}` : ''}`)}
          {row('Restart pending', s.rebootRequired == null ? 'unknown' : s.rebootRequired ? 'yes' : 'no')}
          {row('Who manages patching', <span>{s.managedBy.state === 'external' ? s.managedBy.managers.map((m) => m.label).join(', ') : MANAGED[s.managedBy.state]}</span>)}
          {row('Relevant KBs', s.relevantKbs.length ? s.relevantKbs.join(', ') : s.evidence.source === 'none' ? 'unknown' : 'none offered')}
          {row('Deploy from rem0te', s.deploy.possible ? 'available' : <span className="text-muted-foreground">{s.deploy.reason}</span>)}
        </dl>
        {s.managedBy.explanation && s.managedBy.state !== 'rem0te_or_windows_update' && (
          <p className="rounded-md border p-2 text-muted-foreground">{s.managedBy.explanation}</p>
        )}
        {s.warnings.filter((w) => w !== s.managedBy.explanation).map((w) => (
          <p key={w} className="flex gap-2"><AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-yellow-600" />{w}</p>
        ))}
        {s.confirmations.length > 0 && (
          <div className="space-y-1">
            <p className="font-medium">Installed by an approved plan</p>
            {s.confirmations.map((c, i) => (
              <div key={`${c.kb ?? c.title}-${i}`} className="flex flex-wrap items-center gap-2">
                <strong>{c.kb ?? c.title}</strong>
                <Badge variant={c.confirmedByLaterScan ? 'success' : c.state === 'failed' ? 'destructive' : 'outline'} className="text-[10px]">
                  {c.confirmedByLaterScan ? 'confirmed by a later scan' : c.state.replace(/_/g, ' ')}
                </Badge>
                {c.detail && <span className="text-muted-foreground">{c.detail}</span>}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function EndpointPatches({ endpointId }: { endpointId: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  // A basic scan has no request marker on the server, so poll for a while after Scan now.
  const [waitUntil, setWaitUntil] = useState(0);
  const { data: p, isLoading } = useQuery({
    queryKey: ['endpoint-patches', endpointId],
    queryFn: () => patchingApi.endpoint(endpointId).then((r) => r.data.data as Patches),
    refetchInterval: (q) => ((q.state.data as Patches | undefined)?.scanPending || Date.now() < waitUntil ? 20_000 : false),
  });
  const rescan = useMutation({
    mutationFn: () => endpointsApi.refreshInventory(endpointId),
    onSuccess: () => { setWaitUntil(Date.now() + 10 * 60_000); qc.invalidateQueries({ queryKey: ['endpoint-patches', endpointId] }); toast({ title: 'Scan requested', description: 'The computer scans at its next check-in and reports back.' }); },
    onError: () => toast({ title: 'Not requested', variant: 'destructive' }),
  });

  if (isLoading || !p) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!p.supported && !p.scannedAt) {
    // Every agent answers the inventory's update scan (every 12 hours, or on
    // Scan now), so there is always something to show. Installing through a
    // deployment is what needs the signed agent — not seeing the updates.
    const b = p.basic;
    return (
      <div className="space-y-4">
        <PatchSummaryCard s={p.summary} />
        <Card>
          <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm flex items-center gap-2"><ShieldCheck className="h-4 w-4" />Windows Update</CardTitle>
            <Button size="sm" variant="outline" disabled={rescan.isPending} onClick={() => rescan.mutate()}>
              {rescan.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1" />}Scan now
            </Button>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="text-xs text-muted-foreground">
              {b?.checkedAt ? `Last scanned ${formatDate(b.checkedAt)}` : 'Not scanned yet — the agent scans automatically within 12 hours of its first check-in.'}
            </p>
            {b?.rebootRequired && (
              <p className="text-xs flex gap-2"><AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-yellow-600" />A restart is pending. Rem0te never restarts a computer.</p>
            )}
            {b?.checkedAt && <p className="text-xs">{b.updates.length === 0 ? 'Windows Update offers nothing.' : `${b.updates.length} update${b.updates.length === 1 ? '' : 's'} offered.`}</p>}
            <p className="text-xs text-muted-foreground">
              Reported by the standard agent. Installing these through a <Link className="underline" href="/patching">patch deployment</Link> needs the signed agent (update channel <code>signed</code>), which runs only plans approved on the roster — see <Link className="underline" href="/docs/staged-patching">Staged patching</Link>.
            </p>
          </CardContent>
        </Card>
        {b && b.updates.length > 0 && (
          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-sm">Offered</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {b.updates.map((u, i) => (
                <div key={`${u.kb ?? ''}-${i}`} className="rounded-md border p-2 text-xs space-y-1">
                  <div className="flex flex-wrap items-center gap-2">{u.kb && <strong>{u.kb}</strong>}<span>{u.title}</span></div>
                  <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                    {u.severity && <Badge variant={u.severity === 'Critical' ? 'destructive' : 'outline'} className="text-[10px]">{u.severity}</Badge>}
                    {u.sizeBytes ? <span>{size(u.sizeBytes)}</span> : null}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>
    );
  }
  const installable = p.updates.filter((u) => u.installable);
  return (
    <div className="space-y-4">
      <PatchSummaryCard s={p.summary} />
      <Card>
        <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm flex items-center gap-2"><ShieldCheck className="h-4 w-4" />Windows Update</CardTitle>
          <Button size="sm" variant="outline" disabled={rescan.isPending || p.scanPending} onClick={() => rescan.mutate()}>
            {rescan.isPending || p.scanPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1" />}
            {p.scanPending ? 'Scan requested' : 'Scan now'}
          </Button>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-xs text-muted-foreground">
            {p.scannedAt ? `Last scanned ${formatDate(p.scannedAt)}` : 'Not scanned yet'} · automatic updates {p.autoUpdate ?? 'unknown'}
          </p>
          {p.error && <p className="text-xs text-destructive">The last scan failed: {p.error}. The lists below may be out of date.</p>}
          {p.managers.length > 0 && (
            <div className="rounded-md border border-yellow-300 bg-yellow-50 dark:border-yellow-800 dark:bg-yellow-950/40 p-3 text-xs flex gap-2">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-yellow-600" />
              <span>Updates on this computer are managed by <strong>{p.managers.map((m) => m.label).join(', ')}</strong>. Rem0te will not install updates here — the computer itself refuses, so the two do not fight over it.</span>
            </div>
          )}
          {p.reboot?.pending && (
            <p className="text-xs flex gap-2"><AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-yellow-600" />A restart is pending ({p.reboot.sources.map((s) => REBOOT_SOURCE[s] ?? s).join(', ')}). Rem0te never restarts a computer; installed updates take effect after someone does.</p>
          )}
          <p className="text-xs">
            {p.updates.length === 0 ? 'Windows Update offers nothing.' : `${p.updates.length} offered, ${installable.length} installable by a deployment.`}{' '}
            <Link className="underline" href="/patching">Patch deployments</Link>
          </p>
        </CardContent>
      </Card>

      {p.updates.length > 0 && (
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-sm">Offered</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {p.updates.map((u) => (
              <div key={`${u.updateId}@${u.revision}`} className="rounded-md border p-2 text-xs space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  {u.kb && <strong>{u.kb}</strong>}
                  <span>{u.title}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                  <Badge variant="outline" className="text-[10px]">{u.className ?? 'Unclassified'}</Badge>
                  {u.severity && <Badge variant={u.severity === 'Critical' ? 'destructive' : 'outline'} className="text-[10px]">{u.severity}</Badge>}
                  <span>{size(u.sizeBytes)}{u.downloaded ? ', downloaded' : ''}{u.rebootBehavior > 0 ? ', may need a restart' : ''}</span>
                  {u.installable ? <Badge variant="success" className="text-[10px]">installable</Badge> : <span>not installable: {u.notInstallableBecause}</span>}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm">Update history (from Windows)</CardTitle></CardHeader>
        <CardContent className="space-y-1 text-xs">
          {p.history.length === 0 ? <p className="text-muted-foreground">None reported.</p> : p.history.map((h, i) => (
            <div key={`${h.updateId}-${h.date}-${i}`} className="flex flex-wrap items-center gap-2">
              <Badge variant={RESULT[h.result] ?? 'outline'} className="text-[10px]">{h.result.replace(/_/g, ' ')}</Badge>
              <span className="text-muted-foreground">{h.date ? formatDate(h.date) : ''}</span>
              <span>{h.operation !== 'install' ? `${h.operation}: ` : ''}{h.kb ? <strong>{h.kb} </strong> : null}{h.title}</span>
              {h.hresult && h.result !== 'succeeded' && <code>{h.hresult}</code>}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
