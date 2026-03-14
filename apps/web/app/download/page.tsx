'use client';

import { useEffect, useState } from 'react';
import {
  Shield, Download, Monitor, Apple, Server,
  Copy, Check, Settings, Loader2, Zap, Terminal,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface RustdeskConfig {
  relayHost: string | null;
  relayPort: number | null;
  publicKey: string | null;
  configString: string | null;
  configured: boolean;
  showDownloadPage?: boolean;
}

interface DownloadItem {
  label: string;
  description: string;
  type: 'install' | 'portable' | 'msi';
  url: string;
}

interface OsDownloads {
  os: string;
  icon: React.ComponentType<{ className?: string }>;
  items: DownloadItem[];
}

function buildDownloads(version: string): OsDownloads[] {
  const base = `https://github.com/rustdesk/rustdesk/releases/download/${version}`;
  return [
    {
      os: 'Windows',
      icon: Monitor,
      items: [
        {
          label: `Windows Installer (.exe) — v${version}`,
          description: 'Standard installation — recommended for permanent service install',
          type: 'install',
          url: `${base}/rustdesk-${version}-x86_64.exe`,
        },
        {
          label: `Windows MSI — v${version}`,
          description: 'MSI package for enterprise/managed deployments',
          type: 'msi',
          url: `${base}/rustdesk-${version}-x86_64.msi`,
        },
      ],
    },
    {
      os: 'macOS',
      icon: Apple,
      items: [
        {
          label: `macOS Intel (.dmg) — v${version}`,
          description: 'For Intel-based Macs',
          type: 'install',
          url: `${base}/rustdesk-${version}-x86_64.dmg`,
        },
        {
          label: `macOS Apple Silicon (.dmg) — v${version}`,
          description: 'For M1/M2/M3 Macs',
          type: 'install',
          url: `${base}/rustdesk-${version}-aarch64.dmg`,
        },
      ],
    },
    {
      os: 'Linux',
      icon: Server,
      items: [
        {
          label: `Linux (.deb) — v${version}`,
          description: 'For Debian/Ubuntu-based systems',
          type: 'install',
          url: `${base}/rustdesk-${version}-x86_64.deb`,
        },
        {
          label: `Linux (.AppImage) — v${version}`,
          description: 'Portable — works on most Linux distributions',
          type: 'portable',
          url: `${base}/rustdesk-${version}-x86_64.AppImage`,
        },
      ],
    },
  ];
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 2000); };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallback());
    } else {
      fallback();
    }
    function fallback() {
      const el = document.createElement('textarea');
      el.value = text;
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      try { document.execCommand('copy'); done(); } catch { /* ignore */ }
      document.body.removeChild(el);
    }
  }
  return (
    <Button variant="outline" size="sm" onClick={copy} className="shrink-0">
      {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
    </Button>
  );
}

const BADGE_LABELS: Record<string, string> = {
  install: 'Installer',
  msi: 'MSI',
  portable: 'Portable',
};

function InstallCommand({ label, command }: { label: string; command: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 rounded bg-muted px-3 py-2 text-xs font-mono break-all leading-relaxed">
          {command}
        </code>
        <CopyButton text={command} />
      </div>
    </div>
  );
}

export default function DownloadPage() {
  const [config, setConfig] = useState<RustdeskConfig | null>(null);
  const [downloads, setDownloads] = useState<OsDownloads[] | null>(null);
  const [releaseVersion, setReleaseVersion] = useState<string | null>(null);
  const [apiBase, setApiBase] = useState('');

  useEffect(() => {
    setApiBase(window.location.origin);

    fetch('/api/v1/public/rustdesk-config')
      .then((r) => r.json())
      .then((d) => d.data && setConfig(d.data))
      .catch(() => null);

    fetch('https://api.github.com/repos/rustdesk/rustdesk/releases/latest')
      .then((r) => r.json())
      .then((d) => {
        const version: string = d.tag_name ?? '1.4.6';
        setReleaseVersion(version);
        setDownloads(buildDownloads(version));
      })
      .catch(() => {
        setReleaseVersion('1.4.6');
        setDownloads(buildDownloads('1.4.6'));
      });
  }, []);

  const installBase = `${apiBase}/api/v1/public/install`;

  return (
    <div className="min-h-screen bg-muted/30">
      <header className="border-b bg-background">
        <div className="mx-auto max-w-4xl px-6 py-4 flex items-center gap-3">
          <Shield className="h-6 w-6 text-primary" />
          <span className="font-semibold text-lg">Reboot Remote</span>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-12 space-y-8">
        <div className="text-center space-y-3">
          <h1 className="text-3xl font-bold">Get Remote Support</h1>
          <p className="text-muted-foreground max-w-xl mx-auto">
            Install the remote support client. Your technician can connect to your computer at any
            time — no action needed on your end after setup.
          </p>
        </div>

        {/* Steps */}
        <div className="grid grid-cols-3 gap-4 text-center text-sm">
          {[
            { step: '1', text: 'Run the install command your technician sent you — takes about 30 seconds' },
            { step: '2', text: 'The client installs as a background service that starts automatically with Windows' },
            { step: '3', text: 'Your technician can now connect on demand — you\'ll see a notification when they do' },
          ].map(({ step, text }) => (
            <div key={step} className="rounded-lg border bg-background p-4 space-y-2">
              <div className="h-8 w-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center font-bold mx-auto text-sm">
                {step}
              </div>
              <p className="text-muted-foreground">{text}</p>
            </div>
          ))}
        </div>

        <Tabs defaultValue="oneclick">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="oneclick" className="flex items-center gap-2">
              <Zap className="h-4 w-4" />
              One-Click Install (Recommended)
            </TabsTrigger>
            <TabsTrigger value="manual" className="flex items-center gap-2">
              <Download className="h-4 w-4" />
              Manual Download
            </TabsTrigger>
          </TabsList>

          {/* One-click install tab */}
          <TabsContent value="oneclick" className="mt-4 space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Terminal className="h-5 w-5" />
                  Automatic Install &amp; Configure
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <p className="text-sm text-muted-foreground">
                  Your technician will send you a personalised install command. Run it for your
                  operating system — it downloads RustDesk, configures it to connect to this server,
                  installs it as a background service, and registers your device so your technician
                  can connect on demand.
                </p>

                {/* Windows */}
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Monitor className="h-4 w-4" />
                    <span className="font-medium text-sm">Windows</span>
                  </div>
                  <div className="rounded-lg border-2 border-primary/20 bg-primary/5 p-4 space-y-2">
                    <p className="text-sm font-medium">One-click installer (recommended)</p>
                    <p className="text-xs text-muted-foreground">
                      Download and double-click. It will request Administrator access and install automatically — no PowerShell needed.
                    </p>
                    <Button asChild size="sm" className="mt-1">
                      <a href={`${installBase}/windows.exe`}>
                        <Download className="h-4 w-4 mr-2" />
                        Download Windows Installer (.exe)
                      </a>
                    </Button>
                  </div>
                  <InstallCommand
                    label="Or run in PowerShell (as Administrator):"
                    command={`irm ${installBase}/windows.ps1 | iex`}
                  />
                </div>

                <div className="border-t pt-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <Server className="h-4 w-4" />
                    <span className="font-medium text-sm">Linux</span>
                    <Badge variant="secondary" className="text-xs">Debian/Ubuntu</Badge>
                  </div>
                  <InstallCommand
                    label="Terminal (as root)"
                    command={`curl -fsSL ${installBase}/linux.sh | sudo bash`}
                  />
                </div>

                <div className="border-t pt-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <Apple className="h-4 w-4" />
                    <span className="font-medium text-sm">macOS</span>
                  </div>
                  <InstallCommand
                    label="Terminal"
                    command={`curl -fsSL ${installBase}/macos.sh | bash`}
                  />
                  <p className="text-xs text-muted-foreground">
                    After installing, enable &quot;Start on Login&quot; in RustDesk settings for permanent access.
                  </p>
                </div>

                {!config?.configured && (
                  <div className="rounded-lg border border-yellow-200 bg-yellow-50 dark:border-yellow-900 dark:bg-yellow-950/30 p-3 text-xs text-yellow-800 dark:text-yellow-200">
                    Server not yet configured — scripts will download RustDesk but may not point to this
                    server. Ask your administrator to set the relay host in Settings → RustDesk.
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Manual download tab */}
          <TabsContent value="manual" className="mt-4 space-y-4">
            {!downloads ? (
              <div className="flex items-center justify-center py-12 gap-2 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span className="text-sm">Loading downloads…</span>
              </div>
            ) : (
              <>
                {downloads.map(({ os, icon: Icon, items }) => (
                  <Card key={os}>
                    <CardHeader className="pb-3">
                      <CardTitle className="flex items-center gap-2 text-base">
                        <Icon className="h-5 w-5" />
                        {os}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {items.map((item) => (
                        <div key={item.url} className="flex items-center justify-between gap-4 rounded-lg border p-4">
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-sm">{item.label}</span>
                              <Badge variant={item.type === 'portable' ? 'secondary' : 'default'} className="text-xs">
                                {BADGE_LABELS[item.type] ?? item.type}
                              </Badge>
                            </div>
                            <p className="text-xs text-muted-foreground">{item.description}</p>
                          </div>
                          <Button asChild size="sm">
                            <a href={item.url}>
                              <Download className="h-4 w-4 mr-2" />
                              Download
                            </a>
                          </Button>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                ))}

                {/* Manual server config */}
                {config?.configured && (
                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="flex items-center gap-2 text-base">
                        <Settings className="h-5 w-5" />
                        After Downloading — Configure Server
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <p className="text-sm text-muted-foreground">
                        After installing, run this command to point RustDesk at this server:
                      </p>
                      {config.configString && (
                        <InstallCommand
                          label="Auto-configure command"
                          command={`rustdesk --config ${config.configString}`}
                        />
                      )}
                      <div className="space-y-3 pt-2 border-t">
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          Or configure manually in RustDesk → three-dot menu → Network → ID/Relay Server
                        </p>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          <div className="rounded-lg border bg-muted/30 p-3 space-y-1">
                            <p className="text-xs text-muted-foreground">ID Server</p>
                            <div className="flex items-center gap-2">
                              <code className="text-sm font-mono font-medium flex-1">{config.relayHost}</code>
                              {config.relayHost && <CopyButton text={config.relayHost} />}
                            </div>
                          </div>
                          <div className="rounded-lg border bg-muted/30 p-3 space-y-1">
                            <p className="text-xs text-muted-foreground">Relay Server</p>
                            <div className="flex items-center gap-2">
                              <code className="text-sm font-mono font-medium flex-1">{config.relayHost}</code>
                              {config.relayHost && <CopyButton text={config.relayHost} />}
                            </div>
                          </div>
                          {config.publicKey && (
                            <div className="rounded-lg border bg-muted/30 p-3 space-y-1 sm:col-span-2">
                              <p className="text-xs text-muted-foreground">Public Key</p>
                              <div className="flex items-center gap-2">
                                <code className="text-sm font-mono font-medium flex-1 break-all">{config.publicKey}</code>
                                <CopyButton text={config.publicKey} />
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )}
              </>
            )}
          </TabsContent>
        </Tabs>

        <p className="text-center text-xs text-muted-foreground">
          Powered by{' '}
          <a href="https://rustdesk.com" className="underline" target="_blank" rel="noopener noreferrer">
            RustDesk
          </a>{' '}
          open-source remote desktop software.
          {releaseVersion && (
            <> · <a
              href={`https://github.com/rustdesk/rustdesk/releases/tag/${releaseVersion}`}
              className="underline"
              target="_blank"
              rel="noopener noreferrer"
            >v{releaseVersion}</a></>
          )}
        </p>
      </main>
    </div>
  );
}
