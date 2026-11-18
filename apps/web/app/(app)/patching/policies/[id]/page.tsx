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
import { directApproved } from '@/lib/direct-mode';
import { CLASS_NAMES, DEPLOYMENT_STATUS, POLICY_STATUS, describeWindow, type PolicyWindowInput } from '@/lib/patching';
import { describeOccurrence } from '@/lib/tasks';
import { AlertTriangle, ArrowLeft, ExternalLink } from 'lucide-react';
import { rebootSummary } from '@/components/patching/patch-reboot-choice';

/**
 * One patch policy (0.32): the exact document two approvers signed on the
 * approval signer, what the sweep last did under it, what the signer refused,
 * and its deployments. It is approved on the signer, never here; it can be
 * revoked here (with a fresh sign-in), and a revocation is one-way.
 */

interface PolicyDoc {
  name: string; businessName: string; reason: string; createdAt: string; expiresAt?: string; expiry?: 'never'; createdBy: { name: string };
  rings: { endpointId: string; hostname: string }[][];
  allow: { classifications: string[]; severities?: string[]; excludeKbs?: string[] };
  soakHours: number; failureThreshold: number; window: PolicyWindowInput; reboot: 'never' | 'if_required_in_window';
  restart?: { rule: string; window: PolicyWindowInput }; ignoreRemoteSession?: true;
  /** 0.62: 'none' is all at once; absent (every document before 0.62) is canary. */
  staging?: 'none' | 'canary';
}
interface Policy {
  id: string; name: string; status: string; digest: string; approvalUrl: string; expiresAt: string | null; createdAt: string;
  approvals: { name: string; role: string; at: string }[];
  revokedAt: string | null; revokeReason: string | null; signerConfirmedRevocation: boolean;
  document: PolicyDoc;
  currentWindow: { start: string; end: string } | null; nextWindow: { start: string; end: string } | null;
  /** 0.53: the next three openings (before expiry, for a policy made before 0.63), from the signer's own occurrence functions. */
  upcomingWindows?: { start: string; end: string }[];
  lastProposal: { at: string; windowKey: string | null; ok: boolean; code: string; message: string; deploymentId?: string | null } | null;
  signer: { reachable: boolean; status: string | null; signedPlans: number | null; refusals: { at: string; jobId: string; code: string; message: string }[] };
  deployments: { id: string; name: string; status: string; windowKey: string | null; pausedReason: string | null; createdAt: string }[];
  sweep: { enabled: boolean; everySeconds: number };
  /** 0.54: installs and restarts in plain words, the restart window's openings, and the restarts asked for under it. */
  schedule?: string; restartWords?: string;
  currentRestartWindow?: { start: string; end: string } | null; upcomingRestartWindows?: { start: string; end: string }[];
  restarts?: { endpointId: string; computer: string; windowKey: string; attempt: number; at: string; code: string; message: string; jobId: string | null; jobStatus: string | null; outcome: string | null; reason: string | null; scheduledFor: string | null; sessionOverride: boolean }[];
  /** 0.40: activated at admission in direct mode, with no approvals (the signer's word). */
  direct?: boolean;
  createdById?: string;
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
      <PageHeader title={p.name} description={`Patch policy for ${d.businessName} · proposed by ${d.createdBy.name} ${formatDate(p.createdAt)}${p.expiresAt ? ` · made before 0.63, expires ${formatDate(p.expiresAt)}` : ' · never expires'}`}>
        <div className="flex gap-2 items-center">
          <Badge variant={POLICY_STATUS[p.status] ?? 'outline'}>{p.status.toLowerCase().replace(/_/g, ' ')}</Badge>
          {p.status === 'AWAITING_APPROVAL' && !p.direct && <a href={p.approvalUrl} target="_blank" rel="noreferrer"><Button size="sm" variant="outline"><ExternalLink className="h-3.5 w-3.5 mr-1" />Approval page</Button></a>}
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
            {row('Window', <span data-testid="policy-window">{describeWindow(d.window)}{(p.upcomingWindows?.length ?? 0) > 0 && <span className="block text-muted-foreground">Next openings: {p.upcomingWindows!.map((o) => describeOccurrence(o, d.window.timezone)).join('; ')}</span>}</span>)}
            {row('Staging', <span data-testid="policy-staging">{d.staging === 'none' ? 'All at once: every computer installs in the window together, with no test computer' : 'One computer first: the rest follow in rings, each after the one before it is confirmed'}</span>)}
            {d.staging !== 'none' && row('Soak between rings', `${d.soakHours} h`)}
            {d.staging !== 'none' && row('Failures allowed per ring', String(d.failureThreshold))}
            {row('Restart', <span data-testid="policy-restart">{p.restartWords ? `${rebootSummary(d.reboot)}. Restarts: ${p.restartWords}` : rebootSummary(d.reboot)}{(p.upcomingRestartWindows?.length ?? 0) > 0 && d.restart && <span className="block text-muted-foreground">Next restart windows: {p.upcomingRestartWindows!.map((o) => describeOccurrence(o, d.restart!.window.timezone)).join('; ')}</span>}{(d.restart || d.reboot === 'if_required_in_window') && <span className="block text-muted-foreground">A signed-in user does not stop the restart. They see the 15-minute warning, and unsaved work is lost.</span>}</span>)}
            {p.schedule && row('Schedule', <span data-testid="policy-schedule">{p.schedule}</span>)}
            {row('Reason', d.reason)}
            {row('Approved by', p.direct ? `${directApproved(d.createdBy.name, p.createdAt)} — it stops counting if the business leaves direct mode on the approval signer` : p.approvals.length ? p.approvals.map((a) => `${a.name} (${a.role}, ${formatDate(a.at)})`).join('; ') : 'nobody yet — two approvers other than its author approve it on the approval signer')}
            {row('Document digest', <code className="break-all">{p.digest}</code>)}
          </dl>
          <div className="space-y-1">
            {d.rings.map((r, i) => (
              <p key={i}>
                <strong>{d.staging === 'none' ? (d.rings.length > 1 ? `Plan ${i + 1}` : 'Computers') : i === 0 ? 'Canary' : `Ring ${i}`}:</strong>{' '}
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
          {p.currentWindow ? <p>Its window is open now, until {formatDate(p.currentWindow.end)}.</p> : p.nextWindow ? <p>Next window: {formatDate(p.nextWindow.start)} – {formatDate(p.nextWindow.end)}.</p> : p.status === 'ACTIVE' ? <p>{p.expiresAt ? 'No window opens before it expires.' : 'No window opens.'}</p> : null}
          {p.currentRestartWindow && <p data-testid="policy-restart-open">Its restart window is open now, until {formatDate(p.currentRestartWindow.end)}.</p>}
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

      {d.restart && (
        <Card data-testid="policy-restarts">
          <CardHeader className="pb-3"><CardTitle className="text-sm">Restarts under it</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-xs">
            {(p.restarts ?? []).length === 0 ? <p className="text-muted-foreground">None asked for yet.</p> : p.restarts!.map((x) => (
              <p key={`${x.endpointId}-${x.windowKey}-${x.attempt}`}>
                <strong>{x.computer}</strong> <span className="text-muted-foreground">{formatDate(x.at)} · window {formatDate(x.windowKey)} · attempt {x.attempt}</span>{' '}
                {x.jobId ? <>— {x.outcome ?? x.jobStatus?.toLowerCase() ?? 'signed'}{x.reason ? ` (${x.reason.replace(/_/g, ' ')})` : ''}{x.sessionOverride ? ' — restarted although a technician was connected through RustDesk' : ''}{x.scheduledFor ? `, restart at ${formatDate(x.scheduledFor)}` : ''}</> : <>— not signed: <code>{x.code}</code> {x.message}</>}
              </p>
            ))}
          </CardContent>
        </Card>
      )}

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
