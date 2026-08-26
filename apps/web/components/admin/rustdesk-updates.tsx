'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { updateApi } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { MonitorDown, RefreshCw, Loader2, CheckCircle2, AlertCircle, HelpCircle } from 'lucide-react';

type Row = {
  endpointId: string | null;
  name: string;
  hostname: string | null;
  platform: string | null;
  isOnline: boolean;
  rustdeskId: string;
  version: string | null;
  updatePending: boolean;
  updateTargetVersion: string | null;
  /** null = the endpoint has never reported a version, so we genuinely do not know. */
  upToDate: boolean | null;
};

type Status = {
  latestVersion: string | null;
  total: number;
  outdated: number;
  unknown: number;
  endpoints: Row[];
};

export function RustdeskUpdates({ isPlatformAdmin }: { isPlatformAdmin: boolean }) {
  const qc = useQueryClient();
  const [msg, setMsg] = useState<string | null>(null);

  const { data, isFetching, refetch } = useQuery({
    queryKey: ['rustdesk-updates'],
    queryFn: () => updateApi.rustdesk().then((r) => r.data?.data as Status),
    enabled: isPlatformAdmin,
    refetchInterval: 60_000,
  });

  const stage = useMutation({
    mutationFn: (endpointIds?: string[]) => updateApi.updateRustdesk(endpointIds),
    onSuccess: (r) => {
      const d = r.data?.data as { requested: number; skipped: number; targetVersion: string };
      setMsg(
        d.requested === 0
          ? `Nothing to do - every selected endpoint is already on v${d.targetVersion}.`
          : `Queued ${d.requested} endpoint${d.requested === 1 ? '' : 's'} for v${d.targetVersion}` +
            (d.skipped ? ` (${d.skipped} already current)` : '') +
            '. Each applies on its next heartbeat, within about 3 minutes.',
      );
      qc.invalidateQueries({ queryKey: ['rustdesk-updates'] });
    },
    onError: (e: unknown) => setMsg(e instanceof Error ? e.message : 'Failed to queue update'),
  });

  const cancel = useMutation({
    mutationFn: (endpointId: string) => updateApi.cancelRustdesk(endpointId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rustdesk-updates'] }),
  });

  if (!isPlatformAdmin) return null;

  const rows = data?.endpoints ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <MonitorDown className="h-4 w-4" />
          RustDesk Client Updates
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="text-sm">
            <span className="text-muted-foreground">Latest release: </span>
            <span className="font-mono font-semibold">
              {data?.latestVersion ? `v${data.latestVersion}` : '-'}
            </span>
            {data && (
              <>
                {data.outdated > 0 ? (
                  <Badge variant="default" className="ml-2 text-xs">{data.outdated} outdated</Badge>
                ) : (
                  <Badge variant="secondary" className="ml-2 text-xs">All current</Badge>
                )}
                {data.unknown > 0 && (
                  <Badge variant="outline" className="ml-2 text-xs">{data.unknown} unknown</Badge>
                )}
              </>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
              {isFetching
                ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
              Check
            </Button>
            <Button
              size="sm"
              onClick={() => { setMsg(null); stage.mutate(undefined); }}
              disabled={stage.isPending || !data?.latestVersion || data.outdated === 0}
            >
              {stage.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
              Update all outdated
            </Button>
          </div>
        </div>

        {msg && (
          <div className="rounded-md border bg-muted/50 p-3 text-xs text-muted-foreground">{msg}</div>
        )}

        {data && data.latestVersion === null && (
          <div className="rounded-md border p-3 text-xs text-muted-foreground">
            Could not reach GitHub to determine the latest RustDesk release, so nothing can be
            staged right now. Endpoint versions below are still accurate.
          </div>
        )}

        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">No enrolled endpoints.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground border-b">
                <tr>
                  <th className="text-left font-medium py-2 pr-3">Computer</th>
                  <th className="text-left font-medium py-2 pr-3">RustDesk</th>
                  <th className="text-left font-medium py-2 pr-3">Status</th>
                  <th className="text-right font-medium py-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.rustdeskId} className="border-b last:border-0">
                    <td className="py-2 pr-3">
                      <div className="font-medium">{r.name}</div>
                      <div className="text-muted-foreground font-mono">{r.rustdeskId}</div>
                    </td>
                    <td className="py-2 pr-3 font-mono">{r.version ? `v${r.version}` : '-'}</td>
                    <td className="py-2 pr-3">
                      {r.updatePending ? (
                        <span className="flex items-center gap-1 text-primary">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Queued to v{r.updateTargetVersion}
                        </span>
                      ) : r.upToDate === true ? (
                        <span className="flex items-center gap-1 text-muted-foreground">
                          <CheckCircle2 className="h-3 w-3" /> Current
                        </span>
                      ) : r.upToDate === false ? (
                        <span className="flex items-center gap-1 text-amber-600 dark:text-amber-500">
                          <AlertCircle className="h-3 w-3" /> Outdated
                        </span>
                      ) : (
                        <span
                          className="flex items-center gap-1 text-muted-foreground"
                          title="This endpoint has not reported a RustDesk version yet"
                        >
                          <HelpCircle className="h-3 w-3" /> Unknown
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      {r.updatePending ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => r.endpointId && cancel.mutate(r.endpointId)}
                          disabled={cancel.isPending}
                        >
                          Cancel
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => { setMsg(null); if (r.endpointId) stage.mutate([r.endpointId]); }}
                          disabled={stage.isPending || !data?.latestVersion || r.upToDate === true}
                        >
                          Update
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-[11px] text-muted-foreground">
          Queued updates are picked up on the endpoint&apos;s next heartbeat (about 3 minutes) and
          applied by re-running the installer. An offline endpoint applies it when it next checks
          in. A queued update clears itself once the endpoint reports the target version, so a
          failed install retries rather than being silently dropped.
        </p>
      </CardContent>
    </Card>
  );
}
