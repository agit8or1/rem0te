'use client';

import { Suspense, useState, useEffect, useSyncExternalStore, FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import axios from 'axios';
import { useQuery } from '@tanstack/react-query';
import { authApi, passkeysApi, ssoApi } from '@/lib/api-client';
import { getPasskey, passkeysSupported, errorMessage } from '@/lib/webauthn';
import { ssoErrorMessage } from '@/lib/sso-errors';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Download, Fingerprint, KeyRound, Shield } from 'lucide-react';

// The shared client turns every 401 into a reload of /login, which on this
// page would wipe the reason a passkey was refused ("not registered here").
// The passkey assertion goes through a plain instance so the message shows.
const bare = axios.create({ baseURL: '/api/v1', withCredentials: true, headers: { 'Content-Type': 'application/json' } });

const noSubscribe = () => () => {};

interface SsoProviderOption { id: string; name: string }

interface Branding {
  portalTitle?: string | null;
  logoUrl?: string | null;
  accentColor?: string | null;
  footerText?: string | null;
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  // Only a path on this site. `returnTo` arrives in the query string, and
  // `https://…` or `//host` in there would send someone straight from a real
  // sign-in to somebody else's page — the ideal setup for asking them to sign
  // in again.
  //
  // A backslash is rejected as well as a second slash: several browsers
  // normalise `/\evil.example` to `//evil.example` before anything here gets a
  // say, so a check that only looked for `//` was one character from being no
  // check at all. The query string is allowed through — it has to be, since a
  // Tactical RMM launch is nothing but query string — which is safe because
  // the value stays a same-origin path and nothing downstream redirects on it.
  //
  // The pattern check alone was not enough: the URL parser strips tab, CR and
  // LF before resolving, so `/%09/evil.example` passed it as a single-slash
  // path and resolved to `https://evil.example/`. So the value is resolved the
  // way the browser will resolve it, and kept only if it is still this origin.
  const requested = params.get('returnTo') ?? '';
  const returnTo = safeReturnTo(requested);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  // false on the server and on the first client render, so hydration matches.
  const canPasskey = useSyncExternalStore(noSubscribe, passkeysSupported, () => false);
  const ssoError = ssoErrorMessage(params.get('sso_error'));

  const { data: providers = [] } = useQuery<SsoProviderOption[]>({
    queryKey: ['sso-providers-public'],
    queryFn: () => ssoApi.providers().then((r) => r.data?.data ?? []),
    retry: false,
    staleTime: 60_000,
  });

  async function handlePasskey() {
    setError('');
    setPasskeyLoading(true);
    try {
      const opts = (await passkeysApi.loginOptions()).data?.data;
      const response = await getPasskey(opts);
      const res = await bare.post('/auth/passkeys/login', { response });
      if (res.data?.data?.requiresMfa) {
        router.push('/mfa');
        return;
      }
      router.push(returnTo);
    } catch (err: unknown) {
      setError(errorMessage(err, 'Passkey sign-in failed'));
    } finally {
      setPasskeyLoading(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await authApi.login(email, password);
      const data = res.data?.data;

      if (data?.requiresMfa) {
        router.push('/mfa');
        return;
      }

      router.push(returnTo);
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        'Invalid credentials';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  const busy = loading || passkeyLoading;

  return (
    <div className="space-y-4">
      {ssoError && (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {ssoError}
        </div>
      )}
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" className="w-full" disabled={busy}>
          {loading ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
      {(canPasskey || providers.length > 0) && (
        <>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            or
            <span className="h-px flex-1 bg-border" />
          </div>
          <div className="space-y-2">
            {canPasskey && (
              <Button type="button" variant="outline" className="w-full" onClick={handlePasskey} disabled={busy}>
                <Fingerprint className="h-4 w-4 mr-2" />
                {passkeyLoading ? 'Waiting for passkey…' : 'Sign in with a passkey'}
              </Button>
            )}
            {providers.map((p) => (
              <Button
                key={p.id}
                type="button"
                variant="outline"
                className="w-full"
                disabled={busy}
                onClick={() => { window.location.href = ssoApi.startUrl(p.id, returnTo); }}
              >
                <KeyRound className="h-4 w-4 mr-2" />
                Sign in with {p.name}
              </Button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function LoginPage() {
  const [showDownload, setShowDownload] = useState(false);
  const [branding, setBranding] = useState<Branding | null>(null);

  useEffect(() => {
    fetch('/api/v1/public/rustdesk-config')
      .then(r => r.json())
      .then(d => {
        if (d.data?.showDownloadPage !== false) setShowDownload(true);
        if (d.data?.branding) setBranding(d.data.branding);
      })
      .catch(() => null);
  }, []);

  const title = branding?.portalTitle || 'Rem0te';
  const accentColor = branding?.accentColor || null;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-muted/40 px-4">
      <div className="w-full max-w-sm space-y-4">
        <Card>
          <CardHeader className="space-y-3 pb-4">
            {/* Logo / branding header */}
            {(branding?.logoUrl || accentColor) ? (
              <div
                className="rounded-md px-4 py-3 flex items-center gap-3 -mx-1"
                style={{ backgroundColor: accentColor ?? '#3B82F6' }}
              >
                {branding?.logoUrl ? (
                  <img
                    src={branding.logoUrl}
                    alt={title}
                    className="h-8 w-auto max-w-[120px] object-contain"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                ) : (
                  <Shield className="h-6 w-6 text-white" />
                )}
                <span className="text-white font-semibold">{title}</span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Shield className="h-6 w-6 text-primary" />
                <CardTitle className="text-2xl font-bold">{title}</CardTitle>
              </div>
            )}
            <CardDescription>Sign in to your account</CardDescription>
          </CardHeader>
          <CardContent>
            <Suspense fallback={<div className="h-48" />}>
              <LoginForm />
            </Suspense>
          </CardContent>
        </Card>

        {branding?.footerText && (
          <p className="text-center text-xs text-muted-foreground">{branding.footerText}</p>
        )}

        {showDownload && (
          <div className="text-center">
            <Link
              href="/download"
              className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <Download className="h-4 w-4" />
              Need remote support? Download the client
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

function safeReturnTo(requested: string): string {
  const fallback = '/dashboard';
  if (!/^\/(?![/\\])/.test(requested) || requested.includes('\\')) return fallback;
  if (/[\u0000-\u001f\u007f]/.test(requested)) return fallback;
  if (typeof window === 'undefined') return fallback;
  try {
    const url = new URL(requested, window.location.origin);
    if (url.origin !== window.location.origin) return fallback;
    // Dot segments normalise too: `/..//evil.example` resolves on this origin
    // to the path `//evil.example`, which the router reads as another host.
    if (/^\/[/\\]/.test(url.pathname)) return fallback;
    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
}
