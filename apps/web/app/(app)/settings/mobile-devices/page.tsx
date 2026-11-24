'use client';

import { useCallback, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Download, ExternalLink } from 'lucide-react';
import { mdmSetupApi } from '@/lib/api-client';
import { usePermissions } from '@/lib/auth';
import { PageHeader } from '@/components/common/page-header';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiError } from '@/components/security-controls/shared';
import { confirmSentence, reauthSuffix, useAsks } from '@/lib/confirm-policy';
import { AppleEnrollmentStep, type AppleStep6View } from '@/components/mobile/apple-enrollment-step';
import { AndroidEnterpriseSteps, AndroidQuotaStep, AndroidTestStep, useAndroidReturnNote, type AndroidStepsView } from '@/components/mobile/android-emm-steps';

/**
 * Settings → Mobile devices (0.83 Beacon; docs/own-mdm.md M1, docs/mobile-devices.md).
 *
 * The own MDM's setup, platform-wide (decision 23: one Apple push certificate
 * per install), Platform Admin only. Apple: the prerequisites, the push key
 * and CSR made and sealed in Rem0te, signing with the owner's MDM vendor
 * certificate (decision 22; mdmcert.download only for a first test device),
 * the push certificate's checks (key, topic, expiry), renewal with the same
 * topic. Android: the prerequisites and the service-account key. Every step
 * says what Rem0te checks and what it cannot, and every capability is in one
 * of the four states. The links open Apple's and Google's pages in a new tab.
 *
 * 0.84 Harbor adds step 6 (docs/own-mdm.md M2): the device CA, the profile
 * signer, one-time enrollment links and the enrolled devices.
 *
 * 0.85 Mooring adds Android steps 3 to 6 (docs/own-mdm.md M3): the
 * connection test, the recorded quota, each business's enterprise sign-up,
 * the default policy and one-time enrollment tokens. Those steps call
 * Google from the server (components/mobile/android-emm-steps.tsx); the
 * Apple steps still call nothing.
 */
type State = 'available' | 'requires_setup' | 'unsupported' | 'planned';
interface Cap { key: string; platform: 'apple' | 'android'; label: string; state: State; reason: string }
interface View {
  revision: number;
  apple: {
    state: { state: State; reason: string };
    checklist: string[];
    signingRoute: 'own_vendor' | 'mdmcert' | 'other_vendor' | null;
    pushKey: { present: boolean; createdAt?: string; publicKeySha256?: string };
    vendor: { present: boolean; subject?: string; issuer?: string; notAfter?: string; setAt?: string; expired?: boolean; rootSubject?: string; rootSha256?: string };
    pushCertificate: { present: boolean; topic?: string; serial?: string; sha256?: string; issuer?: string; notBefore?: string; notAfter?: string; installedAt?: string; renewedAt?: string | null; daysLeft?: number; expired?: boolean; proven?: boolean };
    topic: string | null;
    appleAccount: string | null;
    devicesOnTopic: number;
    reminders: { days: number[]; lastSent: number | null; sweep: boolean; heldByPause: boolean };
  } & AppleStep6View;
  android: {
    state: { state: State; reason: string };
    checklist: string[];
    serviceAccount: { present: boolean; projectId?: string; clientEmail?: string; keyIdLast4?: string; setAt?: string };
  } & Omit<AndroidStepsView, 'serviceAccount'>;
  capabilities: Cap[];
}

const STATE: Record<State, { label: string; cls: string }> = {
  available: { label: 'Available', cls: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300' },
  requires_setup: { label: 'Requires setup', cls: 'border-amber-500/50 bg-amber-500/10 text-amber-900 dark:text-amber-200' },
  planned: { label: 'Planned', cls: 'border-sky-500/50 bg-sky-500/10 text-sky-900 dark:text-sky-200' },
  unsupported: { label: 'Unsupported', cls: 'border-muted-foreground/40 bg-muted text-muted-foreground' },
};
const day = (s?: string | null) => (s ? new Date(s).toLocaleDateString() : '—');

const APPLE_ITEMS: { key: string; title: string; detail: string; cost: string; lead: string; links: { href: string; label: string }[] }[] = [
  { key: 'duns', title: 'A D-U-N-S number for your organization', detail: 'Apple uses it to verify the organization for the Developer Program and Apple Business Manager.', cost: 'Free', lead: 'Up to 5 business days, then up to 2 more for Apple to receive it',
    links: [{ href: 'https://developer.apple.com/support/D-U-N-S/', label: 'Apple: D-U-N-S' }] },
  { key: 'developer_org', title: 'Apple Developer Program, as an organization', detail: 'The Account Holder must be able to sign for the organization. An individual membership cannot request the MDM permission.', cost: '99 USD a year', lead: "Apple's verification: not published",
    links: [{ href: 'https://developer.apple.com/programs/enroll/', label: 'Apple: Enroll' }] },
  { key: 'mdm_csr_permission', title: 'The "MDM CSR" permission (MDM Vendor CSR Signing Certificate)', detail: 'The Account Holder asks Apple for it. Once granted, "MDM CSR" appears under Certificates in your developer account. Ask as soon as the membership exists.', cost: 'Included', lead: 'Granted on request; no published criteria or lead time',
    links: [{ href: 'https://developer.apple.com/help/account/certificates/mdm-vendor-csr-signing-certificate', label: 'Apple: MDM Vendor CSR Signing Certificate' }] },
  { key: 'company_apple_account', title: 'A company Apple Account to own the push certificate', detail: "A Managed Apple Account, or a shared company account — never a person's own. The same account must renew the certificate every year.", cost: 'Free', lead: 'Minutes',
    links: [{ href: 'https://support.apple.com/guide/deployment/dep2de55389a/web', label: 'Apple: push certificates' }] },
];
const ANDROID_ITEMS: { key: string; title: string; detail: string; links: { href: string; label: string }[] }[] = [
  { key: 'google_account', title: 'A Google account per customer business', detail: "Each business binds its own enterprise, ideally with a work-domain account (a managed Google domain), not a person's Gmail. One Gmail can bind only one enterprise.", links: [{ href: 'https://developers.google.com/android/management/quickstart', label: 'Google: Quickstart' }] },
  { key: 'cloud_project', title: 'A Google Cloud project with the Android Management API enabled', detail: 'One project for this Rem0te install.', links: [{ href: 'https://console.cloud.google.com/', label: 'Google Cloud console' }] },
  { key: 'service_account', title: 'A service account with the Android Management User role, and a JSON key', detail: 'Role roles/androidmanagement.user. Create a key of type JSON and keep the file safe until step 2.', links: [{ href: 'https://developers.google.com/android/management/service-account', label: 'Google: Service account' }] },
  { key: 'quota_request', title: 'Device quota from Google', detail: 'Up to 500 devices needs a full business justification; more needs an Android Enterprise application. Reviews have been reported to take weeks: ask early.', links: [{ href: 'https://developers.google.com/android/management/permissible-usage', label: 'Google: Permissible usage and quota' }] },
  { key: 'permitted_use', title: "Google's permitted use (decision 21)", detail: "The Android Management API is for commercial EMM providers serving customers outside their own company; tools for a company's own in-house use are prohibited. Rem0te is an MSP platform used for its customers' devices under an agreement with each — describe it to Google exactly that way. It would not be permitted for the MSP's own staff phones alone.", links: [{ href: 'https://developers.google.com/android/management/permissible-usage', label: 'Google: Permissible usage' }] },
];

function Badge({ state, testId }: { state: State; testId?: string }) {
  return <span className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATE[state].cls}`} data-testid={testId} data-state={state}>{STATE[state].label}</span>;
}
function Ext({ href, children }: { href: string; children: ReactNode }) {
  return <a className="inline-flex items-center gap-1 underline underline-offset-2" href={href} target="_blank" rel="noopener noreferrer">{children}<ExternalLink className="h-3 w-3" /></a>;
}
function Step({ n, title, state, children, testId }: { n: number | string; title: string; state?: State; children: ReactNode; testId?: string }) {
  return (
    <li className="flex min-w-0 gap-3" data-testid={testId} data-state={state}>
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium">{n}</span>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2"><p className="font-medium">{title}</p>{state && <Badge state={state} />}</div>
        {children}
      </div>
    </li>
  );
}
function Checks({ auto, cannot }: { auto: string; cannot: string }) {
  return (
    <div className="grid gap-2 text-xs sm:grid-cols-2">
      <div className="rounded-md border bg-muted/40 p-2"><p className="font-medium">Rem0te checks</p><p className="text-muted-foreground">{auto}</p></div>
      <div className="rounded-md border bg-muted/40 p-2"><p className="font-medium">Rem0te cannot check</p><p className="text-muted-foreground">{cannot}</p></div>
    </div>
  );
}
function Fact({ k, v, mono }: { k: string; v: ReactNode; mono?: boolean }) {
  return <div className="flex min-w-0 flex-wrap gap-x-2"><span className="text-muted-foreground">{k}</span><span className={`min-w-0 break-all ${mono ? 'font-mono text-xs' : ''}`}>{v}</span></div>;
}

/** A certificate or key file as text: PEM as it is, anything else (Apple's DER .cer) as Base64. */
async function fileText(f: File): Promise<string> {
  const buf = new Uint8Array(await f.arrayBuffer());
  const text = new TextDecoder().decode(buf);
  if (/-----BEGIN /.test(text) || f.name.endsWith('.json')) return text;
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin);
}
function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function FilePick({ id, label, accept, onFile, name, testId }: { id: string; label: string; accept: string; onFile: (f: File | null) => void; name?: string; testId?: string }) {
  return (
    <div className="min-w-0 space-y-1">
      <Label htmlFor={id} className="text-xs">{label}</Label>
      <input id={id} type="file" accept={accept} data-testid={testId} className="block w-full min-w-0 text-xs file:mr-2 file:rounded-md file:border file:bg-background file:px-2 file:py-1 file:text-xs"
        onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
      {name && <p className="truncate text-xs text-muted-foreground">{name}</p>}
    </div>
  );
}

export default function MobileDeviceSettingsPage() {
  const { user, isPlatformAdmin } = usePermissions();
  const qc = useQueryClient();
  const ask = useAsks('mdm.setup');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  // 0.85: the note after Google's redirect back from an Android enterprise sign-up.
  useAndroidReturnNote(useCallback((n: { ok: boolean; text: string }) => setNote(n), []));
  const [appleTicks, setAppleTicks] = useState<string[] | null>(null);
  const [androidTicks, setAndroidTicks] = useState<string[] | null>(null);
  const [vendor, setVendor] = useState<{ cert?: File; key?: File; mid?: File; root?: File; passphrase: string }>({ passphrase: '' });
  const [push, setPush] = useState<{ cert?: File; account: string }>({ account: '' });
  const [topicChange, setTopicChange] = useState<{ incoming: string } | null>(null);
  const [ack, setAck] = useState(false);
  const [saFile, setSaFile] = useState<File | undefined>();
  const [confirm, setConfirm] = useState<null | 'pushCert' | 'pushKey' | 'vendor' | 'android' | 'replaceKey'>(null);

  const q = useQuery<View>({ queryKey: ['mdm-setup'], queryFn: () => mdmSetupApi.view().then((r) => r.data.data as View), enabled: isPlatformAdmin, retry: false });
  const done = (text: string) => (r: { data: { data: View } }) => { qc.setQueryData(['mdm-setup'], r.data.data); void qc.invalidateQueries({ queryKey: ['mobile-setup'] }); setNote({ ok: true, text }); setConfirm(null); };
  const onError = (e: unknown) => { setConfirm(null); const x = apiError(e); setNote({ ok: false, text: x.message }); };
  const m = useMutation({
    mutationFn: async (job: { run: () => Promise<{ data: { data: View } }>; ok: string }) => ({ r: await job.run(), ok: job.ok }),
    onSuccess: ({ r, ok }) => done(ok)(r),
    onError,
  });
  const setView = (v: unknown) => { qc.setQueryData(['mdm-setup'], v); void qc.invalidateQueries({ queryKey: ['mobile-setup'] }); };
  const run = (fn: () => Promise<unknown>, ok: string) => { setNote(null); m.mutate({ run: fn as () => Promise<{ data: { data: View } }>, ok }); };

  const csr = useMutation({
    mutationFn: () => mdmSetupApi.csr().then((r) => r.data.data as { filename: string; csr: string }),
    onSuccess: (d) => download(d.filename, d.csr), onError,
  });
  const signed = useMutation({
    mutationFn: () => mdmSetupApi.signRequest().then((r) => r.data.data as { filename: string; request: string }),
    onSuccess: (d) => { download(d.filename, d.request); setNote({ ok: true, text: 'Signed request downloaded. Upload it at identity.apple.com (step 4).' }); }, onError,
  });
  const uploadPush = useMutation({
    mutationFn: async (replace: boolean) => {
      const certificate = await fileText(push.cert!);
      const appleAccount = (push.account || q.data?.apple.appleAccount || '').trim();
      return (replace
        ? mdmSetupApi.replacePushCert({ certificate, appleAccount, currentTopic: q.data!.apple.topic!, acknowledgeReenroll: true })
        : mdmSetupApi.pushCert({ certificate, appleAccount })).then((r) => r.data.data as View & { installed: { op: string; topic: string } });
    },
    onSuccess: (d) => {
      qc.setQueryData(['mdm-setup'], d); void qc.invalidateQueries({ queryKey: ['mobile-setup'] });
      setTopicChange(null); setAck(false);
      setNote({ ok: true, text: d.installed.op === 'renew' ? 'Push certificate renewed: same topic, enrolled devices keep working.' : d.installed.op === 'replace' ? 'Push certificate replaced with a new topic. Every enrolled device must enroll again.' : 'Push certificate installed.' });
    },
    onError: (e) => {
      const x = apiError(e);
      if (x.code === 'APNS_TOPIC_CHANGED') setTopicChange({ incoming: x.message });
      setNote({ ok: false, text: x.message });
    },
  });

  if (!user) return null;
  if (!isPlatformAdmin) return <div className="p-6 text-sm text-muted-foreground">Mobile device management is set up by a Platform Admin.</div>;
  const d = q.data;
  const cap = (k: string) => d?.capabilities.find((c) => c.key === k);
  const capState = (k: string) => cap(k)?.state;
  const aTicks = appleTicks ?? d?.apple.checklist ?? [];
  const gTicks = androidTicks ?? d?.android.checklist ?? [];
  const route = d?.apple.signingRoute ?? 'own_vendor';
  const busy = m.isPending || uploadPush.isPending || signed.isPending;
  const pc = d?.apple.pushCertificate;

  return (
    <div className="max-w-4xl space-y-4 p-4 md:p-6" data-testid="mdm-settings">
      <Link href="/settings" className="inline-flex items-center text-sm text-muted-foreground hover:underline"><ArrowLeft className="mr-1 h-4 w-4" />Settings</Link>
      <PageHeader title="Mobile devices" description="Set up Rem0te as the MDM for iPhones and iPads, and the EMM for Android. This page prepares the credentials Apple and Google require. Apple's steps never contact Apple: the links open its pages, and you upload what it gives you. From step 3 on, Android's steps call Google's Android Management API from this server." />

      {note && <div className={`rounded-md border p-3 text-sm ${note.ok ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100' : 'border-destructive/40 bg-destructive/10 text-destructive'}`} data-testid="mdm-settings-note" role="status">{note.text}</div>}
      {q.error ? <p className="text-sm text-destructive">{apiError(q.error).message}</p> : null}
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {d && (
        <>
          <p className="text-xs text-muted-foreground" data-testid="mdm-settings-decisions">
            Decided by the owner (2026-11-21): one Apple push certificate for this whole install; signed with your own organization&apos;s MDM vendor certificate (mdmcert.download only for a first test device while Apple&apos;s permission is pending); iOS and iPadOS 16 or later; Android for customers&apos; devices. {confirmSentence(ask, 'Each change asks you to confirm it is you.')}
          </p>

          {/* ── Apple ───────────────────────────────────────────── */}
          <Card data-testid="mdm-apple">
            <CardHeader className="space-y-1">
              <div className="flex flex-wrap items-center gap-2"><CardTitle className="text-base">Apple: iPhone and iPad</CardTitle><Badge state={d.apple.state.state} testId="mdm-apple-state" /></div>
              <p className="text-sm text-muted-foreground">{d.apple.state.reason}</p>
            </CardHeader>
            <CardContent className="text-sm">
              <ol className="space-y-6">
                <Step n={1} title="Before you start" testId="mdm-apple-prereqs">
                  <p className="text-muted-foreground">What Apple requires before a push certificate can exist. Tick what you have done; the ticks are your own notes and Rem0te never treats them as checked.</p>
                  <ul className="space-y-2">
                    {APPLE_ITEMS.map((it) => (
                      <li key={it.key} className="rounded-md border p-3">
                        <label className="flex items-start gap-2">
                          <input type="checkbox" className="mt-1" checked={aTicks.includes(it.key)} data-testid={`mdm-apple-tick-${it.key}`}
                            onChange={(e) => setAppleTicks(e.target.checked ? [...aTicks, it.key] : aTicks.filter((x) => x !== it.key))} />
                          <span className="min-w-0"><span className="font-medium">{it.title}</span><br /><span className="text-muted-foreground">{it.detail}</span></span>
                        </label>
                        <p className="mt-1 pl-6 text-xs text-muted-foreground">Cost: {it.cost}. Lead time: {it.lead}. {it.links.map((l) => <Ext key={l.href} href={l.href}>{l.label}</Ext>)}</p>
                      </li>
                    ))}
                  </ul>
                  {appleTicks && <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => mdmSetupApi.checklist('apple', aTicks).then((r) => { setAppleTicks(null); return r; }), 'Checklist saved.')}>{`Save ticks${reauthSuffix(ask)}`}</Button>}
                </Step>

                <Step n={2} title="Generate the push request" state={capState('apple.push_request')} testId="mdm-apple-csr">
                  <p className="text-muted-foreground">Rem0te makes the push certificate&apos;s private key and its certificate signing request (CSR). The key is sealed inside Rem0te and never leaves it: Apple&apos;s rule is that the vendor who signs the request must not have it.</p>
                  <Checks auto="The key is RSA 2048 and sealed before anything is shown; the CSR verifies against it." cannot="Nothing: this step is entirely inside Rem0te." />
                  {d.apple.pushKey.present ? (
                    <div className="space-y-2">
                      <Fact k="Made" v={day(d.apple.pushKey.createdAt)} />
                      <Fact k="Public key SHA-256" v={d.apple.pushKey.publicKeySha256} mono />
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" onClick={() => csr.mutate()} disabled={csr.isPending} data-testid="mdm-csr-download"><Download className="mr-1 h-3.5 w-3.5" />Download CSR</Button>
                        {!pc?.present && <Button size="sm" variant="ghost" onClick={() => setConfirm('replaceKey')} data-testid="mdm-key-replace">Make a new key</Button>}
                        {!pc?.present && <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setConfirm('pushKey')}>Delete key</Button>}
                      </div>
                    </div>
                  ) : (
                    <Button size="sm" disabled={busy} onClick={() => run(() => mdmSetupApi.generateKey(), 'Push key generated and sealed. The request is ready.')} data-testid="mdm-generate">{`Generate${reauthSuffix(ask)}`}</Button>
                  )}
                </Step>

                <Step n={3} title="Sign the request" state={capState('apple.vendor_signing')} testId="mdm-apple-sign">
                  <div className="flex flex-wrap gap-3" role="radiogroup" aria-label="How the request is signed">
                    {([['own_vendor', 'My MDM vendor certificate (recommended)'], ['mdmcert', 'mdmcert.download (one test device only)'], ['other_vendor', 'Another MDM vendor']] as const).map(([v, l]) => (
                      <label key={v} className="flex items-center gap-1.5 text-sm">
                        <input type="radio" name="route" checked={route === v} disabled={busy} data-testid={`mdm-route-${v}`}
                          onChange={() => run(() => mdmSetupApi.signingRoute(v), 'Signing route saved.')} />{l}
                      </label>
                    ))}
                  </div>
                  {route === 'own_vendor' && (
                    <>
                      <p className="text-muted-foreground">
                        In your developer account, under Certificates, create an <strong>MDM CSR</strong> certificate (it appears once Apple grants the permission) and download it (<span className="font-mono">mdm.cer</span>). Export its private key from where you made its request (from a Mac&apos;s Keychain as a .p12, then <span className="font-mono">openssl pkcs12 -in vendor.p12 -nocerts -nodes -out vendor.key</span>). Download the Apple WWDR intermediate (G3) and the Apple Root CA from <Ext href="https://www.apple.com/certificateauthority/">Apple PKI</Ext>.
                      </p>
                      <Checks auto="The key is RSA and is the certificate's; the certificate is unexpired; it is signed by the intermediate, the intermediate by the root, the root by itself. The key is sealed. Rem0te then signs its request (SHA256withRSA) with the chain in Apple's order." cannot="That the root is really Apple's (compare the SHA-256 shown after upload with Apple's published one), or that Apple will accept the request." />
                      {d.apple.vendor.present ? (
                        <div className="space-y-2" data-testid="mdm-vendor">
                          <Fact k="Certificate" v={d.apple.vendor.subject} />
                          <Fact k="Root" v={d.apple.vendor.rootSubject} />
                          <Fact k="Root SHA-256 (compare with Apple's)" v={d.apple.vendor.rootSha256} mono />
                          <Fact k="Expires" v={<>{day(d.apple.vendor.notAfter)}{d.apple.vendor.expired && <span className="ml-1 text-destructive">(expired)</span>}</>} />
                          <div className="flex flex-wrap gap-2">
                            <Button size="sm" disabled={!d.apple.pushKey.present || signed.isPending || d.apple.vendor.expired} onClick={() => signed.mutate()} data-testid="mdm-sign-download"><Download className="mr-1 h-3.5 w-3.5" />{`Download signed request${reauthSuffix(ask)}`}</Button>
                            <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setConfirm('vendor')}>Remove vendor certificate</Button>
                          </div>
                        </div>
                      ) : (
                        <div className="grid gap-3 sm:grid-cols-2" data-testid="mdm-vendor-form">
                          <FilePick id="v-cert" label="MDM vendor certificate (mdm.cer or PEM)" accept=".cer,.pem,.crt,.der" onFile={(f) => setVendor({ ...vendor, cert: f ?? undefined })} />
                          <FilePick id="v-key" label="Its private key (PEM)" accept=".key,.pem" onFile={(f) => setVendor({ ...vendor, key: f ?? undefined })} />
                          <FilePick id="v-mid" label="Apple WWDR intermediate (G3)" accept=".cer,.pem,.crt,.der" onFile={(f) => setVendor({ ...vendor, mid: f ?? undefined })} />
                          <FilePick id="v-root" label="Apple Root CA" accept=".cer,.pem,.crt,.der" onFile={(f) => setVendor({ ...vendor, root: f ?? undefined })} />
                          <div className="space-y-1 sm:col-span-2">
                            <Label htmlFor="v-pass" className="text-xs">Key passphrase, if it has one (used once, not kept)</Label>
                            <Input id="v-pass" type="password" autoComplete="off" value={vendor.passphrase} onChange={(e) => setVendor({ ...vendor, passphrase: e.target.value })} />
                          </div>
                          <div className="sm:col-span-2">
                            <Button size="sm" disabled={busy || !vendor.cert || !vendor.key || !vendor.mid || !vendor.root} data-testid="mdm-vendor-upload"
                              onClick={() => run(async () => {
                                const toPem = async (f: File) => { const t = await fileText(f); return /-----BEGIN/.test(t) ? t : `-----BEGIN CERTIFICATE-----\n${t.replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`; };
                                const r = await mdmSetupApi.vendor({ certificate: await fileText(vendor.cert!), privateKey: await fileText(vendor.key!), chain: (await toPem(vendor.mid!)) + (await toPem(vendor.root!)), ...(vendor.passphrase ? { passphrase: vendor.passphrase } : {}) });
                                setVendor({ passphrase: '' });
                                return r;
                              }, 'Vendor certificate checked and sealed. Compare the root\'s SHA-256 below with the one Apple publishes.')}>{`Check and save${reauthSuffix(ask)}`}</Button>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                  {route === 'mdmcert' && (
                    <div className="space-y-2 rounded-md border border-destructive/50 bg-destructive/5 p-3" data-testid="mdm-mdmcert">
                      <p className="flex items-center gap-1 font-medium text-destructive"><AlertTriangle className="h-4 w-4" />For one test device only — never for the fleet</p>
                      <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                        <li>mdmcert.download signs your request with <strong>its</strong> vendor certificate. Someone else&apos;s certificate then stands behind every device you enroll.</li>
                        <li>Apple has said that on finding MDM abuse it may revoke the push certificate, the vendor certificate behind it, and the MDM CSR permission — so another customer&apos;s conduct could orphan your devices.</li>
                        <li>MicroMDM&apos;s own guide calls it &quot;for testing and development scenarios only&quot;. Its terms could not be read.</li>
                        <li>Moving later to your own vendor certificate is a new push certificate, which may mean a new topic and enrolling every device again. Test it with one device first.</li>
                      </ul>
                      <p className="text-muted-foreground">How: download Rem0te&apos;s CSR (step 2) and follow <Ext href="https://mdmcert.download/">mdmcert.download</Ext>&apos;s instructions (see the <Ext href="https://github.com/micromdm/micromdm/blob/main/docs/user-guide/quickstart.md">MicroMDM quickstart</Ext>). Its reply is encrypted to a certificate you give it; decrypt it on your own computer. Rem0te&apos;s push key never leaves Rem0te on this route either.</p>
                      <Checks auto="That the push certificate you upload in step 5 is for Rem0te's key." cannot="mdmcert.download's trustworthiness, or what it does with your request." />
                    </div>
                  )}
                  {route === 'other_vendor' && (
                    <p className="text-muted-foreground" data-testid="mdm-othervendor">Send another vendor Rem0te&apos;s CSR (step 2), never a key, and ask them for the signed request. Rem0te checks the certificate you get back in step 5.</p>
                  )}
                </Step>

                <Step n={4} title="Upload the request to Apple" testId="mdm-apple-upload">
                  <p className="text-muted-foreground">Sign in at <Ext href="https://identity.apple.com/pushcert">identity.apple.com/pushcert</Ext> with the <strong>company</strong> Apple Account, choose Create a Certificate, upload the signed request, and download the push certificate (a .pem). Write down which account you used: you type it in the next step, and Rem0te shows it at every renewal.</p>
                  <Checks auto="Nothing here: this happens at Apple." cannot="Which account you used. Rem0te records what you type." />
                </Step>

                <Step n={5} title="Upload the push certificate" state={capState('apple.push_certificate')} testId="mdm-apple-pushcert">
                  <Checks auto="Its public key is Rem0te's sealed push key; its topic starts com.apple.mgmt.External.; it is unexpired and already valid; a renewal keeps the same topic. The certificate is sealed; the topic is shown." cannot="That APNs accepts it: only a first push answered by APNs, followed by the device connecting (step 6), proves that. Until then it is shown as not yet proven." />
                  {pc?.present && (
                    <div className="space-y-1 rounded-md border p-3" data-testid="mdm-pushcert">
                      <Fact k="Topic" v={pc.topic} mono />
                      <Fact k="Expires" v={<>{day(pc.notAfter)} ({pc.expired ? 'expired' : `${pc.daysLeft} days`})</>} />
                      <Fact k="Apple Account" v={d.apple.appleAccount ?? '—'} />
                      <Fact k="Issuer" v={pc.issuer} />
                      <Fact k="Serial" v={pc.serial} mono />
                      <Fact k="Proven with a device" v={pc.proven ? 'Yes' : 'Not yet (step 6)'} />
                      <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setConfirm('pushCert')} data-testid="mdm-pushcert-delete">Delete push certificate</Button>
                    </div>
                  )}
                  {d.apple.pushKey.present ? (
                    <div className="grid gap-3 sm:grid-cols-2" data-testid="mdm-pushcert-form">
                      <FilePick id="p-cert" label={pc?.present ? 'Renewed push certificate (.pem)' : 'Push certificate (.pem)'} accept=".pem,.cer,.crt" testId="mdm-pushcert-file" onFile={(f) => { setPush({ ...push, cert: f ?? undefined }); setTopicChange(null); }} />
                      <div className="min-w-0 space-y-1">
                        <Label htmlFor="p-acct" className="text-xs">Apple Account that owns it</Label>
                        <Input id="p-acct" type="email" placeholder="mdm-push@yourcompany.example" value={push.account || (d.apple.appleAccount ?? '')} onChange={(e) => setPush({ ...push, account: e.target.value })} data-testid="mdm-pushcert-account" />
                      </div>
                      <div className="sm:col-span-2">
                        <Button size="sm" disabled={!push.cert || !(push.account || d.apple.appleAccount) || uploadPush.isPending} data-testid="mdm-pushcert-upload"
                          onClick={() => { setNote(null); uploadPush.mutate(false); }}>{`${pc?.present ? 'Check and renew' : 'Check and install'}${reauthSuffix(ask)}`}</Button>
                      </div>
                    </div>
                  ) : <p className="text-muted-foreground">Generate the push request first (step 2).</p>}
                  {topicChange && (
                    <div className="space-y-2 rounded-md border-2 border-destructive bg-destructive/10 p-3" data-testid="mdm-topic-change">
                      <p className="flex items-center gap-1 font-semibold text-destructive"><AlertTriangle className="h-4 w-4" />This certificate has a different topic</p>
                      <p>It was almost certainly made with a different Apple Account. Replacing the topic breaks every enrolled device ({d.apple.devicesOnTopic} now): each must enroll again. The right fix is usually to renew with the account that made the first certificate{d.apple.appleAccount ? ` (${d.apple.appleAccount})` : ''}.</p>
                      <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="mdm-topic-ack" /><span>I understand every enrolled device must enroll again.</span></label>
                      <Button size="sm" variant="destructive" disabled={!ack || uploadPush.isPending} onClick={() => uploadPush.mutate(true)} data-testid="mdm-topic-replace">{`Replace the topic${reauthSuffix(ask)}`}</Button>
                    </div>
                  )}
                </Step>

                <Step n={6} title="Enroll a test iPhone or iPad" state={capState('apple.enrollment')} testId="mdm-apple-enroll">
                  <AppleEnrollmentStep view={d.apple} ask={ask} onNote={setNote}
                    onView={(v) => { qc.setQueryData(['mdm-setup'], v); void qc.invalidateQueries({ queryKey: ['mobile-setup'] }); }} />
                </Step>

                <Step n={7} title="Renew every year — with the same Apple Account" state={capState('apple.renewal')} testId="mdm-apple-renewal">
                  <div className="flex items-start gap-2 rounded-md border-2 border-amber-500 bg-amber-500/10 p-3 text-amber-950 dark:text-amber-100" data-testid="mdm-renewal-warning">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <p><strong>Renew with the same Apple Account{d.apple.appleAccount ? ` (${d.apple.appleAccount})` : ''}.</strong> A certificate made with a different account has a different topic, and every enrolled iPhone and iPad would stop being managed until it enrolls again. Rem0te refuses such a certificate on renewal. At identity.apple.com, choose Renew next to the existing certificate and upload the same signed request (or a fresh one from step 3: it uses the same key).</p>
                  </div>
                  <p className="text-muted-foreground">
                    {pc?.present ? <>Expires {day(pc.notAfter)} ({pc.expired ? 'expired' : `${pc.daysLeft} days left`}). </> : 'No certificate yet. '}
                    Reminders are raised {d.apple.reminders.days.join(', ')} days before expiry, and once on expiry, as security alerts (Settings → Security → alerts), delivered to the platform&apos;s alert destinations.
                    {d.apple.reminders.lastSent !== null && ` Last reminder: ${d.apple.reminders.lastSent === 0 ? 'expired' : `${d.apple.reminders.lastSent} days`}.`}
                  </p>
                  {!d.apple.reminders.sweep && <p className="text-xs text-destructive">The MDM sweep is off on this server (MDM_SWEEP=off), so no reminder will be raised.</p>}
                  {d.apple.reminders.heldByPause && <p className="text-xs text-amber-800 dark:text-amber-200">A notifications pause is in effect: reminders are held until it is lifted.</p>}
                </Step>

                <Step n={8} title="Apple Business Manager (optional)" state="planned" testId="mdm-apple-abm">
                  <p className="text-muted-foreground">For supervised, automated enrollment of devices a business buys. Uploading the ABM server token arrives in M6.</p>
                </Step>
              </ol>
            </CardContent>
          </Card>

          {/* ── Android ─────────────────────────────────────────── */}
          <Card data-testid="mdm-android">
            <CardHeader className="space-y-1">
              <div className="flex flex-wrap items-center gap-2"><CardTitle className="text-base">Android</CardTitle><Badge state={d.android.state.state} testId="mdm-android-state" /></div>
              <p className="text-sm text-muted-foreground">{d.android.state.reason}</p>
            </CardHeader>
            <CardContent className="text-sm">
              <ol className="space-y-6">
                <Step n={1} title="Before you start" testId="mdm-android-prereqs">
                  <p className="text-muted-foreground">Google&apos;s Android Device Policy is the app on each phone; Rem0te drives it through the Android Management API. Tick what you have done; the ticks are notes, never checks.</p>
                  <ul className="space-y-2">
                    {ANDROID_ITEMS.map((it) => (
                      <li key={it.key} className="rounded-md border p-3" data-testid={it.key === 'permitted_use' ? 'mdm-android-permitted-use' : undefined}>
                        <label className="flex items-start gap-2">
                          <input type="checkbox" className="mt-1" checked={gTicks.includes(it.key)} data-testid={`mdm-android-tick-${it.key}`}
                            onChange={(e) => setAndroidTicks(e.target.checked ? [...gTicks, it.key] : gTicks.filter((x) => x !== it.key))} />
                          <span className="min-w-0"><span className="font-medium">{it.title}</span><br /><span className="text-muted-foreground">{it.detail}</span></span>
                        </label>
                        <p className="mt-1 pl-6 text-xs text-muted-foreground">{it.links.map((l) => <Ext key={l.label} href={l.href}>{l.label}</Ext>)}</p>
                      </li>
                    ))}
                  </ul>
                  {androidTicks && <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => mdmSetupApi.checklist('android', gTicks).then((r) => { setAndroidTicks(null); return r; }), 'Checklist saved.')}>{`Save ticks${reauthSuffix(ask)}`}</Button>}
                </Step>

                <Step n={2} title="Upload the service-account key" state={capState('android.service_account')} testId="mdm-android-key">
                  <Checks auto={'It is a service-account key ("type": "service_account"), names a project and that project\'s service-account e-mail, has a key id, and its private key loads. Only those fields are kept, sealed; afterwards only the project, the e-mail and the key id\'s last four are shown.'} cannot="That the account has the Android Management User role, or that the project has quota: the connection test (step 3) checks the role; nothing can check quota." />
                  {d.android.serviceAccount.present ? (
                    <div className="space-y-1 rounded-md border p-3" data-testid="mdm-android-sa">
                      <Fact k="Project" v={d.android.serviceAccount.projectId} mono />
                      <Fact k="Service account" v={d.android.serviceAccount.clientEmail} mono />
                      <Fact k="Key id ends" v={`…${d.android.serviceAccount.keyIdLast4}`} mono />
                      <Fact k="Uploaded" v={day(d.android.serviceAccount.setAt)} />
                      <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setConfirm('android')}>Delete key</Button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-end gap-3" data-testid="mdm-android-form">
                      <FilePick id="g-key" label="Key file (.json)" accept=".json,application/json" onFile={(f) => setSaFile(f ?? undefined)} />
                      <Button size="sm" disabled={!saFile || busy} data-testid="mdm-android-upload"
                        onClick={() => run(async () => { const r = await mdmSetupApi.androidKey(await saFile!.text()); setSaFile(undefined); return r; }, 'Service-account key checked and sealed. Delete the downloaded file from your computer.')}>{`Check and save${reauthSuffix(ask)}`}</Button>
                    </div>
                  )}
                </Step>

                <Step n={3} title="Test the connection to Google" state={capState('android.connection_test')} testId="mdm-android-step-test">
                  <AndroidTestStep view={d.android} ask={ask} onNote={setNote} onView={setView} />
                </Step>

                <Step n={4} title="Record the device quota" state={capState('android.quota')} testId="mdm-android-step-quota">
                  <AndroidQuotaStep view={d.android} ask={ask} onNote={setNote} onView={setView} />
                </Step>

                <Step n={5} title="Bind a business to its Android enterprise" state={capState('android.enterprise')} testId="mdm-android-step-signup">
                  <AndroidEnterpriseSteps part="signup" view={d.android} ask={ask} onNote={setNote} />
                </Step>

                <Step n={6} title="Default policy and enrollment tokens" state={capState('android.enrollment')} testId="mdm-android-step-enroll">
                  <AndroidEnterpriseSteps part="enroll" view={d.android} ask={ask} onNote={setNote} />
                </Step>

              </ol>
              <p className="mt-4 text-xs text-muted-foreground" data-testid="mdm-android-not-proven">Tested only against a stand-in for Google&apos;s Android Management API: no real Google API has been called from this server, no enterprise has been created and no device has enrolled.</p>
            </CardContent>
          </Card>

          <Card data-testid="mdm-capabilities">
            <CardHeader><CardTitle className="text-sm">What works now</CardTitle></CardHeader>
            <CardContent>
              <ul className="space-y-2 text-sm">
                {d.capabilities.map((c) => (
                  <li key={c.key} className="flex min-w-0 flex-wrap items-start gap-2" data-capability={c.key} data-state={c.state}>
                    <Badge state={c.state} />
                    <span className="min-w-0 flex-1"><span className="font-medium">{c.platform === 'apple' ? 'Apple' : 'Android'}: {c.label}.</span> <span className="text-muted-foreground">{c.reason}</span></span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-muted-foreground">More: <Link className="underline" href="/docs/mobile-devices">Mobile devices</Link> and <Link className="underline" href="/docs/own-mdm">Rem0te as its own MDM</Link>.</p>
            </CardContent>
          </Card>
        </>
      )}

      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => { if (!o) setConfirm(null); }}
        title={{ pushCert: 'Delete the push certificate?', pushKey: 'Delete the push key?', vendor: 'Remove the vendor certificate?', android: 'Delete the service-account key?', replaceKey: 'Make a new push key?' }[confirm ?? 'pushCert']}
        description={{
          pushCert: `Every enrolled iPhone and iPad (${d?.apple.devicesOnTopic ?? 0} now) is orphaned: Rem0te can no longer wake it. The topic is kept, so the next certificate must have the same one. This does not ask you to confirm it is you, and it is audited.`,
          pushKey: 'The key and its request are deleted. A request already sent to Apple can no longer be used.',
          vendor: 'Its sealed key is deleted. You can upload it again to sign another request.',
          android: 'The sealed key is deleted. Delete the key in Google Cloud too if it is no longer needed.',
          replaceKey: `A new key and request replace the current ones; a signed request you made from the old one can no longer be used. ${confirmSentence(ask)}`,
        }[confirm ?? 'pushCert']}
        confirmLabel={confirm === 'replaceKey' ? 'Make a new key' : 'Delete'}
        destructive
        loading={m.isPending}
        onConfirm={() => {
          if (confirm === 'pushCert') run(() => mdmSetupApi.deletePushCert(), 'Push certificate deleted.');
          else if (confirm === 'pushKey') run(() => mdmSetupApi.deleteKey(), 'Push key deleted.');
          else if (confirm === 'vendor') run(() => mdmSetupApi.deleteVendor(), 'Vendor certificate removed.');
          else if (confirm === 'android') run(() => mdmSetupApi.deleteAndroidKey(), 'Service-account key deleted.');
          else if (confirm === 'replaceKey') run(() => mdmSetupApi.generateKey(true), 'New push key generated. Download the new request.');
        }}
      />
    </div>
  );
}
