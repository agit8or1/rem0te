'use client';

import { Suspense, useState, useEffect, FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { authApi } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Download, Shield } from 'lucide-react';

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

  return (
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
      <Button type="submit" className="w-full" disabled={loading}>
        {loading ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
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
