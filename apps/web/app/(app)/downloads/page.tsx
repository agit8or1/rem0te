'use client';

import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle, CheckCircle2, Download, Loader2, Settings2, Wrench,
} from 'lucide-react';
import { downloadsApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

interface DownloadItem {
  id: 'setup' | 'configured' | 'plain';
  label: string;
  filename: string;
  path: string;
  description: string;
  recommended: boolean;
}

interface Manifest {
  configured: boolean;
  relayHost: string | null;
  rustdeskVersion: string;
  downloads: DownloadItem[];
}

const ICON = { setup: Wrench, configured: Settings2, plain: Download } as const;

export default function DownloadsPage() {
  const { data, isLoading } = useQuery<Manifest>({
    queryKey: ['downloads'],
    queryFn: async () => (await downloadsApi.manifest()).data.data,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Downloads"
        description="RustDesk clients for the computer you connect from."
      />

      {!data?.configured && (
        <Card className="border-amber-500/40">
          <CardContent className="flex items-start gap-3 pt-6">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <p className="text-sm text-muted-foreground">
              No RustDesk relay host is configured, so none of these can be prepared.
              A Platform Admin must set it under Settings first.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Why this page exists</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            The <strong className="text-foreground">Connect</strong> button opens a{' '}
            <code className="font-mono text-xs">rustdesk://</code> link, which Windows hands to
            whichever RustDesk is installed on your machine — using whatever server{' '}
            <em>that</em> client is set to. The link has no way to carry a server address.
          </p>
          <p>
            So a RustDesk that has never been told about{' '}
            <span className="font-mono text-foreground">{data?.relayHost ?? 'this server'}</span>{' '}
            asks rustdesk.com&apos;s public servers instead, is told the ID does not exist, and
            reports{' '}
            <em>&ldquo;the target device is offline or does not exist&rdquo;</em> — about a
            computer that is online and perfectly reachable.
          </p>
          <p className="text-foreground">
            <strong>You usually do not need this page.</strong> Clicking{' '}
            <strong>Connect</strong> on a computer hands you a file that installs RustDesk if
            needed, configures it, and opens the session — no setup in advance.
          </p>
          <p>
            Use the files below to prepare a machine <em>before</em> someone needs it, or when you
            want a client on hand without connecting to anything yet.
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        {data?.downloads.map((d) => {
          const Icon = ICON[d.id];
          return (
            <Card key={d.id} className={d.recommended ? 'border-primary/50' : undefined}>
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Icon className="h-4 w-4" /> {d.label}
                  </CardTitle>
                  {d.recommended && (
                    <Badge variant="default" className="shrink-0">
                      <CheckCircle2 className="mr-1 h-3 w-3" /> Start here
                    </Badge>
                  )}
                </div>
                <CardDescription>{d.description}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Button
                  variant={d.recommended ? 'default' : 'outline'}
                  className="w-full"
                  disabled={!data?.configured && d.id !== 'plain'}
                  asChild
                >
                  <a href={d.path} download>
                    <Download className="mr-2 h-4 w-4" /> Download
                  </a>
                </Button>
                <p className="break-all font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {d.filename}
                </p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">If Connect still fails</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            <strong className="text-foreground">Close RustDesk completely first.</strong> A running
            client will not pick up a configuration change — quit it from the system tray, not just
            the window, then run the setup file again.
          </p>
          <p>
            <strong className="text-foreground">Uninstalling RustDesk does not clear its
            settings.</strong> <code className="font-mono text-xs">%APPDATA%\RustDesk</code>{' '}
            survives, and a fresh install picks the old server back up. Delete that folder before
            reinstalling.
          </p>
          <p>
            <strong className="text-foreground">The preconfigured client keeps its config in its
            filename.</strong> If your browser saved it as{' '}
            <code className="font-mono text-xs">rustdesk (1).exe</code>, it configures nothing — use
            the setup file instead.
          </p>
          <p>
            RustDesk client version served here: <span className="font-mono">{data?.rustdeskVersion}</span>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
