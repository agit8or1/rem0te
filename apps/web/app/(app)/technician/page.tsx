'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, ArrowRight, Building2, CalendarClock, Check, Clock, Loader2, Monitor, Send,
} from 'lucide-react';
import { setActiveBusiness, techniciansApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { usePermissions } from '@/lib/auth';
import { cn, formatDate } from '@/lib/utils';

// ─── Types (apps/api/src/technicians/technicians.service.ts: mine, overview) ─

interface CapItem { key: string; label: string; description: string }
interface CapGroup { group: string; items: CapItem[] }

interface GrantSource {
  assignmentId: string;
  via: 'DIRECT' | 'GROUP';
  temporary: boolean;
  groupId: string | null;
  groupName: string | null;
  capabilities: string[];
  endpointIds: string[] | null;
  startsAt: string | null;
  expiresAt: string | null;
  schedule: string | null;
  approval: string;
}
interface InactiveGrant extends GrantSource { businessId: string; businessName: string; inactiveReason: string }
interface BusinessScope { businessId: string; businessName: string; capabilities: string[]; endpointIds: string[] | null; sources: GrantSource[] }
interface Mine { activeBusinessId: string | null; ownBusinessId: string | null; businesses: BusinessScope[]; inactive: InactiveGrant[] }

interface RecentSession {
  id: string;
  status: string;
  createdAt: string;
  connectionConfirmedAt: string | null;
  endpoint: { id: string; name: string } | null;
  technician: { id: string; firstName: string | null; lastName: string | null } | null;
}
interface OverviewRow {
  businessId: string;
  businessName: string;
  capabilities: string[];
  computerScope: string;
  sources: GrantSource[];
  computers: number | null;
  online: number | null;
  openSessions: number | null;
  waitingRequests: number | null;
  recentSessions: RecentSession[];
}

type ApiErr = { response?: { status?: number; data?: { message?: string | string[] } } };
function errMsg(e: unknown): string | undefined {
  const m = (e as ApiErr)?.response?.data?.message;
  return Array.isArray(m) ? m.join('; ') : m;
}

const INACTIVE_REASON: Record<string, string> = {
  not_started: 'Not started yet',
  expired: 'Expired',
  outside_schedule: 'Outside its weekly schedule right now',
  pending_approval: "Waiting for the Business Owner's approval",
  denied: 'Denied by the Business Owner',
  business_disabled: 'The business is disabled or archived',
};
const TEMP_STYLE = 'bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-200';
const SCHED_STYLE = 'bg-sky-100 text-sky-800 dark:bg-sky-900/60 dark:text-sky-200';
const OPEN_STATUSES = ['LAUNCH_REQUESTED', 'LAUNCHER_ACKNOWLEDGED', 'CLIENT_OPENED', 'SESSION_STARTED'];

function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function WhenBadges({ s }: { s: GrantSource }) {
  return (
    <div className="flex flex-wrap gap-1">
      {s.expiresAt
        ? <Badge className={TEMP_STYLE}><Clock className="mr-1 h-3 w-3" />Temporary · ends {formatDate(s.expiresAt)}</Badge>
        : <Badge variant="secondary">No end date</Badge>}
      {s.startsAt && <Badge className={SCHED_STYLE}><CalendarClock className="mr-1 h-3 w-3" />Starts {formatDate(s.startsAt)}</Badge>}
      {s.schedule && <Badge className={SCHED_STYLE}><CalendarClock className="mr-1 h-3 w-3" />Only {s.schedule}</Badge>}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | null }) {
  return (
    <div
      className="rounded-md border bg-muted/30 p-2 text-center"
      title={value === null ? `${label}: not included in your access here` : undefined}
    >
      <div className="text-lg font-semibold">
        {value === null ? <><span aria-hidden>—</span><span className="sr-only">not in your access</span></> : value}
      </div>
      <div className="text-[11px] leading-tight text-muted-foreground">{label}</div>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function TechnicianOverviewPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const { technician, user } = usePermissions();
  const [switching, setSwitching] = useState<string | null>(null);

  const { data: vocab } = useQuery<{ capabilityGroups: CapGroup[] }>({
    queryKey: ['technicians', 'vocabulary'],
    queryFn: () => techniciansApi.vocabulary().then((r) => r.data?.data),
    staleTime: Infinity,
  });
  const { data: overview = [], isLoading: loadingOverview, error: overviewError } = useQuery<OverviewRow[]>({
    queryKey: ['technicians', 'overview'],
    queryFn: () => techniciansApi.overview().then((r) => r.data?.data ?? []),
    refetchInterval: 60_000,
  });
  const { data: mine } = useQuery<Mine>({
    queryKey: ['technicians', 'me'],
    queryFn: () => techniciansApi.me().then((r) => r.data?.data),
  });

  const capLabels = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of vocab?.capabilityGroups ?? []) for (const i of g.items) m.set(i.key, i.label);
    return m;
  }, [vocab]);

  async function workIn(id: string | null) {
    setSwitching(id ?? 'own');
    setActiveBusiness(id);
    await qc.invalidateQueries();
    router.push('/dashboard');
  }

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="All assigned businesses"
        description="Every business you can reach as a technician right now. Each card shows only what your access to that business allows."
      />

      {technician && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="flex-1">You are currently working in <strong>{technician.businessName}</strong> as a technician.</span>
          {(user?.ownBusinessId || (user?.assignedBusinesses?.length ?? 0) > 1) && (
            <Button size="sm" variant="outline" onClick={() => workIn(user?.ownBusinessId ?? null)} disabled={!!switching}>
              Back to my own account
            </Button>
          )}
        </div>
      )}

      {loadingOverview ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : overviewError ? (
        <Card><CardContent className="p-6 text-sm text-destructive">{errMsg(overviewError) ?? 'Could not load your businesses.'}</CardContent></Card>
      ) : overview.length === 0 ? (
        <Card><CardContent className="p-6 text-sm text-muted-foreground">
          You have no technician access that is active right now. See &ldquo;My access&rdquo; below for anything pending, scheduled or expired.
        </CardContent></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {overview.map((b) => {
            const current = technician?.businessId === b.businessId;
            return (
              <Card key={b.businessId} className={cn(current && 'border-primary/50')}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <CardTitle className="flex items-center gap-2 text-base"><Building2 className="h-4 w-4 shrink-0" /><span className="truncate">{b.businessName}</span></CardTitle>
                      <CardDescription>{b.computerScope} · {b.capabilities.length} permission(s)</CardDescription>
                    </div>
                    {current && <Badge variant="success">Current</Badge>}
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <div className="grid grid-cols-4 gap-2">
                    <Stat label="Computers" value={b.computers} />
                    <Stat label="Online" value={b.online} />
                    <Stat label="Open sessions" value={b.openSessions} />
                    <Stat label="Waiting requests" value={b.waitingRequests} />
                  </div>
                  <div className="space-y-1">{b.sources.map((s) => <WhenBadges key={s.assignmentId} s={s} />)}</div>
                  <div>
                    <div className="mb-1 text-xs font-medium text-muted-foreground">Recent sessions</div>
                    {b.openSessions === null ? (
                      <p className="text-xs text-muted-foreground">Your access here does not include viewing sessions.</p>
                    ) : b.recentSessions.length === 0 ? (
                      <p className="text-xs text-muted-foreground">None.</p>
                    ) : (
                      <ul className="space-y-1">
                        {b.recentSessions.map((s) => (
                          <li key={s.id} className="flex items-center gap-2 text-xs">
                            <Monitor className="h-3 w-3 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate">{s.endpoint?.name ?? 'Quick Connect'}</span>
                            <Badge variant={OPEN_STATUSES.includes(s.status) ? 'warning' : 'secondary'} className="font-normal">
                              {s.status.replace(/_/g, ' ').toLowerCase()}
                            </Badge>
                            <span className="shrink-0 text-muted-foreground">{formatDate(s.createdAt)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <Button className="w-full" size="sm" variant={current ? 'outline' : 'default'} disabled={!!switching}
                    onClick={() => (current ? router.push('/dashboard') : workIn(b.businessId))}>
                    {switching === b.businessId ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ArrowRight className="mr-2 h-4 w-4" />}
                    {current ? 'Open dashboard' : 'Work in this business'}
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <MyAccess mine={mine} capLabels={capLabels} />

      <RequestAccess
        mine={mine}
        groups={vocab?.capabilityGroups ?? []}
        inTechnicianContext={!!technician}
        autoPinned={!!technician && !user?.ownBusinessId && (user?.assignedBusinesses?.length ?? 0) === 1}
        assigned={user?.assignedBusinesses ?? []}
        onLeaveContext={() => workIn(user?.ownBusinessId ?? null)}
      />
    </div>
  );
}

function MyAccess({ mine, capLabels }: { mine?: Mine; capLabels: Map<string, string> }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">My access</CardTitle>
        <CardDescription>Every technician assignment you have, including those that do not count right now and why.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {!mine ? <p className="text-muted-foreground">Loading…</p> : (
          <>
            <div className="space-y-2">
              <h3 className="font-semibold">Active now ({mine.businesses.length})</h3>
              {mine.businesses.length === 0 && <p className="text-muted-foreground">None.</p>}
              {mine.businesses.map((b) => (
                <div key={b.businessId} className="space-y-2 rounded-md border p-3">
                  <div className="flex flex-wrap justify-between gap-2">
                    <span className="font-medium">{b.businessName}</span>
                    <span className="text-xs text-muted-foreground">{b.endpointIds ? `${b.endpointIds.length} selected computer(s)` : 'All computers'}</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {b.capabilities.map((c) => <Badge key={c} variant="outline" className="font-normal">{capLabels.get(c) ?? c}</Badge>)}
                  </div>
                  {b.sources.map((s) => (
                    <div key={s.assignmentId} className="space-y-1 text-xs text-muted-foreground">
                      <div>{s.via === 'DIRECT' ? 'Assigned to you directly' : `Through the group ${s.groupName ?? ''}`}</div>
                      <WhenBadges s={s} />
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <div className="space-y-2">
              <h3 className="font-semibold">Not counting right now ({mine.inactive.length})</h3>
              {mine.inactive.length === 0 && <p className="text-muted-foreground">None.</p>}
              {mine.inactive.map((g) => (
                <div key={g.assignmentId} className="space-y-1.5 rounded-md border border-dashed p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{g.businessName}</span>
                    <Badge className={g.inactiveReason === 'pending_approval' ? TEMP_STYLE
                      : g.inactiveReason === 'denied' ? 'bg-red-100 text-red-800 dark:bg-red-900/60 dark:text-red-200'
                        : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'}>
                      {INACTIVE_REASON[g.inactiveReason] ?? g.inactiveReason}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {g.via === 'DIRECT' ? 'Assigned to you directly' : `Through the group ${g.groupName ?? ''}`} · {g.endpointIds ? `${g.endpointIds.length} selected computer(s)` : 'All computers'}
                  </div>
                  <WhenBadges s={g} />
                  <div className="flex flex-wrap gap-1">
                    {g.capabilities.map((c) => <Badge key={c} variant="outline" className="font-normal">{capLabels.get(c) ?? c}</Badge>)}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

const PRESETS: { label: string; hours: number }[] = [
  { label: '4 hours', hours: 4 }, { label: '1 day', hours: 24 }, { label: '3 days', hours: 72 }, { label: '1 week', hours: 168 },
];

function RequestAccess({
  mine, groups, inTechnicianContext, autoPinned, assigned, onLeaveContext,
}: {
  mine?: Mine; groups: CapGroup[]; inTechnicianContext: boolean; autoPinned: boolean;
  assigned: { id: string; name: string }[]; onLeaveContext: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [f, setF] = useState({ businessId: '', capabilities: [] as string[], endpointIds: '', startsAt: '', expiresAt: '', reason: '' });

  // Technicians cannot list businesses, so the choice is the businesses
  // they already have (or had) an assignment with.
  const businesses = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of assigned) m.set(b.id, b.name);
    for (const b of mine?.businesses ?? []) m.set(b.businessId, b.businessName);
    for (const g of mine?.inactive ?? []) m.set(g.businessId, g.businessName);
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [assigned, mine]);

  const endpointIds = f.endpointIds.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  const problem = (() => {
    if (!f.businessId) return 'Choose a business.';
    if (f.capabilities.length === 0) return 'Choose at least one permission.';
    if (!f.expiresAt) return 'An access request needs an end time.';
    if (new Date(f.expiresAt) <= new Date(f.startsAt || Date.now())) return 'The end must be after the start.';
    if (f.reason.trim().length < 3) return 'Give a reason (at least 3 characters).';
    return null;
  })();

  const send = useMutation({
    mutationFn: () => techniciansApi.requestAccess({
      businessId: f.businessId,
      capabilities: f.capabilities,
      ...(endpointIds.length ? { endpointIds } : {}),
      ...(f.startsAt ? { startsAt: fromLocalInput(f.startsAt) } : {}),
      expiresAt: fromLocalInput(f.expiresAt),
      reason: f.reason.trim(),
    }),
    onSuccess: () => {
      toast({ title: 'Request sent', description: "It grants nothing until the business's Business Owner approves it." });
      setF({ businessId: '', capabilities: [], endpointIds: '', startsAt: '', expiresAt: '', reason: '' });
      qc.invalidateQueries({ queryKey: ['technicians'] });
    },
    onError: (e) => toast({ title: 'Could not send request', description: errMsg(e), variant: 'destructive' }),
  });

  const toggle = (k: string) => setF({ ...f, capabilities: f.capabilities.includes(k) ? f.capabilities.filter((x) => x !== k) : [...f.capabilities, k] });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Request access</CardTitle>
        <CardDescription>
          Ask for time-limited access to a business. The request is pending until that business&apos;s Business Owner approves it,
          and they can narrow it (fewer permissions, fewer computers, an earlier end).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {inTechnicianContext ? (
          <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            {autoPinned ? (
              <p>
                You have no business of your own and exactly one assignment, so Rem0te always works in that business for you,
                and requests cannot be sent from a technician context. Ask your MSP&apos;s technician manager to add the access instead.
              </p>
            ) : (
              <>
                <p>Requests can only be sent from your own account, not while you work in a business as a technician.</p>
                <Button size="sm" variant="outline" onClick={onLeaveContext}>Switch to my own account</Button>
              </>
            )}
          </div>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label>Business</Label>
              <Select value={f.businessId} onValueChange={(v) => setF({ ...f, businessId: v })}>
                <SelectTrigger><SelectValue placeholder={businesses.length ? 'Choose a business' : 'No businesses to choose from'} /></SelectTrigger>
                <SelectContent>{businesses.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Listed: businesses you have, or had, an assignment with. For any other business, ask your technician manager. Only people your MSP already recognises as technicians can send requests.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>Permissions</Label>
              {groups.map((g) => (
                <div key={g.group}>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.group}</div>
                  <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                    {g.items.map((i) => {
                      const on = f.capabilities.includes(i.key);
                      return (
                        <button key={i.key} type="button" onClick={() => toggle(i.key)} title={i.description}
                          className={cn('flex items-start gap-2 rounded-md border p-2 text-left', on ? 'border-primary/40 bg-primary/5' : 'hover:bg-muted/50')}>
                          <span className={cn('mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border', on ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40')}>
                            {on && <Check className="h-3 w-3" />}
                          </span>
                          <span className="font-medium leading-tight">{i.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="rq-s">Starts (optional)</Label>
                <Input id="rq-s" type="datetime-local" value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} />
                <p className="text-xs text-muted-foreground">Empty: from approval.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rq-e">Ends (required)</Label>
                <Input id="rq-e" type="datetime-local" value={f.expiresAt} onChange={(e) => setF({ ...f, expiresAt: e.target.value })} />
                <div className="flex flex-wrap gap-1">
                  {PRESETS.map((p) => (
                    <button key={p.label} type="button" className="rounded border px-1.5 py-0.5 text-xs hover:bg-muted"
                      onClick={() => {
                        const base = f.startsAt ? new Date(f.startsAt) : new Date();
                        setF({ ...f, expiresAt: toLocalInput(new Date(base.getTime() + p.hours * 3600_000)) });
                      }}>+{p.label}</button>
                  ))}
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="rq-c">Specific computers (optional)</Label>
              <Textarea id="rq-c" rows={2} placeholder="Computer IDs, one per line. Leave empty to ask for the whole business."
                value={f.endpointIds} onChange={(e) => setF({ ...f, endpointIds: e.target.value })} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="rq-r">Reason</Label>
              <Textarea id="rq-r" rows={2} maxLength={500} placeholder="e.g. Ticket 4821: printer driver rollout"
                value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
            </div>

            <div className="flex items-center justify-end gap-3">
              {problem && <span className="text-xs text-muted-foreground">{problem}</span>}
              <Button disabled={!!problem || send.isPending} onClick={() => send.mutate()}>
                {send.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}Send request
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
