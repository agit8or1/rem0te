'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Loader2, Package, Plus, RefreshCw, Search } from 'lucide-react';
import { businessesApi, softwareApi } from '@/lib/api-client';
import { usePermissions } from '@/lib/auth';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import {
  DeploymentList, EntryForm, SignerBanner, describeDetection, refusalText, selectClass,
  type DeploymentSummary, type Entry,
} from '@/components/software/software-ui';

/**
 * The software catalog (0.34, docs/software-deployment.md): allowlisted
 * winget packages, each pinned to one version, one installer SHA-256 and a
 * detection rule, and the deployments made from them. Adding or changing an
 * entry is a Business Owner's (their business's entries) or a Platform
 * Admin's, with a fresh sign-in. Deploying is approved on the approval
 * signer, never here.
 */

interface ListData {
  entries: Entry[];
  you: { businessId: string | null; canCreateBusiness: boolean; canCreateGlobal: boolean };
  signerConfigured: boolean;
}

export default function SoftwareCatalogPage() {
  const router = useRouter();
  const { isPlatformAdmin } = usePermissions();
  const [picked, setPicked] = useState('');
  const [archived, setArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const { data: businesses = [] } = useQuery({
    queryKey: ['businesses', ''],
    enabled: isPlatformAdmin,
    queryFn: () => businessesApi.list().then((r) => ((r.data as { data?: { id: string; name: string }[] })?.data ?? [])),
  });
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['software-catalog', picked, archived],
    queryFn: () => softwareApi.list(picked || null, archived).then((r) => r.data.data as ListData),
    retry: false,
  });
  const deployments = useQuery({
    queryKey: ['software-deployments', picked],
    queryFn: () => softwareApi.deployments(picked || null).then((r) => r.data.data as DeploymentSummary[]),
    retry: false,
  });
  const canCreate = !!data && (data.you.canCreateBusiness || data.you.canCreateGlobal);

  return (
    <div className="p-4 md:p-6">
      <PageHeader title="Software catalog" description="Allowlisted winget packages, each pinned to one version and one installer SHA-256, deployed a canary first and then in rings.">
        {canCreate && !creating && <Button size="sm" onClick={() => setCreating(true)}><Plus className="h-4 w-4 mr-1" />Add software</Button>}
      </PageHeader>

      {data && !data.signerConfigured && <SignerBanner />}

      <div className="mb-4 rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground space-y-1 max-w-4xl" data-software-explainer>
        <p>
          Only what is in this catalog can be installed or uninstalled, and only at the version pinned here. Each computer downloads the installer with winget from winget&apos;s own source, hashes the file itself and refuses it unless it matches the SHA-256 pinned here — nothing is uploaded to or served by this portal.
          winget&apos;s own hash check applies again when it installs. The install step downloads once more, and those bytes are checked by winget against the source manifest, not hashed again by the agent.
        </p>
        <p>
          Every plan is high risk and needs two approvers on the approval signer; you cannot approve your own request, and nothing on this page can approve. (In direct mode, which only the approval signer&apos;s operator can turn on for a business, a ring is signed as soon as it is requested, after a fresh sign-in.) A deployment starts with one canary computer, and each later ring can be requested only once the one before it has passed: the canary&apos;s detection rule must confirm the change, failures must stay within the threshold, and the soak time must have passed.
          Computers whose software is managed by Configuration Manager or Intune refuse software plans. Nothing here has been run on a real Windows computer yet.
        </p>
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-4">
        {isPlatformAdmin && (
          <div className="w-72">
            <Label htmlFor="sw-biz" className="text-xs">Business</Label>
            <select id="sw-biz" className={selectClass} value={picked} onChange={(e) => { setPicked(e.target.value); setCreating(false); }}>
              <option value="">Every business, and global entries</option>
              {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
        )}
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />Show archived entries</label>
      </div>

      {creating && data && (
        <Card className="mb-4">
          <CardHeader className="pb-3"><CardTitle className="text-sm">Add software</CardTitle></CardHeader>
          <CardContent>
            <EntryForm you={{ ...data.you, businessId: data.you.businessId ?? (picked || null) }} businesses={isPlatformAdmin ? businesses : undefined}
              onDone={(e) => { setCreating(false); refetch(); if (e) router.push(`/automation/software/${e.id}`); }} />
          </CardContent>
        </Card>
      )}

      {data && (
        <WingetCatalog
          canAdd={canCreate} isPlatformAdmin={isPlatformAdmin}
          target={data.you.canCreateBusiness && (data.you.businessId ?? picked) ? { scope: 'business', businessId: (data.you.businessId ?? picked) as string } : data.you.canCreateGlobal ? { scope: 'global' } : null}
          onAdded={(id) => { refetch(); router.push(`/automation/software/${id}`); }}
        />
      )}

      <Card className="mb-4">
        <CardHeader className="pb-3"><CardTitle className="text-sm">Catalog</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          {isLoading ? <p className="text-muted-foreground">Loading…</p>
            : error ? <p className="text-muted-foreground">{refusalText(error, 'The software catalog could not be loaded.')}</p>
            : !data?.entries.length ? <p className="text-muted-foreground">Nothing in the catalog yet.{canCreate ? ' Add a winget package to start.' : ' A Business Owner or a Platform Admin adds entries.'}</p>
            : data.entries.map((e) => (
              <Link key={e.id} href={`/automation/software/${e.id}`} className="block rounded-md border p-3 hover:bg-muted/50" data-software-row>
                <div className="flex flex-wrap items-center gap-2">
                  <Package className="h-4 w-4 text-muted-foreground" />
                  <strong className="break-all">{e.name}</strong>
                  <span className="font-mono text-xs">{e.packageId} {e.version}</span>
                  <Badge variant="outline">{e.scope === 'global' ? 'Global' : e.businessName ?? 'Business'}</Badge>
                  <Badge variant={e.hashSource === 'winget_pkgs' ? 'secondary' : 'warning'}>{e.hashSource === 'winget_pkgs' ? 'hash from winget-pkgs' : 'hash pasted'}</Badge>
                  {e.archivedAt && <Badge variant="outline">archived</Badge>}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  <span className="font-mono">{e.installerSha256.slice(0, 16)}…</span> · {describeDetection(e.detection)} · revision {e.revision}
                </p>
              </Link>
            ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm">Deployments</CardTitle></CardHeader>
        <CardContent>
          {deployments.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p>
            : deployments.error ? <p className="text-sm text-muted-foreground">{refusalText(deployments.error, 'Deployments could not be loaded.')}</p>
            : <DeploymentList rows={deployments.data ?? []} empty="No software deployments yet. Open a catalog entry to deploy it." />}
        </CardContent>
      </Card>
    </div>
  );
}

interface WingetHit { packageId: string; name: string; latestVersion: string; installable: boolean }
interface WingetIndex { refreshedAt: string | null; attemptedAt: string | null; packages: number; lastError: string | null; sweep: 'on' | 'off'; refreshing: boolean }

/**
 * 0.41: search the server's copy of the winget community index and add a
 * package to the catalog in one step. The server reads the version's
 * installer manifest, picks the machine-wide x64 installer winget would
 * choose, pins its SHA-256 and derives the detection rule; anything it
 * cannot decide is refused with the reason, and the manual form above is
 * the way to add it.
 */
function WingetCatalog({ canAdd, isPlatformAdmin, target, onAdded }: {
  canAdd: boolean; isPlatformAdmin: boolean; target: { scope: 'business'; businessId: string } | { scope: 'global' } | null; onAdded: (entryId: string) => void;
}) {
  const { toast } = useToast();
  const [q, setQ] = useState('');
  const [asked, setAsked] = useState('');
  const search = useQuery({
    queryKey: ['winget-search', asked],
    queryFn: () => softwareApi.wingetSearch(asked).then((r) => r.data.data as { query: string; results: WingetHit[]; index: WingetIndex }),
    enabled: asked.length >= 2,
    retry: false,
  });
  const status = useQuery({
    queryKey: ['winget-search', ''],
    queryFn: () => softwareApi.wingetSearch('').then((r) => r.data.data as { index: WingetIndex }),
    retry: false,
  });
  const refresh = useMutation({
    mutationFn: () => softwareApi.wingetRefresh(),
    onSuccess: () => { status.refetch(); toast({ title: 'Winget index read' }); },
    onError: (e) => toast({ title: 'Not read', description: refusalText(e, 'The index could not be read.'), variant: 'destructive' }),
  });
  const add = useMutation({
    mutationFn: (h: WingetHit) => softwareApi.wingetAdd({ ...(target ?? { scope: 'global' }), packageId: h.packageId, version: h.latestVersion }),
    onSuccess: (r) => {
      const d = r.data.data as { entry: { id: string }; change: 'created' | 'updated' | 'reused' };
      toast({ title: d.change === 'reused' ? 'Already in the catalog' : d.change === 'updated' ? 'Catalog entry moved to this version' : 'Added to the catalog' });
      onAdded(d.entry.id);
    },
    onError: (e) => toast({ title: 'Not added', description: refusalText(e, 'The package could not be added.'), variant: 'destructive' }),
  });
  const idx = search.data?.index ?? status.data?.index;

  return (
    <Card className="mb-4" data-testid="winget-catalog">
      <CardHeader className="pb-3 flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-sm">Winget community catalog</CardTitle>
        {isPlatformAdmin && (
          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={refresh.isPending || idx?.refreshing} onClick={() => refresh.mutate()}>
            {refresh.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1" />}Read the index now
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="text-xs text-muted-foreground">
          {idx?.refreshedAt
            ? `${idx.packages.toLocaleString()} packages, read from winget's own source index ${new Date(idx.refreshedAt).toLocaleString()}.`
            : `The server has not read the winget index yet${idx?.lastError ? ` (last attempt: ${idx.lastError})` : ''}.`}{' '}
          It is read at most daily{idx?.sweep === 'off' ? ' (the sweep is switched off on this server)' : ''}. Adding a package pins the installer winget-pkgs lists for its latest version; installing it is approved like any catalog entry.
        </p>
        <form className="flex gap-2 max-w-xl" onSubmit={(e) => { e.preventDefault(); setAsked(q.trim()); }}>
          <Input className="h-8" placeholder="Name, publisher or package id" aria-label="Search the winget catalog" value={q} maxLength={64} onChange={(e) => setQ(e.target.value)} />
          <Button type="submit" size="sm" variant="outline" className="h-8" disabled={q.trim().length < 2}>
            {search.isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}<span className="ml-1">Search</span>
          </Button>
        </form>
        {search.error && <p className="text-xs text-muted-foreground">{refusalText(search.error, 'The search failed.')}</p>}
        {search.data && (search.data.results.length ? (
          <ul className="divide-y text-xs max-w-3xl" data-winget-results>
            {search.data.results.map((h) => (
              <li key={h.packageId} className="flex items-center justify-between gap-2 py-1.5" data-winget-hit={h.packageId}>
                <span className="min-w-0"><span className="font-medium">{h.name}</span> <span className="font-mono">{h.latestVersion}</span><span className="block font-mono text-muted-foreground truncate">{h.packageId}</span></span>
                {canAdd && target && h.installable && (
                  <Button size="sm" variant="outline" className="h-7 text-xs shrink-0" disabled={add.isPending} onClick={() => add.mutate(h)}>Add to catalog</Button>
                )}
                {!h.installable && <span className="text-muted-foreground shrink-0">version not installable from here</span>}
              </li>
            ))}
          </ul>
        ) : <p className="text-xs text-muted-foreground">Nothing matches “{search.data.query}”.</p>)}
        {canAdd && !target && <p className="text-xs text-muted-foreground">Pick a business above to add packages to its catalog.</p>}
      </CardContent>
    </Card>
  );
}
