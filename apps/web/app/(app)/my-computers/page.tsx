'use client';

import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { endpointsApi, supportRequestsApi } from '@/lib/api-client';
import { usePermissions } from '@/lib/auth';
import { PageHeader } from '@/components/common/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { Monitor, Loader2, LifeBuoy } from 'lucide-react';

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

function apiMessage(e: unknown, fallback: string) {
  return (e as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message?.toString() ?? fallback;
}

export default function MyComputersPage() {
  const { toast } = useToast();
  const { user, isPlatformAdmin, technician, businessId } = usePermissions();
  const [requestOpen, setRequestOpen] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['my-computers'],
    queryFn: () => endpointsApi.mine().then((r) => r.data?.data ?? []),
    refetchInterval: 15_000,
  });
  const computers: Computer[] = data ?? [];

  // The API refuses requests from Platform Admins, from anyone acting through
  // a technician assignment, and from anyone without a business.
  const canRequestSupport = !!user && !isPlatformAdmin && !technician && !!businessId;

  async function connect(c: Computer) {
    try {
      // POST :id/connect records the support session itself and returns its
      // id. The Connect script is told to reuse that session, so one click is
      // one session; nothing else here creates one.
      const res = await endpointsApi.connect(c.id);
      const info = res.data?.data as { rustdeskId?: string; password?: string | null; sessionId?: string | null } | undefined;
      if (!info?.rustdeskId) {
        toast({ title: 'Computer not ready', description: 'This computer has not finished enrollment.', variant: 'destructive' });
        return;
      }
      // Best-effort: the password on the clipboard, for a client that asks.
      if (info.password) {
        try { await navigator.clipboard.writeText(info.password); } catch { /* ignore */ }
      }
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
      const url = endpointsApi.connectScriptUrl(c.id);
      window.location.href = info.sessionId ? `${url}?session=${encodeURIComponent(info.sessionId)}` : url;
    } catch (err) {
      toast({ title: 'Error', description: apiMessage(err, 'Failed to start connection'), variant: 'destructive' });
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
      <PageHeader title="My Computers" description="Computers you're authorized to connect to.">
        {canRequestSupport && (
          <Button size="sm" variant="outline" onClick={() => setRequestOpen(true)}>
            <LifeBuoy className="h-4 w-4 mr-2" />
            Request support
          </Button>
        )}
      </PageHeader>

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
                  <span className={`text-xs font-normal ${c.isOnline ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground'}`}>
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

      {/* Mounted only while open, so each request starts from an empty form. */}
      {canRequestSupport && requestOpen && (
        <RequestSupportDialog open={requestOpen} onOpenChange={setRequestOpen} computers={computers} />
      )}
    </div>
  );
}

const NO_COMPUTER = '__none__';

function RequestSupportDialog({
  open, onOpenChange, computers,
}: { open: boolean; onOpenChange: (o: boolean) => void; computers: Computer[] }) {
  const { toast } = useToast();
  const [description, setDescription] = useState('');
  const [endpointId, setEndpointId] = useState(NO_COMPUTER);
  const [phone, setPhone] = useState('');
  const [statusToken, setStatusToken] = useState<string | null>(null);
  const sent = statusToken !== null;

  const submit = useMutation({
    mutationFn: () => supportRequestsApi.submit({
      description: description.trim(),
      ...(endpointId !== NO_COMPUTER ? { endpointId } : {}),
      ...(phone.trim() ? { phone: phone.trim() } : {}),
    }),
    onSuccess: (res) => setStatusToken((res.data?.data as { statusToken?: string } | undefined)?.statusToken ?? ''),
    onError: (e: unknown) => toast({
      title: 'Request not sent',
      description: apiMessage(e, 'Could not send your request'),
      variant: 'destructive',
    }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request support</DialogTitle>
          <DialogDescription>
            Your request goes into your support team&apos;s queue. A technician picks it up from there.
          </DialogDescription>
        </DialogHeader>

        {sent ? (
          <div className="space-y-2 text-sm">
            <p className="font-medium">Request sent.</p>
            <p className="text-muted-foreground">It is waiting for a technician. Nobody has picked it up yet.</p>
            {statusToken && (
              <p>
                <a
                  href={`/support/status/${encodeURIComponent(statusToken)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline underline-offset-2"
                >
                  Follow its status
                </a>
              </p>
            )}
          </div>
        ) : (
          <form
            id="request-support-form"
            className="space-y-4"
            onSubmit={(e) => { e.preventDefault(); if (description.trim()) submit.mutate(); }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="rs-desc">What do you need help with? *</Label>
              <Textarea
                id="rs-desc"
                rows={4}
                maxLength={2000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                required
              />
            </div>
            {computers.length > 0 && (
              <div className="space-y-1.5">
                <Label htmlFor="rs-computer">Computer (optional)</Label>
                <Select value={endpointId} onValueChange={setEndpointId}>
                  <SelectTrigger id="rs-computer"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_COMPUTER}>Not about a specific computer</SelectItem>
                    {computers.map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="rs-phone">Phone (optional)</Label>
              <Input id="rs-phone" type="tel" maxLength={40} value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
          </form>
        )}

        <DialogFooter>
          {sent ? (
            <Button onClick={() => onOpenChange(false)}>Close</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submit.isPending}>Cancel</Button>
              <Button type="submit" form="request-support-form" disabled={!description.trim() || submit.isPending}>
                {submit.isPending ? 'Sending…' : 'Send request'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
