'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ssoApi, businessesApi } from '@/lib/api-client';
import { usePermissions } from '@/lib/auth';
import { errorMessage } from '@/lib/webauthn';
import { formatDate } from '@/lib/utils';
import { PageHeader } from '@/components/common/page-header';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { CheckCircle, Info, KeyRound, Loader2, Plus, Trash2, XCircle } from 'lucide-react';

// ─── Shapes (apps/api/src/sso/sso.service.ts → view()) ───────────────────────

interface GroupMapping { id: string; groupValue: string; customerId: string; capabilities: string[] }
interface Provider {
  id: string; name: string; issuer: string; clientId: string; hasClientSecret: boolean;
  redirectUri: string; scopes: string; enabled: boolean; allowProvisioning: boolean;
  groupsClaim: string | null; groupMappings: GroupMapping[]; linkedAccounts: number;
  createdAt: string; updatedAt: string;
}
interface TestResult {
  ok: boolean; issuer?: string; authorizationEndpoint?: string; tokenEndpoint?: string; pkce?: boolean; error?: string;
}
interface CapabilityGroup { group: string; items: { key: string; label: string; description: string }[] }
interface Business { id: string; name: string }

const selectClass = 'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm';

// ─── Provider form ───────────────────────────────────────────────────────────

type SecretMode = 'keep' | 'replace' | 'clear';

interface FormState {
  name: string; issuer: string; clientId: string; clientSecret: string; secretMode: SecretMode;
  redirectUri: string; scopes: string; groupsClaim: string; allowProvisioning: boolean; enabled: boolean;
}

function ProviderDialog({
  open, onOpenChange, provider, suggestedRedirectUri,
}: {
  open: boolean; onOpenChange: (o: boolean) => void; provider: Provider | null; suggestedRedirectUri: string;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const editing = !!provider;
  const blank: FormState = {
    name: '', issuer: '', clientId: '', clientSecret: '', secretMode: 'replace',
    redirectUri: suggestedRedirectUri, scopes: 'openid email profile', groupsClaim: '',
    allowProvisioning: false, enabled: false,
  };
  const [form, setForm] = useState<FormState>(blank);
  const [error, setError] = useState('');
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    if (!open) return;
    setError('');
    setForm(provider ? {
      name: provider.name, issuer: provider.issuer, clientId: provider.clientId, clientSecret: '',
      secretMode: 'keep', redirectUri: provider.redirectUri, scopes: provider.scopes,
      groupsClaim: provider.groupsClaim ?? '', allowProvisioning: provider.allowProvisioning, enabled: provider.enabled,
    } : { ...blank, redirectUri: suggestedRedirectUri });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, provider, suggestedRedirectUri]);

  const save = useMutation({
    mutationFn: () => {
      if (editing && provider) {
        const data: Record<string, unknown> = {
          name: form.name, clientId: form.clientId, redirectUri: form.redirectUri, scopes: form.scopes,
          groupsClaim: form.groupsClaim.trim() || null,
          allowProvisioning: form.allowProvisioning, enabled: form.enabled,
        };
        if (form.secretMode === 'replace') data.clientSecret = form.clientSecret;
        if (form.secretMode === 'clear') data.clientSecret = null;
        return ssoApi.update(provider.id, data);
      }
      return ssoApi.create({
        name: form.name, issuer: form.issuer.trim(), clientId: form.clientId,
        ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}),
        redirectUri: form.redirectUri, scopes: form.scopes,
        ...(form.groupsClaim.trim() ? { groupsClaim: form.groupsClaim.trim() } : {}),
        allowProvisioning: form.allowProvisioning,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sso-admin'] });
      toast({ title: editing ? 'Provider saved' : 'Provider added', description: editing ? undefined : 'It is disabled until you enable it.' });
      onOpenChange(false);
    },
    onError: (e: unknown) => setError(errorMessage(e, 'Could not save the provider')),
  });

  const replaceNeedsValue = editing && form.secretMode === 'replace' && !form.clientSecret;
  const valid = form.name.trim() && form.issuer.trim() && form.clientId.trim() && form.redirectUri.trim() && !replaceNeedsValue;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${provider?.name}` : 'Add OpenID Connect provider'}</DialogTitle>
          <DialogDescription>
            Authorization code flow with PKCE. The provider must publish standard OpenID Connect discovery at
            {' '}<code className="text-xs">&lt;issuer&gt;/.well-known/openid-configuration</code>.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="sso-name">Name</Label>
            <Input id="sso-name" value={form.name} maxLength={80} onChange={(e) => set('name', e.target.value)}
              placeholder="Shown on the sign-in button, e.g. Company SSO" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="sso-issuer">Issuer</Label>
            <Input id="sso-issuer" value={form.issuer} readOnly={editing} disabled={editing}
              onChange={(e) => set('issuer', e.target.value)} placeholder="https://login.example.com/tenant" />
            <p className="text-xs text-muted-foreground">
              {editing
                ? 'The issuer cannot be changed: linked accounts are keyed by issuer. To use a different issuer, add a new provider.'
                : 'Must match the provider’s iss value exactly, and use https://. It cannot be changed after the provider is created.'}
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="sso-client">Client ID</Label>
            <Input id="sso-client" value={form.clientId} onChange={(e) => set('clientId', e.target.value)} />
          </div>

          <div className="space-y-1">
            <Label htmlFor="sso-secret">Client secret</Label>
            {editing && (
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className="text-muted-foreground">Currently {provider?.hasClientSecret ? 'set' : 'not set'}.</span>
                {(['keep', 'replace', 'clear'] as SecretMode[])
                  .filter((m) => m !== 'clear' || provider?.hasClientSecret)
                  .map((m) => (
                    <label key={m} className="flex items-center gap-1 cursor-pointer">
                      <input type="radio" name="secret-mode" checked={form.secretMode === m}
                        onChange={() => set('secretMode', m)} />
                      {m === 'keep' ? 'Keep' : m === 'replace' ? 'Replace' : 'Clear'}
                    </label>
                  ))}
              </div>
            )}
            {(!editing || form.secretMode === 'replace') && (
              <Input id="sso-secret" type="password" autoComplete="new-password" value={form.clientSecret}
                onChange={(e) => set('clientSecret', e.target.value)}
                placeholder={editing ? 'New client secret' : 'Leave empty for a public client (PKCE only)'} />
            )}
            <p className="text-xs text-muted-foreground">
              Stored encrypted and never shown again. {editing && form.secretMode === 'clear' && 'Clearing it makes this a public client (PKCE only).'}
            </p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="sso-redirect">Redirect URI</Label>
            <Input id="sso-redirect" value={form.redirectUri} onChange={(e) => set('redirectUri', e.target.value)} />
            <p className="text-xs text-muted-foreground">
              Register exactly this address at the provider. Suggested for this server: <code className="break-all">{suggestedRedirectUri}</code>
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="sso-scopes">Scopes</Label>
              <Input id="sso-scopes" value={form.scopes} onChange={(e) => set('scopes', e.target.value)} />
              <p className="text-xs text-muted-foreground">Space-separated. <code>openid</code> is always included.</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="sso-groups">Groups claim</Label>
              <Input id="sso-groups" value={form.groupsClaim} maxLength={64} onChange={(e) => set('groupsClaim', e.target.value)}
                placeholder="e.g. groups" />
              <p className="text-xs text-muted-foreground">ID-token claim holding group values. Only used for group mappings.</p>
            </div>
          </div>

          <label className="flex items-start gap-2 cursor-pointer text-sm">
            <input type="checkbox" className="mt-1" checked={form.allowProvisioning}
              onChange={(e) => set('allowProvisioning', e.target.checked)} />
            <span>
              <span className="font-medium">Allow provisioning</span>
              <span className="block text-xs text-muted-foreground">
                Create a new account when someone with no linked account signs in with a verified email that no existing
                account uses. The new account has no access unless a group mapping below grants it a business.
              </span>
            </span>
          </label>

          {editing ? (
            <label className="flex items-start gap-2 cursor-pointer text-sm">
              <input type="checkbox" className="mt-1" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
              <span>
                <span className="font-medium">Enabled</span>
                <span className="block text-xs text-muted-foreground">Shows the provider on the sign-in page.</span>
              </span>
            </label>
          ) : (
            <p className="text-xs text-muted-foreground">
              New providers are always created disabled. Run Test discovery, then enable it.
            </p>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={!valid || save.isPending}>
            {save.isPending ? 'Saving…' : editing ? 'Save' : 'Add provider'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Group mappings ──────────────────────────────────────────────────────────

function GroupMappings({
  provider, businesses, catalog,
}: { provider: Provider; businesses: Business[]; catalog: CapabilityGroup[] }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [groupValue, setGroupValue] = useState('');
  const [businessId, setBusinessId] = useState('');
  const [caps, setCaps] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState<GroupMapping | null>(null);

  const bizName = (id: string) => businesses.find((b) => b.id === id)?.name ?? id;
  const capLabel = (k: string) => catalog.flatMap((g) => g.items).find((i) => i.key === k)?.label ?? k;

  const add = useMutation({
    mutationFn: () => ssoApi.addMapping(provider.id, { groupValue: groupValue.trim(), businessId, capabilities: caps }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sso-admin'] });
      setAdding(false); setGroupValue(''); setBusinessId(''); setCaps([]); setError('');
      toast({ title: 'Group mapping added' });
    },
    onError: (e: unknown) => setError(errorMessage(e, 'Could not add the mapping')),
  });
  const remove = useMutation({
    mutationFn: (id: string) => ssoApi.removeMapping(provider.id, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sso-admin'] });
      setRemoving(null);
      toast({ title: 'Group mapping removed' });
    },
    onError: (e: unknown) => toast({ title: 'Could not remove mapping', description: errorMessage(e), variant: 'destructive' }),
  });

  const toggle = (k: string) => setCaps((c) => (c.includes(k) ? c.filter((x) => x !== k) : [...c, k]));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Group mappings</p>
        {!adding && (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4 mr-1" /> Add mapping
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Used only when provisioning creates a new account. If the account&apos;s groups claim contains a mapped value,
        the account is made a Business User of that one business with exactly the permissions listed (the first
        mapping that matches wins). Existing accounts are never changed.
        {!provider.groupsClaim && ' No groups claim is configured for this provider, so these mappings cannot match yet.'}
        {!provider.allowProvisioning && ' Provisioning is off for this provider, so these mappings are not used.'}
      </p>

      {provider.groupMappings.length === 0 ? (
        <p className="text-sm text-muted-foreground">No group mappings.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {provider.groupMappings.map((m) => (
            <li key={m.id} className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
              <div className="min-w-0">
                <p><code className="bg-muted rounded px-1">{m.groupValue}</code> → <span className="font-medium">{bizName(m.customerId)}</span></p>
                <p className="text-xs text-muted-foreground">
                  {m.capabilities.length ? m.capabilities.map(capLabel).join(', ') : 'No permissions (membership only)'}
                </p>
              </div>
              <Button variant="ghost" size="sm" aria-label="Remove mapping" onClick={() => setRemoving(m)}>
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <div className="space-y-3 rounded-md border bg-muted/30 p-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Group value</Label>
              <Input value={groupValue} maxLength={256} onChange={(e) => setGroupValue(e.target.value)} placeholder="Exact value from the claim" />
            </div>
            <div className="space-y-1">
              <Label>Business</Label>
              <select className={selectClass} value={businessId} onChange={(e) => setBusinessId(e.target.value)}>
                <option value="">Select a business…</option>
                {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
          </div>
          <div className="space-y-2">
            <Label>Permissions</Label>
            {catalog.map((g) => (
              <div key={g.group}>
                <p className="text-xs font-medium text-muted-foreground mb-1">{g.group}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                  {g.items.map((i) => (
                    <label key={i.key} className="flex items-center gap-2 text-sm cursor-pointer" title={i.description}>
                      <input type="checkbox" checked={caps.includes(i.key)} onChange={() => toggle(i.key)} />
                      {i.label}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => { setAdding(false); setError(''); }}>Cancel</Button>
            <Button size="sm" onClick={() => add.mutate()} disabled={!groupValue.trim() || !businessId || add.isPending}>
              {add.isPending ? 'Adding…' : 'Add mapping'}
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => { if (!o) setRemoving(null); }}
        title="Remove group mapping?"
        description={`New accounts in group “${removing?.groupValue ?? ''}” will no longer be given access to ${removing ? bizName(removing.customerId) : ''}. Accounts already provisioned keep their membership.`}
        confirmLabel="Remove"
        destructive
        loading={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing.id)}
      />
    </div>
  );
}

// ─── Provider card ───────────────────────────────────────────────────────────

function ProviderCard({
  provider, onEdit, businesses, catalog,
}: { provider: Provider; onEdit: () => void; businesses: Business[]; catalog: CapabilityGroup[] }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [test, setTest] = useState<TestResult | null>(null);
  const [deleting, setDeleting] = useState(false);

  const runTest = useMutation({
    mutationFn: () => ssoApi.test(provider.id).then((r) => r.data?.data as TestResult),
    onSuccess: (r) => setTest(r),
    onError: (e: unknown) => setTest({ ok: false, error: errorMessage(e, 'The test request failed') }),
  });
  const toggle = useMutation({
    mutationFn: () => ssoApi.update(provider.id, { enabled: !provider.enabled }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sso-admin'] });
      toast({ title: provider.enabled ? 'Provider disabled' : 'Provider enabled' });
    },
    onError: (e: unknown) => toast({ title: 'Could not change provider', description: errorMessage(e), variant: 'destructive' }),
  });
  const del = useMutation({
    mutationFn: () => ssoApi.remove(provider.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sso-admin'] });
      setDeleting(false);
      toast({ title: 'Provider deleted' });
    },
    onError: (e: unknown) => toast({ title: 'Could not delete provider', description: errorMessage(e), variant: 'destructive' }),
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              <KeyRound className="h-4 w-4" /> {provider.name}
              {provider.enabled ? <Badge variant="success">Enabled</Badge> : <Badge variant="secondary">Disabled</Badge>}
              {provider.allowProvisioning && <Badge variant="warning">Provisioning on</Badge>}
            </CardTitle>
            <CardDescription className="break-all mt-1">{provider.issuer}</CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => runTest.mutate()} disabled={runTest.isPending}>
              {runTest.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />} Test discovery
            </Button>
            <Button variant="outline" size="sm" onClick={() => toggle.mutate()} disabled={toggle.isPending}>
              {provider.enabled ? 'Disable' : 'Enable'}
            </Button>
            <Button variant="outline" size="sm" onClick={onEdit}>Edit</Button>
            <Button variant="outline" size="sm" className="text-destructive border-destructive/40 hover:bg-destructive/5"
              onClick={() => setDeleting(true)}>
              Delete
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <div><dt className="text-xs text-muted-foreground">Client ID</dt><dd className="break-all">{provider.clientId}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Client secret</dt><dd>{provider.hasClientSecret ? 'Set' : 'Not set (public client)'}</dd></div>
          <div className="sm:col-span-2"><dt className="text-xs text-muted-foreground">Redirect URI</dt><dd className="break-all">{provider.redirectUri}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Scopes</dt><dd>{provider.scopes}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Groups claim</dt><dd>{provider.groupsClaim ?? '—'}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Linked accounts</dt><dd>{provider.linkedAccounts}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Last changed</dt><dd>{formatDate(provider.updatedAt)}</dd></div>
        </dl>

        {test && (
          <div className={test.ok
            ? 'rounded-md border border-green-300 bg-green-50 p-3 text-sm text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200'
            : 'rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive'}>
            {test.ok ? (
              <div className="space-y-1">
                <p className="flex items-center gap-2 font-medium"><CheckCircle className="h-4 w-4" /> Discovery succeeded</p>
                <p className="break-all">Issuer: {test.issuer}</p>
                <p className="break-all">Authorization endpoint: {test.authorizationEndpoint}</p>
                <p className="break-all">Token endpoint: {test.tokenEndpoint}</p>
                <p>PKCE (S256) advertised: {test.pkce ? 'yes' : 'no — sign-in may fail if the provider does not accept PKCE'}</p>
                <p className="text-xs opacity-80">This only checks discovery. It does not sign anyone in; try a real sign-in before relying on it.</p>
              </div>
            ) : (
              <p className="flex items-start gap-2"><XCircle className="h-4 w-4 mt-0.5 shrink-0" /> Discovery failed: {test.error}</p>
            )}
          </div>
        )}

        <GroupMappings provider={provider} businesses={businesses} catalog={catalog} />
      </CardContent>

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${provider.name}?`}
        description={`This removes the provider, its group mappings and ${provider.linkedAccounts} linked identit${provider.linkedAccounts === 1 ? 'y' : 'ies'}. Those people can still sign in with their password or a passkey. Provisioned accounts that have no password will need a password reset.`}
        confirmLabel="Delete"
        destructive
        loading={del.isPending}
        onConfirm={() => del.mutate()}
      />
    </Card>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function SsoAdminPage() {
  const router = useRouter();
  const { isPlatformAdmin, isLoading: authLoading } = usePermissions();
  const allowed = authLoading || isPlatformAdmin;
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Provider | null>(null);

  // Hooks run on every render; the queries are gated instead of returning early.
  const { data, isLoading } = useQuery<{ providers: Provider[]; suggestedRedirectUri: string }>({
    queryKey: ['sso-admin'],
    queryFn: () => ssoApi.adminList().then((r) => r.data?.data),
    enabled: isPlatformAdmin,
  });
  const { data: businessesData } = useQuery({
    queryKey: ['businesses', ''],
    queryFn: () => businessesApi.list().then((r) => r.data?.data ?? []),
    enabled: isPlatformAdmin,
  });
  const { data: catalog = [] } = useQuery<CapabilityGroup[]>({
    queryKey: ['capability-catalog'],
    queryFn: () => businessesApi.capabilityCatalog().then((r) => r.data?.data ?? []),
    enabled: isPlatformAdmin,
  });

  useEffect(() => {
    if (!authLoading && !isPlatformAdmin) router.push('/dashboard');
  }, [authLoading, isPlatformAdmin, router]);

  if (!allowed) return null;

  const providers = data?.providers ?? [];
  const businesses: Business[] = Array.isArray(businessesData) ? businessesData : [];
  const suggested = data?.suggestedRedirectUri ?? '';

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <PageHeader
        title="Single sign-on"
        description="OpenID Connect sign-in providers. Platform Admins only."
        actions={
          <Button onClick={() => { setEditing(null); setDialogOpen(true); }}>
            <Plus className="h-4 w-4 mr-1" /> Add provider
          </Button>
        }
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><Info className="h-4 w-4" /> How sign-in with a provider works here</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
            <li>
              An account is matched by the provider&apos;s issuer and subject only — <strong className="text-foreground">never by email address</strong>.
              People link a provider to their existing account from My Account, after signing in normally.
            </li>
            <li>
              With provisioning on, someone with no linked account gets a new account — only if the provider supplies a
              verified email that no existing account uses. That account has <strong className="text-foreground">no access</strong> unless
              a group mapping grants it membership in exactly one business.
            </li>
            <li>Password sign-in always remains available, whatever is configured here. Two-factor rules still apply to SSO sign-ins.</li>
            <li>
              If a provider misbehaves, disable every provider from the server, in the API directory:
              {' '}<code className="text-xs bg-muted rounded px-1">node dist/cli/auth-recovery.js --disable-sso --yes</code>
            </li>
            <li>Tested against a standards-compliant OpenID Connect provider; no provider-specific behaviour is assumed.</li>
          </ul>
        </CardContent>
      </Card>

      {isLoading || authLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : providers.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No providers configured. Sign-in uses passwords (and passkeys) only.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {providers.map((p) => (
            <ProviderCard
              key={p.id}
              provider={p}
              businesses={businesses}
              catalog={catalog}
              onEdit={() => { setEditing(p); setDialogOpen(true); }}
            />
          ))}
        </div>
      )}

      <ProviderDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        provider={editing}
        suggestedRedirectUri={suggested}
      />
    </div>
  );
}
