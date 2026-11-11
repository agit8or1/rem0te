'use client';

import * as React from 'react';
import { KeyRound, ShieldCheck } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { registerStepUpHandler, stepUpApi } from '@/lib/api-client';
import { errorMessage, getPasskey, passkeysSupported } from '@/lib/webauthn';

const ACTION_LABEL: Record<string, string> = {
  'credential.reveal': 'reveal a computer password',
  'permissions.change': 'change permissions',
  'technicians.manage': 'manage technician access',
  'sso.configure': 'change single sign-on settings',
  'passkey.manage': 'add or remove a passkey',
  'platform.configure': "change the server's public address",
  // v0.23 security controls: always re-authenticate, whatever is enabled.
  'fresh.auth': 'change technician access or security controls',
  'fresh.auth.passkey': 'activate a protected-device exception',
  // 0.32: an enabled client-update policy installs software unattended.
  'updates.schedule': 'turn on automatic client updates',
  // 0.33: an enrolment token adds a computer to a business.
  'enrollment.create': 'make an install link',
  'apikey.enrollment': 'create an API key that can enrol computers',
  // 0.34: a per-computer move to the signed agent runs a portal-served script once.
  'agent.migrate': 'upgrade computers to the signed agent',
};

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

  React.useEffect(() => {
    registerStepUpHandler((a) => new Promise<boolean>((resolve) => {
      // A second prompt while one is open joins the first.
      const prev = resolver.current;
      resolver.current = (ok) => { prev?.(ok); resolve(ok); };
      setAction(a); setValue(''); setError(null); setMode('password'); setTotpOnly(false); setOpen(true);
      stepUpApi.status().then((r) => {
        if (r.data?.data?.totpRequired) { setTotpOnly(true); setMode('totp'); }
      }).catch(() => { /* the server still decides; the form just offers less */ });
    }));
    return () => registerStepUpHandler(null);
  }, []);

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
            {action && ACTION_LABEL[action] ? `To ${ACTION_LABEL[action]}, ` : 'For this action, '}
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
        </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
