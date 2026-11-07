'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, Check, Clock, Loader2, ShieldCheck } from 'lucide-react';
import { businessesApi, techniciansApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { usePermissions } from '@/lib/auth';
import { cn, formatDate } from '@/lib/utils';

// ─── Types (apps/api/src/technicians/technicians.service.ts) ─────────────────

interface CapItem { key: string; label: string; description: string }
interface CapGroup { group: string; items: CapItem[] }
interface Schedule { timeZone: string; windows: { days: number[]; start: string; end: string }[] }
interface UserRef { id: string; email: string; firstName: string | null; lastName: string | null }

interface PendingRequest {
  id: string;
  customerId: string;
  userId: string | null;
  groupId: string | null;
  capabilities: string[];
  endpointIds: string[];
  startsAt: string | null;
  expiresAt: string | null;
  schedule: Schedule | null;
  reason: string | null;
  requestedById: string | null;
  createdAt: string;
  customer: { id: string; name: string };
  user: UserRef | null;
  group: { id: string; name: string } | null;
}

interface BusinessDetail {
  id: string;
  name: string;
  technicianApprovalRequired?: boolean;
  endpoints?: { id: string; name: string; isOnline: boolean }[];
}

type ApiErr = { response?: { status?: number; data?: { message?: string | string[] } } };
function errMsg(e: unknown): string | undefined {
  const m = (e as ApiErr)?.response?.data?.message;
  return Array.isArray(m) ? m.join('; ') : m;
}
function errStatus(e: unknown): number | undefined {
  return (e as ApiErr)?.response?.status;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TEMP_STYLE = 'bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-200';
const SCHED_STYLE = 'bg-sky-100 text-sky-800 dark:bg-sky-900/60 dark:text-sky-200';

function personName(u: UserRef | null | undefined) {
  if (!u) return '—';
  return `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email;
}
function describeSchedule(s: Schedule | null | undefined): string | null {
  if (!s || !Array.isArray(s.windows)) return null;
  return `${s.windows.map((w) => `${w.days.map((d) => DAY_NAMES[d]).join(',')} ${w.start}–${w.end}`).join('; ')} (${s.timeZone})`;
}
function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function CheckBox({ on }: { on: boolean }) {
  return (
    <span className={cn('mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border', on ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40')}>
      {on && <Check className="h-3 w-3" />}
    </span>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function TechnicianApprovalsPage() {
  const { isLoading, isPlatformAdmin, accessLevel, businessId, businessName, technician, user } = usePermissions();
  const isOwner = accessLevel === 'Business Owner';
  const allowed = isPlatformAdmin || isOwner;

  const [pickedBusiness, setPickedBusiness] = useState('');
  const [deciding, setDeciding] = useState<{ r: PendingRequest; decision: 'APPROVE' | 'DENY' } | null>(null);

  const { data: vocab } = useQuery<{ capabilityGroups: CapGroup[] }>({
    queryKey: ['technicians', 'vocabulary'],
    queryFn: () => techniciansApi.vocabulary().then((r) => r.data?.data),
    staleTime: Infinity,
  });
  const capLabels = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of vocab?.capabilityGroups ?? []) for (const i of g.items) m.set(i.key, i.label);
    return m;
  }, [vocab]);

  const { data: requests = [], isLoading: loadingRequests, error } = useQuery<PendingRequest[]>({
    queryKey: ['technicians', 'approvals'],
    queryFn: () => techniciansApi.approvals().then((r) => r.data?.data ?? []),
    enabled: allowed && !technician,
    refetchInterval: 60_000,
  });

  const { data: businesses = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['businesses', ''],
    queryFn: () => businessesApi.list().then((r) => r.data?.data ?? []),
    enabled: isPlatformAdmin,
  });

  // The business whose approval setting is shown: an owner's own, or the one a Platform Admin picks.
  const settingBusinessId = isPlatformAdmin ? pickedBusiness || businessId || '' : businessId ?? '';

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

  if (technician) {
    return (
      <div className="p-6">
        <PageHeader title="Technician approvals" />
        <Card><CardContent className="flex items-start gap-2 p-6 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          You are working in {technician.businessName} as a technician. Approvals are decided by that business&apos;s own Business Owner, from their own account.
        </CardContent></Card>
      </div>
    );
  }

  if (!allowed) {
    return (
      <div className="p-6">
        <PageHeader title="Technician approvals" />
        <Card><CardContent className="p-6 text-sm text-muted-foreground">
          Only the Business Owner of {businessName ?? 'this business'} (or a Platform Admin) can approve technician access to it.
        </CardContent></Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Technician approvals"
        description={isPlatformAdmin
          ? 'Pending requests from MSP technicians, across every business.'
          : `MSP technicians asking for access to ${businessName ?? 'your business'}.`}
      />

      <ApprovalSetting
        businessId={settingBusinessId}
        isPlatformAdmin={isPlatformAdmin}
        businesses={businesses}
        onPick={setPickedBusiness}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Waiting for a decision ({requests.length})</CardTitle>
          <CardDescription>
            Approving gives access to this business only. You can narrow a request (fewer permissions, fewer computers, an earlier end) but not widen it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {loadingRequests ? <p className="text-sm text-muted-foreground">Loading…</p> : error ? (
            <p className="text-sm text-destructive">
              {errStatus(error) === 403 ? "You don't have permission to see these requests." : errMsg(error) ?? 'Could not load requests.'}
            </p>
          ) : requests.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing waiting.</p>
          ) : requests.map((r) => {
            const self = !!user && (r.userId === user.id || r.requestedById === user.id);
            const sched = describeSchedule(r.schedule);
            return (
              <div key={r.id} className="space-y-2 rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="font-medium">
                      {r.user ? personName(r.user) : `Technician group ${r.group?.name ?? ''}`}
                      {isPlatformAdmin && <span className="font-normal text-muted-foreground"> → {r.customer.name}</span>}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {r.user?.email ? `${r.user.email} · ` : ''}
                      {r.requestedById ? 'Asked for this themselves' : 'Assigned by your MSP, needs your approval'} · {formatDate(r.createdAt)}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => setDeciding({ r, decision: 'DENY' })}>Deny</Button>
                    <Button size="sm" disabled={self} title={self ? 'You cannot approve access for yourself' : undefined}
                      onClick={() => setDeciding({ r, decision: 'APPROVE' })}>Approve…</Button>
                  </div>
                </div>
                {r.reason && <p className="rounded bg-muted/50 p-2 text-xs">“{r.reason}”</p>}
                <div className="flex flex-wrap gap-1">
                  <Badge variant="secondary">{r.endpointIds.length ? `${r.endpointIds.length} selected computer(s)` : 'Whole business'}</Badge>
                  {r.expiresAt
                    ? <Badge className={TEMP_STYLE}><Clock className="mr-1 h-3 w-3" />Until {formatDate(r.expiresAt)}</Badge>
                    : <Badge variant="secondary">No end date</Badge>}
                  {r.startsAt && <Badge className={SCHED_STYLE}><CalendarClock className="mr-1 h-3 w-3" />From {formatDate(r.startsAt)}</Badge>}
                  {sched && <Badge className={SCHED_STYLE}><CalendarClock className="mr-1 h-3 w-3" />Only {sched}</Badge>}
                </div>
                <div className="flex flex-wrap gap-1">
                  {r.capabilities.map((c) => <Badge key={c} variant="outline" className="font-normal">{capLabels.get(c) ?? c}</Badge>)}
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <DecisionDialog state={deciding} onClose={() => setDeciding(null)} groups={vocab?.capabilityGroups ?? []} />
    </div>
  );
}

function ApprovalSetting({
  businessId, isPlatformAdmin, businesses, onPick,
}: {
  businessId: string; isPlatformAdmin: boolean; businesses: { id: string; name: string }[]; onPick: (id: string) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: business, isLoading, error } = useQuery<BusinessDetail>({
    queryKey: ['business', businessId],
    queryFn: () => businessesApi.get(businessId).then((r) => r.data?.data),
    enabled: !!businessId,
  });
  const required = business?.technicianApprovalRequired;

  const set = useMutation({
    mutationFn: (v: boolean) => techniciansApi.setApprovalRequired(businessId, v),
    onSuccess: (res) => {
      const now = res.data?.data?.technicianApprovalRequired;
      toast({ title: now ? 'Approval is now required' : 'Approval is no longer required' });
      qc.invalidateQueries({ queryKey: ['business', businessId] });
    },
    onError: (e) => toast({
      title: 'Could not change the setting',
      description: errStatus(e) === 403 ? "Only this business's Business Owner (or a Platform Admin) can change it." : errMsg(e),
      variant: 'destructive',
    }),
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4" />Require approval for technician access</CardTitle>
        <CardDescription>
          When on, every new technician assignment to this business stays pending, and grants nothing, until you approve it.
          Requests a technician sends themselves always need approval, whatever this is set to.
          Changing it does not affect assignments that already work.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {isPlatformAdmin && (
          <Select value={businessId} onValueChange={onPick}>
            <SelectTrigger className="max-w-sm"><SelectValue placeholder="Choose a business" /></SelectTrigger>
            <SelectContent>{businesses.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent>
          </Select>
        )}
        {!businessId ? (
          <p className="text-muted-foreground">Choose a business to see its setting.</p>
        ) : isLoading ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-destructive">{errMsg(error) ?? 'Could not load the business.'}</p>
        ) : required === undefined ? (
          <p className="text-muted-foreground">This server did not report the current setting.</p>
        ) : (
          <div className="flex items-center gap-3">
            <button
              type="button" role="switch" aria-checked={required} disabled={set.isPending}
              onClick={() => set.mutate(!required)}
              className={cn(
                'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 border-transparent transition-colors disabled:opacity-50',
                required ? 'bg-primary' : 'bg-muted-foreground/30',
              )}
            >
              <span className={cn('inline-block h-5 w-5 rounded-full bg-background shadow transition-transform', required ? 'translate-x-5' : 'translate-x-0')} />
            </button>
            <span>{required ? 'On: new assignments wait for approval' : 'Off: assignments from your MSP work straight away'}</span>
            {set.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DecisionDialog({
  state, onClose, groups,
}: { state: { r: PendingRequest; decision: 'APPROVE' | 'DENY' } | null; onClose: () => void; groups: CapGroup[] }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [note, setNote] = useState('');
  const [caps, setCaps] = useState<string[]>([]);
  const [eps, setEps] = useState<string[]>([]);
  const [narrow, setNarrow] = useState(false);
  const [expires, setExpires] = useState('');
  const [seeded, setSeeded] = useState<string | null>(null);
  const key = state ? `${state.r.id}:${state.decision}` : null;
  if (key !== seeded) {
    setSeeded(key);
    setNote('');
    setCaps(state?.r.capabilities ?? []);
    setEps(state?.r.endpointIds ?? []);
    setNarrow(false);
    setExpires(state?.r.expiresAt ? toLocalInput(new Date(state.r.expiresAt)) : '');
  }
  const r = state?.r;
  const approving = state?.decision === 'APPROVE';
  const whole = (r?.endpointIds.length ?? 0) === 0;

  // Computer names come from the business itself (needs computers:view, which an owner has).
  const { data: business } = useQuery<BusinessDetail>({
    queryKey: ['business', r?.customerId],
    queryFn: () => businessesApi.get(r!.customerId).then((x) => x.data?.data),
    enabled: !!r && approving,
    retry: false,
  });
  const computers = business?.endpoints ?? [];
  const nameOf = new Map(computers.map((c) => [c.id, c.name]));
  const choices = whole ? computers.map((c) => c.id) : r?.endpointIds ?? [];
  const allowedCaps = new Set(r?.capabilities ?? []);

  const problem = (() => {
    if (!approving || !r) return null;
    if (caps.length === 0) return 'Approving with no permissions grants nothing; deny instead.';
    if (!whole && eps.length === 0) return 'Keep at least one computer, or deny.';
    if (whole && narrow && eps.length === 0) return 'Pick at least one computer, or keep the whole business.';
    if (expires && r.expiresAt && new Date(expires) > new Date(r.expiresAt)) return 'You can only make the end earlier.';
    return null;
  })();

  const decide = useMutation({
    mutationFn: () => {
      const body: { decision: 'APPROVE' | 'DENY'; note?: string; capabilities?: string[]; endpointIds?: string[]; expiresAt?: string | null } = {
        decision: state!.decision, ...(note.trim() ? { note: note.trim() } : {}),
      };
      if (approving && r) {
        if (caps.length !== r.capabilities.length) body.capabilities = caps;
        if (!whole && eps.length !== r.endpointIds.length) body.endpointIds = eps;
        if (whole && narrow) body.endpointIds = eps;
        const iso = fromLocalInput(expires);
        if (iso && iso !== (r.expiresAt ? new Date(r.expiresAt).toISOString() : null)) body.expiresAt = iso;
      }
      return techniciansApi.decide(r!.id, body);
    },
    onSuccess: () => {
      toast({
        title: approving ? 'Approved' : 'Denied',
        description: approving ? 'The access works from its start time, within any schedule, until it ends or is revoked.' : undefined,
      });
      qc.invalidateQueries({ queryKey: ['technicians'] });
      onClose();
    },
    onError: (e) => toast({
      title: 'Could not record the decision',
      description: errStatus(e) === 404 ? 'This request no longer exists or is not yours to decide.' : errMsg(e),
      variant: 'destructive',
    }),
  });

  return (
    <Dialog open={!!state} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{approving ? 'Approve technician access' : 'Deny technician access'}</DialogTitle>
          <DialogDescription>
            {r ? `${r.user ? personName(r.user) : `Group ${r.group?.name}`} → ${r.customer.name}.` : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          {approving && r && (
            <>
              <div className="space-y-1.5">
                <Label>Permissions (untick to remove)</Label>
                {groups.map((g) => {
                  const items = g.items.filter((i) => allowedCaps.has(i.key));
                  if (!items.length) return null;
                  return (
                    <div key={g.group}>
                      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.group}</div>
                      <div className="grid gap-1 sm:grid-cols-2">
                        {items.map((i) => {
                          const on = caps.includes(i.key);
                          return (
                            <button key={i.key} type="button" title={i.description}
                              onClick={() => setCaps(on ? caps.filter((x) => x !== i.key) : [...caps, i.key])}
                              className={cn('flex items-start gap-2 rounded-md border p-2 text-left text-sm', on ? 'border-primary/40 bg-primary/5' : 'hover:bg-muted/50')}>
                              <CheckBox on={on} /><span className="font-medium leading-tight">{i.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="space-y-1.5">
                <Label>Computers</Label>
                {whole && (
                  <button type="button" onClick={() => setNarrow(!narrow)} className="flex items-center gap-2 text-sm">
                    <CheckBox on={narrow} />Requested the whole business. Limit to specific computers
                  </button>
                )}
                {(!whole || narrow) && (
                  choices.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No computers to choose from.</p>
                  ) : (
                    <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-1">
                      {choices.map((id) => {
                        const on = eps.includes(id);
                        return (
                          <button key={id} type="button" onClick={() => setEps(on ? eps.filter((x) => x !== id) : [...eps, id])}
                            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted/50">
                            <CheckBox on={on} /><span className="truncate">{nameOf.get(id) ?? id}</span>
                          </button>
                        );
                      })}
                    </div>
                  )
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ap-x">Ends</Label>
                <Input id="ap-x" type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)}
                  max={r.expiresAt ? toLocalInput(new Date(r.expiresAt)) : undefined} />
                <p className="text-xs text-muted-foreground">
                  {r.expiresAt ? `Requested until ${formatDate(r.expiresAt)}. You can only make it earlier.` : 'Requested with no end date. Set one to make it temporary.'}
                </p>
              </div>
            </>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="ap-n">Note (recorded in the audit log)</Label>
            <Textarea id="ap-n" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
        <DialogFooter className="items-center">
          {problem && <span className="mr-auto text-xs text-muted-foreground">{problem}</span>}
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant={approving ? 'default' : 'destructive'} disabled={!!problem || decide.isPending} onClick={() => decide.mutate()}>
            {decide.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{approving ? 'Approve' : 'Deny'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
