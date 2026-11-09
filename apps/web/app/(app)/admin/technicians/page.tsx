'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, CalendarClock, Check, Clock, KeyRound, Loader2, Pencil, Plus, Search,
  ShieldCheck, Trash2, UserCog, UserMinus, Users, X,
} from 'lucide-react';
import { businessesApi, endpointsApi, securityControlsApi, techniciansApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { usePermissions } from '@/lib/auth';
import { cn, formatDate } from '@/lib/utils';

// ─── Types (shapes from apps/api/src/technicians + rbac) ─────────────────────

interface CapItem { key: string; label: string; description: string }
interface CapGroup { group: string; items: CapItem[] }
interface Vocabulary {
  capabilityGroups: CapGroup[];
  platformPermissions: Record<string, { label: string; description: string }>;
}

interface ScheduleWindow { days: number[]; start: string; end: string }
interface Schedule { timeZone: string; windows: ScheduleWindow[] }

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
interface InactiveGrant extends GrantSource {
  businessId: string;
  businessName: string;
  inactiveReason: string;
}
interface BusinessScope {
  businessId: string;
  businessName: string;
  capabilities: string[];
  endpointIds: string[] | null;
  sources: GrantSource[];
}

interface UserRef { id: string; email: string; firstName: string | null; lastName: string | null; status?: string }

interface Person extends UserRef {
  status: string;
  platformPermissions: string[];
  ownBusiness: { id: string; name: string } | null;
  ownRole: string | null;
  groups: { id: string; name: string }[];
}

interface Assignment {
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
  approvalStatus: 'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'DENIED';
  requestedById: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
  revokedAt: string | null;
  revokeReason: string | null;
  customer: { id: string; name: string; technicianApprovalRequired?: boolean };
  user: UserRef | null;
  group: { id: string; name: string } | null;
}

interface Group {
  id: string;
  name: string;
  description: string | null;
  capabilities: string[];
  members: { id: string; userId: string; user: UserRef }[];
  assignments: { id: string; customer: { id: string; name: string } }[];
}

interface PresetLite { id: string; key: string; name: string; tier: string; builtIn: boolean; description: string }
const CUSTOM_PRESET = '__custom__';

interface EndpointLite { id: string; name: string; hostname?: string | null; isOnline?: boolean }

type ApiErr = { response?: { status?: number; data?: { message?: string | string[] } } };
function errMsg(e: unknown): string | undefined {
  const m = (e as ApiErr)?.response?.data?.message;
  return Array.isArray(m) ? m.join('; ') : m;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const INACTIVE_REASON: Record<string, string> = {
  not_started: 'Not started yet',
  expired: 'Expired',
  outside_schedule: 'Outside its weekly schedule right now',
  pending_approval: "Waiting for the Business Owner's approval",
  denied: 'Denied by the Business Owner',
  business_disabled: 'The business is disabled or archived',
};

const APPROVAL_LABEL: Record<string, string> = {
  NOT_REQUIRED: 'No approval needed',
  PENDING: 'Pending approval',
  APPROVED: 'Approved',
  DENIED: 'Denied',
};

const APPROVAL_STYLE: Record<string, string> = {
  NOT_REQUIRED: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  PENDING: 'bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-200',
  APPROVED: 'bg-green-100 text-green-800 dark:bg-green-900/60 dark:text-green-200',
  DENIED: 'bg-red-100 text-red-800 dark:bg-red-900/60 dark:text-red-200',
};

const TEMP_STYLE = 'bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-200';
const SCHED_STYLE = 'bg-sky-100 text-sky-800 dark:bg-sky-900/60 dark:text-sky-200';

function personName(u: { firstName?: string | null; lastName?: string | null; email: string } | null | undefined) {
  if (!u) return '—';
  return `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email;
}

function describeSchedule(s: Schedule | null | undefined): string | null {
  if (!s || !Array.isArray(s.windows)) return null;
  const parts = s.windows.map((w) => `${w.days.map((d) => DAY_NAMES[d]).join(',')} ${w.start}–${w.end}`);
  return `${parts.join('; ')} (${s.timeZone})`;
}

/** Same rule as apps/api/src/rbac/schedule.ts: wall clock in the zone, midnight-crossing windows belong to their start day. */
function insideSchedule(s: Schedule | null | undefined, at = new Date()): boolean {
  if (!s) return true;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: s.timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(at);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    const day = DAY_NAMES.indexOf(get('weekday'));
    const minutes = (parseInt(get('hour'), 10) % 24) * 60 + parseInt(get('minute'), 10);
    const yesterday = (day + 6) % 7;
    const toMin = (hhmm: string) => { const [h, m] = hhmm.split(':').map((x) => parseInt(x, 10)); return h * 60 + m; };
    return s.windows.some((w) => {
      const a = toMin(w.start); const b = toMin(w.end);
      if (a < b) return w.days.includes(day) && minutes >= a && minutes < b;
      return (w.days.includes(day) && minutes >= a) || (w.days.includes(yesterday) && minutes < b);
    });
  } catch {
    return false;
  }
}

/** Live status of an assignment row, mirroring TechnicianAccessService.resolve. */
function assignmentStatus(a: Assignment): { label: string; className: string } {
  const now = new Date();
  if (a.revokedAt) return { label: 'Revoked', className: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400' };
  if (a.approvalStatus === 'PENDING') return { label: 'Not active: awaiting approval', className: APPROVAL_STYLE.PENDING };
  if (a.approvalStatus === 'DENIED') return { label: 'Not active: denied', className: APPROVAL_STYLE.DENIED };
  if (a.startsAt && now < new Date(a.startsAt)) return { label: 'Not started yet', className: SCHED_STYLE };
  if (a.expiresAt && now >= new Date(a.expiresAt)) return { label: 'Expired', className: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400' };
  if (!insideSchedule(a.schedule, now)) return { label: 'Outside schedule now', className: SCHED_STYLE };
  return { label: 'Active now', className: APPROVAL_STYLE.APPROVED };
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

const TIME_ZONES: string[] = (() => {
  try { return Intl.supportedValuesOf('timeZone'); } catch { return []; }
})();
function browserTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}
function validTimeZone(tz: string): boolean {
  if (!tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

// ─── Small building blocks ───────────────────────────────────────────────────

function CheckBox({ on }: { on: boolean }) {
  return (
    <span className={cn(
      'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border',
      on ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40',
    )}>
      {on && <Check className="h-3 w-3" />}
    </span>
  );
}

function CapabilityPicker({
  groups, value, onChange, allowed,
}: {
  groups: CapGroup[];
  value: string[];
  onChange: (v: string[]) => void;
  /** When set, only these keys may be chosen (approval can only narrow). */
  allowed?: string[];
}) {
  const toggle = (k: string) => onChange(value.includes(k) ? value.filter((x) => x !== k) : [...value, k]);
  return (
    <div className="space-y-3">
      {groups.map((g) => {
        const items = allowed ? g.items.filter((i) => allowed.includes(i.key)) : g.items;
        if (items.length === 0) return null;
        return (
          <div key={g.group}>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.group}</div>
            <div className="grid gap-1 sm:grid-cols-2">
              {items.map((i) => {
                const on = value.includes(i.key);
                return (
                  <button
                    key={i.key} type="button" onClick={() => toggle(i.key)} title={i.description}
                    className={cn(
                      'flex items-start gap-2 rounded-md border p-2 text-left text-sm transition-colors',
                      on ? 'border-primary/40 bg-primary/5' : 'hover:bg-muted/50',
                    )}
                  >
                    <CheckBox on={on} />
                    <span className="min-w-0">
                      <span className="block font-medium leading-tight">{i.label}</span>
                      <span className="block text-xs text-muted-foreground">{i.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CapBadges({ caps, labels }: { caps: string[]; labels: Map<string, string> }) {
  if (caps.length === 0) return <span className="text-xs text-muted-foreground">None</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {caps.map((c) => <Badge key={c} variant="outline" className="font-normal">{labels.get(c) ?? c}</Badge>)}
    </div>
  );
}

/** Temporary / scheduled / start badges for a grant. Loud on purpose. */
function WhenBadges({ startsAt, expiresAt, schedule }: { startsAt: string | null; expiresAt: string | null; schedule: string | null }) {
  return (
    <div className="flex flex-wrap gap-1">
      {expiresAt ? (
        <Badge className={TEMP_STYLE}><Clock className="mr-1 h-3 w-3" />Temporary · ends {formatDate(expiresAt)}</Badge>
      ) : (
        <Badge variant="secondary">No end date</Badge>
      )}
      {startsAt && <Badge className={SCHED_STYLE}><CalendarClock className="mr-1 h-3 w-3" />Starts {formatDate(startsAt)}</Badge>}
      {schedule && <Badge className={SCHED_STYLE}><CalendarClock className="mr-1 h-3 w-3" />Only {schedule}</Badge>}
    </div>
  );
}

function ScheduleEditor({ value, onChange }: { value: Schedule; onChange: (s: Schedule) => void }) {
  const tzOk = validTimeZone(value.timeZone);
  const setWin = (i: number, w: ScheduleWindow) => onChange({ ...value, windows: value.windows.map((x, j) => (j === i ? w : x)) });
  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-3">
      <div>
        <Label htmlFor="tz">Time zone</Label>
        <Input
          id="tz" list="tz-list" value={value.timeZone}
          onChange={(e) => onChange({ ...value, timeZone: e.target.value })}
          className={cn(!tzOk && 'border-destructive')}
        />
        <datalist id="tz-list">{TIME_ZONES.map((z) => <option key={z} value={z} />)}</datalist>
        <p className="mt-1 text-xs text-muted-foreground">
          Hours are wall-clock time in this zone, including daylight saving changes.
          {!tzOk && <span className="text-destructive"> Not a recognised IANA time zone.</span>}
        </p>
      </div>
      {value.windows.map((w, i) => (
        <div key={i} className="space-y-2 rounded-md border bg-background p-2">
          <div className="flex flex-wrap gap-1">
            {DAY_NAMES.map((d, di) => {
              const on = w.days.includes(di);
              return (
                <button
                  key={d} type="button"
                  onClick={() => setWin(i, { ...w, days: on ? w.days.filter((x) => x !== di) : [...w.days, di].sort() })}
                  className={cn(
                    'rounded border px-2 py-0.5 text-xs',
                    on ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted',
                  )}
                >
                  {d}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2">
            <Input type="time" className="w-32" value={w.start} onChange={(e) => setWin(i, { ...w, start: e.target.value })} />
            <span className="text-sm text-muted-foreground">to</span>
            <Input type="time" className="w-32" value={w.end} onChange={(e) => setWin(i, { ...w, end: e.target.value })} />
            {value.windows.length > 1 && (
              <Button type="button" variant="ghost" size="sm" className="ml-auto h-8 w-8 p-0"
                onClick={() => onChange({ ...value, windows: value.windows.filter((_, j) => j !== i) })}>
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
          {w.end && w.start && w.end < w.start && (
            <p className="text-xs text-muted-foreground">Crosses midnight: runs into the next morning.</p>
          )}
        </div>
      ))}
      {value.windows.length < 14 && (
        <Button type="button" variant="outline" size="sm"
          onClick={() => onChange({ ...value, windows: [...value.windows, { days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' }] })}>
          <Plus className="mr-1 h-3.5 w-3.5" />Add window
        </Button>
      )}
    </div>
  );
}

function scheduleProblem(s: Schedule): string | null {
  if (!validTimeZone(s.timeZone)) return 'Choose a valid time zone for the schedule.';
  if (s.windows.length === 0) return 'Add at least one schedule window.';
  for (const [i, w] of s.windows.entries()) {
    if (w.days.length === 0) return `Schedule window ${i + 1}: pick at least one day.`;
    if (!/^\d\d:\d\d$/.test(w.start) || !/^\d\d:\d\d$/.test(w.end)) return `Schedule window ${i + 1}: set start and end times.`;
    if (w.start === w.end) return `Schedule window ${i + 1}: start and end are the same.`;
  }
  return null;
}

/** Specific computers in one business. Falls back to pasted IDs when the list is not readable. */
function ComputerPicker({ businessId, value, onChange }: { businessId: string; value: string[]; onChange: (v: string[]) => void }) {
  const [q, setQ] = useState('');
  const { data, isLoading, isError } = useQuery<EndpointLite[]>({
    queryKey: ['technicians', 'endpoints', businessId],
    queryFn: () => endpointsApi.list({ businessId, limit: '200' }).then((r) => r.data?.data?.endpoints ?? []),
    enabled: !!businessId,
    retry: false,
  });
  if (!businessId) return <p className="text-xs text-muted-foreground">Choose a business first.</p>;
  if (isLoading) return <p className="text-xs text-muted-foreground">Loading computers…</p>;
  if (isError || !data) {
    return (
      <div className="space-y-1">
        <Textarea
          rows={3} placeholder="One computer ID per line"
          value={value.join('\n')}
          onChange={(e) => onChange(e.target.value.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean))}
        />
        <p className="text-xs text-muted-foreground">
          Your account cannot list this business&apos;s computers, so paste their IDs. The server rejects any ID that is not in the business.
        </p>
      </div>
    );
  }
  const shown = data.filter((e) => !q.trim() || `${e.name} ${e.hostname ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="space-y-2">
      <Input placeholder="Filter computers…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-1">
        {shown.length === 0 && <p className="p-2 text-xs text-muted-foreground">No computers.</p>}
        {shown.map((e) => {
          const on = value.includes(e.id);
          return (
            <button key={e.id} type="button"
              onClick={() => onChange(on ? value.filter((x) => x !== e.id) : [...value, e.id])}
              className={cn('flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm', on ? 'bg-primary/5' : 'hover:bg-muted/50')}>
              <CheckBox on={on} />
              <span className="flex-1 truncate">{e.name}</span>
              {e.isOnline !== undefined && (
                <span className={cn('text-xs', e.isOnline ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground')}>
                  {e.isOnline ? 'online' : 'offline'}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">{value.length} selected</p>
    </div>
  );
}

const REVOKE_COPY =
  'This stops new connections through Rem0te on their next request. It does not change any RustDesk password they already saw, and it does not end a session that is already open. To deal with passwords, use Offboarding or rotate the computer’s credential.';

// ─── Page ────────────────────────────────────────────────────────────────────

export default function TechniciansAdminPage() {
  const { isLoading, canManageTechnicians, isPlatformAdmin, technician, user } = usePermissions();

  const { data: vocab } = useQuery<Vocabulary>({
    queryKey: ['technicians', 'vocabulary'],
    queryFn: () => techniciansApi.vocabulary().then((r) => r.data?.data),
    staleTime: Infinity,
    enabled: canManageTechnicians,
  });
  const { data: approvals = [] } = useQuery<Assignment[]>({
    queryKey: ['technicians', 'approvals'],
    queryFn: () => techniciansApi.approvals().then((r) => r.data?.data ?? []),
    enabled: canManageTechnicians && !technician,
  });

  const capLabels = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of vocab?.capabilityGroups ?? []) for (const i of g.items) m.set(i.key, i.label);
    return m;
  }, [vocab]);

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

  if (!canManageTechnicians) {
    return (
      <div className="p-6">
        <PageHeader title="Technicians" />
        <Card><CardContent className="p-6 text-sm text-muted-foreground">
          Managing technician access needs Platform Admin or the &ldquo;Manage technician access&rdquo; platform permission.
        </CardContent></Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Technicians"
        description="MSP staff working in customer businesses: who can reach which business, with which permissions, and until when."
      />

      {technician && (
        <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          You are working in {technician.businessName} as a technician. Switch back to your own account (business switcher, top left) to manage technician access; the server refuses changes made from a technician context.
        </div>
      )}

      <Card>
        <CardContent className="space-y-1 p-4 text-sm text-muted-foreground">
          <p>
            An assignment gives one person, or a group, access to <strong className="text-foreground">one</strong> business.
            Access is re-checked on every request, so revoking, expiring or narrowing it applies to their very next action.
            Access to one business never carries over to another.
          </p>
          <p>
            Removing access stops <em>new</em> connections through Rem0te. It does not change a RustDesk password they already saw,
            and it does not end a session already open.
          </p>
        </CardContent>
      </Card>

      <Tabs defaultValue="people">
        <TabsList>
          <TabsTrigger value="people"><Users className="mr-1.5 h-4 w-4" />People</TabsTrigger>
          <TabsTrigger value="assignments"><KeyRound className="mr-1.5 h-4 w-4" />Assignments</TabsTrigger>
          <TabsTrigger value="groups"><UserCog className="mr-1.5 h-4 w-4" />Groups</TabsTrigger>
          <TabsTrigger value="approvals">
            <ShieldCheck className="mr-1.5 h-4 w-4" />Approvals
            {approvals.length > 0 && <Badge className="ml-1.5 h-5 px-1.5">{approvals.length}</Badge>}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="people">
          <PeopleTab vocab={vocab} capLabels={capLabels} isPlatformAdmin={isPlatformAdmin} />
        </TabsContent>
        <TabsContent value="assignments">
          <AssignmentsTab vocab={vocab} capLabels={capLabels} isPlatformAdmin={isPlatformAdmin} />
        </TabsContent>
        <TabsContent value="groups">
          <GroupsTab vocab={vocab} capLabels={capLabels} />
        </TabsContent>
        <TabsContent value="approvals">
          <ApprovalsTab
            approvals={approvals} vocab={vocab} capLabels={capLabels}
            isPlatformAdmin={isPlatformAdmin} meId={user?.id ?? null}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─── People ──────────────────────────────────────────────────────────────────

function PeopleTab({ vocab, capLabels, isPlatformAdmin }: { vocab?: Vocabulary; capLabels: Map<string, string>; isPlatformAdmin: boolean }) {
  const [search, setSearch] = useState('');
  const [viewing, setViewing] = useState<Person | null>(null);
  const [permsFor, setPermsFor] = useState<Person | null>(null);

  const { data: people = [], isLoading, error } = useQuery<Person[]>({
    queryKey: ['technicians', 'people'],
    queryFn: () => techniciansApi.people().then((r) => r.data?.data ?? []),
  });

  const filtered = people.filter((p) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return `${personName(p)} ${p.email} ${p.ownBusiness?.name ?? ''} ${p.groups.map((g) => g.name).join(' ')}`.toLowerCase().includes(q);
  });
  const permLabels = vocab?.platformPermissions ?? {};

  return (
    <div className="space-y-3">
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-9" placeholder="Search people…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Loading…</div>
          ) : error ? (
            <div className="p-8 text-center text-sm text-destructive">{errMsg(error) ?? 'Could not load people.'}</div>
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">No people found.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">Person</th>
                    <th className="px-4 py-3 font-medium">Own business</th>
                    <th className="px-4 py-3 font-medium">Technician groups</th>
                    <th className="px-4 py-3 font-medium">Platform permissions</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {filtered.map((p) => (
                    <tr key={p.id} className="hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <div className="font-medium">{personName(p)}</div>
                        <div className="text-xs text-muted-foreground">{p.email}</div>
                        {p.status !== 'ACTIVE' && <Badge variant="secondary" className="mt-1">{p.status}</Badge>}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {p.ownBusiness ? (
                          <>
                            <div>{p.ownBusiness.name}</div>
                            <div className="text-xs">{['BUSINESS_OWNER', 'TENANT_OWNER', 'TENANT_ADMIN'].includes(p.ownRole ?? '') ? 'Business Owner' : 'Business User'}</div>
                          </>
                        ) : <span className="text-xs">None (MSP technician account)</span>}
                      </td>
                      <td className="px-4 py-3">
                        {p.groups.length === 0 ? <span className="text-xs text-muted-foreground">—</span> : (
                          <div className="flex flex-wrap gap-1">{p.groups.map((g) => <Badge key={g.id} variant="secondary">{g.name}</Badge>)}</div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {p.platformPermissions.length === 0 ? <span className="text-xs text-muted-foreground">—</span> : (
                          <div className="flex flex-wrap gap-1">
                            {p.platformPermissions.map((k) => (
                              <Badge key={k} className="bg-purple-100 text-purple-800 dark:bg-purple-900/60 dark:text-purple-200">{permLabels[k]?.label ?? k}</Badge>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right">
                        <Button variant="outline" size="sm" onClick={() => setViewing(p)}>Effective access</Button>
                        {isPlatformAdmin && (
                          <Button variant="ghost" size="sm" className="ml-1" onClick={() => setPermsFor(p)}>Permissions</Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <EffectiveDialog person={viewing} onClose={() => setViewing(null)} capLabels={capLabels} />
      {isPlatformAdmin && (
        <PlatformPermissionsDialog person={permsFor} onClose={() => setPermsFor(null)} labels={permLabels} />
      )}
    </div>
  );
}

function SourceLine({ s, capLabels }: { s: GrantSource; capLabels: Map<string, string> }) {
  return (
    <div className="space-y-1.5 rounded-md border bg-background p-2 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline">{s.via === 'DIRECT' ? 'Assigned directly' : `Through group ${s.groupName ?? ''}`}</Badge>
        <Badge className={APPROVAL_STYLE[s.approval] ?? ''}>{APPROVAL_LABEL[s.approval] ?? s.approval}</Badge>
        <span className="text-muted-foreground">{s.endpointIds ? `${s.endpointIds.length} selected computer(s)` : 'All computers'}</span>
      </div>
      <WhenBadges startsAt={s.startsAt} expiresAt={s.expiresAt} schedule={s.schedule} />
      <CapBadges caps={s.capabilities} labels={capLabels} />
    </div>
  );
}

function EffectiveDialog({ person, onClose, capLabels }: { person: Person | null; onClose: () => void; capLabels: Map<string, string> }) {
  const { data, isLoading, error } = useQuery<{ businesses: BusinessScope[]; inactive: InactiveGrant[] }>({
    queryKey: ['technicians', 'effective', person?.id],
    queryFn: () => techniciansApi.effective(person!.id).then((r) => r.data?.data),
    enabled: !!person,
  });
  return (
    <Dialog open={!!person} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Effective technician access</DialogTitle>
          <DialogDescription>
            {person ? `${personName(person)} · ${person.email}. ` : ''}
            What counts right now. Several grants to the same business add up; one lapsing does not affect the others.
            {person?.ownBusiness ? ` Their own business (${person.ownBusiness.name}) is not listed here.` : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : error ? (
            <p className="text-sm text-destructive">{errMsg(error) ?? 'Could not load access.'}</p>
          ) : (
            <>
              <section className="space-y-2">
                <h3 className="text-sm font-semibold">Active now ({data?.businesses.length ?? 0})</h3>
                {(data?.businesses ?? []).length === 0 && <p className="text-sm text-muted-foreground">No business reachable as a technician right now.</p>}
                {(data?.businesses ?? []).map((b) => (
                  <div key={b.businessId} className="space-y-2 rounded-md border bg-muted/30 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">{b.businessName}</span>
                      <span className="text-xs text-muted-foreground">{b.endpointIds ? `${b.endpointIds.length} selected computer(s)` : 'All computers'}</span>
                    </div>
                    <CapBadges caps={b.capabilities} labels={capLabels} />
                    <div className="text-xs font-medium text-muted-foreground">Because of:</div>
                    {b.sources.map((s) => <SourceLine key={s.assignmentId} s={s} capLabels={capLabels} />)}
                  </div>
                ))}
              </section>
              <section className="space-y-2">
                <h3 className="text-sm font-semibold">Not counting right now ({data?.inactive.length ?? 0})</h3>
                {(data?.inactive ?? []).length === 0 && <p className="text-sm text-muted-foreground">None.</p>}
                {(data?.inactive ?? []).map((g) => (
                  <div key={g.assignmentId} className="space-y-1.5 rounded-md border border-dashed p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">{g.businessName}</span>
                      <Badge className={APPROVAL_STYLE.PENDING}>{INACTIVE_REASON[g.inactiveReason] ?? g.inactiveReason}</Badge>
                    </div>
                    <SourceLine s={g} capLabels={capLabels} />
                  </div>
                ))}
              </section>
            </>
          )}
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PlatformPermissionsDialog({
  person, onClose, labels,
}: { person: Person | null; onClose: () => void; labels: Vocabulary['platformPermissions'] }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [selected, setSelected] = useState<string[]>([]);
  const [seeded, setSeeded] = useState<string | null>(null);
  if (person && seeded !== person.id) { setSelected(person.platformPermissions); setSeeded(person.id); }
  if (!person && seeded !== null) setSeeded(null);

  const save = useMutation({
    mutationFn: () => techniciansApi.setPlatformPermissions(person!.id, selected),
    onSuccess: () => {
      toast({ title: 'Platform permissions saved' });
      qc.invalidateQueries({ queryKey: ['technicians', 'people'] });
      onClose();
    },
    onError: (e) => toast({ title: 'Could not save', description: errMsg(e), variant: 'destructive' }),
  });

  return (
    <Dialog open={!!person} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Platform permissions</DialogTitle>
          <DialogDescription>
            {person ? `${personName(person)}. ` : ''}These are not Platform Admin and grant no access to any business by themselves.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          {Object.entries(labels).map(([k, v]) => {
            const on = selected.includes(k);
            return (
              <button key={k} type="button"
                onClick={() => setSelected(on ? selected.filter((x) => x !== k) : [...selected, k])}
                className={cn('flex w-full items-start gap-3 rounded-md border p-2.5 text-left', on ? 'border-primary/40 bg-primary/5' : 'hover:bg-muted/50')}>
                <CheckBox on={on} />
                <span>
                  <span className="block text-sm font-medium">{v.label}</span>
                  <span className="block text-xs text-muted-foreground">{v.description}</span>
                </span>
              </button>
            );
          })}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Assignments ─────────────────────────────────────────────────────────────

/**
 * Businesses a manager can pick. A Platform Admin can list them all; a
 * `technicians:manage` holder cannot (the businesses endpoint is scoped to
 * their own), so we also offer every business already seen in assignments and
 * people's own memberships.
 */
function useBusinessOptions(assignments: Assignment[]) {
  const { data: listed = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['businesses', ''],
    queryFn: () => businessesApi.list().then((r) => r.data?.data ?? []),
    retry: false,
  });
  const { data: people = [] } = useQuery<Person[]>({
    queryKey: ['technicians', 'people'],
    queryFn: () => techniciansApi.people().then((r) => r.data?.data ?? []),
  });
  return useMemo(() => {
    const m = new Map<string, string>();
    for (const b of listed) m.set(b.id, b.name);
    for (const a of assignments) m.set(a.customer.id, a.customer.name);
    for (const p of people) if (p.ownBusiness) m.set(p.ownBusiness.id, p.ownBusiness.name);
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [listed, assignments, people]);
}

function AssignmentsTab({ vocab, capLabels, isPlatformAdmin }: { vocab?: Vocabulary; capLabels: Map<string, string>; isPlatformAdmin: boolean }) {
  const [includeRevoked, setIncludeRevoked] = useState(false);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<Assignment | null>(null);

  const { data: rows = [], isLoading, error } = useQuery<Assignment[]>({
    queryKey: ['technicians', 'assignments', includeRevoked],
    queryFn: () => techniciansApi.assignments(includeRevoked ? { includeRevoked: 'true' } : undefined).then((r) => r.data?.data ?? []),
  });
  const businesses = useBusinessOptions(rows);

  const filtered = rows.filter((a) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return `${a.customer.name} ${a.user ? `${personName(a.user)} ${a.user.email}` : ''} ${a.group?.name ?? ''} ${a.reason ?? ''}`.toLowerCase().includes(q);
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search assignments…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <button type="button" onClick={() => setIncludeRevoked(!includeRevoked)} className="flex items-center gap-2 text-sm">
          <CheckBox on={includeRevoked} />Show revoked
        </button>
        <Button size="sm" className="ml-auto" onClick={() => setCreating(true)} disabled={!vocab}>
          <Plus className="mr-2 h-4 w-4" />New assignment
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Loading…</div>
          ) : error ? (
            <div className="p-8 text-center text-sm text-destructive">{errMsg(error) ?? 'Could not load assignments.'}</div>
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">No assignments.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">Who</th>
                    <th className="px-4 py-3 font-medium">Business</th>
                    <th className="px-4 py-3 font-medium">Permissions</th>
                    <th className="px-4 py-3 font-medium">When</th>
                    <th className="px-4 py-3 font-medium">Approval</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {filtered.map((a) => {
                    const st = assignmentStatus(a);
                    return (
                      <tr key={a.id} className={cn('align-top hover:bg-muted/30', a.revokedAt && 'opacity-60')}>
                        <td className="px-4 py-3">
                          {a.user ? (
                            <>
                              <div className="font-medium">{personName(a.user)}</div>
                              <div className="text-xs text-muted-foreground">{a.user.email}</div>
                            </>
                          ) : (
                            <div className="font-medium"><Users className="mr-1 inline h-3.5 w-3.5" />Group: {a.group?.name ?? '—'}</div>
                          )}
                          {a.requestedById && <div className="text-xs text-muted-foreground">Self-requested</div>}
                          {a.reason && <div className="mt-1 max-w-[16rem] text-xs text-muted-foreground">“{a.reason}”</div>}
                        </td>
                        <td className="px-4 py-3">
                          <div>{a.customer.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {a.endpointIds.length ? `${a.endpointIds.length} selected computer(s)` : 'All computers'}
                          </div>
                        </td>
                        <td className="max-w-[18rem] px-4 py-3"><CapBadges caps={a.capabilities} labels={capLabels} /></td>
                        <td className="px-4 py-3">
                          <WhenBadges startsAt={a.startsAt} expiresAt={a.expiresAt} schedule={describeSchedule(a.schedule)} />
                        </td>
                        <td className="px-4 py-3">
                          <Badge className={APPROVAL_STYLE[a.approvalStatus]}>{APPROVAL_LABEL[a.approvalStatus]}</Badge>
                          {a.decisionNote && <div className="mt-1 text-xs text-muted-foreground">“{a.decisionNote}”</div>}
                        </td>
                        <td className="px-4 py-3">
                          <Badge className={st.className}>{st.label}</Badge>
                          {a.revokedAt && (
                            <div className="mt-1 text-xs text-muted-foreground">
                              {formatDate(a.revokedAt)}{a.revokeReason ? ` · ${a.revokeReason}` : ''}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {!a.revokedAt && (
                            <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setRevoking(a)}>
                              <UserMinus className="mr-1 h-4 w-4" />Revoke
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {vocab && (
        <CreateAssignmentDialog
          open={creating} onClose={() => setCreating(false)} vocab={vocab}
          businesses={businesses} isPlatformAdmin={isPlatformAdmin}
        />
      )}
      <RevokeDialog assignment={revoking} onClose={() => setRevoking(null)} />
    </div>
  );
}

function RevokeDialog({ assignment, onClose }: { assignment: Assignment | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [reason, setReason] = useState('');
  const revoke = useMutation({
    mutationFn: () => techniciansApi.revokeAssignment(assignment!.id, reason.trim() || undefined),
    onSuccess: () => {
      toast({ title: 'Assignment revoked', description: 'New connections through Rem0te are refused from now on.' });
      qc.invalidateQueries({ queryKey: ['technicians'] });
      setReason('');
      onClose();
    },
    onError: (e) => toast({ title: 'Could not revoke', description: errMsg(e), variant: 'destructive' }),
  });
  return (
    <Dialog open={!!assignment} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke assignment</DialogTitle>
          <DialogDescription>
            {assignment ? `${assignment.user ? personName(assignment.user) : `Group ${assignment.group?.name}`} in ${assignment.customer.name}.` : ''}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{REVOKE_COPY}</p>
        <div>
          <Label htmlFor="rr">Reason (recorded in the audit log)</Label>
          <Textarea id="rr" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" disabled={revoke.isPending} onClick={() => revoke.mutate()}>
            {revoke.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Revoke
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const PRESETS: { label: string; hours: number }[] = [
  { label: '4 hours', hours: 4 }, { label: '1 day', hours: 24 }, { label: '1 week', hours: 24 * 7 }, { label: '30 days', hours: 24 * 30 },
];

function CreateAssignmentDialog({
  open, onClose, vocab, businesses, isPlatformAdmin,
}: {
  open: boolean; onClose: () => void; vocab: Vocabulary;
  businesses: { id: string; name: string }[]; isPlatformAdmin: boolean;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const blank = () => ({
    target: 'user' as 'user' | 'group', userId: '', groupId: '', businessId: '', businessIdManual: '',
    capabilities: [] as string[], whole: true, endpointIds: [] as string[],
    startsAt: '', expiresAt: '', scheduled: false,
    schedule: { timeZone: browserTimeZone(), windows: [{ days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' }] } as Schedule,
    reason: '', personFilter: '',
    // null = not chosen yet, which means the L1 Help Desk preset.
    presetChoice: null as string | null,
  });
  const [f, setF] = useState(blank);
  const [wasOpen, setWasOpen] = useState(false);
  if (open && !wasOpen) { setF(blank()); setWasOpen(true); }
  if (!open && wasOpen) setWasOpen(false);

  const { data: people = [] } = useQuery<Person[]>({
    queryKey: ['technicians', 'people'],
    queryFn: () => techniciansApi.people().then((r) => r.data?.data ?? []),
    enabled: open,
  });
  const { data: groups = [] } = useQuery<Group[]>({
    queryKey: ['technicians', 'groups'],
    queryFn: () => techniciansApi.groups().then((r) => r.data?.data ?? []),
    enabled: open,
  });

  // v0.23: an assignment is made from a preset (capabilities derived on every
  // request, never connect or credential) or, deliberately, from custom
  // capabilities as before.
  const { data: presetList, isError: presetsFailed } = useQuery<{ presets: PresetLite[] }>({
    queryKey: ['security-controls', 'presets'],
    queryFn: () => securityControlsApi.presets().then((r) => r.data?.data),
    enabled: open,
    retry: false,
  });
  const presets = presetList?.presets ?? [];
  const l1 = presets.find((p) => p.key === 'l1-help-desk') ?? presets.find((p) => p.builtIn && p.tier === 'L1');
  // Presets unreadable (or none seeded): fall back to custom rather than block.
  const presetChoice = f.presetChoice ?? (l1?.id ?? (presetList || presetsFailed ? CUSTOM_PRESET : ''));
  const custom = presetChoice === CUSTOM_PRESET;
  const chosenPreset = presets.find((p) => p.id === presetChoice);

  const businessId = f.businessIdManual.trim() || f.businessId;
  const group = groups.find((g) => g.id === f.groupId);
  const shownPeople = people
    .filter((p) => !f.personFilter.trim() || `${personName(p)} ${p.email}`.toLowerCase().includes(f.personFilter.toLowerCase()))
    .slice(0, 100);

  const problem = (() => {
    if (f.target === 'user' && !f.userId) return 'Choose a person.';
    if (f.target === 'group' && !f.groupId) return 'Choose a group.';
    if (!businessId) return 'Choose a business.';
    if (!presetChoice) return 'Loading access levels…';
    if (custom && f.capabilities.length === 0 && !(f.target === 'group' && (group?.capabilities.length ?? 0) > 0)) return 'Choose at least one permission.';
    if (!f.whole && f.endpointIds.length === 0) return 'Pick at least one computer, or choose the whole business.';
    if (f.startsAt && f.expiresAt && new Date(f.expiresAt) <= new Date(f.startsAt)) return 'The end must be after the start.';
    if (f.scheduled) return scheduleProblem(f.schedule);
    return null;
  })();

  const create = useMutation({
    mutationFn: () => techniciansApi.createAssignment({
      ...(f.target === 'user' ? { userId: f.userId } : { groupId: f.groupId }),
      businessId,
      ...(custom
        ? (f.capabilities.length ? { capabilities: f.capabilities } : {})
        : { presetId: presetChoice }),
      ...(f.whole ? {} : { endpointIds: f.endpointIds }),
      startsAt: fromLocalInput(f.startsAt),
      expiresAt: fromLocalInput(f.expiresAt),
      ...(f.scheduled ? { schedule: f.schedule } : {}),
      ...(f.reason.trim() ? { reason: f.reason.trim() } : {}),
    }),
    onSuccess: (res) => {
      const pending = res.data?.data?.approvalStatus === 'PENDING';
      toast({
        title: pending ? 'Assignment created: waiting for approval' : 'Assignment created',
        description: pending
          ? "This business requires approval. The assignment grants nothing until its Business Owner approves it."
          : undefined,
      });
      qc.invalidateQueries({ queryKey: ['technicians'] });
      onClose();
    },
    onError: (e) => toast({ title: 'Could not create assignment', description: errMsg(e), variant: 'destructive' }),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New technician assignment</DialogTitle>
          <DialogDescription>Access to one business. Recorded in the audit log.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-1">
          <div className="flex gap-2">
            {(['user', 'group'] as const).map((t) => (
              <Button key={t} type="button" size="sm" variant={f.target === t ? 'default' : 'outline'} onClick={() => setF({ ...f, target: t })}>
                {t === 'user' ? 'A person' : 'A group'}
              </Button>
            ))}
          </div>

          {f.target === 'user' ? (
            <div className="space-y-1.5">
              <Label>Person</Label>
              <Input placeholder="Filter by name or email…" value={f.personFilter} onChange={(e) => setF({ ...f, personFilter: e.target.value })} />
              <Select value={f.userId} onValueChange={(v) => setF({ ...f, userId: v })}>
                <SelectTrigger><SelectValue placeholder="Choose a person" /></SelectTrigger>
                <SelectContent>
                  {shownPeople.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{personName(p)} · {p.email}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Platform Admins are not listed: they already reach every business.</p>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label>Group</Label>
              <Select value={f.groupId} onValueChange={(v) => setF({ ...f, groupId: v })}>
                <SelectTrigger><SelectValue placeholder={groups.length ? 'Choose a group' : 'No groups yet'} /></SelectTrigger>
                <SelectContent>
                  {groups.map((g) => <SelectItem key={g.id} value={g.id}>{g.name} ({g.members.length})</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Everyone in the group gets this access while they are a member. Leave permissions empty to copy the group&apos;s
                defaults; that is a snapshot, so editing the group later does not change this assignment.
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Business</Label>
            <Select value={f.businessId} onValueChange={(v) => setF({ ...f, businessId: v, businessIdManual: '', endpointIds: [] })}>
              <SelectTrigger><SelectValue placeholder="Choose a business" /></SelectTrigger>
              <SelectContent>
                {businesses.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {!isPlatformAdmin && (
              <>
                <Input
                  placeholder="…or paste a business ID" value={f.businessIdManual}
                  onChange={(e) => setF({ ...f, businessIdManual: e.target.value, endpointIds: [] })}
                />
                <p className="text-xs text-muted-foreground">
                  Only a Platform Admin can list every business. The list above shows businesses already seen in assignments and memberships.
                </p>
              </>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Access level</Label>
            <Select value={presetChoice} onValueChange={(v) => setF({ ...f, presetChoice: v })}>
              <SelectTrigger><SelectValue placeholder="Loading access levels…" /></SelectTrigger>
              <SelectContent>
                {presets.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}{p.builtIn ? '' : ' (custom preset)'}</SelectItem>)}
                <SelectItem value={CUSTOM_PRESET}>Custom capabilities</SelectItem>
              </SelectContent>
            </Select>
            {chosenPreset?.description && <p className="text-xs text-muted-foreground">{chosenPreset.description}</p>}
            <p className="text-xs text-muted-foreground">
              New technicians start at L1. No preset grants Remote connect or credential access: interactive control is only
              ever a temporary, independently approved grant. Presets are managed under{' '}
              <Link href="/settings/security/technician-access" className="underline underline-offset-2">Settings → Security → Technician Access</Link>.
            </p>
          </div>

          {custom && (
            <div className="space-y-1.5">
              <Label>Permissions in that business</Label>
              {f.target === 'group' && group && group.capabilities.length > 0 && f.capabilities.length === 0 && (
                <p className="text-xs text-muted-foreground">Nothing chosen: the group&apos;s {group.capabilities.length} default permission(s) will be copied.</p>
              )}
              <CapabilityPicker groups={vocab.capabilityGroups} value={f.capabilities} onChange={(v) => setF({ ...f, capabilities: v })} />
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Computers</Label>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant={f.whole ? 'default' : 'outline'} onClick={() => setF({ ...f, whole: true })}>Whole business</Button>
              <Button type="button" size="sm" variant={!f.whole ? 'default' : 'outline'} onClick={() => setF({ ...f, whole: false })}>Specific computers</Button>
            </div>
            {!f.whole && <ComputerPicker businessId={businessId} value={f.endpointIds} onChange={(v) => setF({ ...f, endpointIds: v })} />}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="sa">Starts (optional)</Label>
              <Input id="sa" type="datetime-local" value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} />
              <p className="text-xs text-muted-foreground">Empty: starts immediately.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ea">Ends (optional)</Label>
              <Input id="ea" type="datetime-local" value={f.expiresAt} onChange={(e) => setF({ ...f, expiresAt: e.target.value })} />
              <div className="flex flex-wrap gap-1">
                {PRESETS.map((p) => (
                  <button key={p.label} type="button" className="rounded border px-1.5 py-0.5 text-xs hover:bg-muted"
                    onClick={() => {
                      const base = f.startsAt ? new Date(f.startsAt) : new Date();
                      setF({ ...f, expiresAt: toLocalInput(new Date(base.getTime() + p.hours * 3600_000)) });
                    }}>
                    +{p.label}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {f.expiresAt ? 'Temporary: access stops by itself at this time.' : 'Empty: no end date. It lasts until revoked.'}
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <button type="button" onClick={() => setF({ ...f, scheduled: !f.scheduled })} className="flex items-center gap-2 text-sm font-medium">
              <CheckBox on={f.scheduled} />Only during set weekly hours
            </button>
            {f.scheduled && <ScheduleEditor value={f.schedule} onChange={(s) => setF({ ...f, schedule: s })} />}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="rs">Reason</Label>
            <Textarea id="rs" rows={2} maxLength={500} placeholder="e.g. Contractor for the March server migration"
              value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
          </div>

          <p className="text-xs text-muted-foreground">
            If the business requires approval for technician access, this assignment is created as pending and grants nothing until its Business Owner approves it.
          </p>
        </div>
        <DialogFooter className="items-center">
          {problem && <span className="mr-auto text-xs text-muted-foreground">{problem}</span>}
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!!problem || create.isPending} onClick={() => create.mutate()}>
            {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Create assignment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Groups ──────────────────────────────────────────────────────────────────

function GroupsTab({ vocab, capLabels }: { vocab?: Vocabulary; capLabels: Map<string, string> }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState<Group | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Group | null>(null);

  const { data: groups = [], isLoading, error } = useQuery<Group[]>({
    queryKey: ['technicians', 'groups'],
    queryFn: () => techniciansApi.groups().then((r) => r.data?.data ?? []),
  });
  const { data: people = [] } = useQuery<Person[]>({
    queryKey: ['technicians', 'people'],
    queryFn: () => techniciansApi.people().then((r) => r.data?.data ?? []),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['technicians'] });

  const del = useMutation({
    mutationFn: (id: string) => techniciansApi.deleteGroup(id),
    onSuccess: () => { toast({ title: 'Group deleted' }); invalidate(); setDeleting(null); },
    onError: (e) => toast({ title: 'Could not delete group', description: errMsg(e), variant: 'destructive' }),
  });
  const addMember = useMutation({
    mutationFn: ({ id, userId }: { id: string; userId: string }) => techniciansApi.addMember(id, userId),
    onSuccess: () => { toast({ title: 'Member added' }); invalidate(); },
    onError: (e) => toast({ title: 'Could not add member', description: errMsg(e), variant: 'destructive' }),
  });
  const removeMember = useMutation({
    mutationFn: ({ id, userId }: { id: string; userId: string }) => techniciansApi.removeMember(id, userId),
    onSuccess: () => { toast({ title: 'Member removed', description: 'New connections through this group are refused from now on.' }); invalidate(); },
    onError: (e) => toast({ title: 'Could not remove member', description: errMsg(e), variant: 'destructive' }),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          A group bundles technicians so one assignment covers all of them. Default permissions are copied into each new assignment.
        </p>
        <Button size="sm" onClick={() => setEditing('new')} disabled={!vocab}><Plus className="mr-2 h-4 w-4" />New group</Button>
      </div>

      {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : error ? (
        <p className="text-sm text-destructive">{errMsg(error) ?? 'Could not load groups.'}</p>
      ) : groups.length === 0 ? (
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">No groups yet.</CardContent></Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {groups.map((g) => {
            const memberIds = new Set(g.members.map((m) => m.userId));
            const candidates = people.filter((p) => !memberIds.has(p.id));
            return (
              <Card key={g.id}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <CardTitle className="text-base">{g.name}</CardTitle>
                      {g.description && <CardDescription>{g.description}</CardDescription>}
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => setEditing(g)} aria-label="Edit group"><Pencil className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-destructive" onClick={() => setDeleting(g)} aria-label="Delete group"><Trash2 className="h-4 w-4" /></Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <div>
                    <div className="mb-1 text-xs font-medium text-muted-foreground">Default permissions</div>
                    <CapBadges caps={g.capabilities} labels={capLabels} />
                  </div>
                  <div>
                    <div className="mb-1 text-xs font-medium text-muted-foreground">Active assignments</div>
                    {g.assignments.length === 0 ? <span className="text-xs text-muted-foreground">None</span> : (
                      <div className="flex flex-wrap gap-1">{g.assignments.map((a) => <Badge key={a.id} variant="secondary">{a.customer.name}</Badge>)}</div>
                    )}
                  </div>
                  <div>
                    <div className="mb-1 text-xs font-medium text-muted-foreground">Members ({g.members.length})</div>
                    <div className="space-y-1">
                      {g.members.map((m) => (
                        <div key={m.id} className="flex items-center justify-between gap-2 rounded border px-2 py-1">
                          <span className="min-w-0 truncate">{personName(m.user)} <span className="text-xs text-muted-foreground">{m.user.email}</span></span>
                          <Button variant="ghost" size="sm" className="h-7 w-7 shrink-0 p-0" aria-label="Remove member"
                            disabled={removeMember.isPending}
                            onClick={() => removeMember.mutate({ id: g.id, userId: m.userId })}>
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ))}
                    </div>
                    <div className="mt-2">
                      <Select value="" onValueChange={(v) => addMember.mutate({ id: g.id, userId: v })}>
                        <SelectTrigger className="h-9"><SelectValue placeholder="Add a member…" /></SelectTrigger>
                        <SelectContent>
                          {candidates.slice(0, 200).map((p) => <SelectItem key={p.id} value={p.id}>{personName(p)} · {p.email}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {vocab && <GroupDialog group={editing} onClose={() => setEditing(null)} vocab={vocab} />}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete group ${deleting?.name ?? ''}?`}
        description={`This also deletes the group's ${deleting?.assignments.length ?? 0} assignment(s), so its members lose that access on their next request. It does not change any RustDesk password they already saw and does not end a session already open.`}
        confirmLabel="Delete group"
        destructive
        loading={del.isPending}
        onConfirm={() => deleting && del.mutate(deleting.id)}
      />
    </div>
  );
}

function GroupDialog({ group, onClose, vocab }: { group: Group | 'new' | null; onClose: () => void; vocab: Vocabulary }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [f, setF] = useState({ name: '', description: '', capabilities: [] as string[] });
  const key = group === 'new' ? 'new' : group?.id ?? null;
  const [seeded, setSeeded] = useState<string | null>(null);
  if (key !== seeded) {
    setSeeded(key);
    if (group && group !== 'new') setF({ name: group.name, description: group.description ?? '', capabilities: group.capabilities });
    else setF({ name: '', description: '', capabilities: [] });
  }

  const save = useMutation({
    mutationFn: () => {
      const body = { name: f.name.trim(), description: f.description.trim(), capabilities: f.capabilities };
      return group === 'new' ? techniciansApi.createGroup(body) : techniciansApi.updateGroup((group as Group).id, body);
    },
    onSuccess: () => {
      toast({ title: group === 'new' ? 'Group created' : 'Group saved' });
      qc.invalidateQueries({ queryKey: ['technicians'] });
      onClose();
    },
    onError: (e) => toast({ title: 'Could not save group', description: errMsg(e), variant: 'destructive' }),
  });

  return (
    <Dialog open={!!group} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{group === 'new' ? 'New technician group' : 'Edit group'}</DialogTitle>
          <DialogDescription>
            Default permissions are copied into new assignments made to this group. Changing them here does not change existing assignments.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
          <div>
            <Label htmlFor="gn">Name</Label>
            <Input id="gn" maxLength={100} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="gd">Description</Label>
            <Textarea id="gd" rows={2} maxLength={500} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
          </div>
          <div>
            <Label>Default permissions</Label>
            <CapabilityPicker groups={vocab.capabilityGroups} value={f.capabilities} onChange={(v) => setF({ ...f, capabilities: v })} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!f.name.trim() || save.isPending} onClick={() => save.mutate()}>
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Approvals ───────────────────────────────────────────────────────────────

function ApprovalsTab({
  approvals, vocab, capLabels, isPlatformAdmin, meId,
}: {
  approvals: Assignment[]; vocab?: Vocabulary; capLabels: Map<string, string>; isPlatformAdmin: boolean; meId: string | null;
}) {
  const [deciding, setDeciding] = useState<{ a: Assignment; decision: 'APPROVE' | 'DENY' } | null>(null);
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {isPlatformAdmin
          ? 'Pending requests across every business. Normally the Business Owner decides; as Platform Admin you can too.'
          : "Only a business's own Business Owner (or a Platform Admin) can approve technician access to it, so this list shows only requests you may decide."}
      </p>
      {approvals.length === 0 ? (
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">Nothing waiting for a decision.</CardContent></Card>
      ) : (
        <div className="space-y-3">
          {approvals.map((a) => {
            const self = !!meId && (a.userId === meId || a.requestedById === meId);
            return (
              <Card key={a.id}>
                <CardContent className="space-y-2 p-4 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="font-medium">
                        {a.user ? personName(a.user) : `Group ${a.group?.name ?? ''}`} → {a.customer.name}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {a.user?.email ? `${a.user.email} · ` : ''}{a.requestedById ? 'Requested by the technician' : 'Created by a technician manager'} · {formatDate(a.createdAt)}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" onClick={() => setDeciding({ a, decision: 'DENY' })}>Deny</Button>
                      <Button size="sm" disabled={self} title={self ? 'You cannot approve access for yourself' : undefined}
                        onClick={() => setDeciding({ a, decision: 'APPROVE' })}>Approve…</Button>
                    </div>
                  </div>
                  {a.reason && <p className="rounded bg-muted/50 p-2 text-xs">“{a.reason}”</p>}
                  <div className="text-xs text-muted-foreground">{a.endpointIds.length ? `${a.endpointIds.length} selected computer(s)` : 'All computers'}</div>
                  <WhenBadges startsAt={a.startsAt} expiresAt={a.expiresAt} schedule={describeSchedule(a.schedule)} />
                  <CapBadges caps={a.capabilities} labels={capLabels} />
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
      {vocab && <DecisionDialog state={deciding} onClose={() => setDeciding(null)} vocab={vocab} />}
    </div>
  );
}

function DecisionDialog({
  state, onClose, vocab,
}: { state: { a: Assignment; decision: 'APPROVE' | 'DENY' } | null; onClose: () => void; vocab: Vocabulary }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [note, setNote] = useState('');
  const [caps, setCaps] = useState<string[]>([]);
  const [eps, setEps] = useState<string[]>([]);
  const [narrowComputers, setNarrowComputers] = useState(false);
  const [expires, setExpires] = useState('');
  const [seeded, setSeeded] = useState<string | null>(null);
  const key = state ? `${state.a.id}:${state.decision}` : null;
  if (key !== seeded) {
    setSeeded(key);
    setNote('');
    setCaps(state?.a.capabilities ?? []);
    setEps(state?.a.endpointIds ?? []);
    setNarrowComputers(false);
    setExpires(state?.a.expiresAt ? toLocalInput(new Date(state.a.expiresAt)) : '');
  }
  const a = state?.a;
  const approving = state?.decision === 'APPROVE';
  const wholeBusiness = (a?.endpointIds.length ?? 0) === 0;

  const { data: endpoints } = useQuery<EndpointLite[]>({
    queryKey: ['technicians', 'decision-endpoints', a?.customerId],
    queryFn: () => endpointsApi.list({ businessId: a!.customerId, limit: '200' }).then((r) => r.data?.data?.endpoints ?? []),
    enabled: !!a && approving,
    retry: false,
  });
  const epName = new Map((endpoints ?? []).map((e) => [e.id, e.name]));

  const problem = (() => {
    if (!approving || !a) return null;
    if (caps.length === 0) return 'Approving with no permissions grants nothing; deny instead.';
    if (!wholeBusiness && eps.length === 0) return 'Keep at least one computer, or deny.';
    if (wholeBusiness && narrowComputers && eps.length === 0) return 'Pick at least one computer, or keep the whole business.';
    if (expires && a.expiresAt && new Date(expires) > new Date(a.expiresAt)) return 'Approval can only shorten the requested window.';
    return null;
  })();

  const decide = useMutation({
    mutationFn: () => {
      const body: { decision: 'APPROVE' | 'DENY'; note?: string; capabilities?: string[]; endpointIds?: string[]; expiresAt?: string | null } = {
        decision: state!.decision, ...(note.trim() ? { note: note.trim() } : {}),
      };
      if (approving && a) {
        if (caps.length !== a.capabilities.length) body.capabilities = caps;
        if (!wholeBusiness && eps.length !== a.endpointIds.length) body.endpointIds = eps;
        if (wholeBusiness && narrowComputers) body.endpointIds = eps;
        const iso = fromLocalInput(expires);
        if (iso && iso !== (a.expiresAt ? new Date(a.expiresAt).toISOString() : null)) body.expiresAt = iso;
      }
      return techniciansApi.decide(a!.id, body);
    },
    onSuccess: () => {
      toast({ title: approving ? 'Approved' : 'Denied' });
      qc.invalidateQueries({ queryKey: ['technicians'] });
      onClose();
    },
    onError: (e) => toast({ title: 'Could not record the decision', description: errMsg(e), variant: 'destructive' }),
  });

  return (
    <Dialog open={!!state} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{approving ? 'Approve request' : 'Deny request'}</DialogTitle>
          <DialogDescription>
            {a ? `${a.user ? personName(a.user) : `Group ${a.group?.name}`} → ${a.customer.name}. ` : ''}
            {approving ? 'You can narrow what was asked for (fewer permissions, fewer computers, an earlier end) but not widen it.' : 'The request grants nothing.'}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          {approving && a && (
            <>
              <div className="space-y-1.5">
                <Label>Permissions</Label>
                <CapabilityPicker groups={vocab.capabilityGroups} value={caps} onChange={setCaps} allowed={a.capabilities} />
              </div>
              <div className="space-y-1.5">
                <Label>Computers</Label>
                {wholeBusiness ? (
                  <>
                    <button type="button" onClick={() => setNarrowComputers(!narrowComputers)} className="flex items-center gap-2 text-sm">
                      <CheckBox on={narrowComputers} />Requested the whole business. Limit to specific computers
                    </button>
                    {narrowComputers && <ComputerPicker businessId={a.customerId} value={eps} onChange={setEps} />}
                  </>
                ) : (
                  <div className="space-y-1 rounded-md border p-1">
                    {a.endpointIds.map((id) => {
                      const on = eps.includes(id);
                      return (
                        <button key={id} type="button" onClick={() => setEps(on ? eps.filter((x) => x !== id) : [...eps, id])}
                          className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted/50">
                          <CheckBox on={on} /><span className="truncate">{epName.get(id) ?? id}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dx">Ends</Label>
                <Input id="dx" type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)}
                  max={a.expiresAt ? toLocalInput(new Date(a.expiresAt)) : undefined} />
                <p className="text-xs text-muted-foreground">
                  {a.expiresAt ? `Requested until ${formatDate(a.expiresAt)}. You can only make it earlier.` : 'Requested with no end date. Set one to make it temporary.'}
                </p>
              </div>
            </>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="dn">Note (shown in the audit log)</Label>
            <Textarea id="dn" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
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
