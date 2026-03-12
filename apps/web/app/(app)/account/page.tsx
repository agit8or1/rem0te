'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { authApi, mfaApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { ShieldCheck, ShieldOff, KeyRound, User, Copy, Check } from 'lucide-react';
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

  const [firstName, setFirstName] = useState('');
  const [lastName,  setLastName]  = useState('');
  const [email,     setEmail]     = useState('');
  const [loaded,    setLoaded]    = useState(false);

  useEffect(() => {
    if (profile && !loaded) {
      const p = profile as { firstName?: string; lastName?: string; email?: string };
      setFirstName(p.firstName ?? '');
      setLastName(p.lastName  ?? '');
      setEmail(p.email        ?? '');
      setLoaded(true);
    }
  }, [profile, loaded]);

  const mutation = useMutation({
    mutationFn: () => authApi.updateProfile({ firstName, lastName, email }),
    onSuccess: () => {
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
        <CardDescription>Update your name and email address.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 max-w-md">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label>First Name</Label>
            <Input value={firstName} onChange={e => setFirstName(e.target.value)} placeholder="First" />
          </div>
          <div className="space-y-1">
            <Label>Last Name</Label>
            <Input value={lastName}  onChange={e => setLastName(e.target.value)}  placeholder="Last" />
          </div>
        </div>
        <div className="space-y-1">
          <Label>Email</Label>
          <Input type="email" value={email} onChange={e => setEmail(e.target.value)} />
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

  const mfaEnabled: boolean = status?.mfaEnabled ?? false;

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
      qc.invalidateQueries({ queryKey: ['mfa-status'] });
      toast({ title: 'Two-factor authentication disabled' });
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

// ─── Page ────────────────────────────────────────────────────────────────────

export default function AccountPage() {
  return (
    <div className="p-6 space-y-6">
      <PageHeader title="My Account" description="Manage your profile, password, and security" />
      <Tabs defaultValue="profile" className="space-y-4">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="password">Password</TabsTrigger>
          <TabsTrigger value="2fa">Two-Factor Auth</TabsTrigger>
        </TabsList>
        <TabsContent value="profile"><ProfileTab /></TabsContent>
        <TabsContent value="password"><PasswordTab /></TabsContent>
        <TabsContent value="2fa"><MfaTab /></TabsContent>
      </Tabs>
    </div>
  );
}
