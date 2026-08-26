'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { updateApi } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  AlertCircle, AlertTriangle, CheckCircle2, HelpCircle, Loader2, RefreshCw, Server,
} from 'lucide-react';

type ServerStatus = {
  latestVersion: string | null;
  hbbs: string | null;
  hbbr: string | null;
  mismatched: boolean;
  /** null = GitHub unreachable or a binary missing, so genuinely unknown. */
  upToDate: boolean | null;
  /** WebSocket rendezvous over 443 needs 1.1.16. */
  websocketCapable: boolean | null;
};

/**
 * hbbs and hbbr — the rendezvous and relay pair this platform runs.
 *
 * Distinct from the RustDesk client table below it, and from Rem0te's own
 * self-update above. It had no update path at all: install.sh installed the
 * pair once and every later run reported "already installed", so a deployment
 * could sit on an old version indefinitely with nothing surfacing the fact.
 */
export function RustdeskServerUpdate({ isPlatformAdmin }: { isPlatformAdmin: boolean }) {
  const qc = useQueryClient();
  const [msg, setMsg] = useState<string | null>(null);

  const { data, isFetching, refetch } = useQuery({
    queryKey: ['rustdesk-server-update'],
    queryFn: () => updateApi.rustdeskServer().then((r) => r.data?.data as ServerStatus),
    enabled: isPlatformAdmin,
    refetchInterval: 300_000,
  });

  const upgrade = useMutation({
    mutationFn: () => updateApi.updateRustdeskServer(),
    onSuccess: (r) => {
      const d = r.data?.data as { updated: boolean; version: string; message: string };
      setMsg(d.message);
      qc.invalidateQueries({ queryKey: ['rustdesk-server-update'] });
    },
    onError: (e: unknown) => setMsg(e instanceof Error ? e.message : 'Upgrade failed'),
  });

  if (!isPlatformAdmin) return null;

  const canUpgrade = !!data?.latestVersion && (data.upToDate === false || data.mismatched);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Server className="h-4 w-4" /> RustDesk Server
        </CardTitle>
        <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </Button>
      </CardHeader>

      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          The rendezvous (hbbs) and relay (hbbr) services this platform runs — not the client
          installed on an endpoint.
        </p>

        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="hbbs" value={data?.hbbs ?? 'unknown'} />
          <Stat label="hbbr" value={data?.hbbr ?? 'unknown'} />
          <Stat label="Latest release" value={data?.latestVersion ?? 'unavailable'} />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {data?.upToDate === true && (
            <Badge variant="outline" className="gap-1 border-emerald-500/40 text-emerald-600">
              <CheckCircle2 className="h-3 w-3" /> Up to date
            </Badge>
          )}
          {data?.upToDate === false && (
            <Badge variant="outline" className="gap-1 border-amber-500/40 text-amber-600">
              <AlertCircle className="h-3 w-3" /> Update available
            </Badge>
          )}
          {data?.upToDate === null && (
            <Badge variant="outline" className="gap-1 text-muted-foreground">
              <HelpCircle className="h-3 w-3" /> Unknown
            </Badge>
          )}
          {data?.mismatched && (
            <Badge variant="destructive" className="gap-1">
              <AlertTriangle className="h-3 w-3" /> hbbs and hbbr differ
            </Badge>
          )}
          {data?.websocketCapable === false && (
            <Badge variant="outline" className="gap-1 border-amber-500/40 text-amber-600">
              <AlertCircle className="h-3 w-3" /> No WebSocket support
            </Badge>
          )}
        </div>

        {data?.websocketCapable === false && (
          <p className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            Endpoints on networks that only allow port 443 reach this server over{' '}
            <code className="font-mono">/ws/id</code> and <code className="font-mono">/ws/relay</code>.
            Versions before 1.1.16 accept the WebSocket upgrade and then immediately drop the
            connection, so those routes silently do nothing. Upgrading fixes it.
          </p>
        )}

        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-muted-foreground">
          <strong className="text-foreground">Upgrading restarts hbbs and hbbr.</strong> hbbs keeps
          its online-peer map in memory only, so every endpoint reads as offline for roughly 30
          seconds while they re-register. A Connect attempted in that window fails with
          &ldquo;the target device is offline or does not exist&rdquo;. Avoid doing this mid-session.
        </div>

        <div className="flex items-center gap-3">
          <Button onClick={() => upgrade.mutate()} disabled={!canUpgrade || upgrade.isPending}>
            {upgrade.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Upgrading…
              </>
            ) : (
              `Upgrade to ${data?.latestVersion ?? '…'}`
            )}
          </Button>
          {!canUpgrade && data?.upToDate === true && (
            <span className="text-xs text-muted-foreground">Nothing to install.</span>
          )}
        </div>

        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-mono text-sm">{value}</div>
    </div>
  );
}
