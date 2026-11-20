'use client';

import * as React from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/common/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { msaApi, msaSessionsApi } from '@/lib/api-client';
import { usePermissions, CAP } from '@/lib/auth';
import { formatDate } from '@/lib/utils';
import { apiError } from '@/components/security-controls/shared';
import { useToast } from '@/hooks/use-toast';
import { SessionTimeline, sessionWhat, technicianText, type MsaSession } from '@/components/endpoints/msa-sessions';

/**
 * Devices → Managed sessions (0.73): every live Managed Secure Access session
 * on the computers this person can see, with Disconnect one by one or
 * together. It reads the ungated readiness route first and asks the gated
 * sessions route only when that says `managedControls: true`, so with
 * MSA_GRANTS off this page makes no request to a gated route.
 */
export default function ManagedSessionsPage() {
  const { can } = usePermissions();
  const allowed = can(CAP.COMPUTERS_VIEW);
  const qc = useQueryClient();
  const { toast } = useToast();
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [open, setOpen] = React.useState<string | null>(null);
  const [asking, setAsking] = React.useState<string[] | null>(null);

  const { data: fleet, isLoading: fleetLoading } = useQuery<{ managedControls?: boolean }>({
    queryKey: ['msa-readiness-fleet'],
    queryFn: () => msaApi.fleet().then((r) => r.data?.data),
    enabled: allowed,
  });
  const on = fleet?.managedControls === true;
  const { data, isLoading, isError } = useQuery<{ sessions: MsaSession[]; canRevokeAny: boolean }>({
    queryKey: ['msa-sessions-active'],
    queryFn: () => msaSessionsApi.active().then((r) => r.data?.data),
    enabled: allowed && on,
    refetchInterval: 10_000,
  });
  const sessions = data?.sessions ?? [];
  const revocable = sessions.filter((s) => s.canRevoke);
  const revoke = useMutation({
    mutationFn: (grantIds: string[]) => msaSessionsApi.revoke({ scope: 'sessions', grantIds }).then((r) => r.data?.data as { revoked: number; computers: number }),
    onSuccess: (r) => {
      setAsking(null); setPicked(new Set());
      void qc.invalidateQueries({ queryKey: ['msa-sessions-active'] });
      toast({ title: `Disconnect sent: ${r?.revoked ?? 0} session${r?.revoked === 1 ? '' : 's'}`, description: 'Each computer\'s agent ends its session when the signed revocation reaches it; an offline computer\'s session still ends at its time limit.' });
    },
    onError: (e: unknown) => toast({ title: 'Not disconnected', description: apiError(e).message, variant: 'destructive' }),
  });
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <PageHeader
        title="Managed sessions"
        description="Live Managed Secure Access sessions on the computers you can see: who, what the grant allows, and how far it got. Disconnect ends a session on the computer."
      />
      {!allowed ? <p className="text-sm text-muted-foreground">This page needs the View computers permission.</p>
        : fleetLoading ? <p className="text-sm text-muted-foreground">Loading…</p>
          : !on ? (
            <p className="text-sm text-muted-foreground" data-testid="msa-sessions-off">
              Managed Secure Access is not switched on on this server, so there are no managed sessions.
              See <Link className="underline" href="/endpoints/remote-readiness">Remote access readiness</Link>.
            </p>
          ) : (
            <>
              <p className="rounded-md border border-sky-500/40 bg-sky-500/5 px-3 py-2 text-xs" data-testid="msa-sessions-evidence">
                Managed Secure Access has run only in the Windows lab (Windows Server, as SYSTEM): never on a Windows 10 or 11 desktop or on the fleet.
                A session shown as Launched has had its one-time password handed over; Connected means the computer&apos;s agent saw RustDesk accept a connection.
              </p>
              {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
              {isError && <p className="text-sm text-destructive">Managed sessions could not be loaded.</p>}
              {data && (
                <Card>
                  <CardContent className="p-0">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3 text-sm">
                      <span className="font-medium">Live sessions: {sessions.length}</span>
                      {revocable.length > 0 && (
                        <Button size="sm" variant="outline" disabled={picked.size === 0 || revoke.isPending} onClick={() => setAsking([...picked])} data-testid="msa-sessions-bulk-disconnect">
                          Disconnect selected ({picked.size})
                        </Button>
                      )}
                    </div>
                    {sessions.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No live managed sessions.</p> : (
                      <ul className="divide-y" data-testid="msa-sessions-rows">
                        {sessions.map((s) => (
                          <li key={s.grantId} className="space-y-1.5 p-3 text-xs" data-state={s.state}>
                            <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
                              {s.canRevoke && (
                                <input type="checkbox" className="mt-1" aria-label="Select this session" checked={picked.has(s.grantId)} onChange={() => toggle(s.grantId)} data-testid="msa-session-pick" />
                              )}
                              <div className="min-w-0 flex-1 basis-48">
                                {s.endpoint
                                  ? <Link href={`/endpoints/${s.endpoint.id}`} className="text-sm font-medium hover:underline break-all">{s.endpoint.name}</Link>
                                  : <span className="text-sm font-medium">{s.endpointId}</span>}
                                <p className="text-muted-foreground break-words">{s.endpoint?.businessName ?? ''}{s.endpoint?.businessName ? ' · ' : ''}{technicianText(s)} · {formatDate(s.createdAt)}</p>
                              </div>
                              <div className="min-w-0 flex-[2] basis-64">
                                <p className="font-medium">{s.timeline.status}</p>
                                <p className="text-muted-foreground">{sessionWhat(s)}</p>
                              </div>
                              <div className="flex gap-1.5">
                                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setOpen(open === s.grantId ? null : s.grantId)} aria-expanded={open === s.grantId}>
                                  {open === s.grantId ? 'Hide timeline' : 'Timeline'}
                                </Button>
                                {s.canRevoke && <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setAsking([s.grantId])} data-testid="msa-session-disconnect">Disconnect</Button>}
                              </div>
                            </div>
                            {open === s.grantId && <SessionTimeline s={s} />}
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>
              )}
            </>
          )}
      <Dialog open={!!asking} onOpenChange={(o) => { if (!o) setAsking(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect {asking?.length === 1 ? 'this session' : `${asking?.length ?? 0} sessions`}?</DialogTitle>
            <DialogDescription>Each is revoked now with a signed revocation; the computer&apos;s agent ends the session when it receives it. Nothing can extend a revoked session.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAsking(null)}>Cancel</Button>
            <Button variant="destructive" disabled={revoke.isPending || !asking?.length} onClick={() => asking && revoke.mutate(asking)} data-testid="msa-sessions-disconnect-confirm">Disconnect</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
