'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { FileCode2, Plus } from 'lucide-react';
import { businessesApi, scriptsApi } from '@/lib/api-client';
import { usePermissions } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/utils';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScriptRunNotice, RiskBadge, StatusBadge, VersionEditor, apiMessage, selectClass } from '@/components/scripts/script-ui';

/**
 * The script library (docs/script-library.md): scripts for this business and
 * the global ones, with their latest version and review state. Writing,
 * editing and reviewing here. A run is requested from an approved version's
 * page (0.34) and approved on the approval signer; the notice says how.
 */

interface Row {
  id: string; name: string; scope: 'global' | 'business'; businessId: string | null; businessName: string | null;
  latest: { version: number; status: string; risk: string; createdAt: string };
  approved: { version: number; contentSha256: string } | null;
  inReview: number; versions: number; view: 'full' | 'approved_only';
}
interface ListData { scripts: Row[]; you: { canCreateBusiness: boolean; canCreateGlobal: boolean; businessId: string | null } }

export default function ScriptLibraryPage() {
  const { isPlatformAdmin } = usePermissions();
  const [picked, setPicked] = useState('');
  const [creating, setCreating] = useState(false);
  const { data: businesses = [] } = useQuery({
    queryKey: ['businesses', ''],
    enabled: isPlatformAdmin,
    queryFn: () => businessesApi.list().then((r) => ((r.data as { data?: { id: string; name: string }[] })?.data ?? [])),
  });
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['scripts', picked],
    queryFn: () => scriptsApi.list(picked || null).then((r) => r.data.data as ListData),
    retry: false,
  });
  const canCreate = !!data && (data.you.canCreateBusiness || data.you.canCreateGlobal);

  return (
    <div>
      <PageHeader title="Script library" description="PowerShell scripts, versioned and reviewed by someone other than their author.">
        {canCreate && !creating && <Button size="sm" onClick={() => setCreating(true)}><Plus className="h-4 w-4 mr-1" />New script</Button>}
      </PageHeader>
      <ScriptRunNotice />

      {isPlatformAdmin && (
        <div className="mb-4 max-w-sm">
          <Label htmlFor="sl-biz" className="text-xs">Business</Label>
          <select id="sl-biz" className={selectClass} value={picked} onChange={(e) => { setPicked(e.target.value); setCreating(false); }}>
            <option value="">Every business, and global scripts</option>
            {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
      )}

      {creating && data && <CreateScript you={data.you} businesses={businesses} onDone={() => { setCreating(false); refetch(); }} />}

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm">Scripts</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          {isLoading ? <p className="text-muted-foreground">Loading…</p>
            : error ? <p className="text-muted-foreground">{apiMessage(error, 'The script library could not be loaded.')}</p>
            : !data?.scripts.length ? <p className="text-muted-foreground">No scripts yet.</p>
            : data.scripts.map((s) => (
              <Link key={s.id} href={`/automation/scripts/${s.id}`} className="block rounded-md border p-3 hover:bg-muted/50" data-script-row>
                <div className="flex flex-wrap items-center gap-2">
                  <FileCode2 className="h-4 w-4 text-muted-foreground" />
                  <strong className="break-all">{s.name}</strong>
                  <Badge variant="outline">{s.scope === 'global' ? 'Global' : s.businessName ?? 'Business'}</Badge>
                  <StatusBadge status={s.latest.status} />
                  <RiskBadge risk={s.latest.risk} />
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Version {s.latest.version} · {formatDate(s.latest.createdAt)}
                  {s.approved ? ` · approved: version ${s.approved.version}` : ' · nothing approved yet'}
                  {s.inReview ? ` · ${s.inReview} in review` : ''}
                  {s.view === 'approved_only' ? ' · read-only (approved global versions)' : ''}
                </p>
              </Link>
            ))}
        </CardContent>
      </Card>
    </div>
  );
}

function CreateScript({ you, businesses, onDone }: { you: ListData['you']; businesses: { id: string; name: string }[]; onDone: () => void }) {
  const { toast } = useToast();
  const router = useRouter();
  const { isPlatformAdmin } = usePermissions();
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'business' | 'global'>(you.canCreateBusiness ? 'business' : 'global');
  const [businessId, setBusinessId] = useState(you.businessId ?? '');
  const create = useMutation({
    mutationFn: (v: Parameters<typeof scriptsApi.create>[0]) => scriptsApi.create(v),
    onSuccess: (r) => { toast({ title: 'Script added', description: 'Version 1 is a draft. Submit it for review when it is ready.' }); onDone(); router.push(`/automation/scripts/${r.data.data.id}`); },
    onError: (e) => toast({ title: 'Not added', description: apiMessage(e, 'The script was refused.'), variant: 'destructive' }),
  });
  return (
    <Card className="mb-4">
      <CardHeader className="pb-3"><CardTitle className="text-sm">New script</CardTitle></CardHeader>
      <CardContent>
        <VersionEditor submitLabel="Add as a draft" busy={create.isPending} onCancel={onDone}
          onSubmit={(v) => create.mutate({ ...v, name: name.trim(), scope, ...(scope === 'business' && isPlatformAdmin ? { businessId } : {}) })}>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-2xl">
            <div className="space-y-1 sm:col-span-1">
              <Label htmlFor="ns-name" className="text-xs">Name</Label>
              <Input id="ns-name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Clear print queue" />
            </div>
            {you.canCreateGlobal && (
              <div className="space-y-1">
                <Label htmlFor="ns-scope" className="text-xs">Scope</Label>
                <select id="ns-scope" className={selectClass} value={scope} onChange={(e) => setScope(e.target.value as 'business' | 'global')}>
                  <option value="business">One business</option>
                  <option value="global">Global (every business)</option>
                </select>
              </div>
            )}
            {scope === 'business' && isPlatformAdmin && (
              <div className="space-y-1">
                <Label htmlFor="ns-biz" className="text-xs">Business</Label>
                <select id="ns-biz" className={selectClass} value={businessId} onChange={(e) => setBusinessId(e.target.value)}>
                  <option value="">Choose…</option>
                  {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
            )}
          </div>
        </VersionEditor>
      </CardContent>
    </Card>
  );
}
