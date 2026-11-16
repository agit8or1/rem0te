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
import { lookupResultText } from '@/lib/hardware-support';
import { apiError } from '@/components/security-controls/shared';
import { reauthSuffix, useAsks } from '@/lib/confirm-policy';

/**
 * Settings → Warranty (0.56): the vendor warranty lookups. Platform Admin
 * only; saving asks for fresh authentication unless the warranty.settings
 * confirmation is off. Each lookup is off until it is switched on here, and
 * the credential is write-only: the page shows only that one is set and its
 * last four characters.
 */
type Vendor = WarrantyVendorView['vendor'];
const HELP: Record<Vendor, { what: string; creds: string; clientId?: string; keyId?: string; secret: string; standIn?: boolean }> = {
  dell: {
    what: 'Dell TechDirect warranty API (v5). Each lookup sends the computer’s Dell service tag to Dell (apigtwb2c.us.dell.com).',
    creds: 'A client id and client secret from Dell TechDirect (techdirect.dell.com → APIs), with the warranty API approved for your account. Approval can take a few days.',
    clientId: 'Client id', secret: 'Client secret',
  },
  lenovo: {
    what: 'Lenovo warranty API (v2.5). Each lookup sends the computer’s Lenovo serial number to Lenovo (supportapi.lenovo.com).',
    creds: 'A ClientID token issued by Lenovo — ask your Lenovo account representative or partner programme for warranty API access.',
    secret: 'ClientID token',
  },
  hp: {
    what: 'HP Inc. Warranty API (batch jobs). Each lookup sends the computer’s HP serial number to HP (warranty.api.hp.com) as a one-serial job, then reads the result. HP servers (ProLiant and the like) are HPE’s, not HP’s, and are not looked up.',
    creds: 'An app key and secret from the HP Developer Portal. Create an account at developers.hp.com, submit the CSS API enrolment form (developers.hp.com/css-enroll), wait for HP to confirm the Warranty API is enabled on your account (HP may involve your HP account manager), then create an app with the Warranty API and copy its API key and secret here.',
    clientId: 'API key', secret: 'API secret', standIn: true,
  },
  apple: {
    what: 'Apple Business Manager API (AppleCare coverage). Each lookup sends the Mac’s serial number to Apple (account.apple.com for the token, api-business.apple.com for coverage). Only devices in your organisation’s Apple Business Manager are known; any other serial is “no record”.',
    creds: 'An API account from Apple Business Manager (Preferences → API, by an Administrator): its client id (BUSINESSAPI.…), its key id, and the private key (.pem) it lets you download once.',
    clientId: 'Client id', keyId: 'Key id', secret: 'Private key (PEM)', standIn: true,
  },
};

function VendorCard({ v, onSaved, onError }: { v: WarrantyVendorView; onSaved: (text: string) => void; onError: (e: unknown) => void }) {
  const qc = useQueryClient();
  const ask = useAsks('warranty.settings');
  const [enabled, setEnabled] = useState(v.enabled);
  const [clientId, setClientId] = useState(v.clientId ?? '');
  const [keyId, setKeyId] = useState(v.keyId ?? '');
  const h = HELP[v.vendor];
  const [secret, setSecret] = useState('');
  const [clear, setClear] = useState(false);
  const save = useMutation({
    mutationFn: () => warrantyApi.saveVendor(v.vendor, {
      enabled,
      ...(h.clientId ? { clientId: clientId.trim() || null } : {}),
      ...(h.keyId ? { keyId: keyId.trim() || null } : {}),
      ...(secret ? { secret } : clear ? { secret: null } : {}),
    }).then((r) => r.data.data as WarrantyVendorView),
    onSuccess: (r) => {
      setSecret(''); setClear(false);
      onSaved(r.keyChange === 'cleared_client_changed' ? `${v.label}: saved. The ${h.keyId ? 'client id or key id' : (h.clientId ?? 'identifier').toLowerCase()} changed, so the saved ${h.secret.toLowerCase()} was removed — enter it again.` : `${v.label}: saved.`);
      qc.invalidateQueries({ queryKey: ['warranty-settings'] });
    },
    onError,
  });
  return (
    <Card data-testid={`warranty-vendor-${v.vendor}`}>
      <CardHeader><CardTitle className="flex items-center gap-2 text-sm">{v.label} {v.enabled ? <Badge>on</Badge> : <Badge variant="outline">off</Badge>}</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          Switching this on sends serial numbers to {v.label}: the serial (and nothing else about the computer — no name, model, business, user or address) of every {v.label} computer, at most once every 30 days each.
        </p>
        {h.standIn && <p className="rounded-md border p-2 text-xs text-muted-foreground" data-testid={`warranty-standin-${v.vendor}`}>New in 0.61: this lookup has been tested only against a stand-in that follows {v.label}’s published examples, never against {v.label} itself. Use Check now on one computer first and read the result.</p>}
        <p className="text-muted-foreground">{h.what}</p>
        <p className="text-muted-foreground"><span className="font-medium text-foreground">You need:</span> {h.creds}</p>
        <label className="flex items-center gap-2"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />Look up {v.label} warranties</label>
        {h.clientId && (
          <div className="space-y-1">
            <Label htmlFor={`w-${v.vendor}-client`}>{h.clientId}</Label>
            <Input id={`w-${v.vendor}-client`} className="font-mono md:w-96" value={clientId} onChange={(e) => setClientId(e.target.value)} />
            {v.clientId && clientId.trim() !== v.clientId && v.secretSet && !secret ? <p className="text-xs text-amber-700 dark:text-amber-300">A different {h.clientId.toLowerCase()} removes the saved {h.secret.toLowerCase()} unless you enter one with it.</p> : null}
          </div>
        )}
        {h.keyId && (
          <div className="space-y-1">
            <Label htmlFor={`w-${v.vendor}-keyid`}>{h.keyId}</Label>
            <Input id={`w-${v.vendor}-keyid`} className="font-mono md:w-96" value={keyId} onChange={(e) => setKeyId(e.target.value)} />
          </div>
        )}
        <div className="space-y-1">
          <Label htmlFor={`w-${v.vendor}-secret`}>{h.secret}</Label>
          {v.vendor === 'apple'
            ? <textarea id={`w-${v.vendor}-secret`} className="block w-full rounded-md border bg-background p-2 font-mono text-xs md:w-[28rem]" rows={5} autoComplete="off" spellCheck={false} placeholder={v.secretSet ? `set · …${v.secretLast4 ?? ''} — leave blank to keep` : '-----BEGIN PRIVATE KEY-----'} value={secret} onChange={(e) => { setSecret(e.target.value); setClear(false); }} />
            : <Input id={`w-${v.vendor}-secret`} type="password" autoComplete="new-password" className="md:w-96" placeholder={v.secretSet ? `set · …${v.secretLast4 ?? ''} — leave blank to keep` : 'Not set'} value={secret} onChange={(e) => { setSecret(e.target.value); setClear(false); }} />}
          {v.secretSet && <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={clear} onChange={(e) => { setClear(e.target.checked); setSecret(''); }} />Remove the saved {h.secret.toLowerCase()}</label>}
          <p className="text-xs text-muted-foreground">Stored encrypted on this server and never shown again. Changes are audited; the credential never is.</p>
        </div>
        <Button disabled={save.isPending} onClick={() => save.mutate()}>{`Save${reauthSuffix(ask)}`}</Button>
        <p className="text-xs text-muted-foreground" data-testid={`warranty-last-${v.vendor}`}>Last lookup: {v.lastResultAt ? `${new Date(v.lastResultAt).toLocaleString()} — ${v.lastResult === 'OK' ? 'a warranty was found' : `${lookupResultText(v.lastResult)} (${v.lastResult})`}` : 'never'}.</p>
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
              <p>Each computer with no warranty date says why on its Warranty &amp; support card and in <Link href="/reports/warranty" className="underline">Reports → Warranty</Link>.</p>
            </CardContent>
          </Card>
          {data.vendors.map((v) => (
            <VendorCard key={`${v.vendor}-${v.updatedAt ?? ''}`} v={v} onSaved={(text) => setNotice({ ok: true, text })} onError={(e) => setNotice({ ok: false, text: apiError(e).message })} />
          ))}
          <Card data-testid="warranty-manual-only">
            <CardHeader><CardTitle className="text-sm">No lookup: dates are entered by hand</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              {data.manualOnly.map((m) => (
                <p key={m.vendor} className="text-muted-foreground"><span className="font-medium text-foreground">{m.label}.</span> {m.reason}</p>
              ))}
              <p className="text-xs text-muted-foreground">For these, enter the dates on the computer’s Warranty &amp; support card; its support links open the vendor’s own warranty page.</p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
