'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { actionsApi, patchingApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/utils';
import { ArrowLeft, ExternalLink, Loader2, ShieldCheck } from 'lucide-react';
import { rebootSummary } from '@/components/patching/patch-reboot-choice';
import { DEPLOYMENT_STATUS } from '@/lib/patching';

/**
 * One staged deployment (v0.27): its rings, where every update stands on
 * every computer, and the next step. Requesting a ring creates a signed plan
 * awaiting approval on the approval signer; it is approved there, never here.
 *
 * "Effective" means a scan taken after the install no longer offers the
 * update, Windows' own history records the install, and no restart is
 * pending. It is what the computer reports, not proof a vulnerability is gone.
 */

interface Gate { ok: boolean; reason: string; detail: string; until?: string }
interface Computer {
  endpointId: string; hostname: string | null; inPlan: boolean; status: string | null; statusReason: string | null; outcome: string | null;
  reconciled: string | null; rebootPending: boolean | null; scannedAt: string | null;
  restart: { state: string; reason?: string; scheduledFor?: string } | null;
  updates: { key: string; state: string; detail: string | null }[];
}
interface Ring {
  ring: number; canary: boolean; gate: Gate;
  job: { id: string; status: string; statusReason: string | null; approvalUrl: string; outcome: string | null; window: { notBefore: string; notAfter: string }; digest: string } | null;
  computers: Computer[];
}
interface Deployment {
  id: string; name: string; businessId: string; origin: 'DEPLOYMENT' | 'MANUAL' | 'POLICY'; policyId: string | null; status: string; pausedReason: string | null;
  soakHours: number; failureThreshold: number; windowHours: number; reboot: string; createdAt: string;
  updates: { updateId: string; revision: number; kb: string | null; title: string; className: string | null; severity: string | null }[];
  next: { ring: number | null; canRequest: boolean; why: string };
  rings: Ring[];
}

const RESTART_DEFERRED: Record<string, string> = {
  remote_session_open: 'a RustDesk session was open', session_state_unknown: 'could not tell whether a RustDesk session was open',
  window_closed: 'the window would have closed first', restart_already_scheduled: 'Windows already had a restart pending',
  schedule_failed: 'Windows refused to schedule it', install_uncertain: 'the install outcome is not known', no_maintenance: 'this agent cannot schedule restarts',
};

const STATE: Record<string, { label: string; variant: 'success' | 'destructive' | 'warning' | 'outline' | 'secondary' }> = {
  not_planned: { label: 'not in plan', variant: 'outline' }, awaiting_approval: { label: 'awaiting approval', variant: 'outline' },
  scheduled: { label: 'scheduled', variant: 'secondary' }, delivered: { label: 'delivered', variant: 'secondary' },
  installed: { label: 'installed', variant: 'secondary' }, restart_required: { label: 'restart required', variant: 'warning' },
  effective: { label: 'effective', variant: 'success' }, superseded: { label: 'superseded', variant: 'outline' },
  not_applicable: { label: 'not offered', variant: 'outline' }, excluded: { label: 'excluded', variant: 'outline' },
  failed: { label: 'failed', variant: 'destructive' }, refused: { label: 'refused', variant: 'destructive' },
  not_executed: { label: 'not executed', variant: 'outline' }, unknown: { label: 'unknown', variant: 'destructive' }, canceled: { label: 'canceled', variant: 'outline' },
};
const key = (u: { updateId: string; revision: number }) => `${u.updateId}@${u.revision}`;
function apiMessage(e: unknown, fallback: string) {
  return (e as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message?.toString() ?? fallback;
}

export default function DeploymentPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: d, isLoading } = useQuery({
    queryKey: ['patch-deployment', id],
    queryFn: () => patchingApi.get(id).then((r) => r.data.data as Deployment),
    refetchInterval: (q) => ((q.state.data as Deployment | undefined)?.status === 'ACTIVE' ? 20_000 : false),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['patch-deployment', id] });
  const [reason, setReason] = useState('');
  const [exclude, setExclude] = useState<Record<string, string>>({});
  const [startsIn, setStartsIn] = useState(0);

  const request = useMutation({
    mutationFn: () => patchingApi.requestRing(id, d!.next.ring!, {
      reason: reason.trim(), startsInMinutes: startsIn,
      exclude: Object.entries(exclude).filter(([, why]) => why.trim()).map(([endpointId, why]) => ({ endpointId, why: why.trim() })),
    }),
    onSuccess: (r) => {
      setReason(''); setExclude({}); refresh();
      const url = r.data.data.job?.approvalUrl;
      toast({ title: 'Requested', description: 'Nothing installs until two approvers authorize this ring on the approval page.' });
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
    },
    onError: (e) => toast({ title: 'Not requested', description: apiMessage(e, 'The request was refused.'), variant: 'destructive' }),
  });
  const setStatus = useMutation({
    mutationFn: ({ to, why }: { to: 'pause' | 'resume' | 'cancel'; why: string }) => patchingApi[to](id, why),
    onSuccess: refresh,
    onError: (e) => toast({ title: 'Not changed', description: apiMessage(e, 'Refused.'), variant: 'destructive' }),
  });
  const ask = (to: 'pause' | 'resume' | 'cancel') => {
    const why = window.prompt(`Why ${to} this deployment? (recorded in the audit log)`);
    if (why && why.trim().length >= 3) setStatus.mutate({ to, why: why.trim() });
  };

  if (isLoading || !d) return <p className="p-4 md:p-6 text-sm text-muted-foreground">Loading…</p>;
  const nextRing = d.next.ring !== null ? d.rings[d.next.ring] : null;

  return (
    <div className="space-y-4 p-4 md:p-6">
      <Link href="/patching" className="text-xs text-muted-foreground inline-flex items-center gap-1"><ArrowLeft className="h-3 w-3" />Patching</Link>
      <PageHeader title={d.name} description={`Created ${formatDate(d.createdAt)} · soak ${d.soakHours} h · ${d.failureThreshold} failure${d.failureThreshold === 1 ? '' : 's'} allowed per ring · ${d.windowHours} h window · ${rebootSummary(d.reboot).toLowerCase()}`}>
        <div className="flex gap-2 items-center">
          <Badge variant={DEPLOYMENT_STATUS[d.status] ?? 'outline'}>{d.status.toLowerCase()}</Badge>
          {d.status === 'ACTIVE' && <Button size="sm" variant="outline" onClick={() => ask('pause')}>Pause</Button>}
          {d.status === 'PAUSED' && <Button size="sm" variant="outline" onClick={() => ask('resume')}>Resume</Button>}
          {['ACTIVE', 'PAUSED'].includes(d.status) && <Button size="sm" variant="ghost" onClick={() => ask('cancel')}>Cancel</Button>}
        </div>
      </PageHeader>
      {d.status === 'PAUSED' && d.pausedReason && <p className="text-sm">Paused: {d.pausedReason}</p>}

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm flex items-center gap-2"><ShieldCheck className="h-4 w-4" />Next</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>{d.next.why}</p>
          {d.origin === 'POLICY' && d.policyId && (
            <p className="text-xs text-muted-foreground">
              This deployment belongs to <Link className="underline" href={`/patching/policies/${d.policyId}`}>a patch policy</Link>: its rings are requested by the policy inside its maintenance window and signed by the approval signer only if they fall inside it. Pause or cancel it here, or revoke the policy.
            </p>
          )}
          {d.origin === 'MANUAL' && <p className="text-xs text-muted-foreground">Requested from one computer&apos;s Patches tab: a single canary ring, approved like any other.</p>}
          {d.next.canRequest && nextRing && d.origin !== 'POLICY' && (
            <>
              <p className="text-xs text-muted-foreground">
                Requests {nextRing.canary ? 'the canary' : `ring ${nextRing.ring}`} ({nextRing.computers.length} computer{nextRing.computers.length === 1 ? '' : 's'}) as one signed plan. Two people on the approval roster must approve it with a passkey; you cannot approve your own request. Restart rule: {rebootSummary(d.reboot).toLowerCase()}.
              </p>
              {!nextRing.canary && (
                <div className="space-y-1">
                  <p className="text-xs font-medium">Leave out (optional — say why)</p>
                  {nextRing.computers.map((c) => (
                    <div key={c.endpointId} className="flex items-center gap-2 text-xs">
                      <span className="w-40 truncate">{c.hostname ?? c.endpointId}</span>
                      <Input className="h-8 text-xs" maxLength={200} placeholder="included" value={exclude[c.endpointId] ?? ''} onChange={(e) => setExclude((m) => ({ ...m, [c.endpointId]: e.target.value }))} />
                    </div>
                  ))}
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
                <div className="space-y-1">
                  <Label htmlFor="ring-reason" className="text-xs">Why (shown to the approvers)</Label>
                  <Textarea id="ring-reason" rows={2} maxLength={400} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Patch Tuesday; canary confirmed" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Starts in (minutes)</Label>
                  <Input type="number" min={0} max={1440} value={startsIn} onChange={(e) => setStartsIn(Number(e.target.value))} />
                </div>
              </div>
              <Button size="sm" disabled={reason.trim().length < 3 || request.isPending} onClick={() => request.mutate()}>
                {request.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}Request {nextRing.canary ? 'canary' : `ring ${nextRing.ring}`}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {d.rings.map((r) => <RingCard key={r.ring} r={r} d={d} onChanged={refresh} />)}
    </div>
  );
}

function RingCard({ r, d, onChanged }: { r: Ring; d: Deployment; onChanged: () => void }) {
  return (
    <Card>
      <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0 gap-2 flex-wrap">
        <CardTitle className="text-sm">{r.canary ? 'Ring 0 — canary' : `Ring ${r.ring}`}</CardTitle>
        <div className="flex items-center gap-2 text-xs">
          {r.job && <Badge variant="outline">{r.job.status.toLowerCase().replace(/_/g, ' ')}</Badge>}
          <Badge variant={r.gate.ok ? 'success' : r.gate.reason === 'not_requested' ? 'outline' : 'warning'}>{r.gate.ok ? 'passed' : r.gate.reason.replace(/_/g, ' ')}</Badge>
          {r.job?.status === 'AWAITING_APPROVAL' && (
            <Button size="sm" variant="outline" asChild><a href={r.job.approvalUrl} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-3.5 w-3.5 mr-1" />Approval page</a></Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        {r.job && !r.gate.ok && r.gate.reason !== 'not_requested' && <p>{r.gate.detail}</p>}
        {r.job && <p className="text-muted-foreground">May run {formatDate(r.job.window.notBefore)} – {formatDate(r.job.window.notAfter)} · <span className="font-mono break-all">plan {r.job.digest.slice(0, 16)}…</span></p>}
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 pr-2 font-medium">Computer</th>
                {d.updates.map((u) => <th key={key(u)} className="py-1 pr-2 font-medium" title={u.title}>{u.kb ?? u.title.slice(0, 24)}</th>)}
              </tr>
            </thead>
            <tbody>
              {r.computers.map((c) => (
                <tr key={c.endpointId} className="border-t align-top">
                  <td className="py-1 pr-2">
                    <Link className="underline" href={`/endpoints/${c.endpointId}`}>{c.hostname ?? c.endpointId}</Link>
                    {c.statusReason && <span className="block text-muted-foreground">{c.statusReason.replace(/_/g, ' ')}</span>}
                    {c.rebootPending && <span className="block text-muted-foreground">restart pending</span>}
                    {c.restart?.state === 'scheduled' && <span className="block text-muted-foreground" data-testid="restart-scheduled">restart scheduled for {c.restart.scheduledFor ? formatDate(c.restart.scheduledFor) : 'a time the agent did not report'}</span>}
                    {c.restart?.state === 'restart_deferred' && <span className="block text-muted-foreground" data-testid="restart-deferred">restart deferred: {RESTART_DEFERRED[c.restart.reason ?? ''] ?? c.restart.reason?.replace(/_/g, ' ')}</span>}
                    {c.reconciled && <span className="block text-muted-foreground">reconciled: {c.reconciled}</span>}
                    {r.job && c.status === 'UNKNOWN' && !c.reconciled && <Reconcile jobId={r.job.id} endpointId={c.endpointId} onDone={onChanged} />}
                  </td>
                  {c.updates.map((s) => {
                    const v = STATE[s.state] ?? { label: s.state, variant: 'outline' as const };
                    return <td key={s.key} className="py-1 pr-2"><Badge variant={v.variant} className="text-[10px]" title={s.detail ?? undefined}>{v.label}</Badge>{s.detail && ['failed', 'refused', 'unknown', 'canceled', 'superseded', 'excluded'].includes(s.state) && <span className="block text-muted-foreground max-w-[14rem]">{s.detail}</span>}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function Reconcile({ jobId, endpointId, onDone }: { jobId: string; endpointId: string; onDone: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [found, setFound] = useState<'installed' | 'not_installed' | 'other'>('not_installed');
  const [note, setNote] = useState('');
  const m = useMutation({
    mutationFn: () => actionsApi.reconcile(jobId, { found, note: note.trim(), endpointId }),
    onSuccess: () => { setOpen(false); onDone(); },
    onError: (e) => toast({ title: 'Not recorded', description: apiMessage(e, 'Could not reconcile.'), variant: 'destructive' }),
  });
  if (!open) return <Button size="sm" variant="outline" className="h-6 mt-1 text-[11px]" onClick={() => setOpen(true)}>Reconcile</Button>;
  return (
    <div className="mt-1 space-y-1 rounded-md border border-destructive/40 p-2 max-w-xs">
      <p>Uncertain: the installer did not finish reporting. It will not run again. Check Update history on the computer, then record what you found.</p>
      <div className="flex flex-wrap gap-2">
        {(['installed', 'not_installed', 'other'] as const).map((f) => (
          <label key={f} className="flex items-center gap-1"><input type="radio" checked={found === f} onChange={() => setFound(f)} />{f.replace(/_/g, ' ')}</label>
        ))}
      </div>
      <Textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="How you checked" />
      <Button size="sm" variant="outline" disabled={note.trim().length < 3 || m.isPending} onClick={() => m.mutate()}>Record</Button>
    </div>
  );
}
