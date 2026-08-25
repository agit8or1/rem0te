'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, Apple, CheckCircle2, Download, Loader2, Monitor,
  PhoneCall, Server, Zap,
} from 'lucide-react';
import { quickConnectApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/utils';

interface QuickConnectStatus {
  platformEnabled: boolean;
  businessEnabled: boolean;
  hasCapability: boolean;
  canUse: boolean;
  reason: string | null;
  businessName: string | null;
  downloads: { os: 'windows' | 'macos' | 'linux'; label: string; path: string }[];
}

interface QuickSession {
  id: string;
  adHocRustdeskId: string | null;
  status: string;
  contactName: string | null;
  startedAt: string | null;
  completedAt: string | null;
  duration: number | null;
  createdAt: string;
  technician: { firstName: string; lastName: string; email: string };
}

const OS_ICON = { windows: Monitor, macos: Apple, linux: Server } as const;

export default function QuickConnectPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [rustdeskId, setRustdeskId] = useState('');
  const [password, setPassword] = useState('');
  const [contactName, setContactName] = useState('');
  const [active, setActive] = useState<{ sessionId: string; rustdeskId: string } | null>(null);

  const { data: status, isLoading } = useQuery<QuickConnectStatus>({
    queryKey: ['quick-connect', 'status'],
    queryFn: () => quickConnectApi.status().then((r) => r.data?.data),
  });

  const { data: history } = useQuery<{ sessions: QuickSession[] }>({
    queryKey: ['quick-connect', 'sessions'],
    queryFn: () => quickConnectApi.sessions().then((r) => r.data?.data),
    enabled: !!status?.canUse,
  });

  const connect = useMutation({
    mutationFn: () => quickConnectApi.connect({
      rustdeskId: rustdeskId.trim(),
      password,
      ...(contactName.trim() ? { contactName: contactName.trim() } : {}),
    }),
    onSuccess: (res) => {
      const data = res.data?.data as { sessionId: string; rustdeskId: string; password: string };
      setActive({ sessionId: data.sessionId, rustdeskId: data.rustdeskId });

      // Hand the credentials straight to RustDesk and drop them. Rem0te has
      // not stored the password and neither should this page.
      const uri = `rustdesk://connection/new/${data.rustdeskId}?password=${encodeURIComponent(data.password)}`;
      window.location.href = uri;

      setPassword('');
      qc.invalidateQueries({ queryKey: ['quick-connect', 'sessions'] });
      toast({ title: 'Opening RustDesk…', description: `Connecting to ${data.rustdeskId}` });
    },
    onError: (e: { response?: { data?: { message?: string } } }) =>
      toast({
        title: 'Could not connect',
        description: e.response?.data?.message ?? 'Check the ID and password and try again.',
        variant: 'destructive',
      }),
  });

  const endSession = useMutation({
    mutationFn: (id: string) => quickConnectApi.endSession(id, 'completed'),
    onSuccess: () => {
      setActive(null);
      qc.invalidateQueries({ queryKey: ['quick-connect', 'sessions'] });
      toast({ title: 'Session closed' });
    },
  });

  if (isLoading) {
    return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  }

  if (!status?.canUse) {
    return (
      <div className="space-y-6">
        <PageHeader title="Quick Connect" description="Temporary support access." />
        <Card>
          <CardContent className="p-8 text-center">
            <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm font-medium">Quick Connect is not available to you</p>
            <p className="mt-1 text-sm text-muted-foreground">{status?.reason}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Quick Connect"
        description="Connect to a computer that is not a managed device, using an ID and password the person reads out to you."
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* Connect form */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Zap className="h-4 w-4 text-primary" /> Quick Connect
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="qc-id">Remote ID</Label>
              <Input
                id="qc-id"
                inputMode="numeric"
                autoComplete="off"
                placeholder="123 456 789"
                value={rustdeskId}
                onChange={(e) => setRustdeskId(e.target.value)}
                className="font-mono text-lg tracking-wider"
              />
            </div>

            <div>
              <Label htmlFor="qc-pw">Password</Label>
              <Input
                id="qc-pw"
                type="password"
                autoComplete="off"
                placeholder="A7k9X2"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="font-mono text-lg tracking-wider"
              />
            </div>

            <div>
              <Label htmlFor="qc-who">Who are you helping? (optional)</Label>
              <Input
                id="qc-who"
                placeholder="Name or reference for the session record"
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
              />
            </div>

            <Button
              className="w-full"
              disabled={!rustdeskId.trim() || !password || connect.isPending}
              onClick={() => connect.mutate()}
            >
              {connect.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Connect
            </Button>

            <p className="text-xs text-muted-foreground">
              Use this for temporary support sessions. The remote user must provide the ID and
              password displayed by their Quick Connect client. Rem0te does not store that password
              and never shows it anywhere else.
            </p>

            {active && (
              <div className="flex items-center justify-between rounded-md border bg-muted/40 p-3">
                <div className="flex items-center gap-2 text-sm">
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                  Session open with <span className="font-mono">{active.rustdeskId}</span>
                </div>
                <Button size="sm" variant="outline" onClick={() => endSession.mutate(active.sessionId)}>
                  Mark finished
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Downloads */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Download className="h-4 w-4" /> Quick Connect Client
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Send the person you are helping to the public page, or hand them a direct download.
              </p>

              {status.downloads.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No client builds are enabled. A Platform Admin can turn them on under Settings.
                </p>
              ) : (
                status.downloads.map((d) => {
                  const Icon = OS_ICON[d.os];
                  return (
                    <Button key={d.os} variant="outline" className="w-full justify-start" asChild>
                      <a href={d.path}>
                        <Icon className="mr-2 h-4 w-4" /> Download for {d.label}
                      </a>
                    </Button>
                  );
                })
              )}

              <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
                Public page:{' '}
                <a href="/quick" target="_blank" rel="noopener noreferrer" className="font-mono underline">
                  /quick
                </a>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <PhoneCall className="h-4 w-4" /> How it works
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="space-y-2 text-sm text-muted-foreground">
                <li><strong className="text-foreground">1.</strong> They download and run the Quick Connect client.</li>
                <li><strong className="text-foreground">2.</strong> It shows a Remote ID and a password.</li>
                <li><strong className="text-foreground">3.</strong> They read both to you.</li>
                <li><strong className="text-foreground">4.</strong> You type them in and connect.</li>
                <li><strong className="text-foreground">5.</strong> They close the client when you are done.</li>
              </ol>
              <p className="mt-3 text-xs text-muted-foreground">
                Nothing is installed as a service and no managed computer is created — closing the
                client ends their availability.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Recent sessions */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent Quick Connect sessions</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {!history?.sessions?.length ? (
            <div className="p-6 text-center text-sm text-muted-foreground">No sessions yet.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Remote ID</th>
                  <th className="px-4 py-3 font-medium">Contact</th>
                  <th className="px-4 py-3 font-medium">Started by</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">When</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {history.sessions.map((s) => (
                  <tr key={s.id} className="hover:bg-muted/40">
                    <td className="px-4 py-3 font-mono">{s.adHocRustdeskId ?? '—'}</td>
                    <td className="px-4 py-3">{s.contactName ?? <span className="text-muted-foreground">—</span>}</td>
                    <td className="px-4 py-3">
                      {`${s.technician.firstName ?? ''} ${s.technician.lastName ?? ''}`.trim() || s.technician.email}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={s.status === 'SESSION_COMPLETED' ? 'default' : 'secondary'}>
                        {s.status.replace(/_/g, ' ').toLowerCase()}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDate(s.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
