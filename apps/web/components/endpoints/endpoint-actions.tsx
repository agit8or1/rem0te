'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { actionsApi } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/utils';
import { AlertTriangle, ExternalLink, Loader2, ShieldCheck, Wrench } from 'lucide-react';

/**
 * Approved catalog actions on one computer (v0.26).
 *
 * This page can REQUEST an action and show where it stands. It cannot approve
 * one: approval is a passkey quorum on the approval signer, a separate process
 * on its own origin, and the agent on the computer checks that signature with
 * a key from the offline-rooted update chain. The "Open approval page" link
 * goes there; nothing on this page can stand in for it.
 *
 * Results say what the agent observed and nothing more — a running Print
 * Spooler is not a printed document.
 */

interface CatalogAction { id: string; version: number; title: string; description: string; warnings: string[]; verification: string; doesNotProve: string[] }
interface Job {
  id: string; status: string; statusReason: string | null;
  action: { id: string; version: number; title: string; warnings: string[] };
  reason: string; origin: string; via: string; ticketRef: string | null; requestedById: string;
  risk: 'low' | 'high'; approvalsRequired: number; customerSignoff: boolean;
  window: { notBefore: string; notAfter: string }; digest: string; approvalUrl: string;
  approvers: { name: string; role: string; at: string }[] | null;
  dispatchedAt: string | null; deliveries: number; outcome: string | null;
  result: { observed?: Record<string, string>; detail?: string; reason?: string } | null; resultAt: string | null;
  reconciled: { at: string; byId: string; note: string } | null;
  createdAt: string;
  // v0.27: one plan can name several computers (a patch ring). From one
  // computer's page the list carries that computer's row only, plus ringSize.
  deploymentId: string | null; ring: number | null; ringSize?: number;
  targets: { endpointId: string; hostname: string | null; status: string; statusReason: string | null; outcome: string | null;
    result: JobResult | null; reconciled: { at: string; note: string } | null }[];
}
type JobResult = { observed?: Record<string, string>; detail?: string; reason?: string; updates?: { updateId: string; kb?: string; state: string; reason?: string; hresult?: string }[] };
const UPDATE_ACTION = 'windows.update.install';

const STATUS: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning' }> = {
  AWAITING_APPROVAL: { label: 'Awaiting approval', variant: 'warning' },
  APPROVED: { label: 'Approved — waiting for the computer', variant: 'secondary' },
  DISPATCHED: { label: 'Delivered — waiting for its result', variant: 'secondary' },
  SUCCEEDED: { label: 'Succeeded', variant: 'success' },
  FAILED: { label: 'Failed', variant: 'destructive' },
  REFUSED_BY_ENDPOINT: { label: 'Refused by the computer', variant: 'destructive' },
  NOT_EXECUTED: { label: 'Not executed', variant: 'outline' },
  UNKNOWN: { label: 'Outcome uncertain', variant: 'destructive' },
  REJECTED: { label: 'Rejected', variant: 'outline' },
  CANCELED: { label: 'Canceled', variant: 'outline' },
  EXPIRED: { label: 'Expired', variant: 'outline' },
};

function apiMessage(e: unknown, fallback: string) {
  return (e as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message?.toString() ?? fallback;
}

export function EndpointActions({ endpointId, isOnline }: { endpointId: string; isOnline: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);

  const { data: catalog } = useQuery({
    queryKey: ['actions-catalog'],
    queryFn: () => actionsApi.catalog().then((r) => r.data.data as { configured: boolean; actions: CatalogAction[] }),
  });
  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ['endpoint-actions', endpointId],
    queryFn: () => actionsApi.list(endpointId).then((r) => r.data.data as Job[]),
    refetchInterval: (q) => ((q.state.data as Job[] | undefined)?.some((j) => ['AWAITING_APPROVAL', 'APPROVED', 'DISPATCHED'].includes(j.status)) ? 15_000 : false),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['endpoint-actions', endpointId] });

  // Updates are requested through a staged deployment, never one computer at a time from here.
  const action = catalog?.actions.find((a) => a.id === 'windows.service.start');
  const request = useMutation({
    mutationFn: () => actionsApi.request(endpointId, { actionId: action!.id, version: action!.version, params: { service: 'Spooler' }, reason: reason.trim() }),
    onSuccess: () => { setReason(''); setConfirmed(false); refresh(); toast({ title: 'Requested', description: 'Nothing runs until the approvers authorize it on the approval page.' }); },
    onError: (e) => toast({ title: 'Not requested', description: apiMessage(e, 'The request was refused.'), variant: 'destructive' }),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => actionsApi.cancel(id),
    onSuccess: refresh,
    onError: (e) => toast({ title: 'Not canceled', description: apiMessage(e, 'Could not cancel.'), variant: 'destructive' }),
  });

  if (catalog && !catalog.configured) {
    return (
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm flex items-center gap-2"><Wrench className="h-4 w-4" />Approved actions</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Not available on this server: no approval signer is configured. See <Link className="underline" href="/docs/approved-actions">Approved actions</Link>.
        </CardContent>
      </Card>
    );
  }

  const pending = jobs.find((j) => j.action.id !== UPDATE_ACTION && (['AWAITING_APPROVAL', 'APPROVED', 'DISPATCHED'].includes(j.status) || (j.status === 'UNKNOWN' && !j.reconciled)));

  return (
    <div className="space-y-4">
      {action && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2"><Wrench className="h-4 w-4" />{action.title}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">{action.description}</p>
            <div className="rounded-md border border-yellow-300 bg-yellow-50 dark:border-yellow-800 dark:bg-yellow-950/40 p-3 space-y-1">
              {action.warnings.map((w) => (
                <p key={w} className="flex gap-2 text-xs"><AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-yellow-600" />{w}</p>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {action.verification} It does not show {action.doesNotProve.join(', ')}.
            </p>
            <p className="text-xs text-muted-foreground flex gap-2">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              Requesting runs nothing. People on the approval roster authorize the exact plan with a passkey on the approval page — one for a standard workstation, two for anything else, plus the customer where their policy requires it. You cannot approve your own request.
            </p>
            {pending ? (
              <p className="text-xs">An earlier request is {STATUS[pending.status]?.label.toLowerCase() ?? pending.status}; resolve it before asking again.</p>
            ) : (
              <>
                <div className="space-y-1">
                  <Label htmlFor="action-reason" className="text-xs">Why (shown to the approvers)</Label>
                  <Textarea id="action-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Ticket 42: nothing prints, the spooler is stopped" />
                </div>
                <label className="flex items-start gap-2 text-xs">
                  <input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                  I understand that documents already waiting may print as soon as the spooler starts, and cannot be recalled.
                </label>
                <Button size="sm" disabled={!confirmed || reason.trim().length < 3 || request.isPending} onClick={() => request.mutate()}>
                  {request.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}Request approval
                </Button>
                {!isOnline && <p className="text-xs text-muted-foreground">This computer is offline. An approved plan waits for it until its window closes, then expires unrun.</p>}
              </>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm">History</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          {isLoading ? <p className="text-muted-foreground">Loading…</p> : jobs.length === 0 ? <p className="text-muted-foreground">No actions have been requested on this computer.</p> : jobs.map((j) => (
            <JobRow key={j.id} job={j} onCancel={() => cancel.mutate(j.id)} onChanged={refresh} />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function JobRow({ job: j, onCancel, onChanged }: { job: Job; onCancel: () => void; onChanged: () => void }) {
  const { toast } = useToast();
  const isUpdate = j.action.id === UPDATE_ACTION;
  const choices = isUpdate ? (['installed', 'not_installed', 'other'] as const) : (['running', 'stopped', 'other'] as const);
  const [found, setFound] = useState<(typeof choices)[number]>(choices[0]);
  const [note, setNote] = useState('');
  // This computer's row of the plan; for a single-computer plan it is the plan.
  const mine = j.targets?.[0];
  const uncertain = mine ? mine.status === 'UNKNOWN' && !mine.reconciled : j.status === 'UNKNOWN' && !j.reconciled;
  const result = (mine?.result ?? j.result) as JobResult | null;
  const outcome = mine?.outcome ?? j.outcome;
  const reconciled = mine?.reconciled ?? j.reconciled;
  const reconcile = useMutation({
    mutationFn: () => actionsApi.reconcile(j.id, { found, note: note.trim(), ...(mine && j.targets.length >= 1 && (j.ringSize ?? 1) > 1 ? { endpointId: mine.endpointId } : {}) }),
    onSuccess: () => { setNote(''); onChanged(); },
    onError: (e) => toast({ title: 'Not recorded', description: apiMessage(e, 'Could not reconcile.'), variant: 'destructive' }),
  });
  const s = STATUS[j.status] ?? { label: j.status, variant: 'outline' as const };
  return (
    <div className="rounded-md border p-3 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge variant={s.variant}>{s.label}</Badge>
          <span className="text-xs text-muted-foreground">{formatDate(j.createdAt)}</span>
          {j.origin === 'ai_suggestion' && <Badge variant="outline" className="text-xs">AI suggestion{j.ticketRef ? ` · ${j.ticketRef}` : ''}</Badge>}
          {j.via === 'clientst0r' && <Badge variant="outline" className="text-xs">via ClientSt0r</Badge>}
          {j.deploymentId && (
            <Link href={`/patching/${j.deploymentId}`} className="text-xs underline">
              {j.ring === 0 ? 'Patch canary' : `Patch ring ${j.ring}`}{(j.ringSize ?? 1) > 1 ? ` · ${j.ringSize} computers` : ''}
            </Link>
          )}
        </div>
        <div className="flex gap-2">
          {j.status === 'AWAITING_APPROVAL' && (
            <Button size="sm" variant="outline" asChild>
              <a href={j.approvalUrl} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-3.5 w-3.5 mr-1" />Open approval page</a>
            </Button>
          )}
          {['AWAITING_APPROVAL', 'APPROVED'].includes(j.status) && <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>}
        </div>
      </div>
      <p className="text-xs">{j.reason}</p>
      <p className="text-xs text-muted-foreground">
        {j.risk === 'high' ? 'Higher impact' : 'Standard workstation'} · needs {j.approvalsRequired} approver{j.approvalsRequired > 1 ? 's' : ''}{j.customerSignoff ? ' and customer sign-off' : ''} · may run {formatDate(j.window.notBefore)} – {formatDate(j.window.notAfter)}
      </p>
      {j.approvers?.length ? <p className="text-xs text-muted-foreground">Approved by {j.approvers.map((a) => `${a.name}${a.role === 'customer' ? ' (customer)' : ''}`).join(', ')}</p> : null}
      {j.statusReason && <p className="text-xs text-muted-foreground">Reason: {j.statusReason.replace(/_/g, ' ')}</p>}
      {(j.ringSize ?? 1) > 1 && mine && <p className="text-xs text-muted-foreground">This computer: {mine.status.toLowerCase().replace(/_/g, ' ')}{mine.statusReason ? ` (${mine.statusReason.replace(/_/g, ' ')})` : ''}</p>}
      {result && (
        <p className="text-xs">
          Computer reported <strong>{outcome?.replace(/_/g, ' ')}</strong>
          {result.reason ? ` (${result.reason.replace(/_/g, ' ')})` : ''}
          {result.observed && !isUpdate ? ` — observed: ${Object.entries(result.observed).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}
          {isUpdate ? '. An install is confirmed only by a later scan; see the deployment.' : '. This shows the service state only, not that anything printed.'}
        </p>
      )}
      {result?.updates?.length ? (
        <ul className="text-xs list-disc pl-5">
          {result.updates.map((u) => <li key={u.updateId}>{u.kb ?? u.updateId}: {u.state.replace(/_/g, ' ')}{u.reason ? ` — ${u.reason}` : ''}{u.hresult && u.state === 'failed' ? ` (${u.hresult})` : ''}</li>)}
        </ul>
      ) : null}
      <p className="text-[11px] text-muted-foreground font-mono break-all">plan {j.digest}</p>
      {uncertain && (
        <div className="rounded-md border border-destructive/40 p-2 space-y-2">
          <p className="text-xs">{isUpdate
            ? 'The outcome is uncertain — the computer may or may not have installed these updates. It will not run this again. Check Settings › Windows Update › Update history on the computer, then record what you found; the deployment does not move on until you do.'
            : 'The outcome is uncertain — the computer may or may not have started the spooler. It will not run this again. Check the computer, then record what you found; no new request is accepted until you do.'}</p>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {isUpdate ? 'Found the updates' : 'Found the spooler'}
            {choices.map((f) => (
              <label key={f} className="flex items-center gap-1"><input type="radio" name={`found-${j.id}`} checked={found === f} onChange={() => setFound(f)} />{f.replace(/_/g, ' ')}</label>
            ))}
          </div>
          <Textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="How you checked, e.g. services.msc on FRONTDESK" />
          <Button size="sm" variant="outline" disabled={note.trim().length < 3 || reconcile.isPending} onClick={() => reconcile.mutate()}>Record and reconcile</Button>
        </div>
      )}
      {reconciled && <p className="text-xs text-muted-foreground">Reconciled {formatDate(reconciled.at)}: {reconciled.note}</p>}
    </div>
  );
}
