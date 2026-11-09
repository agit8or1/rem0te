'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, KeyRound, PlayCircle, X } from 'lucide-react';
import { securityControlsApi } from '@/lib/api-client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/utils';
import { apiError, Chip, CHIP, type TemporaryAccess } from './shared';

const STATUS_STYLE: Record<string, string> = {
  PENDING: CHIP.warn, APPROVED: CHIP.on, DENIED: CHIP.bad, REVOKED: CHIP.off,
};

function isLive(r: TemporaryAccess) {
  return !!r.activatedAt && !!r.expiresAt && new Date(r.expiresAt) > new Date();
}

/**
 * A technician's own time-limited control for one computer: shown when a
 * connect attempt answered TEMPORARY_GRANT_REQUIRED, or whenever they already
 * have a request for this computer. Request → independent approval →
 * activation (with fresh authentication) → connect. The launch decision
 * re-checks everything, so this card only ever asks.
 */
export function TemporaryAccessCard({
  endpointId, refusal, onDismiss, onConnect,
}: {
  endpointId: string;
  /** The server's TEMPORARY_GRANT_REQUIRED message, verbatim. */
  refusal: string | null;
  onDismiss: () => void;
  onConnect: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState(30);

  const { data: mine = [] } = useQuery<TemporaryAccess[]>({
    queryKey: ['security-controls', 'temporary-access', 'mine'],
    queryFn: () => securityControlsApi.temporaryAccess({ mine: true }).then((r) => r.data?.data ?? []),
    retry: false,
  });
  const here = mine.filter((r) => r.endpointId === endpointId && r.mode === 'CONTROL');
  const open = here.filter((r) => r.status === 'PENDING' || (r.status === 'APPROVED' && (!r.activatedAt || isLive(r))));
  const history = here.filter((r) => !open.includes(r)).slice(0, 5);
  const hasPending = here.some((r) => r.status === 'PENDING');

  const refresh = () => qc.invalidateQueries({ queryKey: ['security-controls', 'temporary-access'] });

  const request = useMutation({
    mutationFn: () => securityControlsApi.requestTemporaryAccess({ endpointId, mode: 'CONTROL', reason: reason.trim(), durationMinutes: minutes }),
    onSuccess: (res) => {
      const d = res.data?.data as TemporaryAccess | undefined;
      toast({
        title: 'Request sent',
        description: `An independent reviewer must approve it. Once approved, activate it here to start the ${d?.durationMinutes ?? minutes} minutes.`,
      });
      setReason('');
      refresh();
    },
    onError: (e) => toast({ title: 'Request not sent', description: apiError(e).message, variant: 'destructive' }),
  });
  const activate = useMutation({
    mutationFn: (id: string) => securityControlsApi.activateTemporaryAccess(id),
    onSuccess: (res) => {
      const d = res.data?.data as TemporaryAccess | undefined;
      toast({ title: 'Temporary control active', description: d?.expiresAt ? `Until ${formatDate(d.expiresAt)}. Connect now.` : undefined });
      onDismiss();
      refresh();
    },
    onError: (e) => toast({ title: 'Not activated', description: apiError(e).message, variant: 'destructive' }),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => securityControlsApi.revokeTemporaryAccess(id),
    onSuccess: () => { toast({ title: 'Request withdrawn' }); refresh(); },
    onError: (e) => toast({ title: 'Not withdrawn', description: apiError(e).message, variant: 'destructive' }),
  });

  if (!refusal && open.length === 0) return null;

  return (
    <Card className="border-sky-300 dark:border-sky-800">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm"><Clock className="h-4 w-4" />Temporary control</CardTitle>
            <CardDescription>
              {refusal ?? 'Interactive control on this computer through a time-limited, independently approved grant.'}
            </CardDescription>
          </div>
          {refusal && open.length === 0 && (
            <Button size="sm" variant="ghost" onClick={onDismiss} aria-label="Dismiss"><X className="h-4 w-4" /></Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {open.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm">
            <Chip className={isLive(r) ? CHIP.on : STATUS_STYLE[r.status] ?? CHIP.off}>
              {isLive(r) ? 'Active' : r.status === 'APPROVED' ? 'Approved — not active yet' : 'Waiting for approval'}
            </Chip>
            <span className="text-muted-foreground">{r.durationMinutes} min · asked {formatDate(r.createdAt)}</span>
            {isLive(r) && <span className="text-muted-foreground">until {formatDate(r.expiresAt)}</span>}
            <span className="min-w-0 flex-1 truncate" title={r.reason}>{r.reason}</span>
            <div className="flex gap-2">
              {r.status === 'APPROVED' && !r.activatedAt && (
                <Button size="sm" onClick={() => activate.mutate(r.id)} disabled={activate.isPending}>
                  <KeyRound className="mr-1.5 h-4 w-4" />Activate
                </Button>
              )}
              {isLive(r) && (
                <Button size="sm" onClick={onConnect}><PlayCircle className="mr-1.5 h-4 w-4" />Connect</Button>
              )}
              <Button size="sm" variant="outline" onClick={() => revoke.mutate(r.id)} disabled={revoke.isPending}>
                {isLive(r) ? 'End now' : 'Withdraw'}
              </Button>
            </div>
          </div>
        ))}

        {refusal && !hasPending && (
          <form
            className="space-y-3"
            onSubmit={(e) => { e.preventDefault(); if (reason.trim().length >= 3) request.mutate(); }}
          >
            <div className="font-medium text-sm">Request temporary control</div>
            <div className="space-y-1.5">
              <Label htmlFor="ta-reason">Reason</Label>
              <Textarea id="ta-reason" rows={2} maxLength={500} placeholder="e.g. Ticket 4521: printer driver reinstall with the user on the phone"
                value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="ta-min">Duration (minutes)</Label>
                <Input id="ta-min" type="number" min={5} max={480} className="w-28"
                  value={minutes} onChange={(e) => setMinutes(parseInt(e.target.value, 10) || 5)} />
              </div>
              <Button type="submit" disabled={reason.trim().length < 3 || request.isPending}>
                {request.isPending ? 'Sending…' : 'Request temporary control'}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Someone other than you must approve it. It does nothing until you activate it here, which needs a fresh
              confirmation that it is you; the duration starts then and is capped by the business&apos;s maximum session length.
            </p>
          </form>
        )}

        {history.length > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">Earlier requests</summary>
            <div className="mt-2 space-y-1">
              {history.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center gap-2 text-muted-foreground">
                  <Chip className={STATUS_STYLE[r.status] ?? CHIP.off}>{r.activatedAt && r.status === 'APPROVED' ? 'Expired' : r.status.toLowerCase()}</Chip>
                  <span>{formatDate(r.createdAt)}</span>
                  <span className="truncate">{r.reason}</span>
                  {r.decisionNote && <span>· {r.decisionNote}</span>}
                </div>
              ))}
            </div>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
