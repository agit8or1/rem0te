'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { emailApi, type EmailRecipientView, type SmtpSettingsView, type TlsMode } from '@/lib/api-client';
import { usePermissions } from '@/lib/auth';
import { PageHeader } from '@/components/common/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiError } from '@/components/security-controls/shared';
import { RecipientsCard } from '@/components/email/recipients-card';

/**
 * Settings → Email (0.34): the SMTP relay every alert email and scheduled
 * report goes through, and the MSP's global recipients. Platform Admin only;
 * saving asks for fresh authentication. The password is write-only.
 */
const TLS: { id: TlsMode; label: string; hint: string }[] = [
  { id: 'implicit', label: 'Implicit TLS', hint: 'TLS from the first byte — usually port 465.' },
  { id: 'starttls', label: 'STARTTLS (required)', hint: 'Plain connect, then upgraded; refused if the relay does not offer it — usually port 587.' },
  { id: 'none', label: 'None (loopback only)', hint: 'Unencrypted. Accepted only for a relay on this server (127.0.0.1 / ::1 / localhost).' },
];
const RELAY: Record<SmtpSettingsView['localRelay'], string> = {
  none: 'public DNS names only (SMTP_ALLOW_LOCAL_RELAY is not set)',
  loopback: 'public names, plus a relay on this server (SMTP_ALLOW_LOCAL_RELAY=loopback)',
  private: 'public names, this server, and private-network relays (SMTP_ALLOW_LOCAL_RELAY=private)',
};

type Form = { enabled: boolean; host: string; port: string; tlsMode: TlsMode; username: string; password: string; clearPassword: boolean; fromAddress: string; fromName: string };

export default function EmailSettingsPage() {
  const { user, isPlatformAdmin } = usePermissions();
  const qc = useQueryClient();
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const ok = (text: string) => setNotice({ ok: true, text });
  const fail = (e: unknown) => setNotice({ ok: false, text: apiError(e).message });
  const { data, error } = useQuery<SmtpSettingsView>({ queryKey: ['smtp-settings'], queryFn: () => emailApi.settings().then((r) => r.data.data), enabled: isPlatformAdmin, retry: false });
  const { data: globals } = useQuery<{ recipients: EmailRecipientView[] }>({ queryKey: ['email-recipients', 'global', null], queryFn: () => emailApi.recipients('global').then((r) => r.data.data), enabled: isPlatformAdmin, retry: false });
  const [f, setF] = useState<Form | null>(null);
  const [testTo, setTestTo] = useState('');
  useEffect(() => {
    if (data && !f) setF({ enabled: data.enabled, host: data.host ?? '', port: String(data.port ?? 587), tlsMode: data.tlsMode ?? 'starttls', username: data.username ?? '', password: '', clearPassword: false, fromAddress: data.fromAddress ?? '', fromName: data.fromName ?? '' });
  }, [data, f]);

  const relayMoved = !!data?.configured && !!f && (f.host.trim().toLowerCase() !== data.host || Number(f.port) !== data.port || (f.username.trim() || null) !== (data.username ?? null) || f.tlsMode !== data.tlsMode);
  const save = useMutation({
    mutationFn: () => emailApi.saveSettings({
      enabled: f!.enabled, host: f!.host.trim(), port: Number(f!.port), tlsMode: f!.tlsMode, username: f!.username.trim() || null,
      ...(f!.password ? { password: f!.password } : f!.clearPassword ? { password: null } : {}),
      fromAddress: f!.fromAddress.trim(), fromName: f!.fromName.trim() || null,
    }).then((r) => r.data.data as SmtpSettingsView),
    onSuccess: (r) => {
      ok(r.passwordChange === 'cleared_relay_changed' ? 'Saved. The relay changed, so the saved password was cleared — enter it again if the relay needs one.' : 'Email settings saved.');
      setF(null); qc.invalidateQueries({ queryKey: ['smtp-settings'] }); qc.invalidateQueries({ queryKey: ['email-status'] });
    },
    onError: fail,
  });
  const test = useMutation({
    mutationFn: () => emailApi.test(testTo || undefined).then((r) => r.data.data as { to: string; ok: boolean; status: string }),
    onSuccess: (r) => { setNotice({ ok: r.ok, text: r.ok ? `Test email sent to ${r.to}.` : `The test email to ${r.to} was not sent: ${r.status}.` }); qc.invalidateQueries({ queryKey: ['smtp-settings'] }); },
    onError: fail,
  });

  if (!user) return null;
  if (!isPlatformAdmin) return <div className="p-6 text-sm text-muted-foreground">Outbound email is configured by a Platform Admin.</div>;
  const set = (p: Partial<Form>) => setF((x) => (x ? { ...x, ...p } : x));
  return (
    <div className="space-y-4 p-4 md:p-6">
      <Link href="/settings" className="inline-flex items-center text-sm text-muted-foreground hover:underline"><ArrowLeft className="mr-1 h-4 w-4" />Settings</Link>
      <PageHeader title="Email" description="The SMTP relay used for alert emails, scheduled reports and address confirmations. Off until it is configured and switched on." />
      {notice && <div className={`rounded-md border p-3 text-sm ${notice.ok ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100' : 'border-destructive/40 bg-destructive/10 text-destructive'}`}>{notice.text}</div>}
      {error ? <p className="text-sm text-muted-foreground">{apiError(error).message}</p> : null}
      {data && f && (
        <Card data-testid="smtp-settings">
          <CardHeader><CardTitle className="flex items-center gap-2 text-sm">SMTP relay {data.configured ? (data.enabled ? <Badge>on</Badge> : <Badge variant="outline">off</Badge>) : <Badge variant="outline">not configured</Badge>}</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Allowed hosts: {RELAY[data.localRelay]}. A relay on this server or the local network is allowed only from the API&apos;s environment, never from this page.
              The host is checked again, resolved, every time mail is sent; link-local and metadata addresses are always refused.
            </p>
            <label className="flex items-center gap-2"><input type="checkbox" checked={f.enabled} onChange={(e) => set({ enabled: e.target.checked })} />Send email</label>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="space-y-1 md:col-span-2"><Label htmlFor="smtp-host">Host</Label><Input id="smtp-host" placeholder="smtp.example.com" value={f.host} onChange={(e) => set({ host: e.target.value })} /></div>
              <div className="space-y-1"><Label htmlFor="smtp-port">Port</Label><Input id="smtp-port" type="number" min={1} max={65535} value={f.port} onChange={(e) => set({ port: e.target.value })} /></div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="smtp-tls">Encryption</Label>
              <select id="smtp-tls" className="w-full rounded-md border bg-background p-2 md:w-96" value={f.tlsMode} onChange={(e) => set({ tlsMode: e.target.value as TlsMode })}>
                {TLS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
              <p className="text-xs text-muted-foreground">{TLS.find((t) => t.id === f.tlsMode)?.hint} Certificates are always checked.</p>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1"><Label htmlFor="smtp-user">Username (optional)</Label><Input id="smtp-user" autoComplete="off" value={f.username} onChange={(e) => set({ username: e.target.value })} /></div>
              <div className="space-y-1">
                <Label htmlFor="smtp-pass">Password</Label>
                <Input id="smtp-pass" type="password" autoComplete="new-password" placeholder={data.passwordSet ? 'Saved — leave blank to keep' : 'Not set'} value={f.password} onChange={(e) => set({ password: e.target.value, clearPassword: false })} />
                {data.passwordSet && <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={f.clearPassword} onChange={(e) => set({ clearPassword: e.target.checked, password: '' })} />Remove the saved password</label>}
                {relayMoved && data.passwordSet && !f.password && <p className="text-xs text-amber-700 dark:text-amber-300">You changed the host, port, username or encryption: the saved password will be cleared unless you enter it again, so it is never sent to a different relay.</p>}
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1"><Label htmlFor="smtp-from">From address</Label><Input id="smtp-from" type="email" placeholder="alerts@example.com" value={f.fromAddress} onChange={(e) => set({ fromAddress: e.target.value })} /></div>
              <div className="space-y-1"><Label htmlFor="smtp-from-name">From name (optional)</Label><Input id="smtp-from-name" placeholder="rem0te" value={f.fromName} onChange={(e) => set({ fromName: e.target.value })} /></div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button disabled={save.isPending || !f.host.trim() || !f.fromAddress.trim()} onClick={() => save.mutate()}>Save (re-authenticate)</Button>
              <Button variant="ghost" onClick={() => setF(null)}>Discard changes</Button>
            </div>
            {data.updatedAt && <p className="text-xs text-muted-foreground">Last changed {new Date(data.updatedAt).toLocaleString()}. Changes are audited; the password never is.</p>}
          </CardContent>
        </Card>
      )}
      {data?.configured && (
        <Card data-testid="smtp-test">
          <CardHeader><CardTitle className="text-sm">Send a test email</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor="smtp-test-to">To</Label>
                <select id="smtp-test-to" className="rounded-md border bg-background p-2" value={testTo} onChange={(e) => setTestTo(e.target.value)}>
                  <option value="">Your account address ({user.email})</option>
                  {(globals?.recipients ?? []).filter((r) => r.verified).map((r) => <option key={r.id} value={r.id}>{r.address}</option>)}
                </select>
              </div>
              <Button variant="outline" disabled={test.isPending || !data.enabled} onClick={() => test.mutate()}>Send test email</Button>
            </div>
            {!data.enabled && <p className="text-xs text-muted-foreground">Switch email on and save first.</p>}
            <p className="text-xs text-muted-foreground">Last test: {data.lastTestAt ? `${new Date(data.lastTestAt).toLocaleString()} — ${data.lastTestResult}` : 'never'}.</p>
          </CardContent>
        </Card>
      )}
      <RecipientsCard scope="global" businessId={null} ok={ok} fail={fail} />
    </div>
  );
}
