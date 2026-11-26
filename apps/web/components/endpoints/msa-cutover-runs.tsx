'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { automationApi, businessesApi, msaCutoverRunsApi } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiError } from '@/components/security-controls/shared';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/utils';

/**
 * Managed Secure Access cutover runs (0.73): a device group or a business,
 * canary first. The canary goes through the ordinary per-computer path (a
 * managed test session, then Confirm verified on its own page) and must be
 * Managed and verified before Advance moves anyone else; each Advance moves
 * one batch, and nothing advances by itself. Platform Admin. Mounted only
 * when the ungated readiness answer said `managedControls: true`.
 */

type MemberState = 'queued' | 'cut_over' | 'verified' | 'skipped' | 'failed' | 'rolled_back';
interface Run {
  id: string; scope: 'group' | 'business'; businessId: string; businessName: string | null; groupId: string | null; groupName: string | null;
  canaryEndpointId: string | null; canaryName: string | null; batchSize: number;
  state: 'canary' | 'rolling' | 'complete' | 'halted' | 'rolled_back'; createdAt: string; lastBatchAt: string | null;
  counts: Record<MemberState | 'total', number>;
  next: { allowed: boolean; reason: string | null };
  members?: { endpointId: string; name: string; state: MemberState; skipReason: string | null; batch: number | null; cutAt: string | null; verifiedAt: string | null; managedState: string | null }[];
}

const RUN_STATE: Record<Run['state'], string> = {
  canary: 'Canary: waiting for it to be Managed and verified', rolling: 'Rolling, one batch per Advance', complete: 'Complete',
  halted: 'Halted', rolled_back: 'Rolled back',
};
const MEMBER_STATE: Record<MemberState, string> = {
  queued: 'queued', cut_over: 'moved to Managed (pending)', verified: 'Managed and verified', skipped: 'skipped', failed: 'failed', rolled_back: 'rolled back',
};

function RunCard({ run }: { run: Run }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [showMembers, setShowMembers] = useState(false);
  const { data: detail } = useQuery<Run>({
    queryKey: ['msa-cutover-run', run.id],
    queryFn: () => msaCutoverRunsApi.get(run.id).then((r) => r.data?.data),
    enabled: showMembers,
  });
  const act = (fn: () => Promise<unknown>, ok: string) => ({
    mutationFn: fn,
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['msa-cutover-runs'] }); void qc.invalidateQueries({ queryKey: ['msa-cutover-run', run.id] }); toast({ title: ok }); },
    onError: (e: unknown) => toast({ title: 'Not done', description: apiError(e).message, variant: 'destructive' as const }),
  });
  const advance = useMutation(act(() => msaCutoverRunsApi.advance(run.id), 'Next batch moved'));
  const confirm = useMutation(act(() => msaCutoverRunsApi.confirm(run.id), 'Verified devices confirmed'));
  const halt = useMutation(act(() => msaCutoverRunsApi.halt(run.id), 'Run halted'));
  const rollback = useMutation(act(() => msaCutoverRunsApi.rollback(run.id), 'Rolling the run back to Legacy'));
  const busy = advance.isPending || confirm.isPending || halt.isPending || rollback.isPending;
  const open = run.state === 'canary' || run.state === 'rolling';
  const c = run.counts;
  return (
    <li className="space-y-1.5 p-3 text-xs" data-testid="msa-run" data-state={run.state}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{run.scope === 'group' ? `Group ${run.groupName ?? run.groupId}` : 'Whole customer'} · {run.businessName ?? run.businessId}</span>
        <span className="text-muted-foreground">started {formatDate(run.createdAt)}{run.lastBatchAt ? ` · last batch ${formatDate(run.lastBatchAt)}` : ''}</span>
      </div>
      <p className="font-medium" data-testid="msa-run-state">{RUN_STATE[run.state]}</p>
      <p className="text-muted-foreground">
        Canary: {run.canaryEndpointId ? <Link className="underline" href={`/endpoints/${run.canaryEndpointId}`}>{run.canaryName ?? run.canaryEndpointId}</Link> : 'none'}
        {' '}· batches of {run.batchSize} · {c.total} devices: {c.verified} verified, {c.cut_over} pending, {c.queued} queued, {c.skipped} skipped, {c.failed} failed{c.rolled_back ? `, ${c.rolled_back} rolled back` : ''}
      </p>
      {run.next.reason && <p className="text-muted-foreground" data-testid="msa-run-next">{run.next.reason}</p>}
      <div className="flex flex-wrap gap-2">
        {open && <Button size="sm" variant="outline" disabled={busy || !run.next.allowed} onClick={() => advance.mutate()} data-testid="msa-run-advance">Advance one batch</Button>}
        {open && <Button size="sm" variant="outline" disabled={busy} onClick={() => confirm.mutate()} data-testid="msa-run-confirm">Confirm verified</Button>}
        {open && <Button size="sm" variant="outline" disabled={busy} onClick={() => halt.mutate()} data-testid="msa-run-halt">Halt</Button>}
        {run.state !== 'rolled_back' && <Button size="sm" variant="outline" disabled={busy} onClick={() => rollback.mutate()} data-testid="msa-run-rollback">Roll back the run</Button>}
        <Button size="sm" variant="ghost" className="h-8 px-2 text-xs" onClick={() => setShowMembers((v) => !v)} aria-expanded={showMembers}>{showMembers ? 'Hide devices' : 'Devices'}</Button>
      </div>
      {showMembers && detail?.members && (
        <ul className="divide-y rounded-md border" data-testid="msa-run-members">
          {detail.members.map((m) => (
            <li key={m.endpointId} className="flex flex-wrap gap-x-3 px-2.5 py-1.5" data-state={m.state}>
              <Link href={`/endpoints/${m.endpointId}`} className="font-medium hover:underline">{m.name}</Link>
              <span>{MEMBER_STATE[m.state] ?? m.state}{m.batch !== null ? ` · batch ${m.batch}` : ''}</span>
              {m.skipReason && <span className="text-muted-foreground">{m.skipReason}</span>}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function MsaCutoverRuns() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [businessId, setBusinessId] = useState('');
  const [groupId, setGroupId] = useState('');
  const [canary, setCanary] = useState('');
  const [batch, setBatch] = useState('5');
  const { data: runs } = useQuery<Run[]>({
    queryKey: ['msa-cutover-runs'],
    queryFn: () => msaCutoverRunsApi.list().then((r) => r.data?.data?.runs ?? []),
    refetchInterval: 30_000,
  });
  const { data: businesses } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['businesses-for-msa-runs'],
    queryFn: () => businessesApi.list().then((r) => {
      const d = r.data?.data;
      return (Array.isArray(d) ? d : (d?.items ?? d?.businesses ?? [])) as { id: string; name: string }[];
    }),
  });
  const { data: groups } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['device-groups-for-msa-runs', businessId],
    queryFn: () => automationApi.groups(businessId).then((r) => {
      const d = r.data?.data;
      return (Array.isArray(d) ? d : (d?.groups ?? [])) as { id: string; name: string }[];
    }),
    enabled: !!businessId,
  });
  const start = useMutation({
    mutationFn: () => msaCutoverRunsApi.start({
      scope: groupId ? 'group' : 'business', businessId, ...(groupId ? { groupId } : {}),
      ...(canary.trim() ? { canaryEndpointId: canary.trim() } : {}), batchSize: Math.max(1, Math.min(25, Number(batch) || 5)),
    }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['msa-cutover-runs'] }); toast({ title: 'Run started: the canary moved to Managed (pending)' }); },
    onError: (e: unknown) => toast({ title: 'Not started', description: apiError(e).message, variant: 'destructive' }),
  });
  return (
    <Card data-testid="msa-cutover-runs">
      <CardContent className="space-y-3 p-4 text-sm">
        <div>
          <p className="font-medium">Cutover runs (Platform Admin)</p>
          <p className="text-xs text-muted-foreground">
            Move a device group or a whole customer into Managed Secure Access. The canary goes first and must become Managed and verified — a managed
            test session on its own page, then Confirm verified — before Advance moves anyone else. Each Advance moves one batch, every device is
            checked on its own, and nothing advances by itself. Halt and Roll back never ask you to confirm it is you.
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-4">
          <div className="space-y-1">
            <Label htmlFor="msa-run-business">Customer</Label>
            <select id="msa-run-business" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={businessId}
              onChange={(e) => { setBusinessId(e.target.value); setGroupId(''); }} data-testid="msa-run-business">
              <option value="">Choose…</option>
              {(businesses ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="msa-run-group">Device group (optional)</Label>
            <select id="msa-run-group" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={groupId}
              onChange={(e) => setGroupId(e.target.value)} disabled={!businessId} data-testid="msa-run-group">
              <option value="">The whole customer</option>
              {(groups ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="msa-run-canary">Canary device id (optional)</Label>
            <Input id="msa-run-canary" value={canary} onChange={(e) => setCanary(e.target.value)} placeholder="Chosen for you if empty" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="msa-run-batch">Batch size (1–25)</Label>
            <Input id="msa-run-batch" inputMode="numeric" value={batch} onChange={(e) => setBatch(e.target.value)} />
          </div>
        </div>
        <Button size="sm" disabled={!businessId || start.isPending} onClick={() => start.mutate()} data-testid="msa-run-start">Start run</Button>
        {runs && runs.length > 0 && <ul className="divide-y rounded-md border">{runs.map((r) => <RunCard key={r.id} run={r} />)}</ul>}
        {runs && runs.length === 0 && <p className="text-xs text-muted-foreground">No cutover runs yet.</p>}
      </CardContent>
    </Card>
  );
}
