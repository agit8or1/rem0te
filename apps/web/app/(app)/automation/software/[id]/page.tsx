'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Loader2, Rocket } from 'lucide-react';
import { businessesApi, endpointsApi, softwareApi } from '@/lib/api-client';
import { usePermissions } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/utils';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  DeploymentList, EntryForm, describeDetection, refusal, refusalText, selectClass,
  type DeploymentSummary, type Entry,
} from '@/components/software/software-ui';

/**
 * One catalog entry (0.34): what it pins, its deployments, and "Deploy to
 * computers" — a canary and up to four more rings. Creating a deployment
 * requests nothing; each ring is requested on the deployment's page and
 * approved by two people on the approval signer.
 */

type Detail = Entry & { deployments: DeploymentSummary[] };
interface Computer { id: string; name: string; hostname?: string | null; platform?: string | null; isOnline?: boolean; status?: string }

export default function SoftwareEntryPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const { data: e, isLoading, error } = useQuery({
    queryKey: ['software-entry', id],
    queryFn: () => softwareApi.get(id).then((r) => r.data.data as Detail),
    retry: false,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['software-entry', id] });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (error || !e) return <p className="text-sm text-muted-foreground">{refusalText(error, 'This catalog entry could not be loaded.')}</p>;

  return (
    <div className="space-y-4">
      <Link href="/automation/software" className="text-xs text-muted-foreground inline-flex items-center gap-1"><ArrowLeft className="h-3 w-3" />Software catalog</Link>
      <PageHeader title={`${e.name} ${e.version}`} description={`${e.packageId} · ${e.scope === 'global' ? 'global catalog' : e.businessName ?? 'business catalog'} · revision ${e.revision}`}>
        <div className="flex gap-2">
          {!e.archivedAt && !deploying && <Button size="sm" onClick={() => { setDeploying(true); setEditing(false); }}><Rocket className="h-4 w-4 mr-1" />Deploy to computers</Button>}
          {e.canEdit && !e.archivedAt && !editing && <Button size="sm" variant="outline" onClick={() => { setEditing(true); setDeploying(false); }}>Edit</Button>}
        </div>
      </PageHeader>
      {e.archivedAt && <p className="text-sm rounded-md border p-3">Archived {formatDate(e.archivedAt)}. It cannot be deployed, and deployments made from it request no further ring.</p>}

      {editing ? (
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-sm">Edit — saving makes revision {e.revision + 1}</CardTitle></CardHeader>
          <CardContent><EntryForm entry={e} onDone={(saved) => { setEditing(false); if (saved) refresh(); }} /></CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-sm">What this entry pins</CardTitle></CardHeader>
          <CardContent className="text-sm">
            <dl className="grid grid-cols-1 sm:grid-cols-[12rem_1fr] gap-x-4 gap-y-1">
              <dt className="text-muted-foreground">Package</dt><dd className="font-mono break-all">{e.packageId}</dd>
              <dt className="text-muted-foreground">Version</dt><dd className="font-mono">{e.version}</dd>
              {e.publisher && <><dt className="text-muted-foreground">Publisher</dt><dd>{e.publisher}</dd></>}
              <dt className="text-muted-foreground">Installer SHA-256</dt><dd className="font-mono break-all">{e.installerSha256}</dd>
              <dt className="text-muted-foreground">Where the hash came from</dt>
              <dd>{e.hashSource === 'winget_pkgs' ? `The winget-pkgs installer manifest${e.architecture ? ` (${e.architecture})` : ''}` : 'Pasted by whoever saved this revision; no manifest behind it'}</dd>
              {e.manifestUrl && <><dt className="text-muted-foreground">Manifest</dt><dd><a className="underline break-all" href={e.manifestUrl} target="_blank" rel="noopener noreferrer">{e.manifestUrl}</a></dd></>}
              {e.manifestSha256 && <><dt className="text-muted-foreground">Manifest SHA-256</dt><dd className="font-mono break-all">{e.manifestSha256}</dd></>}
              {e.installerUrl && <><dt className="text-muted-foreground">Installer URL (manifest)</dt><dd className="break-all">{e.installerUrl}</dd></>}
              <dt className="text-muted-foreground">Detection rule</dt><dd>{describeDetection(e.detection)}</dd>
              {e.notes && <><dt className="text-muted-foreground">Notes</dt><dd className="whitespace-pre-wrap">{e.notes}</dd></>}
              <dt className="text-muted-foreground">Changed</dt><dd>{formatDate(e.updatedAt)}</dd>
            </dl>
            {e.canEdit && !e.archivedAt && <Archive entry={e} onDone={refresh} />}
          </CardContent>
        </Card>
      )}

      {deploying && <DeployBuilder entry={e} onCancel={() => setDeploying(false)} />}

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm">Deployments of this entry</CardTitle></CardHeader>
        <CardContent><DeploymentList rows={e.deployments} empty="Not deployed yet." /></CardContent>
      </Card>
    </div>
  );
}

function Archive({ entry, onDone }: { entry: Entry; onDone: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => softwareApi.archive(entry.id, { reason: reason.trim(), expectedRevision: entry.revision }),
    onSuccess: () => { toast({ title: 'Archived', description: 'It can no longer be deployed.' }); setOpen(false); onDone(); },
    onError: (e) => toast({ title: 'Not archived', description: refusalText(e, 'Refused.'), variant: 'destructive' }),
  });
  if (!open) return <Button size="sm" variant="ghost" className="mt-3" onClick={() => setOpen(true)}>Archive…</Button>;
  return (
    <div className="mt-3 space-y-2 max-w-lg rounded-md border p-3">
      <p className="text-xs">Archiving stops new deployments, and stops existing deployments of it at their next ring. Plans already approved still run. It asks you to sign in again.</p>
      <Label htmlFor="sw-archive" className="text-xs">Why (recorded in the audit log)</Label>
      <Textarea id="sw-archive" rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="flex gap-2">
        <Button size="sm" variant="destructive" disabled={reason.trim().length < 1 || m.isPending} onClick={() => m.mutate()}>{m.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}Archive</Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </div>
  );
}

function DeployBuilder({ entry, onCancel }: { entry: Entry; onCancel: () => void }) {
  const { toast } = useToast();
  const router = useRouter();
  const { isPlatformAdmin, businessId: own, technician } = usePermissions();
  const [picked, setPicked] = useState('');
  const businessId = entry.scope === 'business' ? entry.businessId ?? '' : picked || technician?.businessId || own || '';
  const { data: businesses = [] } = useQuery({
    queryKey: ['businesses', ''],
    enabled: isPlatformAdmin && entry.scope === 'global',
    queryFn: () => businessesApi.list().then((r) => ((r.data as { data?: { id: string; name: string }[] })?.data ?? [])),
  });
  const { data: computers = [], isLoading } = useQuery({
    queryKey: ['software-deploy-computers', businessId],
    enabled: !!businessId,
    queryFn: () => endpointsApi.list({ businessId, limit: '200' }).then((r) => ((r.data?.data?.endpoints ?? []) as Computer[]).filter((c) => c.status !== 'ARCHIVED')),
  });
  const [operation, setOperation] = useState<'install' | 'uninstall'>('install');
  const [name, setName] = useState('');
  const [ringOf, setRingOf] = useState<Record<string, number | ''>>({});
  const [soakHours, setSoakHours] = useState(24);
  const [failureThreshold, setFailureThreshold] = useState(0);
  const [windowHours, setWindowHours] = useState(8);
  const [refused, setRefused] = useState<{ message: string; fix: string | null } | null>(null);

  const rings = useMemo(() => {
    const max = Math.max(-1, ...Object.values(ringOf).filter((r): r is number => r !== ''));
    const out: string[][] = Array.from({ length: max + 1 }, () => []);
    for (const [cid, r] of Object.entries(ringOf)) if (r !== '') out[r].push(cid);
    return out;
  }, [ringOf]);
  const ringsOk = rings.length >= 1 && rings[0].length === 1 && rings.every((r) => r.length >= 1 && r.length <= 25);
  const numbersOk = soakHours >= 0 && soakHours <= 168 && failureThreshold >= 0 && failureThreshold <= 25 && windowHours >= 1 && windowHours <= 24;

  const create = useMutation({
    mutationFn: () => softwareApi.createDeployment({
      entryId: entry.id, operation, rings, soakHours, failureThreshold, windowHours, ...(name.trim() ? { name: name.trim() } : {}),
    }),
    onSuccess: (r) => { toast({ title: 'Deployment created', description: 'Nothing is requested yet. Request the canary on its page.' }); router.push(`/automation/software/deployments/${r.data.data.id}`); },
    onError: (e) => { const r = refusal(e, 'The deployment was refused.'); setRefused({ message: r.message, fix: r.fix }); },
  });

  return (
    <Card data-deploy-builder>
      <CardHeader className="pb-3"><CardTitle className="text-sm flex items-center gap-2"><Rocket className="h-4 w-4" />Deploy {entry.name} {entry.version}</CardTitle></CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-3xl">
          <div className="space-y-1">
            <Label htmlFor="sd-op" className="text-xs">Operation</Label>
            <select id="sd-op" className={selectClass} value={operation} onChange={(e) => setOperation(e.target.value as 'install' | 'uninstall')}>
              <option value="install">Install</option>
              <option value="uninstall">Uninstall</option>
            </select>
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="sd-name" className="text-xs">Name (optional)</Label>
            <Input id="sd-name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder={`${operation === 'install' ? 'Install' : 'Uninstall'} ${entry.name} ${entry.version}`} />
          </div>
          {entry.scope === 'global' && isPlatformAdmin && (
            <div className="space-y-1">
              <Label htmlFor="sd-biz" className="text-xs">Business</Label>
              <select id="sd-biz" className={selectClass} value={picked} onChange={(e) => { setPicked(e.target.value); setRingOf({}); }}>
                <option value="">Choose a business…</option>
                {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
          )}
        </div>

        <div className="space-y-1">
          <p className="text-xs font-medium">Rings — ring 0 is one canary computer; rings 1–4 hold up to 25 each. Computers of one business only.</p>
          {!businessId ? <p className="text-xs text-muted-foreground">Choose a business first.</p>
            : isLoading ? <p className="text-xs text-muted-foreground">Loading computers…</p>
            : computers.length === 0 ? <p className="text-xs text-muted-foreground">This business has no computers you can see.</p>
            : (
              <div className="max-h-96 overflow-auto space-y-1">
                {computers.map((c) => (
                  <div key={c.id} className="flex flex-wrap items-center gap-2 text-xs">
                    <select aria-label={`Ring for ${c.hostname ?? c.name}`} className="h-8 rounded-md border border-input bg-background px-2 text-xs" value={ringOf[c.id] ?? ''}
                      onChange={(e) => setRingOf((m) => ({ ...m, [c.id]: e.target.value === '' ? '' : Number(e.target.value) }))}>
                      <option value="">not in this deployment</option>
                      {[0, 1, 2, 3, 4].map((r) => <option key={r} value={r}>{r === 0 ? 'ring 0 (canary)' : `ring ${r}`}</option>)}
                    </select>
                    <span>{c.hostname ?? c.name}</span>
                    <span className="text-muted-foreground">{c.platform ?? 'platform not reported'}{c.isOnline === false ? ' · offline' : ''}</span>
                  </div>
                ))}
              </div>
            )}
          {Object.values(ringOf).some((r) => r !== '') && (
            <p className={`text-xs ${ringsOk ? 'text-muted-foreground' : 'text-destructive'}`}>
              {ringsOk ? rings.map((r, i) => `${i === 0 ? 'canary' : `ring ${i}`}: ${r.length}`).join(' · ') : 'Ring 0 must be exactly one computer, and no ring may be empty or larger than 25.'}
            </p>
          )}
          <p className="text-xs text-muted-foreground">Each computer is checked when you create the deployment, and again when its ring is requested: Windows, a signed agent that supports software plans, software not managed by Configuration Manager or Intune, and your access to higher-risk requests. The canary must be online now.</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-2xl">
          <div className="space-y-1"><Label htmlFor="sd-soak" className="text-xs">Soak between rings (hours, 0–168)</Label><Input id="sd-soak" type="number" min={0} max={168} value={soakHours} onChange={(e) => setSoakHours(Number(e.target.value))} /></div>
          <div className="space-y-1"><Label htmlFor="sd-thr" className="text-xs">Failed computers allowed per ring</Label><Input id="sd-thr" type="number" min={0} max={25} value={failureThreshold} onChange={(e) => setFailureThreshold(Number(e.target.value))} /></div>
          <div className="space-y-1"><Label htmlFor="sd-win" className="text-xs">Window each ring may run in (hours, 1–24)</Label><Input id="sd-win" type="number" min={1} max={24} value={windowHours} onChange={(e) => setWindowHours(Number(e.target.value))} /></div>
        </div>

        {refused && (
          <div className="rounded-md border border-destructive/50 p-3 text-xs" data-refusal>
            <p className="font-medium">{refused.message}</p>
            {refused.fix && <p className="mt-1">{refused.fix}</p>}
          </div>
        )}
        <p className="text-xs text-muted-foreground flex gap-2"><AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-yellow-600" />
          The deployment keeps this revision of the entry. If the entry is changed or archived later, no further ring is requested; make a new deployment from the current entry.
        </p>
        <div className="flex gap-2">
          <Button size="sm" disabled={!ringsOk || !numbersOk || create.isPending} onClick={() => { setRefused(null); create.mutate(); }}>
            {create.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}Create deployment
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        </div>
      </CardContent>
    </Card>
  );
}
