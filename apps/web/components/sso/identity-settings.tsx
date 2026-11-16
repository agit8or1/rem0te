'use client';

/**
 * 0.59 "Agit8or Identity P0": the parts of Settings → Single sign-on that
 * decide how far a provider is trusted, who must use it, and the break-glass
 * accounts that never depend on it. Every write goes through the API, which
 * checks it again (apps/api/src/sso/sso.service.ts settings(),
 * sso-identity.service.ts); the form only words the rules.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, KeyRound, Link2, LifeBuoy, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { ssoApi } from '@/lib/api-client';
import { errorMessage } from '@/lib/webauthn';
import { formatDate } from '@/lib/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';

export interface ProviderTrust {
  id: string; name: string;
  tokenAuth: 'client_secret_post' | 'private_key_jwt'; hasClientKey: boolean; clientKeyKid: string | null;
  clientPublicJwk: Record<string, unknown> | null; bindOrgId: string | null;
  acrLevels: { password: string | null; mfa: string | null; passkey: string | null };
  trustIdpMfa: boolean; trustIdpPasskey: boolean; allowPlatformAdmin: boolean;
  sessionCheckFailMode: 'open' | 'closed'; postLogoutRedirectUri: string | null;
  backchannelLogoutUri: string; jwksUri: string; defaultPostLogoutRedirectUri: string;
}

const selectClass = 'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm';
const nul = (s: string) => (s.trim() ? s.trim() : null);

function Check({ id, checked, onChange, children, hint }: { id: string; checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode; hint?: string }) {
  return (
    <label htmlFor={id} className="flex items-start gap-2 text-sm">
      <input id={id} type="checkbox" className="mt-1" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}{hint && <span className="block text-xs text-muted-foreground">{hint}</span>}</span>
    </label>
  );
}

/** Trust, token authentication, logout and the endpoints to register, for one provider. */
export function ProviderTrustSection({ provider }: { provider: ProviderTrust }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const initial = () => ({
    tokenAuth: provider.tokenAuth, bindOrgId: provider.bindOrgId ?? '',
    acrPassword: provider.acrLevels.password ?? '', acrMfa: provider.acrLevels.mfa ?? '', acrPasskey: provider.acrLevels.passkey ?? '',
    trustIdpMfa: provider.trustIdpMfa, trustIdpPasskey: provider.trustIdpPasskey, allowPlatformAdmin: provider.allowPlatformAdmin,
    sessionCheckFailMode: provider.sessionCheckFailMode, postLogoutRedirectUri: provider.postLogoutRedirectUri ?? '',
  });
  const [f, setF] = useState(initial);
  const [editing, setEditing] = useState(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (!editing) setF(initial()); }, [provider, editing]);
  const set = <K extends keyof ReturnType<typeof initial>>(k: K, v: ReturnType<typeof initial>[K]) => setF((x) => ({ ...x, [k]: v }));

  const save = useMutation({
    mutationFn: () => ssoApi.update(provider.id, {
      tokenAuth: f.tokenAuth, bindOrgId: nul(f.bindOrgId),
      acrPassword: nul(f.acrPassword), acrMfa: nul(f.acrMfa), acrPasskey: nul(f.acrPasskey),
      trustIdpMfa: f.trustIdpMfa, trustIdpPasskey: f.trustIdpPasskey, allowPlatformAdmin: f.allowPlatformAdmin,
      sessionCheckFailMode: f.sessionCheckFailMode, postLogoutRedirectUri: nul(f.postLogoutRedirectUri),
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sso-admin'] }); setEditing(false); toast({ title: 'Trust settings saved' }); },
    onError: (e: unknown) => toast({ title: 'Not saved', description: errorMessage(e), variant: 'destructive' }),
  });
  const genKey = useMutation({
    mutationFn: () => ssoApi.generateClientKey(provider.id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sso-admin'] }); toast({ title: 'Client key generated', description: 'Register its public key (or the JWKS URL) at the provider before switching to private_key_jwt.' }); },
    onError: (e: unknown) => toast({ title: 'No key generated', description: errorMessage(e), variant: 'destructive' }),
  });

  function downloadJwk() {
    if (!provider.clientPublicJwk) return;
    const blob = new Blob([JSON.stringify({ keys: [provider.clientPublicJwk] }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `rem0te-${provider.clientKeyKid?.slice(0, 8) ?? 'client'}-jwks.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const levels = provider.acrLevels;
  return (
    <div className="space-y-3 rounded-md border p-3" data-testid="sso-trust">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-medium"><ShieldCheck className="h-4 w-4" /> Trust and sign-out</p>
        {!editing && <Button variant="outline" size="sm" onClick={() => setEditing(true)}>Change</Button>}
      </div>

      {!editing ? (
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <div><dt className="text-xs text-muted-foreground">Token authentication</dt><dd>{provider.tokenAuth === 'private_key_jwt' ? 'private_key_jwt (signed assertion)' : 'Client secret'}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Organization</dt><dd>{provider.bindOrgId ?? 'Not bound'}</dd></div>
          <div><dt className="text-xs text-muted-foreground">acr values (password / MFA / passkey)</dt><dd>{levels.password ?? '—'} / {levels.mfa ?? '—'} / {levels.passkey ?? '—'}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Provider MFA counts here</dt><dd>{provider.trustIdpMfa ? 'Yes, when acr and amr both say so' : 'No — Rem0te asks its own second factor'}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Provider passkeys count as phishing-resistant</dt><dd>{provider.trustIdpPasskey ? 'Yes' : 'No'}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Platform Admins may use it</dt><dd>{provider.allowPlatformAdmin ? 'Yes, at the passkey level only' : 'No'}</dd></div>
          <div><dt className="text-xs text-muted-foreground">If the provider cannot be reached</dt><dd>{provider.sessionCheckFailMode === 'closed' ? 'Sessions end (fail closed)' : 'Sessions continue, an alert is raised (fail open)'}</dd></div>
          <div><dt className="text-xs text-muted-foreground">After sign-out at the provider</dt><dd className="break-all">{provider.postLogoutRedirectUri ?? provider.defaultPostLogoutRedirectUri}</dd></div>
        </dl>
      ) : (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor={`ta-${provider.id}`}>Token authentication</Label>
              <select id={`ta-${provider.id}`} className={selectClass} value={f.tokenAuth} onChange={(e) => set('tokenAuth', e.target.value as typeof f.tokenAuth)}>
                <option value="client_secret_post">Client secret</option>
                <option value="private_key_jwt" disabled={!provider.hasClientKey}>private_key_jwt{provider.hasClientKey ? '' : ' (generate a key first)'}</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`org-${provider.id}`}>Organization (optional)</Label>
              <Input id={`org-${provider.id}`} value={f.bindOrgId} onChange={(e) => set('bindOrgId', e.target.value)} placeholder="Keycloak organization alias or id" />
            </div>
            <div className="space-y-1"><Label htmlFor={`a1-${provider.id}`}>acr for password</Label><Input id={`a1-${provider.id}`} value={f.acrPassword} onChange={(e) => set('acrPassword', e.target.value)} placeholder="e.g. 1" /></div>
            <div className="space-y-1"><Label htmlFor={`a2-${provider.id}`}>acr for MFA</Label><Input id={`a2-${provider.id}`} value={f.acrMfa} onChange={(e) => set('acrMfa', e.target.value)} placeholder="e.g. 2" /></div>
            <div className="space-y-1"><Label htmlFor={`a3-${provider.id}`}>acr for passkey</Label><Input id={`a3-${provider.id}`} value={f.acrPasskey} onChange={(e) => set('acrPasskey', e.target.value)} placeholder="e.g. 3" /></div>
            <div className="space-y-1">
              <Label htmlFor={`fm-${provider.id}`}>If the provider cannot be reached</Label>
              <select id={`fm-${provider.id}`} className={selectClass} value={f.sessionCheckFailMode} onChange={(e) => set('sessionCheckFailMode', e.target.value as typeof f.sessionCheckFailMode)}>
                <option value="open">Keep sessions, raise an alert (fail open)</option>
                <option value="closed">End sessions (fail closed)</option>
              </select>
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor={`pl-${provider.id}`}>Post-logout redirect URI (optional)</Label>
              <Input id={`pl-${provider.id}`} value={f.postLogoutRedirectUri} onChange={(e) => set('postLogoutRedirectUri', e.target.value)} placeholder={provider.defaultPostLogoutRedirectUri} />
            </div>
          </div>
          <div className="space-y-2">
            <Check id={`tm-${provider.id}`} checked={f.trustIdpMfa} onChange={(v) => set('trustIdpMfa', v)}
              hint="Only when the token's acr is the MFA value and amr names a second factor. Needs the MFA acr.">
              Count the provider&apos;s MFA as Rem0te&apos;s second factor
            </Check>
            <Check id={`tp-${provider.id}`} checked={f.trustIdpPasskey} onChange={(v) => set('trustIdpPasskey', v)}
              hint="A step-up through the provider at the passkey level then satisfies actions that need a passkey. Needs the passkey acr.">
              Trust the provider&apos;s passkeys as phishing-resistant
            </Check>
            <Check id={`pa-${provider.id}`} checked={f.allowPlatformAdmin} onChange={(v) => set('allowPlatformAdmin', v)}
              hint="Off by default. When on, a Platform Admin is admitted only at the passkey level.">
              Let Platform Admins sign in through this provider
            </Check>
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={save.isPending}>Save</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </form>
      )}

      <div className="space-y-2 border-t pt-3 text-sm">
        <p className="flex items-center gap-2 font-medium"><KeyRound className="h-4 w-4" /> Client key for private_key_jwt</p>
        {provider.hasClientKey ? (
          <p className="text-muted-foreground">Key <code className="text-xs bg-muted rounded px-1 break-all">{provider.clientKeyKid}</code> (P-256). Only its public half leaves this server.</p>
        ) : (
          <p className="text-muted-foreground">No key yet. Generating one keeps the private key sealed here; the provider gets only the public key.</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => genKey.mutate()} disabled={genKey.isPending}>{provider.hasClientKey ? 'Replace key' : 'Generate key'}</Button>
          {provider.hasClientKey && <Button variant="outline" size="sm" onClick={downloadJwk}><Download className="h-4 w-4 mr-1" /> Download public JWKS</Button>}
        </div>
      </div>

      <div className="space-y-1 border-t pt-3 text-sm">
        <p className="font-medium">Register these at the provider</p>
        <p className="text-xs text-muted-foreground">Back-channel logout URL</p>
        <p className="break-all"><code className="text-xs">{provider.backchannelLogoutUri}</code></p>
        <p className="text-xs text-muted-foreground">JWKS URL (client authentication)</p>
        <p className="break-all"><code className="text-xs">{provider.jwksUri}</code></p>
        <p className="text-xs text-muted-foreground">Valid post-logout redirect URI</p>
        <p className="break-all"><code className="text-xs">{provider.postLogoutRedirectUri ?? provider.defaultPostLogoutRedirectUri}</code></p>
      </div>
    </div>
  );
}

// ─── Suggested links ─────────────────────────────────────────────────────────

interface Suggestion {
  id: string; email: string | null; createdAt: string; lastSeenAt: string;
  provider: { id: string; name: string }; user: { id: string; email: string; firstName: string; lastName: string };
}

export function LinkSuggestionsCard() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data = [] } = useQuery<Suggestion[]>({ queryKey: ['sso-suggestions'], queryFn: () => ssoApi.suggestions().then((r) => r.data?.data ?? []) });
  const done = () => { qc.invalidateQueries({ queryKey: ['sso-suggestions'] }); qc.invalidateQueries({ queryKey: ['sso-enforcement'] }); qc.invalidateQueries({ queryKey: ['sso-admin'] }); };
  const confirm = useMutation({
    mutationFn: (id: string) => ssoApi.confirmSuggestion(id),
    onSuccess: (r) => { done(); toast({ title: 'Linked', description: r.data?.data?.notified ? 'The account holder was emailed.' : 'No email was sent (no confirmed mail recipient for them).' }); },
    onError: (e: unknown) => toast({ title: 'Not linked', description: errorMessage(e), variant: 'destructive' }),
  });
  const dismiss = useMutation({
    mutationFn: (id: string) => ssoApi.dismissSuggestion(id),
    onSuccess: done,
    onError: (e: unknown) => toast({ title: 'Not dismissed', description: errorMessage(e), variant: 'destructive' }),
  });
  return (
    <Card data-testid="sso-suggestions">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base"><Link2 className="h-4 w-4" /> Suggested links</CardTitle>
        <CardDescription>
          Someone signed in at a provider with an unlinked identity whose verified email matches an account here. Nothing is linked
          until you confirm it. Platform Admin and break-glass accounts are never suggested.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? <p className="text-sm text-muted-foreground">No suggestions.</p> : (
          <ul className="divide-y text-sm">
            {data.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0">
                  <span className="font-medium">{`${s.user.firstName} ${s.user.lastName}`.trim() || s.user.email}</span>{' '}
                  <span className="text-muted-foreground break-all">{s.user.email}</span>
                  <span className="block text-xs text-muted-foreground">at {s.provider.name}, last seen {formatDate(s.lastSeenAt)}</span>
                </span>
                <span className="flex gap-2">
                  <Button size="sm" onClick={() => confirm.mutate(s.id)} disabled={confirm.isPending}>Link</Button>
                  <Button size="sm" variant="outline" onClick={() => dismiss.mutate(s.id)} disabled={dismiss.isPending}><X className="h-4 w-4" /></Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Enforcement and break-glass ─────────────────────────────────────────────

type Mode = 'off' | 'optional' | 'required';
interface Coverage { mode: Mode; total: number; linked: number; unlinked: number }
interface Enforcement {
  staff: Coverage;
  businesses: (Coverage & { id: string; name: string })[];
  breakGlass: { id: string; email: string; name: string; breakGlass: boolean; hasTotp: boolean; hasPasskey: boolean }[];
  enabledProviders: number;
}

function ModeRow({ scope, label, c, disabledReason }: { scope: string; label: string; c: Coverage; disabledReason?: string | null }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const set = useMutation({
    mutationFn: (m: Mode) => ssoApi.setMode(scope, m),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sso-enforcement'] }); toast({ title: `Sign-in mode for ${label} saved` }); },
    onError: (e: unknown) => toast({ title: 'Not changed', description: errorMessage(e), variant: 'destructive' }),
  });
  const canRequire = c.unlinked === 0 && !disabledReason;
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm" data-testid={`sso-mode-${scope}`}>
      <span className="min-w-0">
        <span className="font-medium">{label}</span>{' '}
        <span className="text-xs text-muted-foreground">
          {c.linked} of {c.total} linked{c.unlinked > 0 && <> · <span className="text-destructive">{c.unlinked} unlinked</span></>}
        </span>
      </span>
      <select aria-label={`Sign-in mode for ${label}`} className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        value={c.mode} disabled={set.isPending} onChange={(e) => set.mutate(e.target.value as Mode)}>
        <option value="off">Off</option>
        <option value="optional">Optional</option>
        <option value="required" disabled={!canRequire && c.mode !== 'required'}>
          Required{!canRequire && c.mode !== 'required' ? (disabledReason ? ` (${disabledReason})` : ` (${c.unlinked} unlinked)`) : ''}
        </option>
      </select>
    </li>
  );
}

export function EnforcementCard() {
  const { data } = useQuery<Enforcement>({ queryKey: ['sso-enforcement'], queryFn: () => ssoApi.enforcement().then((r) => r.data?.data) });
  if (!data) return null;
  const noProvider = data.enabledProviders === 0 ? 'no provider enabled' : null;
  const hasBreakGlass = data.breakGlass.some((b) => b.breakGlass);
  return (
    <Card data-testid="sso-enforcement">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base"><ShieldAlert className="h-4 w-4" /> Who must use single sign-on</CardTitle>
        <CardDescription>
          <strong>Required</strong> refuses password and passkey sign-in for accounts linked to a provider; it can be set only when every
          active account in scope is linked. <strong>Optional</strong> and <strong>Off</strong> sign in the same way. Break-glass accounts are
          always exempt. If the provider is down, lower it from the server:{' '}
          <code className="text-xs bg-muted rounded px-1">node dist/cli/auth-recovery.js --sso-mode optional &lt;business id | staff&gt; --yes</code>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          <ModeRow scope="staff" label="Staff (no business)" c={data.staff} disabledReason={noProvider ?? (hasBreakGlass ? null : 'needs a break-glass account')} />
          {data.businesses.map((b) => <ModeRow key={b.id} scope={b.id} label={b.name} c={b} disabledReason={noProvider} />)}
        </ul>
      </CardContent>
    </Card>
  );
}

export function BreakGlassCard() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data } = useQuery<Enforcement>({ queryKey: ['sso-enforcement'], queryFn: () => ssoApi.enforcement().then((r) => r.data?.data) });
  const set = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => ssoApi.setBreakGlass(id, on),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sso-enforcement'] }); qc.invalidateQueries({ queryKey: ['platform-admins'] }); toast({ title: 'Break-glass updated' }); },
    onError: (e: unknown) => toast({ title: 'Not changed', description: errorMessage(e), variant: 'destructive' }),
  });
  if (!data) return null;
  const count = data.breakGlass.filter((b) => b.breakGlass).length;
  return (
    <Card data-testid="sso-break-glass">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base"><LifeBuoy className="h-4 w-4" /> Break-glass accounts</CardTitle>
        <CardDescription>
          At most two Platform Admins that can always sign in with a password, an authenticator code and a passkey, even when single
          sign-on is required or the provider is down. Each needs both factors enrolled. Every use raises a security alert, emails the
          Platform Admins and is recorded in the audit log. See the break-glass runbook in Docs.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y text-sm">
          {data.breakGlass.map((u) => (
            <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="min-w-0">
                <span className="font-medium">{u.name || u.email}</span> <span className="text-muted-foreground break-all">{u.email}</span>{' '}
                {u.breakGlass && <Badge variant="warning">Break-glass</Badge>}
                <span className="block text-xs text-muted-foreground">
                  {u.hasTotp ? 'Authenticator' : 'No authenticator'} · {u.hasPasskey ? 'Passkey' : 'No passkey'}
                </span>
              </span>
              <Button size="sm" variant="outline" disabled={set.isPending || (!u.breakGlass && (count >= 2 || !u.hasTotp || !u.hasPasskey))}
                onClick={() => set.mutate({ id: u.id, on: !u.breakGlass })}>
                {u.breakGlass ? 'Clear' : 'Make break-glass'}
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
