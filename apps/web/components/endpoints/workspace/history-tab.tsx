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
 * the access review, and (0.36) the tray: its self-help runs and the
 * support requests it sent. Before 0.31 these were four separate tabs.
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
      qc.invalidateQueries({ queryKey: ['endpoint-timeline', endpointId] });
      toast({ title: 'Note added' });
    },
    onError: () => toast({ title: 'Error', description: 'Failed to add note', variant: 'destructive' }),
  });
  const update = useMutation({
    mutationFn: ({ noteId, content }: { noteId: string; content: string }) => notesApi.update(noteId, { content }),
    onSuccess: () => {
      setEditingNoteId(null);
      qc.invalidateQueries({ queryKey: ['notes', 'endpoint', endpointId] });
      qc.invalidateQueries({ queryKey: ['endpoint-timeline', endpointId] });
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

interface TimelineStatus {
  operation: string;
  available: boolean;
  code: string;
  message: string;
  peerId: string | null;
  organizationId: string | null;
  modelProfile: string | null;
  canRequest: boolean;
  requires: string[];
  fields: { field: string; from: string; redacted: boolean }[];
  notSent: string[];
  preview: {
    untrusted_segments: { ref: string; kind: string; text: string }[];
    redactions: Record<string, number>;
    chars: number;
    droppedForSize: number;
    notes: number;
    sessions: number;
  };
}

const REDACTION_LABEL: Record<string, string> = {
  secret: 'passwords and secrets', token: 'tokens and keys', email: 'e-mail addresses', ip_address: 'IP addresses',
  mac_address: 'MAC addresses', rustdesk_id: 'RustDesk IDs', user_path: 'user-profile paths',
};

/** The API answers `{ code, message }`, sometimes nested under `message`. */
function apiError(e: unknown, fallback: string): string {
  const d = (e as { response?: { data?: { message?: unknown; code?: string } } })?.response?.data;
  const m = d?.message;
  if (typeof m === 'string') return m;
  if (m && typeof m === 'object' && typeof (m as { message?: unknown }).message === 'string') return (m as { message: string }).message;
  return fallback;
}

/**
 * What leaves rem0te when the summary is requested: the field list, what is
 * never sent, how many values were redacted, and — on demand — the exact
 * segments, which are the same object the server sends.
 */
function OutboundDisclosure({ st }: { st: TimelineStatus }) {
  const [showExact, setShowExact] = useState(false);
  const red = Object.entries(st.preview.redactions).filter(([, n]) => n > 0);
  return (
    <details className="rounded-md border px-3 py-2 text-xs" data-testid="ai-summary-outbound">
      <summary className="cursor-pointer font-medium text-foreground">What is sent to ClientSt0r</summary>
      <div className="mt-2 space-y-2 text-muted-foreground">
        <ul className="list-disc pl-5 space-y-0.5">
          {st.fields.map((f) => (
            <li key={f.field}><code>{f.field}</code>: {f.from}{f.redacted ? ' (redacted)' : ''}</li>
          ))}
        </ul>
        <p><span className="text-foreground">Never sent:</span> {st.notSent.join('; ')}.</p>
        <p>
          Now: {st.preview.notes} note{st.preview.notes === 1 ? '' : 's'}, {st.preview.sessions} session{st.preview.sessions === 1 ? '' : 's'},{' '}
          {st.preview.chars.toLocaleString()} characters
          {st.preview.droppedForSize > 0 ? `, ${st.preview.droppedForSize} oldest left out for size` : ''}.{' '}
          {red.length > 0
            ? <>Removed before sending: {red.map(([k, n]) => `${n} ${REDACTION_LABEL[k] ?? k}`).join(', ')}.</>
            : 'Nothing needed redacting.'}
        </p>
        <button type="button" className="underline hover:text-foreground" onClick={() => setShowExact((v) => !v)}>
          {showExact ? 'Hide the exact text' : 'Show the exact text'}
        </button>
        {showExact && (
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[11px] text-foreground" data-testid="ai-summary-exact">
            {st.preview.untrusted_segments.map((s) => `[${s.ref}]\n${s.text}`).join('\n\n')}
          </pre>
        )}
      </div>
    </details>
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

  const status = useQuery({
    queryKey: ['endpoint-timeline', endpointId],
    queryFn: () => endpointsApi.timelineStatus(endpointId).then((r) => r.data?.data as TimelineStatus),
  });
  const st = status.data;

  const generate = useMutation({
    mutationFn: () => endpointsApi.generateTimeline(endpointId),
    onSuccess: (res) => {
      const t = res.data?.data?.text ?? '';
      setText(t); setDraft(t); setEditing(false);
      qc.invalidateQueries({ queryKey: ['endpoint', endpointId] });
      toast({ title: 'Summary generated' });
    },
    onError: (e) => {
      qc.invalidateQueries({ queryKey: ['endpoint-timeline', endpointId] });
      toast({ title: 'No summary', description: apiError(e, 'ClientSt0r did not return a summary. Nothing was saved.'), variant: 'destructive' });
    },
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

  const canGenerate = !!st?.available && !!st?.canRequest && !generate.isPending;
  const why = !st ? (status.isError ? 'Could not check whether ClientSt0r can write the summary.' : 'Checking ClientSt0r…')
    : !st.available ? st.message
    : !st.canRequest ? `Requesting it needs ${st.requires.join(' and ')} in this business.`
    : null;

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
          <Button size="sm" variant="outline" onClick={() => generate.mutate()} disabled={!canGenerate} title={why ?? undefined} data-testid="ai-summary-generate">
            <RefreshCw className={`h-3 w-3 mr-1 ${generate.isPending ? 'animate-spin' : ''}`} />
            {text ? 'Regenerate' : 'Generate'}
          </Button>
        </div>
      }
    >
      <p className="text-xs text-muted-foreground">
        Written by a model that ClientSt0r runs, from a redacted copy of this computer&apos;s notes, sessions and status.
        Rem0te holds no AI provider key. It can be wrong; it is a starting point, not a record.
      </p>
      {why && <p className="text-xs rounded-md border border-dashed px-3 py-2 text-muted-foreground" data-testid="ai-summary-unavailable">{why}</p>}
      {st?.available && (
        <p className="text-xs text-muted-foreground">
          Sent to ClientSt0r <code>{st.peerId}</code>, organization <code>{st.organizationId}</code>, profile <code>{st.modelProfile}</code>.
        </p>
      )}
      {st && <OutboundDisclosure st={st} />}
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
        <p className="text-muted-foreground">No summary yet.{canGenerate ? <> <strong>Generate</strong> asks ClientSt0r to write one.</> : null}</p>
      )}
    </Section>
  );
}

// ── The tray (0.36) ─────────────────────────────────────────────────────────

type TrayRun = {
  id: string; tool: string; localUser: string | null; via: 'signed' | 'tray_key'; status: 'running' | 'succeeded' | 'failed' | 'refused';
  offline: boolean; summary: string | null; detail: string[] | null; startedAt: string; finishedAt: string | null;
};
type TrayInfo = {
  tray: { kind: 'signed' | 'standard' | 'none' | 'unsupported'; protocol: number | null; pairedAt: string | null; message: string };
  selfHelp: TrayRun[];
  requests: { id: string; status: string; createdAt: string; contactName: string | null; _count: { attachments: number } }[] | null;
};

const TOOL_TITLE: Record<string, string> = {
  'dns.check': 'Check DNS', 'dns.flush': 'Flush the DNS cache', 'ip.renew': 'Renew IP address',
  'net.test': 'Test the connection', 'net.details': 'Show network details', 'rustdesk.restart': 'Restart the remote support service',
};
const RUN_TONE: Record<TrayRun['status'], string> = {
  succeeded: 'text-emerald-700 dark:text-emerald-300', failed: 'text-red-700 dark:text-red-300',
  refused: 'text-amber-700 dark:text-amber-300', running: 'text-muted-foreground',
};

function TrayHistory({ endpointId }: { endpointId: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const { data, isLoading, isError } = useQuery<TrayInfo>({
    queryKey: ['endpoint-tray', endpointId],
    queryFn: () => endpointsApi.tray(endpointId).then((r) => r.data?.data),
    refetchInterval: 60_000,
  });
  return (
    <Section id="history-tray" title="Tray and self-help">
      {isLoading ? <p className="text-muted-foreground">Loading…</p>
        : isError || !data ? <p className="text-destructive">The tray history could not be loaded.</p>
          : (
            <>
              <p data-testid="tray-kind" data-kind={data.tray.kind}>{data.tray.message}</p>
              <p className="text-xs text-muted-foreground">
                The tray program has been built and unit-tested for Windows but has not been run on a real Windows computer by
                this release&apos;s tests. Treat its first use on a computer as a trial.
              </p>
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Self-help runs (newest 50)</p>
                {data.selfHelp.length === 0 ? <p className="text-muted-foreground" data-testid="tray-runs-empty">None yet.</p> : (
                  <ul className="divide-y rounded-md border" data-testid="tray-runs">
                    {data.selfHelp.map((r) => (
                      <li key={r.id} className="px-3 py-2" data-testid="tray-run" data-tool={r.tool} data-status={r.status}>
                        <button type="button" className="flex w-full flex-wrap items-baseline justify-between gap-2 text-left" onClick={() => setOpen(open === r.id ? null : r.id)}>
                          <span>{TOOL_TITLE[r.tool] ?? r.tool}{r.localUser ? <span className="text-muted-foreground"> · {r.localUser}</span> : null}</span>
                          <span className="text-xs">
                            <span className={RUN_TONE[r.status]}>{r.status}</span>
                            <span className="text-muted-foreground"> · {formatDate(r.startedAt)}{r.offline ? ' · ran while offline, reported later' : ''}</span>
                          </span>
                        </button>
                        {r.summary && <p className="mt-0.5 text-xs text-muted-foreground">{r.summary}</p>}
                        {open === r.id && r.detail && r.detail.length > 0 && (
                          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-[11px]">{r.detail.join('\n')}</pre>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {data.requests && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">Support requests sent from the tray</p>
                  {data.requests.length === 0 ? <p className="text-muted-foreground">None.</p> : (
                    <ul className="space-y-1" data-testid="tray-requests">
                      {data.requests.map((q) => (
                        <li key={q.id} className="text-xs">
                          <Link href={`/support-requests?open=${q.id}`} className="underline underline-offset-2">{formatDate(q.createdAt)}</Link>
                          <span className="text-muted-foreground"> · {q.status.toLowerCase()}{q.contactName ? ` · ${q.contactName}` : ''}{q._count.attachments ? ` · ${q._count.attachments} attachment(s)` : ''}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
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
        <a className="hover:text-foreground underline-offset-2 hover:underline" href="#history-tray">Tray</a>
        {review && <a className="hover:text-foreground underline-offset-2 hover:underline" href="#history-access">Who can connect</a>}
      </nav>
      <Sessions sessions={sessions} />
      <Notes endpointId={endpointId} />
      <AiSummary endpointId={endpointId} stored={aiTimeline} />
      <TrayHistory endpointId={endpointId} />
      {review && <div id="history-access"><AccessReviewPanel review={review} /></div>}
    </div>
  );
}
