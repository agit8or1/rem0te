'use client';

import { Suspense, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, ArrowRight, Check, Clock, Info, KeyRound, Loader2, UserMinus, Wifi, WifiOff,
} from 'lucide-react';
import { businessesApi, offboardingApi, techniciansApi, usersApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { connectivityHint, connectivityLabel, connectivityOf } from '@/lib/connectivity';

// ─── Types (apps/api/src/offboarding/offboarding.service.ts) ─────────────────

interface RotationSummary { total: number; confirmed: number; pending: number; failed: number; offlinePending: number }
interface CaseRow {
  id: string;
  subjectEmail: string | null;
  businessId: string | null;
  startedAt: string;
  completedAt: string | null;
  rotation: RotationSummary;
}
interface PendingRotation {
  endpointId: string; name: string; businessName: string | null; online: boolean; lastSeenAt: string | null; stagedAt: string;
}
interface Credential {
  endpointId: string; name: string; businessId: string | null; businessName: string | null;
  lastObtainedAt: string; how: string[]; online: boolean; lastSeenAt: string | null;
  canRotate: boolean; rotationAlreadyPending: boolean;
}
interface Preview {
  subject: { id: string; email: string; name: string; status: string };
  scope: 'business' | 'platform';
  businessId: string | null;
  willRevoke: {
    membership: boolean; computerGrants: number; technicianAssignments: number; groupMemberships: number;
    unredeemedLauncherTokens: number; unredeemedConnectionGrants: number;
  };
  canSuspendAccount: boolean;
  suspendBlockedReason: string | null;
  credentialsObtained: Credential[];
  sharedPasswords: { computers: { endpointId: string; name: string }[] }[];
  limits: string[];
}
interface Membership {
  id: string;
  user: { id: string; email: string; firstName: string | null; lastName: string | null; isPlatformAdmin: boolean; status: string };
  business: { id: string; name: string } | null;
}
interface Person { id: string; email: string; firstName: string | null; lastName: string | null; ownBusiness: { id: string; name: string } | null }

type ApiErr = { response?: { status?: number; data?: { message?: string | string[] } } };
function errMsg(e: unknown): string | undefined {
  const m = (e as ApiErr)?.response?.data?.message;
  return Array.isArray(m) ? m.join('; ') : m;
}

function personName(u: { firstName?: string | null; lastName?: string | null; email: string }) {
  return `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email;
}

function CheckBox({ on, disabled }: { on: boolean; disabled?: boolean }) {
  return (
    <span className={cn(
      'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border',
      on ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40',
      disabled && 'opacity-40',
    )}>
      {on && <Check className="h-3 w-3" />}
    </span>
  );
}

function RotationText({ r }: { r: RotationSummary }) {
  if (r.total === 0) return <span className="text-xs text-muted-foreground">No rotations</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {r.confirmed > 0 && <Badge variant="success">{r.confirmed} confirmed</Badge>}
      {r.pending > 0 && <Badge variant="warning">{r.pending} pending{r.offlinePending ? ` (${r.offlinePending} offline)` : ''}</Badge>}
      {r.failed > 0 && <Badge variant="destructive">{r.failed} failed</Badge>}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function OffboardingPage() {
  // useSearchParams needs a Suspense boundary under the App Router.
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
      <OffboardingInner />
    </Suspense>
  );
}

function OffboardingInner() {
  const params = useSearchParams();
  const { isLoading, isPlatformAdmin, accessLevel, businessId, businessName, technician, canManageTechnicians } = usePermissions();
  const isOwner = accessLevel === 'Business Owner';
  const allowed = isPlatformAdmin || isOwner || canManageTechnicians;

  const [filter, setFilter] = useState<string>('all');

  const { data: businesses = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['businesses', ''],
    queryFn: () => businessesApi.list().then((r) => r.data?.data ?? []),
    enabled: isPlatformAdmin,
  });
  const businessNames = useMemo(() => {
    const m = new Map(businesses.map((b) => [b.id, b.name]));
    if (businessId && businessName) m.set(businessId, businessName);
    return m;
  }, [businesses, businessId, businessName]);

  const listScope = isPlatformAdmin ? (filter === 'all' ? undefined : filter) : undefined;
  const { data: cases = [], isLoading: loadingCases, error: casesError } = useQuery<CaseRow[]>({
    queryKey: ['offboarding', 'list', listScope ?? 'all'],
    queryFn: () => offboardingApi.list(listScope).then((r) => r.data?.data ?? []),
    enabled: allowed && !technician,
    refetchInterval: 30_000,
  });
  const { data: pending = [], error: pendingError } = useQuery<PendingRotation[]>({
    queryKey: ['offboarding', 'pending-rotations', listScope ?? 'all'],
    queryFn: () => offboardingApi.pendingRotations(listScope).then((r) => r.data?.data ?? []),
    enabled: allowed && !technician && (isPlatformAdmin || !!businessId),
    refetchInterval: 30_000,
    retry: false,
  });

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

  if (technician) {
    return (
      <div className="p-6">
        <PageHeader title="Offboarding" />
        <Card><CardContent className="flex items-start gap-2 p-6 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          You are working in {technician.businessName} as a technician. Switch back to your own business to offboard people.
        </CardContent></Card>
      </div>
    );
  }
  if (!allowed) {
    return (
      <div className="p-6">
        <PageHeader title="Offboarding" />
        <Card><CardContent className="p-6 text-sm text-muted-foreground">
          Only a Business Owner (or a Platform Admin) can offboard people.
        </CardContent></Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Offboarding"
        description="Remove a person's access, and deal with the computer passwords they already had."
      >
        {isPlatformAdmin && (
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All businesses</SelectItem>
              {businesses.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
      </PageHeader>

      <StartOffboarding
        initialUserId={params.get('userId') ?? ''}
        initialBusinessId={params.get('businessId') ?? ''}
        isPlatformAdmin={isPlatformAdmin}
        isOwner={isOwner}
        canManageTechnicians={canManageTechnicians}
        ownBusinessId={businessId}
        ownBusinessName={businessName}
        businesses={businesses}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Computers with an unacknowledged rotation ({pending.length})</CardTitle>
          <CardDescription>
            A new password has been staged but the computer has not confirmed it yet. Until it does, its old password still works.
            An offline computer stays here until it comes back.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {pendingError ? (
            <p className="p-4 text-sm text-muted-foreground">{errMsg(pendingError) ?? 'Could not load pending rotations.'}</p>
          ) : !isPlatformAdmin && !businessId ? (
            <p className="p-4 text-sm text-muted-foreground">Pending rotations are listed per business; your account has none of its own.</p>
          ) : pending.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">None.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Computer</th>
                  {isPlatformAdmin && <th className="px-4 py-2 font-medium">Business</th>}
                  <th className="px-4 py-2 font-medium">Connectivity</th>
                  <th className="px-4 py-2 font-medium">Staged</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {pending.map((p) => (
                  <tr key={p.endpointId}>
                    <td className="px-4 py-2"><Link className="hover:underline" href={`/endpoints/${p.endpointId}`}>{p.name}</Link></td>
                    {isPlatformAdmin && <td className="px-4 py-2 text-muted-foreground">{p.businessName ?? '—'}</td>}
                    <td className="px-4 py-2">
                      {p.online
                        ? <span className="flex items-center gap-1 text-green-700 dark:text-green-400"><Wifi className="h-3.5 w-3.5" />Online, waiting for check-in</span>
                        : <span className="flex items-center gap-1 text-muted-foreground"><WifiOff className="h-3.5 w-3.5" />Offline{p.lastSeenAt ? ` since ${formatDate(p.lastSeenAt)}` : ''}</span>}
                    </td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">{formatDate(p.stagedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Past offboarding</CardTitle></CardHeader>
        <CardContent className="p-0">
          {loadingCases ? <p className="p-4 text-sm text-muted-foreground">Loading…</p> : casesError ? (
            <p className="p-4 text-sm text-destructive">{errMsg(casesError) ?? 'Could not load offboarding history.'}</p>
          ) : cases.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No one has been offboarded yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Person</th>
                  <th className="px-4 py-2 font-medium">Scope</th>
                  <th className="px-4 py-2 font-medium">Started</th>
                  <th className="px-4 py-2 font-medium">Credential rotation</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {cases.map((c) => (
                  <tr key={c.id} className="hover:bg-muted/30">
                    <td className="px-4 py-2">{c.subjectEmail ?? '—'}</td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {c.businessId ? businessNames.get(c.businessId) ?? 'One business' : 'Every business'}
                    </td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">{formatDate(c.startedAt)}</td>
                    <td className="px-4 py-2"><RotationText r={c.rotation} /></td>
                    <td className="px-4 py-2">
                      {c.completedAt
                        ? <Badge variant="success">Complete</Badge>
                        : <Badge variant="warning"><Clock className="mr-1 h-3 w-3" />In progress</Badge>}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Button asChild variant="ghost" size="sm">
                        <Link href={`/offboarding/${c.id}`}>Open<ArrowRight className="ml-1 h-3.5 w-3.5" /></Link>
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Start ───────────────────────────────────────────────────────────────────

function StartOffboarding({
  initialUserId, initialBusinessId, isPlatformAdmin, isOwner, canManageTechnicians,
  ownBusinessId, ownBusinessName, businesses,
}: {
  initialUserId: string; initialBusinessId: string;
  isPlatformAdmin: boolean; isOwner: boolean; canManageTechnicians: boolean;
  ownBusinessId: string | null; ownBusinessName: string | null;
  businesses: { id: string; name: string }[];
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = usePermissions();

  // Business scope needs a Business Owner (own business) or Platform Admin (any).
  // Every-business scope needs a Platform Admin, or technicians:manage for an
  // account with no business membership.
  const canBusiness = isPlatformAdmin || (isOwner && !!ownBusinessId);
  const canPlatform = isPlatformAdmin || canManageTechnicians;

  const [scope, setScope] = useState<'business' | 'platform'>(canBusiness ? 'business' : 'platform');
  const [pickedBusiness, setPickedBusiness] = useState(isPlatformAdmin ? initialBusinessId : '');
  const [userId, setUserId] = useState(initialUserId);
  const [rotate, setRotate] = useState<string[] | null>(null); // null = not yet seeded from the preview
  const [suspend, setSuspend] = useState(false);
  const [notes, setNotes] = useState('');
  const [confirming, setConfirming] = useState(false);

  const businessId = scope === 'business' ? (isPlatformAdmin ? pickedBusiness : ownBusinessId ?? '') : '';

  const { data: members = [] } = useQuery<Membership[]>({
    queryKey: ['users', businessId || 'all'],
    queryFn: () => usersApi.list(businessId || undefined).then((r) => r.data?.data ?? []),
    enabled: scope === 'business' ? !!businessId : isPlatformAdmin,
  });
  const { data: techPeople = [] } = useQuery<Person[]>({
    queryKey: ['technicians', 'people'],
    queryFn: () => techniciansApi.people().then((r) => r.data?.data ?? []),
    enabled: scope === 'platform' && canManageTechnicians,
    retry: false,
  });

  const candidates = useMemo(() => {
    const m = new Map<string, string>();
    if (scope === 'business' || isPlatformAdmin) {
      for (const x of members) {
        if (x.user.isPlatformAdmin && !isPlatformAdmin) continue;
        m.set(x.user.id, `${personName(x.user)} · ${x.user.email}${scope === 'platform' && x.business ? ` (${x.business.name})` : ''}`);
      }
    }
    if (scope === 'platform') {
      for (const p of techPeople) {
        // A technicians:manage holder may offboard only accounts with no business of their own.
        if (!isPlatformAdmin && p.ownBusiness) continue;
        if (!m.has(p.id)) m.set(p.id, `${personName(p)} · ${p.email}${p.ownBusiness ? '' : ' (technician account)'}`);
      }
    }
    if (user) m.delete(user.id);
    return [...m.entries()].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [members, techPeople, scope, isPlatformAdmin, user]);

  const ready = !!userId && (scope === 'platform' || !!businessId);
  const { data: preview, isLoading: loadingPreview, error: previewError } = useQuery<Preview>({
    queryKey: ['offboarding', 'preview', userId, businessId || null],
    queryFn: () => offboardingApi.preview(userId, businessId || undefined).then((r) => r.data?.data),
    enabled: ready,
    retry: false,
  });

  // Seed the rotation choice once per preview: every computer that can rotate.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const previewKey = preview ? `${preview.subject.id}:${preview.businessId ?? ''}` : null;
  if (previewKey !== seededFor) {
    setSeededFor(previewKey);
    setRotate(preview ? preview.credentialsObtained.filter((c) => c.canRotate).map((c) => c.endpointId) : null);
    setSuspend(false);
  }
  const rotateIds = rotate ?? [];

  const execute = useMutation({
    mutationFn: () => offboardingApi.execute({
      userId,
      ...(businessId ? { businessId } : {}),
      suspendAccount: suspend,
      rotateEndpointIds: rotateIds,
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    }),
    onSuccess: (res) => {
      const id = res.data?.data?.id;
      toast({ title: 'Offboarding started', description: 'Access is removed. Rotations stay pending until each computer confirms.' });
      qc.invalidateQueries({ queryKey: ['offboarding'] });
      qc.invalidateQueries({ queryKey: ['users'] });
      qc.invalidateQueries({ queryKey: ['technicians'] });
      setConfirming(false);
      if (id) router.push(`/offboarding/${id}`);
    },
    onError: (e) => toast({ title: 'Offboarding failed', description: errMsg(e), variant: 'destructive' }),
  });

  const notRotated = preview ? preview.credentialsObtained.filter((c) => !rotateIds.includes(c.endpointId)).length : 0;
  const knownUser = candidates.some((c) => c.id === userId);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><UserMinus className="h-4 w-4" />Offboard someone</CardTitle>
        <CardDescription>Choose who, see exactly what will happen, then confirm.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 text-sm">
        {canBusiness && canPlatform && (
          <div className="space-y-1.5">
            <Label>Scope</Label>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant={scope === 'business' ? 'default' : 'outline'} onClick={() => { setScope('business'); setUserId(''); }}>
                One business
              </Button>
              <Button size="sm" variant={scope === 'platform' ? 'default' : 'outline'} onClick={() => { setScope('platform'); setUserId(''); }}>
                Every business (whole account)
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {scope === 'business'
                ? 'Removes their access to one business only: membership, computer grants, technician assignments into it, unused tokens for its computers, and rotation of its computers.'
                : isPlatformAdmin
                  ? 'Removes every membership, assignment and group membership, and all unused tokens.'
                  : 'For MSP technician accounts (no business of their own): every assignment and group membership, the account, all unused tokens.'}
            </p>
          </div>
        )}
        {!canBusiness && canPlatform && (
          <p className="text-xs text-muted-foreground">
            With &ldquo;Manage technician access&rdquo; you can offboard MSP technician accounts (people with no business of their own) across every business.
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          {scope === 'business' && (
            <div className="space-y-1.5">
              <Label>Business</Label>
              {isPlatformAdmin ? (
                <Select value={pickedBusiness} onValueChange={(v) => { setPickedBusiness(v); setUserId(''); }}>
                  <SelectTrigger><SelectValue placeholder="Choose a business" /></SelectTrigger>
                  <SelectContent>{businesses.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent>
                </Select>
              ) : (
                <div className="rounded-md border bg-muted/30 px-3 py-2">{ownBusinessName ?? 'Your business'}</div>
              )}
            </div>
          )}
          <div className="space-y-1.5">
            <Label>Person</Label>
            <Select value={userId} onValueChange={setUserId}>
              <SelectTrigger><SelectValue placeholder={scope === 'business' && !businessId ? 'Choose a business first' : 'Choose a person'} /></SelectTrigger>
              <SelectContent>
                {!knownUser && userId && <SelectItem value={userId}>{preview?.subject.email ?? 'Selected person'}</SelectItem>}
                {candidates.map((c) => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}
              </SelectContent>
            </Select>
            {scope === 'business' && (
              <p className="text-xs text-muted-foreground">
                Lists this business&apos;s members. A technician with access here but no membership can be opened from a link with their user ID.
              </p>
            )}
          </div>
        </div>

        {ready && (loadingPreview ? (
          <p className="text-muted-foreground"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />Working out what this person has…</p>
        ) : previewError ? (
          <p className="text-destructive">{errMsg(previewError) ?? 'Could not prepare the offboarding.'}</p>
        ) : preview && (
          <PreviewBody
            preview={preview}
            rotate={rotateIds} setRotate={setRotate}
            suspend={suspend} setSuspend={setSuspend}
            notes={notes} setNotes={setNotes}
            notRotated={notRotated}
            onExecute={() => setConfirming(true)}
          />
        ))}
      </CardContent>

      <Dialog open={confirming} onOpenChange={(o) => !execute.isPending && setConfirming(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Offboard {preview?.subject.name}?</DialogTitle>
            <DialogDescription>
              {preview?.scope === 'business' ? 'Their access to this business is removed now.' : 'Their access to every business is removed now.'}
            </DialogDescription>
          </DialogHeader>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li>{suspend ? 'Their account is suspended and every signed-in session ends.' : 'Their account stays active.'}</li>
            <li>
              {rotateIds.length
                ? `${rotateIds.length} computer credential(s) will be rotated. Each stays pending, and the old password keeps working there, until the computer confirms.`
                : 'No credentials will be rotated.'}
            </li>
            {notRotated > 0 && <li className="text-amber-700 dark:text-amber-400">{notRotated} computer(s) they had a password for will NOT be rotated. That password keeps working.</li>}
            <li>Sessions already open are not ended.</li>
          </ul>
          <p className="text-xs text-muted-foreground">You may be asked to confirm your identity first.</p>
          <DialogFooter>
            <Button variant="outline" disabled={execute.isPending} onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant="destructive" disabled={execute.isPending} onClick={() => execute.mutate()}>
              {execute.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Offboard now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function PreviewBody({
  preview, rotate, setRotate, suspend, setSuspend, notes, setNotes, notRotated, onExecute,
}: {
  preview: Preview;
  rotate: string[]; setRotate: (v: string[]) => void;
  suspend: boolean; setSuspend: (v: boolean) => void;
  notes: string; setNotes: (v: string) => void;
  notRotated: number;
  onExecute: () => void;
}) {
  const w = preview.willRevoke;
  const rows: { label: string; value: string }[] = [
    { label: preview.scope === 'business' ? 'Membership of this business' : 'Business memberships', value: w.membership ? 'Disabled' : 'None active' },
    { label: 'Per-computer access grants', value: String(w.computerGrants) },
    { label: 'Technician assignments (direct)', value: String(w.technicianAssignments) },
    ...(preview.scope === 'platform' ? [{ label: 'Technician group memberships', value: String(w.groupMemberships) }] : []),
    {
      label: preview.scope === 'business' ? 'Unused launcher tokens (only those for this business are revoked)' : 'Unused launcher tokens',
      value: preview.scope === 'business' ? `up to ${w.unredeemedLauncherTokens}` : String(w.unredeemedLauncherTokens),
    },
    { label: 'Unused connection grants', value: String(w.unredeemedConnectionGrants) },
  ];
  const rotatable = preview.credentialsObtained.filter((c) => c.canRotate).map((c) => c.endpointId);

  return (
    <div className="space-y-5 border-t pt-4">
      <div>
        <div className="font-medium">{preview.subject.name}</div>
        <div className="text-xs text-muted-foreground">{preview.subject.email} · account {preview.subject.status.toLowerCase()}</div>
      </div>

      <section className="space-y-2">
        <h3 className="font-semibold">Access that will be removed</h3>
        <div className="divide-y rounded-md border">
          {rows.map((r) => (
            <div key={r.label} className="flex justify-between gap-3 px-3 py-1.5">
              <span className="text-muted-foreground">{r.label}</span><span className="font-medium">{r.value}</span>
            </div>
          ))}
        </div>
        {preview.scope === 'business' && (
          <p className="text-xs text-muted-foreground">
            If they reach this business through a technician group, that access stays until they are removed from the group or the group&apos;s assignment is revoked. The result will say so.
          </p>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="flex items-center gap-2 font-semibold"><KeyRound className="h-4 w-4" />Computer passwords they obtained ({preview.credentialsObtained.length})</h3>
        <p className="text-xs text-muted-foreground">
          Removing access does not change these passwords. Tick a computer to rotate its credential. Only computers with a Rem0te agent bound to them can be rotated from here.
        </p>
        {preview.credentialsObtained.length === 0 ? (
          <p className="text-muted-foreground">No record of this person revealing or being given a computer password{preview.scope === 'business' ? ' in this business' : ''}.</p>
        ) : (
          <>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setRotate(rotatable)}>Select all that can rotate</Button>
              <Button size="sm" variant="ghost" onClick={() => setRotate([])}>Select none</Button>
            </div>
            <div className="divide-y rounded-md border">
              {preview.credentialsObtained.map((c) => {
                const on = rotate.includes(c.endpointId);
                return (
                  <button
                    key={c.endpointId} type="button" disabled={!c.canRotate}
                    onClick={() => setRotate(on ? rotate.filter((x) => x !== c.endpointId) : [...rotate, c.endpointId])}
                    className={cn('flex w-full items-start gap-3 px-3 py-2 text-left', c.canRotate ? 'hover:bg-muted/40' : 'cursor-not-allowed')}
                  >
                    <CheckBox on={on} disabled={!c.canRotate} />
                    <span className="min-w-0 flex-1 space-y-0.5">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{c.name}</span>
                        {preview.scope === 'platform' && c.businessName && <span className="text-xs text-muted-foreground">{c.businessName}</span>}
                        {c.online && connectivityOf(c.online, c.lastSeenAt) === 'agent_silent'
                          ? <Badge variant="warning" className="font-normal" title={connectivityHint('agent_silent')}><Wifi className="mr-1 h-3 w-3" />{connectivityLabel('agent_silent', c.lastSeenAt)}</Badge>
                          : c.online
                          ? <Badge variant="success" className="font-normal"><Wifi className="mr-1 h-3 w-3" />Online</Badge>
                          : <Badge variant="secondary" className="font-normal"><WifiOff className="mr-1 h-3 w-3" />Offline{c.lastSeenAt ? ` · seen ${formatDate(c.lastSeenAt)}` : ''}</Badge>}
                        {c.rotationAlreadyPending && <Badge variant="warning" className="font-normal">A rotation is already pending</Badge>}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {c.how.join(', ')} · last {formatDate(c.lastObtainedAt)}
                      </span>
                      {!c.canRotate && (
                        <span className="block text-xs text-amber-700 dark:text-amber-400">
                          Cannot rotate from here: no agent is bound to this computer. Change its RustDesk password on the computer itself.
                        </span>
                      )}
                      {c.canRotate && !c.online && on && (
                        <span className="block text-xs text-muted-foreground">Offline: the rotation stays pending, and the old password keeps working, until it comes back.</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
            {notRotated > 0 && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                {notRotated} computer(s) will keep the password this person saw.
              </p>
            )}
          </>
        )}
      </section>

      {preview.sharedPasswords.length > 0 && (
        <section className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <h3 className="flex items-center gap-2 font-semibold"><AlertTriangle className="h-4 w-4" />Shared passwords</h3>
          <p className="text-xs">
            These computers use the same password. Rotating one changes only that one; the others keep the password this person may know.
            Rotate each of them (from its computer page if it is not listed above).
          </p>
          {preview.sharedPasswords.map((g, i) => (
            <div key={i} className="flex flex-wrap gap-1">
              {g.computers.map((c) => (
                <Link key={c.endpointId} href={`/endpoints/${c.endpointId}`}>
                  <Badge variant="outline" className="border-amber-400 font-normal dark:border-amber-700">{c.name}</Badge>
                </Link>
              ))}
            </div>
          ))}
        </section>
      )}

      <section className="space-y-2">
        <h3 className="font-semibold">Account</h3>
        <button
          type="button" disabled={!preview.canSuspendAccount}
          onClick={() => setSuspend(!suspend)}
          className={cn('flex items-start gap-3 rounded-md border p-2.5 text-left', preview.canSuspendAccount ? 'hover:bg-muted/40' : 'cursor-not-allowed')}
        >
          <CheckBox on={suspend} disabled={!preview.canSuspendAccount} />
          <span>
            <span className="block font-medium">Suspend the account and end every signed-in session</span>
            <span className="block text-xs text-muted-foreground">
              {preview.canSuspendAccount
                ? 'They cannot sign in to Rem0te at all. This does not end a RustDesk session already open.'
                : preview.suspendBlockedReason}
            </span>
          </span>
        </button>
      </section>

      <section className="space-y-1.5">
        <Label htmlFor="ob-notes">Notes (kept with the record)</Label>
        <Textarea id="ob-notes" rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </section>

      <section className="space-y-1.5 rounded-md border bg-muted/40 p-3">
        <h3 className="flex items-center gap-2 font-semibold"><Info className="h-4 w-4" />What this does not do</h3>
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          {preview.limits.map((l) => <li key={l}>{l}</li>)}
        </ul>
      </section>

      <div className="flex justify-end">
        <Button variant="destructive" onClick={onExecute}><UserMinus className="mr-2 h-4 w-4" />Offboard…</Button>
      </div>
    </div>
  );
}
