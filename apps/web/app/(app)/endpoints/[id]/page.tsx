'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { endpointsApi, launcherApi, notesApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { StatusIndicator } from '@/components/common/status-indicator';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/utils';
import { PlayCircle, Archive, Pencil, Check, X, RefreshCw, Sparkles } from 'lucide-react';

export default function EndpointDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [newNote, setNewNote] = useState('');
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const [timelineText, setTimelineText] = useState<string | null>(null);
  const [timelineEditing, setTimelineEditing] = useState(false);
  const [timelineDraft, setTimelineDraft] = useState('');

  const { data: endpoint, isLoading } = useQuery({
    queryKey: ['endpoint', id],
    queryFn: () => endpointsApi.get(id).then((r) => r.data?.data),
  });

  const { data: notes } = useQuery({
    queryKey: ['notes', 'endpoint', id],
    queryFn: () =>
      notesApi.list({ endpointId: id }).then((r) => r.data?.data ?? []),
  });

  const launchMutation = useMutation({
    mutationFn: () => launcherApi.issueToken({ endpointId: id }),
    onSuccess: (res) => {
      const deepLink = res.data?.data?.deepLink;
      if (deepLink) window.location.href = deepLink;
      toast({ title: 'Launcher token issued', description: 'Opening RustDesk…' });
    },
    onError: () => toast({ title: 'Error', description: 'Failed to launch session', variant: 'destructive' }),
  });

  const archiveMutation = useMutation({
    mutationFn: () => endpointsApi.archive(id),
    onSuccess: () => {
      toast({ title: 'Endpoint archived' });
      router.push('/endpoints');
    },
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
            onClick={() => launchMutation.mutate()}
            disabled={launchMutation.isPending || !ep.rustdeskId}
          >
            <PlayCircle className="h-4 w-4 mr-2" />
            Launch Session
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => archiveMutation.mutate()}
            disabled={archiveMutation.isPending}
          >
            <Archive className="h-4 w-4 mr-2" />
            Archive
          </Button>
        </div>
      </PageHeader>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="notes">Notes</TabsTrigger>
          <TabsTrigger value="timeline">AI Timeline</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4 mt-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">System Info</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <Row label="Status">
                  <StatusIndicator status={(ep.isOnline as boolean) ? 'online' : 'offline'} />
                </Row>
                <Row label="Platform">
                  {ep.platform ? <Badge variant="secondary">{ep.platform as string}</Badge> : '—'}
                </Row>
                <Row label="OS">{(ep.osVersion as string) ?? '—'}</Row>
                <Row label="RustDesk ID">
                  <span className="font-mono text-xs">{(ep.rustdeskId as string) ?? 'Not enrolled'}</span>
                </Row>
                <Row label="Agent">{(ep.agentVersion as string) ?? '—'}</Row>
                <Row label="Last Seen">{formatDate(ep.lastSeenAt as string)}</Row>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Assignment</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <Row label="Customer">{customer?.name ?? '—'}</Row>
                <Row label="Site">{site?.name ?? '—'}</Row>
                <Row label="Tags">
                  <div className="flex flex-wrap gap-1">
                    {tags.length ? tags.map((t) => (
                      <Badge key={t.id} variant="secondary" className="text-xs">{t.tag}</Badge>
                    )) : '—'}
                  </div>
                </Row>
                <Row label="Aliases">
                  <div className="flex flex-wrap gap-1">
                    {aliases.length ? aliases.map((a) => (
                      <Badge key={a.id} variant="outline" className="text-xs font-mono">{a.alias}</Badge>
                    )) : '—'}
                  </div>
                </Row>
                <Row label="Created">{formatDate(ep.createdAt as string)}</Row>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

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
