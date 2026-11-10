'use client';

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
interface Patches {
  supported: boolean; scannedAt: string | null; scanRequestedAt: string | null; scanPending: boolean; error: string | null;
  managers: { id: string; label: string }[]; autoUpdate: string | null;
  reboot: { pending: boolean; sources: string[] } | null;
  updates: PatchUpdate[]; history: History[];
}

const REBOOT_SOURCE: Record<string, string> = {
  component_servicing: 'Windows servicing', windows_update: 'Windows Update', pending_file_rename: 'pending file replacement', update_agent: 'the update agent',
};
const RESULT: Record<string, 'success' | 'destructive' | 'warning' | 'outline'> = { succeeded: 'success', succeeded_with_errors: 'warning', failed: 'destructive', aborted: 'destructive', in_progress: 'outline', unknown: 'outline' };
const size = (b: number) => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} GB` : `${Math.max(1, Math.round(b / (1 << 20)))} MB`);

export function EndpointPatches({ endpointId }: { endpointId: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: p, isLoading } = useQuery({
    queryKey: ['endpoint-patches', endpointId],
    queryFn: () => patchingApi.endpoint(endpointId).then((r) => r.data.data as Patches),
    refetchInterval: (q) => ((q.state.data as Patches | undefined)?.scanPending ? 20_000 : false),
  });
  const rescan = useMutation({
    mutationFn: () => endpointsApi.refreshInventory(endpointId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['endpoint-patches', endpointId] }); toast({ title: 'Scan requested', description: 'The computer scans at its next check-in and reports back.' }); },
    onError: () => toast({ title: 'Not requested', variant: 'destructive' }),
  });

  if (isLoading || !p) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!p.supported && !p.scannedAt) {
    return (
      <Card><CardContent className="pt-6 text-sm text-muted-foreground">
        This computer&apos;s agent does not report Windows Update posture. It needs the signed agent (update channel <code>signed</code>) from 0.27 or later — see <Link className="underline" href="/docs/staged-patching">Staged patching</Link>.
      </CardContent></Card>
    );
  }
  const installable = p.updates.filter((u) => u.installable);
  return (
    <div className="space-y-4">
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
