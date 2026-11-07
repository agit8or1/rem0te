'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { businessesApi, endpointsApi, rolloutsApi, updateApi } from '@/lib/api-client';
import { usePermissions } from '@/lib/auth';
import { errorMessage } from '@/lib/webauthn';
import { formatDate } from '@/lib/utils';
import { PageHeader } from '@/components/common/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { RolloutStatusBadge, type RolloutStatus } from '@/components/rollouts/endpoint-update-history';
import { AlertTriangle, Pin, Plus, Search, Trash2, Users, X } from 'lucide-react';

// ─── Shapes ──────────────────────────────────────────────────────────────────

interface RolloutRow {
  id: string; name: string; component: 'RUSTDESK' | 'AGENT'; targetVersion: string; status: RolloutStatus;
  currentBatch: number; batchSize: number; pausedReason: string | null;
  createdAt: string; startedAt: string | null; completedAt: string | null;
  pilotGroup: { id: string; name: string } | null; _count: { jobs: number };
}
interface PilotGroup {
  id: string; name: string; description: string | null; createdAt: string;
  members: { id: string; endpointId: string }[];
}
interface EndpointLite {
  id: string; name: string; hostname?: string | null; platform?: string | null;
  customer?: { id: string; name: string } | null;
}
interface Business { id: string; name: string }

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const selectClass = 'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm';
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ─── Computer picker ─────────────────────────────────────────────────────────

/**
 * Search-then-tick picker over endpointsApi.list (200 per search, the API's
 * cap). Selected computers stay listed above the results so a later search
 * does not hide what is already chosen.
 */
function ComputerPicker({
  selected, onChange, known, onKnown,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
  known: Record<string, EndpointLite>;
  onKnown: (e: EndpointLite[]) => void;
}) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading } = useQuery<{ endpoints: EndpointLite[]; total: number }>({
    queryKey: ['rollout-picker', query],
    queryFn: () => endpointsApi.list({ limit: '200', ...(query ? { search: query } : {}) }).then((r) => r.data?.data),
  });
  const results = useMemo(() => data?.endpoints ?? [], [data]);
  useEffect(() => { if (results.length) onKnown(results); }, [results, onKnown]);

  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const label = (e?: EndpointLite) => (e ? `${e.name}${e.customer ? ` · ${e.customer.name}` : ''}` : 'Computer');

  return (
    <div className="space-y-2">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selected.map((id) => (
            <span key={id} className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-xs">
              {label(known[id])}
              <button type="button" aria-label="Remove" onClick={() => toggle(id)} className="opacity-60 hover:opacity-100">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <Search className="absolute left-2.5 top-3 h-4 w-4 text-muted-foreground" />
        <Input className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search computers by name, hostname, ID…" />
      </div>
      <div className="max-h-48 overflow-y-auto rounded-md border divide-y">
        {isLoading ? (
          <p className="p-2 text-xs text-muted-foreground">Loading…</p>
        ) : results.length === 0 ? (
          <p className="p-2 text-xs text-muted-foreground">No computers match.</p>
        ) : (
          results.map((e) => (
            <label key={e.id} className="flex items-center gap-2 px-2 py-1.5 text-sm cursor-pointer hover:bg-muted/50">
              <input type="checkbox" checked={selected.includes(e.id)} onChange={() => toggle(e.id)} />
              <span className="truncate">{e.name}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {[e.customer?.name, e.platform].filter(Boolean).join(' · ')}
              </span>
            </label>
          ))
        )}
      </div>
      {data && data.total > results.length && (
        <p className="text-xs text-muted-foreground">Showing {results.length} of {data.total}. Narrow the search to find others.</p>
      )}
    </div>
  );
}

function useKnownEndpoints() {
  const [known, setKnown] = useState<Record<string, EndpointLite>>({});
  const onKnown = useMemo(() => (list: EndpointLite[]) => {
    setKnown((k) => {
      let changed = false;
      const next = { ...k };
      for (const e of list) if (!next[e.id]) { next[e.id] = e; changed = true; }
      return changed ? next : k;
    });
  }, []);
  return { known, onKnown };
}

// ─── Version pin ─────────────────────────────────────────────────────────────

function PinCard() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<{ pinnedVersion: string | null; latestVersion: string | null }>({
    queryKey: ['rollout-pin'],
    queryFn: () => rolloutsApi.pin().then((r) => r.data?.data),
  });
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  const save = useMutation({
    mutationFn: (v: string | null) => rolloutsApi.setPin(v),
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey: ['rollout-pin'] });
      setValue(''); setError('');
      toast({ title: v ? `Pinned to ${v}` : 'Pin cleared', description: v ? undefined : 'New installs use the latest release.' });
    },
    onError: (e: unknown) => setError(errorMessage(e, 'Could not save the pin')),
  });

  const trimmed = value.trim();
  const validVersion = VERSION_RE.test(trimmed);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base"><Pin className="h-4 w-4" /> Supported RustDesk version</CardTitle>
        <CardDescription>
          The RustDesk client version that every installer, Connect script and Quick Connect download installs.
          It does not change computers that are already installed — use a rollout for that.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <p className="text-sm">
            {data?.pinnedVersion
              ? <>Pinned to <span className="font-mono font-medium">{data.pinnedVersion}</span>.</>
              : <>Not pinned — new installs use the latest release.</>}
            {' '}
            <span className="text-muted-foreground">
              Latest release: {data?.latestVersion ? <span className="font-mono">{data.latestVersion}</span> : 'unknown (GitHub not reachable)'}
            </span>
          </p>
        )}
        <div className="flex flex-wrap items-start gap-2">
          <div className="space-y-1">
            <Input className="w-40 font-mono" value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. 1.4.4" />
            {trimmed && !validVersion && <p className="text-xs text-destructive">Exact version only, like 1.4.4.</p>}
          </div>
          <Button onClick={() => save.mutate(trimmed)} disabled={!validVersion || save.isPending}>Pin version</Button>
          {data?.pinnedVersion && (
            <Button variant="outline" onClick={() => save.mutate(null)} disabled={save.isPending}>Clear pin</Button>
          )}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

// ─── Pilot groups ────────────────────────────────────────────────────────────

function PilotGroupDialog({
  open, onOpenChange, group,
}: { open: boolean; onOpenChange: (o: boolean) => void; group: PilotGroup | null }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { known, onKnown } = useKnownEndpoints();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [ids, setIds] = useState<string[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setName(group?.name ?? '');
    setDescription(group?.description ?? '');
    setIds(group?.members.map((m) => m.endpointId) ?? []);
    setError('');
  }, [open, group]);

  const save = useMutation({
    mutationFn: () => rolloutsApi.savePilotGroup({
      ...(group ? { id: group.id } : {}), name: name.trim(), description: description.trim() || undefined, endpointIds: ids,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pilot-groups'] });
      toast({ title: group ? 'Pilot group saved' : 'Pilot group created' });
      onOpenChange(false);
    },
    onError: (e: unknown) => setError(errorMessage(e, 'Could not save the pilot group')),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{group ? `Edit ${group.name}` : 'New pilot group'}</DialogTitle>
          <DialogDescription>
            Computers in a rollout&apos;s pilot group go first, as batch 0. The rest of the rollout waits until every pilot
            job has finished and the failure threshold has not been reached.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Name</Label>
            <Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Description (optional)</Label>
            <Textarea value={description} maxLength={500} rows={2} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Computers ({ids.length})</Label>
            <ComputerPicker selected={ids} onChange={setIds} known={known} onKnown={onKnown} />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={!name.trim() || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PilotGroupsCard({ groups, isLoading }: { groups: PilotGroup[]; isLoading: boolean }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<PilotGroup | null>(null);
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base"><Users className="h-4 w-4" /> Pilot groups</CardTitle>
            <CardDescription>Computers that take an update first, before the rest of the fleet.</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => { setEditing(null); setOpen(true); }}>
            <Plus className="h-4 w-4 mr-1" /> New group
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">No pilot groups yet.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {groups.map((g) => (
              <li key={g.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{g.name}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {g.members.length} computer{g.members.length === 1 ? '' : 's'}{g.description ? ` · ${g.description}` : ''}
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => { setEditing(g); setOpen(true); }}>Edit</Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <PilotGroupDialog open={open} onOpenChange={setOpen} group={editing} />
    </Card>
  );
}

// ─── Create rollout ──────────────────────────────────────────────────────────

interface WindowRow { days: number[]; start: string; end: string }

function localTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

function CreateRolloutDialog({
  open, onOpenChange, pilotGroups,
}: { open: boolean; onOpenChange: (o: boolean) => void; pilotGroups: PilotGroup[] }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const router = useRouter();
  const { known, onKnown } = useKnownEndpoints();

  const { data: pin } = useQuery<{ pinnedVersion: string | null; latestVersion: string | null }>({
    queryKey: ['rollout-pin'],
    queryFn: () => rolloutsApi.pin().then((r) => r.data?.data),
    enabled: open,
  });
  const { data: appVersion } = useQuery<{ version: string }>({
    queryKey: ['app-version'],
    queryFn: () => updateApi.appVersion().then((r) => r.data?.data),
    enabled: open,
  });
  const { data: businessesData } = useQuery({
    queryKey: ['businesses', ''],
    queryFn: () => businessesApi.list().then((r) => r.data?.data ?? []),
    enabled: open,
  });
  const businesses: Business[] = Array.isArray(businessesData) ? businessesData : [];

  const [name, setName] = useState('');
  const [component, setComponent] = useState<'RUSTDESK' | 'AGENT'>('RUSTDESK');
  const [targetVersion, setTargetVersion] = useState('');
  const [endpointIds, setEndpointIds] = useState<string[]>([]);
  const [businessIds, setBusinessIds] = useState<string[]>([]);
  const [pilotGroupId, setPilotGroupId] = useState('');
  const [batchSize, setBatchSize] = useState('10');
  const [failureThreshold, setFailureThreshold] = useState('1');
  const [maxAttempts, setMaxAttempts] = useState('3');
  const [backoffMinutes, setBackoffMinutes] = useState('30');
  const [verifyTimeoutMinutes, setVerifyTimeoutMinutes] = useState('60');
  const [useWindow, setUseWindow] = useState(false);
  const [timeZone, setTimeZone] = useState(localTimeZone);
  const [windows, setWindows] = useState<WindowRow[]>([{ days: [1, 2, 3, 4, 5], start: '22:00', end: '05:00' }]);
  const [deferOnUnknownSession, setDeferOnUnknownSession] = useState(true);
  const [allowSignatureOnly, setAllowSignatureOnly] = useState(false);
  const [error, setError] = useState('');

  // Reset every time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setName(''); setComponent('RUSTDESK'); setTargetVersion(''); setEndpointIds([]); setBusinessIds([]);
    setPilotGroupId(''); setBatchSize('10'); setFailureThreshold('1'); setMaxAttempts('3');
    setBackoffMinutes('30'); setVerifyTimeoutMinutes('60'); setUseWindow(false); setTimeZone(localTimeZone());
    setWindows([{ days: [1, 2, 3, 4, 5], start: '22:00', end: '05:00' }]);
    setDeferOnUnknownSession(true); setAllowSignatureOnly(false); setError('');
  }, [open]);

  // Pre-fill the target: the pinned (or latest) RustDesk release, or this
  // server's own version for the agent — the only agent version it can serve.
  const rustdeskDefault = pin?.pinnedVersion ?? pin?.latestVersion ?? '';
  useEffect(() => {
    if (!open) return;
    if (component === 'AGENT') setTargetVersion(appVersion?.version ?? '');
    else setTargetVersion((v) => (v && v !== appVersion?.version ? v : rustdeskDefault));
  }, [open, component, appVersion?.version, rustdeskDefault]);

  const int = (s: string) => Number.parseInt(s, 10);
  const numbersValid =
    int(batchSize) >= 1 && int(batchSize) <= 500 &&
    int(failureThreshold) >= 0 && int(failureThreshold) <= 1000 &&
    int(maxAttempts) >= 1 && int(maxAttempts) <= 10 &&
    int(backoffMinutes) >= 5 && int(backoffMinutes) <= 1440 &&
    int(verifyTimeoutMinutes) >= 15 && int(verifyTimeoutMinutes) <= 1440;
  const versionValid = VERSION_RE.test(targetVersion.trim());
  const windowsValid = !useWindow || (timeZone.trim() && windows.length > 0 && windows.every((w) => w.days.length > 0 && w.start && w.end && w.start !== w.end));
  const valid = name.trim() && versionValid && numbersValid && windowsValid;
  const noTargets = endpointIds.length === 0 && businessIds.length === 0;

  const create = useMutation({
    mutationFn: () => rolloutsApi.create({
      name: name.trim(),
      component,
      targetVersion: targetVersion.trim(),
      ...(endpointIds.length ? { endpointIds } : {}),
      ...(businessIds.length ? { businessIds } : {}),
      pilotGroupId: pilotGroupId || null,
      batchSize: int(batchSize),
      failureThreshold: int(failureThreshold),
      maxAttempts: int(maxAttempts),
      backoffMinutes: int(backoffMinutes),
      verifyTimeoutMinutes: int(verifyTimeoutMinutes),
      maintenanceWindow: useWindow ? { timeZone: timeZone.trim(), windows } : null,
      deferOnUnknownSession,
      ...(component === 'RUSTDESK' ? { allowSignatureOnly } : {}),
    }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['rollouts'] });
      const id = res.data?.data?.id;
      toast({ title: 'Rollout created', description: 'It is a draft. Review the jobs, then start it.' });
      onOpenChange(false);
      if (id) router.push(`/admin/rollouts/${id}`);
    },
    onError: (e: unknown) => setError(errorMessage(e, 'Could not create the rollout')),
  });

  const setWin = (i: number, w: Partial<WindowRow>) => setWindows((ws) => ws.map((x, j) => (j === i ? { ...x, ...w } : x)));
  const toggleDay = (i: number, d: number) =>
    setWin(i, { days: windows[i].days.includes(d) ? windows[i].days.filter((x) => x !== d) : [...windows[i].days, d].sort() });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New staged update</DialogTitle>
          <DialogDescription>
            Creates a draft with one job per targeted computer. Nothing is sent to any computer until you start it.
            Staged updates are Windows-only; other computers are skipped. Rollback is not offered.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1 sm:col-span-3">
              <Label>Name</Label>
              <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="e.g. RustDesk 1.4.4 — November" />
            </div>
            <div className="space-y-1">
              <Label>Component</Label>
              <select className={selectClass} value={component} onChange={(e) => setComponent(e.target.value as 'RUSTDESK' | 'AGENT')}>
                <option value="RUSTDESK">RustDesk client</option>
                <option value="AGENT">Rem0te agent</option>
              </select>
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label>Target version</Label>
              <Input className="font-mono" value={targetVersion} readOnly={component === 'AGENT'}
                onChange={(e) => setTargetVersion(e.target.value)} placeholder="e.g. 1.4.4" />
              <p className="text-xs text-muted-foreground">
                {component === 'AGENT'
                  ? `The agent can only be updated to this server's own version${appVersion?.version ? ` (${appVersion.version})` : ''}.`
                  : 'Exact version, like 1.4.4. Computers already on a newer version are skipped — downgrades are not supported.'}
              </p>
              {targetVersion.trim() && !versionValid && <p className="text-xs text-destructive">Exact version only, like 1.4.4.</p>}
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Targets</p>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Businesses ({businessIds.length})</Label>
              <div className="max-h-32 overflow-y-auto rounded-md border p-2 grid grid-cols-1 sm:grid-cols-2 gap-1">
                {businesses.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No businesses.</p>
                ) : businesses.map((b) => (
                  <label key={b.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input type="checkbox" checked={businessIds.includes(b.id)}
                      onChange={() => setBusinessIds((ids) => (ids.includes(b.id) ? ids.filter((x) => x !== b.id) : [...ids, b.id]))} />
                    <span className="truncate">{b.name}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Specific computers ({endpointIds.length})</Label>
              <ComputerPicker selected={endpointIds} onChange={setEndpointIds} known={known} onKnown={onKnown} />
            </div>
            <p className="text-xs text-muted-foreground">
              {noTargets
                ? <span className="text-yellow-700 dark:text-yellow-400 font-medium">Nothing selected: the rollout will include every managed computer that is not archived.</span>
                : endpointIds.length && businessIds.length
                  ? 'Both are set, so only the selected computers that also belong to a selected business are included.'
                  : endpointIds.length
                    ? 'Only the selected computers are included.'
                    : 'Every managed computer in the selected businesses is included.'}
              {' '}Computers that are not Windows, have not authenticated with a device secret, are already on the target,
              or are in another active rollout for this component are listed as skipped.
            </p>
          </div>

          <div className="space-y-1">
            <Label>Pilot group</Label>
            <select className={selectClass} value={pilotGroupId} onChange={(e) => setPilotGroupId(e.target.value)}>
              <option value="">None — start with batch 1</option>
              {pilotGroups.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.members.length})</option>)}
            </select>
            <p className="text-xs text-muted-foreground">
              Targeted computers that are in the pilot group go first, as batch 0. Pilot members outside the targets are not added.
            </p>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Batch size</Label>
              <Input type="number" min={1} max={500} value={batchSize} onChange={(e) => setBatchSize(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Failure threshold</Label>
              <Input type="number" min={0} max={1000} value={failureThreshold} onChange={(e) => setFailureThreshold(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Max attempts</Label>
              <Input type="number" min={1} max={10} value={maxAttempts} onChange={(e) => setMaxAttempts(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Backoff (min)</Label>
              <Input type="number" min={5} max={1440} value={backoffMinutes} onChange={(e) => setBackoffMinutes(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Verify timeout (min)</Label>
              <Input type="number" min={15} max={1440} value={verifyTimeoutMinutes} onChange={(e) => setVerifyTimeoutMinutes(e.target.value)} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground -mt-2">
            The rollout pauses itself once this many jobs have failed (0 = never). A failed attempt is retried after the
            backoff, doubling each time, until max attempts. A job with no verdict within the verify timeout counts as a failed attempt.
            {!numbersValid && <span className="block text-destructive">Batch 1–500, threshold 0–1000, attempts 1–10, backoff 5–1440, timeout 15–1440.</span>}
          </p>

          <div className="space-y-2 rounded-md border p-3">
            <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
              <input type="checkbox" checked={useWindow} onChange={(e) => setUseWindow(e.target.checked)} />
              Only install inside a maintenance window
            </label>
            {useWindow && (
              <div className="space-y-2">
                <div className="space-y-1">
                  <Label className="text-xs">Time zone (IANA)</Label>
                  <Input className="max-w-xs" value={timeZone} onChange={(e) => setTimeZone(e.target.value)} placeholder="America/New_York" />
                </div>
                {windows.map((w, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2 rounded border bg-muted/30 p-2">
                    <div className="flex flex-wrap gap-1">
                      {DAYS.map((d, di) => (
                        <label key={d} className="flex items-center gap-1 text-xs cursor-pointer">
                          <input type="checkbox" checked={w.days.includes(di)} onChange={() => toggleDay(i, di)} /> {d}
                        </label>
                      ))}
                    </div>
                    <Input type="time" className="w-28" value={w.start} onChange={(e) => setWin(i, { start: e.target.value })} />
                    <span className="text-xs text-muted-foreground">to</span>
                    <Input type="time" className="w-28" value={w.end} onChange={(e) => setWin(i, { end: e.target.value })} />
                    {windows.length > 1 && (
                      <Button variant="ghost" size="sm" aria-label="Remove window" onClick={() => setWindows((ws) => ws.filter((_, j) => j !== i))}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    )}
                  </div>
                ))}
                {windows.length < 14 && (
                  <Button variant="outline" size="sm" onClick={() => setWindows((ws) => [...ws, { days: [6, 0], start: '00:00', end: '06:00' }])}>
                    <Plus className="h-4 w-4 mr-1" /> Add window
                  </Button>
                )}
                <p className="text-xs text-muted-foreground">
                  Local wall-clock times in that zone. A window whose end is before its start crosses midnight and belongs to the day it starts.
                </p>
              </div>
            )}
          </div>

          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <input type="checkbox" className="mt-1" checked={deferOnUnknownSession} onChange={(e) => setDeferOnUnknownSession(e.target.checked)} />
            <span>
              <span className="font-medium">Defer when session state is unknown</span>
              <span className="block text-xs text-muted-foreground">
                A computer with a confirmed active session is always deferred. With this on, it is also deferred while a remote
                session launched in the last two hours has not been confirmed or closed.
              </span>
            </span>
          </label>

          {component === 'RUSTDESK' && (
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input type="checkbox" className="mt-1" checked={allowSignatureOnly} onChange={(e) => setAllowSignatureOnly(e.target.checked)} />
              <span>
                <span className="font-medium">Allow signature-only verification</span>
                <span className="block text-xs text-muted-foreground">
                  Normally the exact installer is pinned by the SHA-256 that GitHub publishes for the release, and creating the
                  rollout fails if GitHub returns none. With this on, the rollout is created without a pinned digest: each computer
                  downloads that version from the RustDesk GitHub release and installs it only if Windows reports a valid
                  Authenticode signature. Any signature Windows trusts passes — the signer is logged, not checked — so this
                  is weaker than the digest. Leave it off unless the digest is genuinely unavailable.
                </span>
              </span>
            </label>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" /> <span>{error}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>Cancel</Button>
          <Button onClick={() => create.mutate()} disabled={!valid || create.isPending}>
            {create.isPending ? 'Creating…' : 'Create draft'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function RolloutsPage() {
  const router = useRouter();
  const { isPlatformAdmin, isLoading: authLoading } = usePermissions();
  const allowed = authLoading || isPlatformAdmin;
  const [creating, setCreating] = useState(false);

  const { data: rollouts = [], isLoading } = useQuery<RolloutRow[]>({
    queryKey: ['rollouts'],
    queryFn: () => rolloutsApi.list().then((r) => r.data?.data ?? []),
    enabled: isPlatformAdmin,
    refetchInterval: (q) => ((q.state.data ?? []).some((r) => r.status === 'RUNNING') ? 15_000 : false),
  });
  const { data: pilotGroups = [], isLoading: groupsLoading } = useQuery<PilotGroup[]>({
    queryKey: ['pilot-groups'],
    queryFn: () => rolloutsApi.pilotGroups().then((r) => r.data?.data ?? []),
    enabled: isPlatformAdmin,
  });

  useEffect(() => {
    if (!authLoading && !isPlatformAdmin) router.push('/dashboard');
  }, [authLoading, isPlatformAdmin, router]);

  if (!allowed) return null;

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <PageHeader
        title="Staged updates"
        description="Roll RustDesk client and Rem0te agent updates out to managed computers in batches. Platform Admins only."
        actions={<Button onClick={() => setCreating(true)}><Plus className="h-4 w-4 mr-1" /> New rollout</Button>}
      />

      <div className="flex items-start gap-2 rounded-md border border-yellow-300 bg-yellow-50 px-3 py-2 text-sm text-yellow-900 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-200">
        <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
        <span>
          Staged updates are Windows-only. Rollback is not offered — RustDesk&apos;s installer has no tested downgrade.
          If an update goes wrong, follow the recovery steps in <Link href="/docs/updates" className="underline">Updates</Link>.
        </span>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Rollouts</CardTitle>
          <CardDescription>The 50 most recent.</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading || authLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : rollouts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No rollouts yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50 text-left">
                    <th className="px-3 py-2 font-medium">Name</th>
                    <th className="px-3 py-2 font-medium">Component</th>
                    <th className="px-3 py-2 font-medium">Target</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Computers</th>
                    <th className="px-3 py-2 font-medium">Batch</th>
                    <th className="px-3 py-2 font-medium">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {rollouts.map((r) => (
                    <tr key={r.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-3 py-2">
                        <Link href={`/admin/rollouts/${r.id}`} className="font-medium hover:underline">{r.name}</Link>
                        {r.pausedReason && r.status === 'PAUSED' && (
                          <p className="text-xs text-muted-foreground">{r.pausedReason}</p>
                        )}
                      </td>
                      <td className="px-3 py-2">{r.component === 'RUSTDESK' ? 'RustDesk' : 'Agent'}</td>
                      <td className="px-3 py-2 font-mono">{r.targetVersion}</td>
                      <td className="px-3 py-2"><RolloutStatusBadge status={r.status} /></td>
                      <td className="px-3 py-2 tabular-nums">{r._count.jobs}</td>
                      <td className="px-3 py-2 tabular-nums">
                        {r.status === 'DRAFT' ? '—' : r.currentBatch === 0 ? 'Pilot' : r.currentBatch}
                        {r.pilotGroup && <span className="block text-xs text-muted-foreground">pilot: {r.pilotGroup.name}</span>}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{formatDate(r.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <PinCard />
        <PilotGroupsCard groups={pilotGroups} isLoading={groupsLoading} />
      </div>

      <CreateRolloutDialog open={creating} onOpenChange={setCreating} pilotGroups={pilotGroups} />
    </div>
  );
}
