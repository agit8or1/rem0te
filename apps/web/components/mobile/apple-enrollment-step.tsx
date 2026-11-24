'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import { businessesApi, mdmAppleApi, mdmSetupApi } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiError } from '@/components/security-controls/shared';
import { reauthSuffix, useAsks } from '@/lib/confirm-policy';

/**
 * Settings → Mobile devices, Apple step 6 (0.84 Harbor; docs/own-mdm.md M2).
 *
 * Upload the device CA's public certificates (root and intermediate, from
 * deploy/mdm-ca/rem0te-mdm-ca-setup.sh) and the profile-signing certificate
 * and key it issued; then make a one-time enrollment link for a business and
 * open it on a test iPhone or iPad. The link is shown once. Enrolled devices
 * are listed with their last check-in, push and inventory. Nothing here
 * calls Apple: pushes go from the MDM sweep, and none has reached a real
 * device from this server yet.
 */
export interface AppleStep6View {
  deviceCa: { present: boolean; rootSha256?: string; notAfter?: string; setAt?: string; intermediates?: number };
  profileSigner: { present: boolean; sha256?: string; notAfter?: string; setAt?: string };
  enrollment: { devicesEnrolled: number; pushProven: boolean; lastCheckInAt: string | null };
}
interface Link { id: string; businessName: string; state: string; createdAt: string; expiresAt: string; usedAt: string | null; device: { id: string; state: string; deviceName: string | null } | null }
interface Device {
  id: string; businessName: string; state: string; platform: string; deviceName: string | null; productName: string | null; osVersion: string | null;
  serialNumber: string | null; enrolledAt: string | null; lastSeenAt: string | null; lastPushAt: string | null; lastPushOkAt: string | null; lastPushResult: string | null;
  lastInventoryAt: string | null; signatureDigest: string; commands: { requestType: string; state: string; errorCode: string | null }[];
}

const when = (s?: string | null) => (s ? new Date(s).toLocaleString() : '—');
async function fileText(f: File): Promise<string> { if (f.size > 512 * 1024) throw new Error('That file is too large to be a certificate or key.'); return f.text(); }

function Pick({ id, label, accept, onFile, testId }: { id: string; label: string; accept: string; onFile: (f: File | null) => void; testId?: string }) {
  return (
    <div className="min-w-0 space-y-1">
      <Label htmlFor={id} className="text-xs">{label}</Label>
      <Input id={id} type="file" accept={accept} className="max-w-full" data-testid={testId} onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
    </div>
  );
}

export function AppleEnrollmentStep({ view, ask, onView, onNote }: {
  view: AppleStep6View; ask: boolean; onView: (v: unknown) => void; onNote: (n: { ok: boolean; text: string }) => void;
}) {
  const qc = useQueryClient();
  const askEnroll = useAsks('mdm.enroll');
  const [ca, setCa] = useState<{ root?: File; mid?: File }>({});
  const [sg, setSg] = useState<{ cert?: File; key?: File; chain?: File; passphrase: string }>({ passphrase: '' });
  const [biz, setBiz] = useState('');
  const [minutes, setMinutes] = useState(60);
  const [shown, setShown] = useState<{ url: string; businessName: string; expiresAt: string } | null>(null);
  const ready = view.deviceCa.present && view.profileSigner.present;

  const businesses = useQuery({
    queryKey: ['businesses-min'],
    queryFn: () => businessesApi.list().then((r) => ((r.data as { data?: { id: string; name: string }[] })?.data ?? [])),
  });
  const links = useQuery<Link[]>({ queryKey: ['mdm-apple-links'], queryFn: () => mdmAppleApi.links().then((r) => r.data.data as Link[]), enabled: ready, retry: false });
  const devices = useQuery<Device[]>({ queryKey: ['mdm-apple-devices'], queryFn: () => mdmAppleApi.devices().then((r) => r.data.data as Device[]), retry: false, refetchInterval: 30_000 });

  const fail = (e: unknown) => onNote({ ok: false, text: e instanceof Error && !('response' in e) ? e.message : apiError(e).message });
  const save = useMutation({
    mutationFn: async (job: { run: () => Promise<{ data: { data: unknown } }>; ok: string }) => ({ r: await job.run(), ok: job.ok }),
    onSuccess: ({ r, ok }) => { onView(r.data.data); onNote({ ok: true, text: ok }); },
    onError: fail,
  });
  const create = useMutation({
    mutationFn: () => mdmAppleApi.createLink({ businessId: biz, expiresInMinutes: minutes }).then((r) => r.data.data as { url: string; businessName: string; expiresAt: string }),
    onSuccess: (d) => { setShown(d); void qc.invalidateQueries({ queryKey: ['mdm-apple-links'] }); },
    onError: fail,
  });
  const revoke = useMutation({
    mutationFn: (id: string) => mdmAppleApi.revokeLink(id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['mdm-apple-links'] }); onNote({ ok: true, text: 'Link revoked.' }); },
    onError: fail,
  });

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground">
        Each iPhone or iPad proves who it is with a certificate from Rem0te&apos;s own device CA (step-ca, installed on this server by <code>deploy/mdm-ca/rem0te-mdm-ca-setup.sh</code>), obtained over ACME with Apple&apos;s attestation. The CA&apos;s key stays with the CA: upload only its public certificates here, and the profile-signing certificate and key it issued.
      </p>

      <div className="space-y-2 rounded-md border p-3" data-testid="mdm-apple-deviceca">
        <p className="font-medium">a. Device CA (public certificates)</p>
        <p className="text-xs text-muted-foreground">Rem0te checks: the root is a self-signed CA, unexpired; every intermediate is a CA issued by it; at most three. It cannot check that this is the CA your devices will use: the first enrollment proves that.</p>
        {view.deviceCa.present ? (
          <div className="space-y-1 text-xs" data-testid="mdm-deviceca-facts">
            <p>Root SHA-256 <span className="break-all font-mono">{view.deviceCa.rootSha256}</span></p>
            <p>Expires {when(view.deviceCa.notAfter)}; {view.deviceCa.intermediates} intermediate{view.deviceCa.intermediates === 1 ? '' : 's'}; uploaded {when(view.deviceCa.setAt)}</p>
            <Button size="sm" variant="ghost" className="text-destructive" disabled={save.isPending} data-testid="mdm-deviceca-delete"
              onClick={() => save.mutate({ run: () => mdmSetupApi.deleteDeviceCa(), ok: 'Device CA removed. Enrolled devices can no longer be verified until it is uploaded again.' })}>Remove</Button>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Pick id="ca-root" label="Root (root_ca.crt)" accept=".crt,.pem,.cer" testId="mdm-deviceca-root" onFile={(f) => setCa({ ...ca, root: f ?? undefined })} />
            <Pick id="ca-mid" label="Intermediate (intermediate_ca.crt)" accept=".crt,.pem,.cer" testId="mdm-deviceca-mid" onFile={(f) => setCa({ ...ca, mid: f ?? undefined })} />
            <div className="sm:col-span-2">
              <Button size="sm" disabled={!ca.root || save.isPending} data-testid="mdm-deviceca-upload"
                onClick={() => save.mutate({ run: async () => mdmSetupApi.deviceCa({ root: await fileText(ca.root!), ...(ca.mid ? { intermediates: await fileText(ca.mid) } : {}) }), ok: 'Device CA checked and saved.' })}>{`Check and save${reauthSuffix(ask)}`}</Button>
            </div>
          </div>
        )}
      </div>

      <div className="space-y-2 rounded-md border p-3" data-testid="mdm-apple-signer">
        <p className="font-medium">b. Enrollment profile signer</p>
        <p className="text-xs text-muted-foreground">Rem0te checks: the key matches the certificate, the certificate is not a CA and is unexpired; the key is sealed and never shown again. It cannot check how iOS will show the signer: a certificate from your own CA shows as &quot;Not verified&quot; on the device, which is expected.</p>
        {view.profileSigner.present ? (
          <div className="space-y-1 text-xs" data-testid="mdm-signer-facts">
            <p>Certificate SHA-256 <span className="break-all font-mono">{view.profileSigner.sha256}</span></p>
            <p>Expires {when(view.profileSigner.notAfter)}; uploaded {when(view.profileSigner.setAt)}</p>
            <Button size="sm" variant="ghost" className="text-destructive" disabled={save.isPending} data-testid="mdm-signer-delete"
              onClick={() => save.mutate({ run: () => mdmSetupApi.deleteProfileSigner(), ok: 'Profile signer removed. No new enrollment link can be used until one is uploaded.' })}>Remove</Button>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Pick id="sg-cert" label="Certificate (profile_signer.crt)" accept=".crt,.pem,.cer" testId="mdm-signer-cert" onFile={(f) => setSg({ ...sg, cert: f ?? undefined })} />
            <Pick id="sg-key" label="Private key (profile-signer.key)" accept=".key,.pem" testId="mdm-signer-key" onFile={(f) => setSg({ ...sg, key: f ?? undefined })} />
            <Pick id="sg-chain" label="Chain (intermediate_ca.crt, optional)" accept=".crt,.pem,.cer" onFile={(f) => setSg({ ...sg, chain: f ?? undefined })} />
            <div className="min-w-0 space-y-1">
              <Label htmlFor="sg-pass" className="text-xs">Key passphrase (if encrypted; used once, not kept)</Label>
              <Input id="sg-pass" type="password" autoComplete="off" value={sg.passphrase} onChange={(e) => setSg({ ...sg, passphrase: e.target.value })} />
            </div>
            <div className="sm:col-span-2">
              <Button size="sm" disabled={!sg.cert || !sg.key || save.isPending} data-testid="mdm-signer-upload"
                onClick={() => save.mutate({
                  run: async () => {
                    const r = await mdmSetupApi.profileSigner({ certificate: await fileText(sg.cert!), privateKey: await fileText(sg.key!), ...(sg.chain ? { chain: await fileText(sg.chain) } : {}), ...(sg.passphrase ? { passphrase: sg.passphrase } : {}) });
                    setSg({ passphrase: '' });
                    return r;
                  },
                  ok: 'Profile signer checked and sealed. Delete the key file from your computer and from the CA\'s handoff folder.',
                })}>{`Check and save${reauthSuffix(ask)}`}</Button>
            </div>
          </div>
        )}
      </div>

      <div className="space-y-2 rounded-md border p-3" data-testid="mdm-apple-links">
        <p className="font-medium">c. One-time enrollment link</p>
        <p className="text-xs text-muted-foreground">A link enrolls one corporate device into one business, once, and expires (an hour by default; 15 minutes to 24 hours). Open it in Safari on the iPhone or iPad and install the profile in Settings. Rem0te checks: the device&apos;s certificate is from your device CA, every message is signed by it, the topic is your push certificate&apos;s, and the device runs iOS/iPadOS 16 or later. It cannot check who opens the link: treat it like a password.</p>
        {!ready ? <p className="text-xs text-muted-foreground">Upload the device CA and the profile signer first (a and b).</p> : (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-0 space-y-1">
                <Label htmlFor="ln-biz" className="text-xs">Business</Label>
                <select id="ln-biz" className="w-full max-w-xs rounded-md border bg-background p-2" value={biz} onChange={(e) => setBiz(e.target.value)} data-testid="mdm-link-business">
                  <option value="">Choose…</option>
                  {(businesses.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="ln-min" className="text-xs">Expires after (minutes)</Label>
                <Input id="ln-min" type="number" min={15} max={1440} className="w-28" value={minutes} onChange={(e) => setMinutes(Math.max(15, Math.min(1440, Number(e.target.value) || 60)))} />
              </div>
              <Button size="sm" disabled={!biz || create.isPending} onClick={() => { setShown(null); create.mutate(); }} data-testid="mdm-link-create">{`Create link${reauthSuffix(askEnroll)}`}</Button>
            </div>
            {shown && (
              <div className="space-y-1 rounded-md border-2 border-amber-500 bg-amber-500/10 p-3 text-xs" data-testid="mdm-link-shown">
                <p className="font-semibold">Shown once, for {shown.businessName}; expires {when(shown.expiresAt)}.</p>
                <p className="break-all font-mono" data-testid="mdm-link-url">{shown.url}</p>
                <Button size="sm" variant="outline" onClick={() => { void navigator.clipboard?.writeText(shown.url); onNote({ ok: true, text: 'Link copied.' }); }}><Copy className="mr-1 h-3 w-3" />Copy</Button>
              </div>
            )}
            {(links.data ?? []).length > 0 && (
              <ul className="space-y-1 text-xs" data-testid="mdm-link-list">
                {(links.data ?? []).slice(0, 20).map((l) => (
                  <li key={l.id} className="flex flex-wrap items-center gap-2" data-link-state={l.state}>
                    <span className="font-medium">{l.businessName}</span>
                    <span className="text-muted-foreground">{l.state}{l.state === 'open' ? `, expires ${when(l.expiresAt)}` : ''}{l.device ? ` — ${l.device.deviceName ?? 'device'} (${l.device.state})` : ''}</span>
                    {(l.state === 'open' || l.state === 'claimed') && <Button size="sm" variant="ghost" className="h-6 text-destructive" disabled={revoke.isPending} onClick={() => revoke.mutate(l.id)}>Revoke</Button>}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      <div className="space-y-2 rounded-md border p-3" data-testid="mdm-apple-devices">
        <p className="font-medium">d. Enrolled iPhones and iPads</p>
        <p className="text-xs text-muted-foreground">
          {view.enrollment.devicesEnrolled} enrolled{view.enrollment.lastCheckInAt ? `; last check-in ${when(view.enrollment.lastCheckInAt)}` : ''}. {view.enrollment.pushProven ? 'A push was answered by APNs and the device connected afterwards: the push certificate is proven.' : 'Not yet proven: no push has been answered by APNs and followed by the device connecting.'} Rem0te asks each device only for inventory (model, storage, security state, and counts of apps, profiles and certificates), once a day. It sends no lock, wipe or other command. Devices also appear under Mobile devices after the next sync.
        </p>
        {(devices.data ?? []).length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="text-left text-muted-foreground"><th className="p-1">Device</th><th className="p-1">Business</th><th className="p-1">State</th><th className="p-1">Last check-in</th><th className="p-1">Last push</th><th className="p-1">Inventory</th><th className="p-1">Signature</th></tr></thead>
              <tbody>
                {(devices.data ?? []).map((x) => (
                  <tr key={x.id} className="border-t" data-device-state={x.state}>
                    <td className="p-1">{x.deviceName ?? x.productName ?? 'Unnamed'}<br /><span className="text-muted-foreground">{x.productName} · {x.platform === 'ipados' ? 'iPadOS' : 'iOS'} {x.osVersion}</span></td>
                    <td className="p-1">{x.businessName}</td>
                    <td className="p-1">{x.state.replace('_', ' ')}</td>
                    <td className="p-1">{when(x.lastSeenAt)}</td>
                    <td className="p-1">{x.lastPushResult ?? '—'}{x.lastPushAt ? ` (${when(x.lastPushAt)})` : ''}</td>
                    <td className="p-1">{when(x.lastInventoryAt)}{x.commands.some((c) => c.state === 'error') ? `; ${x.commands.filter((c) => c.state === 'error').length} not answered` : ''}</td>
                    <td className="p-1" data-testid="mdm-device-digest" title="The digest of the device's newest signed message. SHA-1 is accepted for now and will be revisited once real devices have checked in.">{x.signatureDigest.toUpperCase().replace('SHA', 'SHA-')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
