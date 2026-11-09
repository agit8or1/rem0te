'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { endpointsApi, notesApi, diagnosticsApi, offboardingApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { StatusIndicator } from '@/components/common/status-indicator';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EndpointSpecs } from '@/components/endpoints/endpoint-specs';
import { EndpointEventLog } from '@/components/endpoints/endpoint-event-log';
import { EndpointUpdateHistory } from '@/components/rollouts/endpoint-update-history';
import { usePermissions, CAP } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/utils';
import {
  PlayCircle, Archive, ArchiveRestore, Pencil, Check, X, RefreshCw, Sparkles,
  CheckCircle2, XCircle, AlertTriangle, HelpCircle, Info, Clock, Download, Laptop, ShieldAlert, Eye,
} from 'lucide-react';
import { TemporaryAccessCard } from '@/components/security-controls/temporary-access-card';

export default function EndpointDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { can, isPlatformAdmin, technician } = usePermissions();

  const [newNote, setNewNote] = useState('');
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const [timelineText, setTimelineText] = useState<string | null>(null);
  const [timelineEditing, setTimelineEditing] = useState(false);
  const [timelineDraft, setTimelineDraft] = useState('');
  const [tab, setTab] = useState('overview');

  // Access review lists people, so it needs users:view as well. Fetched up
  // front so a 403 (or any error) can hide the tab without a flash of it.
  const canReview = can(CAP.USERS_VIEW);
  const { data: review, isError: reviewError } = useQuery<AccessReview>({
    queryKey: ['access-review', id],
    queryFn: () => offboardingApi.accessReview(id).then((r) => r.data?.data),
    enabled: canReview,
    retry: false,
  });
  const showReview = canReview && !reviewError && !!review;

  const { data: endpoint, isLoading } = useQuery({
    queryKey: ['endpoint', id],
    queryFn: () => endpointsApi.get(id).then((r) => r.data?.data),
  });

  const { data: notes } = useQuery({
    queryKey: ['notes', 'endpoint', id],
    queryFn: () =>
      notesApi.list({ endpointId: id }).then((r) => r.data?.data ?? []),
  });

  // Prefer the direct browser-launch path (rustdesk:// with password) — one click
  // for anyone with access, and does not require the desktop launcher.
  // v0.23: a refusal that a temporary grant would lift opens the request form.
  const [grantRequired, setGrantRequired] = useState<string | null>(null);
  const launchMutation = useMutation({
    mutationFn: (mode?: 'view_only') => endpointsApi.connect(id, mode),
    onSuccess: async (res, mode) => {
      setGrantRequired(null);
      const info = res.data?.data as {
        rustdeskId?: string; password?: string | null; sessionId?: string | null;
        mode?: string; accessPath?: string; maxSessionMinutes?: number | null;
      } | undefined;
      const rdId = info?.rustdeskId;
      if (!rdId) {
        toast({ title: 'Computer not ready', description: 'This computer has not finished enrollment.', variant: 'destructive' });
        return;
      }
      const pw = info?.password ?? null;
      if (pw) {
        try { await navigator.clipboard.writeText(pw); } catch { /* ignore */ }
      }
      // A preset-backed launch never releases the permanent password. The
      // shipped endpoint configuration accepts only that password
      // (verification-method = use-permanent-password), so nothing will prompt
      // at the computer — say what is actually true. The session-length limit
      // is policy text: nothing on the endpoint ends the session.
      if (!pw || info?.maxSessionMinutes) {
        toast({
          title: info?.mode === 'view_only' ? 'Starting a view-only session' : 'Starting the session',
          description: [
            !pw ? 'No password is released for this launch. A computer installed by Rem0te accepts only its permanent password, so RustDesk may not be able to sign in.' : null,
            info?.maxSessionMinutes ? `Policy limit: ${info.maxSessionMinutes} minutes. Nothing on the computer enforces it — end the session when the time is up.` : null,
          ].filter(Boolean).join(' '),
        });
      }
      // See my-computers/page.tsx: a bare rustdesk:// link cannot carry the
      // server address, so it only works on a client that already knows this
      // server. The script installs RustDesk if needed, configures it, then
      // connects — and deletes itself afterwards. POST :id/connect already
      // recorded the session; `?session=` makes the script reuse it rather
      // than create a second one.
      const q = new URLSearchParams();
      if (info?.sessionId) q.set('session', info.sessionId);
      if (mode) q.set('mode', mode);
      const url = endpointsApi.connectScriptUrl(id);
      const qs = q.toString();
      window.location.href = qs ? `${url}?${qs}` : url;
    },
    // A 403 from connect carries { code, message } written to be read as it
    // is — protected device class, a view-only launch the endpoint cannot
    // enforce, a paused identity — so show it verbatim.
    onError: (e: unknown) => {
      const r = (e as { response?: { status?: number; data?: { code?: string } } })?.response;
      if (r?.status === 403 && r.data?.code === 'TEMPORARY_GRANT_REQUIRED') {
        setGrantRequired(apiMessage(e, 'Interactive control needs a temporary grant.'));
        return;
      }
      toast({
        title: r?.status === 403 ? 'Connection refused' : 'Error',
        description: apiMessage(e, 'Failed to start connection'),
        variant: 'destructive',
      });
    },
  });

  const archiveMutation = useMutation({
    mutationFn: () => endpointsApi.archive(id),
    onSuccess: () => {
      toast({ title: 'Computer archived', description: 'Restore it from its page if that was a mistake.' });
      router.push('/endpoints');
    },
    onError: () => toast({ title: 'Error', description: 'Failed to archive', variant: 'destructive' }),
  });

  const restoreMutation = useMutation({
    mutationFn: () => endpointsApi.restore(id),
    onSuccess: () => {
      toast({ title: 'Computer restored' });
      qc.invalidateQueries({ queryKey: ['endpoint', id] });
    },
    onError: () => toast({ title: 'Error', description: 'Failed to restore', variant: 'destructive' }),
  });

  const createNoteMutation = useMutation({
    mutationFn: (content: string) => notesApi.create({ endpointId: id, content }),
    onSuccess: () => {
      setNewNote('');
      qc.invalidateQueries({ queryKey: ['notes', 'endpoint', id] });
      toast({ title: 'Note added' });
    },
    onError: () => toast({ title: 'Error', description: 'Failed to add note', variant: 'destructive' }),
  });

  const generateTimelineMutation = useMutation({
    mutationFn: () => endpointsApi.generateTimeline(id),
    onSuccess: (res) => {
      const text = res.data?.data?.text ?? '';
      setTimelineText(text);
      setTimelineDraft(text);
      setTimelineEditing(false);
      toast({ title: 'Timeline generated' });
    },
    onError: () => toast({ title: 'Error', description: 'Failed to generate timeline. Check ANTHROPIC_API_KEY.', variant: 'destructive' }),
  });

  const saveTimelineMutation = useMutation({
    mutationFn: (text: string) => endpointsApi.saveTimeline(id, text),
    onSuccess: () => {
      setTimelineText(timelineDraft);
      setTimelineEditing(false);
      toast({ title: 'Timeline saved' });
    },
    onError: () => toast({ title: 'Error', description: 'Failed to save timeline', variant: 'destructive' }),
  });

  const updateNoteMutation = useMutation({
    mutationFn: ({ noteId, content }: { noteId: string; content: string }) =>
      notesApi.update(noteId, { content }),
    onSuccess: () => {
      setEditingNoteId(null);
      qc.invalidateQueries({ queryKey: ['notes', 'endpoint', id] });
      toast({ title: 'Note updated' });
    },
    onError: () => toast({ title: 'Error', description: 'Failed to update note', variant: 'destructive' }),
  });

  // Initialise timeline from endpoint data on first load
  useEffect(() => {
    if (endpoint) {
      const ep = endpoint as Record<string, unknown>;
      const stored = ep.aiTimeline as string | null | undefined;
      if (stored && timelineText === null) {
        setTimelineText(stored);
        setTimelineDraft(stored);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint]);

  if (isLoading) return <div className="p-6 text-muted-foreground text-sm">Loading…</div>;
  if (!endpoint) return <div className="p-6 text-muted-foreground text-sm">Not found</div>;

  const ep = endpoint as Record<string, unknown>;
  const customer = ep.customer as { id: string; name: string } | null;
  const site = ep.site as { id: string; name: string } | null;
  const aliases = (ep.aliases as { id: string; alias: string }[]) ?? [];
  const tags = (ep.tags as { id: string; tag: string }[]) ?? [];

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title={ep.name as string}
        description={(ep.hostname as string) ?? 'No hostname'}
      >
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={() => launchMutation.mutate(undefined)}
            disabled={launchMutation.isPending || !(ep.rustdeskNode as { rustdeskId?: string } | null)?.rustdeskId}
          >
            <PlayCircle className="h-4 w-4 mr-2" />
            Connect
          </Button>
          {/* View-only is enforced only for preset-backed technician grants,
              and only by refusing a launch the computer cannot restrict. For a
              Business Owner, Business User or Platform Admin the server has
              never applied it — RustDesk opened with full control — so the
              button is not offered to them rather than implying a restriction
              that does not exist (0.25.0). */}
          {technician && (
            <Button
              size="sm"
              variant="outline"
              title="Asks for a view-only launch. For a preset-based assignment it is refused unless this computer reports it can enforce view-only, and no shipped agent reports that yet. A custom assignment with Connect opens a normal session."
              onClick={() => launchMutation.mutate('view_only')}
              disabled={launchMutation.isPending || !(ep.rustdeskNode as { rustdeskId?: string } | null)?.rustdeskId}
            >
              <Eye className="h-4 w-4 mr-2" />
              View only
            </Button>
          )}
          {ep.status === 'ARCHIVED' ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => restoreMutation.mutate()}
              disabled={restoreMutation.isPending}
            >
              <ArchiveRestore className="h-4 w-4 mr-2" />
              Restore
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                // One click used to archive outright, with no way back.
                if (confirm(`Archive ${ep.name as string}? Nobody will be able to connect to it until it is restored.`)) {
                  archiveMutation.mutate();
                }
              }}
              disabled={archiveMutation.isPending}
            >
              <Archive className="h-4 w-4 mr-2" />
              Archive
            </Button>
          )}
        </div>
      </PageHeader>

      <TemporaryAccessCard
        endpointId={id}
        refusal={grantRequired}
        onDismiss={() => setGrantRequired(null)}
        onConnect={() => launchMutation.mutate(undefined)}
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          {/* Hidden without the capability as a courtesy — the route re-checks
              it, so this is tidiness rather than a control. */}
          {can(CAP.COMPUTERS_EVENT_LOGS) && (
            <TabsTrigger value="events">Event Log</TabsTrigger>
          )}
          {can(CAP.COMPUTERS_VIEW) && (
            <TabsTrigger value="diagnostics">Test connection</TabsTrigger>
          )}
          {showReview && (
            <TabsTrigger value="access-review">Access review</TabsTrigger>
          )}
          <TabsTrigger value="notes">Notes</TabsTrigger>
          <TabsTrigger value="timeline">AI Timeline</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4 mt-4">
          {/* Assignment first: it is the only part of this page that is true
              the moment it loads. Everything below came off the endpoint on a
              heartbeat and carries its own collected-at line. */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Assignment</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2.5 text-sm">
                <Row label="Status">
                  <StatusIndicator status={(ep.isOnline as boolean) ? 'online' : 'offline'} />
                </Row>
                <Row label="Business">{customer?.name ?? '—'}</Row>
                <Row label="Site">{site?.name ?? '—'}</Row>
                <Row label="Platform">
                  {ep.platform ? <Badge variant="secondary">{ep.platform as string}</Badge> : '—'}
                </Row>
                <Row label="Tags">
                  <div className="flex flex-wrap gap-1 justify-end">
                    {tags.length ? tags.map((t) => (
                      <Badge key={t.id} variant="secondary" className="text-xs">{t.tag}</Badge>
                    )) : '—'}
                  </div>
                </Row>
                <Row label="Aliases">
                  <div className="flex flex-wrap gap-1 justify-end">
                    {aliases.length ? aliases.map((a) => (
                      <Badge key={a.id} variant="outline" className="text-xs font-mono">{a.alias}</Badge>
                    )) : '—'}
                  </div>
                </Row>
                <Row label="Enrolled">{formatDate(ep.createdAt as string)}</Row>
              </CardContent>
            </Card>
          </div>

          <EndpointSpecs endpointId={id} endpoint={ep} />
          {/* Staged-update history (Platform Admin only, like rollouts). */}
          {isPlatformAdmin && <EndpointUpdateHistory endpointId={id} />}
        </TabsContent>

        {can(CAP.COMPUTERS_EVENT_LOGS) && (
          <TabsContent value="events" className="mt-4">
            <EndpointEventLog endpointId={id} isOnline={!!(ep.isOnline as boolean)} />
          </TabsContent>
        )}

        {can(CAP.COMPUTERS_VIEW) && (
          <TabsContent value="diagnostics" className="mt-4 space-y-4">
            {/* Mounted only while selected: every run probes the server and
                is audited, so it should not run just because the page opened. */}
            {tab === 'diagnostics' && (
              <DiagnosticsPanel endpointId={id} canConnect={can(CAP.COMPUTERS_CONNECT)} />
            )}
          </TabsContent>
        )}

        {showReview && review && (
          <TabsContent value="access-review" className="mt-4 space-y-4">
            <AccessReviewPanel review={review} />
          </TabsContent>
        )}

        <TabsContent value="notes" className="mt-4 space-y-4">
          {/* Add new note */}
          <Card>
            <CardContent className="pt-4 space-y-3">
              <Textarea
                placeholder="Document an issue, observation, or anything worth tracking about this device — hardware problems, recurring errors, customer preferences, recent changes…"
                value={newNote}
                onChange={(e) => setNewNote(e.target.value)}
                rows={3}
                className="resize-none"
              />
              <div className="flex justify-end">
                <Button
                  size="sm"
                  onClick={() => createNoteMutation.mutate(newNote)}
                  disabled={!newNote.trim() || createNoteMutation.isPending}
                >
                  Add Note
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Existing notes */}
          {Array.isArray(notes) && notes.length > 0 ? (
            <div className="space-y-3">
              {notes.map((note: Record<string, unknown>) => {
                const noteId = note.id as string;
                const isEditing = editingNoteId === noteId;
                return (
                  <Card key={noteId}>
                    <CardContent className="pt-4">
                      {isEditing ? (
                        <div className="space-y-3">
                          <Textarea
                            value={editingContent}
                            onChange={(e) => setEditingContent(e.target.value)}
                            rows={3}
                            className="resize-none"
                            autoFocus
                          />
                          <div className="flex gap-2 justify-end">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setEditingNoteId(null)}
                              disabled={updateNoteMutation.isPending}
                            >
                              <X className="h-3 w-3 mr-1" />
                              Cancel
                            </Button>
                            <Button
                              size="sm"
                              onClick={() => updateNoteMutation.mutate({ noteId, content: editingContent })}
                              disabled={!editingContent.trim() || updateNoteMutation.isPending}
                            >
                              <Check className="h-3 w-3 mr-1" />
                              Update
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <p className="text-sm whitespace-pre-wrap">{note.content as string}</p>
                          <div className="flex items-center justify-between">
                            <p className="text-xs text-muted-foreground">
                              {((note.author as { email?: string }) ?? {})?.email} · {formatDate(note.createdAt as string)}
                            </p>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
                              onClick={() => {
                                setEditingNoteId(noteId);
                                setEditingContent(note.content as string);
                              }}
                            >
                              <Pencil className="h-3 w-3 mr-1" />
                              Edit
                            </Button>
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No notes yet.</p>
          )}
        </TabsContent>
        <TabsContent value="timeline" className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-primary" />
                  AI-Generated Device Summary
                </CardTitle>
                <div className="flex gap-2">
                  {timelineText && !timelineEditing && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setTimelineDraft(timelineText);
                        setTimelineEditing(true);
                      }}
                    >
                      <Pencil className="h-3 w-3 mr-1" />
                      Edit
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => generateTimelineMutation.mutate()}
                    disabled={generateTimelineMutation.isPending}
                  >
                    <RefreshCw className={`h-3 w-3 mr-1 ${generateTimelineMutation.isPending ? 'animate-spin' : ''}`} />
                    {timelineText ? 'Regenerate' : 'Generate'}
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {timelineEditing ? (
                <div className="space-y-3">
                  <Textarea
                    value={timelineDraft}
                    onChange={(e) => setTimelineDraft(e.target.value)}
                    rows={10}
                    className="resize-y font-sans text-sm"
                    autoFocus
                  />
                  <div className="flex gap-2 justify-end">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setTimelineEditing(false)}
                      disabled={saveTimelineMutation.isPending}
                    >
                      <X className="h-3 w-3 mr-1" />
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => saveTimelineMutation.mutate(timelineDraft)}
                      disabled={saveTimelineMutation.isPending}
                    >
                      <Check className="h-3 w-3 mr-1" />
                      Save
                    </Button>
                  </div>
                </div>
              ) : timelineText ? (
                <p className="text-sm leading-relaxed whitespace-pre-wrap text-foreground">
                  {timelineText}
                </p>
              ) : (
                <div className="py-8 text-center space-y-3">
                  <Sparkles className="h-8 w-8 text-muted-foreground mx-auto" />
                  <p className="text-sm text-muted-foreground">
                    No timeline generated yet. Click <strong>Generate</strong> to create an AI summary based on this device&apos;s notes, sessions, and status.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

function apiMessage(e: unknown, fallback: string) {
  return (e as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message?.toString() ?? fallback;
}

// ─── Test connection ─────────────────────────────────────────────────────────

/** Shapes from apps/api/src/diagnostics/diagnostics.service.ts. */
type CheckStatus = 'pass' | 'fail' | 'warn' | 'stale' | 'unavailable' | 'info';
type CheckLocation = 'technician' | 'endpoint' | 'server';
interface DiagnosticCheck {
  key: string;
  label: string;
  location: CheckLocation;
  status: CheckStatus;
  source: string;
  observedAt: string | null;
  summary: string;
  nextSteps: string[];
  actions: { id: string; label: string; changesConfiguration: boolean }[];
}
interface DiagnosticsResult {
  endpoint: { id: string; name: string; hostname: string | null; rustdeskId: string | null };
  ranAt: string;
  checks: DiagnosticCheck[];
  byLocation: { location: CheckLocation; worst: CheckStatus; failing: string[] }[];
  disclaimer: string;
}

const CHECK_STYLE: Record<CheckStatus, { label: string; icon: React.ElementType; className: string }> = {
  pass: {
    label: 'Pass', icon: CheckCircle2,
    className: 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900 dark:text-green-100 dark:border-green-800',
  },
  fail: {
    label: 'Fail', icon: XCircle,
    className: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900 dark:text-red-100 dark:border-red-800',
  },
  warn: {
    label: 'Warning', icon: AlertTriangle,
    className: 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900 dark:text-amber-100 dark:border-amber-800',
  },
  stale: {
    label: 'Out of date', icon: Clock,
    className: 'bg-orange-50 text-orange-800 border-orange-200 dark:bg-orange-950 dark:text-orange-200 dark:border-orange-900',
  },
  unavailable: {
    label: 'Unknown', icon: HelpCircle,
    className: 'bg-muted text-muted-foreground border-border border-dashed',
  },
  info: {
    label: 'Info', icon: Info,
    className: 'bg-sky-50 text-sky-800 border-sky-200 dark:bg-sky-950 dark:text-sky-200 dark:border-sky-900',
  },
};

const LOCATION_LABEL: Record<CheckLocation, string> = {
  technician: 'Your computer',
  endpoint: 'This computer',
  server: 'Rem0te server',
};

function CheckBadge({ status }: { status: CheckStatus }) {
  const s = CHECK_STYLE[status] ?? CHECK_STYLE.unavailable;
  const Icon = s.icon;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${s.className}`}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {s.label}
    </span>
  );
}

/** Fields the read-only helper reports (see technicianChecks in the API). */
const TECH_REPORT_FIELDS: { key: string; label: string }[] = [
  { key: 'installed', label: 'RustDesk installed' },
  { key: 'installedVersion', label: 'Installed version' },
  { key: 'portableCached', label: 'Portable copy cached' },
  { key: 'portableVersion', label: 'Portable version' },
  { key: 'configHost', label: 'Server address in RustDesk' },
  { key: 'hostMatches', label: 'Server address matches' },
  { key: 'keyMatches', label: 'Server key matches' },
  { key: 'tcp21116', label: 'TCP 21116 reachable' },
  { key: 'tcp21117', label: 'TCP 21117 reachable' },
];

function reportValue(v: unknown): string {
  if (v === true) return 'Yes';
  if (v === false) return 'No';
  if (v === null || v === undefined || v === '') return '—';
  return String(v);
}

function DiagnosticsPanel({ endpointId, canConnect }: { endpointId: string; canConnect: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [pending, setPending] = useState<{ id: string; label: string } | null>(null);
  const [helperAt, setHelperAt] = useState<number | null>(null);

  const { data, isLoading, isFetching, isError, error, refetch } = useQuery<DiagnosticsResult>({
    queryKey: ['diagnostics', endpointId],
    queryFn: () => diagnosticsApi.forEndpoint(endpointId).then((r) => r.data?.data),
    retry: false,
    staleTime: 0,
  });

  // After the helper is downloaded, poll for its report for up to 15 minutes.
  const { data: latest } = useQuery<{ submittedAt: string; report: Record<string, unknown> | null } | null>({
    queryKey: ['diagnostics', 'technician-latest'],
    queryFn: () => diagnosticsApi.latestTechnicianReport().then((r) => r.data?.data ?? null),
    enabled: canConnect,
    retry: false,
    refetchInterval: helperAt && Date.now() - helperAt < 15 * 60_000 ? 10_000 : false,
  });

  const latestAt = latest?.submittedAt ? new Date(latest.submittedAt).getTime() : 0;
  useEffect(() => {
    if (helperAt && latestAt > helperAt) {
      setHelperAt(null);
      qc.invalidateQueries({ queryKey: ['diagnostics', endpointId] });
      toast({ title: 'Report received from your computer' });
    }
  }, [helperAt, latestAt, endpointId, qc, toast]);

  const action = useMutation({
    mutationFn: (actionId: string) => {
      if (actionId === 'reinstall_agent') return endpointsApi.reinstallAgent(endpointId);
      if (actionId === 'accept_device_secret') return endpointsApi.acceptDeviceSecret(endpointId);
      if (actionId === 'rotate_credential') return endpointsApi.rotateCredential(endpointId);
      return Promise.reject(new Error('Unsupported action'));
    },
    onSuccess: () => {
      // Each of these is queued for the computer's next check-in, not done.
      toast({ title: 'Requested', description: 'The computer applies this on its next check-in.' });
      setPending(null);
      qc.invalidateQueries({ queryKey: ['diagnostics', endpointId] });
      qc.invalidateQueries({ queryKey: ['endpoint', endpointId] });
    },
    onError: (e: unknown) => {
      toast({ title: 'Not done', description: apiMessage(e, 'The request failed'), variant: 'destructive' });
      setPending(null);
    },
  });

  function runAction(a: { id: string; label: string }) {
    if (a.id === 'run_technician_check') {
      if (!canConnect) return;
      setHelperAt(Date.now());
      window.location.href = diagnosticsApi.helperUrl(endpointId);
      return;
    }
    if (a.id === 'technician_setup') {
      window.location.href = '/downloads';
      return;
    }
    setPending(a);
  }

  const actionAvailable = (id: string) =>
    id === 'run_technician_check' ? canConnect
      : ['technician_setup', 'reinstall_agent', 'accept_device_secret', 'rotate_credential'].includes(id);

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-sm">Test connection</CardTitle>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
                <RefreshCw className={`h-3.5 w-3.5 mr-1 ${isFetching ? 'animate-spin' : ''}`} />
                Run again
              </Button>
              <Button size="sm" variant="outline" asChild>
                <a href={diagnosticsApi.reportUrl(endpointId)}>
                  <Download className="h-3.5 w-3.5 mr-1" />
                  Download report
                </a>
              </Button>
              {canConnect && (
                <Button size="sm" variant="outline" asChild>
                  <a href={diagnosticsApi.helperUrl(endpointId)} onClick={() => setHelperAt(Date.now())}>
                    <Laptop className="h-3.5 w-3.5 mr-1" />
                    Check my computer
                  </a>
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {isLoading ? (
            <p className="text-muted-foreground">Running checks…</p>
          ) : isError || !data ? (
            <p className="text-destructive">{apiMessage(error, 'Could not run the checks.')}</p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">{data.disclaimer}</p>
              <p className="text-xs text-muted-foreground">Run {formatDate(data.ranAt)}.</p>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {data.byLocation.map((l) => (
                  <div key={l.location} className="rounded-md border bg-muted/30 px-3 py-2 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium">{LOCATION_LABEL[l.location]}</span>
                      <CheckBadge status={l.worst} />
                    </div>
                    {l.failing.length > 0 && (
                      <p className="text-xs text-muted-foreground">Failing: {l.failing.join(', ')}</p>
                    )}
                  </div>
                ))}
              </div>

              {(['technician', 'endpoint', 'server'] as CheckLocation[]).map((loc) => {
                const checks = data.checks.filter((c) => c.location === loc);
                if (!checks.length) return null;
                return (
                  <div key={loc} className="space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{LOCATION_LABEL[loc]}</p>
                    <div className="divide-y rounded-md border">
                      {checks.map((c, i) => (
                        <div key={`${c.key}-${i}`} className="p-3 space-y-1.5">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-medium">{c.label}</span>
                            <CheckBadge status={c.status} />
                          </div>
                          <p>{c.summary}</p>
                          {c.nextSteps.length > 0 && (
                            <ul className="list-disc pl-5 text-muted-foreground space-y-0.5">
                              {c.nextSteps.map((n, j) => <li key={j}>{n}</li>)}
                            </ul>
                          )}
                          <p className="text-xs text-muted-foreground">
                            {c.source}{c.observedAt ? ` · observed ${formatDate(c.observedAt)}` : ' · never observed'}
                          </p>
                          {c.actions.filter((a) => actionAvailable(a.id)).length > 0 && (
                            <div className="flex flex-wrap gap-2 pt-1">
                              {c.actions.filter((a) => actionAvailable(a.id)).map((a) => (
                                <Button key={a.id} size="sm" variant="outline" className="h-7 text-xs" onClick={() => runAction(a)}>
                                  {a.label}
                                </Button>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </CardContent>
      </Card>

      {canConnect && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Latest check of your computer</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {helperAt && (
              <p className="text-xs text-muted-foreground">
                Waiting for the helper to report. Run the downloaded file on your Windows computer.
              </p>
            )}
            {!latest ? (
              <p className="text-muted-foreground">
                No report yet. &ldquo;Check my computer&rdquo; downloads a read-only helper for Windows that reports back here.
              </p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">Reported {formatDate(latest.submittedAt)}.</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
                  {TECH_REPORT_FIELDS.filter((f) => latest.report && f.key in latest.report).map((f) => (
                    <Row key={f.key} label={f.label}>{reportValue(latest.report?.[f.key])}</Row>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={!!pending}
        onOpenChange={(o) => { if (!o) setPending(null); }}
        title={pending?.label ?? ''}
        description="This changes configuration on the computer. It is queued and applied on the computer's next check-in."
        confirmLabel="Request it"
        loading={action.isPending}
        onConfirm={() => pending && action.mutate(pending.id)}
      />
    </>
  );
}

// ─── Access review ───────────────────────────────────────────────────────────

/** Shapes from apps/api/src/offboarding/access-review.service.ts. */
interface AccessEntry {
  userId: string;
  name: string;
  email: string;
  via: 'PLATFORM_ADMIN' | 'BUSINESS_OWNER' | 'COMPUTER_GRANT' | 'COMPANY_WIDE' | 'TECHNICIAN_DIRECT' | 'TECHNICIAN_GROUP';
  detail: string;
  activeNow: boolean;
  inactiveReason?: string;
  startsAt?: string | null;
  expiresAt?: string | null;
  schedule?: string | null;
  temporary: boolean;
}
interface AccessReview {
  endpoint: { id: string; name: string; accessMode: string; businessId: string | null };
  reviewedAt: string;
  entries: AccessEntry[];
  note: string;
}

const VIA_LABEL: Record<AccessEntry['via'], string> = {
  PLATFORM_ADMIN: 'Platform Admin',
  BUSINESS_OWNER: 'Business Owner',
  COMPUTER_GRANT: 'Granted on this computer',
  COMPANY_WIDE: 'Company-wide',
  TECHNICIAN_DIRECT: 'Technician (direct)',
  TECHNICIAN_GROUP: 'Technician (group)',
};

function AccessReviewPanel({ review }: { review: AccessReview }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Who can connect to this computer</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
          <p>{review.note}</p>
        </div>

        <p className="text-xs text-muted-foreground">
          Access mode: {review.endpoint.accessMode === 'COMPANY_WIDE' ? 'company-wide' : 'assigned users only'} ·
          reviewed {formatDate(review.reviewedAt)}
        </p>

        {review.entries.length === 0 ? (
          <p className="text-muted-foreground">Nobody has access.</p>
        ) : (
          <div className="rounded-md border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="text-left px-3 py-2 font-medium text-xs">Person</th>
                  <th className="text-left px-3 py-2 font-medium text-xs">How</th>
                  <th className="text-left px-3 py-2 font-medium text-xs">Now</th>
                  <th className="text-left px-3 py-2 font-medium text-xs">Window</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {review.entries.map((e, i) => (
                  <tr key={`${e.userId}-${e.via}-${i}`} className={e.activeNow ? '' : 'text-muted-foreground'}>
                    <td className="px-3 py-2 align-top">
                      <p className="font-medium">{e.name}</p>
                      {e.name !== e.email && <p className="text-xs text-muted-foreground">{e.email}</p>}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <p>{VIA_LABEL[e.via] ?? e.via}</p>
                      <p className="text-xs text-muted-foreground">{e.detail}</p>
                    </td>
                    <td className="px-3 py-2 align-top">
                      {e.activeNow ? (
                        <Badge variant="success">Active</Badge>
                      ) : (
                        <div className="space-y-0.5">
                          <Badge variant="secondary">Inactive</Badge>
                          {e.inactiveReason && <p className="text-xs">{e.inactiveReason}</p>}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 align-top text-xs space-y-0.5">
                      {e.temporary && <Badge variant="warning" className="text-[10px]">Temporary</Badge>}
                      {e.startsAt && <p>From {formatDate(e.startsAt)}</p>}
                      {e.expiresAt && <p>Until {formatDate(e.expiresAt)}</p>}
                      {e.schedule && <p>{e.schedule}</p>}
                      {!e.temporary && !e.startsAt && !e.expiresAt && !e.schedule && <span className="text-muted-foreground">No limit</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
