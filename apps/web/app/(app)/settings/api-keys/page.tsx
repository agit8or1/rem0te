'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Copy, KeyRound, Trash2 } from 'lucide-react';
import { API_KEY_SCOPES, apiKeysApi, businessesApi } from '@/lib/api-client';
import { usePermissions } from '@/lib/auth';
import { PageHeader } from '@/components/common/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiError } from '@/components/security-controls/shared';

/**
 * Settings → API keys (0.29).
 *
 * Keys for the public API (/api/v1/pub/v1, docs/PUBLIC-API.md). A key belongs
 * to exactly one business and carries only the scopes ticked here. The key
 * itself is shown once, at creation; only its prefix is stored readably.
 *
 * Creating a key asks the person to confirm it is them (0.34, every key; 0.33
 * asked only for enrollment:write). The API answers STEP_UP_REQUIRED, the
 * StepUpDialog asks, and the interceptor retries the same request — the form
 * is untouched throughout and cleared only once the key exists. Revoking
 * never asks. Keys cannot be edited: to change scopes, create a new key and
 * revoke the old one.
 */

type Key = {
  id: string; name: string; keyPrefix: string; scopes: string[];
  lastUsedAt: string | null; expiresAt: string | null; revokedAt: string | null; createdAt: string;
};

const SCOPE_HINT: Record<string, string> = {
  'companies:read': 'List and read businesses',
  'companies:write': 'Create businesses',
  'users:read': 'List people',
  'users:write': 'Invite people',
  'computers:read': 'List and read computers',
  'computers:write': 'Change computers',
  'sessions:read': 'Read session history',
  'enrollment:write': 'Create enrollment tokens (installs a computer into the business)',
  'audit:read': 'Read the audit log',
};
const fmt = (d: string | null) => (d ? new Date(d).toLocaleString() : '—');

export default function ApiKeysPage() {
  const { user, isPlatformAdmin, isBusinessOwner, businessId, businessName } = usePermissions();
  const qc = useQueryClient();
  const [target, setTarget] = useState('');
  const scopeId = businessId ?? (target || undefined);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);

  const { data: businesses } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['businesses-for-apikeys'],
    queryFn: () => businessesApi.list().then((r) => ((r.data as { data?: { id: string; name: string }[] })?.data ?? [])),
    enabled: isPlatformAdmin && !businessId,
  });
  const { data: keys, isLoading, error } = useQuery<Key[]>({
    queryKey: ['apikeys', scopeId ?? 'all'],
    queryFn: () => apiKeysApi.list(scopeId).then((r) => r.data.data),
    enabled: !!user && isBusinessOwner,
    retry: false,
  });

  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['computers:read']);
  const [expires, setExpires] = useState('90');
  const create = useMutation({
    mutationFn: () => apiKeysApi.create({
      name: name.trim(), scopes,
      ...(expires !== 'never' ? { expiresInDays: Number(expires) } : {}),
      ...(!businessId && target ? { businessId: target } : {}),
    }).then((r) => r.data.data as Key & { key: string }),
    onSuccess: (k) => {
      setCreated({ name: k.name, key: k.key }); setName(''); setNotice(null);
      qc.invalidateQueries({ queryKey: ['apikeys'] });
    },
    onError: (e) => {
      // Cancelled (or failed) confirmation: nothing was created and the form is kept as it was.
      const code = (e as { response?: { data?: { code?: string } } })?.response?.data?.code;
      setNotice({ ok: false, text: code === 'STEP_UP_REQUIRED'
        ? 'No key was created: creating a key needs you to confirm it is you. Your entries are kept — press Create key to try again.'
        : apiError(e).message });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => apiKeysApi.revoke(id),
    onSuccess: () => { setNotice({ ok: true, text: 'Revoked. Requests with that key now get 401.' }); qc.invalidateQueries({ queryKey: ['apikeys'] }); },
    onError: (e) => setNotice({ ok: false, text: apiError(e).message }),
  });

  if (!user) return null;
  if (!isBusinessOwner) {
    return <div className="p-6 text-sm text-muted-foreground">API keys are managed by a Business Owner or a Platform Admin.</div>;
  }

  const needsBusiness = !businessId;
  const canCreate = name.trim().length > 0 && scopes.length > 0 && (!needsBusiness || !!target);
  const toggle = (s: string) => setScopes((x) => (x.includes(s) ? x.filter((y) => y !== s) : [...x, s]));

  return (
    <div className="space-y-4 p-4 md:p-6">
      <Link href="/settings" className="inline-flex items-center text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="mr-1 h-4 w-4" />Settings
      </Link>
      <PageHeader
        title="API keys"
        description="Keys for the public API at /api/v1/pub/v1. Each key belongs to one business and can do only what its scopes allow."
      />
      {notice && (
        <div className={`rounded-md border p-3 text-sm ${notice.ok ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100' : 'border-destructive/40 bg-destructive/10 text-destructive'}`}>{notice.text}</div>
      )}

      {created && (
        <Card className="border-amber-300 dark:border-amber-800" data-testid="apikey-created">
          <CardHeader><CardTitle className="text-sm">Copy “{created.name}” now — it is not shown again</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-muted p-2 font-mono text-xs" data-secret>{created.key}</code>
              <Button size="sm" variant="outline" onClick={() => { void navigator.clipboard?.writeText(created.key); setNotice({ ok: true, text: 'Copied.' }); }}>
                <Copy className="mr-1 h-4 w-4" />Copy
              </Button>
            </div>
            <p className="text-muted-foreground">Send it as <code>Authorization: Bearer {'<key>'}</code>. Only a hash is stored; if it is lost, revoke it and create another.</p>
            <Button size="sm" variant="ghost" onClick={() => setCreated(null)}>I have saved it</Button>
          </CardContent>
        </Card>
      )}

      {needsBusiness && (
        <Card>
          <CardContent className="space-y-1 pt-6 text-sm">
            <Label htmlFor="ak-business">Business</Label>
            <select id="ak-business" className="w-full rounded-md border bg-background p-2 md:w-96" value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">All businesses (list only)</option>
              {(businesses ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <p className="text-xs text-muted-foreground">A key is always created inside one business — no key reaches every business.</p>
          </CardContent>
        </Card>
      )}

      <Card data-testid="apikey-create">
        <CardHeader><CardTitle className="text-sm">Create a key{businessName ? ` for ${businessName}` : ''}</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="ak-name">Name</Label>
              <Input id="ak-name" value={name} maxLength={128} placeholder="e.g. PSA sync" onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ak-exp">Expires</Label>
              <select id="ak-exp" className="w-full rounded-md border bg-background p-2" value={expires} onChange={(e) => setExpires(e.target.value)}>
                <option value="30">In 30 days</option>
                <option value="90">In 90 days</option>
                <option value="365">In a year</option>
                <option value="never">Never</option>
              </select>
            </div>
          </div>
          <fieldset className="space-y-1">
            <legend className="mb-1 font-medium">Scopes</legend>
            <div className="grid gap-1 md:grid-cols-2">
              {API_KEY_SCOPES.map((s) => (
                <label key={s} className="flex items-start gap-2">
                  <input type="checkbox" className="mt-1" checked={scopes.includes(s)} onChange={() => toggle(s)} />
                  <span><code className="text-xs">{s}</code> <span className="text-muted-foreground">— {SCOPE_HINT[s]}</span></span>
                </label>
              ))}
            </div>
          </fieldset>
          <Button disabled={!canCreate || create.isPending} onClick={() => create.mutate()}>
            <KeyRound className="mr-1 h-4 w-4" />Create key
          </Button>
          <p className="text-xs text-muted-foreground">
            You will be asked to confirm it is you: a key keeps working after you sign out, so creating one needs a fresh
            sign-in. Scopes cannot be changed later — create a new key and revoke the old one. Revoking never asks.
          </p>
          {needsBusiness && !target && <p className="text-xs text-muted-foreground">Choose a business above first.</p>}
        </CardContent>
      </Card>

      <Card data-testid="apikey-list">
        <CardHeader><CardTitle className="text-sm">Keys</CardTitle></CardHeader>
        <CardContent className="text-sm">
          {isLoading && <p className="text-muted-foreground">Loading…</p>}
          {error && <p className="text-destructive">{apiError(error).message}</p>}
          {keys && keys.length === 0 && <p className="text-muted-foreground">No keys yet.</p>}
          {keys && keys.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="text-xs text-muted-foreground">
                  <tr><th className="py-2 pr-3">Name</th><th className="pr-3">Key</th><th className="pr-3">Scopes</th><th className="pr-3">Last used</th><th className="pr-3">Expires</th><th /></tr>
                </thead>
                <tbody>
                  {keys.map((k) => {
                    const expired = !!k.expiresAt && new Date(k.expiresAt) < new Date();
                    return (
                      <tr key={k.id} className="border-t align-top">
                        <td className="py-2 pr-3 font-medium">{k.name}
                          {k.revokedAt && <Badge variant="secondary" className="ml-2">revoked</Badge>}
                          {!k.revokedAt && expired && <Badge variant="secondary" className="ml-2">expired</Badge>}
                        </td>
                        <td className="pr-3"><code className="text-xs">{k.keyPrefix}…</code></td>
                        <td className="pr-3"><div className="flex flex-wrap gap-1">{k.scopes.map((s) => <Badge key={s} variant="outline" className="font-mono text-[10px]">{s}</Badge>)}</div></td>
                        <td className="pr-3 whitespace-nowrap">{fmt(k.lastUsedAt)}</td>
                        <td className="pr-3 whitespace-nowrap">{k.expiresAt ? fmt(k.expiresAt) : 'never'}</td>
                        <td className="text-right">
                          {!k.revokedAt && (
                            <Button size="sm" variant="ghost" disabled={revoke.isPending}
                              onClick={() => { if (window.confirm(`Revoke “${k.name}”? Anything using it stops working at once.`)) revoke.mutate(k.id); }}>
                              <Trash2 className="mr-1 h-4 w-4" />Revoke
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
    </div>
  );
}
