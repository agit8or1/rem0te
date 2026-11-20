'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { msaManagedApi } from '@/lib/api-client';
import { usePermissions } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { apiError } from '@/components/security-controls/shared';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/utils';

/**
 * Managed Secure Access cutover controls (0.72, build step 4) on the device
 * page's readiness card. Platform Admins only, and only while the server
 * runs with MSA_GRANTS=on: the readiness card mounts this only when its own
 * (ungated) answer says `managedControls: true`, so with the switch off the
 * console makes no request to a gated route at all. One computer at a time; the API makes
 * every decision (readiness gate, published grant key, pauses).
 */

interface GrantRow {
  grantId: string; state: string; createdAt: string; appliedAt: string | null; connectedAt: string | null;
  endedAt: string | null; outcome: string | null; failedKeys: string[]; revealedAt: string | null;
}
export interface ManagedView {
  enabled: true;
  endpointId: string;
  state: 'legacy' | 'pending' | 'verified' | 'enforcement_failure' | 'rollback_pending';
  managed: {
    requestedAt: string; verifiedAt: string | null; legacySecuredAt: string | null; failedAt: string | null; failReason: string | null;
    failedKeys: string[]; rollbackRequestedAt: string | null; readbackOkAt: string | null; lastReportAt: string | null;
  } | null;
  grants: GrantRow[];
  grantKeyPublished: boolean;
  cutover: { allowed: boolean; blockers: { code: string; message: string }[] };
  canConfirm: boolean;
  evidence: string;
}

const STATE_TEXT: Record<ManagedView['state'], string> = {
  legacy: 'Legacy',
  pending: 'Managed (pending)',
  verified: 'Managed and verified',
  enforcement_failure: 'Enforcement failure',
  rollback_pending: 'Rolling back to Legacy',
};

const GRANT_TEXT: Record<string, string> = {
  issued: 'waiting for the agent', delivered: 'delivered', applied: 'applied — settings read back', failed: 'refused or failed',
  ended: 'ended', expired: 'expired unused', cancelled: 'cancelled',
};

/**
 * The managed view (GET /msa/managed/:id, View computers). A gated route:
 * pass `enabled` only when an ungated readiness answer said
 * `managedControls: true`. The device page's Connect and this card share
 * the one query (and key).
 */
export function useMsaManagedView(endpointId: string, enabled: boolean) {
  return useQuery<ManagedView | null>({
    queryKey: ['msa-managed', endpointId],
    queryFn: () => msaManagedApi.view(endpointId).then((r) => r.data?.data ?? null).catch(() => null),
    enabled,
    retry: false,
    refetchInterval: 15_000,
  });
}

export function MsaManagedControls({ endpointId }: { endpointId: string }) {
  const { isPlatformAdmin } = usePermissions();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [password, setPassword] = useState<{ grantId: string; value: string } | null>(null);
  const { data } = useMsaManagedView(endpointId, isPlatformAdmin);
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['msa-managed', endpointId] });
    void qc.invalidateQueries({ queryKey: ['msa-readiness', endpointId] });
  };
  const act = (fn: () => Promise<unknown>, ok: string) => ({
    mutationFn: fn,
    onSuccess: () => { done(); toast({ title: ok }); },
    onError: (e: unknown) => toast({ title: 'Not done', description: apiError(e).message, variant: 'destructive' as const }),
  });
  const cutover = useMutation(act(() => msaManagedApi.cutover(endpointId), 'Moved to Managed (pending)'));
  const test = useMutation(act(() => msaManagedApi.testGrant(endpointId), 'Test grant sent'));
  const confirm = useMutation(act(() => msaManagedApi.confirm(endpointId), 'Confirmed: managed and verified'));
  const rollback = useMutation(act(() => msaManagedApi.rollback(endpointId), 'Rolling back to Legacy'));
  const force = useMutation(act(() => msaManagedApi.rollback(endpointId, true), 'Returned to Legacy'));
  const reveal = useMutation({
    mutationFn: (grantId: string) => msaManagedApi.reveal(grantId).then((r) => r.data?.data as { grantId: string; oneTimePassword: string }),
    onSuccess: (r) => { done(); setPassword({ grantId: r.grantId, value: r.oneTimePassword }); },
    onError: (e: unknown) => toast({ title: 'Not shown', description: apiError(e).message, variant: 'destructive' }),
  });

  if (!isPlatformAdmin || !data?.enabled) return null;
  const latest = data.grants[0];
  const busy = cutover.isPending || test.isPending || confirm.isPending || rollback.isPending || force.isPending || reveal.isPending;
  return (
    <div className="space-y-2 rounded-md border border-dashed px-3 py-2 text-xs" data-testid="msa-managed">
      <p className="font-medium">
        Managed Secure Access (Platform Admin): <span data-testid="msa-managed-state">{STATE_TEXT[data.state]}</span>
      </p>
      <p className="text-muted-foreground" data-testid="msa-managed-evidence">{data.evidence}</p>
      {data.managed?.failReason && (
        <p className="text-destructive">Last failure: {data.managed.failReason}{data.managed.failedKeys.length ? ` (${data.managed.failedKeys.join(', ')})` : ''}</p>
      )}
      {!data.grantKeyPublished && <p className="text-muted-foreground">The grant key is not in the signed release metadata yet: the agent would refuse every grant.</p>}
      {latest && (
        <p data-testid="msa-managed-grant">
          Latest test grant: {GRANT_TEXT[latest.state] ?? latest.state}
          {latest.connectedAt ? ' · a RustDesk connection was seen' : ''}
          {latest.outcome ? ` · ${latest.outcome}` : ''}
          {latest.failedKeys.length ? ` (${latest.failedKeys.join(', ')})` : ''} · {formatDate(latest.createdAt)}
        </p>
      )}
      {password && (
        <p className="rounded border bg-muted px-2 py-1" data-testid="msa-managed-password">
          One-time password (shown once, not again): <code className="select-all font-mono">{password.value}</code>
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {data.state === 'legacy' && (
          <Button size="sm" variant="outline" disabled={busy || !data.cutover.allowed} onClick={() => cutover.mutate()} data-testid="msa-cutover">
            Move to Managed (pending)
          </Button>
        )}
        {(data.state === 'pending' || data.state === 'verified' || data.state === 'enforcement_failure') && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => test.mutate()} data-testid="msa-test-grant">Send test grant</Button>
        )}
        {latest && latest.state === 'applied' && !latest.revealedAt && data.state !== 'rollback_pending' && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => reveal.mutate(latest.grantId)} data-testid="msa-reveal">
            Reveal one-time password
          </Button>
        )}
        {data.state === 'pending' && (
          <Button size="sm" variant="outline" disabled={busy || !data.canConfirm} onClick={() => confirm.mutate()} data-testid="msa-confirm">
            Confirm verified
          </Button>
        )}
        {data.state !== 'legacy' && data.state !== 'rollback_pending' && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => rollback.mutate()} data-testid="msa-rollback">Roll back to Legacy</Button>
        )}
        {data.state === 'rollback_pending' && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => force.mutate()} data-testid="msa-rollback-force"
            title="Only if the agent will not report again: RustDesk keeps whatever settings it has.">
            Finish rollback without the agent
          </Button>
        )}
      </div>
      {data.state === 'legacy' && data.cutover.blockers.length > 0 && (
        <ul className="list-disc pl-5 text-muted-foreground" data-testid="msa-cutover-blockers">
          {data.cutover.blockers.map((b) => <li key={b.code}>{b.message}</li>)}
        </ul>
      )}
    </div>
  );
}
