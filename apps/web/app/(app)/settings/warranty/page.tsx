'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { warrantyApi, type WarrantySettingsView, type WarrantyVendorView } from '@/lib/api-client';
import { usePermissions } from '@/lib/auth';
import { PageHeader } from '@/components/common/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiError } from '@/components/security-controls/shared';
import { reauthSuffix, useAsks } from '@/lib/confirm-policy';

/**
 * Settings → Warranty (0.56): the vendor warranty lookups. Platform Admin
 * only; saving asks for fresh authentication unless the warranty.settings
 * confirmation is off. Each lookup is off until it is switched on here, and
 * the credential is write-only: the page shows only that one is set and its
 * last four characters.
 */
const HELP: Record<'dell' | 'lenovo', { what: string; creds: string }> = {
  dell: {
    what: 'Dell TechDirect warranty API (v5). Each lookup sends the computer’s Dell service tag to Dell (apigtwb2c.us.dell.com).',
    creds: 'A client id and client secret from Dell TechDirect (techdirect.dell.com → APIs), with the warranty API approved for your account. Approval can take a few days.',
  },
  lenovo: {
    what: 'Lenovo warranty API (v2.5). Each lookup sends the computer’s Lenovo serial number to Lenovo (supportapi.lenovo.com).',
    creds: 'A ClientID token issued by Lenovo — ask your Lenovo account representative or partner programme for warranty API access.',
  },
};

function VendorCard({ v, onSaved, onError }: { v: WarrantyVendorView; onSaved: (text: string) => void; onError: (e: unknown) => void }) {
  const qc = useQueryClient();
  const ask = useAsks('warranty.settings');
  const [enabled, setEnabled] = useState(v.enabled);
  const [clientId, setClientId] = useState(v.clientId ?? '');
  const [secret, setSecret] = useState('');
  const [clear, setClear] = useState(false);
  const save = useMutation({
    mutationFn: () => warrantyApi.saveVendor(v.vendor, {
      enabled,
      ...(v.vendor === 'dell' ? { clientId: clientId.trim() || null } : {}),
      ...(secret ? { secret } : clear ? { secret: null } : {}),
    }).then((r) => r.data.data as WarrantyVendorView),
    onSuccess: (r) => {
      setSecret(''); setClear(false);
      onSaved(r.keyChange === 'cleared_client_changed' ? `${v.label}: saved. The client id changed, so the saved secret was removed — enter it again.` : `${v.label}: saved.`);
      qc.invalidateQueries({ queryKey: ['warranty-settings'] });
    },
    onError,
  });
  const h = HELP[v.vendor];
  return (
    <Card data-testid={`warranty-vendor-${v.vendor}`}>
      <CardHeader><CardTitle className="flex items-center gap-2 text-sm">{v.label} {v.enabled ? <Badge>on</Badge> : <Badge variant="outline">off</Badge>}</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          Switching this on sends serial numbers to {v.vendor === 'dell' ? 'Dell' : 'Lenovo'}: the serial (and nothing else about the computer — no name, business, user or address) of every {v.vendor === 'dell' ? 'Dell' : 'Lenovo'} computer, at most once every 30 days each.
        </p>
        <p className="text-muted-foreground">{h.what}</p>
        <p className="text-muted-foreground"><span className="font-medium text-foreground">You need:</span> {h.creds}</p>
        <label className="flex items-center gap-2"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />Look up {v.vendor === 'dell' ? 'Dell' : 'Lenovo'} warranties</label>
        {v.vendor === 'dell' && (
          <div className="space-y-1">
            <Label htmlFor="w-dell-client">Client id</Label>
            <Input id="w-dell-client" className="font-mono md:w-96" value={clientId} onChange={(e) => setClientId(e.target.value)} />
            {v.clientId && clientId.trim() !== v.clientId && v.secretSet && !secret ? <p className="text-xs text-amber-700 dark:text-amber-300">A different client id removes the saved secret unless you enter one with it.</p> : null}
          </div>
        )}
        <div className="space-y-1">
          <Label htmlFor={`w-${v.vendor}-secret`}>{v.vendor === 'dell' ? 'Client secret' : 'ClientID token'}</Label>
          <Input id={`w-${v.vendor}-secret`} type="password" autoComplete="new-password" className="md:w-96" placeholder={v.secretSet ? `set · …${v.secretLast4 ?? ''} — leave blank to keep` : 'Not set'} value={secret} onChange={(e) => { setSecret(e.target.value); setClear(false); }} />
          {v.secretSet && <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={clear} onChange={(e) => { setClear(e.target.checked); setSecret(''); }} />Remove the saved {v.vendor === 'dell' ? 'secret' : 'token'}</label>}
          <p className="text-xs text-muted-foreground">Stored encrypted on this server and never shown again. Changes are audited; the credential never is.</p>
        </div>
        <Button disabled={save.isPending} onClick={() => save.mutate()}>{`Save${reauthSuffix(ask)}`}</Button>
        <p className="text-xs text-muted-foreground">Last lookup: {v.lastResultAt ? `${new Date(v.lastResultAt).toLocaleString()} — ${v.lastResult}` : 'never'}.</p>
      </CardContent>
    </Card>
  );
}

export default function WarrantySettingsPage() {
  const { user, isPlatformAdmin } = usePermissions();
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const { data, error } = useQuery<WarrantySettingsView>({ queryKey: ['warranty-settings'], queryFn: () => warrantyApi.settings().then((r) => r.data.data), enabled: isPlatformAdmin, retry: false });
  if (!user) return null;
  if (!isPlatformAdmin) return <div className="p-6 text-sm text-muted-foreground">Warranty lookups are configured by a Platform Admin.</div>;
  return (
    <div className="max-w-4xl space-y-4 p-4 md:p-6">
      <Link href="/settings" className="inline-flex items-center text-sm text-muted-foreground hover:underline"><ArrowLeft className="mr-1 h-4 w-4" />Settings</Link>
      <PageHeader title="Warranty" description="Automatic hardware warranty lookups from the vendor. Off unless switched on here; warranty dates can always be entered by hand on a computer's Hardware card." />
      {notice && <div className={`rounded-md border p-3 text-sm ${notice.ok ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100' : 'border-destructive/40 bg-destructive/10 text-destructive'}`}>{notice.text}</div>}
      {error ? <p className="text-sm text-muted-foreground">{apiError(error).message}</p> : null}
      {data && (
        <>
          <Card>
            <CardContent className="space-y-1 pt-6 text-sm text-muted-foreground">
              <p>
                When a lookup is on, this server asks the vendor about at most {data.sweep.perHour} computers an hour, each at most once every {data.sweep.intervalDays} days
                (a failure that may pass is asked again after a day). A date entered by hand is never overwritten. A business under an
                integration containment pause is not looked up.{data.sweep.enabled ? '' : ' The lookup sweep is off in this API process (WARRANTY_SWEEP=off); “Check now” on a computer still works.'}
              </p>
              <p>Manual entry only: {data.manualOnly.map((m) => m.label).join(', ')} — they publish no warranty API this server can use (HP&apos;s batch API is not implemented yet).</p>
            </CardContent>
          </Card>
          {data.vendors.map((v) => (
            <VendorCard key={`${v.vendor}-${v.updatedAt ?? ''}`} v={v} onSaved={(text) => setNotice({ ok: true, text })} onError={(e) => setNotice({ ok: false, text: apiError(e).message })} />
          ))}
        </>
      )}
    </div>
  );
}
