'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, AlertTriangle, Globe } from 'lucide-react';
import { publicAddressApi, type PublicAddressCheck, type PublicAddressInfo } from '@/lib/api-client';
import { usePermissions } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/common/confirm-dialog';

type ApiError = { response?: { status?: number; data?: { code?: string; message?: string } } };
const errMsg = (e: unknown) => (e as ApiError)?.response?.data?.message ?? 'Something went wrong';
const hostOf = (u: string | null | undefined) => { try { return u ? new URL(u).hostname : null; } catch { return null; } };

const SOURCE_LABEL: Record<PublicAddressInfo['source'], string> = {
  setting: 'Saved here',
  environment: 'From the server environment (FRONTEND_URL)',
  default: 'Development default',
};

/**
 * Settings → General → Public address. The address every link, download and
 * redirect this server hands out is built from. Platform Admin only; the API
 * refuses everyone else and asks for step-up (platform.configure) on save.
 */
export function PublicAddressCard() {
  const { isPlatformAdmin, technician } = usePermissions();
  const show = isPlatformAdmin && !technician;
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: info, isLoading, isError } = useQuery({
    queryKey: ['public-address'],
    queryFn: () => publicAddressApi.get().then((r) => r.data.data),
    enabled: show,
    retry: false,
  });

  const [value, setValue] = useState('');
  const [check, setCheck] = useState<PublicAddressCheck | null>(null);
  const [unverified, setUnverified] = useState<string | null>(null);
  const [confirmPasskeys, setConfirmPasskeys] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    if (info) setValue(info.setting ?? info.effective);
  }, [info]);

  const here = typeof window !== 'undefined' ? window.location.origin : null;

  const runCheck = useMutation({
    mutationFn: (url: string) => publicAddressApi.check(url).then((r) => r.data.data),
    onSuccess: (c) => { setCheck(c); setUnverified(null); },
    onError: (e) => { setCheck(null); toast({ title: 'Not checked', description: errMsg(e), variant: 'destructive' }); },
  });

  const save = useMutation({
    mutationFn: (v: { url: string | null; saveUnverified?: boolean }) =>
      publicAddressApi.set(v.url, v.saveUnverified).then((r) => r.data.data),
    onSuccess: (d, v) => {
      qc.setQueryData(['public-address'], d);
      setUnverified(null);
      setCheck(d.check);
      toast({
        title: v.url === null ? 'Public address cleared' : 'Public address saved',
        description: v.url === null ? `Now using ${d.effective} from the server environment.` : `New links and downloads use ${d.effective}.`,
      });
    },
    onError: (e) => {
      const r = (e as ApiError).response;
      if (r?.status === 409 && r.data?.code === 'ADDRESS_UNVERIFIED') {
        setUnverified(r.data.message ?? 'The address could not be confirmed.');
        return;
      }
      toast({ title: 'Not saved', description: errMsg(e), variant: 'destructive' });
    },
  });

  if (!show || isError) return null;

  const trimmed = value.trim().replace(/\/+$/, '');
  const unchanged = !!info && trimmed === (info.setting ?? '');
  const hostChanges = !!info && hostOf(trimmed) !== null && hostOf(trimmed) !== hostOf(info.effective);
  const passkeysAtRisk = !!info && hostChanges && !info.webauthnRpIdPinned && info.passkeys > 0;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!trimmed) return;
    if (passkeysAtRisk) { setConfirmPasskeys(true); return; }
    save.mutate({ url: trimmed });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2"><Globe className="h-4 w-4" /> Public address</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-muted-foreground">
          The address people use to reach this server. Support links, sign-in redirects, passkeys, launcher links and
          installer downloads are all built from it.
        </p>

        {isLoading || !info ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : (
          <>
            <div className="rounded-md border bg-muted/30 p-3 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">In use:</span>
                <code className="font-mono text-xs">{info.effective}</code>
                <Badge variant={info.source === 'setting' ? 'success' : info.source === 'default' ? 'warning' : 'secondary'}>
                  {SOURCE_LABEL[info.source]}
                </Badge>
              </div>
              {info.effectiveApi !== info.effective && (
                <p className="text-xs text-muted-foreground">
                  API links use <code className="font-mono">{info.effectiveApi}</code> (PUBLIC_API_URL).
                </p>
              )}
              {here && here !== info.effective && (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  You are viewing this page at <code className="font-mono">{here}</code>, which is not the address in use.
                </p>
              )}
            </div>

            <form onSubmit={submit} className="space-y-2">
              <Label htmlFor="public-address">Address</Label>
              <div className="flex flex-col sm:flex-row gap-2">
                <Input
                  id="public-address"
                  value={value}
                  onChange={(e) => { setValue(e.target.value); setCheck(null); setUnverified(null); }}
                  placeholder="https://remote.example.com"
                  className="font-mono text-xs"
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button type="button" variant="outline" className="h-10" disabled={!trimmed || runCheck.isPending} onClick={() => runCheck.mutate(trimmed)}>
                  {runCheck.isPending ? 'Checking…' : 'Check'}
                </Button>
                <Button type="submit" className="h-10" disabled={!trimmed || unchanged || save.isPending}>
                  {save.isPending ? 'Saving…' : 'Save'}
                </Button>
              </div>
              {here && here !== trimmed && (
                <button type="button" className="text-xs text-primary hover:underline" onClick={() => { setValue(here); setCheck(null); setUnverified(null); }}>
                  Use the address of this page ({here})
                </button>
              )}
            </form>

            {check && (
              <div className={`flex items-start gap-2 rounded-md border p-3 text-xs ${check.sameServer ? 'border-green-300 dark:border-green-800' : 'border-amber-300 dark:border-amber-800'}`}>
                {check.sameServer
                  ? <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
                  : <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />}
                <span><code className="font-mono">{check.address}</code>: {check.detail}</span>
              </div>
            )}

            {unverified && (
              <div className="rounded-md border border-amber-300 dark:border-amber-800 p-3 space-y-2 text-xs">
                <p className="flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                  <span>
                    {unverified} The server could not confirm this address leads back to it. That is expected if DNS has not
                    switched yet, or if the server cannot reach its own public address from inside its network.
                  </span>
                </p>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => setUnverified(null)}>Cancel</Button>
                  <Button size="sm" disabled={save.isPending} onClick={() => save.mutate({ url: trimmed, saveUnverified: true })}>
                    Save anyway
                  </Button>
                </div>
              </div>
            )}

            <ul className="list-disc pl-5 space-y-1 text-xs text-muted-foreground">
              <li>Enrolled computers are not affected: they check in through the RustDesk relay host.</li>
              <li>Links and downloads already handed out keep the old address.</li>
              <li>
                SSO: update the redirect URI at each provider to <code className="font-mono">{(trimmed || info.effective)}/api/v1/auth/sso/callback</code>.
              </li>
              <li>
                {info.webauthnRpIdPinned
                  ? 'Passkeys are pinned by WEBAUTHN_RP_ID and are not affected.'
                  : info.passkeys === 0
                    ? 'Passkeys are bound to the host name. None are registered yet, so a change now affects none.'
                    : `Passkeys are bound to the host name: changing it makes ${info.passkeys === 1 ? 'the 1 registered passkey' : `all ${info.passkeys} registered passkeys`} unusable.`}
              </li>
            </ul>

            {info.source === 'setting' && (
              <div className="flex items-center justify-between gap-4 border-t pt-3">
                <p className="text-xs text-muted-foreground">
                  Clear the setting to go back to{' '}
                  <code className="font-mono">{info.environment.FRONTEND_URL ?? 'the development default'}</code>.
                </p>
                <Button size="sm" variant="outline" disabled={save.isPending} onClick={() => setConfirmClear(true)}>Clear</Button>
              </div>
            )}
          </>
        )}
      </CardContent>

      <ConfirmDialog
        open={confirmPasskeys}
        onOpenChange={setConfirmPasskeys}
        title="Passkeys will stop working"
        description={`${info?.passkeys ?? 0} registered passkey(s) are bound to ${hostOf(info?.effective) ?? 'the current host name'}. After this change they cannot sign in, and each person must add a new one. Password sign-in is unaffected.`}
        confirmLabel="Change address"
        destructive
        loading={save.isPending}
        onConfirm={() => { setConfirmPasskeys(false); save.mutate({ url: trimmed }); }}
      />
      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="Clear the public address?"
        description={`The server goes back to the address in its environment file: ${info?.environment.FRONTEND_URL ?? 'the development default'}.${
          info && !info.webauthnRpIdPinned && info.passkeys > 0 && hostOf(info.environment.FRONTEND_URL) !== hostOf(info.effective)
            ? ` That is a different host name, so ${info.passkeys} registered passkey(s) will stop working.`
            : ''}`}
        confirmLabel="Clear"
        loading={save.isPending}
        onConfirm={() => { setConfirmClear(false); save.mutate({ url: null }); }}
      />
    </Card>
  );
}
