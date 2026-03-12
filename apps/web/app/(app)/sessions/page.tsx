'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { sessionsApi, endpointsApi, launcherApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { SessionStatusBadge } from '@/components/sessions/session-status-badge';
import { useToast } from '@/hooks/use-toast';
import { formatDate, formatDuration } from '@/lib/utils';
import { Plus, PlayCircle, X, Monitor, Wifi, RefreshCw } from 'lucide-react';

export default function SessionsPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [adHocId, setAdHocId] = useState('');
  const [contactName, setContactName] = useState('');
  const [issue, setIssue] = useState('');

  const { data: sessionsData, isLoading: sessionsLoading } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => sessionsApi.list().then((r) => r.data?.data),
    refetchInterval: 15_000,
  });

  const { data: connectedData, isLoading: connectedLoading, refetch: refetchConnected } = useQuery({
    queryKey: ['endpoints-connected'],
    queryFn: () => endpointsApi.connected().then((r) => r.data?.data),
    refetchInterval: 30_000,
  });

  const createMutation = useMutation({
    mutationFn: () =>
      sessionsApi.create({
        adHocRustdeskId: adHocId,
        isAdHoc: true,
        contactName: contactName || undefined,
        issueDescription: issue || undefined,
      }),
    onSuccess: () => {
      toast({ title: 'Session created' });
      qc.invalidateQueries({ queryKey: ['sessions'] });
      setShowCreate(false);
      setAdHocId('');
      setContactName('');
      setIssue('');
    },
    onError: () => toast({ title: 'Error', description: 'Failed to create session', variant: 'destructive' }),
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => sessionsApi.cancel(id),
    onSuccess: () => {
      toast({ title: 'Session cancelled' });
      qc.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: () => toast({ title: 'Error', description: 'Failed to cancel session', variant: 'destructive' }),
  });

  const connectMutation = useMutation({
    mutationFn: (endpointId: string) => launcherApi.issueToken({ endpointId }),
    onSuccess: (res) => {
      const deepLink = res.data?.data?.deepLink;
      if (deepLink) window.location.href = deepLink;
      toast({ title: 'Launching RustDesk…' });
    },
    onError: () => toast({ title: 'Error', description: 'Failed to launch session', variant: 'destructive' }),
  });

  const INACTIVE = ['SESSION_COMPLETED', 'FAILED', 'CANCELED'];
  const sessions: Record<string, unknown>[] = sessionsData?.sessions ?? [];
  const activeSessions = sessions.filter((s) => !INACTIVE.includes(s.status as string));
  const connected: Record<string, unknown>[] = Array.isArray(connectedData) ? connectedData : [];
  const connectedCount = activeSessions.length + connected.length;

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Sessions" description="Connected clients and session history">
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Ad-hoc Session
        </Button>
      </PageHeader>

      <Tabs defaultValue="connected">
        <TabsList>
          <TabsTrigger value="connected" className="gap-2">
            <Wifi className="h-3.5 w-3.5" />
            Connected
            {connectedCount > 0 && (
              <Badge variant="secondary" className="ml-1 h-4 px-1.5 text-[10px]">
                {connectedCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="history" className="gap-2">
            <Monitor className="h-3.5 w-3.5" />
            Session History
          </TabsTrigger>
        </TabsList>

        {/* ─── Connected Clients ─── */}
        <TabsContent value="connected" className="mt-4">
          <div className="space-y-5">

            {/* Active / waiting sessions */}
            {activeSessions.length > 0 && (
              <div className="space-y-3">
                <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse inline-block" />
                  Active Sessions ({activeSessions.length})
                </h2>
                <div className="rounded-md border bg-background overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        <th className="text-left px-4 py-2 font-medium text-xs">Endpoint / RustDesk ID</th>
                        <th className="text-left px-4 py-2 font-medium text-xs">Contact</th>
                        <th className="text-left px-4 py-2 font-medium text-xs">Status</th>
                        <th className="text-left px-4 py-2 font-medium text-xs">Created</th>
                        <th className="px-4 py-2" />
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {activeSessions.map((s) => {
                        const ep = s.endpoint as { id: string; name: string } | null;
                        const epId = ep?.id;
                        const rustdeskId = s.adHocRustdeskId as string | null;
                        return (
                          <tr key={s.id as string} className="hover:bg-muted/30">
                            <td className="px-4 py-3">
                              {ep ? (
                                <Link href={`/endpoints/${epId}`} className="hover:underline font-medium">
                                  {ep.name}
                                </Link>
                              ) : (
                                <span className="font-mono text-xs">{rustdeskId ?? '—'}</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-muted-foreground text-xs">
                              {(s.contactName as string) ?? '—'}
                            </td>
                            <td className="px-4 py-3">
                              <SessionStatusBadge status={s.status as string} />
                            </td>
                            <td className="px-4 py-3 text-muted-foreground text-xs">
                              {formatDate(s.createdAt as string)}
                            </td>
                            <td className="px-4 py-3 text-right">
                              <div className="flex items-center justify-end gap-1">
                                {(epId || rustdeskId) && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 px-2 text-xs gap-1"
                                    onClick={() => {
                                      if (epId) connectMutation.mutate(epId);
                                      else window.location.href = `rustdesk://connection/new/${rustdeskId}`;
                                    }}
                                    disabled={connectMutation.isPending}
                                  >
                                    <PlayCircle className="h-3 w-3" />
                                    Connect
                                  </Button>
                                )}
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 px-2 text-xs text-destructive hover:text-destructive gap-1"
                                  onClick={() => cancelMutation.mutate(s.id as string)}
                                  disabled={cancelMutation.isPending}
                                >
                                  <X className="h-3 w-3" />
                                  Cancel
                                </Button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Online enrolled endpoints */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-green-500 inline-block" />
                  Online Enrolled Clients ({connected.length})
                </h2>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 gap-1 text-xs"
                  onClick={() => refetchConnected()}
                  disabled={connectedLoading}
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${connectedLoading ? 'animate-spin' : ''}`} />
                  Refresh
                </Button>
              </div>

              {connectedLoading ? (
                <div className="text-sm text-muted-foreground py-4 text-center">Loading…</div>
              ) : connected.length === 0 ? (
                <div className="rounded-md border border-dashed py-8 text-center text-sm text-muted-foreground space-y-1">
                  <Monitor className="h-6 w-6 mx-auto opacity-30" />
                  <p>No enrolled clients online.</p>
                  <p className="text-xs">Clients appear here when the agent sends a heartbeat.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                  {connected.map((ep) => {
                    const epId = ep.id as string;
                    const node = ep.rustdeskNode as { rustdeskId?: string; lastSeenAt?: string } | null;
                    const customer = ep.customer as { name: string } | null;
                    const lastSeen = node?.lastSeenAt ?? ep.lastSeenAt as string | null;
                    return (
                      <Card key={epId} className="flex flex-col border-green-200 dark:border-green-900">
                        <CardHeader className="pb-2 pt-3 px-4">
                          <CardTitle className="text-sm flex items-center justify-between gap-2">
                            <span className="truncate">
                              <Link href={`/endpoints/${epId}`} className="hover:underline">
                                {ep.name as string}
                              </Link>
                            </span>
                            <span className="flex-none w-2 h-2 rounded-full bg-green-500 animate-pulse" title="Online" />
                          </CardTitle>
                        </CardHeader>
                        <CardContent className="px-4 pb-3 pt-0 flex flex-col gap-2">
                          {ep.hostname ? (
                            <p className="text-xs text-muted-foreground font-mono truncate">{ep.hostname as string}</p>
                          ) : null}
                          {customer && (
                            <p className="text-xs text-muted-foreground truncate">{customer.name}</p>
                          )}
                          {lastSeen && (
                            <p className="text-[10px] text-muted-foreground">Last seen {formatDate(lastSeen)}</p>
                          )}
                          {node?.rustdeskId && (
                            <Button
                              size="sm"
                              className="w-full gap-1.5"
                              onClick={() => connectMutation.mutate(epId)}
                              disabled={connectMutation.isPending}
                            >
                              <PlayCircle className="h-3.5 w-3.5" />
                              Connect
                            </Button>
                          )}
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              )}
            </div>

            {activeSessions.length === 0 && connected.length === 0 && !connectedLoading && (
              <div className="rounded-md border border-dashed py-12 text-center text-sm text-muted-foreground space-y-2">
                <Wifi className="h-8 w-8 mx-auto opacity-30" />
                <p>No active sessions or connected clients.</p>
              </div>
            )}
          </div>
        </TabsContent>

        {/* ─── Session History ─── */}
        <TabsContent value="history" className="mt-4">
          {sessionsLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : (
            <div className="rounded-md border bg-background overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left px-4 py-3 font-medium">Endpoint / Target</th>
                    <th className="text-left px-4 py-3 font-medium">Technician</th>
                    <th className="text-left px-4 py-3 font-medium">Started</th>
                    <th className="text-left px-4 py-3 font-medium">Duration</th>
                    <th className="text-left px-4 py-3 font-medium">Status</th>
                    <th className="text-left px-4 py-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {sessions.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="text-center py-8 text-muted-foreground">
                        No sessions yet.
                      </td>
                    </tr>
                  ) : (
                    sessions.map((s) => {
                      const ep = s.endpoint as { id: string; name: string } | null;
                      const tech = s.technician as { email: string } | null;
                      const status = s.status as string;
                      const canCancel = status === 'ACTIVE' || status === 'PENDING';
                      return (
                        <tr key={s.id as string} className="hover:bg-muted/30">
                          <td className="px-4 py-3">
                            {ep ? (
                              <Link href={`/endpoints/${ep.id}`} className="hover:underline font-medium">
                                {ep.name}
                              </Link>
                            ) : (
                              <span className="text-muted-foreground font-mono text-xs">
                                {(s.adHocRustdeskId as string) ?? 'Ad-hoc'}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">{tech?.email ?? '—'}</td>
                          <td className="px-4 py-3 text-muted-foreground text-xs">
                            {formatDate((s.startedAt as string) ?? (s.createdAt as string))}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {formatDuration(s.duration as number)}
                          </td>
                          <td className="px-4 py-3">
                            <SessionStatusBadge status={status} />
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1">
                              {ep && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 text-xs gap-1"
                                  onClick={() => connectMutation.mutate(ep.id)}
                                  disabled={connectMutation.isPending}
                                >
                                  <PlayCircle className="h-3 w-3" />
                                  Connect
                                </Button>
                              )}
                              {canCancel && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 text-xs text-destructive hover:text-destructive gap-1"
                                  onClick={() => cancelMutation.mutate(s.id as string)}
                                  disabled={cancelMutation.isPending}
                                >
                                  <X className="h-3 w-3" />
                                  Cancel
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>
      </Tabs>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start Ad-hoc Session</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="rustdesk-id">RustDesk ID *</Label>
              <Input
                id="rustdesk-id"
                placeholder="123456789"
                value={adHocId}
                onChange={(e) => setAdHocId(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="contact">Contact Name</Label>
              <Input
                id="contact"
                placeholder="John Smith"
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="issue">Issue Description</Label>
              <Input
                id="issue"
                placeholder="Cannot print…"
                value={issue}
                onChange={(e) => setIssue(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={!adHocId || createMutation.isPending}
            >
              {createMutation.isPending ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
