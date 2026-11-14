'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ExternalLink, Loader2, Lock } from 'lucide-react';
import { actionsApi, api } from '@/lib/api-client';
import { DIRECT_REQUEST_NOTE, DIRECT_TOAST, oldAgentRefusal } from '@/lib/direct-mode';
import { useToast } from '@/hooks/use-toast';
import { useApprovalMode } from '@/hooks/use-approval-mode';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ago } from './device-model';

/**
 * Service control and End process on the Services and Processes tabs (0.45):
 * windows.service.control@1 and windows.process.stop@1.
 *
 * A button appears only when the server says a request is possible on this
 * computer and the row is not protected; a protected row says why. The rules
 * that decide it are the server's (GET /endpoints/:id/device-control hands
 * over the lists) and are applied again by the server when the request
 * arrives, and once more by the computer. In direct mode (the approval
 * signer's setting, 0.40) the request is signed at once after a fresh
 * sign-in; otherwise it waits for two approvers.
 *
 * Editing a service means its startup type only. Its program, account,
 * password, recovery actions and dependencies cannot be changed from here:
 * each of those would let whoever changes it run anything as SYSTEM.
 *
 * When a request finishes, the tab asks for a fresh snapshot (POST
 * /diagnostics/runs, as Refresh does), so the list shows what changed.
 */

export interface Availability { possible: boolean; reason: string | null; fix: string | null }
interface Recent {
  jobId: string; actionId: string; params: Record<string, unknown> | null; jobStatus: string; status: string; reason: string | null; outcome: string | null;
  observed: Record<string, string> | null; detail: string | null; at: string;
}
export interface DeviceControl {
  service: Availability; process: Availability; approval: 'direct' | 'signed' | null; unproven: string;
  protected: { services: string[]; ownServicePrefix: string; keepRunning: string[]; noDisable: string[]; processes: string[]; maxTree: number };
  recent: Recent[];
}
interface CatalogAction { id: string; title: string; description: string; warnings: string[]; acknowledge: string; verification: string; doesNotProve: string[] }

export const SERVICE_ACTION = 'windows.service.control';
export const PROCESS_ACTION = 'windows.process.stop';
const OPEN = ['PENDING', 'DISPATCHED', 'UNKNOWN'];
const OPEN_JOB = ['AWAITING_APPROVAL', 'APPROVED', 'DISPATCHED'];

/** The charsets the actions accept (the same as the API's SERVICE_NAME_RE / PROCESS_NAME_RE). */
const SERVICE_NAME_RE = /^[A-Za-z0-9_]{1,64}$/;
// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const SERVICE_DISPLAY_NAME_RE = /^[^\x00-\x1f\x7f"<>\\]{1,256}$/;
const PROCESS_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.()+-]{0,63}$/;

export type ServiceOp = 'start' | 'stop' | 'restart' | 'set_start_type';
export type StartType = 'automatic' | 'automatic_delayed' | 'manual' | 'disabled';
export const START_TYPES: { value: StartType; label: string; snapshot: string }[] = [
  { value: 'automatic', label: 'Automatic', snapshot: 'Automatic' },
  { value: 'automatic_delayed', label: 'Automatic (delayed start)', snapshot: 'AutomaticDelayedStart' },
  { value: 'manual', label: 'Manual', snapshot: 'Manual' },
  { value: 'disabled', label: 'Disabled', snapshot: 'Disabled' },
];
export const NOT_EDITABLE = 'Only the startup type can be changed here. The program a service runs, the account and password it runs as, its recovery actions and its dependencies are never changed from rem0te: each of those would let whoever changes it run anything as SYSTEM.';

const fold = (l: string[], s: string) => l.some((x) => x.toLowerCase() === s.toLowerCase());

/** The server's serviceRefusal, from the lists it handed over. Display only: the server decides. */
export function serviceRefusal(c: DeviceControl, name: string, op: ServiceOp, startType?: StartType): string | null {
  const p = c.protected;
  if (name.slice(0, p.ownServicePrefix.length).toLowerCase() === p.ownServicePrefix.toLowerCase()) return 'Rem0te’s own service: never changed from here.';
  if (fold(p.services, name)) return 'A protected security or core Windows service: stopping, restarting or reconfiguring it can leave the computer unprotected, unbootable or unreachable.';
  if (fold(p.keepRunning, name) && (op === 'stop' || (op === 'set_start_type' && startType !== 'automatic' && startType !== 'automatic_delayed'))) return 'RustDesk is how this computer is reached: never stopped or set to Manual or Disabled from here.';
  if (fold(p.noDisable, name) && op === 'set_start_type' && startType === 'disabled') return 'A Windows Update service: never disabled from here.';
  return null;
}
const base = (n: string) => (n.length > 4 && n.slice(-4).toLowerCase() === '.exe' ? n.slice(0, -4) : n);
/** The server's processRefusal. Display only. */
export function processRefusal(c: DeviceControl, name: string, pid: number | null): string | null {
  const b = base(name.trim()).toLowerCase();
  if (pid === 0 || pid === 4) return 'The kernel’s own process; it cannot be ended.';
  if (b === 'svchost') return 'svchost hosts Windows services: stop the service instead, from the Services tab.';
  if (b === 'rem0te-agent' || b === 'rem0te-tray' || b === 'rustdesk') return 'Rem0te and RustDesk are how this computer is reached; never ended from here.';
  if (fold(c.protected.processes, b)) return 'A protected Windows or security process: ending it can stop Windows, sign everyone out or leave the computer unprotected.';
  return null;
}

export interface SvcRow { name: string; displayName: string | null; state: string; startMode: string; account: string | null }
/** What can be asked for on one service row, or why nothing can. */
export function serviceOptions(c: DeviceControl, v: SvcRow): { ops: ServiceOp[]; startTypes: StartType[]; protectedWhy: string | null; unusable: string | null } {
  if (!SERVICE_NAME_RE.test(v.name)) return { ops: [], startTypes: [], protectedWhy: null, unusable: 'Its name has characters this action does not accept.' };
  if (!v.displayName || !SERVICE_DISPLAY_NAME_RE.test(v.displayName) || v.displayName.trim() !== v.displayName) return { ops: [], startTypes: [], protectedWhy: null, unusable: 'Its display name was not reported in a form the computer can check.' };
  if (v.startMode === 'Boot' || v.startMode === 'System') return { ops: [], startTypes: [], protectedWhy: 'Started by Windows at boot: not changed from here.', unusable: null };
  const ops: ServiceOp[] = [];
  const running = v.state === 'Running';
  if (!running && v.state !== 'StartPending' && v.startMode !== 'Disabled' && !serviceRefusal(c, v.name, 'start')) ops.push('start');
  if (running && !serviceRefusal(c, v.name, 'stop')) ops.push('stop');
  if (running && !serviceRefusal(c, v.name, 'restart')) ops.push('restart');
  const startTypes = START_TYPES.filter((t) => t.snapshot !== v.startMode && !serviceRefusal(c, v.name, 'set_start_type', t.value)).map((t) => t.value);
  // "Protected" when the server refuses the stop (or everything): say why on the row.
  const protectedWhy = serviceRefusal(c, v.name, 'stop') ?? serviceRefusal(c, v.name, 'set_start_type', 'disabled');
  return { ops, startTypes, protectedWhy, unusable: null };
}

export interface ProcRow { name: string; pid: number | null; cpuSeconds: number | null; workingSetBytes: number | null; user: string | null; startedAt: string | null }
export function processOption(c: DeviceControl, p: ProcRow): { ok: boolean; why: string | null; protectedWhy: string | null } {
  const prot = processRefusal(c, p.name, p.pid);
  if (prot) return { ok: false, why: null, protectedWhy: prot };
  if (p.pid === null || !p.startedAt) return { ok: false, why: 'Windows did not let the agent read when it started, so it cannot be told apart from a later process with the same id.', protectedWhy: null };
  if (!PROCESS_NAME_RE.test(p.name)) return { ok: false, why: 'Its name has characters this action does not accept.', protectedWhy: null };
  return { ok: true, why: null, protectedWhy: null };
}

export function useDeviceControl(endpointId: string) {
  return useQuery({
    queryKey: ['device-control', endpointId],
    queryFn: () => api.get(`/endpoints/${endpointId}/device-control`).then((r) => r.data?.data as DeviceControl),
    // While a request is on its way, often; otherwise with the snapshot.
    refetchInterval: (q) => (q.state.data?.recent.some((r) => OPEN.includes(r.status) && OPEN_JOB.includes(r.jobStatus)) ? 5_000 : 30_000),
  });
}

/**
 * When one of this tab's requests reaches its result, ask for a fresh
 * snapshot once, as Refresh would, so the list shows what changed.
 */
export function useRefreshAfterResult(endpointId: string, c: DeviceControl | undefined, actionId: string, snapKey: 'service_list' | 'process_list') {
  const qc = useQueryClient();
  const seen = useRef<Map<string, boolean> | null>(null);
  useEffect(() => {
    if (!c) return;
    const mine = c.recent.filter((r) => r.actionId === actionId);
    if (!seen.current) { seen.current = new Map(mine.map((r) => [r.jobId, !!r.outcome])); return; }
    let fire = false;
    for (const r of mine) {
      const before = seen.current.get(r.jobId);
      if (r.outcome && before === false) fire = true;
      seen.current.set(r.jobId, !!r.outcome);
    }
    if (fire) {
      api.post(`/endpoints/${endpointId}/diagnostics/runs`, { key: snapKey }).catch(() => undefined)
        .finally(() => qc.invalidateQueries({ queryKey: ['diagnostics-snapshot', endpointId, snapKey] }));
    }
  }, [c, actionId, snapKey, endpointId, qc]);
}

const errText = (e: unknown, fallback: string) => {
  const d = (e as { response?: { data?: { message?: unknown; fix?: string } } })?.response?.data;
  const m = typeof d?.message === 'string' ? d.message : (d?.message as { message?: string } | undefined)?.message;
  return [m ?? fallback, d?.fix].filter(Boolean).join(' ');
};

/** Above the table: whether anything can be asked for, the mode, and that this has not run on real Windows. */
export function ControlBanner({ c, which }: { c: DeviceControl; which: 'service' | 'process' }) {
  const a = which === 'service' ? c.service : c.process;
  return (
    <div className="space-y-1 text-xs" data-testid={`control-banner-${which}`}>
      {a.possible
        ? <p className="text-muted-foreground">{which === 'service' ? 'Start, stop, restart or change a service’s startup type' : 'End a process'} from its row. {c.approval === 'direct' ? 'Direct mode: a request runs at the computer’s next check-in.' : 'Each request waits for two approvers on the approval page.'}</p>
        : <p className="text-amber-700 dark:text-amber-400 flex items-start gap-1" data-testid="control-unavailable"><AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" />{a.reason}{a.fix ? ` ${a.fix}` : ''}</p>}
      <p className="text-amber-700 dark:text-amber-400" data-testid="control-unproven">{c.unproven}</p>
    </div>
  );
}

export function ProtectedBadge({ why }: { why: string }) {
  return <Badge variant="outline" className="gap-1 font-normal whitespace-nowrap" title={why} data-testid="protected"><Lock className="h-3 w-3" />Protected</Badge>;
}

/** The last result of this tab's requests on one row, in words. */
export function LastResult({ r }: { r: Recent | undefined }) {
  if (!r) return null;
  const open = !r.outcome && OPEN.includes(r.status) && OPEN_JOB.includes(r.jobStatus);
  const old = oldAgentRefusal(true, r.reason);
  return (
    <p className="text-[11px] text-muted-foreground" data-testid="control-last" title={r.detail ?? undefined}>
      {open ? (r.jobStatus === 'AWAITING_APPROVAL' ? 'Awaiting approval' : 'Waiting for the computer’s next check-in')
        : `${(r.outcome ?? r.status).toLowerCase().replace(/_/g, ' ')}${r.reason ? ` (${r.reason.replace(/_/g, ' ')})` : ''} ${ago(r.at)}`}
      {old ? ` — ${old}` : ''}
    </p>
  );
}

/** One request: the action's own warnings and terms, a reason, the window, and Run or Request. */
export function ControlDialog({ endpointId, actionId, title, children, valid = true, send, onClose }: {
  endpointId: string; actionId: string; title: string; children?: React.ReactNode; valid?: boolean;
  send: (reason: string | undefined, windowHours: number) => Promise<unknown>; onClose: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const mode = useApprovalMode({ endpointId });
  const [reason, setReason] = useState('');
  const [windowHours, setWindowHours] = useState(1);
  const [ack, setAck] = useState(false);
  const [done, setDone] = useState<{ approvalUrl: string | null; direct: boolean } | null>(null);
  const { data: catalog } = useQuery({
    queryKey: ['actions-catalog', endpointId],
    queryFn: () => actionsApi.catalog(endpointId).then((r) => r.data.data as { actions: CatalogAction[]; approval: 'direct' | 'signed' | null }),
  });
  const isDirect = (catalog?.approval ?? mode) === 'direct';
  const action = catalog?.actions.find((a) => a.id === actionId);
  const m = useMutation({
    mutationFn: () => send(reason.trim() || undefined, windowHours) as Promise<{ data: { data: { job?: { approvalUrl?: string; direct?: boolean } } } }>,
    onSuccess: (r) => {
      const j = r.data.data.job;
      setDone({ approvalUrl: j?.approvalUrl ?? null, direct: !!j?.direct });
      toast(j?.direct ? { title: 'Approved automatically', description: DIRECT_TOAST } : { title: 'Requested', description: 'Nothing runs until two approvers authorize it on the approval page.' });
      qc.invalidateQueries({ queryKey: ['device-control', endpointId] });
      qc.invalidateQueries({ queryKey: ['endpoint-actions', endpointId] });
    },
    onError: (e) => toast({ title: 'Not requested', description: errText(e, 'The request was refused.'), variant: 'destructive' }),
  });
  const reasonOk = reason.trim().length === 0 || reason.trim().length >= 3;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg" data-testid="control-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{action?.description ?? 'Loading…'}</DialogDescription>
        </DialogHeader>
        {done ? (
          <div className="space-y-2 text-sm" data-requested>
            {done.direct
              ? <p data-testid="direct-approved">{DIRECT_TOAST}</p>
              : <p>Requested. Nothing runs until two people on the approval roster approve it; you cannot approve your own request.</p>}
            {done.approvalUrl && !done.direct && <p><a className="underline inline-flex items-center gap-1" href={done.approvalUrl} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-3.5 w-3.5" />Open the approval page</a></p>}
            <p className="text-xs text-muted-foreground">The row shows the result when the computer reports it, and the list is refreshed then.</p>
            <DialogFooter><Button size="sm" onClick={onClose}>Close</Button></DialogFooter>
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            {isDirect && <p className="text-xs text-muted-foreground" data-testid="direct-mode-note">{DIRECT_REQUEST_NOTE}</p>}
            {children}
            {action && <ul className="list-disc pl-5 text-xs space-y-1">{action.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
            {action && <p className="text-xs text-muted-foreground">{action.verification} It does not prove {action.doesNotProve.join(', ')}.</p>}
            <div className="space-y-1">
              <Label htmlFor="dc-reason" className="text-xs">{isDirect ? 'Why (recorded in the audit log)' : 'Why (shown to the approvers)'} — optional</Label>
              <Textarea id="dc-reason" rows={2} maxLength={400} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <div className="space-y-1 w-48">
              <Label htmlFor="dc-window" className="text-xs">May run within (hours, 1–4)</Label>
              <Input id="dc-window" type="number" min={1} max={4} value={windowHours} onChange={(e) => setWindowHours(Number(e.target.value))} />
            </div>
            {action ? (
              <label className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="control-ack" />{action.acknowledge}</label>
            ) : <p className="text-xs text-muted-foreground">Loading the action&apos;s terms…</p>}
            <DialogFooter>
              <Button size="sm" variant="outline" onClick={onClose}>Cancel</Button>
              <Button size="sm" data-testid="control-submit" disabled={!action || !ack || !valid || !reasonOk || windowHours < 1 || windowHours > 4 || m.isPending} onClick={() => m.mutate()}>
                {m.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}{isDirect ? 'Run it' : 'Request it'}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export const serviceControl = (endpointId: string, body: { service: string; displayName: string; op: ServiceOp; startType?: StartType; reason?: string; windowHours: number }) =>
  api.post(`/endpoints/${endpointId}/services/control`, body);
export const processStop = (endpointId: string, body: { pid: number; name: string; startedAt: string; tree?: boolean; reason?: string; windowHours: number }) =>
  api.post(`/endpoints/${endpointId}/processes/stop`, body);

/** The newest request of this action naming this row (by service name, or by pid and start time). */
export function lastFor(c: DeviceControl | undefined, actionId: string, match: (p: Record<string, unknown>) => boolean): Recent | undefined {
  return c?.recent.find((r) => r.actionId === actionId && !!r.params && match(r.params));
}
