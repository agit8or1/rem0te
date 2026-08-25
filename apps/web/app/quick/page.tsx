'use client';

import { useEffect, useState } from 'react';
import { Apple, Download, Loader2, Lock, Monitor, Server, Shield } from 'lucide-react';

interface QuickInfo {
  enabled: boolean;
  configured?: boolean;
  downloads: { os: 'windows' | 'macos' | 'linux'; label: string; path: string }[];
  branding: {
    portalTitle: string | null;
    logoUrl: string | null;
    accentColor: string | null;
    supportEmail: string | null;
    supportPhone: string | null;
  } | null;
}

const OS_ICON = { windows: Monitor, macos: Apple, linux: Server } as const;

/**
 * Public "I need help" page.
 *
 * Deliberately not part of the signed-in app: no navigation into the console,
 * no account required, and nothing on this page reveals a business name, a
 * user, or an enrolled computer.
 */
export default function QuickConnectLandingPage() {
  const [info, setInfo] = useState<QuickInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/v1/public/quick-connect')
      .then((r) => r.json())
      .then((j) => setInfo(j?.data ?? null))
      .catch(() => setInfo(null))
      .finally(() => setLoading(false));
  }, []);

  const title = info?.branding?.portalTitle || 'Rem0te';
  const accent = info?.branding?.accentColor || '#3B82F6';

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-muted/30">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </main>
    );
  }

  if (!info?.enabled) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-muted/30 p-6">
        <div className="w-full max-w-md rounded-lg border bg-background p-8 text-center shadow-sm">
          <Shield className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50" />
          <h1 className="text-lg font-semibold">Remote support is not available</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Quick Connect is currently turned off. Please contact the person who asked you to visit
            this page.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-muted/30 py-10 px-6">
      <div className="mx-auto w-full max-w-2xl space-y-6">
        <header className="flex items-center gap-3">
          {info.branding?.logoUrl ? (
            <img
              src={info.branding.logoUrl}
              alt={title}
              className="h-9 w-auto max-w-[140px] object-contain"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
          ) : (
            <Shield className="h-7 w-7" style={{ color: accent }} />
          )}
          <span className="text-lg font-semibold">{title}</span>
        </header>

        <section className="rounded-lg border bg-background p-8 shadow-sm">
          <h1 className="text-2xl font-bold tracking-tight">Need Remote Support?</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Follow these four steps and your support technician will be able to see your screen.
          </p>

          <ol className="mt-6 space-y-4">
            {[
              { n: 1, title: 'Download Rem0te Quick Connect', body: 'Use the button below.' },
              { n: 2, title: 'Run the application', body: 'You do not need to install anything or create an account.' },
              { n: 3, title: 'Give your support technician the ID and password shown', body: 'Read them out over the phone or send them however you were asked to.' },
              { n: 4, title: 'Keep the application open while receiving support', body: 'Closing it ends the session immediately.' },
            ].map((step) => (
              <li key={step.n} className="flex gap-3">
                <span
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
                  style={{ backgroundColor: accent }}
                >
                  {step.n}
                </span>
                <div>
                  <div className="text-sm font-medium">{step.title}</div>
                  <div className="text-sm text-muted-foreground">{step.body}</div>
                </div>
              </li>
            ))}
          </ol>

          <div className="mt-8 space-y-2">
            {info.downloads.length === 0 || info.configured === false ? (
              <p className="rounded-md border bg-muted/40 p-4 text-sm text-muted-foreground">
                No download is available right now. Please contact your support technician.
              </p>
            ) : (
              info.downloads.map((d) => {
                const Icon = OS_ICON[d.os];
                return (
                  <a
                    key={d.os}
                    href={d.path}
                    className="flex w-full items-center justify-center gap-2 rounded-md px-4 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90"
                    style={{ backgroundColor: accent }}
                  >
                    <Icon className="h-4 w-4" />
                    Download for {d.label}
                    <Download className="h-4 w-4" />
                  </a>
                );
              })
            )}
          </div>

          <div className="mt-6 flex gap-3 rounded-md border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/40">
            <Lock className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400" />
            <p className="text-sm text-amber-900 dark:text-amber-200">
              Only share your ID and password with someone you trust and are expecting support from.
              Anyone with those two values can connect to this computer until you close the
              application.
            </p>
          </div>
        </section>

        {(info.branding?.supportEmail || info.branding?.supportPhone) && (
          <footer className="text-center text-sm text-muted-foreground">
            Need help getting started?{' '}
            {info.branding.supportPhone && <span className="font-medium">{info.branding.supportPhone}</span>}
            {info.branding.supportPhone && info.branding.supportEmail && ' · '}
            {info.branding.supportEmail && (
              <a href={`mailto:${info.branding.supportEmail}`} className="underline">
                {info.branding.supportEmail}
              </a>
            )}
          </footer>
        )}
      </div>
    </main>
  );
}
