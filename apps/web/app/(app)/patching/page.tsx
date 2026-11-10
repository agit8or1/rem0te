'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { businessesApi, patchingApi, type UpdateIdentity } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { usePermissions } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/utils';
import { DEPLOYMENT_STATUS } from '@/lib/patching';
import { AlertTriangle, Loader2, Plus, ShieldCheck } from 'lucide-react';

/**
 * Staged Windows patching (v0.27): deployments for one business.
 *
 * A deployment names security/critical/rollup/ordinary updates, by Windows
 * Update's own identity, and the computers in each ring. Ring 0 is a single
 * canary. Each ring is requested as one signed plan and approved on the
 * approval signer by two people on the roster; the next ring cannot be
 * requested until the canary confirms the updates took effect, the failure
 * threshold holds and the soak time has passed. Nothing on this page can
 * approve anything or restart a computer.
 */

interface Candidates {
  computers: { id: string; hostname: string; deviceClass: string; isOnline: boolean; notReady: string | null; scannedAt: string | null; managers: string[]; rebootPending: boolean | null; offered: number | null }[];
  updates: (UpdateIdentity & { kb: string | null; title: string; className: string | null; severity: string | null; offeredOn: number; installable: boolean; notInstallableBecause: string | null })[];
}
interface DeploymentRow { id: string; name: string; status: string; pausedReason: string | null; rings: number[]; updates: number; lastRing: number | null; lastRingStatus: string | null; createdAt: string }

const selectClass = 'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm';
const key = (u: UpdateIdentity) => `${u.updateId}@${u.revision}`;

function apiMessage(e: unknown, fallback: string) {
  return (e as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message?.toString() ?? fallback;
}

export default function PatchingPage() {
  const { isPlatformAdmin, businessId: own, technician } = usePermissions();
  const [picked, setPicked] = useState('');
  const { data: businesses = [] } = useQuery({
    queryKey: ['businesses', ''],
    enabled: isPlatformAdmin,
    queryFn: () => businessesApi.list().then((r) => ((r.data as { data?: { id: string; name: string }[] })?.data ?? [])),
  });
  const businessId = picked || technician?.businessId || own || '';
  const [creating, setCreating] = useState(false);

  const { data: rows = [], isLoading, refetch } = useQuery({
    queryKey: ['patch-deployments', businessId],
    enabled: !!businessId,
    queryFn: () => patchingApi.list(businessId).then((r) => r.data.data as DeploymentRow[]),
  });

  return (
    <div>
      <PageHeader title="Patching" description="Windows updates, a canary first, then rings — each ring approved by two people on the approval roster.">
        {businessId && !creating && <Button size="sm" onClick={() => setCreating(true)}><Plus className="h-4 w-4 mr-1" />New deployment</Button>}
      </PageHeader>

      {isPlatformAdmin && (
        <div className="mb-4 max-w-sm">
          <Label className="text-xs">Business</Label>
          <select className={selectClass} value={businessId} onChange={(e) => { setPicked(e.target.value); setCreating(false); }}>
            <option value="">Choose a business…</option>
            {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
      )}

      {creating && businessId && <CreateDeployment businessId={businessId} onDone={() => { setCreating(false); refetch(); }} />}

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm">Deployments</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          {!businessId ? <p className="text-muted-foreground">Choose a business.</p>
            : isLoading ? <p className="text-muted-foreground">Loading…</p>
            : rows.length === 0 ? <p className="text-muted-foreground">No deployments yet.</p>
            : rows.map((d) => (
              <Link key={d.id} href={`/patching/${d.id}`} className="block rounded-md border p-3 hover:bg-muted/50">
                <div className="flex flex-wrap items-center gap-2">
                  <strong>{d.name}</strong>
                  <Badge variant={DEPLOYMENT_STATUS[d.status] ?? 'outline'}>{d.status.toLowerCase()}</Badge>
                  <span className="text-xs text-muted-foreground">{d.updates} update{d.updates === 1 ? '' : 's'} · rings of {d.rings.join(', ')} · {formatDate(d.createdAt)}</span>
                </div>
                {d.lastRing !== null && <p className="text-xs text-muted-foreground mt-1">{d.lastRing === 0 ? 'Canary' : `Ring ${d.lastRing}`}: {d.lastRingStatus?.toLowerCase().replace(/_/g, ' ')}</p>}
                {d.pausedReason && d.status === 'PAUSED' && <p className="text-xs mt-1">Paused: {d.pausedReason}</p>}
              </Link>
            ))}
        </CardContent>
      </Card>
    </div>
  );
}

function CreateDeployment({ businessId, onDone }: { businessId: string; onDone: () => void }) {
  const { toast } = useToast();
  const router = useRouter();
  const { data: c, isLoading } = useQuery({
    queryKey: ['patch-candidates', businessId],
    queryFn: () => patchingApi.candidates(businessId).then((r) => r.data.data as Candidates),
  });
  const [name, setName] = useState('');
  const [updates, setUpdates] = useState<Set<string>>(new Set());
  const [ringOf, setRingOf] = useState<Record<string, number | ''>>({});
  const [soakHours, setSoakHours] = useState(24);
  const [failureThreshold, setFailureThreshold] = useState(0);
  const [windowHours, setWindowHours] = useState(8);

  const rings = useMemo(() => {
    const max = Math.max(-1, ...Object.values(ringOf).filter((r): r is number => r !== ''));
    const out: string[][] = Array.from({ length: max + 1 }, () => []);
    for (const [id, r] of Object.entries(ringOf)) if (r !== '') out[r].push(id);
    return out;
  }, [ringOf]);
  const ringsOk = rings.length >= 1 && rings[0].length === 1 && rings.every((r) => r.length >= 1 && r.length <= 25);

  const create = useMutation({
    mutationFn: () => patchingApi.create({
      businessId, name: name.trim(), soakHours, failureThreshold, windowHours, rings,
      updates: (c?.updates ?? []).filter((u) => updates.has(key(u))).map((u) => ({ updateId: u.updateId, revision: u.revision })),
    }),
    onSuccess: (r) => { toast({ title: 'Deployment created', description: 'Request the canary when you are ready.' }); onDone(); router.push(`/patching/${r.data.data.id}`); },
    onError: (e) => toast({ title: 'Not created', description: apiMessage(e, 'The deployment was refused.'), variant: 'destructive' }),
  });

  if (isLoading || !c) return <Card className="mb-4"><CardContent className="pt-6 text-sm text-muted-foreground">Loading what the computers report…</CardContent></Card>;
  const ready = c.computers.filter((x) => !x.notReady && x.managers.length === 0 && x.scannedAt);
  const notReady = c.computers.filter((x) => !ready.includes(x));

  return (
    <Card className="mb-4">
      <CardHeader className="pb-3"><CardTitle className="text-sm flex items-center gap-2"><ShieldCheck className="h-4 w-4" />New deployment</CardTitle></CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="max-w-md space-y-1">
          <Label htmlFor="dep-name" className="text-xs">Name</Label>
          <Input id="dep-name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. November security updates" />
        </div>

        <div className="space-y-1">
          <p className="text-xs font-medium">Updates — as Windows Update offers them to these computers</p>
          {c.updates.length === 0 && <p className="text-xs text-muted-foreground">No computer has reported any offered update yet. Ask them to scan from each computer&apos;s Patches tab.</p>}
          {c.updates.map((u) => (
            <label key={key(u)} className={`flex items-start gap-2 rounded-md border p-2 text-xs ${u.installable ? '' : 'opacity-60'}`}>
              <input type="checkbox" className="mt-0.5" disabled={!u.installable} checked={updates.has(key(u))}
                onChange={(e) => setUpdates((s) => { const n = new Set(s); if (e.target.checked) n.add(key(u)); else n.delete(key(u)); return n; })} />
              <span>
                {u.kb && <strong>{u.kb} </strong>}{u.title}
                <span className="block text-muted-foreground">{u.className ?? 'Unclassified'}{u.severity ? ` · ${u.severity}` : ''} · offered on {u.offeredOn} computer{u.offeredOn === 1 ? '' : 's'}{u.installable ? '' : ` · not installable: ${u.notInstallableBecause}`}</span>
              </span>
            </label>
          ))}
        </div>

        <div className="space-y-1">
          <p className="text-xs font-medium">Rings — ring 0 is one canary computer; each later ring up to 25</p>
          {ready.map((x) => (
            <div key={x.id} className="flex flex-wrap items-center gap-2 text-xs">
              <select className="h-8 rounded-md border border-input bg-background px-2 text-xs" value={ringOf[x.id] ?? ''} onChange={(e) => setRingOf((m) => ({ ...m, [x.id]: e.target.value === '' ? '' : Number(e.target.value) }))}>
                <option value="">not in this deployment</option>
                {[0, 1, 2, 3, 4].map((r) => <option key={r} value={r}>{r === 0 ? 'ring 0 (canary)' : `ring ${r}`}</option>)}
              </select>
              <span>{x.hostname}</span>
              <span className="text-muted-foreground">{x.deviceClass.toLowerCase()} · {x.offered ?? 0} offered{x.rebootPending ? ' · restart pending' : ''}{x.isOnline ? '' : ' · offline'}</span>
            </div>
          ))}
          {notReady.length > 0 && (
            <details className="text-xs text-muted-foreground">
              <summary>{notReady.length} computer{notReady.length === 1 ? '' : 's'} cannot be included</summary>
              <ul className="list-disc pl-5 mt-1">
                {notReady.map((x) => <li key={x.id}>{x.hostname}: {x.managers.length ? `updates managed by ${x.managers.join(', ')}` : x.notReady ?? 'no Windows Update scan reported yet'}</li>)}
              </ul>
            </details>
          )}
          {!ringsOk && Object.keys(ringOf).length > 0 && <p className="text-xs text-destructive">Ring 0 must be exactly one computer, and no ring may be empty or larger than 25.</p>}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-2xl">
          <div className="space-y-1"><Label className="text-xs">Soak between rings (hours)</Label><Input type="number" min={0} max={168} value={soakHours} onChange={(e) => setSoakHours(Number(e.target.value))} /></div>
          <div className="space-y-1"><Label className="text-xs">Failed computers allowed per ring</Label><Input type="number" min={0} max={25} value={failureThreshold} onChange={(e) => setFailureThreshold(Number(e.target.value))} /></div>
          <div className="space-y-1"><Label className="text-xs">Window each ring may run in (hours)</Label><Input type="number" min={1} max={24} value={windowHours} onChange={(e) => setWindowHours(Number(e.target.value))} /></div>
        </div>

        <p className="text-xs text-muted-foreground flex gap-2"><AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-yellow-600" />
          Computers are never restarted. Drivers, feature upgrades, optional updates and anything needing a licence or someone at the keyboard are refused, by the portal and again by each computer.
        </p>
        <div className="flex gap-2">
          <Button size="sm" disabled={name.trim().length < 3 || updates.size === 0 || !ringsOk || create.isPending} onClick={() => create.mutate()}>
            {create.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}Create
          </Button>
          <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
        </div>
      </CardContent>
    </Card>
  );
}
