'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { api, endpointsApi, quickConnectApi, supportRequestsApi } from '@/lib/api-client';
import { usePermissions, CAP } from '@/lib/auth';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { SessionStatusBadge } from '@/components/sessions/session-status-badge';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/utils';
import { Inbox, RefreshCw, PlayCircle, Zap, Monitor } from 'lucide-react';

/** Shapes from apps/api/src/support-requests/support-requests.service.ts. */
type RequestStatus = 'WAITING' | 'CLAIMED' | 'CONNECTING' | 'COMPLETED' | 'CANCELED' | 'EXPIRED';
type Person = { id: string; firstName: string | null; lastName: string | null; email: string };
interface SupportRequest {
  id: string;
  customerId: string;
  origin: 'PUBLIC' | 'PORTAL' | string;
  status: RequestStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  description: string | null;
  reportedRustdeskId: string | null;
  endpointId: string | null;
  claimedAt: string | null;
  closedAt: string | null;
  outcome: string | null;
  customer: { id: string; name: string };
  claimedBy: Person | null;
  computer: { id: string; name: string } | null;
  claimedByMe?: boolean;
}
interface SupportRequestDetail extends SupportRequest {
  claimedById: string | null;
  events: { id: string; event: string; actorId: string | null; detail: Record<string, unknown> | null; createdAt: string }[];
  sessions: { id: string; status: string; createdAt: string; isAdHoc: boolean }[];
}

const STATUS_LABEL: Record<RequestStatus, string> = {
  WAITING: 'Waiting',
  CLAIMED: 'Claimed',
  CONNECTING: 'Connecting',
  COMPLETED: 'Completed',
  CANCELED: 'Canceled',
  EXPIRED: 'Expired',
};

const STATUS_CLASS: Record<RequestStatus, string> = {
  WAITING: 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900 dark:text-amber-100 dark:border-amber-800',
  CLAIMED: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900 dark:text-blue-100 dark:border-blue-800',
  CONNECTING: 'bg-sky-50 text-sky-800 border-sky-200 dark:bg-sky-950 dark:text-sky-200 dark:border-sky-900',
  COMPLETED: 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900 dark:text-green-100 dark:border-green-800',
  CANCELED: 'bg-muted text-muted-foreground border-border',
  EXPIRED: 'bg-muted text-muted-foreground border-border border-dashed',
};

const EVENT_LABEL: Record<string, string> = {
  submitted: 'Submitted',
  claimed: 'Claimed',
  handed_off: 'Handed off',
  released: 'Released back to the queue',
  completed: 'Completed',
  canceled: 'Canceled',
};

const FILTERS: { value: string; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'WAITING', label: 'Waiting' },
  { value: 'CLAIMED', label: 'Claimed' },
  { value: 'CONNECTING', label: 'Connecting' },
  { value: 'closed', label: 'Closed' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'CANCELED', label: 'Canceled' },
  { value: 'EXPIRED', label: 'Expired' },
];

const OPEN: RequestStatus[] = ['WAITING', 'CLAIMED', 'CONNECTING'];

function personName(p: Person | null | undefined) {
  return p ? ([p.firstName, p.lastName].filter(Boolean).join(' ') || p.email) : '—';
}

function apiError(e: unknown): { status?: number; message: string } {
  const r = (e as { response?: { status?: number; data?: { message?: string | string[] } } })?.response;
  return { status: r?.status, message: r?.data?.message?.toString() ?? 'The request failed' };
}

function RequestStatusBadge({ status }: { status: RequestStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap ${STATUS_CLASS[status] ?? STATUS_CLASS.CANCELED}`}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export default function SupportRequestsPage() {
  const { can, isLoading: permsLoading, isPlatformAdmin } = usePermissions();
  const [filter, setFilter] = useState('open');
  const [mine, setMine] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const allowed = can(CAP.SUPPORT_REQUESTS);

  const { data, isLoading, isFetching, refetch } = useQuery<SupportRequest[]>({
    queryKey: ['support-requests', filter, mine],
    queryFn: () => supportRequestsApi.list({ status: filter, mine }).then((r) => r.data?.data ?? []),
    enabled: allowed,
    refetchInterval: 15_000,
  });
  const rows = data ?? [];

  if (permsLoading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  if (!allowed) {
    return (
      <div className="p-6">
        <PageHeader title="Support Requests" />
        <p className="text-sm text-muted-foreground">You do not have permission to handle support requests.</p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Support Requests" description="People waiting for help. Claim one to work on it.">
        <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-3">
        <div className="w-44">
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger aria-label="Status filter"><SelectValue /></SelectTrigger>
            <SelectContent>
              {FILTERS.map((f) => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
          <input type="checkbox" className="h-4 w-4 accent-primary" checked={mine} onChange={(e) => setMine(e.target.checked)} />
          Claimed by me
        </label>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center space-y-2 text-sm text-muted-foreground">
            <Inbox className="h-8 w-8 mx-auto opacity-40" />
            <p>No requests here.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="rounded-md border bg-background overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left px-4 py-2 font-medium text-xs">Who</th>
                {isPlatformAdmin && <th className="text-left px-4 py-2 font-medium text-xs">Business</th>}
                <th className="text-left px-4 py-2 font-medium text-xs">Request</th>
                <th className="text-left px-4 py-2 font-medium text-xs">Computer</th>
                <th className="text-left px-4 py-2 font-medium text-xs">Status</th>
                <th className="text-left px-4 py-2 font-medium text-xs">Submitted</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="hover:bg-muted/30 cursor-pointer"
                  onClick={() => setSelectedId(r.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter') setSelectedId(r.id); }}
                  tabIndex={0}
                >
                  <td className="px-4 py-3 align-top">
                    <p className="font-medium">{r.contactName ?? '—'}</p>
                    <p className="text-xs text-muted-foreground">{r.origin === 'PUBLIC' ? 'Public form' : 'Signed-in user'}</p>
                  </td>
                  {isPlatformAdmin && <td className="px-4 py-3 align-top text-muted-foreground">{r.customer?.name}</td>}
                  <td className="px-4 py-3 align-top max-w-md">
                    <p className="line-clamp-2">{r.description ?? '—'}</p>
                  </td>
                  <td className="px-4 py-3 align-top text-xs">
                    {r.computer ? (
                      <span className="inline-flex items-center gap-1"><Monitor className="h-3 w-3" />{r.computer.name}</span>
                    ) : r.reportedRustdeskId ? (
                      <span className="font-mono text-muted-foreground">ID {r.reportedRustdeskId}</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 align-top">
                    <RequestStatusBadge status={r.status} />
                    {r.claimedBy && (
                      <p className="text-xs text-muted-foreground mt-1">{r.claimedByMe ? 'You' : personName(r.claimedBy)}</p>
                    )}
                  </td>
                  <td className="px-4 py-3 align-top text-xs text-muted-foreground">{formatDate(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedId && (
        <RequestDetailDialog id={selectedId} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}

type Dialogs = null | 'handoff' | 'complete' | 'cancel' | 'quick';

function RequestDetailDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { user, can, isBusinessOwner, technician } = usePermissions();
  const [sub, setSub] = useState<Dialogs>(null);

  const { data: r, isLoading, isError, error } = useQuery<SupportRequestDetail>({
    queryKey: ['support-request', id],
    queryFn: () => supportRequestsApi.get(id).then((res) => res.data?.data),
    refetchInterval: 15_000,
    retry: false,
  });

  const { data: qcStatus } = useQuery<{ canUse?: boolean }>({
    queryKey: ['quick-connect', 'status'],
    queryFn: () => quickConnectApi.status().then((res) => res.data?.data),
    enabled: can(CAP.QUICK_CONNECT),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['support-requests'] });
    qc.invalidateQueries({ queryKey: ['support-request', id] });
  };

  // Every change carries the version we loaded. A 409 means someone else got
  // there first: say what the API said and reload.
  const onActionError = (title: string) => (e: unknown) => {
    const err = apiError(e);
    toast({ title, description: err.message, variant: 'destructive' });
    refresh();
  };

  const claim = useMutation({
    mutationFn: () => supportRequestsApi.claim(id, r!.version),
    onSuccess: () => { toast({ title: 'Claimed' }); refresh(); },
    onError: onActionError('Could not claim'),
  });
  const release = useMutation({
    mutationFn: () => supportRequestsApi.release(id, r!.version),
    onSuccess: () => { toast({ title: 'Released back to the queue' }); refresh(); },
    onError: onActionError('Could not release'),
  });

  // Managed computer: the endpoint connect flow, linked to this request. The
  // API records one session and moves the request to CONNECTING; the script
  // reuses that session.
  const connectManaged = useMutation({
    mutationFn: (endpointId: string) =>
      api.post(`/endpoints/${endpointId}/connect`, undefined, { params: { supportRequestId: id } }),
    onSuccess: async (res, endpointId) => {
      const info = res.data?.data as { rustdeskId?: string; sessionId?: string | null } | undefined;
      if (!info?.rustdeskId) {
        toast({ title: 'Computer not ready', description: 'This computer has not finished enrollment.', variant: 'destructive' });
        return;
      }
      const url = endpointsApi.connectScriptUrl(endpointId);
      window.location.href = info.sessionId ? `${url}?session=${encodeURIComponent(info.sessionId)}` : url;
      refresh();
    },
    onError: onActionError('Could not connect'),
  });

  const status = r?.status;
  const isOpen = !!status && OPEN.includes(status);
  const claimedByMe = !!r && !!user && r.claimedById === user.id;
  const ownerHere = isBusinessOwner && !technician;
  const held = status === 'CLAIMED' || status === 'CONNECTING';
  const canManage = claimedByMe || ownerHere;

  const showClaim = status === 'WAITING';
  const showHandoff = held && canManage;
  const showRelease = held && canManage;
  const showComplete = held && canManage;
  const showCancel = isOpen && (canManage || (status === 'WAITING' && ownerHere));
  const showConnectManaged = held && claimedByMe && !!r?.computer && can(CAP.COMPUTERS_CONNECT);
  const showQuickConnect = held && claimedByMe && can(CAP.QUICK_CONNECT) && !!qcStatus?.canUse;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            Support request
            {r && <RequestStatusBadge status={r.status} />}
          </DialogTitle>
          <DialogDescription>
            {r ? `${r.customer?.name ?? ''} · submitted ${formatDate(r.createdAt)}` : ' '}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : isError || !r ? (
          <p className="text-sm text-destructive">{apiError(error).message}</p>
        ) : (
          <div className="space-y-5 text-sm">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
              <Field label="Name">{r.contactName ?? '—'}</Field>
              <Field label="From">{r.origin === 'PUBLIC' ? 'Public form' : 'Signed-in user'}</Field>
              <Field label="Email">{r.contactEmail ? <a className="underline underline-offset-2" href={`mailto:${r.contactEmail}`}>{r.contactEmail}</a> : '—'}</Field>
              <Field label="Phone">{r.contactPhone ? <a className="underline underline-offset-2" href={`tel:${r.contactPhone}`}>{r.contactPhone}</a> : '—'}</Field>
              <Field label="Claimed by">{r.claimedBy ? (claimedByMe ? 'You' : personName(r.claimedBy)) : '—'}</Field>
              <Field label="Remote ID they entered">{r.reportedRustdeskId ? <span className="font-mono">{r.reportedRustdeskId}</span> : '—'}</Field>
            </div>

            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Description</p>
              <p className="whitespace-pre-wrap">{r.description ?? '—'}</p>
            </div>

            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Matched computer</p>
              {r.computer ? (
                <Link href={`/endpoints/${r.computer.id}`} className="inline-flex items-center gap-1 hover:underline">
                  <Monitor className="h-3.5 w-3.5" />{r.computer.name}
                </Link>
              ) : (
                <p className="text-muted-foreground">
                  None you can reach.{r.reportedRustdeskId ? ' The ID they entered is not an enrolled computer you have access to.' : ''}
                </p>
              )}
            </div>

            {r.outcome && (
              <Field label="Outcome">{r.outcome}</Field>
            )}

            {r.sessions.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sessions</p>
                <ul className="space-y-1.5">
                  {r.sessions.map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center gap-2">
                      <SessionStatusBadge status={s.status} />
                      <span className="text-xs text-muted-foreground">{s.isAdHoc ? 'Quick Connect' : 'Managed computer'} · {formatDate(s.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">History</p>
              <ol className="relative border-l pl-4 space-y-2">
                {r.events.map((e) => {
                  const note = e.detail && typeof e.detail.note === 'string' ? e.detail.note : null;
                  const outcome = e.detail && typeof e.detail.outcome === 'string' ? e.detail.outcome : null;
                  return (
                    <li key={e.id} className="relative">
                      <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-background bg-primary" aria-hidden="true" />
                      <p>{EVENT_LABEL[e.event] ?? e.event}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatDate(e.createdAt)}{note ? ` · ${note}` : ''}{outcome ? ` · ${outcome}` : ''}
                      </p>
                    </li>
                  );
                })}
              </ol>
            </div>

            {held && claimedByMe && !showConnectManaged && !showQuickConnect && (
              <p className="text-xs text-muted-foreground rounded-md border bg-muted/40 px-3 py-2">
                No connection option is available to you for this request.
                {!r.computer ? ' It has no computer you can reach' : ''}
                {!r.computer && !(can(CAP.QUICK_CONNECT) && qcStatus?.canUse) ? ', and Quick Connect is not available to you.' : '.'}
              </p>
            )}
          </div>
        )}

        {r && (
          <DialogFooter className="flex-wrap gap-2 sm:justify-between">
            <div className="flex flex-wrap gap-2">
              {showConnectManaged && r.computer && (
                <Button size="sm" onClick={() => connectManaged.mutate(r.computer!.id)} disabled={connectManaged.isPending}>
                  <PlayCircle className="h-3.5 w-3.5 mr-1" />
                  Connect to {r.computer.name}
                </Button>
              )}
              {showQuickConnect && (
                <Button size="sm" variant={showConnectManaged ? 'outline' : 'default'} onClick={() => setSub('quick')}>
                  <Zap className="h-3.5 w-3.5 mr-1" />
                  Quick Connect
                </Button>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {showClaim && (
                <Button size="sm" onClick={() => claim.mutate()} disabled={claim.isPending}>
                  {claim.isPending ? 'Claiming…' : 'Claim'}
                </Button>
              )}
              {showHandoff && <Button size="sm" variant="outline" onClick={() => setSub('handoff')}>Hand off…</Button>}
              {showRelease && (
                <Button size="sm" variant="outline" onClick={() => release.mutate()} disabled={release.isPending}>Release</Button>
              )}
              {showComplete && <Button size="sm" variant="outline" onClick={() => setSub('complete')}>Complete…</Button>}
              {showCancel && (
                <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setSub('cancel')}>
                  Cancel…
                </Button>
              )}
            </div>
          </DialogFooter>
        )}

        {r && sub === 'handoff' && (
          <HandoffDialog request={r} onClose={() => setSub(null)} onDone={refresh} onError={onActionError('Could not hand off')} />
        )}
        {r && (sub === 'complete' || sub === 'cancel') && (
          <CloseDialog kind={sub} request={r} onClose={() => setSub(null)} onDone={refresh} onError={onActionError(sub === 'complete' ? 'Could not complete' : 'Could not cancel')} />
        )}
        {r && sub === 'quick' && (
          <QuickConnectDialog request={r} onClose={() => setSub(null)} onDone={refresh} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function HandoffDialog({
  request, onClose, onDone, onError,
}: { request: SupportRequestDetail; onClose: () => void; onDone: () => void; onError: (e: unknown) => void }) {
  const { toast } = useToast();
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const { data: candidates, isLoading } = useQuery<{ userId: string; name: string; email: string }[]>({
    queryKey: ['support-request', request.id, 'handoff-candidates'],
    queryFn: () => supportRequestsApi.handoffCandidates(request.id).then((r) => r.data?.data ?? []),
  });
  const handoff = useMutation({
    mutationFn: () => supportRequestsApi.handoff(request.id, request.version, to, note.trim() || undefined),
    onSuccess: () => { toast({ title: 'Handed off' }); onDone(); onClose(); },
    onError: (e) => { onError(e); onClose(); },
  });
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Hand off request</DialogTitle>
          <DialogDescription>Only people who can handle support requests for this business are listed.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : !candidates?.length ? (
            <p className="text-sm text-muted-foreground">Nobody else can take this request right now.</p>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="ho-to">Hand to</Label>
              <Select value={to} onValueChange={setTo}>
                <SelectTrigger id="ho-to"><SelectValue placeholder="Choose a person" /></SelectTrigger>
                <SelectContent>
                  {candidates.map((c) => (
                    <SelectItem key={c.userId} value={c.userId}>{c.name}{c.name !== c.email ? ` (${c.email})` : ''}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="ho-note">Note (optional)</Label>
            <Textarea id="ho-note" rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={handoff.isPending}>Cancel</Button>
          <Button onClick={() => handoff.mutate()} disabled={!to || handoff.isPending}>
            {handoff.isPending ? 'Handing off…' : 'Hand off'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CloseDialog({
  kind, request, onClose, onDone, onError,
}: {
  kind: 'complete' | 'cancel'; request: SupportRequestDetail;
  onClose: () => void; onDone: () => void; onError: (e: unknown) => void;
}) {
  const { toast } = useToast();
  const [outcome, setOutcome] = useState('');
  const close = useMutation({
    mutationFn: () => (kind === 'complete'
      ? supportRequestsApi.complete(request.id, request.version, outcome.trim() || undefined)
      : supportRequestsApi.cancel(request.id, request.version, outcome.trim() || undefined)),
    onSuccess: () => { toast({ title: kind === 'complete' ? 'Request completed' : 'Request canceled' }); onDone(); onClose(); },
    onError: (e) => { onError(e); onClose(); },
  });
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{kind === 'complete' ? 'Complete request' : 'Cancel request'}</DialogTitle>
          <DialogDescription>
            {kind === 'complete'
              ? 'Closes the request. Any session stays as it is; close that from Sessions.'
              : 'Closes the request without completing it.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="cl-outcome">Outcome (optional)</Label>
          <Textarea id="cl-outcome" rows={2} maxLength={300} value={outcome} onChange={(e) => setOutcome(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={close.isPending}>Back</Button>
          <Button variant={kind === 'cancel' ? 'destructive' : 'default'} onClick={() => close.mutate()} disabled={close.isPending}>
            {close.isPending ? 'Saving…' : kind === 'complete' ? 'Complete' : 'Cancel request'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Quick Connect from a request: the customer reads out the ID and password
 * their Quick Connect client shows. The API links the session to this request
 * (only for the technician who claimed it) and never stores the password.
 */
function QuickConnectDialog({
  request, onClose, onDone,
}: { request: SupportRequestDetail; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const [rustdeskId, setRustdeskId] = useState(request.reportedRustdeskId ?? '');
  const [password, setPassword] = useState('');
  const connect = useMutation({
    mutationFn: () => api.post('/quick-connect/connect', {
      rustdeskId: rustdeskId.trim(),
      password,
      ...(request.contactName ? { contactName: request.contactName.slice(0, 128) } : {}),
      ...(request.description ? { issueDescription: request.description.slice(0, 1024) } : {}),
      supportRequestId: request.id,
    }),
    onSuccess: (res) => {
      const data = res.data?.data as { rustdeskId: string; password: string };
      setPassword('');
      window.location.href = `rustdesk://connection/new/${data.rustdeskId}?password=${encodeURIComponent(data.password)}`;
      toast({ title: 'Opening RustDesk…', description: `Connecting to ${data.rustdeskId}` });
      onDone();
      onClose();
    },
    onError: (e: unknown) => toast({ title: 'Could not connect', description: apiError(e).message, variant: 'destructive' }),
  });
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Quick Connect</DialogTitle>
          <DialogDescription>Enter the ID and password shown in their Quick Connect app.</DialogDescription>
        </DialogHeader>
        <form id="qc-form" className="space-y-4" onSubmit={(e) => { e.preventDefault(); connect.mutate(); }}>
          <div className="space-y-1.5">
            <Label htmlFor="qc-id">Remote ID</Label>
            <Input id="qc-id" inputMode="numeric" value={rustdeskId} onChange={(e) => setRustdeskId(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="qc-pw">Password</Label>
            <Input id="qc-pw" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={connect.isPending}>Cancel</Button>
          <Button type="submit" form="qc-form" disabled={!rustdeskId.trim() || password.length < 4 || connect.isPending}>
            {connect.isPending ? 'Connecting…' : 'Connect'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 sm:block">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-right sm:text-left break-words">{children}</p>
    </div>
  );
}
