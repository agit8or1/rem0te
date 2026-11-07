'use client';

import { Suspense, useState, useEffect, useSyncExternalStore } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { authApi, mfaApi, passkeysApi, ssoApi } from '@/lib/api-client';
import { createPasskey, passkeysSupported, errorMessage } from '@/lib/webauthn';
import { ssoErrorMessage } from '@/lib/sso-errors';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { formatDate } from '@/lib/utils';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { ShieldCheck, ShieldOff, KeyRound, User, Copy, Check, Fingerprint, Link2, CheckCircle2, AlertTriangle, X } from 'lucide-react';
import Image from 'next/image';

// ─── Profile Tab ────────────────────────────────────────────────────────────

function ProfileTab() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: me } = useQuery({ queryKey: ['me'], queryFn: () => authApi.me().then(r => r.data?.data) });
  const { data: profile } = useQuery({
    queryKey: ['auth-profile'],
    queryFn: () => authApi.profile().then(r => r.data?.data),
  });

  type ProfileForm = {
    firstName: string; lastName: string; email: string;
    phone: string; jobTitle: string;
    address: string; city: string; state: string; country: string; postalCode: string;
    timeZone: string;
  };
  const empty: ProfileForm = {
    firstName: '', lastName: '', email: '', phone: '', jobTitle: '',
    address: '', city: '', state: '', country: '', postalCode: '', timeZone: '',
  };
  const [form, setForm] = useState<ProfileForm>(empty);
  const [loaded, setLoaded] = useState(false);
  // Changing the address a password reset goes to needs the password.
  const [currentPassword, setCurrentPassword] = useState('');
  const savedEmail = (profile as { email?: string } | undefined)?.email ?? '';
  const emailChanged = loaded && form.email.trim().toLowerCase() !== savedEmail.toLowerCase();
  const set = <K extends keyof ProfileForm>(k: K, v: ProfileForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    if (profile && !loaded) {
      const p = profile as Partial<ProfileForm>;
      setForm({
        firstName:  p.firstName  ?? '',
        lastName:   p.lastName   ?? '',
        email:      p.email      ?? '',
        phone:      p.phone      ?? '',
        jobTitle:   p.jobTitle   ?? '',
        address:    p.address    ?? '',
        city:       p.city       ?? '',
        state:      p.state      ?? '',
        country:    p.country    ?? '',
        postalCode: p.postalCode ?? '',
        timeZone:   p.timeZone   ?? '',
      });
      setLoaded(true);
    }
  }, [profile, loaded]);

  const mutation = useMutation({
    mutationFn: () => authApi.updateProfile(emailChanged ? { ...form, currentPassword } : form),
    onSuccess: () => {
      setCurrentPassword('');
      toast({ title: 'Profile updated' });
      qc.invalidateQueries({ queryKey: ['auth-profile'] });
      qc.invalidateQueries({ queryKey: ['members'] });
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Update failed';
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><User className="h-4 w-4" /> Profile</CardTitle>
        <CardDescription>Contact information and mailing address for this user.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 max-w-2xl">
        <div>
          <p className="text-sm font-medium mb-2">Identity</p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>First Name</Label>
              <Input value={form.firstName} onChange={e => set('firstName', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Last Name</Label>
              <Input value={form.lastName} onChange={e => set('lastName', e.target.value)} />
            </div>
            <div className="space-y-1 col-span-2">
              <Label>Email</Label>
              <Input type="email" value={form.email} onChange={e => set('email', e.target.value)} />
            </div>
            {emailChanged && (
              <div className="space-y-1 col-span-2">
                <Label>Current password</Label>
                <Input
                  type="password" autoComplete="current-password" value={currentPassword}
                  onChange={e => setCurrentPassword(e.target.value)}
                  placeholder="Required to change your email address"
                />
              </div>
            )}
            <div className="space-y-1">
              <Label>Phone</Label>
              <Input value={form.phone} onChange={e => set('phone', e.target.value)} placeholder="+1 555 555 0100" />
            </div>
            <div className="space-y-1">
              <Label>Job Title</Label>
              <Input value={form.jobTitle} onChange={e => set('jobTitle', e.target.value)} placeholder="e.g. Support Technician" />
            </div>
          </div>
        </div>
        <div>
          <p className="text-sm font-medium mb-2">Mailing Address</p>
          <div className="grid grid-cols-6 gap-3">
            <div className="space-y-1 col-span-6">
              <Label>Street</Label>
              <Input value={form.address} onChange={e => set('address', e.target.value)} placeholder="123 Main St" />
            </div>
            <div className="space-y-1 col-span-2">
              <Label>City</Label>
              <Input value={form.city} onChange={e => set('city', e.target.value)} />
            </div>
            <div className="space-y-1 col-span-2">
              <Label>State / Region</Label>
              <Input value={form.state} onChange={e => set('state', e.target.value)} />
            </div>
            <div className="space-y-1 col-span-2">
              <Label>Postal Code</Label>
              <Input value={form.postalCode} onChange={e => set('postalCode', e.target.value)} />
            </div>
            <div className="space-y-1 col-span-3">
              <Label>Country</Label>
              <Input value={form.country} onChange={e => set('country', e.target.value)} />
            </div>
            <div className="space-y-1 col-span-3">
              <Label>Time Zone</Label>
              <Input value={form.timeZone} onChange={e => set('timeZone', e.target.value)} placeholder="America/New_York" />
            </div>
          </div>
        </div>
        <div className="text-xs text-muted-foreground">
          Role: <span className="font-medium">{me?.roleType ?? '—'}</span>
          {me?.isPlatformAdmin && <span className="ml-2 text-orange-600 font-medium">Platform Admin</span>}
        </div>
        <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
          {mutation.isPending ? 'Saving…' : 'Save Changes'}
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Password Tab ────────────────────────────────────────────────────────────

function PasswordTab() {
  const { toast } = useToast();
  const [current, setCurrent]   = useState('');
  const [next,    setNext]      = useState('');
  const [confirm, setConfirm]   = useState('');

  const mutation = useMutation({
    mutationFn: () => authApi.changePassword(current, next),
    onSuccess: () => {
      toast({ title: 'Password changed' });
      setCurrent(''); setNext(''); setConfirm('');
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Failed to change password';
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  const mismatch = next !== confirm && confirm.length > 0;
  const valid = current.length > 0 && next.length >= 8 && next === confirm;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><KeyRound className="h-4 w-4" /> Change Password</CardTitle>
        <CardDescription>You must enter your current password to set a new one.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 max-w-md">
        <div className="space-y-1">
          <Label>Current Password</Label>
          <Input type="password" value={current} onChange={e => setCurrent(e.target.value)} autoComplete="current-password" />
        </div>
        <div className="space-y-1">
          <Label>New Password</Label>
          <Input type="password" value={next} onChange={e => setNext(e.target.value)} autoComplete="new-password" placeholder="Minimum 8 characters" />
        </div>
        <div className="space-y-1">
          <Label>Confirm New Password</Label>
          <Input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="new-password" />
          {mismatch && <p className="text-xs text-destructive">Passwords do not match</p>}
        </div>
        <Button onClick={() => mutation.mutate()} disabled={!valid || mutation.isPending}>
          {mutation.isPending ? 'Changing…' : 'Change Password'}
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── MFA Tab ─────────────────────────────────────────────────────────────────

function MfaTab() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: status, isLoading } = useQuery({
    queryKey: ['mfa-status'],
    queryFn: () => mfaApi.status().then(r => r.data?.data),
  });

  const [setupData, setSetupData]     = useState<{ qrCodeUrl: string; secret: string; recoveryCodes?: string[] } | null>(null);
  const [setupCode, setSetupCode]     = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [showDisable, setShowDisable] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  const mfaEnabled: boolean = status?.enrolled ?? false;

  const beginEnroll = useMutation({
    mutationFn: () => mfaApi.beginEnroll(),
    onSuccess: (res) => setSetupData(res.data?.data),
    onError: () => toast({ title: 'Failed to start MFA setup', variant: 'destructive' }),
  });

  const confirmEnroll = useMutation({
    mutationFn: () => mfaApi.confirmEnroll(setupCode),
    onSuccess: (res) => {
      const codes: string[] = res.data?.data?.recoveryCodes ?? [];
      setRecoveryCodes(codes);
      setSetupData(null);
      setSetupCode('');
      qc.invalidateQueries({ queryKey: ['mfa-status'] });
      toast({ title: 'Two-factor authentication enabled' });
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Invalid code';
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  const disableMutation = useMutation({
    mutationFn: () => mfaApi.disable(disableCode),
    onSuccess: () => {
      setShowDisable(false); setDisableCode('');
      // Turning 2FA off ends every session on the account, this one included.
      toast({ title: 'Two-factor authentication disabled', description: 'Sign in again to continue.' });
      setTimeout(() => { window.location.href = '/login'; }, 1200);
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Invalid code';
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  function copyCode(code: string, idx: number) {
    navigator.clipboard.writeText(code);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 2000);
  }

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  // Recovery codes display after enrollment
  if (recoveryCodes) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-green-600"><ShieldCheck className="h-4 w-4" /> 2FA Enabled — Save Your Recovery Codes</CardTitle>
          <CardDescription>
            These codes can be used to access your account if you lose your authenticator. Each code can only be used once. Store them somewhere safe.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-2 font-mono text-sm">
            {recoveryCodes.map((code, i) => (
              <div key={i} className="flex items-center justify-between bg-muted rounded px-3 py-1.5">
                <span className="tracking-wider">{code}</span>
                <button onClick={() => copyCode(code, i)} className="ml-2 text-muted-foreground hover:text-foreground">
                  {copiedIdx === i ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3" />}
                </button>
              </div>
            ))}
          </div>
          <Button onClick={() => setRecoveryCodes(null)}>Done</Button>
        </CardContent>
      </Card>
    );
  }

  // Setup flow
  if (setupData) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Set Up Authenticator App</CardTitle>
          <CardDescription>Scan the QR code with your authenticator app (Google Authenticator, Authy, etc.), then enter the 6-digit code to confirm.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 max-w-sm">
          {setupData.qrCodeUrl && (
            <div className="flex justify-center">
              <Image src={setupData.qrCodeUrl} alt="TOTP QR Code" width={180} height={180} className="rounded border" />
            </div>
          )}
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Or enter manually:</Label>
            <code className="block text-xs bg-muted px-2 py-1.5 rounded break-all">{setupData.secret}</code>
          </div>
          <div className="space-y-1">
            <Label>Verification Code</Label>
            <Input
              maxLength={6}
              value={setupCode}
              onChange={e => setSetupCode(e.target.value.replace(/\D/g, ''))}
              placeholder="000000"
              className="font-mono tracking-widest text-center text-lg"
            />
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setSetupData(null)}>Cancel</Button>
            <Button
              onClick={() => confirmEnroll.mutate()}
              disabled={setupCode.length !== 6 || confirmEnroll.isPending}>
              {confirmEnroll.isPending ? 'Verifying…' : 'Enable 2FA'}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Current status
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {mfaEnabled
            ? <><ShieldCheck className="h-4 w-4 text-green-600" /> Two-Factor Authentication</>
            : <><ShieldOff className="h-4 w-4 text-muted-foreground" /> Two-Factor Authentication</>}
        </CardTitle>
        <CardDescription>
          {mfaEnabled
            ? 'Your account is protected with an authenticator app.'
            : 'Add an extra layer of security to your account.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {mfaEnabled ? (
          <>
            <div className="flex items-center gap-2 text-sm text-green-600 font-medium">
              <ShieldCheck className="h-4 w-4" /> 2FA is active
            </div>
            {!showDisable ? (
              <Button variant="outline" className="text-destructive border-destructive/40 hover:bg-destructive/5"
                onClick={() => setShowDisable(true)}>
                Disable 2FA
              </Button>
            ) : (
              <div className="space-y-3 p-3 border rounded bg-muted/30">
                <p className="text-sm font-medium">Enter your authenticator code to disable 2FA:</p>
                <Input
                  maxLength={6}
                  value={disableCode}
                  onChange={e => setDisableCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="000000"
                  className="font-mono tracking-widest text-center text-lg max-w-[140px]"
                />
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => { setShowDisable(false); setDisableCode(''); }}>Cancel</Button>
                  <Button variant="destructive" size="sm"
                    onClick={() => disableMutation.mutate()}
                    disabled={disableCode.length !== 6 || disableMutation.isPending}>
                    {disableMutation.isPending ? 'Disabling…' : 'Confirm Disable'}
                  </Button>
                </div>
              </div>
            )}
          </>
        ) : (
          <Button onClick={() => beginEnroll.mutate()} disabled={beginEnroll.isPending}>
            {beginEnroll.isPending ? 'Starting…' : 'Enable 2FA'}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Passkeys Tab ────────────────────────────────────────────────────────────

interface PasskeyRow { id: string; name: string | null; createdAt: string; lastUsedAt: string | null }

const noSubscribe = () => () => {};

function PasskeysTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  // false on the server and the first client render, so hydration matches.
  const supported = useSyncExternalStore(noSubscribe, passkeysSupported, () => false);
  const [name, setName] = useState('');
  const [removing, setRemoving] = useState<PasskeyRow | null>(null);

  const { data: passkeys = [], isLoading } = useQuery<PasskeyRow[]>({
    queryKey: ['passkeys'],
    queryFn: () => passkeysApi.list().then((r) => r.data?.data ?? []),
  });

  const add = useMutation({
    mutationFn: async () => {
      const opts = (await passkeysApi.registerOptions()).data?.data;
      const response = await createPasskey(opts);
      return passkeysApi.register(response, name.trim() || undefined);
    },
    onSuccess: () => {
      setName('');
      qc.invalidateQueries({ queryKey: ['passkeys'] });
      toast({ title: 'Passkey added' });
    },
    onError: (e: unknown) => toast({ title: 'Passkey not added', description: errorMessage(e), variant: 'destructive' }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => passkeysApi.remove(id),
    onSuccess: () => {
      setRemoving(null);
      qc.invalidateQueries({ queryKey: ['passkeys'] });
      toast({ title: 'Passkey removed' });
    },
    onError: (e: unknown) => toast({ title: 'Could not remove passkey', description: errorMessage(e), variant: 'destructive' }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Fingerprint className="h-4 w-4" /> Passkeys</CardTitle>
        <CardDescription>
          Sign in with your device&apos;s fingerprint, face, PIN or a security key instead of a password.
          A passkey that verifies you counts as two-factor authentication. Your password keeps working.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : passkeys.length === 0 ? (
          <p className="text-sm text-muted-foreground">You have no passkeys.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {passkeys.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{p.name || 'Unnamed passkey'}</p>
                  <p className="text-xs text-muted-foreground">
                    Added {formatDate(p.createdAt)} · {p.lastUsedAt ? `last used ${formatDate(p.lastUsedAt)}` : 'never used'}
                  </p>
                </div>
                <Button variant="outline" size="sm" className="text-destructive border-destructive/40 hover:bg-destructive/5"
                  onClick={() => setRemoving(p)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}

        {supported ? (
          <div className="flex flex-wrap items-end gap-2 max-w-md">
            <div className="space-y-1 flex-1 min-w-[180px]">
              <Label htmlFor="passkey-name">Name (optional)</Label>
              <Input id="passkey-name" value={name} maxLength={60} placeholder="e.g. Work laptop"
                onChange={(e) => setName(e.target.value)} />
            </div>
            <Button onClick={() => add.mutate()} disabled={add.isPending}>
              {add.isPending ? 'Waiting for passkey…' : 'Add passkey'}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            This browser does not support passkeys, so one cannot be added here. Try a current version of Chrome, Edge, Firefox or Safari.
          </p>
        )}
      </CardContent>

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => { if (!o) setRemoving(null); }}
        title="Remove passkey?"
        description={`“${removing?.name || 'Unnamed passkey'}” will no longer sign you in. You can still sign in with your password.`}
        confirmLabel="Remove"
        destructive
        loading={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing.id)}
      />
    </Card>
  );
}

// ─── Single sign-on Tab ──────────────────────────────────────────────────────

interface IdentityRow {
  id: string; email: string | null; linkedAt: string; lastLoginAt: string | null;
  provider: { id: string; name: string; enabled: boolean };
}

function SsoTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [unlinking, setUnlinking] = useState<IdentityRow | null>(null);
  const [linkingId, setLinkingId] = useState<string | null>(null);

  const { data: identities = [], isLoading } = useQuery<IdentityRow[]>({
    queryKey: ['sso-identities'],
    queryFn: () => ssoApi.identities().then((r) => r.data?.data ?? []),
  });
  const { data: providers = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['sso-providers-public'],
    queryFn: () => ssoApi.providers().then((r) => r.data?.data ?? []),
  });

  const linkedProviderIds = new Set(identities.map((i) => i.provider.id));
  const linkable = providers.filter((p) => !linkedProviderIds.has(p.id));

  async function link(id: string) {
    setLinkingId(id);
    try {
      const res = await ssoApi.link(id, '/account');
      const url = res.data?.data?.url;
      if (!url) throw new Error('The server did not return a sign-in address');
      window.location.href = url;
    } catch (e) {
      setLinkingId(null);
      toast({ title: 'Could not start linking', description: errorMessage(e), variant: 'destructive' });
    }
  }

  const unlink = useMutation({
    mutationFn: (id: string) => ssoApi.unlink(id),
    onSuccess: () => {
      setUnlinking(null);
      qc.invalidateQueries({ queryKey: ['sso-identities'] });
      toast({ title: 'Identity unlinked' });
    },
    onError: (e: unknown) => toast({ title: 'Could not unlink', description: errorMessage(e), variant: 'destructive' }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Link2 className="h-4 w-4" /> Single sign-on</CardTitle>
        <CardDescription>
          Link an identity from your organisation&apos;s sign-in provider so you can use it here.
          The link is made only by signing in at the provider from this page — never by matching email addresses.
          Your password keeps working either way.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : identities.length === 0 ? (
          <p className="text-sm text-muted-foreground">No identities are linked to your account.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {identities.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">
                    {i.provider.name}
                    {!i.provider.enabled && <span className="ml-2 text-xs font-normal text-muted-foreground">(provider currently disabled)</span>}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {i.email ? `${i.email} · ` : ''}Linked {formatDate(i.linkedAt)} · {i.lastLoginAt ? `last sign-in ${formatDate(i.lastLoginAt)}` : 'not used to sign in yet'}
                  </p>
                </div>
                <Button variant="outline" size="sm" className="text-destructive border-destructive/40 hover:bg-destructive/5"
                  onClick={() => setUnlinking(i)}>
                  Unlink
                </Button>
              </li>
            ))}
          </ul>
        )}

        {linkable.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {linkable.map((p) => (
              <Button key={p.id} variant="outline" onClick={() => link(p.id)} disabled={linkingId !== null}>
                <Link2 className="h-4 w-4 mr-2" />
                {linkingId === p.id ? 'Redirecting…' : `Link ${p.name}`}
              </Button>
            ))}
          </div>
        )}
        {providers.length === 0 && (
          <p className="text-sm text-muted-foreground">No sign-in providers are enabled on this server.</p>
        )}
      </CardContent>

      <ConfirmDialog
        open={!!unlinking}
        onOpenChange={(o) => { if (!o) setUnlinking(null); }}
        title="Unlink identity?"
        description={`You will no longer be able to sign in with ${unlinking?.provider.name ?? 'this provider'} until you link it again. Your password and passkeys are not affected.`}
        confirmLabel="Unlink"
        destructive
        loading={unlink.isPending}
        onConfirm={() => unlinking && unlink.mutate(unlinking.id)}
      />
    </Card>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

function AccountTabs() {
  const params = useSearchParams();
  const router = useRouter();
  const linked = params.get('sso') === 'linked';
  const ssoError = ssoErrorMessage(params.get('sso_error'));
  const dismiss = () => router.replace('/account');

  return (
    <>
      {linked && (
        <div role="status" className="flex items-start gap-2 rounded-md border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200">
          <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
          <span className="flex-1">The identity was linked to your account. You can now sign in with that provider.</span>
          <button onClick={dismiss} aria-label="Dismiss" className="opacity-70 hover:opacity-100"><X className="h-4 w-4" /></button>
        </div>
      )}
      {ssoError && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span className="flex-1">{ssoError}</span>
          <button onClick={dismiss} aria-label="Dismiss" className="opacity-70 hover:opacity-100"><X className="h-4 w-4" /></button>
        </div>
      )}
      <Tabs defaultValue={linked || ssoError ? 'sso' : 'profile'} className="space-y-4">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="password">Password</TabsTrigger>
          <TabsTrigger value="2fa">Two-Factor Auth</TabsTrigger>
          <TabsTrigger value="passkeys">Passkeys</TabsTrigger>
          <TabsTrigger value="sso">Single sign-on</TabsTrigger>
        </TabsList>
        <TabsContent value="profile"><ProfileTab /></TabsContent>
        <TabsContent value="password"><PasswordTab /></TabsContent>
        <TabsContent value="2fa"><MfaTab /></TabsContent>
        <TabsContent value="passkeys"><PasskeysTab /></TabsContent>
        <TabsContent value="sso"><SsoTab /></TabsContent>
      </Tabs>
    </>
  );
}

export default function AccountPage() {
  return (
    <div className="p-6 space-y-6">
      <PageHeader title="My Account" description="Manage your profile, password, and security" />
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <AccountTabs />
      </Suspense>
    </div>
  );
}
