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
import { DIRECT_REQUEST_NOTE, DIRECT_TOAST, directApproved, oldAgentRefusal } from '@/lib/direct-mode';
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
 * Spooler is not a printed document, a scheduled restart is not a restart.
 *
 * 0.32: every direct catalog action is offered here (start the spooler, and
 * the maintenance actions: restart an allowlisted service, schedule or cancel
 * a restart, collect logs). Parameters are only ever one of the values the
 * catalog lists; the server and the agent check them again.
 *
 * 0.34: script runs (windows.script.run) are requested from an approved
 * version in the script library, not here, but appear in this history with
 * the script's name, exit code and its redacted output.
 */

interface CatalogAction {
  id: string; version: number; title: string; description: string; warnings: string[]; verification: string; doesNotProve: string[];
  direct: boolean; acknowledge: string; maxWindowHours: number; workstationRisk: 'low' | 'high';
  choice: { field: string; label: string; options: { value: string | number; label: string }[] } | null;
  requiresCapability: string | null;
}
type LogSection = { source: string; text: string; truncated: boolean; note?: string };
interface Job {
  id: string; status: string; statusReason: string | null;
  action: { id: string; version: number; title: string; warnings: string[] };
  params?: { service?: unknown; delayMinutes?: unknown } | null;
  reason: string; origin: string; via: string; ticketRef: string | null; requestedById: string;
  risk: 'low' | 'high'; approvalsRequired: number; customerSignoff: boolean;
  /** 0.40: signed at the request, in direct mode. */
  direct?: boolean; requestedByName?: string | null;
  window: { notBefore: string; notAfter: string }; digest: string; approvalUrl: string;
  approvers: { name: string; role: string; at: string }[] | null;
  dispatchedAt: string | null; deliveries: number; outcome: string | null;
  result: { observed?: Record<string, string>; detail?: string; reason?: string } | null; resultAt: string | null;
  reconciled: { at: string; byId: string; note: string } | null;
  createdAt: string;
  // 0.34: a script run names its script; each target carries its output (or that it was pruned).
  script?: { name: string; version: number; scriptId: string; versionId: string; contentSha256: string };
  // v0.27: one plan can name several computers (a patch ring). From one
  // computer's page the list carries that computer's row only, plus ringSize.
  deploymentId: string | null; ring: number | null; ringSize?: number;
  targets: { endpointId: string; hostname: string | null; status: string; statusReason: string | null; outcome: string | null;
    result: JobResult | null; reconciled: { at: string; note: string } | null; scriptOutput?: ScriptOutput | { pruned: true } | null }[];
}
type JobResult = {
  observed?: Record<string, string>; detail?: string; reason?: string;
  updates?: { updateId: string; kb?: string; state: string; reason?: string; hresult?: string }[];
  logs?: LogSection[]; logsWithheld?: string;
};
type ScriptOutput = {
  exitCode: number | null; timedOut: boolean; durationMs: number | null; stdout: string; stderr: string;
  stdoutBytes: number; stderrBytes: number; stdoutTruncated: boolean; stderrTruncated: boolean; recordedAt: string;
};
const UPDATE_ACTION = 'windows.update.install';
const SCRIPT_ACTION = 'windows.script.run';
/** The Print Spooler start has one fixed parameter value; no choice is offered. */
const FIXED_PARAMS: Record<string, Record<string, unknown>> = { 'windows.service.start': { service: 'Spooler' } };
const PLACEHOLDER: Record<string, string> = {
  'windows.service.start': 'e.g. Ticket 42: nothing prints, the spooler is stopped',
  'windows.service.restart': 'e.g. Ticket 51: Windows Update is stuck at 0%',
  'windows.reboot.schedule': 'e.g. Ticket 8: updates installed, a restart is pending',
  'windows.reboot.cancel': 'e.g. Ticket 8: the user asked to restart tonight instead',
  'windows.logs.collect': 'e.g. Ticket 60: random freezes since Monday',
};
const LOG_LABEL: Record<string, string> = {
  system_errors: 'System log: Critical and Error events, last 24 hours',
  application_errors: 'Application log: Critical and Error events, last 24 hours',
  agent_journal: 'Agent: approved-action journal',
  agent_log: 'Agent: its own log',
  rustdesk_log: 'RustDesk service log',
};

/** What the person reconciling an uncertain outcome checks for, per action. */
function reconcileFor(actionId: string, observed?: Record<string, string>) {
  switch (actionId) {
    case UPDATE_ACTION:
      return { label: 'Found the updates', choices: ['installed', 'not_installed', 'other'] as const,
        text: 'The outcome is uncertain — the computer may or may not have installed these updates. It will not run this again. Check Settings › Windows Update › Update history on the computer, then record what you found; the deployment does not move on until you do.' };
    case 'windows.service.restart':
      return { label: `Found ${observed?.service ?? 'the service'}`, choices: ['running', 'stopped', 'other'] as const,
        text: 'The outcome is uncertain — the computer may have stopped the service and not started it again. It will not run this again. Check the service on the computer, then record what you found; no new restart request is accepted until you do.' };
    case 'windows.reboot.schedule':
    case 'windows.reboot.cancel':
      return { label: 'Found', choices: ['restart_scheduled', 'no_restart_scheduled', 'other'] as const,
        text: 'The outcome is uncertain — Windows may or may not have a restart pending. It will not run this again. Check the computer (a restart warning on screen, or ask the person there), then record what you found; no new request for this action is accepted until you do.' };
    case SCRIPT_ACTION:
      return { label: 'Found', choices: ['other'] as const,
        text: 'The outcome is uncertain — the agent stopped while the script was running, so it may have done part of its work, and its output was not kept. It will not run this again. Check the computer for what the script changes, then record what you found; no new run of a script on this computer is accepted until you do.' };
    case 'windows.logs.collect':
      return { label: 'Found', choices: ['other'] as const,
        text: 'The outcome is uncertain — the agent stopped while collecting. Nothing was changed on the computer. Record that you have seen this; no new collection is accepted until you do.' };
    default:
      return { label: 'Found the spooler', choices: ['running', 'stopped', 'other'] as const,
        text: 'The outcome is uncertain — the computer may or may not have started the spooler. It will not run this again. Check the computer, then record what you found; no new request is accepted until you do.' };
  }
}

/** What a reported result does not show, per action. */
const RESULT_CAVEAT: Record<string, string> = {
  [UPDATE_ACTION]: '. An install is confirmed only by a later scan; see the deployment.',
  'windows.service.start': '. This shows the service state only, not that anything printed.',
  'windows.service.restart': '. This shows the service state only, not that whatever was failing now works.',
  'windows.reboot.schedule': '. This shows that Windows accepted the restart, not that the computer restarted; a new boot time in the inventory shows that.',
  'windows.reboot.cancel': '. This shows what Windows answered when asked to cancel.',
  'windows.logs.collect': '. Redacted on the computer and again on receipt.',
  [SCRIPT_ACTION]: '. An exit code is what the script returned, not proof that it did what it says.',
};

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

export function EndpointActions({ endpointId, isOnline, unavailableReason, agentActions = [] }: {
  endpointId: string; isOnline: boolean;
  /** Why this computer cannot run any action (0.31, from the device workspace); the server still decides. */
  unavailableReason?: string | null;
  /** What this computer's agent reports it can run, as id@version (0.32: per-action availability). */
  agentActions?: string[];
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [choice, setChoice] = useState<string>('');

  const { data: catalog } = useQuery({
    queryKey: ['actions-catalog', endpointId],
    queryFn: () => actionsApi.catalog(endpointId).then((r) => r.data.data as { configured: boolean; actions: CatalogAction[]; approval: 'direct' | 'signed' | null }),
  });
  // 0.40: the business's approval mode on the signer, read only.
  const directMode = catalog?.approval === 'direct';
  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ['endpoint-actions', endpointId],
    queryFn: () => actionsApi.list(endpointId).then((r) => r.data.data as Job[]),
    refetchInterval: (q) => ((q.state.data as Job[] | undefined)?.some((j) => ['AWAITING_APPROVAL', 'APPROVED', 'DISPATCHED'].includes(j.status)) ? 15_000 : false),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['endpoint-actions', endpointId] });

  // Updates are requested through a staged deployment, never one computer at a time from here.
  const direct = (catalog?.actions ?? []).filter((a) => a.direct);
  const supported = (a: CatalogAction) => agentActions.includes(`${a.id}@${a.version}`);
  const action = direct.find((a) => a.id === picked) ?? direct.find(supported) ?? direct[0];
  const choiceValue = action?.choice ? (action.choice.options.find((o) => String(o.value) === choice) ?? action.choice.options[0]) : null;
  const params = (a: CatalogAction): Record<string, unknown> =>
    FIXED_PARAMS[a.id] ?? (a.choice && choiceValue ? { [a.choice.field]: choiceValue.value } : {});
  const pick = (id: string) => { setPicked(id); setChoice(''); setConfirmed(false); };
  const request = useMutation({
    mutationFn: () => actionsApi.request(endpointId, {
      actionId: action!.id, version: action!.version, params: params(action!), reason: reason.trim(),
      windowHours: Math.min(4, action!.maxWindowHours ?? 4),
    }),
    onSuccess: (r) => {
      setReason(''); setConfirmed(false); refresh();
      const j = r.data?.data as Job | undefined;
      toast(j?.direct ? { title: 'Approved automatically', description: DIRECT_TOAST } : { title: 'Requested', description: 'Nothing runs until the approvers authorize it on the approval page.' });
    },
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

  // The server allows one open request per action per computer.
  const pending = action && jobs.find((j) => j.action.id === action.id && (['AWAITING_APPROVAL', 'APPROVED', 'DISPATCHED'].includes(j.status) || (j.status === 'UNKNOWN' && !j.reconciled)));
  const notSupported = action && !unavailableReason && !supported(action)
    ? 'This computer’s agent does not report support for this action. The maintenance actions need a signed agent from 0.32 on; let it update first.'
    : null;
  const blocked = unavailableReason ?? notSupported;

  return (
    <div className="space-y-4">
      {action && (
        <Card>
          <CardHeader className="pb-3 space-y-2">
            <CardTitle className="text-sm flex items-center gap-2"><Wrench className="h-4 w-4" />Run an approved action</CardTitle>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Action" data-testid="action-picker">
              {direct.map((a) => (
                <Button key={a.id} size="sm" variant={a.id === action.id ? 'default' : 'outline'} role="radio" aria-checked={a.id === action.id}
                  onClick={() => pick(a.id)} data-testid={`pick-${a.id}`}>
                  {a.title}{!supported(a) && <span className="ml-1 text-[10px] opacity-70">(not on this agent)</span>}
                </Button>
              ))}
            </div>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="font-medium">{action.title}</p>
            <p className="text-muted-foreground">{action.description}</p>
            <div className="rounded-md border border-yellow-300 bg-yellow-50 dark:border-yellow-800 dark:bg-yellow-950/40 p-3 space-y-1">
              {action.warnings.map((w) => (
                <p key={w} className="flex gap-2 text-xs"><AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-yellow-600" />{w}</p>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {action.verification} It does not show {action.doesNotProve.join(', ')}.
            </p>
            {directMode ? (
              <p className="text-xs text-muted-foreground flex gap-2" data-testid="direct-mode-note">
                <ShieldCheck className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                {DIRECT_REQUEST_NOTE}
              </p>
            ) : (
            <p className="text-xs text-muted-foreground flex gap-2">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              Requesting runs nothing. People on the approval roster authorize the exact plan with a passkey on the approval page — {action.workstationRisk === 'high'
                ? 'this action always needs two different approvers, whatever the computer'
                : 'one for a standard workstation, two for anything else'}, plus the customer where their policy requires it. You cannot approve your own request.
            </p>
            )}
            {action.requiresCapability && (
              <p className="text-xs text-muted-foreground">Requesting this, and reading what it collects, also needs permission to read this computer’s event logs ({action.requiresCapability}).</p>
            )}
            {pending ? (
              <p className="text-xs">An earlier request for this action is {STATUS[pending.status]?.label.toLowerCase() ?? pending.status}; resolve it before asking again.</p>
            ) : blocked ? (
              <p className="rounded-md border bg-muted/40 p-2 text-xs" data-testid="action-unavailable">
                <strong>Cannot be requested for this computer:</strong> {blocked}
              </p>
            ) : (
              <>
                {action.choice && choiceValue && (
                  <div className="space-y-1">
                    <Label htmlFor="action-choice" className="text-xs">{action.choice.label}</Label>
                    <select id="action-choice" data-testid="action-choice" className="block h-8 rounded-md border bg-background px-2 text-xs"
                      value={String(choiceValue.value)} onChange={(e) => { setChoice(e.target.value); setConfirmed(false); }}>
                      {action.choice.options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
                    </select>
                  </div>
                )}
                <div className="space-y-1">
                  <Label htmlFor="action-reason" className="text-xs">{directMode ? 'Why (recorded in the audit log)' : 'Why (shown to the approvers)'}</Label>
                  <Textarea id="action-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={PLACEHOLDER[action.id] ?? 'e.g. Ticket 42: what is wrong'} />
                </div>
                <label className="flex items-start gap-2 text-xs">
                  <input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                  {action.acknowledge}
                </label>
                <Button size="sm" disabled={!confirmed || reason.trim().length < 3 || request.isPending} onClick={() => request.mutate()}>
                  {request.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}{directMode ? 'Run it' : 'Request approval'}
                </Button>
                {action.maxWindowHours < 4 && !directMode && <p className="text-xs text-muted-foreground">An approved plan for this action is valid for {action.maxWindowHours} hour{action.maxWindowHours === 1 ? '' : 's'} only: approve it promptly, or it expires unrun.</p>}
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
  const rec = reconcileFor(j.action.id, ((j.targets?.[0]?.result ?? j.result) as JobResult | null)?.observed);
  const choices: readonly ('running' | 'stopped' | 'installed' | 'not_installed' | 'restart_scheduled' | 'no_restart_scheduled' | 'other')[] = rec.choices;
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
          <span className="text-xs font-medium">{j.action.title}{j.script ? ` · ${j.script.name} v${j.script.version}` : ''}{typeof j.params?.service === 'string' && j.action.id !== 'windows.service.start' ? ` · ${j.params.service}` : ''}{typeof j.params?.delayMinutes === 'number' ? ` · ${j.params.delayMinutes}-minute warning` : ''}</span>
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
          {j.status === 'AWAITING_APPROVAL' && !j.direct && (
            <Button size="sm" variant="outline" asChild>
              <a href={j.approvalUrl} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-3.5 w-3.5 mr-1" />Open approval page</a>
            </Button>
          )}
          {['AWAITING_APPROVAL', 'APPROVED'].includes(j.status) && <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>}
        </div>
      </div>
      <p className="text-xs">{j.reason}</p>
      <p className="text-xs text-muted-foreground">
        {j.risk === 'high' ? 'Higher impact' : 'Standard workstation'} · {j.direct ? 'direct mode' : <>needs {j.approvalsRequired} approver{j.approvalsRequired > 1 ? 's' : ''}{j.customerSignoff ? ' and customer sign-off' : ''}</>} · may run {formatDate(j.window.notBefore)} – {formatDate(j.window.notAfter)}
      </p>
      {j.direct && <p className="text-xs text-muted-foreground" data-testid="direct-approved">{directApproved(j.requestedByName, j.createdAt)}</p>}
      {oldAgentRefusal(j.direct, mine?.statusReason ?? j.statusReason) && <p className="text-xs" data-testid="old-agent-refusal">{oldAgentRefusal(j.direct, mine?.statusReason ?? j.statusReason)}</p>}
      {j.approvers?.length ? <p className="text-xs text-muted-foreground">Approved by {j.approvers.map((a) => `${a.name}${a.role === 'customer' ? ' (customer)' : ''}`).join(', ')}</p> : null}
      {j.statusReason && <p className="text-xs text-muted-foreground">Reason: {j.statusReason.replace(/_/g, ' ')}</p>}
      {(j.statusReason === 'revoked' || mine?.statusReason === 'revoked') && <p className="text-xs text-muted-foreground">The script or software entry this runs was revoked after the plan was signed, so it will never run here.</p>}
      {(j.ringSize ?? 1) > 1 && mine && <p className="text-xs text-muted-foreground">This computer: {mine.status.toLowerCase().replace(/_/g, ' ')}{mine.statusReason ? ` (${mine.statusReason.replace(/_/g, ' ')})` : ''}</p>}
      {result && (
        <p className="text-xs">
          Computer reported <strong>{outcome?.replace(/_/g, ' ')}</strong>
          {result.reason ? ` (${result.reason.replace(/_/g, ' ')})` : ''}
          {result.observed && !isUpdate ? ` — observed: ${Object.entries(result.observed).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}
          {RESULT_CAVEAT[j.action.id] ?? '.'}
        </p>
      )}
      {result?.detail && !isUpdate && <p className="text-xs text-muted-foreground">{result.detail}</p>}
      {result?.logsWithheld && <p className="text-xs text-muted-foreground" data-testid="logs-withheld">{result.logsWithheld}</p>}
      {result?.logs?.length ? (
        <div className="space-y-1" data-testid="collected-logs">
          {result.logs.map((l) => (
            <details key={l.source} className="rounded border">
              <summary className="cursor-pointer px-2 py-1 text-xs">
                {LOG_LABEL[l.source] ?? l.source}
                <span className="text-muted-foreground"> · {l.text.length.toLocaleString()} characters{l.truncated ? ', shortened' : ''}{l.note ? ` · ${l.note}` : ''}</span>
              </summary>
              {l.text ? <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all border-t bg-muted/30 p-2 text-[11px] leading-snug">{l.text}</pre> : null}
            </details>
          ))}
        </div>
      ) : null}
      {j.action.id === SCRIPT_ACTION && mine?.scriptOutput !== undefined && <ScriptOutputView out={mine.scriptOutput} />}
      {result?.updates?.length ? (
        <ul className="text-xs list-disc pl-5">
          {result.updates.map((u) => <li key={u.updateId}>{u.kb ?? u.updateId}: {u.state.replace(/_/g, ' ')}{u.reason ? ` — ${u.reason}` : ''}{u.hresult && u.state === 'failed' ? ` (${u.hresult})` : ''}</li>)}
        </ul>
      ) : null}
      <p className="text-[11px] text-muted-foreground font-mono break-all">plan {j.digest}</p>
      {uncertain && (
        <div className="rounded-md border border-destructive/40 p-2 space-y-2">
          <p className="text-xs">{rec.text}</p>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {rec.label}
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

function ScriptOutputView({ out }: { out: ScriptOutput | { pruned: true } | null }) {
  if (!out) return null;
  if ('pruned' in out) return <p className="text-xs text-muted-foreground" data-testid="script-output-pruned">Output pruned: run output is kept for 90 days.</p>;
  const stream = (label: string, text: string, bytes: number, truncated: boolean) => (
    <details className="rounded border">
      <summary className="cursor-pointer px-2 py-1 text-xs">
        {label}<span className="text-muted-foreground"> · {bytes.toLocaleString()} bytes{truncated ? ', first 64 KB kept' : ''}</span>
      </summary>
      {text ? <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all border-t bg-muted/30 p-2 text-[11px] leading-snug">{text}</pre> : <p className="border-t p-2 text-xs text-muted-foreground">Empty.</p>}
    </details>
  );
  return (
    <div className="space-y-1" data-testid="script-output">
      <p className="text-xs">
        {out.timedOut ? 'Stopped at its timeout' : `Exit code ${out.exitCode ?? 'unknown'}`}
        {out.durationMs !== null ? ` · ran ${(out.durationMs / 1000).toFixed(1)} s` : ''}
        <span className="text-muted-foreground"> · redacted on the computer and again on receipt</span>
      </p>
      {stream('Output', out.stdout, out.stdoutBytes, out.stdoutTruncated)}
      {stream('Errors', out.stderr, out.stderrBytes, out.stderrTruncated)}
    </div>
  );
}
