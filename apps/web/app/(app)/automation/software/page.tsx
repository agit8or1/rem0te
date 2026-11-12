'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Package, Plus } from 'lucide-react';
import { businessesApi, softwareApi } from '@/lib/api-client';
import { usePermissions } from '@/lib/auth';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
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
    <div>
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
          Every plan is high risk and needs two approvers on the approval signer; you cannot approve your own request, and nothing on this page can approve. A deployment starts with one canary computer, and each later ring can be requested only once the one before it has passed: the canary&apos;s detection rule must confirm the change, failures must stay within the threshold, and the soak time must have passed.
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
