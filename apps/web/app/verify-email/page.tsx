'use client';

import { useEffect, useState } from 'react';
import { MailCheck } from 'lucide-react';
import { emailApi } from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

/**
 * Confirm an address for rem0te notifications (0.34). Public: the person
 * confirming has no account. Opening the page confirms nothing — mail
 * scanners follow links — the button posts the single-use token.
 */
export default function VerifyEmailPage() {
  const [token, setToken] = useState<string | null>(null);
  const [state, setState] = useState<{ kind: 'idle' | 'busy' | 'done' | 'error'; text?: string }>({ kind: 'idle' });
  useEffect(() => {
    try { setToken(new URLSearchParams(window.location.search).get('token')); } catch { setToken(null); }
  }, []);
  const confirm = async () => {
    if (!token) return;
    setState({ kind: 'busy' });
    try {
      const r = await emailApi.verify(token);
      setState({ kind: 'done', text: `Confirmed: ${(r.data?.data as { address?: string })?.address ?? 'this address'} will receive the notifications it was signed up for.` });
    } catch (e) {
      const m = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      setState({ kind: 'error', text: typeof m === 'string' ? m : 'This confirmation link is not valid, was already used, or has expired.' });
    }
  };
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader><CardTitle className="flex items-center gap-2"><MailCheck className="h-5 w-5" />Confirm this address</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          {!token && <p className="text-muted-foreground">This page needs the link from the confirmation email. Open the link in that email.</p>}
          {token && state.kind !== 'done' && (
            <>
              <p className="text-muted-foreground">Someone asked rem0te to send alert emails and scheduled reports to this mailbox. Confirm only if you expect them. If you do not, close this page: nothing is sent to an unconfirmed address.</p>
              <Button onClick={confirm} disabled={state.kind === 'busy'}>{state.kind === 'busy' ? 'Confirming…' : 'Confirm this address'}</Button>
            </>
          )}
          {state.kind === 'done' && <p className="text-emerald-700 dark:text-emerald-300">{state.text}</p>}
          {state.kind === 'error' && <p className="text-destructive">{state.text}</p>}
        </CardContent>
      </Card>
    </main>
  );
}
