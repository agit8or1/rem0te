'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, ExternalLink, Loader2, ShieldCheck } from 'lucide-react';
import { actionsApi, softwareApi, type SoftwareDetection } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/utils';
import { DEPLOYMENT_STATUS } from '@/lib/patching';
import { describeDetection, plural, refusalText } from '@/components/software/software-ui';

/**
 * One software deployment (0.34), modelled on a patch deployment: its rings,
 * each ring's gate, and where every computer stands. Requesting a ring
 * creates one signed plan that waits for two approvals on the approval
 * signer; this page links there and cannot approve.
 *
 * "Effective" is the computer's own detection rule run after the install
 * (or uninstall): it is what the computer reports, not proof the software
 * works.
 */

interface Gate { ok: boolean; reason: string; detail: string; until?: string }
interface Computer {
  endpointId: string; hostname: string | null; inPlan: boolean; status: string | null; statusReason: string | null; outcome: string | null;
  detail: string | null; observed: Record<string, string> | null; reconciled: string | null;
}
interface Ring {
  ring: number; canary: boolean; gate: Gate;
  job: { id: string; status: string; statusReason: string | null; approvalUrl: string; outcome: string | null; window: { notBefore: string; notAfter: string }; digest: string } | null;
  computers: Computer[];
}
interface Deployment {
  id: string; name: string; operation: 'install' | 'uninstall'; businessId: string; status: string; pausedReason: string | null; single: boolean;
  soakHours: number; failureThreshold: number; windowHours: number; createdAt: string;
  params: { packageId: string; version: string; installerSha256: string; scope: string; detection: SoftwareDetection };
  display: { name?: string; publisher?: string | null; hashSource?: string; manifestSha256?: string | null } | null;
  entryId: string | null; entryRevision: number; entryState: 'current' | 'changed' | 'archived' | 'deleted';
  next: { ring: number | null; canRequest: boolean; why: string };
  rings: Ring[];
}

const OUTCOME: Record<string, 'success' | 'destructive' | 'warning' | 'outline' | 'secondary'> = {
  succeeded: 'success', no_change: 'secondary', restart_required: 'warning', uncertain: 'destructive', failed: 'destructive', refused: 'destructive', not_executed: 'outline',
};
const OBSERVED: [string, string][] = [
  ['wingetVersion', 'winget'], ['detectedBefore', 'before'], ['versionBefore', 'version before'], ['detectedAfter', 'after'], ['versionAfter', 'version after'],
  ['detectedNow', 'now'], ['versionNow', 'version now'], ['effective', 'effective'], ['rebootRequired', 'restart required'], ['installerSha256', 'installer SHA-256'],
  ['exitCode', 'exit code'], ['managers', 'managed by'],
];
const words = (s: string) => s.toLowerCase().replace(/_/g, ' ');

export default function SoftwareDeploymentPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: d, isLoading, error } = useQuery({
    queryKey: ['software-deployment', id],
    queryFn: () => softwareApi.deployment(id).then((r) => r.data.data as Deployment),
    refetchInterval: (q) => ((q.state.data as Deployment | undefined)?.status === 'ACTIVE' ? 20_000 : false),
    retry: false,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['software-deployment', id] });
  const [reason, setReason] = useState('');
  const [exclude, setExclude] = useState<Record<string, string>>({});
  const [startsIn, setStartsIn] = useState(0);
  const [requested, setRequested] = useState<string | null>(null);
  const [changing, setChanging] = useState<'pause' | 'resume' | 'cancel' | null>(null);
  const [why, setWhy] = useState('');

  const request = useMutation({
    mutationFn: () => softwareApi.requestRing(id, d!.next.ring!, {
      reason: reason.trim(), startsInMinutes: startsIn,
      exclude: Object.entries(exclude).filter(([, w]) => w.trim()).map(([endpointId, w]) => ({ endpointId, why: w.trim() })),
    }),
    onSuccess: (r) => {
      setReason(''); setExclude({}); refresh();
      setRequested((r.data.data.job?.approvalUrl as string | undefined) ?? null);
      toast({ title: 'Requested', description: 'Nothing runs until two approvers authorize this plan on the approval page.' });
    },
    onError: (e) => toast({ title: 'Not requested', description: refusalText(e, 'The request was refused.'), variant: 'destructive' }),
  });
  const setStatus = useMutation({
    mutationFn: () => softwareApi[changing!](id, why.trim()),
    onSuccess: () => { setChanging(null); setWhy(''); refresh(); },
    onError: (e) => toast({ title: 'Not changed', description: refusalText(e, 'Refused.'), variant: 'destructive' }),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (error || !d) return <p className="text-sm text-muted-foreground">{refusalText(error, 'This deployment could not be loaded.')}</p>;
  const nextRing = d.next.ring !== null ? d.rings[d.next.ring] : null;
  const excludedAll = nextRing ? nextRing.computers.every((c) => (exclude[c.endpointId] ?? '').trim()) : false;
  const badExclusion = Object.values(exclude).some((w) => w.trim() && w.trim().length < 3);

  return (
    <div className="space-y-4">
      <Link href={d.entryId ? `/automation/software/${d.entryId}` : '/automation/software'} className="text-xs text-muted-foreground inline-flex items-center gap-1"><ArrowLeft className="h-3 w-3" />{d.entryId ? 'Catalog entry' : 'Software catalog'}</Link>
      <PageHeader title={d.name} description={`${d.operation === 'install' ? 'Install' : 'Uninstall'} · created ${formatDate(d.createdAt)}${d.single ? ' · one computer' : ` · soak ${d.soakHours} h · ${plural(d.failureThreshold, 'failure')} allowed per ring`} · ${d.windowHours} h window`}>
        <div className="flex gap-2 items-center">
          <Badge variant={DEPLOYMENT_STATUS[d.status] ?? 'outline'}>{d.status.toLowerCase()}</Badge>
          {d.status === 'ACTIVE' && <Button size="sm" variant="outline" onClick={() => setChanging('pause')}>Pause</Button>}
          {d.status === 'PAUSED' && <Button size="sm" variant="outline" onClick={() => setChanging('resume')}>Resume</Button>}
          {['ACTIVE', 'PAUSED'].includes(d.status) && <Button size="sm" variant="ghost" onClick={() => setChanging('cancel')}>Cancel deployment</Button>}
        </div>
      </PageHeader>

      {changing && (
        <Card>
          <CardContent className="pt-4 space-y-2 text-sm max-w-xl">
            <p className="text-xs">
              {changing === 'pause' ? 'Pausing stops further rings being requested. A plan already approved still runs.'
                : changing === 'resume' ? 'Resuming lets the next ring be requested again; a ring that tripped the failure threshold may be retried.'
                : 'Cancelling stops every plan of this deployment that has not reached a computer. Anything already delivered runs to its own result.'}
            </p>
            <Label htmlFor="sw-why" className="text-xs">Why {changing} it? (recorded in the audit log)</Label>
            <Textarea id="sw-why" rows={2} maxLength={300} value={why} onChange={(e) => setWhy(e.target.value)} />
            <div className="flex gap-2">
              <Button size="sm" variant={changing === 'cancel' ? 'destructive' : 'default'} disabled={why.trim().length < 3 || setStatus.isPending} onClick={() => setStatus.mutate()}>
                {setStatus.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}{changing[0].toUpperCase() + changing.slice(1)}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setChanging(null); setWhy(''); }}>Back</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {d.entryState !== 'current' && (
        <div className="rounded-md border border-yellow-500/50 bg-yellow-50 dark:bg-yellow-950/30 p-3 text-sm flex gap-2" data-entry-state>
          <AlertTriangle className="h-4 w-4 text-yellow-600 shrink-0 mt-0.5" />
          <p>
            {d.entryState === 'changed' ? 'Its catalog entry has changed since this deployment was made. No further ring will be requested; make a new deployment from the current entry.'
              : d.entryState === 'archived' ? 'Its catalog entry has been archived. No further ring will be requested.'
              : 'Its catalog entry no longer exists. No further ring will be requested.'}
            {' '}Plans already requested carry the parameters below and are unaffected.
          </p>
        </div>
      )}
      {d.status === 'PAUSED' && d.pausedReason && <p className="text-sm">Paused: {d.pausedReason}</p>}

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm">What every plan of this deployment carries</CardTitle></CardHeader>
        <CardContent className="text-xs">
          <dl className="grid grid-cols-1 sm:grid-cols-[11rem_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">Package</dt><dd className="font-mono break-all">{d.params.packageId} {d.params.version} (scope {d.params.scope})</dd>
            <dt className="text-muted-foreground">Installer SHA-256</dt><dd className="font-mono break-all">{d.params.installerSha256}</dd>
            <dt className="text-muted-foreground">Hash from</dt><dd>{d.display?.hashSource === 'winget_pkgs' ? 'the winget-pkgs manifest' : 'pasted by an administrator'}{d.display?.manifestSha256 ? <> · manifest <span className="font-mono break-all">{d.display.manifestSha256.slice(0, 16)}…</span></> : null}</dd>
            <dt className="text-muted-foreground">Detection rule</dt><dd>{describeDetection(d.params.detection)}</dd>
            <dt className="text-muted-foreground">Entry revision</dt><dd>{d.entryRevision}</dd>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm flex items-center gap-2"><ShieldCheck className="h-4 w-4" />Next</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p data-next-why>{d.next.why}</p>
          {requested && (
            <p className="text-xs">
              Requested. <a className="underline inline-flex items-center gap-1" href={requested} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-3 w-3" />Open the approval page</a> — two people on the approval roster approve it there with a passkey; you cannot approve your own request.
            </p>
          )}
          {d.next.canRequest && nextRing && (
            <>
              <p className="text-xs text-muted-foreground">
                Requests {nextRing.canary ? (d.single ? 'the plan' : 'the canary') : `ring ${nextRing.ring}`} ({plural(nextRing.computers.length, 'computer')}) as one signed plan. Each computer re-checks the parameters, downloads the installer with winget, hashes it and refuses anything but the pinned SHA-256. Computers are never restarted.
              </p>
              {!nextRing.canary && (
                <div className="space-y-1">
                  <p className="text-xs font-medium">Leave out (optional — say why)</p>
                  {nextRing.computers.map((c) => (
                    <div key={c.endpointId} className="flex items-center gap-2 text-xs">
                      <span className="w-40 truncate">{c.hostname ?? c.endpointId}</span>
                      <Input className="h-8 text-xs" maxLength={200} placeholder="included" aria-label={`Leave out ${c.hostname ?? c.endpointId}: why`} value={exclude[c.endpointId] ?? ''} onChange={(e) => setExclude((m) => ({ ...m, [c.endpointId]: e.target.value }))} />
                    </div>
                  ))}
                  {badExclusion && <p className="text-xs text-destructive">A reason to leave a computer out is at least 3 characters.</p>}
                  {excludedAll && <p className="text-xs text-destructive">Every computer of this ring is left out.</p>}
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
                <div className="space-y-1">
                  <Label htmlFor="ring-reason" className="text-xs">Why (shown to the approvers)</Label>
                  <Textarea id="ring-reason" rows={2} maxLength={400} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Canary confirmed; rolling out to the office" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ring-start" className="text-xs">Starts in (minutes, 0–1440)</Label>
                  <Input id="ring-start" type="number" min={0} max={1440} value={startsIn} onChange={(e) => setStartsIn(Number(e.target.value))} />
                </div>
              </div>
              <Button size="sm" disabled={reason.trim().length < 3 || startsIn < 0 || startsIn > 1440 || badExclusion || excludedAll || request.isPending} onClick={() => request.mutate()}>
                {request.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}Request {nextRing.canary ? (d.single ? 'the plan' : 'canary') : `ring ${nextRing.ring}`}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {d.rings.map((r) => <RingCard key={r.ring} r={r} single={d.single} onChanged={refresh} />)}
    </div>
  );
}

function RingCard({ r, single, onChanged }: { r: Ring; single: boolean; onChanged: () => void }) {
  return (
    <Card data-ring={r.ring}>
      <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0 gap-2 flex-wrap">
        <CardTitle className="text-sm">{single ? 'The computer' : r.canary ? 'Ring 0 — canary' : `Ring ${r.ring}`}</CardTitle>
        <div className="flex items-center gap-2 text-xs">
          {r.job && <Badge variant="outline">{words(r.job.status)}</Badge>}
          <Badge variant={r.gate.ok ? 'success' : r.gate.reason === 'not_requested' ? 'outline' : 'warning'}>{r.gate.ok ? 'passed' : words(r.gate.reason)}</Badge>
          {r.job?.status === 'AWAITING_APPROVAL' && (
            <Button size="sm" variant="outline" asChild><a href={r.job.approvalUrl} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-3.5 w-3.5 mr-1" />Approval page</a></Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        <p className={r.gate.ok ? 'text-muted-foreground' : ''}>{r.gate.detail}</p>
        {r.job?.statusReason && <p className="text-muted-foreground">Plan: {words(r.job.statusReason)}</p>}
        {r.job && <p className="text-muted-foreground">May run {formatDate(r.job.window.notBefore)} – {formatDate(r.job.window.notAfter)} · <span className="font-mono break-all">plan {r.job.digest.slice(0, 16)}…</span></p>}
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 pr-2 font-medium">Computer</th>
                <th className="py-1 pr-2 font-medium">Status</th>
                <th className="py-1 pr-2 font-medium">Outcome</th>
                <th className="py-1 pr-2 font-medium">What it reported</th>
              </tr>
            </thead>
            <tbody>
              {r.computers.map((c) => (
                <tr key={c.endpointId} className="border-t align-top" data-computer={c.endpointId}>
                  <td className="py-1 pr-2">
                    <Link className="underline" href={`/endpoints/${c.endpointId}?tab=software`}>{c.hostname ?? c.endpointId}</Link>
                    {r.job && !c.inPlan && <span className="block text-muted-foreground">left out of this plan</span>}
                  </td>
                  <td className="py-1 pr-2">
                    {c.status ? words(c.status) : r.job ? '—' : 'not requested'}
                    {c.statusReason && <span className="block text-muted-foreground">{words(c.statusReason)}</span>}
                  </td>
                  <td className="py-1 pr-2">
                    {c.outcome ? <Badge variant={OUTCOME[c.outcome] ?? 'outline'} className="text-[10px]">{words(c.outcome)}</Badge> : '—'}
                    {c.detail && <span className="block text-muted-foreground max-w-[18rem]">{c.detail}</span>}
                    {c.reconciled && <span className="block text-muted-foreground">reconciled: {c.reconciled}</span>}
                    {r.job && c.status === 'UNKNOWN' && !c.reconciled && <Reconcile jobId={r.job.id} endpointId={c.endpointId} onDone={onChanged} />}
                  </td>
                  <td className="py-1 pr-2">
                    {c.observed && Object.keys(c.observed).length > 0 ? (
                      <dl className="grid grid-cols-[auto_1fr] gap-x-2">
                        {OBSERVED.filter(([k]) => c.observed![k]).map(([k, label]) => (
                          <span key={k} className="contents"><dt className="text-muted-foreground">{label}</dt><dd className={k === 'installerSha256' ? 'font-mono break-all' : ''}>{c.observed![k]}</dd></span>
                        ))}
                      </dl>
                    ) : <span className="text-muted-foreground">—</span>}
                  </td>
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
    onError: (e) => toast({ title: 'Not recorded', description: refusalText(e, 'Could not reconcile.'), variant: 'destructive' }),
  });
  if (!open) return <Button size="sm" variant="outline" className="h-6 mt-1 text-[11px]" onClick={() => setOpen(true)}>Reconcile</Button>;
  return (
    <div className="mt-1 space-y-1 rounded-md border border-destructive/40 p-2 max-w-xs">
      <p>Uncertain: the computer did not finish reporting. It will not run again. Check Programs and Features on the computer, then record what you found.</p>
      <div className="flex flex-wrap gap-2">
        {(['installed', 'not_installed', 'other'] as const).map((f) => (
          <label key={f} className="flex items-center gap-1"><input type="radio" checked={found === f} onChange={() => setFound(f)} />{words(f)}</label>
        ))}
      </div>
      <Textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="How you checked" />
      <Button size="sm" variant="outline" disabled={note.trim().length < 3 || m.isPending} onClick={() => m.mutate()}>Record</Button>
    </div>
  );
}
