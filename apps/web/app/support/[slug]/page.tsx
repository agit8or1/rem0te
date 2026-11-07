'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useParams } from 'next/navigation';
import { useQuery, useMutation } from '@tanstack/react-query';
import { publicSupportApi } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { CheckCircle2, Copy, LifeBuoy, Loader2, Shield } from 'lucide-react';

type ApiError = { response?: { status?: number; data?: { message?: string | string[] } } };

function submitError(e: unknown): string {
  const err = e as ApiError;
  if (err?.response?.status === 429) return 'Too many requests. Please try again in a minute.';
  if (err?.response?.status === 404) return 'This support link is not active.';
  return err?.response?.data?.message?.toString() ?? 'Something went wrong. Please try again.';
}

/**
 * Public support request form, reached from a business's intake link.
 *
 * Outside the signed-in app on purpose: no navigation into the console and
 * nothing here names a computer or a person. The business comes from the
 * link alone.
 */
export default function SupportIntakePage() {
  const { slug } = useParams<{ slug: string }>();
  const mountedAt = useRef(0);
  useEffect(() => { mountedAt.current = Date.now(); }, []);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [description, setDescription] = useState('');
  const [rustdeskId, setRustdeskId] = useState('');
  const [website, setWebsite] = useState('');
  const [copied, setCopied] = useState(false);

  const intake = useQuery<{ businessName: string }>({
    queryKey: ['public-support-intake', slug],
    queryFn: () => publicSupportApi.intake(slug).then((r) => r.data?.data),
    retry: false,
    enabled: !!slug,
  });

  const submit = useMutation({
    mutationFn: () => publicSupportApi.submit(slug, {
      name: name.trim(),
      ...(email.trim() ? { email: email.trim() } : {}),
      ...(phone.trim() ? { phone: phone.trim() } : {}),
      description: description.trim(),
      ...(rustdeskId.trim() ? { rustdeskId: rustdeskId.trim() } : {}),
      website,
      elapsedMs: mountedAt.current ? Date.now() - mountedAt.current : 0,
    }).then((r) => r.data?.data as { accepted: boolean; statusToken: string }),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !description.trim()) return;
    submit.mutate();
  }

  const statusUrl = submit.data?.statusToken && typeof window !== 'undefined'
    ? `${window.location.origin}/support/status/${encodeURIComponent(submit.data.statusToken)}`
    : null;

  async function copy() {
    if (!statusUrl) return;
    try {
      await navigator.clipboard.writeText(statusUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  }

  if (intake.isLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-muted/30">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </main>
    );
  }

  // 404 means unknown, disabled or inactive; the API answers the same for
  // all three, and so does this page.
  if (intake.isError || !intake.data) {
    const rateLimited = (intake.error as ApiError)?.response?.status === 429;
    return (
      <main className="flex min-h-screen items-center justify-center bg-muted/30 p-6">
        <div className="w-full max-w-md rounded-lg border bg-card p-8 text-center shadow-sm">
          <Shield className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50" />
          <h1 className="text-lg font-semibold">
            {rateLimited ? 'Too many requests' : 'This support link is not active'}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {rateLimited
              ? 'Please try again in a minute.'
              : 'Please contact the company that gave you this link.'}
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-muted/30 py-10 px-4 sm:px-6">
      <div className="mx-auto w-full max-w-xl space-y-6">
        <header className="flex items-center gap-3">
          <LifeBuoy className="h-7 w-7 text-primary" aria-hidden="true" />
          <span className="text-lg font-semibold">{intake.data.businessName}</span>
        </header>

        {submit.isSuccess && statusUrl ? (
          <section className="rounded-lg border bg-card p-6 sm:p-8 shadow-sm space-y-4">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" aria-hidden="true" />
              <h1 className="text-xl font-semibold">Request received</h1>
            </div>
            <p className="text-sm text-muted-foreground">
              It is waiting for a technician. Keep this link: it is the only way to check on your request.
            </p>
            <div className="flex flex-col sm:flex-row gap-2">
              <Input readOnly value={statusUrl} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
              <Button type="button" variant="outline" onClick={copy}>
                <Copy className="h-4 w-4 mr-2" />
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <Button asChild>
              <a href={statusUrl}>Open status page</a>
            </Button>
          </section>
        ) : (
          <section className="rounded-lg border bg-card p-6 sm:p-8 shadow-sm">
            <h1 className="text-2xl font-bold tracking-tight">Request support</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Tell us what you need. A technician from {intake.data.businessName} will pick it up.
            </p>

            <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
              <div className="space-y-1.5">
                <Label htmlFor="si-name">Your name *</Label>
                <Input id="si-name" autoComplete="name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} required />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="si-email">Email</Label>
                  <Input id="si-email" type="email" autoComplete="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="si-phone">Phone</Label>
                  <Input id="si-phone" type="tel" autoComplete="tel" maxLength={40} value={phone} onChange={(e) => setPhone(e.target.value)} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="si-desc">What do you need help with? *</Label>
                <Textarea id="si-desc" rows={5} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="si-rid">Remote ID (optional)</Label>
                <Input
                  id="si-rid"
                  inputMode="numeric"
                  maxLength={20}
                  placeholder="e.g. 123 456 789"
                  value={rustdeskId}
                  onChange={(e) => setRustdeskId(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  If the support app is already open on your screen, enter the ID number it shows.
                </p>
              </div>

              {/* Honeypot: invisible to people, filled in by form bots. */}
              <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', top: 'auto', width: 1, height: 1, overflow: 'hidden' }}>
                <label htmlFor="si-website">Website</label>
                <input
                  id="si-website"
                  name="website"
                  type="text"
                  tabIndex={-1}
                  autoComplete="off"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                />
              </div>

              {submit.isError && (
                <p className="text-sm text-destructive" role="alert">{submitError(submit.error)}</p>
              )}

              <Button type="submit" className="w-full" disabled={!name.trim() || !description.trim() || submit.isPending}>
                {submit.isPending ? 'Sending…' : 'Send request'}
              </Button>
            </form>
          </section>
        )}
      </div>
    </main>
  );
}
