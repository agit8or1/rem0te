'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { authApi, tenantsApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, Circle, ChevronRight, ChevronLeft, Sparkles, Monitor, Server, Link2 } from 'lucide-react';
import Link from 'next/link';

const STEPS = [
  { label: 'Verify Server', icon: Server },
  { label: 'Install RustDesk', icon: Monitor },
  { label: 'Enroll a Device', icon: Sparkles },
  { label: "You're Ready!", icon: CheckCircle2 },
];

export default function QuickstartPage() {
  const [step, setStep] = useState(0);

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: () => authApi.me().then((r) => r.data?.data),
  });

  const tenantId: string = me?.tenantId ?? '';

  const { data: tenantData } = useQuery({
    queryKey: ['tenant', tenantId],
    queryFn: () => tenantsApi.get(tenantId).then((r) => r.data?.data),
    enabled: !!tenantId,
  });

  const tenant = tenantData as Record<string, unknown> | undefined;
  const settings = tenant?.settings as Record<string, unknown> | undefined;
  const relayHost = (settings?.rustdeskRelayHost as string) ?? '';
  const publicKey = (settings?.rustdeskPublicKey as string) ?? '';

  const configCommand = relayHost
    ? `rustdesk --config "host=${relayHost}${publicKey ? `;key=${publicKey}` : ''};relay-server=${relayHost}"`
    : null;

  const downloadPageUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/download`
      : '/download';

  function goNext() {
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }
  function goBack() {
    setStep((s) => Math.max(s - 1, 0));
  }

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <PageHeader
        title="Quick Start"
        description="Get your remote support environment set up in a few steps."
      />

      {/* Progress indicator */}
      <div className="flex items-center gap-2">
        {STEPS.map((s, i) => {
          const Icon = s.icon;
          const done = i < step;
          const active = i === step;
          return (
            <div key={i} className="flex items-center gap-2">
              <button
                onClick={() => setStep(i)}
                className="flex items-center gap-1.5 text-sm font-medium transition-colors"
              >
                {done ? (
                  <CheckCircle2 className="h-4 w-4 text-primary" />
                ) : (
                  <Circle
                    className={`h-4 w-4 ${active ? 'text-primary' : 'text-muted-foreground'}`}
                  />
                )}
                <span className={active ? 'text-foreground' : done ? 'text-primary' : 'text-muted-foreground'}>
                  {s.label}
                </span>
              </button>
              {i < STEPS.length - 1 && (
                <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
              )}
            </div>
          );
        })}
      </div>

      {/* Step content */}
      <div>
        {step === 0 && (
          <StepVerifyServer
            relayHost={relayHost}
            publicKey={publicKey}
            configCommand={configCommand}
          />
        )}
        {step === 1 && (
          <StepInstallRustDesk configCommand={configCommand} relayHost={relayHost} />
        )}
        {step === 2 && (
          <StepEnrollDevice downloadPageUrl={downloadPageUrl} />
        )}
        {step === 3 && (
          <StepReady />
        )}
      </div>

      {/* Navigation buttons */}
      <div className="flex items-center justify-between pt-2">
        <Button variant="outline" onClick={goBack} disabled={step === 0}>
          <ChevronLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
        {step < STEPS.length - 1 ? (
          <Button onClick={goNext}>
            Next
            <ChevronRight className="h-4 w-4 ml-1" />
          </Button>
        ) : (
          <Link href="/connect">
            <Button>
              <Link2 className="h-4 w-4 mr-2" />
              Go to Connect
            </Button>
          </Link>
        )}
      </div>
    </div>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="rounded-md bg-muted px-4 py-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all">
      {children}
    </pre>
  );
}

function StepVerifyServer({
  relayHost,
  publicKey,
  configCommand,
}: {
  relayHost: string;
  publicKey: string;
  configCommand: string | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Server className="h-4 w-4" />
          Step 1 — Verify Server Settings
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Before anything else, make sure your RustDesk server settings are configured. These tell
          clients which server to connect to.
        </p>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4 rounded-md border px-4 py-3">
            <div>
              <p className="text-sm font-medium">Relay Host</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {relayHost || 'Not configured — go to Settings → RustDesk tab'}
              </p>
            </div>
            {relayHost ? (
              <Badge variant="secondary" className="text-green-700 bg-green-100 dark:bg-green-900/30 dark:text-green-400 shrink-0">
                <CheckCircle2 className="h-3 w-3 mr-1" />
                Set
              </Badge>
            ) : (
              <Badge variant="destructive" className="shrink-0">Not set</Badge>
            )}
          </div>

          <div className="flex items-center justify-between gap-4 rounded-md border px-4 py-3">
            <div>
              <p className="text-sm font-medium">Public Key</p>
              <p className="text-xs text-muted-foreground mt-0.5 font-mono break-all">
                {publicKey || 'Not configured — go to Settings → RustDesk tab'}
              </p>
            </div>
            {publicKey ? (
              <Badge variant="secondary" className="text-green-700 bg-green-100 dark:bg-green-900/30 dark:text-green-400 shrink-0">
                <CheckCircle2 className="h-3 w-3 mr-1" />
                Set
              </Badge>
            ) : (
              <Badge variant="outline" className="shrink-0">Optional</Badge>
            )}
          </div>
        </div>

        {!relayHost && (
          <div className="rounded-md border border-yellow-200 bg-yellow-50 dark:border-yellow-900 dark:bg-yellow-900/20 px-4 py-3 text-sm text-yellow-800 dark:text-yellow-300">
            Configure the relay host in{' '}
            <Link href="/settings" className="underline font-medium">
              Settings → RustDesk
            </Link>{' '}
            before continuing.
          </div>
        )}

        {configCommand && (
          <div className="space-y-2">
            <p className="text-sm font-medium">Auto-config command</p>
            <p className="text-xs text-muted-foreground">
              Run this on any machine to configure RustDesk to use this server:
            </p>
            <CodeBlock>{configCommand}</CodeBlock>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StepInstallRustDesk({
  configCommand,
  relayHost,
}: {
  configCommand: string | null;
  relayHost: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Monitor className="h-4 w-4" />
          Step 2 — Install RustDesk on Your Machine
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          As a technician, you need RustDesk installed on your own computer to connect to remote
          devices.
        </p>

        <ol className="space-y-4 text-sm">
          <li className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">
              1
            </span>
            <div className="space-y-1">
              <p className="font-medium">Download RustDesk</p>
              <p className="text-muted-foreground">
                Go to{' '}
                <a
                  href="https://rustdesk.com/download"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  rustdesk.com/download
                </a>{' '}
                and download the installer for your OS. Install it normally.
              </p>
            </div>
          </li>

          <li className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">
              2
            </span>
            <div className="space-y-1 w-full">
              <p className="font-medium">Configure it to use this server</p>
              {configCommand ? (
                <>
                  <p className="text-muted-foreground">
                    Run this command (as admin/sudo on Windows/Linux) to point RustDesk at your server:
                  </p>
                  <CodeBlock>{configCommand}</CodeBlock>
                </>
              ) : (
                <p className="text-muted-foreground">
                  Complete Step 1 first (set the relay host in Settings) to get the config command.
                </p>
              )}
              {relayHost && (
                <p className="text-muted-foreground">
                  Or open RustDesk, go to{' '}
                  <strong>Settings → Network</strong>, and set the ID/Relay server to{' '}
                  <code className="text-xs bg-muted px-1 py-0.5 rounded">{relayHost}</code>.
                </p>
              )}
            </div>
          </li>

          <li className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">
              3
            </span>
            <div className="space-y-1">
              <p className="font-medium">Verify the connection</p>
              <p className="text-muted-foreground">
                RustDesk should show a numeric ID (e.g. <code className="text-xs bg-muted px-1 py-0.5 rounded">123 456 789</code>). If it
                stays blank or shows an error, check your firewall — ports 21115–21119 must be open on
                the server.
              </p>
            </div>
          </li>
        </ol>
      </CardContent>
    </Card>
  );
}

function StepEnrollDevice({ downloadPageUrl }: { downloadPageUrl: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4" />
          Step 3 — Enroll a Remote Device
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-muted-foreground">
          Enrolling a device registers it permanently in the system so you can connect without asking
          the user for their ID every time.
        </p>

        <div className="space-y-3">
          <p className="text-sm font-medium">Option A — Download page (easiest for end users)</p>
          <p className="text-sm text-muted-foreground">
            Send the user this link. It lets them download RustDesk pre-configured for your server
            and includes enrollment instructions:
          </p>
          <CodeBlock>{downloadPageUrl}</CodeBlock>
          <p className="text-xs text-muted-foreground">
            The download page is enabled in Settings → General → Download Page.
          </p>
        </div>

        <div className="border-t pt-4 space-y-3">
          <p className="text-sm font-medium">Option B — Manual enrollment token</p>
          <ol className="space-y-2 text-sm text-muted-foreground list-decimal pl-5">
            <li>
              Go to <Link href="/endpoints" className="underline">Endpoints</Link> and click{' '}
              <strong>New Enrollment Token</strong> (or use Settings → Enrollment).
            </li>
            <li>Copy the token and give it to whoever is setting up the device.</li>
            <li>
              On the remote device, after installing RustDesk, run:
              <div className="mt-1.5">
                <CodeBlock>{`rustdesk --enroll <TOKEN>`}</CodeBlock>
              </div>
            </li>
            <li>
              The device will appear in your <Link href="/endpoints" className="underline">Endpoints</Link> list
              automatically.
            </li>
          </ol>
        </div>
      </CardContent>
    </Card>
  );
}

function StepReady() {
  return (
    <Card className="border-primary/40 bg-primary/5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CheckCircle2 className="h-5 w-5 text-primary" />
          You&apos;re Ready!
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Your Reboot Remote environment is set up. Here&apos;s a summary of what you&apos;ve
          configured:
        </p>

        <ul className="space-y-2 text-sm">
          <li className="flex items-start gap-2">
            <CheckCircle2 className="h-4 w-4 text-primary mt-0.5 shrink-0" />
            <span>RustDesk server configured (relay host + public key in Settings)</span>
          </li>
          <li className="flex items-start gap-2">
            <CheckCircle2 className="h-4 w-4 text-primary mt-0.5 shrink-0" />
            <span>RustDesk installed on your machine and pointed at this server</span>
          </li>
          <li className="flex items-start gap-2">
            <CheckCircle2 className="h-4 w-4 text-primary mt-0.5 shrink-0" />
            <span>At least one remote device enrolled (or a download link ready for users)</span>
          </li>
        </ul>

        <div className="flex flex-wrap gap-3 pt-2">
          <Link href="/connect">
            <Button>
              <Link2 className="h-4 w-4 mr-2" />
              Connect to a Device
            </Button>
          </Link>
          <Link href="/endpoints">
            <Button variant="outline">
              <Monitor className="h-4 w-4 mr-2" />
              View Endpoints
            </Button>
          </Link>
          <Link href="/help">
            <Button variant="ghost">View Help &amp; Docs</Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
