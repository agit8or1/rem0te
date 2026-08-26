'use client';

import { useQuery } from '@tanstack/react-query';
import { endpointsApi, sessionsApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { Monitor, Loader2 } from 'lucide-react';

type Computer = {
  id: string;
  name: string;
  hostname?: string | null;
  isOnline: boolean;
  platform?: string | null;
  osVersion?: string | null;
  lastSeenAt?: string | null;
  customer?: { id: string; name: string } | null;
  rustdeskNode?: { rustdeskId?: string | null } | null;
};

export default function MyComputersPage() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery({
    queryKey: ['my-computers'],
    queryFn: () => endpointsApi.mine().then((r) => r.data?.data ?? []),
    refetchInterval: 15_000,
  });
  const computers: Computer[] = data ?? [];

  async function connect(c: Computer) {
    try {
      const res = await endpointsApi.connect(c.id);
      const info = res.data?.data as { rustdeskId?: string; password?: string | null } | undefined;
      const rdId = info?.rustdeskId;
      if (!rdId) {
        toast({ title: 'Computer not ready', description: 'This computer has not finished enrollment.', variant: 'destructive' });
        return;
      }
      const pw = info?.password ?? null;
      // Best-effort: put the password on the clipboard AND embed it in the
      // rustdesk:// URI. Modern RustDesk builds honor the query-string password
      // so it's truly one click; older builds fall back to a clipboard paste.
      if (pw) {
        try { await navigator.clipboard.writeText(pw); } catch { /* ignore */ }
      }
      // Audit the launch.
      try { await sessionsApi.create({ endpointId: c.id }); } catch { /* audit only */ }
      // Hand over a file that does the whole job rather than a bare
      // rustdesk:// link.
      //
      // The link is routed by Windows to whichever RustDesk is installed,
      // using whatever server *that* client points at — and the URI scheme has
      // no field for a server address, so it cannot say "use ours". On a
      // machine whose RustDesk was never told about this server, or that
      // auto-updated to a stock build, it asks rustdesk.com, is told the ID is
      // unknown, and reports "the target device is offline or does not exist"
      // about an endpoint that is online. There is no fixing that from inside
      // the link.
      //
      // The script installs RustDesk if the machine has none, applies this
      // server's config, then opens the connection — and deletes itself,
      // because it carries a live credential.
      window.location.href = endpointsApi.connectScriptUrl(c.id);
    } catch (err) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Failed to start connection';
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    }
  }

  if (isLoading) {
    return (
      <div className="p-6 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading your computers…
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <PageHeader title="My Computers" description="Computers you're authorized to connect to." />

      {computers.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center space-y-3">
            <Monitor className="h-10 w-10 mx-auto text-muted-foreground/50" />
            <p className="font-medium">No computers assigned yet.</p>
            <p className="text-sm text-muted-foreground">
              Ask your company administrator to grant you access.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
          {computers.map((c) => (
            <Card key={c.id} className={c.isOnline ? '' : 'opacity-70'}>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between text-base">
                  <span>{c.name}</span>
                  <span className={`text-xs font-normal ${c.isOnline ? 'text-green-600' : 'text-muted-foreground'}`}>
                    {c.isOnline ? 'Online' : 'Offline'}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="text-xs text-muted-foreground space-x-3">
                  {c.platform && <span>{c.platform}</span>}
                  {c.osVersion && <span>{c.osVersion}</span>}
                  {c.customer?.name && <span>· {c.customer.name}</span>}
                </div>
                <Button onClick={() => connect(c)} disabled={!c.isOnline} className="w-full">
                  Connect
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
