'use client';

/**
 * One automation schedule (0.58): what it runs, where and when, its approval
 * on the signer, and its history — each window's plans and how each computer
 * did. Pause (immediate, no fresh sign-in), resume and revoke (fresh
 * sign-in), and a revision (a new schedule approved again). There is no
 * approve button: approval happens on the approval signer's own page.
 */
import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Loader2, Pause, Play, ShieldOff } from 'lucide-react';
import { automationApi } from '@/lib/api-client';
import { useAsks } from '@/lib/confirm-policy';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/utils';
import { PageHeader } from '@/components/common/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusBadge, apiMessage, when, type Occurrence } from '@/components/automation/schedule-ui';

type Computer = { endpointId: string; computer: string; status: string; outcome: string | null; reason: string | null; at: string | null };
type Skipped = { endpointId: string; computer: string; why: string };
interface Detail {
  id: string; name: string; businessId: string; status: string; digest: string; approvalUrl: string; direct: boolean;
  approvals: { userId: string; name: string; role: string; at: string }[];
  paused: { at: string; byId: string; reason: string } | null;
  expiresAt: string | null; createdAt: string; revokedAt: string | null; revokeReason: string | null; signerConfirmedRevocation: boolean;
  supersedesId: string | null; supersededAt: string | null; supersededBy: { id: string; name: string; status: string } | null;
  document: { reason: string; createdBy: { name: string }; maxRunsPerOccurrence: number; targets: { kind: 'computers'; computers: { endpointId: string; hostname: string }[] } | { kind: 'group'; groupName: string; maxTargets: number } };
  task: string; schedule: string; offline: string;
  currentRun: Occurrence | null; nextRun: Occurrence | null; upcoming: Occurrence[];
  lastRun: string | null; succeeded: number; failed: number;
  occurrences: { occurrence: string; succeeded: number; failed: number; pending: number; note: { code: string; message: string; skipped: Skipped[]; at: string } | null;
    plans: { attempt: number; jobId: string | null; at: string; message: string; skipped: Skipped[]; jobStatus: string | null; notBefore: string | null; notAfter: string | null; computers: Computer[] }[] }[];
  lastProposal: { ok: boolean; code: string; message: string; at: string } | null;
  signer: { reachable: boolean; status: string | null; signedPlans: number | null; refusals: { at: string; code: string; message: string }[] };
  sweep: { enabled: boolean; everySeconds: number };
  mayManage: boolean;
}
const OUTCOME: Record<string, 'success' | 'destructive' | 'warning' | 'outline'> = { SUCCEEDED: 'success', FAILED: 'destructive', REFUSED_BY_ENDPOINT: 'destructive', NOT_EXECUTED: 'destructive', UNKNOWN: 'warning' };

export default function ScheduleDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const qc = useQueryClient();
  const askChange = useAsks('automation.policy');
  const [why, setWhy] = useState('');
  const [asking, setAsking] = useState<'pause' | 'revoke' | null>(null);
  const { data: d, isLoading, error } = useQuery({
    queryKey: ['automation-schedule', id],
    queryFn: () => automationApi.get(id).then((r) => r.data.data as Detail),
    retry: false,
    refetchInterval: 15_000,
  });
  const done = (title: string) => () => { toast({ title }); setAsking(null); setWhy(''); qc.invalidateQueries({ queryKey: ['automation-schedule', id] }); qc.invalidateQueries({ queryKey: ['automation-schedules'] }); };
  const fail = (e: unknown) => toast({ title: 'Refused', description: apiMessage(e, 'The request was refused.'), variant: 'destructive' });
  const pause = useMutation({ mutationFn: () => automationApi.pause(id, why.trim()), onSuccess: done('Paused'), onError: fail });
  const resume = useMutation({ mutationFn: () => automationApi.resume(id), onSuccess: done('Resumed'), onError: fail });
  const revoke = useMutation({ mutationFn: () => automationApi.revoke(id, why.trim()), onSuccess: done('Revoked'), onError: fail });

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  if (error || !d) return <div className="p-6 text-sm text-destructive" data-testid="schedule-error">{apiMessage(error, 'Could not load this schedule.')} <Link className="underline" href="/automation/schedules">All schedules</Link></div>;
  const live = d.status === 'ACTIVE' || d.status === 'AWAITING_APPROVAL';
  return (
    <div className="space-y-4 p-4 sm:p-6 max-w-5xl" data-testid="schedule-detail" data-schedule-id={d.id}>
      <PageHeader title={d.name} description={`${d.task} · ${d.schedule}`}>
        <StatusBadge status={d.status} paused={!!d.paused} />
      </PageHeader>
      <p className="text-xs"><Link className="underline" href="/automation/schedules">All schedules</Link></p>

      {d.status === 'AWAITING_APPROVAL' && (
        <div className="rounded-md border border-yellow-300 bg-yellow-50 p-3 text-sm dark:border-yellow-800 dark:bg-yellow-950/40" data-testid="schedule-awaiting">
          Nothing runs until two approvers who are not its author{d.task.startsWith('Run') ? ' and did not write the script' : ''} approve it on the approval signer.{' '}
          <a className="underline inline-flex items-center gap-1" href={d.approvalUrl} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-3.5 w-3.5" />Open the approval page</a>
        </div>
      )}
      {d.paused && <p className="rounded-md border p-3 text-sm" data-testid="schedule-paused">Paused {formatDate(d.paused.at)}: {d.paused.reason}. Nothing is asked for until it is resumed.</p>}
      {d.status === 'REVOKED' && <p className="rounded-md border border-destructive/50 p-3 text-sm">Revoked {d.revokedAt ? formatDate(d.revokedAt) : ''}{d.revokeReason ? `: ${d.revokeReason}` : ''}. {d.signerConfirmedRevocation ? 'The approval signer confirmed it.' : 'The approval signer has not confirmed it yet; this server keeps telling it.'}</p>}
      {d.supersededBy && <p className="rounded-md border p-3 text-sm">Revised: <Link className="underline" href={`/automation/schedules/${d.supersededBy.id}`}>{d.supersededBy.name}</Link> ({d.supersededBy.status.toLowerCase().replace(/_/g, ' ')}) replaces this once it is approved.</p>}
      {!d.sweep.enabled && <p className="rounded-md border p-3 text-xs">The automation sweep is off on this server (AUTOMATION_SWEEP=off).</p>}
      {d.lastProposal && !d.lastProposal.ok && live && <p className="rounded-md border p-3 text-xs" data-testid="schedule-last-refusal"><strong>Last time it asked ({formatDate(d.lastProposal.at)}):</strong> {d.lastProposal.message}</p>}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">The schedule</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p><span className="text-muted-foreground">Runs:</span> {d.task}</p>
            <p><span className="text-muted-foreground">On:</span> {d.document.targets.kind === 'computers' ? d.document.targets.computers.map((c) => c.hostname).join(', ') : `the device group "${d.document.targets.groupName}", at most ${d.document.targets.maxTargets} per run (members worked out at each run)`}</p>
            <p><span className="text-muted-foreground">When:</span> {d.schedule}</p>
            <p><span className="text-muted-foreground">Offline:</span> {d.offline}</p>
            <p><span className="text-muted-foreground">Plans per window:</span> {d.document.maxRunsPerOccurrence}; runs never overlap</p>
            <p><span className="text-muted-foreground">Expires:</span> {d.expiresAt ? `${formatDate(d.expiresAt)} (made before 0.63; a revision made now never expires)` : 'never — it runs until it is paused or revoked'}</p>
            <p><span className="text-muted-foreground">Created by:</span> {d.document.createdBy.name}, {formatDate(d.createdAt)} — {d.document.reason}</p>
            <p className="text-xs text-muted-foreground break-all">Digest {d.digest}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Runs</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            {d.currentRun && <p data-testid="schedule-current"><span className="text-muted-foreground">Open now:</span> {when(d.currentRun)}</p>}
            <p data-testid="schedule-next"><span className="text-muted-foreground">Next:</span> {d.nextRun ? when(d.nextRun) : '—'}</p>
            {d.upcoming.length > 1 && <ul className="list-disc pl-5 text-xs text-muted-foreground">{d.upcoming.slice(1).map((o) => <li key={o.start}>{when(o)}</li>)}</ul>}
            <p><span className="text-muted-foreground">Last run:</span> {d.lastRun ? formatDate(d.lastRun) : 'Never'}</p>
            <p data-testid="schedule-counts">{d.succeeded} succeeded · {d.failed} failed</p>
            <p className="text-xs text-muted-foreground">
              {d.direct ? 'Direct mode: active when it was created, with no approvers.' : `Approved by ${d.approvals.map((a) => a.name).join(' and ') || 'nobody yet'}.`}{' '}
              {d.signer.reachable ? `The signer has signed ${d.signer.signedPlans} plan(s) under it.` : 'The approval signer did not answer.'}
            </p>
          </CardContent>
        </Card>
      </div>

      {d.mayManage && (
        <Card>
          <CardHeader><CardTitle className="text-base">Change it</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-2">
              {!d.paused && live && <Button size="sm" variant="outline" onClick={() => setAsking('pause')} data-testid="schedule-pause"><Pause className="h-4 w-4 mr-1" />Pause</Button>}
              {d.paused && live && <Button size="sm" variant="outline" disabled={resume.isPending} onClick={() => resume.mutate()} data-testid="schedule-resume"><Play className="h-4 w-4 mr-1" />Resume{askChange ? ' (confirm it is you)' : ''}</Button>}
              {live && <Button size="sm" variant="outline" asChild><Link href={`/automation/schedules/new?supersedes=${d.id}`}>Revise…</Link></Button>}
              <Button size="sm" variant="destructive" onClick={() => setAsking('revoke')} data-testid="schedule-revoke"><ShieldOff className="h-4 w-4 mr-1" />Revoke</Button>
            </div>
            {asking && (
              <div className="space-y-2 rounded-md border p-3">
                <Label htmlFor="sched-why" className="text-xs">{asking === 'pause' ? 'Why pause it? Undelivered runs are canceled now.' : 'Why revoke it? This is one-way: nothing more is ever signed under it.'}</Label>
                <Input id="sched-why" maxLength={300} value={why} onChange={(e) => setWhy(e.target.value)} data-testid="schedule-why" />
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => setAsking(null)}>Cancel</Button>
                  <Button size="sm" variant={asking === 'revoke' ? 'destructive' : 'default'} disabled={why.trim().length < 3 || pause.isPending || revoke.isPending}
                    onClick={() => (asking === 'pause' ? pause.mutate() : revoke.mutate())} data-testid="schedule-confirm">
                    {(pause.isPending || revoke.isPending) && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
                    {asking === 'pause' ? 'Pause now' : `Revoke${askChange ? ' (confirm it is you)' : ''}`}
                  </Button>
                </div>
              </div>
            )}
            <p className="text-xs text-muted-foreground">Pausing needs no fresh sign-in, because it only stops things. Resuming and revoking do{askChange ? '' : ' when your organisation asks for it'}. Changing what runs, where or when is a revision, approved again on the signer.</p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">History</CardTitle></CardHeader>
        <CardContent>
          {d.occurrences.length === 0 && <p className="text-sm text-muted-foreground" data-testid="schedule-history-empty">No runs yet.</p>}
          <ul className="space-y-3" data-testid="schedule-history">
            {d.occurrences.map((o) => (
              <li key={o.occurrence} className="rounded-md border p-3 text-sm" data-occurrence={o.occurrence}>
                <p className="font-medium">Window from {formatDate(o.occurrence)} <span className="text-xs text-muted-foreground">· {o.succeeded} succeeded, {o.failed} failed{o.pending ? `, ${o.pending} pending` : ''}</span></p>
                {o.note && !o.plans.length && <p className="text-xs text-yellow-700 dark:text-yellow-400">{o.note.message}</p>}
                {o.plans.map((p) => (
                  <div key={p.attempt} className="mt-2 space-y-1">
                    <p className="text-xs text-muted-foreground">Plan {p.attempt}{p.jobId ? <> (<Link className="underline" href={`/automation/tasks`}>{p.jobId.slice(0, 8)}</Link>)</> : ''} · {p.jobStatus?.toLowerCase().replace(/_/g, ' ')} · valid {p.notBefore ? formatDate(p.notBefore) : '—'} to {p.notAfter ? formatDate(p.notAfter) : '—'}</p>
                    <ul className="flex flex-wrap gap-1">
                      {p.computers.map((c) => <li key={c.endpointId}><Badge variant={OUTCOME[c.status] ?? 'outline'} title={c.reason ?? undefined}>{c.computer}: {c.status.toLowerCase().replace(/_/g, ' ')}</Badge></li>)}
                    </ul>
                    {p.skipped.length > 0 && <p className="text-xs text-muted-foreground">Left out: {p.skipped.map((s) => `${s.computer} (${s.why})`).join('; ')}</p>}
                  </div>
                ))}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      {d.signer.refusals.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Refused by the approval signer</CardTitle></CardHeader>
          <CardContent><ul className="space-y-1 text-xs">{d.signer.refusals.slice(-10).reverse().map((r) => <li key={`${r.at}-${r.code}`}>{formatDate(r.at)} · <code>{r.code}</code> — {r.message}</li>)}</ul></CardContent>
        </Card>
      )}
    </div>
  );
}
