'use client';

import * as React from 'react';
import { KeyRound, LogIn, ShieldCheck } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { registerStepUpHandler, ssoApi, stepUpApi } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { ssoErrorMessage } from '@/lib/sso-errors';
import { useConfirmPolicy } from '@/lib/confirm-policy';
import { errorMessage, getPasskey, passkeysSupported } from '@/lib/webauthn';

// 0.49: every configurable function is worded from the API's catalog
// (GET /security/confirm-policy, its `prompt`). Only the always-ask keys,
// which the catalog does not list as toggles, are worded here.
const ALWAYS_ASK_LABEL: Record<string, string> = {
  'passkey.manage': 'add or remove a passkey',
  'fresh.auth.passkey': 'activate a protected-device exception',
  'confirm.relax': 'turn a confirmation off',
};

type SsoStepUpProvider = { id: string; name: string; mfa: boolean; passkey: boolean };

/**
 * Mounted once in the app layout. When the API answers STEP_UP_REQUIRED, the
 * request interceptor calls the handler registered here, this asks the person
 * to confirm it is them, and the original request is retried once.
 */
export function StepUpDialog() {
  const [open, setOpen] = React.useState(false);
  const [action, setAction] = React.useState<string | undefined>();
  const [mode, setMode] = React.useState<'password' | 'totp'>('password');
  const [value, setValue] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // With an authenticator enrolled the server refuses the password for
  // step-up, so do not offer it.
  const [totpOnly, setTotpOnly] = React.useState(false);
  const resolver = React.useRef<((ok: boolean) => void) | null>(null);
  // 0.59: providers this account can confirm through (GET /auth/sso/step-up).
  // An SSO-only account has no password, so this is its only way to step up.
  const [sso, setSso] = React.useState<{ ssoOnly: boolean; providers: SsoStepUpProvider[] }>({ ssoOnly: false, providers: [] });
  const { toast } = useToast();
  const { data: policy } = useConfirmPolicy();
  const label = action ? (policy?.catalog.find((f) => f.key === action)?.prompt ?? ALWAYS_ASK_LABEL[action]) : undefined;

  React.useEffect(() => {
    registerStepUpHandler((a) => new Promise<boolean>((resolve) => {
      // A second prompt while one is open joins the first.
      const prev = resolver.current;
      resolver.current = (ok) => { prev?.(ok); resolve(ok); };
      setAction(a); setValue(''); setError(null); setMode('password'); setTotpOnly(false); setOpen(true);
      ssoApi.stepUpOptions().then((r) => setSso(r.data?.data ?? { ssoOnly: false, providers: [] })).catch(() => setSso({ ssoOnly: false, providers: [] }));
      stepUpApi.status().then((r) => {
        if (r.data?.data?.totpRequired) { setTotpOnly(true); setMode('totp'); }
      }).catch(() => { /* the server still decides; the form just offers less */ });
    }));
    return () => registerStepUpHandler(null);
  }, []);

  // 0.59: coming back from a step-up at the provider. The request that asked
  // for it was not kept across the round trip, so the person does it again.
  React.useEffect(() => {
    const url = new URL(window.location.href);
    const ok = url.searchParams.get('sso_step_up');
    const err = url.searchParams.get('sso_step_up_error');
    if (!ok && !err) return;
    url.searchParams.delete('sso_step_up'); url.searchParams.delete('sso_step_up_error');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    if (ok === 'ok') toast({ title: 'Confirmed', description: 'Your provider confirmed it is you. Do what you were doing again; this lasts 10 minutes.' });
    else toast({ title: 'Not confirmed', description: ssoErrorMessage(err) ?? 'The provider did not confirm it is you.', variant: 'destructive' });
  }, [toast]);

  // A protected-device exception accepts only a passkey; offering a password
  // there would succeed here and then be refused by the retried request.
  const passkeyOnly = action === 'fresh.auth.passkey';

  function finish(ok: boolean) {
    const r = resolver.current;
    resolver.current = null;
    setOpen(false);
    r?.(ok);
  }

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!value) return;
    setBusy(true); setError(null);
    try {
      await stepUpApi.verify(mode === 'password' ? { password: value } : { totpCode: value.replace(/\s/g, '') });
      finish(true);
    } catch (err) {
      setError(errorMessage(err, 'That did not match. Try again.'));
    } finally { setBusy(false); }
  }

  async function confirmWithSso(providerId: string) {
    setBusy(true); setError(null);
    try {
      const returnTo = window.location.pathname + window.location.search;
      const url = (await ssoApi.stepUpStart({ providerId, phishingResistant: passkeyOnly, returnTo })).data?.data?.url;
      if (!url) throw new Error('no url');
      // The page is left for the provider; the waiting request is let go.
      finish(false);
      window.location.assign(url);
    } catch (err) {
      setError(errorMessage(err, 'That provider could not be reached.'));
      setBusy(false);
    }
  }

  const ssoChoices = sso.providers.filter((p) => (passkeyOnly ? p.passkey : p.mfa));
  const ssoButtons = ssoChoices.length > 0 && (
    <div className="space-y-2 border-t pt-3">
      <p className="text-xs text-muted-foreground">
        {sso.ssoOnly ? 'Your account signs in through single sign-on, so confirm it there.' : 'Or confirm through your single sign-on provider.'}
      </p>
      {ssoChoices.map((p) => (
        <Button key={p.id} type="button" variant="outline" className="w-full" onClick={() => confirmWithSso(p.id)} disabled={busy} data-testid="step-up-sso">
          <LogIn className="mr-2 h-4 w-4" />Confirm with {p.name}
        </Button>
      ))}
    </div>
  );

  async function usePasskey() {
    setBusy(true); setError(null);
    try {
      const opts = (await stepUpApi.passkeyOptions()).data.data;
      const response = await getPasskey(opts);
      await stepUpApi.passkeyVerify(response);
      finish(true);
    } catch (err) {
      setError(errorMessage(err, 'The passkey could not be verified.'));
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) finish(false); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-primary" />Confirm it&apos;s you</DialogTitle>
          <DialogDescription>
            {label ? `To ${label}, ` : 'For this action, '}
            confirm your identity. This lasts 10 minutes for this sign-in only.
          </DialogDescription>
        </DialogHeader>
        {passkeyOnly ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              This action needs a passkey. Passwords and authenticator codes are not accepted for it.
            </p>
            {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
            <DialogFooter>
              <Button type="button" onClick={usePasskey} disabled={busy || !passkeysSupported()}>
                <KeyRound className="mr-2 h-4 w-4" />{busy ? 'Checking…' : 'Use a passkey'}
              </Button>
            </DialogFooter>
            {ssoButtons}
          </div>
        ) : (
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="stepup-value">{mode === 'password' ? 'Password' : 'Authenticator code'}</Label>
            <Input
              id="stepup-value" autoFocus autoComplete={mode === 'password' ? 'current-password' : 'one-time-code'}
              type={mode === 'password' ? 'password' : 'text'} inputMode={mode === 'totp' ? 'numeric' : undefined}
              value={value} onChange={(e) => setValue(e.target.value)} disabled={busy}
            />
          </div>
          {totpOnly ? (
            <p className="text-xs text-muted-foreground">Your account has an authenticator, so its code (or a passkey) is needed here — not your password.</p>
          ) : (
          <button type="button" className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => { setMode(mode === 'password' ? 'totp' : 'password'); setValue(''); setError(null); }}>
            {mode === 'password' ? 'Use an authenticator code instead' : 'Use your password instead'}
          </button>
          )}
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          <DialogFooter className="gap-2 sm:gap-2">
            {passkeysSupported() && (
              <Button type="button" variant="outline" onClick={usePasskey} disabled={busy}>
                <KeyRound className="mr-2 h-4 w-4" />Use a passkey
              </Button>
            )}
            <Button type="submit" disabled={busy || !value}>{busy ? 'Checking…' : 'Confirm'}</Button>
          </DialogFooter>
          {ssoButtons}
        </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
