'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Pencil, RefreshCw, Sparkles, X } from 'lucide-react';
import { endpointsApi, notesApi } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { SessionStatusBadge } from '@/components/sessions/session-status-badge';
import { useToast } from '@/hooks/use-toast';
import { formatDate, formatDuration } from '@/lib/utils';
import { AccessReviewPanel, type AccessReview } from './access-review-panel';

/**
 * What has happened on this computer and who can reach it: remote sessions,
 * technicians' notes, the AI-written summary (labelled as such, and editable),
 * and the access review. Before 0.31 these were four separate tabs.
 */

export interface SessionRow {
  id: string;
  status: string;
  createdAt: string;
  endedAt?: string | null;
  duration?: number | null;
  timingQuality?: string | null;
  issueDescription?: string | null;
  technician?: { firstName?: string | null; lastName?: string | null } | null;
}

export const personName = (p?: { firstName?: string | null; lastName?: string | null } | null) =>
  [p?.firstName, p?.lastName].filter(Boolean).join(' ') || 'Unknown';

function Section({ id, title, aside, children }: { id: string; title: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card id={id}>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm flex items-center gap-2">{title}</CardTitle>
          {aside}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">{children}</CardContent>
    </Card>
  );
}

function Sessions({ sessions }: { sessions: SessionRow[] }) {
  return (
    <Section id="history-sessions" title="Remote sessions" aside={<Link href="/sessions" className="text-xs underline text-muted-foreground hover:text-foreground">All sessions</Link>}>
      {sessions.length === 0 ? (
        <p className="text-muted-foreground">No remote sessions recorded for this computer.</p>
      ) : (
        <>
          <ul className="divide-y rounded-md border">
            {sessions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <SessionStatusBadge status={s.status} />
                <span className="font-medium">{personName(s.technician)}</span>
                <span className="text-xs text-muted-foreground">{formatDate(s.createdAt)}</span>
                {/* Duration is measured connection time only; it is null when either end was not observed. */}
                {s.duration != null && <span className="text-xs text-muted-foreground">{formatDuration(s.duration)} connected</span>}
                {s.issueDescription && <span className="w-full text-xs text-muted-foreground break-words">{s.issueDescription}</span>}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">Latest {sessions.length === 1 ? 'session' : `${sessions.length} sessions`}. The time is when it was requested; the status says what was actually observed.</p>
        </>
      )}
    </Section>
  );
}

function Notes({ endpointId }: { endpointId: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [newNote, setNewNote] = useState('');
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const { data: notes } = useQuery({
    queryKey: ['notes', 'endpoint', endpointId],
    queryFn: () => notesApi.list({ endpointId }).then((r) => r.data?.data ?? []),
  });
  const create = useMutation({
    mutationFn: (content: string) => notesApi.create({ endpointId, content }),
    onSuccess: () => {
      setNewNote('');
      qc.invalidateQueries({ queryKey: ['notes', 'endpoint', endpointId] });
      toast({ title: 'Note added' });
    },
    onError: () => toast({ title: 'Error', description: 'Failed to add note', variant: 'destructive' }),
  });
  const update = useMutation({
    mutationFn: ({ noteId, content }: { noteId: string; content: string }) => notesApi.update(noteId, { content }),
    onSuccess: () => {
      setEditingNoteId(null);
      qc.invalidateQueries({ queryKey: ['notes', 'endpoint', endpointId] });
      toast({ title: 'Note updated' });
    },
    onError: () => toast({ title: 'Error', description: 'Failed to update note', variant: 'destructive' }),
  });

  return (
    <Section id="history-notes" title="Technician notes">
      <div className="space-y-2">
        <Textarea
          placeholder="Document an issue, observation, or anything worth tracking about this device — hardware problems, recurring errors, customer preferences, recent changes…"
          aria-label="New note"
          value={newNote}
          onChange={(e) => setNewNote(e.target.value)}
          rows={3}
          className="resize-none"
        />
        <div className="flex justify-end">
          <Button size="sm" onClick={() => create.mutate(newNote)} disabled={!newNote.trim() || create.isPending}>Add note</Button>
        </div>
      </div>
      {Array.isArray(notes) && notes.length > 0 ? (
        <div className="space-y-2">
          {notes.map((note: Record<string, unknown>) => {
            const noteId = note.id as string;
            const isEditing = editingNoteId === noteId;
            return (
              <div key={noteId} className="rounded-md border p-3">
                {isEditing ? (
                  <div className="space-y-2">
                    <Textarea value={editingContent} onChange={(e) => setEditingContent(e.target.value)} rows={3} className="resize-none" autoFocus aria-label="Edit note" />
                    <div className="flex gap-2 justify-end">
                      <Button size="sm" variant="outline" onClick={() => setEditingNoteId(null)} disabled={update.isPending}>
                        <X className="h-3 w-3 mr-1" />Cancel
                      </Button>
                      <Button size="sm" onClick={() => update.mutate({ noteId, content: editingContent })} disabled={!editingContent.trim() || update.isPending}>
                        <Check className="h-3 w-3 mr-1" />Update
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <p className="whitespace-pre-wrap">{note.content as string}</p>
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-muted-foreground">
                        {((note.author as { email?: string }) ?? {})?.email} · {formatDate(note.createdAt as string)}
                      </p>
                      <Button
                        size="sm" variant="ghost" className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => { setEditingNoteId(noteId); setEditingContent(note.content as string); }}
                      >
                        <Pencil className="h-3 w-3 mr-1" />Edit
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-muted-foreground">No notes yet.</p>
      )}
    </Section>
  );
}

function AiSummary({ endpointId, stored }: { endpointId: string; stored: string | null }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [text, setText] = useState<string | null>(stored);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(stored ?? '');
  useEffect(() => {
    if (stored && text === null) { setText(stored); setDraft(stored); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored]);

  const generate = useMutation({
    mutationFn: () => endpointsApi.generateTimeline(endpointId),
    onSuccess: (res) => {
      const t = res.data?.data?.text ?? '';
      setText(t); setDraft(t); setEditing(false);
      qc.invalidateQueries({ queryKey: ['endpoint', endpointId] });
      toast({ title: 'Summary generated' });
    },
    onError: () => toast({ title: 'Error', description: 'Failed to generate the summary. Check ANTHROPIC_API_KEY.', variant: 'destructive' }),
  });
  const save = useMutation({
    mutationFn: (t: string) => endpointsApi.saveTimeline(endpointId, t),
    onSuccess: () => {
      setText(draft); setEditing(false);
      // The page's copy of the computer carries the stored summary; refresh it
      // so leaving the tab and coming back does not show the old text.
      qc.invalidateQueries({ queryKey: ['endpoint', endpointId] });
      toast({ title: 'Summary saved' });
    },
    onError: () => toast({ title: 'Error', description: 'Failed to save the summary', variant: 'destructive' }),
  });

  return (
    <Section
      id="history-ai-summary"
      title={<><Sparkles className="h-4 w-4 text-primary" />AI-written summary</>}
      aside={
        <div className="flex gap-2">
          {text && !editing && (
            <Button size="sm" variant="outline" onClick={() => { setDraft(text); setEditing(true); }}>
              <Pencil className="h-3 w-3 mr-1" />Edit
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => generate.mutate()} disabled={generate.isPending}>
            <RefreshCw className={`h-3 w-3 mr-1 ${generate.isPending ? 'animate-spin' : ''}`} />
            {text ? 'Regenerate' : 'Generate'}
          </Button>
        </div>
      }
    >
      <p className="text-xs text-muted-foreground">
        Written by an AI model from this computer&apos;s notes, sessions and status. It can be wrong; it is a starting point, not a record.
      </p>
      {editing ? (
        <div className="space-y-2">
          <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={10} className="resize-y font-sans text-sm" autoFocus aria-label="Edit summary" />
          <div className="flex gap-2 justify-end">
            <Button size="sm" variant="outline" onClick={() => setEditing(false)} disabled={save.isPending}><X className="h-3 w-3 mr-1" />Cancel</Button>
            <Button size="sm" onClick={() => save.mutate(draft)} disabled={save.isPending}><Check className="h-3 w-3 mr-1" />Save</Button>
          </div>
        </div>
      ) : text ? (
        <p className="leading-relaxed whitespace-pre-wrap text-foreground">{text}</p>
      ) : (
        <p className="text-muted-foreground">No summary yet. <strong>Generate</strong> writes one from this computer&apos;s notes, sessions and status.</p>
      )}
    </Section>
  );
}

export function DeviceHistoryTab({
  endpointId, sessions, aiTimeline, review,
}: {
  endpointId: string;
  sessions: SessionRow[];
  aiTimeline: string | null;
  /** Present only when the viewer may review access (users:view) and the route answered. */
  review: AccessReview | null;
}) {
  return (
    <div className="space-y-4" data-testid="device-history">
      <nav className="flex flex-wrap gap-3 text-xs text-muted-foreground" aria-label="On this tab">
        <a className="hover:text-foreground underline-offset-2 hover:underline" href="#history-sessions">Remote sessions</a>
        <a className="hover:text-foreground underline-offset-2 hover:underline" href="#history-notes">Notes</a>
        <a className="hover:text-foreground underline-offset-2 hover:underline" href="#history-ai-summary">AI summary</a>
        {review && <a className="hover:text-foreground underline-offset-2 hover:underline" href="#history-access">Who can connect</a>}
      </nav>
      <Sessions sessions={sessions} />
      <Notes endpointId={endpointId} />
      <AiSummary endpointId={endpointId} stored={aiTimeline} />
      {review && <div id="history-access"><AccessReviewPanel review={review} /></div>}
    </div>
  );
}
