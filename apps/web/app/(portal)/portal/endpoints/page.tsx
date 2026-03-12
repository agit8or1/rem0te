'use client';
import { useQuery, useMutation } from '@tanstack/react-query';
import { portalApi } from '@/lib/api-client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Monitor, Wifi, WifiOff, PlayCircle, ExternalLink, MonitorPlay } from 'lucide-react';
import { useState } from 'react';
import { useToast } from '@/hooks/use-toast';

export default function PortalEndpointsPage() {
  const { toast } = useToast();
  const [requestingId, setRequestingId] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [launchUrl, setLaunchUrl] = useState<string | null>(null);
  const [issue, setIssue] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['portal-endpoints'],
    queryFn: () => portalApi.endpoints().then(r => r.data?.data ?? []),
  });
  const endpoints = Array.isArray(data) ? data : [];

  const requestMutation = useMutation({
    mutationFn: (endpointId: string) => portalApi.requestSupport({ endpointId, issueDescription: issue }),
    onSuccess: () => {
      toast({ title: 'Support request sent! A technician will be with you shortly.' });
      setRequestingId(null);
      setIssue('');
    },
    onError: () => toast({ title: 'Failed to send request', variant: 'destructive' }),
  });

  const connectMutation = useMutation({
    mutationFn: (endpointId: string) => portalApi.connect(endpointId),
    onSuccess: (res) => {
      const url = res.data?.data?.launchUrl as string;
      setLaunchUrl(url ?? null);
    },
    onError: () => toast({ title: 'Failed to initiate connection', variant: 'destructive' }),
  });

  function handleConnect(ep: Record<string, unknown>) {
    setConnectingId(ep.id as string);
    setLaunchUrl(null);
    setRequestingId(null);
    connectMutation.mutate(ep.id as string);
  }

  if (isLoading) return <div className="p-6 text-muted-foreground">Loading devices&hellip;</div>;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">My Devices</h1>
        <p className="text-muted-foreground text-sm mt-1">Devices registered under your account.</p>
      </div>

      {endpoints.length === 0 ? (
        <Card><CardContent className="py-12 text-center text-muted-foreground">No devices found. Contact your support team to have devices added.</CardContent></Card>
      ) : (
        <div className="grid gap-4">
          {endpoints.map((ep: Record<string, unknown>) => (
            <Card key={ep.id as string}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Monitor className="h-8 w-8 text-muted-foreground" />
                    <div>
                      <div className="font-medium">{ep.name as string}</div>
                      <div className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                        {ep.isOnline
                          ? <Wifi className="h-3 w-3 text-green-500" />
                          : <WifiOff className="h-3 w-3 text-muted-foreground" />}
                        {ep.isOnline ? 'Online' : 'Offline'} &middot; {(ep.platform as string) ?? 'Unknown'} &middot; {(ep.hostname as string) ?? ''}
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleConnect(ep)}
                      disabled={connectMutation.isPending && connectingId === ep.id}
                    >
                      <MonitorPlay className="h-4 w-4 mr-2" />
                      Connect Remotely
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => { setRequestingId(ep.id as string); setConnectingId(null); setLaunchUrl(null); }}
                      disabled={requestMutation.isPending}
                    >
                      <PlayCircle className="h-4 w-4 mr-2" />
                      Request Support
                    </Button>
                  </div>
                </div>

                {/* Self-service connect panel */}
                {connectingId === ep.id && (
                  <div className="mt-4 border-t pt-4 space-y-3">
                    {connectMutation.isPending ? (
                      <p className="text-sm text-muted-foreground">Starting session&hellip;</p>
                    ) : launchUrl ? (
                      <>
                        <p className="text-sm font-medium">Ready to connect</p>
                        <p className="text-xs text-muted-foreground">
                          RustDesk must be installed on <strong>this computer</strong>. The remote PC must have
                          unattended access (permanent password) configured in RustDesk settings.
                        </p>
                        <div className="flex gap-2">
                          <Button asChild size="sm">
                            <a href={launchUrl}>
                              <ExternalLink className="h-4 w-4 mr-2" />
                              Open in RustDesk
                            </a>
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => { setConnectingId(null); setLaunchUrl(null); }}>
                            Cancel
                          </Button>
                        </div>
                      </>
                    ) : null}
                  </div>
                )}

                {/* Request support panel */}
                {requestingId === ep.id && (
                  <div className="mt-4 space-y-3 border-t pt-4">
                    <div className="space-y-1">
                      <label className="text-sm font-medium">Describe the issue (optional)</label>
                      <textarea
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[80px]"
                        placeholder="e.g. My computer is running slowly, can't open email…"
                        value={issue}
                        onChange={e => setIssue(e.target.value)}
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button onClick={() => requestMutation.mutate(ep.id as string)} disabled={requestMutation.isPending}>
                        {requestMutation.isPending ? 'Sending\u2026' : 'Send Request'}
                      </Button>
                      <Button variant="outline" onClick={() => setRequestingId(null)}>Cancel</Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
