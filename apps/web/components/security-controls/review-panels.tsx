'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import { securityControlsApi } from '@/lib/api-client';
import { useCurrentUser } from '@/lib/auth';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/utils';
import {
  apiError, Chip, CHIP, decisionError, JsonBlock, personName, usePeople,
  type TemporaryAccess, type TrustChange,
} from './shared';

const KIND_LABEL: Record<string, string> = {
  access_policy: 'Platform access policy',
  preset: 'Technician preset',
  platform_permissions: 'Platform permissions',
  device_class: 'Device class',
  managed_workstation: 'Managed admin workstation',
};

const MODE_LABEL: Record<string, string> = {
  CONTROL: 'Interactive control',
  ELEVATION: 'Elevation',
  PROTECTED_EXCEPTION: 'Protected-computer exception',
};

function useNames() {
  const { data: people = [] } = usePeople();
  return useMemo(() => {
    const m = new Map(people.map((p) => [p.id, personName(p)]));
    return (id: string | null | undefined) => (id ? m.get(id) ?? id : '—');
  }, [people]);
}

// ─── Reviews ─────────────────────────────────────────────────────────────────

export function ReviewsPanel() {
  const { data: me } = useCurrentUser();
  const name = useNames();
  const qc = useQueryClient();
  const { toast } = useToast();

  const trust = useQuery<TrustChange[]>({
    queryKey: ['security-controls', 'trust-changes', 'PENDING'],
    queryFn: () => securityControlsApi.trustChanges('PENDING').then((r) => r.data?.data ?? []),
    retry: false,
  });
  const temporary = useQuery<TemporaryAccess[]>({
    queryKey: ['security-controls', 'temporary-access', 'PENDING'],
    queryFn: () => securityControlsApi.temporaryAccess({ status: 'PENDING' }).then((r) => r.data?.data ?? []),
    retry: false,
  });

  const decideTrust = useMutation({
    mutationFn: (v: { id: string; decision: 'APPROVE' | 'DENY' }) => securityControlsApi.decideTrustChange(v.id, v.decision),
    onSuccess: (_r, v) => {
      toast({ title: v.decision === 'APPROVE' ? 'Approved and applied' : 'Denied' });
      qc.invalidateQueries({ queryKey: ['security-controls'] });
    },
    onError: (e) => toast({ title: 'Not decided', description: decisionError(e), variant: 'destructive' }),
  });
  const decideTemp = useMutation({
    mutationFn: (v: { id: string; decision: 'APPROVE' | 'DENY' }) => securityControlsApi.decideTemporaryAccess(v.id, v.decision),
    onSuccess: (_r, v) => {
      toast({
        title: v.decision === 'APPROVE' ? 'Approved' : 'Denied',
        description: v.decision === 'APPROVE' ? 'The technician must still activate it, with fresh authentication, before it does anything.' : undefined,
      });
      qc.invalidateQueries({ queryKey: ['security-controls'] });
    },
    onError: (e) => toast({ title: 'Not decided', description: decisionError(e), variant: 'destructive' }),
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Independent review: whoever asked for a change can never approve it. Each decision needs a fresh confirmation that it is you.
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Trust changes</CardTitle>
          <CardDescription>Changes that widen what someone may do, held until another reviewer decides.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {trust.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {trust.isError && <p className="text-sm text-destructive">{apiError(trust.error).message}</p>}
          {trust.data?.length === 0 && <p className="text-sm text-muted-foreground">Nothing waiting for review.</p>}
          {trust.data?.map((t) => {
            const mine = t.requestedById === me?.id;
            return (
              <div key={t.id} className="space-y-2 rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{KIND_LABEL[t.kind] ?? t.kind}</span>
                  <span className="font-mono text-xs text-muted-foreground">{t.target}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    Requested by {name(t.requestedById)} · {formatDate(t.createdAt)}
                  </span>
                </div>
                {t.widening.length > 0 && (
                  <ul className="list-disc pl-5 text-xs">{t.widening.map((w) => <li key={w} className="font-mono">{w}</li>)}</ul>
                )}
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">Before and after</summary>
                  <div className="mt-2 grid gap-2 md:grid-cols-2">
                    <div><div className="mb-1 font-medium">Before</div><JsonBlock value={t.before} /></div>
                    <div><div className="mb-1 font-medium">After</div><JsonBlock value={t.after} /></div>
                  </div>
                </details>
                <DecisionButtons
                  mine={mine} pending={decideTrust.isPending}
                  onDecide={(decision) => decideTrust.mutate({ id: t.id, decision })}
                />
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Temporary access requests</CardTitle>
          <CardDescription>
            Time-limited control asked for by a technician on one computer. Approval alone grants nothing: the technician
            activates it with fresh authentication, which starts the clock.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {temporary.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {temporary.isError && <p className="text-sm text-destructive">{apiError(temporary.error).message}</p>}
          {temporary.data?.length === 0 && <p className="text-sm text-muted-foreground">No pending requests.</p>}
          {temporary.data?.map((r) => (
            <div key={r.id} className="space-y-2 rounded-md border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{name(r.userId)}</span>
                <Chip className={r.mode === 'PROTECTED_EXCEPTION' ? CHIP.bad : CHIP.request}>{MODE_LABEL[r.mode] ?? r.mode}</Chip>
                <span className="text-xs text-muted-foreground">{r.durationMinutes} min</span>
                <Link href={`/endpoints/${r.endpointId}`} className="font-mono text-xs underline-offset-2 hover:underline">{r.endpointId}</Link>
                <span className="ml-auto text-xs text-muted-foreground">{formatDate(r.createdAt)}</span>
              </div>
              <p className="text-sm">{r.reason}</p>
              <DecisionButtons
                mine={r.userId === me?.id} pending={decideTemp.isPending}
                onDecide={(decision) => decideTemp.mutate({ id: r.id, decision })}
              />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function DecisionButtons({ mine, pending, onDecide }: { mine: boolean; pending: boolean; onDecide: (d: 'APPROVE' | 'DENY') => void }) {
  if (mine) {
    return <p className="text-xs text-muted-foreground">You requested this, so someone else must decide it.</p>;
  }
  return (
    <div className="flex gap-2">
      <Button size="sm" onClick={() => onDecide('APPROVE')} disabled={pending}><Check className="mr-1.5 h-4 w-4" />Approve</Button>
      <Button size="sm" variant="outline" onClick={() => onDecide('DENY')} disabled={pending}><X className="mr-1.5 h-4 w-4" />Deny</Button>
    </div>
  );
}

// ─── Pauses and alerts ───────────────────────────────────────────────────────

interface Pause { id: string; identity: string; reason: string; details: unknown; createdAt: string; clearedAt: string | null }
interface Alert {
  id: string; kind: string; identity: string | null; customerId: string | null; details: unknown;
  suppressed: boolean; delivered: boolean; deliveryError: string | null; createdAt: string;
}
interface Suppression { id: string; identity: string | null; kind: string; reason: string; until: string; createdById: string }

export function PausesAlertsPanel() {
  const name = useNames();
  const identityName = (i: string | null) => (i?.startsWith('user:') ? name(i.slice(5)) : i ?? '—');
  const qc = useQueryClient();
  const { toast } = useToast();

  const pauses = useQuery<Pause[]>({
    queryKey: ['security-controls', 'pauses'],
    queryFn: () => securityControlsApi.pauses().then((r) => r.data?.data ?? []),
    retry: false,
  });
  const alerts = useQuery<{ alerts: Alert[]; suppressions: Suppression[] }>({
    queryKey: ['security-controls', 'alerts'],
    queryFn: () => securityControlsApi.alerts().then((r) => r.data?.data),
    retry: false,
  });

  const clear = useMutation({
    mutationFn: (id: string) => securityControlsApi.clearPause(id),
    onSuccess: () => {
      toast({ title: 'Pause cleared', description: 'Privileged work for that identity is allowed again, within its limits.' });
      qc.invalidateQueries({ queryKey: ['security-controls'] });
    },
    onError: (e) => toast({ title: 'Not cleared', description: decisionError(e), variant: 'destructive' }),
  });

  const active = (pauses.data ?? []).filter((p) => !p.clearedAt);
  const past = (pauses.data ?? []).filter((p) => p.clearedAt);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        When an identity reaches an activity limit its privileged work is paused and the alert contacts are told. Only someone
        other than that identity can clear the pause. Suppressing an alert only silences its delivery: it never lifts a pause.
      </p>

      <Card>
        <CardHeader><CardTitle className="text-sm">Paused identities</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {pauses.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {pauses.isError && <p className="text-sm text-destructive">{apiError(pauses.error).message}</p>}
          {pauses.data && active.length === 0 && <p className="text-sm text-muted-foreground">Nobody is paused.</p>}
          {active.map((p) => (
            <div key={p.id} className="flex flex-wrap items-start gap-3 rounded-md border border-red-200 p-3 text-sm dark:border-red-900">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{identityName(p.identity)}</span>
                  <Chip className={CHIP.bad}>Paused</Chip>
                  <span className="text-xs text-muted-foreground">{formatDate(p.createdAt)}</span>
                </div>
                <p>{p.reason}</p>
                {p.details != null && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground">Details</summary>
                    <JsonBlock value={p.details} />
                  </details>
                )}
              </div>
              <Button size="sm" variant="outline" onClick={() => clear.mutate(p.id)} disabled={clear.isPending}>Clear</Button>
            </div>
          ))}
          {past.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-xs text-muted-foreground">{past.length} cleared</summary>
              <div className="mt-2 space-y-1">
                {past.map((p) => (
                  <div key={p.id} className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{identityName(p.identity)}</span>
                    <span>{p.reason}</span>
                    <span>· paused {formatDate(p.createdAt)} · cleared {formatDate(p.clearedAt)}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">Security alerts</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {alerts.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {alerts.isError && <p className="text-sm text-destructive">{apiError(alerts.error).message}</p>}
          {(alerts.data?.suppressions.length ?? 0) > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              <div className="mb-1 font-medium">Active suppressions (delivery only; pauses still apply)</div>
              {alerts.data!.suppressions.map((s) => (
                <div key={s.id}>{s.kind} · {s.identity ? identityName(s.identity) : 'everyone'} · until {formatDate(s.until)} · {s.reason}</div>
              ))}
            </div>
          )}
          {alerts.data?.alerts.length === 0 && <p className="text-sm text-muted-foreground">No alerts.</p>}
          {(alerts.data?.alerts.length ?? 0) > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">When</th>
                    <th className="px-2 py-2 font-medium">Kind</th>
                    <th className="px-2 py-2 font-medium">Identity</th>
                    <th className="px-2 py-2 font-medium">Delivery</th>
                    <th className="px-2 py-2 font-medium">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {alerts.data!.alerts.map((a) => (
                    <tr key={a.id} className="border-b align-top last:border-0">
                      <td className="whitespace-nowrap py-2 pr-3 text-xs">{formatDate(a.createdAt)}</td>
                      <td className="px-2 py-2 font-mono text-xs">{a.kind}</td>
                      <td className="px-2 py-2 text-xs">{identityName(a.identity)}</td>
                      <td className="px-2 py-2">
                        {a.suppressed ? <Chip className={CHIP.warn}>Suppressed</Chip>
                          : a.delivered ? <Chip className={CHIP.on}>Delivered</Chip>
                          : <Chip className={CHIP.bad} title={a.deliveryError ?? undefined}>Not delivered</Chip>}
                        {!a.delivered && a.deliveryError && <div className="mt-1 text-xs text-muted-foreground">{a.deliveryError}</div>}
                      </td>
                      <td className="px-2 py-2">
                        <details className="text-xs">
                          <summary className="cursor-pointer text-muted-foreground">Show</summary>
                          <JsonBlock value={a.details} />
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
