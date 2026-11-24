'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, ExternalLink } from 'lucide-react';
import { businessesApi, mdmAndroidApi, mdmSetupApi } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiError } from '@/components/security-controls/shared';
import { reauthSuffix, useAsks } from '@/lib/confirm-policy';

/**
 * Settings → Mobile devices, Android steps 3 to 6 (0.85 Mooring;
 * docs/own-mdm.md M3). The server calls Google's Android Management API;
 * this page never does. The only Google address built here is the
 * enrollment link a person opens on the phone, from a token value shown
 * once. No real Google API has been called from this server, no enterprise
 * has been created and no device has enrolled.
 */
export interface AndroidStepsView {
  serviceAccount: { present: boolean };
  connectionTest: { result: string; testedAt: string } | null;
  quota: { devices: number; setAt: string } | null;
  enterprises: number;
  devicesEnrolled: number;
}
interface Enterprise { id: string; customerId: string; businessName: string; enterpriseId: string; boundAt: string; policyVersion: string | null; policySetAt: string | null; devicesEnrolled: number }
interface Signup { id: string; customerId: string; businessName: string; state: string; createdAt: string; expiresAt: string; failureCode: string | null }
interface AndroidView { enterprises: Enterprise[]; signups: Signup[]; tokenMinutes: { min: number; max: number; default: number } }
interface Shown { businessName: string; personalUsage: 'allowed' | 'disallowed'; expiresAt: string; value: string; qrDataUrl: string }

const when = (s?: string | null) => (s ? new Date(s).toLocaleString() : '—');
/** The Android enrollment link for a token value (Google's documented form). Built here so the API names no Google host but its own two. */
export const enrollLink = (value: string) => `https://enterprise.google.com/android/enroll?et=${encodeURIComponent(value)}`;

/** What the callback's codes mean, for the note after Google sends the admin back (android-emm.service.ts SIGNUP_FAILURES). */
const SIGNUP_NOTE: Record<string, string> = {
  signup_not_found: 'That sign-up link is unknown, already used or expired. Start again.',
  admin_gone: 'The Platform Admin who started the sign-up is no longer an active Platform Admin.',
  already_bound: 'That business already has an Android enterprise.',
  paused: 'An integration pause is in effect for that business: nothing was sent to Google.',
  no_key: 'The service-account key is no longer sealed in Rem0te.',
  bad_token: 'Google\'s answer did not carry a usable enterprise token.',
  google_refused: 'Google refused to create the enterprise.',
  google_unreachable: 'Google could not be reached to create the enterprise. Start again.',
  google_bad_response: 'Google answered something Rem0te did not expect.',
  enterprise_taken: 'Google returned an enterprise already bound to another business.',
};

type Note = (n: { ok: boolean; text: string }) => void;

/** Reads `?android=…` once, after Google's redirect, and clears it from the address bar. */
export function useAndroidReturnNote(onNote: Note) {
  useEffect(() => {
    const u = new URL(window.location.href);
    const a = u.searchParams.get('android');
    if (!a) return;
    if (a === 'bound') onNote({ ok: true, text: u.searchParams.get('policy') === 'set' ? 'The business is bound to its Android enterprise and the default policy is applied.' : 'The business is bound to its Android enterprise. Apply the default policy (step 6) before making a token.' });
    else onNote({ ok: false, text: `The Android sign-up did not finish: ${SIGNUP_NOTE[u.searchParams.get('code') ?? ''] ?? 'unknown reason.'}` });
    ['android', 'code', 'business', 'policy'].forEach((k) => u.searchParams.delete(k));
    window.history.replaceState(null, '', u.pathname + (u.search || ''));
  }, [onNote]);
}

export function AndroidTestStep({ view, ask, onView, onNote }: { view: AndroidStepsView; ask: boolean; onView: (v: unknown) => void; onNote: Note }) {
  const t = useMutation({
    mutationFn: () => mdmAndroidApi.test().then((r) => r.data.data as { result: string; message: string; setup: unknown }),
    onSuccess: (d) => { onView(d.setup); onNote({ ok: d.result === 'ok', text: d.message }); },
    onError: (e) => onNote({ ok: false, text: apiError(e).message }),
  });
  return (
    <div className="space-y-2" data-testid="mdm-android-test">
      <p className="text-muted-foreground">Rem0te signs a token request with the sealed key, exchanges it at Google for an Android Management token, and makes one read call. It checks the key and the role. It cannot check quota: Google has no call that reports it.</p>
      {view.connectionTest && (
        <p className="text-xs" data-testid="mdm-android-test-result" data-result={view.connectionTest.result}>
          Last test {when(view.connectionTest.testedAt)}: <span className="font-medium">{view.connectionTest.result === 'ok' ? 'passed' : view.connectionTest.result.replace(/_/g, ' ')}</span>
        </p>
      )}
      <Button size="sm" disabled={!view.serviceAccount.present || t.isPending} onClick={() => t.mutate()} data-testid="mdm-android-test-run">{`Test the connection${reauthSuffix(ask)}`}</Button>
      {!view.serviceAccount.present && <p className="text-xs text-muted-foreground">Upload the key first (step 2).</p>}
    </div>
  );
}

export function AndroidQuotaStep({ view, ask, onView, onNote }: { view: AndroidStepsView; ask: boolean; onView: (v: unknown) => void; onNote: Note }) {
  const [n, setN] = useState<string>(view.quota ? String(view.quota.devices) : '');
  const save = useMutation({
    mutationFn: (v: number | null) => mdmSetupApi.androidQuota(v).then((r) => r.data.data),
    onSuccess: (d) => { onView(d); onNote({ ok: true, text: 'Quota recorded.' }); },
    onError: (e) => onNote({ ok: false, text: apiError(e).message }),
  });
  return (
    <div className="space-y-2" data-testid="mdm-android-quota">
      <p className="text-muted-foreground">Record the number of devices Google granted, from Google&apos;s answer to your quota request. Rem0te cannot read it from Google, and does not stop at it; it is a note for whoever enrolls devices.</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="g-quota" className="text-xs">Devices granted</Label>
          <Input id="g-quota" type="number" min={0} max={1000000} className="w-32" value={n} onChange={(e) => setN(e.target.value)} data-testid="mdm-android-quota-input" />
        </div>
        <Button size="sm" disabled={save.isPending || !/^[0-9]{1,7}$/.test(n)} onClick={() => save.mutate(Number(n))} data-testid="mdm-android-quota-save">{`Record${reauthSuffix(ask)}`}</Button>
        {view.quota && <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => { setN(''); save.mutate(null); }}>Clear</Button>}
      </div>
      {view.quota && <p className="text-xs text-muted-foreground" data-testid="mdm-android-quota-facts">Recorded {view.quota.devices} on {when(view.quota.setAt)}.</p>}
    </div>
  );
}

/** Steps 5 (bind a business) and 6 (policy and one-time tokens). */
export function AndroidEnterpriseSteps({ view, ask, onNote, part }: { view: AndroidStepsView; ask: boolean; onNote: Note; part: 'signup' | 'enroll' }) {
  const qc = useQueryClient();
  const askEnroll = useAsks('mdm.enroll');
  const [biz, setBiz] = useState('');
  const [tokBiz, setTokBiz] = useState('');
  const [usage, setUsage] = useState<'allowed' | 'disallowed'>('allowed');
  const [minutes, setMinutes] = useState(60);
  const [shown, setShown] = useState<Shown | null>(null);
  const [signupLink, setSignupLink] = useState<{ url: string; businessName: string; expiresAt: string } | null>(null);
  const tested = view.connectionTest?.result === 'ok';

  const businesses = useQuery({
    queryKey: ['businesses-min'],
    queryFn: () => businessesApi.list().then((r) => ((r.data as { data?: { id: string; name: string }[] })?.data ?? [])),
  });
  const a = useQuery<AndroidView>({ queryKey: ['mdm-android'], queryFn: () => mdmAndroidApi.view().then((r) => r.data.data as AndroidView), retry: false });
  const fail = (e: unknown) => onNote({ ok: false, text: apiError(e).message });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['mdm-android'] }); void qc.invalidateQueries({ queryKey: ['mdm-setup'] }); };

  const signup = useMutation({
    mutationFn: () => mdmAndroidApi.signup(biz).then((r) => r.data.data as { url: string; businessName: string; expiresAt: string }),
    // Google's sign-up page: the business's admin signs in (ideally with a managed Google domain) and Google sends
    // that browser back to the callback. The callback needs no session, so the link may be opened here or sent to them.
    onSuccess: (d) => { setSignupLink(d); refresh(); },
    onError: fail,
  });
  const policy = useMutation({
    mutationFn: (businessId: string) => mdmAndroidApi.policy(businessId),
    onSuccess: () => { refresh(); onNote({ ok: true, text: 'Default policy applied: software and app reports only.' }); },
    onError: fail,
  });
  const token = useMutation({
    mutationFn: () => mdmAndroidApi.token({ businessId: tokBiz, personalUsage: usage, ...(minutes !== 60 ? { expiresInMinutes: minutes } : {}) }).then((r) => r.data.data as Shown),
    onSuccess: (d) => { setShown(d); refresh(); },
    onError: fail,
  });

  const bound = a.data?.enterprises ?? [];
  const boundIds = new Set(bound.map((e) => e.customerId));
  const withPolicy = bound.filter((e) => e.policySetAt);

  if (part === 'signup') return (
    <div className="space-y-3" data-testid="mdm-android-signup">
      <p className="text-muted-foreground">Each business gets its own Android enterprise. Rem0te asks Google for a sign-up link. Open it here, or send it to the business&apos;s admin: they sign in at Google, ideally with a managed Google domain (a work account), not a personal Gmail. Google then sends that browser back to Rem0te, which creates the enterprise in your name. The link works once, for this business, for 30 minutes. Treat it like a password until it is used.</p>
      {!tested ? <p className="text-xs text-muted-foreground">Pass the connection test first (step 3).</p> : (
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 space-y-1">
            <Label htmlFor="g-biz" className="text-xs">Business</Label>
            <select id="g-biz" className="w-full max-w-xs rounded-md border bg-background p-2" value={biz} onChange={(e) => setBiz(e.target.value)} data-testid="mdm-android-signup-business">
              <option value="">Choose…</option>
              {(businesses.data ?? []).filter((b) => !boundIds.has(b.id)).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <Button size="sm" disabled={!biz || signup.isPending} onClick={() => signup.mutate()} data-testid="mdm-android-signup-start">
            {`Get a sign-up link${reauthSuffix(ask)}`}
          </Button>
        </div>
      )}
      {signupLink && (
        <div className="space-y-2 rounded-md border-2 border-amber-500 bg-amber-500/10 p-3 text-xs" data-testid="mdm-android-signup-link">
          <p className="font-semibold">Sign-up link for {signupLink.businessName}; works once, until {when(signupLink.expiresAt)}.</p>
          <p className="break-all font-mono">{signupLink.url}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => window.location.assign(signupLink.url)}>Open at Google<ExternalLink className="ml-1 h-3 w-3" /></Button>
            <Button size="sm" variant="outline" onClick={() => { void navigator.clipboard?.writeText(signupLink.url); onNote({ ok: true, text: 'Sign-up link copied.' }); }}><Copy className="mr-1 h-3 w-3" />Copy link</Button>
          </div>
        </div>
      )}
      {bound.length > 0 && (
        <ul className="space-y-1 text-xs" data-testid="mdm-android-enterprises">
          {bound.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-2" data-enterprise={e.enterpriseId}>
              <span className="font-medium">{e.businessName}</span>
              <span className="font-mono text-muted-foreground">enterprises/{e.enterpriseId}</span>
              <span className="text-muted-foreground">bound {when(e.boundAt)}; {e.policySetAt ? `policy version ${e.policyVersion}` : 'no policy yet'}; {e.devicesEnrolled} enrolled</span>
            </li>
          ))}
        </ul>
      )}
      {(a.data?.signups ?? []).filter((s) => s.state !== 'bound').slice(0, 5).map((s) => (
        <p key={s.id} className="text-xs text-muted-foreground" data-signup-state={s.state}>{s.businessName}: sign-up {s.state}{s.failureCode ? ` (${s.failureCode.replace(/_/g, ' ')})` : ''}, {when(s.createdAt)}</p>
      ))}
    </div>
  );

  return (
    <div className="space-y-3" data-testid="mdm-android-enroll">
      <div className="space-y-2 rounded-md border p-3" data-testid="mdm-android-policy">
        <p className="font-medium">a. The default policy</p>
        <p className="text-xs text-muted-foreground">One policy per enterprise, <code>rem0te-default</code>. It turns on only the software and app reports. It never turns on network info, which carries the IMEI and MAC addresses: Rem0te does not keep them. It sets no passcode, restriction or app. Applying it again replaces it with exactly this.</p>
        {bound.length === 0 ? <p className="text-xs text-muted-foreground">Bind a business first (step 5).</p> : (
          <ul className="space-y-1 text-xs">
            {bound.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{e.businessName}</span>
                <span className="text-muted-foreground">{e.policySetAt ? `applied ${when(e.policySetAt)} (version ${e.policyVersion})` : 'not applied'}</span>
                <Button size="sm" variant="outline" className="h-6" disabled={policy.isPending} onClick={() => policy.mutate(e.customerId)} data-testid="mdm-android-policy-apply">{`${e.policySetAt ? 'Apply again' : 'Apply'}${reauthSuffix(ask)}`}</Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2 rounded-md border p-3" data-testid="mdm-android-token">
        <p className="font-medium">b. One-time enrollment token</p>
        <p className="text-xs text-muted-foreground">A token enrolls one device into one business, once, and expires (an hour by default; 15 to 60 minutes). Work profile: on a personal phone, a separate work profile; Rem0te keeps it as a personal (BYOD) device and never keeps its serial number. Fully managed: a company phone, reset to factory settings first, scanned from the setup screen (tap six times on the welcome screen). Rem0te cannot check who uses the token: treat it like a password.</p>
        {withPolicy.length === 0 ? <p className="text-xs text-muted-foreground">Apply the default policy first (a).</p> : (
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-0 space-y-1">
              <Label htmlFor="g-tbiz" className="text-xs">Business</Label>
              <select id="g-tbiz" className="w-full max-w-xs rounded-md border bg-background p-2" value={tokBiz} onChange={(e) => setTokBiz(e.target.value)} data-testid="mdm-android-token-business">
                <option value="">Choose…</option>
                {withPolicy.map((e) => <option key={e.customerId} value={e.customerId}>{e.businessName}</option>)}
              </select>
            </div>
            <div className="min-w-0 space-y-1">
              <Label htmlFor="g-usage" className="text-xs">Device</Label>
              <select id="g-usage" className="w-full max-w-xs rounded-md border bg-background p-2" value={usage} onChange={(e) => setUsage(e.target.value as 'allowed' | 'disallowed')} data-testid="mdm-android-token-usage">
                <option value="allowed">Work profile (personal phone)</option>
                <option value="disallowed">Fully managed (company phone)</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="g-min" className="text-xs">Expires after (minutes)</Label>
              <Input id="g-min" type="number" min={15} max={60} className="w-24" value={minutes} onChange={(e) => setMinutes(Math.max(15, Math.min(60, Number(e.target.value) || 60)))} />
            </div>
            <Button size="sm" disabled={!tokBiz || token.isPending} onClick={() => { setShown(null); token.mutate(); }} data-testid="mdm-android-token-create">{`Create token${reauthSuffix(askEnroll)}`}</Button>
          </div>
        )}
        {shown && (
          <div className="space-y-2 rounded-md border-2 border-amber-500 bg-amber-500/10 p-3 text-xs" data-testid="mdm-android-token-shown">
            <p className="font-semibold">Shown once, for {shown.businessName} ({shown.personalUsage === 'allowed' ? 'work profile' : 'fully managed'}); expires {when(shown.expiresAt)}.</p>
            {/* eslint-disable-next-line @next/next/no-img-element -- a data URL made by the API; nothing is fetched */}
            <img src={shown.qrDataUrl} alt="Enrollment QR code" width={240} height={240} className="rounded bg-white p-1" data-testid="mdm-android-token-qr" />
            <p className="break-all font-mono" data-testid="mdm-android-token-link">{enrollLink(shown.value)}</p>
            <Button size="sm" variant="outline" onClick={() => { void navigator.clipboard?.writeText(enrollLink(shown.value)); onNote({ ok: true, text: 'Link copied.' }); }}><Copy className="mr-1 h-3 w-3" />Copy link</Button>
          </div>
        )}
      </div>

      <p className="text-xs text-muted-foreground" data-testid="mdm-android-devices">
        {view.devicesEnrolled} Android device{view.devicesEnrolled === 1 ? '' : 's'} enrolled, as Google reports them. The MDM sweep lists each enterprise&apos;s devices (model, Android version, ownership, compliance) and shows them under Mobile devices. Rem0te sends no command to an Android device. It has been tested only against a stand-in for Google: no real Android device has enrolled with Rem0te yet.
      </p>
    </div>
  );
}
