'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Lock, ShieldCheck } from 'lucide-react';
import { confirmPolicyApi } from '@/lib/api-client';
import { CONFIRM_POLICY_QUERY, useConfirmPolicy, type ConfirmFunction, type ConfirmValue } from '@/lib/confirm-policy';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';

/**
 * Settings → Confirm it is you (0.49). Which functions ask a signed-in
 * person to confirm it is them again (password, authenticator code or
 * passkey) before they go ahead. Grouped toggles, a Platform Admin's to
 * change; read-only for everyone else. Turning any confirmation off asks
 * once (the API's always-ask `confirm.relax`); turning one back on never
 * does. The list and the always-ask note come from the API.
 *
 * 0.64: every function defaults to Don't ask (the owner's "just on login"),
 * so the page says so, and says which functions differ from their default.
 */
function apiError(e: unknown) {
  const m = (e as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  return typeof m === 'string' ? m : 'The change was not saved.';
}

function Choice({ fn, disabled, onSet }: { fn: ConfirmFunction; disabled: boolean; onSet: (v: ConfirmValue) => void }) {
  return (
    <div className="flex shrink-0 gap-1" role="group" aria-label={fn.label} data-testid={`confirm-${fn.key}`} data-value={fn.value}>
      <Button size="sm" variant={fn.value === 'ask' ? 'default' : 'outline'} disabled={disabled} aria-pressed={fn.value === 'ask'} onClick={() => fn.value !== 'ask' && onSet('ask')}>Ask</Button>
      <Button size="sm" variant={fn.value === 'off' ? 'default' : 'outline'} disabled={disabled} aria-pressed={fn.value === 'off'} onClick={() => fn.value !== 'off' && onSet('off')}>Don&apos;t ask</Button>
    </div>
  );
}

export function ConfirmPolicyCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isError, isLoading } = useConfirmPolicy();
  const save = useMutation({
    mutationFn: (values: Record<string, ConfirmValue>) => confirmPolicyApi.set(values),
    onSuccess: (r) => { qc.setQueryData(CONFIRM_POLICY_QUERY, r.data?.data); toast({ title: 'Saved' }); },
    onError: (e) => toast({ title: 'Not saved', description: apiError(e), variant: 'destructive' }),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (isError || !data) return <p className="text-sm text-muted-foreground">The confirmation settings could not be loaded. The server asks for everything until it has read them.</p>;

  const disabled = !data.canChange || save.isPending;
  const setAll = (fns: ConfirmFunction[], v: ConfirmValue) => {
    const values = Object.fromEntries(fns.filter((f) => f.value !== v).map((f) => [f.key, v]));
    if (Object.keys(values).length) save.mutate(values);
  };
  const offCount = data.catalog.filter((f) => f.value === 'off').length;

  return (
    <div className="space-y-4" data-testid="confirm-policy">
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2 text-sm"><ShieldCheck className="h-4 w-4 text-primary" />Confirm it is you</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            By default you confirm it is you only when you sign in (with its MFA). Any function below can also ask you to
            confirm it is you again (your password, an authenticator code or a passkey) while you are signed in; a
            confirmation then lasts 10 minutes for that sign-in. Choose <strong className="text-foreground">Ask</strong> for
            the functions that should. <strong className="text-foreground">Don&apos;t ask</strong>, the default, means signing in
            is enough. Signing in is always required, permissions are checked as before, and every change is still recorded
            in the audit log.
          </p>
          <p className="text-muted-foreground" data-testid="confirm-summary">
            Turning a confirmation off asks you to confirm it is you once. Turning one back on never does.{' '}
            {offCount === data.catalog.length
              ? 'Nothing asks after sign-in (the default).'
              : offCount === 0
                ? 'Every function asks.'
                : `${data.catalog.length - offCount} of ${data.catalog.length} functions ask.`}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={disabled || offCount === data.catalog.length} onClick={() => setAll(data.catalog, 'off')}>Don&apos;t ask for any</Button>
            <Button size="sm" variant="outline" disabled={disabled || offCount === 0} onClick={() => setAll(data.catalog, 'ask')}>Ask for all</Button>
            {!data.canChange && <span className="text-xs text-muted-foreground">Read-only: a Platform Admin changes these.</span>}
          </div>
        </CardContent>
      </Card>

      {data.groups.map((g) => {
        const fns = data.catalog.filter((f) => f.group === g);
        if (!fns.length) return null;
        const off = fns.filter((f) => f.value === 'off').length;
        return (
          <Card key={g} data-testid={`confirm-group-${g}`}>
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-sm">{g}</CardTitle>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" disabled={disabled || off === fns.length} onClick={() => setAll(fns, 'off')}>Don&apos;t ask for any</Button>
                  <Button size="sm" variant="ghost" disabled={disabled || off === 0} onClick={() => setAll(fns, 'ask')}>Ask for all</Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="divide-y text-sm">
              {fns.map((fn) => (
                <div key={fn.key} className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="font-medium">{fn.label}</p>
                    <p className="text-xs text-muted-foreground">{fn.description}</p>
                  </div>
                  <Choice fn={fn} disabled={disabled} onSet={(v) => save.mutate({ [fn.key]: v })} />
                </div>
              ))}
            </CardContent>
          </Card>
        );
      })}

      <Card>
        <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><Lock className="h-4 w-4" />Always asks</CardTitle></CardHeader>
        <CardContent className="text-sm">
          <p className="mb-2 text-muted-foreground">These are not settings: they ask every time, whatever is chosen above.</p>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground" data-testid="confirm-always-ask">
            {data.alwaysAsk.map((l) => <li key={l}>{l}</li>)}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
