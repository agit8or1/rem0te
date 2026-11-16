'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Copy, KeyRound } from 'lucide-react';
import { adoptionApi, type DeploymentKey } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/utils';
import { usePermissions } from '@/lib/auth';
import { EMPTY_PLACE, PlacePicker, errText, selectClass, type Place } from '@/components/adoption/place-picker';
import { deploymentRecipes, type Recipe } from '@/components/adoption/recipes';

/**
 * Devices → Deploy agents (0.57). Multi-use deployment keys for fleet
 * rollout — GPO, Intune, an existing RMM, Linux and macOS scripts.
 *
 * A key is shown once, in this page's memory, when it is created; only its
 * hash is stored. The instructions are generated here in the browser with the
 * key put in client-side — nothing on the server, in the docs or in a URL
 * this page requests carries it. Paste the key in yourself for a key made
 * earlier.
 */
const KEY_RE = /^[0-9a-f]{96}$/;
const STATE: Record<DeploymentKey['state'], 'secondary' | 'outline' | 'destructive'> = { usable: 'secondary', exhausted: 'outline', expired: 'outline', revoked: 'destructive' };

export default function DeployAgentsPage() {
  const router = useRouter();
  const { isPlatformAdmin, isLoading: authLoading } = usePermissions();
  const allowed = authLoading || isPlatformAdmin;
  useEffect(() => { if (!authLoading && !isPlatformAdmin) router.push('/dashboard'); }, [authLoading, isPlatformAdmin, router]);
  const [key, setKey] = useState('');
  if (!allowed) return null;
  return (
    <div className="p-4 sm:p-6 space-y-6">
      <PageHeader
        title="Deploy agents"
        description="Deployment keys enrol many computers at once — from Group Policy, Intune, another RMM or a script. Platform Admins only."
        actions={<Button asChild variant="outline" size="sm"><Link href="/admin/unassigned">Unassigned computers</Link></Button>}
      />
      <Keys enabled={isPlatformAdmin} onKey={setKey} />
      <Instructions keyValue={key} onKey={setKey} />
    </div>
  );
}

function Keys({ enabled, onKey }: { enabled: boolean; onKey: (k: string) => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: keys = [], isLoading } = useQuery({ queryKey: ['adoption', 'keys'], queryFn: adoptionApi.keys, enabled });
  const [place, setPlace] = useState<Place>(EMPTY_PLACE);
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'review' | 'active'>('review');
  const [maxUses, setMaxUses] = useState('100');
  const [days, setDays] = useState('30');
  const [shown, setShown] = useState<DeploymentKey | null>(null);
  const create = useMutation({
    mutationFn: () => adoptionApi.createKey({
      businessId: place.businessId, siteId: place.siteId || null, endpointGroupId: place.groupIds[0] ?? null,
      name: name.trim(), mode, maxUses: Number(maxUses), expiresInDays: Number(days),
    }),
    onSuccess: (k) => { setShown(k); if (k.key) onKey(k.key); setName(''); qc.invalidateQueries({ queryKey: ['adoption', 'keys'] }); },
    onError: (e) => toast({ title: 'Could not create the key', description: errText(e), variant: 'destructive' }),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => adoptionApi.revokeKey(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['adoption', 'keys'] }); toast({ title: 'Key revoked', description: 'Computers it already enrolled are not affected.' }); },
    onError: (e) => toast({ title: 'Could not revoke', description: errText(e), variant: 'destructive' }),
  });
  const copy = (t: string) => navigator.clipboard?.writeText(t).then(() => toast({ title: 'Copied' })).catch(() => undefined);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">New deployment key</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <PlacePicker value={place} onChange={setPlace} groups="one" idPrefix="key" />
          <div className="grid gap-3 sm:grid-cols-4">
            <label className="space-y-1 text-xs font-medium sm:col-span-2"><span>Name</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme GPO rollout, November" maxLength={80} />
            </label>
            <label className="space-y-1 text-xs font-medium"><span>Uses (1–10,000)</span>
              <Input type="number" min={1} max={10000} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} />
            </label>
            <label className="space-y-1 text-xs font-medium"><span>Expires after (days, up to 90)</span>
              <Input type="number" min={1} max={90} value={days} onChange={(e) => setDays(e.target.value)} />
            </label>
          </div>
          <label className="space-y-1 text-xs font-medium block"><span>When a computer enrols with it</span>
            <select className={selectClass} value={mode} onChange={(e) => setMode(e.target.value as 'review' | 'active')}>
              <option value="review">Hold it in Unassigned for review (recommended)</option>
              <option value="active">Put it straight into this business</option>
            </select>
          </label>
          <p className="text-xs text-muted-foreground">
            {mode === 'review'
              ? 'Each computer appears under Unassigned with this key’s business suggested; nothing can connect to it until a Platform Admin assigns it.'
              : 'Each computer goes straight into this business (and site and group), where everyone with access can see and act on it. Anyone who has the key can add a computer there until it expires, is used up or is revoked.'}
            {' '}You will be asked to confirm it is you. The key is shown once.
          </p>
          <Button size="sm" disabled={!place.businessId || !name.trim() || create.isPending} onClick={() => create.mutate()}>
            <KeyRound className="h-4 w-4 mr-1" /> Create key
          </Button>
          {shown?.key && (
            <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 space-y-2" data-testid="deployment-key-once">
              <p className="text-xs font-medium">Copy this key now. It is not stored and cannot be shown again.</p>
              <div className="flex gap-2 items-start">
                <code className="flex-1 break-all text-xs font-mono">{shown.key}</code>
                <Button size="sm" variant="outline" onClick={() => copy(shown.key!)}><Copy className="h-4 w-4" /></Button>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setShown(null)}>I have stored it</Button>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="rounded-md border bg-background overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b bg-muted/50 text-left">
            <th className="px-3 py-3 font-medium">Key</th><th className="px-3 py-3 font-medium">Business</th><th className="px-3 py-3 font-medium">Mode</th>
            <th className="px-3 py-3 font-medium">Uses</th><th className="px-3 py-3 font-medium">Expires</th><th className="px-3 py-3 font-medium">State</th><th className="px-3 py-3" />
          </tr></thead>
          <tbody className="divide-y">
            {isLoading ? <tr><td colSpan={7} className="px-3 py-6 text-muted-foreground">Loading…</td></tr>
              : keys.length === 0 ? <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">No deployment keys.</td></tr>
                : keys.map((k) => (
                  <tr key={k.id}>
                    <td className="px-3 py-3"><div className="font-medium">{k.name}</div><div className="text-xs text-muted-foreground font-mono">…{k.keyHint}</div></td>
                    <td className="px-3 py-3 text-xs">{k.businessName}{k.siteName ? ` · ${k.siteName}` : ''}{k.groupName ? ` · ${k.groupName}` : ''}</td>
                    <td className="px-3 py-3 text-xs">{k.mode === 'review' ? 'Review' : 'Straight in'}</td>
                    <td className="px-3 py-3 text-xs">{k.useCount} / {k.maxUses}</td>
                    <td className="px-3 py-3 text-xs">{formatDate(k.expiresAt)}</td>
                    <td className="px-3 py-3"><Badge variant={STATE[k.state]}>{k.state}</Badge></td>
                    <td className="px-3 py-3 text-right">
                      {!k.revokedAt && (
                        <Button size="sm" variant="ghost" disabled={revoke.isPending}
                          onClick={() => { if (window.confirm(`Revoke “${k.name}”? Installs still using it will stop enrolling.`)) revoke.mutate(k.id); }}>Revoke</Button>
                      )}
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Instructions({ keyValue, onKey }: { keyValue: string; onKey: (k: string) => void }) {
  const { toast } = useToast();
  const [origin, setOrigin] = useState('');
  useEffect(() => { setOrigin(window.location.origin); }, []);
  const valid = KEY_RE.test(keyValue);
  // The placeholder, never a real key, when none is entered: the page is safe to screenshot.
  const recipes = useMemo(() => deploymentRecipes(origin || 'https://portal.example.com', valid ? keyValue : '<DEPLOYMENT-KEY>'), [origin, keyValue, valid]);
  const copy = (t: string) => navigator.clipboard?.writeText(t).then(() => toast({ title: 'Copied' })).catch(() => undefined);
  const [sum, setSum] = useState<string | null>(null);
  async function checksum() {
    if (!valid) return;
    try {
      const r = await fetch(`/api/v1/public/install/linux/${keyValue}`, { cache: 'no-store' });
      const buf = await r.arrayBuffer();
      const h = await crypto.subtle.digest('SHA-256', buf);
      setSum(Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join(''));
    } catch { setSum(null); toast({ title: 'Could not fetch the script', variant: 'destructive' }); }
  }

  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm">Instructions</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <label className="space-y-1 text-xs font-medium block"><span>Deployment key</span>
          <Input value={keyValue} onChange={(e) => onKey(e.target.value.trim().toLowerCase())} placeholder="Paste a deployment key (96 characters) to fill it in below"
            className="font-mono" autoComplete="off" spellCheck={false} />
        </label>
        <p className="text-xs text-muted-foreground">
          {valid ? 'The key is filled in below, in this browser only.' : 'Until a key is entered the commands show <DEPLOYMENT-KEY>.'}
          {' '}Every method runs the same installer as Add device and enrols with the key; running it again on a computer that is already enrolled changes nothing and uses nothing.
        </p>
        <Tabs defaultValue={recipes[0].id}>
          <TabsList className="flex flex-wrap h-auto">
            {recipes.map((r) => <TabsTrigger key={r.id} value={r.id}>{r.label}</TabsTrigger>)}
          </TabsList>
          {recipes.map((r) => (
            <TabsContent key={r.id} value={r.id} className="mt-3 space-y-3">
              <RecipeView r={r} copy={copy} />
              {r.id === 'linux' && (
                <div className="space-y-1">
                  <Button size="sm" variant="outline" disabled={!valid} onClick={checksum}>Compute the script’s SHA-256 now</Button>
                  {sum && <p className="text-xs font-mono break-all">{sum}</p>}
                  <p className="text-xs text-muted-foreground">The script changes when this server’s RustDesk version or relay changes, so compare the checksum on the day you roll out.</p>
                </div>
              )}
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  );
}

function RecipeView({ r, copy }: { r: Recipe; copy: (t: string) => void }) {
  return (
    <div className="space-y-3">
      <p className="text-sm">{r.intro}</p>
      {r.steps.map((s, i) => (
        <div key={i} className="space-y-1">
          <p className="text-xs font-medium">{i + 1}. {s.text}</p>
          {s.code && (
            <div className="relative">
              <pre className="rounded-md bg-muted p-3 text-xs overflow-x-auto whitespace-pre"><code>{s.code}</code></pre>
              <Button size="sm" variant="ghost" className="absolute top-1 right-1" onClick={() => copy(s.code!)} aria-label="Copy"><Copy className="h-3.5 w-3.5" /></Button>
            </div>
          )}
        </div>
      ))}
      {r.note && <p className="text-xs text-muted-foreground">{r.note}</p>}
    </div>
  );
}
