'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { patchingApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/utils';
import { CLASS_NAMES, DEPLOYMENT_STATUS, POLICY_STATUS, describeWindow } from '@/lib/patching';
import { AlertTriangle, ArrowLeft, ExternalLink } from 'lucide-react';
import { rebootSummary } from '@/components/patching/patch-reboot-choice';

/**
 * One patch policy (0.32): the exact document two approvers signed on the
 * approval signer, what the sweep last did under it, what the signer refused,
 * and its deployments. It is approved on the signer, never here; it can be
 * revoked here (with a fresh sign-in), and a revocation is one-way.
 */

interface PolicyDoc {
  name: string; businessName: string; reason: string; createdAt: string; expiresAt: string; createdBy: { name: string };
  rings: { endpointId: string; hostname: string }[][];
  allow: { classifications: string[]; severities?: string[]; excludeKbs?: string[] };
  soakHours: number; failureThreshold: number; window: { days: string[]; start: string; end: string; timezone: string }; reboot: 'never' | 'if_required_in_window';
}
interface Policy {
  id: string; name: string; status: string; digest: string; approvalUrl: string; expiresAt: string; createdAt: string;
  approvals: { name: string; role: string; at: string }[];
  revokedAt: string | null; revokeReason: string | null; signerConfirmedRevocation: boolean;
  document: PolicyDoc;
  currentWindow: { start: string; end: string } | null; nextWindow: { start: string; end: string } | null;
  lastProposal: { at: string; windowKey: string | null; ok: boolean; code: string; message: string; deploymentId?: string | null } | null;
  signer: { reachable: boolean; status: string | null; signedPlans: number | null; refusals: { at: string; jobId: string; code: string; message: string }[] };
  deployments: { id: string; name: string; status: string; windowKey: string | null; pausedReason: string | null; createdAt: string }[];
  sweep: { enabled: boolean; everySeconds: number };
  /** 0.34: each computer's result-key fingerprint as this portal holds it (null: none, a pre-0.34 agent). */
  resultKeys?: Record<string, string | null>;
  mayRevoke: boolean;
}

function apiMessage(e: unknown, fallback: string) {
  return (e as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message?.toString() ?? fallback;
}

export default function PolicyPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: p, isLoading } = useQuery({
    queryKey: ['patch-policy', id],
    queryFn: () => patchingApi.policy(id).then((r) => r.data.data as Policy),
    refetchInterval: (q) => (['AWAITING_APPROVAL', 'ACTIVE'].includes((q.state.data as Policy | undefined)?.status ?? '') ? 20_000 : false),
  });
  const revoke = useMutation({
    mutationFn: (reason: string) => patchingApi.revokePolicy(id, reason),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['patch-policy', id] });
      const d = r.data.data as Policy;
      toast({ title: 'Revoked', description: d.signerConfirmedRevocation ? 'The approval signer confirmed it: nothing more is signed under this policy.' : 'Stopped here. The approval signer has not confirmed yet; rem0te keeps telling it until it does.' });
    },
    onError: (e) => toast({ title: 'Not revoked', description: apiMessage(e, 'Refused.'), variant: 'destructive' }),
  });
  const ask = () => {
    const why = window.prompt('Why revoke this policy? It cannot be undone — a new policy needs new approvals.');
    if (why && why.trim().length >= 3) revoke.mutate(why.trim());
  };

  if (isLoading || !p) return <p className="p-4 md:p-6 text-sm text-muted-foreground">Loading…</p>;
  const d = p.document;
  const row = (k: string, v: React.ReactNode) => (<div className="flex flex-wrap gap-x-2"><dt className="text-muted-foreground w-44 shrink-0">{k}</dt><dd className="min-w-0">{v}</dd></div>);

  return (
    <div className="space-y-4 p-4 md:p-6">
      <Link href="/patching" className="text-xs text-muted-foreground inline-flex items-center gap-1"><ArrowLeft className="h-3 w-3" />Patching</Link>
      <PageHeader title={p.name} description={`Patch policy for ${d.businessName} · proposed by ${d.createdBy.name} ${formatDate(p.createdAt)} · expires ${formatDate(p.expiresAt)}`}>
        <div className="flex gap-2 items-center">
          <Badge variant={POLICY_STATUS[p.status] ?? 'outline'}>{p.status.toLowerCase().replace(/_/g, ' ')}</Badge>
          {p.status === 'AWAITING_APPROVAL' && <a href={p.approvalUrl} target="_blank" rel="noreferrer"><Button size="sm" variant="outline"><ExternalLink className="h-3.5 w-3.5 mr-1" />Approval page</Button></a>}
          {p.mayRevoke && <Button size="sm" variant="ghost" disabled={revoke.isPending} onClick={ask}>Revoke</Button>}
        </div>
      </PageHeader>

      <p className="text-xs text-muted-foreground flex gap-2"><AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-yellow-600" />
        Fixture-tested only: the automatic path is proven end to end against a simulated Windows Update, synthetic passkeys and a scratch approval signer — not yet on a real Windows computer.
      </p>

      {p.status === 'REVOKED' && (
        <Card><CardContent className="pt-6 text-sm">
          Revoked {p.revokedAt ? formatDate(p.revokedAt) : ''}{p.revokeReason ? `: ${p.revokeReason}` : ''}. {p.signerConfirmedRevocation ? 'The approval signer confirmed it.' : 'The approval signer has not confirmed yet; the sweep keeps telling it.'}
        </CardContent></Card>
      )}

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm">What was approved</CardTitle></CardHeader>
        <CardContent className="text-xs space-y-3">
          <dl className="space-y-1.5">
            {row('Classes', d.allow.classifications.map((c) => CLASS_NAMES[c] ?? c).join(', '))}
            {row('Severities', d.allow.severities?.join(', ') ?? 'any')}
            {row('Never installs', d.allow.excludeKbs?.join(', ') ?? 'nothing excluded')}
            {row('Window', describeWindow(d.window))}
            {row('Soak between rings', `${d.soakHours} h`)}
            {row('Failures allowed per ring', String(d.failureThreshold))}
            {row('Restart', rebootSummary(d.reboot))}
            {row('Reason', d.reason)}
            {row('Approved by', p.approvals.length ? p.approvals.map((a) => `${a.name} (${a.role}, ${formatDate(a.at)})`).join('; ') : 'nobody yet — two approvers other than its author approve it on the approval signer')}
            {row('Document digest', <code className="break-all">{p.digest}</code>)}
          </dl>
          <div className="space-y-1">
            {d.rings.map((r, i) => (
              <p key={i}>
                <strong>{i === 0 ? 'Canary' : `Ring ${i}`}:</strong>{' '}
                {r.map((c, j) => {
                  const fp = p.resultKeys?.[c.endpointId];
                  return (
                    <span key={c.endpointId}>
                      {j > 0 && ', '}{c.hostname}
                      {fp && <span className="text-muted-foreground"> (result key <code>{fp}</code>)</span>}
                    </span>
                  );
                })}
              </p>
            ))}
            {p.resultKeys && (
              <p className="text-xs text-muted-foreground">
                Result-key fingerprints are this portal&apos;s copy. Compare the approval signer&apos;s page with{' '}
                <code>rem0te-agent.exe status</code> on the computer, not with this list.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm">Activity</CardTitle></CardHeader>
        <CardContent className="text-xs space-y-2">
          {!p.sweep.enabled && <p className="text-destructive">The policy sweep is off on this server (PATCH_POLICY_SWEEP=off): nothing is proposed under any policy.</p>}
          {p.currentWindow ? <p>Its window is open now, until {formatDate(p.currentWindow.end)}.</p> : p.nextWindow ? <p>Next window: {formatDate(p.nextWindow.start)} – {formatDate(p.nextWindow.end)}.</p> : p.status === 'ACTIVE' ? <p>No window opens before it expires.</p> : null}
          {p.lastProposal && <p>{p.lastProposal.ok ? 'Last' : 'Last refusal'} ({formatDate(p.lastProposal.at)}, <code>{p.lastProposal.code}</code>): {p.lastProposal.message}</p>}
          <p className="text-muted-foreground">Approval signer: {p.signer.reachable ? `${p.signer.status?.toLowerCase().replace(/_/g, ' ')}, ${p.signer.signedPlans} plan${p.signer.signedPlans === 1 ? '' : 's'} signed under it` : 'not reachable'}.</p>
          {p.signer.refusals.length > 0 && (
            <div className="space-y-1">
              <p className="font-medium">Plans the signer refused under this policy</p>
              {p.signer.refusals.slice().reverse().map((f, i) => <p key={`${f.at}-${i}`}><span className="text-muted-foreground">{formatDate(f.at)}</span> <code>{f.code}</code> {f.message}</p>)}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm">Deployments under it</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          {p.deployments.length === 0 ? <p className="text-xs text-muted-foreground">None yet.</p> : p.deployments.map((x) => (
            <Link key={x.id} href={`/patching/${x.id}`} className="block rounded-md border p-2 hover:bg-muted/50 text-xs">
              <strong>{x.name}</strong> <Badge variant={DEPLOYMENT_STATUS[x.status] ?? 'outline'} className="text-[10px]">{x.status.toLowerCase()}</Badge> <span className="text-muted-foreground">{formatDate(x.createdAt)}</span>
              {x.pausedReason && x.status !== 'COMPLETED' && <span className="block text-muted-foreground">{x.pausedReason}</span>}
            </Link>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
