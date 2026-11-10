'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { api, sessionsApi, endpointsApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  SessionStatusBadge,
  isTerminalSessionStatus,
} from '@/components/sessions/session-status-badge';
import { usePermissions, CAP } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';
import { formatDate, formatDuration } from '@/lib/utils';
import { PlayCircle, X, Monitor, Wifi, RefreshCw, Zap, CheckCircle, Info } from 'lucide-react';

type Row = Record<string, unknown>;

function apiMessage(e: unknown, fallback: string) {
  return (e as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message?.toString() ?? fallback;
}

/** What each recorded event means, in the API's own vocabulary. */
const EVENT_LABEL: Record<string, string> = {
  launch_requested: 'Launch requested',
  launcher_acknowledged: 'Launcher acknowledged',
  client_opened: 'RustDesk opened on the technician’s computer',
  client_launch_failed: 'RustDesk failed to open',
  connection_confirmed: 'Connection confirmed',
  connection_observed_ambiguous: 'A connection was seen, but could not be tied to this launch',
  disconnected: 'Disconnected',
  technician_completed: 'Completed by technician',
  technician_canceled: 'Canceled by technician',
  technician_failed: 'Marked failed by technician',
  timeout_unknown: 'Closed by timeout: no signal arrived',
  timeout_ended: 'Closed by timeout: no end signal arrived',
};

const SOURCE_LABEL: Record<string, string> = {
  server: 'server',
  launcher: 'launcher',
  connect_script: 'Connect script',
  endpoint_agent: 'endpoint agent',
  technician: 'technician',
  timeout: 'timeout',
};

/**
 * Duration is shown only when the API measured it: a confirmed start and an
 * observed end, both from the endpoint. Everything else says why not.
 */
function durationInfo(s: Row): { real: boolean; text: string; why?: string } {
  const quality = (s.timingQuality as string | undefined) ?? 'UNKNOWN';
  const duration = s.duration as number | null | undefined;
  if (quality === 'MEASURED' && typeof duration === 'number') {
    return { real: true, text: formatDuration(duration) };
  }
  if (!isTerminalSessionStatus(s.status as string)) {
    return { real: false, text: 'Unknown', why: 'The session is still open.' };
  }
  const why: Record<string, string> = {
    REPORTED: 'The start or end came from a technician’s report, not from the computer, so no duration was measured.',
    INFERRED: 'The end was inferred from a timeout because no end signal arrived, so no duration is claimed.',
    LEGACY: 'Recorded before connection tracking: its times are launch times, not connection times.',
    UNKNOWN: 'No connection start and end were observed by the computer.',
  };
  return { real: false, text: 'Unknown', why: why[quality] ?? why.UNKNOWN };
}

export default function SessionsPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { can } = usePermissions();
  const canConnect = can(CAP.COMPUTERS_CONNECT);
  const [detailId, setDetailId] = useState<string | null>(null);

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

  const cancelMutation = useMutation({
    mutationFn: (id: string) => sessionsApi.cancel(id),
    onSuccess: (_r, id) => {
      toast({ title: 'Session canceled' });
      qc.invalidateQueries({ queryKey: ['sessions'] });
      qc.invalidateQueries({ queryKey: ['session', id] });
    },
    // 403: not this person's session to change; 409: already closed.
    onError: (e: unknown, id) => {
      toast({ title: 'Could not cancel session', description: apiMessage(e, 'Failed to cancel session'), variant: 'destructive' });
      qc.invalidateQueries({ queryKey: ['sessions'] });
      qc.invalidateQueries({ queryKey: ['session', id] });
    },
  });

  // Connect creates the session server-side (POST :id/connect returns its
  // id); the Connect script is then told to reuse it, so one click is one
  // session.
  const connectMutation = useMutation({
    mutationFn: (endpointId: string) => endpointsApi.connect(endpointId),
    onSuccess: async (res, endpointId) => {
      const info = res.data?.data as { rustdeskId?: string; sessionId?: string | null } | undefined;
      if (!info?.rustdeskId) {
        toast({ title: 'Computer not ready', description: 'This computer has not finished enrollment.', variant: 'destructive' });
        return;
      }
      const url = endpointsApi.connectScriptUrl(endpointId);
      window.location.href = info.sessionId ? `${url}?session=${encodeURIComponent(info.sessionId)}` : url;
      qc.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (e: unknown) => toast({ title: 'Could not connect', description: apiMessage(e, 'Failed to start connection'), variant: 'destructive' }),
  });

  const sessions: Row[] = sessionsData?.sessions ?? [];
  const activeSessions = sessions.filter((s) => !isTerminalSessionStatus(s.status as string));
  const connected: Row[] = Array.isArray(connectedData) ? connectedData : [];
  const connectedCount = activeSessions.length + connected.length;

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Sessions" description="Connected clients and session history">
        {/* Ad-hoc sessions go through Quick Connect; POST /sessions refuses them. */}
        {can(CAP.QUICK_CONNECT) && (
          <Button size="sm" variant="outline" asChild>
            <Link href="/quick-connect">
              <Zap className="h-4 w-4 mr-2" />
              Quick Connect
            </Link>
          </Button>
        )}
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

            {/* Open sessions: launched or confirmed, not yet closed */}
            {activeSessions.length > 0 && (
              <div className="space-y-3">
                <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-amber-500 inline-block" />
                  Open Sessions ({activeSessions.length})
                </h2>
                <div className="rounded-md border bg-background overflow-x-auto">
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
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 px-2 text-xs gap-1"
                                  onClick={() => setDetailId(s.id as string)}
                                >
                                  <Info className="h-3 w-3" />
                                  Details
                                </Button>
                                {canConnect && epId && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 px-2 text-xs gap-1"
                                    onClick={() => connectMutation.mutate(epId)}
                                    disabled={connectMutation.isPending}
                                  >
                                    <PlayCircle className="h-3 w-3" />
                                    Connect
                                  </Button>
                                )}
                                {canConnect && (
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
                                )}
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
                            <span className="flex-none w-2 h-2 rounded-full bg-green-500" title="Online" />
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
                          {canConnect && node?.rustdeskId && (
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
                <p>No open sessions or connected clients.</p>
              </div>
            )}
          </div>
        </TabsContent>

        {/* ─── Session History ─── */}
        <TabsContent value="history" className="mt-4">
          {sessionsLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : (
            <div className="rounded-md border bg-background overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left px-4 py-3 font-medium">Endpoint / Target</th>
                    <th className="text-left px-4 py-3 font-medium">Started by</th>
                    <th className="text-left px-4 py-3 font-medium">Launched</th>
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
                      const open = !isTerminalSessionStatus(status);
                      const dur = durationInfo(s);
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
                            {formatDate((s.launchRequestedAt as string) ?? (s.createdAt as string))}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground" title={dur.why}>
                            {dur.real ? dur.text : <span className="italic">{dur.text}</span>}
                          </td>
                          <td className="px-4 py-3">
                            <SessionStatusBadge status={status} />
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs gap-1"
                                onClick={() => setDetailId(s.id as string)}
                              >
                                <Info className="h-3 w-3" />
                                Details
                              </Button>
                              {canConnect && ep && (
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
                              {canConnect && open && (
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

      <SessionDetailDialog
        id={detailId}
        onClose={() => setDetailId(null)}
        canChange={canConnect}
        onCancel={(id) => cancelMutation.mutate(id)}
        cancelPending={cancelMutation.isPending}
      />
    </div>
  );
}

function SessionDetailDialog({
  id, onClose, canChange, onCancel, cancelPending,
}: {
  id: string | null;
  onClose: () => void;
  canChange: boolean;
  onCancel: (id: string) => void;
  cancelPending: boolean;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [completing, setCompleting] = useState(false);
  const [notes, setNotes] = useState('');
  const [disposition, setDisposition] = useState('');
  const [minutes, setMinutes] = useState('');

  const { data: s, isLoading } = useQuery<Row>({
    queryKey: ['session', id],
    queryFn: () => sessionsApi.get(id!).then((r) => r.data?.data),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data && !isTerminalSessionStatus(q.state.data.status as string) ? 10_000 : false),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['sessions'] });
    qc.invalidateQueries({ queryKey: ['session', id] });
  };

  const completeMutation = useMutation({
    mutationFn: () => {
      const m = minutes.trim() === '' ? undefined : Number(minutes);
      return sessionsApi.complete(id!, {
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(disposition.trim() ? { disposition: disposition.trim() } : {}),
        ...(m !== undefined && Number.isInteger(m) ? { manualWorkMinutes: m } : {}),
      });
    },
    onSuccess: () => {
      toast({ title: 'Session completed' });
      setCompleting(false);
      setNotes(''); setDisposition(''); setMinutes('');
      refresh();
    },
    onError: (e: unknown) => {
      toast({ title: 'Could not complete session', description: apiMessage(e, 'Failed to complete session'), variant: 'destructive' });
      refresh();
    },
  });

  // A technician's own report. Recorded as theirs, never as the computer's.
  const reportMutation = useMutation({
    mutationFn: (event: 'connected' | 'failed') => api.post(`/sessions/${id}/events`, { event }),
    onSuccess: (_r, event) => {
      toast({ title: event === 'connected' ? 'Recorded: you reported connected' : 'Recorded: you reported it failed' });
      refresh();
    },
    onError: (e: unknown) => {
      toast({ title: 'Not recorded', description: apiMessage(e, 'Failed to record'), variant: 'destructive' });
      refresh();
    },
  });

  const minutesValid = minutes.trim() === '' || (/^\d+$/.test(minutes.trim()) && Number(minutes) <= 1440);
  const status = (s?.status as string) ?? '';
  const open = !!s && !isTerminalSessionStatus(status);
  const events = (s?.events as Row[] | undefined) ?? [];
  const ep = s?.endpoint as { id: string; name: string; hostname?: string | null } | null | undefined;
  const tech = s?.technician as { email: string; firstName?: string | null; lastName?: string | null } | null | undefined;
  const dur = s ? durationInfo(s) : null;

  return (
    <Dialog open={!!id} onOpenChange={(o) => { if (!o) { setCompleting(false); onClose(); } }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            Session
            {s && <SessionStatusBadge status={status} />}
          </DialogTitle>
          <DialogDescription>
            {ep ? ep.name : (s?.adHocRustdeskId as string | undefined) ? `Quick Connect · ${s?.adHocRustdeskId as string}` : ' '}
          </DialogDescription>
        </DialogHeader>

        {isLoading || !s ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-5 text-sm">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
              <Field label="Technician">{tech ? ([tech.firstName, tech.lastName].filter(Boolean).join(' ') || tech.email) : '—'}</Field>
              <Field label="Contact">{(s.contactName as string) || '—'}</Field>
              <Field label="Launch requested">{s.launchRequestedAt ? formatDate(s.launchRequestedAt as string) : '—'}</Field>
              <Field label="Connection confirmed">{s.connectionConfirmedAt ? formatDate(s.connectionConfirmedAt as string) : '—'}</Field>
              <Field label="Ended">
                {s.endedAt ? `${formatDate(s.endedAt as string)}${s.endInferred ? ' (inferred)' : ''}` : '—'}
              </Field>
              <Field label="Duration">
                {dur?.real ? dur.text : <span className="italic text-muted-foreground">Unknown</span>}
              </Field>
              {typeof s.manualWorkMinutes === 'number' && (
                <Field label="Work time (entered)">{`${s.manualWorkMinutes as number} min`}</Field>
              )}
              {!!s.disposition && <Field label="Disposition">{s.disposition as string}</Field>}
            </div>

            {dur && !dur.real && dur.why && (
              <p className="text-xs text-muted-foreground rounded-md border bg-muted/40 px-3 py-2">
                Duration unknown: {dur.why}
              </p>
            )}

            {!!s.notes && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Notes</p>
                <p className="whitespace-pre-wrap">{s.notes as string}</p>
              </div>
            )}

            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Timeline</p>
              {events.length === 0 ? (
                <p className="text-muted-foreground text-xs">No events recorded.</p>
              ) : (
                <ol className="relative border-l pl-4 space-y-3">
                  {events.map((e) => {
                    const name = e.event as string;
                    const at = (e.occurredAt as string | null) ?? (e.timestamp as string);
                    const src = e.source as string | null;
                    const applied = e.applied !== false;
                    return (
                      <li key={e.id as string} className="relative">
                        <span
                          className={`absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-background ${applied ? 'bg-primary' : 'bg-muted-foreground/40'}`}
                          aria-hidden="true"
                        />
                        <p className={applied ? '' : 'text-muted-foreground'}>
                          {EVENT_LABEL[name] ?? name}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {formatDate(at)}
                          {src ? ` · from ${SOURCE_LABEL[src] ?? src}` : ''}
                          {!applied ? ' · recorded, changed nothing' : ''}
                        </p>
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>

            {open && canChange && completing && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-xs text-muted-foreground">
                  Completing records your close-out. It does not measure a duration.
                </p>
                <div className="space-y-1.5">
                  <Label htmlFor="s-notes">Notes</Label>
                  <Textarea id="s-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="s-disp">Disposition</Label>
                    <Input id="s-disp" placeholder="e.g. Resolved" value={disposition} onChange={(e) => setDisposition(e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="s-min">Work time (minutes)</Label>
                    <Input id="s-min" inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
                    {!minutesValid && <p className="text-xs text-destructive">Whole minutes, 0 to 1440.</p>}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {s && open && canChange && (
          <DialogFooter className="flex-wrap gap-2 sm:justify-between">
            {completing ? (
              <>
                <Button variant="outline" onClick={() => setCompleting(false)} disabled={completeMutation.isPending}>Back</Button>
                <Button onClick={() => completeMutation.mutate()} disabled={!minutesValid || completeMutation.isPending}>
                  {completeMutation.isPending ? 'Saving…' : 'Complete session'}
                </Button>
              </>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  {status !== 'SESSION_STARTED' && (
                    <Button variant="outline" size="sm" onClick={() => reportMutation.mutate('connected')} disabled={reportMutation.isPending}>
                      I&apos;m connected
                    </Button>
                  )}
                  <Button variant="outline" size="sm" onClick={() => reportMutation.mutate('failed')} disabled={reportMutation.isPending}>
                    It failed
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => onCancel(id!)}
                    disabled={cancelPending}
                  >
                    <X className="h-3.5 w-3.5 mr-1" />
                    Cancel session
                  </Button>
                  <Button size="sm" onClick={() => setCompleting(true)}>
                    <CheckCircle className="h-3.5 w-3.5 mr-1" />
                    Complete…
                  </Button>
                </div>
              </>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 sm:block">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-right sm:text-left">{children}</p>
    </div>
  );
}
